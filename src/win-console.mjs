/* Windows .NET 启动桥：保留有效控制台，同时隐藏窗口、独立于 agent 存活。
 * Node 的 detached 使用 DETACHED_PROCESS，不能用于依赖 Console 编码的程序。
 * PowerShell 仅负责调用系统 API 和等待退出；业务 stdout/stderr 仍直接写日志文件。
 */
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

const PAYLOAD_ENV = 'VCSNODE_WINDOWS_CONSOLE_LAUNCH';
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VCSNODE_WINDOWS_CONSOLE_LAUNCH)) | ConvertFrom-Json
  Remove-Item Env:VCSNODE_WINDOWS_CONSOLE_LAUNCH
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class VcsNodeConsoleLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb;
    public string reserved, desktop, title;
    public int x, y, xSize, ySize, xChars, yChars, fillAttribute, flags;
    public short showWindow, reservedSize;
    public IntPtr reserved2, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo {
    public IntPtr process, thread;
    public uint pid, tid;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string file, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
    uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string file, string commandLine, string cwd) {
    var startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.flags = 0x00000101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
    startup.showWindow = 0;    // SW_HIDE：有控制台，但不弹窗口
    startup.stdin = GetStdHandle(-10);
    startup.stdout = startup.stderr = GetStdHandle(-12); // helper stderr 是业务日志文件
    ProcessInfo info;
    if (!CreateProcessW(file, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
      true, 0x00000010, IntPtr.Zero, cwd, ref startup, out info)) // CREATE_NEW_CONSOLE
      throw new Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(info.thread);
    try {
      Console.Out.WriteLine("VCSNODE_PID:" + info.pid);
      Console.Out.Flush();
      if (WaitForSingleObject(info.process, 0xffffffff) != 0)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code;
      if (!GetExitCodeProcess(info.process, out code))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return unchecked((int)code);
    } finally {
      CloseHandle(info.process);
    }
  }
}
'@
  exit ([VcsNodeConsoleLauncher]::Run($payload.file, $payload.commandLine, $payload.cwd))
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`;

// CreateProcess 接收 Windows argv 命令行，不经过 cmd / PowerShell 表达式求值。
function quoteArgument(value) {
  const s = String(value);
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/** 返回使用真实业务 PID 的退出事件对象，保持 agent 的启停与异常退出审计语义。 */
export async function spawnWindowsConsole(file, args, { cwd, env, logFd, timeoutMs = 15000 }) {
  const payload = Buffer.from(JSON.stringify({
    file, commandLine: [file, ...args].map(quoteArgument).join(' '), cwd,
  })).toString('base64');
  const systemRoot = Object.entries(env).find(([k]) => k.toLowerCase() === 'systemroot')?.[1] || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64'),
  ], {
    cwd, env: { ...env, [PAYLOAD_ENV]: payload },
    // PowerShell 自身不能使用 DETACHED_PROCESS；业务进程由 CreateProcess 创建，
    // 不经 uv_spawn，不加入 Node 用来随 agent 退出而清理的子进程 job。
    windowsHide: true, stdio: ['ignore', 'pipe', logFd],
  });
  const child = new EventEmitter();
  child.unref = () => {
    helper.unref();
    helper.stdout.unref?.();
    return child;
  };

  return new Promise((resolve, reject) => {
    let ready = false;
    let timingOut = false;
    let buffer = '';
    const timer = setTimeout(() => {
      timingOut = true;
      // PID 可能已写入管道，但 agent 事件循环尚未处理。不能只杀 helper，
      // 否则 CreateProcess 创建的业务进程会成为「启动失败但仍在跑」的孤儿。
      execFile(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(helper.pid), '/T', '/F'], {
        windowsHide: true, timeout: 10000,
      }, (error) => {
        const cleanup = error ? `；清理启动进程树失败：${error.message}` : '';
        reject(new Error(`Windows 控制台启动器 ${timeoutMs}ms 内未返回业务 PID${cleanup}`));
      });
    }, timeoutMs);
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk) => {
      if (ready || timingOut) return;
      buffer += chunk;
      const match = buffer.match(/^VCSNODE_PID:(\d+)\r?\n/);
      if (!match) return;
      child.pid = Number(match[1]);
      ready = true;
      clearTimeout(timer);
      resolve(child);
    });
    helper.once('error', (error) => {
      clearTimeout(timer);
      if (timingOut) return;
      if (ready) child.emit('error', error);
      else reject(error);
    });
    helper.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timingOut) return;
      if (ready) child.emit('exit', code, signal);
      else reject(new Error(`Windows 控制台启动器退出（${code ?? signal ?? '?'}），详情见组件日志`));
    });
  });
}
