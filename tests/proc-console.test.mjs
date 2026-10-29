import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { findTarget, pidAlive, restartComponent, startComponent, stopComponent } from '../src/proc.mjs';
import { spawnWindowsConsole } from '../src/win-console.mjs';

const run = promisify(execFile);
const windows = process.platform === 'win32';
let root;
let dll;
const managed = new Set();

before(async () => {
  if (!windows) return;
  root = await mkdtemp(join(os.tmpdir(), 'vcsNode console 测试 '));
  await writeFile(join(root, 'ConsoleFixture.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>
  </Project>`);
  await writeFile(join(root, 'Program.cs'), `
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Net;
using System.Net.Sockets;
class Program {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static void Main(string[] args) {
    Console.OutputEncoding = Encoding.UTF8;
    Console.InputEncoding = Encoding.UTF8;
    Console.WriteLine("stdout 编码正常");
    Console.Error.WriteLine("stderr 编码正常");
    TcpListener listener = null;
    if (args.Length > 1 && int.TryParse(args[1], out int port)) {
      listener = new TcpListener(IPAddress.Loopback, port);
      listener.Start();
    }
    File.WriteAllText(args[0], JsonSerializer.Serialize(new {
      pid = Environment.ProcessId, cwd = Environment.CurrentDirectory, args,
      env = Environment.GetEnvironmentVariable("VCSNODE_CONSOLE_TEST"),
      visible = IsWindowVisible(GetConsoleWindow())
    }));
    Thread.Sleep(Timeout.Infinite);
  }
}`);
  execFileSync('dotnet', ['build', join(root, 'ConsoleFixture.csproj'), '--nologo', '-v:q', '-p:NuGetAudit=false'], { windowsHide: true, timeout: 90000 });
  dll = join(root, 'bin', 'Debug', 'net8.0', 'ConsoleFixture.dll');
});

after(async () => {
  for (const pid of managed) {
    if (pidAlive(pid)) await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  }
  if (root) {
    const target = resolve(root);
    assert.equal(dirname(target).toLowerCase(), resolve(os.tmpdir()).toLowerCase());
    assert.equal(basename(target).startsWith('vcsNode console 测试 '), true);
    await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

async function fixture(name, extraArgs = [], port = null) {
  const cwd = join(root, name);
  await mkdir(cwd, { recursive: true });
  const report = join(cwd, 'report.json');
  const args = [dll, report, ...extraArgs];
  const spec = {
    kind: 'service', localRoot: cwd, port,
    start: { cmd: 'dotnet', args, cwd: '.', env: { VCSNODE_CONSOLE_TEST: '环境保留' } },
    identify: { name: 'dotnet.exe', cmdlineIncludes: [dll, report] },
  };
  return { spec, report, cwd, logDir: join(cwd, 'logs') };
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}

test('GenerateClient initializes UTF-8 in a hidden console and preserves cwd, arguments, env and logs', { skip: !windows, timeout: 60000 }, async () => {
  const special = ['带 空格', 'a"b', 'C:\\尾部 空格\\', 'a&b;$()'];
  const f = await fixture('generateclient', special);
  let child;
  const result = await startComponent(f.spec, 'generateclient', { logDir: f.logDir, onSpawn: (c) => { child = c; } });
  if (result.pid) managed.add(result.pid);
  assert.equal(result.ok, true, result.message);
  const report = JSON.parse(await readFile(f.report, 'utf8'));
  assert.equal(report.pid, result.pid);
  assert.equal(child.pid, result.pid, 'exit watcher must use the actual business PID');
  assert.equal(report.visible, false);
  assert.equal(report.cwd.toLowerCase(), f.cwd.toLowerCase());
  assert.equal(report.env, '环境保留');
  assert.deepEqual(report.args.slice(1), special);
  const log = await readFile(result.logFile, 'utf8');
  assert.match(log, /stdout 编码正常/);
  assert.match(log, /stderr 编码正常/);
  // 生产 agent 有 SSE/采样计时器；测试也要在等待 unref 的退出通知时保持事件循环。
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('business exit notification timed out')), 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  const stopped = await stopComponent(f.spec);
  assert.equal(stopped.ok, true, stopped.message);
  await exit;
  assert.equal(pidAlive(result.pid), false);
});

test('GenerateTool avoids duplicate starts and restart replaces the actual business PID', { skip: !windows, timeout: 60000 }, async () => {
  const f = await fixture('generatetool');
  const opts = { logDir: f.logDir };
  const first = await startComponent(f.spec, 'generatetool', opts);
  if (first.pid) managed.add(first.pid);
  assert.equal(first.ok, true, first.message);
  const duplicate = await startComponent(f.spec, 'generatetool', opts);
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(duplicate.pid, first.pid);
  const restarted = await restartComponent(f.spec, 'generatetool', opts);
  if (restarted.pid) managed.add(restarted.pid);
  assert.equal(restarted.ok, true, restarted.message);
  assert.equal(restarted.stoppedPid, first.pid);
  assert.notEqual(restarted.pid, first.pid);
  assert.equal(pidAlive(first.pid), false);
  assert.equal((await stopComponent(f.spec)).ok, true);
});

test('McpServer-style dotnet service is recognized by its listening port and stops cleanly', { skip: !windows, timeout: 60000 }, async () => {
  const port = await freePort();
  const f = await fixture('mcpserver', [String(port)], port);
  const result = await startComponent(f.spec, 'mcpserver', { logDir: f.logDir });
  if (result.pid) managed.add(result.pid);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.listening, true);
  const stopped = await stopComponent(f.spec);
  assert.equal(stopped.ok, true, stopped.message);
  assert.equal(stopped.portFree, true);
});

test('WorkerHost-style business process survives the launching agent exiting', { skip: !windows, timeout: 60000 }, async () => {
  const f = await fixture('workerhost');
  const moduleUrl = new URL('../src/proc.mjs', import.meta.url).href;
  const script = `import {startComponent} from ${JSON.stringify(moduleUrl)};
    const result = await startComponent(${JSON.stringify(f.spec)}, 'workerhost', {logDir:${JSON.stringify(f.logDir)}});
    console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1);`;
  const launched = await run(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, timeout: 45000 });
  const result = JSON.parse(launched.stdout.trim());
  if (result.pid) managed.add(result.pid);
  assert.equal(result.ok, true, result.message);
  assert.equal(pidAlive(result.pid), true);
  assert.equal((await findTarget(f.spec)).pid, result.pid);
  assert.equal((await stopComponent(f.spec)).ok, true);
});

test('console bridge forwards a business exit code instead of reporting the monitor PID or exit code', { skip: !windows, timeout: 20000 }, async () => {
  const logFd = openSync(join(root, 'exit-code.log'), 'a');
  let child;
  try {
    child = await spawnWindowsConsole(process.execPath, ['-e', 'setTimeout(() => process.exit(37), 300)'], {
      cwd: root, env: process.env, logFd,
    });
    managed.add(child.pid);
  } finally {
    closeSync(logFd);
  }
  assert.deepEqual(await once(child, 'exit'), [37, null]);
  assert.equal(pidAlive(child.pid), false);
});

test('console bridge rejects a failed CreateProcess and keeps the native error in the component log', { skip: !windows, timeout: 20000 }, async () => {
  const logFile = join(root, 'create-failed.log');
  const logFd = openSync(logFile, 'a');
  try {
    await assert.rejects(spawnWindowsConsole(join(root, 'missing.exe'), [], { cwd: root, env: process.env, logFd }));
  } finally {
    closeSync(logFd);
  }
  assert.match(await readFile(logFile, 'utf8'), /Win32Exception/);
});

test('startup timeout cleans an already-created business process when PID delivery is delayed', { skip: !windows, timeout: 20000 }, async () => {
  const pidFile = join(root, 'timeout-pid.txt');
  const logFd = openSync(join(root, 'timeout.log'), 'a');
  try {
    const pending = spawnWindowsConsole(process.execPath, ['-e',
      'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);', pidFile,
    ], { cwd: root, env: process.env, logFd, timeoutMs: 500 });
    // 模拟 agent 同步磁盘操作阻塞：业务已启动，但 PID 的 data 事件尚未处理。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
    await assert.rejects(pending, /未返回业务 PID/);
    const pid = Number(await readFile(pidFile, 'utf8'));
    managed.add(pid);
    assert.equal(pidAlive(pid), false, 'spawn_failed must not leave a running untracked business process');
  } finally {
    closeSync(logFd);
  }
});
