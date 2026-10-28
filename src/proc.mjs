/* vcsNode 进程控制（M1：停止 / 启动 / 重启）
 *
 * 原则：
 *   - 只动「我们自己该管的」进程：端口归属 > 进程名 + 命令行关键字（probe.locate），
 *     端口被别人占着（foreign）时一律不动，避免误杀。
 *   - 用的是识别出来的真实 pid，不是 spawn 返回值 —— 这样即使被 cmd.exe 包一层也不会杀错。
 *   - 停完必须确认真的没了（轮询 pid），不能只信 taskkill 的退出码。
 *   - 启动只用配置里的 start.cmd + cwd，绝不在错误的工作目录里跑（dotnet .\X.dll 找不到 appsettings 会静默起错）。
 *   - 不碰文件、不碰 98（98 是人工操作）。
 *
 * 输出一律是 {ok, code, message, ...}，由 agent 转成 ack / nack，不抛裸异常给上层。
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { readInventory, locate, applyRemap, resolveStartCwd } from './probe.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_WIN = process.platform === 'win32';

/** 进程还在不在。EPERM 说明进程存在但没权限查 —— 也算在。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function run(file, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err?.code ?? 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: err ? err.message : null,
      });
    });
  });
}

/**
 * 找到要操作的进程。
 * @returns {{ok:boolean, code?:string, message?:string, pid?:number, matchBy?:string, proc?:object}}
 */
export async function findTarget(spec, inventory = null) {
  let inv = inventory;
  if (!inv) {
    try {
      inv = await readInventory();
    } catch (e) {
      return { ok: false, code: 'inventory_failed', message: `读进程表失败：${e.message}` };
    }
  }

  const loc = locate(spec, inv);
  if (loc.foreign) {
    const owner = loc.portOwner;
    return {
      ok: false,
      code: 'not_ours',
      message: `端口 ${spec.port} 被别人的进程占着（${owner?.name || '?'} pid ${owner?.pid ?? '?'}），不动它`,
    };
  }
  if (!loc.pid) {
    return { ok: false, code: 'not_running', message: '没找到这个组件的进程（可能已经停了）' };
  }

  // 端口是所有「我们的进程」共享的证据，配错端口就会指到邻居身上。
  // 典型：149 上把 webapi.port 写成 7080，而 7080 是 mcpserver 的 —— locate() 只看
  // 进程名（都是 dotnet.exe）就认了。这里再拿命令行对一次，对不上就不动。
  const includes = spec.identify?.cmdlineIncludes;
  if (loc.matchBy === 'port' && includes?.length && loc.proc?.cmd) {
    const cmd = String(loc.proc.cmd).toLowerCase();
    const missing = includes.filter((x) => !cmd.includes(String(x).toLowerCase()));
    if (missing.length) {
      return {
        ok: false,
        code: 'identify_mismatch',
        message: `端口 ${spec.port} 上的进程 pid ${loc.pid} 命令行对不上（缺 ${missing.join(' / ')}），不敢停：${String(loc.proc.cmd).slice(0, 160)}`,
      };
    }
  }

  return { ok: true, pid: loc.pid, matchBy: loc.matchBy, proc: loc.proc || null, inventory: inv };
}

/**
 * 停止一个组件进程（含子进程），并确认真的退出。
 * @param {object} spec 组件规格（port / identify / start ...）
 * @param {{waitMs?:number, inventory?:object}} opts
 */
export async function stopComponent(spec, { waitMs = 12000, inventory = null } = {}) {
  const t0 = Date.now();
  const done = (extra) => ({ ...extra, durationMs: Date.now() - t0 });

  const found = await findTarget(spec, inventory);
  if (!found.ok) return done({ ok: false, code: found.code, message: found.message });

  const { pid } = found;
  const kill = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);

  // taskkill 成功也要复核：控制台程序有时会「退出码 0 但进程还挂着」
  let alive = true;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    alive = pidAlive(pid);
    if (!alive) break;
    await sleep(300);
  }

  // 有端口配置时再确认一遍端口是否释放（最多多花一次采样时间）
  let portFree = null;
  if (!alive && spec.port) {
    try {
      const inv = await readInventory();
      portFree = !inv.listen.some((l) => Number(l.port) === Number(spec.port));
    } catch {
      portFree = null;
    }
  }

  if (alive) {
    return done({
      ok: false,
      code: 'still_alive',
      message: `${waitMs}ms 内进程 ${pid} 还没退出`,
      pid,
      matchBy: found.matchBy,
      kill,
    });
  }

  return done({
    ok: true,
    pid,
    matchBy: found.matchBy,
    portFree,
    kill: { exitCode: kill.exitCode, stdout: kill.stdout, stderr: kill.stderr },
    message: '已停止',
  });
}

export { pidAlive };

/* ── 启动 ────────────────────────────────────────────────── */

/** 端口能不能连上（比读整张进程表便宜两个数量级） */
function tcpOk(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port: Number(port), timeout: timeoutMs });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** Windows 的环境变量名大小写不敏感：process.env 里通常是 Path / ComSpec，不是 PATH */
function envGet(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * 找到命令的真实文件。只为了两件事：
 *   1) `.cmd` / `.bat`（npm、pnpm 这类）不能直接 CreateProcess，得走 shell；
 *   2) 找不到时给出「PATH 里没有」这种一眼能懂的原因，而不是 ENOENT。
 */
function resolveCommand(cmd, cwd, env) {
  const hasSep = /[\\/]/.test(cmd);
  if (hasSep) {
    const base = isAbsolute(cmd) ? cmd : resolvePath(cwd, cmd);
    for (const c of [base, `${base}.exe`, `${base}.cmd`, `${base}.bat`, `${base}.com`]) {
      try { if (statSync(c).isFile()) return c; } catch { /* 下一个 */ }
    }
    return null;
  }
  const exts = IS_WIN
    ? String(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of String(envGet(env, 'PATH') || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const c = join(dir, cmd + ext.toLowerCase());
      try { if (statSync(c).isFile()) return c; } catch { /* 下一个 */ }
    }
  }
  return null;
}

/** cmd.exe 里拼一条命令行：含空格/引号的参数加双引号 */
function quoteCmd(s) {
  const t = String(s);
  return /[\s"&|<>^()]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** 读日志尾巴，进程起不来时把原因直接带回界面 */
function logTail(file, maxBytes = 4096, maxLines = 12) {
  try {
    const buf = readFileSync(file);
    const text = buf.slice(Math.max(0, buf.length - maxBytes)).toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(-maxLines);
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 启动一个组件：按配置的 cwd 起进程，然后把「被 identify 认出来的 pid」当作成功。
 *
 * 成功条件（全部满足才算）：
 *   - 进程出现在进程表里，且 locate() 认得出来（端口/命令行）
 *   - 配了端口的，端口在监听
 * 起不来时把日志尾巴带回去（工作目录错、dll 不在、端口被占，看日志最快）。
 */
export async function startComponent(spec, component, { logDir, remaps = [], waitMs = null } = {}) {
  const t0 = Date.now();
  const done = (extra) => ({ ...extra, durationMs: Date.now() - t0 });

  const start = spec?.start;
  if ((spec?.kind || 'service') === 'asset') {
    return done({ ok: false, code: 'no_target', message: `${component} 是纯文件组件，没有进程可启动` });
  }
  if (!start?.cmd) {
    return done({ ok: false, code: 'no_start', message: `${component} 的配置里没有 start.cmd，只能人工起` });
  }

  const timeoutMs = Number(waitMs || start.timeoutMs || 30000);

  // 1) 已经在跑就别再起一个（重复启动会抢端口，最后两个都不健康）
  const inv0 = await readInventory().catch(() => null);
  if (inv0) {
    const loc0 = locate(spec, inv0);
    if (loc0.foreign) {
      return done({
        ok: false,
        code: 'port_busy',
        message: `端口 ${spec.port} 被 ${loc0.portOwner?.name || '?'} pid ${loc0.portOwner?.pid ?? '?'} 占着，先处理它再启动`,
      });
    }
    if (loc0.pid) {
      return done({ ok: true, pid: loc0.pid, matchBy: loc0.matchBy, listening: loc0.listening, alreadyRunning: true, message: '本来就在跑' });
    }
  }

  // 2) 工作目录：必须在，而且就是配置里算出来的那个
  const cwd = applyRemap(resolveStartCwd(spec.localRoot, start), remaps);
  if (!cwd) return done({ ok: false, code: 'bad_cwd', message: 'localRoot 为空，算不出工作目录' });
  let st = null;
  try { st = statSync(cwd); } catch { /* 下面统一报 */ }
  if (!st) return done({ ok: false, code: 'bad_cwd', message: `工作目录不存在：${cwd}` });
  if (!st.isDirectory()) return done({ ok: false, code: 'bad_cwd', message: `工作目录不是目录：${cwd}` });

  // 3) 命令 + 参数：相对路径一律按 cwd 解析（CreateProcess 不会按子进程 cwd 找 exe）
  const env = { ...process.env, ...(start.env || {}) };
  const cmdRaw = applyRemap(String(start.cmd), remaps);
  const cmdPath = resolveCommand(cmdRaw, cwd, env);
  if (!cmdPath) {
    return done({ ok: false, code: 'spawn_failed', message: `找不到命令 ${cmdRaw}（PATH 里没有，cwd=${cwd}）` });
  }
  const args = (start.args || []).map((a) => {
    const s = applyRemap(String(a), remaps);
    return /[\\/]/.test(s) && !isAbsolute(s) ? resolvePath(cwd, s) : s;
  });

  // .cmd / .bat（npm、pnpm 之类）只能经 cmd.exe；其余直接起，pid 才是真的
  const useShell = IS_WIN && /\.(cmd|bat)$/i.test(cmdPath);
  const comspec = envGet(env, 'ComSpec') || 'cmd.exe';
  const spawnCmd = useShell ? comspec : cmdPath;
  const spawnArgs = useShell
    ? ['/d', '/s', '/c', [cmdPath, ...args].map(quoteCmd).join(' ')]
    : args;
  const cmdline = useShell ? spawnArgs[3] : [cmdPath, ...args].join(' ');

  // 4) 输出落盘：不起 detached 的话 agent 一重启服务就跟着没了
  const dir = logDir || join(dirname(cwd), 'logs');
  let fd = null;
  let logFile = null;
  try {
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, `${component}.log`);
    fd = openSync(logFile, 'a');
    writeSync(fd, `\n===== ${new Date().toISOString()} 启动 ${component}\n  pid(父) ${process.pid}\n  cwd   ${cwd}\n  cmd   ${cmdline}\n`);
  } catch (e) {
    return done({ ok: false, code: 'log_failed', message: `日志目录不可写（${dir}）：${e.message}` });
  }

  let child;
  try {
    child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env,
      detached: true,          // 服务不能跟着 agent 一起死
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    closeSync(fd);
    return done({ ok: false, code: 'spawn_failed', message: `起不来：${e.message}`, cwd, cmdline });
  } finally {
    // 子进程已经拿到句柄副本，父进程这份可以关了
    try { if (fd !== null) closeSync(fd); } catch { /* 已经关了 */ }
  }
  child.unref();

  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  child.once('error', (e) => { exited = { code: null, signal: null, error: e.message }; });

  // 5) 等它真的被认出来（不只是 spawn 成功）
  //    有端口的先廉价地探端口（几十毫秒一次），端口起来了再读一次进程表拿 pid ——
  //    每次 readInventory 要 1.5s 左右，轮询它会把启动等待拖长好几秒。
  const deadline = Date.now() + timeoutMs;
  let portSeen = false;
  while (Date.now() < deadline) {
    if (exited) break;

    if (spec.port && !portSeen) {
      portSeen = await tcpOk(spec.port, 400);
      if (!portSeen) { await sleep(250); continue; }
    }

    const inv = await readInventory().catch(() => null);
    if (inv) {
      const loc = locate(spec, inv);
      const listening = !spec.port || loc.listening;
      if (loc.pid && listening) {
        return done({
          ok: true,
          pid: loc.pid,
          matchBy: loc.matchBy,
          listening: loc.listening,
          logFile,
          spawnedPid: child.pid ?? null,
          message: '已启动',
        });
      }
    }
    await sleep(300);
  }

  if (exited) {
    const tail = logTail(logFile);
    const why = exited.error || `退出码 ${exited.code ?? '?'}${exited.signal ? ` / ${exited.signal}` : ''}`;
    return done({
      ok: false,
      code: 'exited',
      message: `进程起来后立刻退出（${why}）${tail ? `\n${tail}` : ''}`,
      logFile,
      cwd,
      cmdline,
    });
  }

  const tail = logTail(logFile);
  return done({
    ok: false,
    code: 'start_timeout',
    message: `${timeoutMs}ms 内没等到 ${component} 就绪${
      spec.port ? `（端口 ${spec.port} ${portSeen ? '在监听，但认不到对应进程' : '还没监听'}）` : ''
    }${tail ? `\n${tail}` : ''}`,
    logFile,
    cwd,
    cmdline,
    spawnedPid: child.pid ?? null,
  });
}

/* ── 重启 ────────────────────────────────────────────────── */

/** 先停再起。停不下来就不起（避免两个实例抢端口）。 */
export async function restartComponent(spec, component, opts = {}) {
  const t0 = Date.now();
  const stopped = await stopComponent(spec);
  if (!stopped.ok && stopped.code !== 'not_running') {
    return {
      ok: false,
      code: stopped.code,
      message: `重启前停不下来：${stopped.message}`,
      durationMs: Date.now() - t0,
    };
  }
  const started = await startComponent(spec, component, opts);
  return {
    ...started,
    wasRunning: stopped.ok === true,
    durationMs: Date.now() - t0,
  };
}
