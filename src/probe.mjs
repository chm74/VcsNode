/* vcsNode 本机观测（只读，M0）
 *
 * 只做三件事：
 *   1. 读出本机进程表（pid / 父 pid / 进程名 / 启动时间 / 命令行）
 *   2. 读出监听端口与 ESTABLISHED 连接（含所属 pid）
 *   3. 按配置里的 identify / health 判断「每个组件是不是在跑」
 *
 * 不做任何启停，不写业务目录，不跟随 junction。
 *
 * 为什么用 PowerShell：Windows 上没有零依赖的方式拿到进程命令行。
 * Win32_Process 的 CommandLine 是识别 `dotnet xxx.dll` 的唯一可靠依据
 * （一台机器上十几个 dotnet.exe，只看进程名必然杀错）。
 *
 * 性能：一次采样约 300~900ms（一次 PowerShell 调用取全部数据）。
 * 正常运行身份（非管理员）能读到别的用户进程的 pid/名字，但 CommandLine 可能为空 ——
 * 那就只能靠端口归属来判断，快照里会标 matchBy=port 或 notes。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import http from 'node:http';

const PWSH = 'powershell.exe';
const INVENTORY_TIMEOUT_MS = 20000;
const MAX_BUFFER = 32 * 1024 * 1024;

/* 一次调用取全部数据。
 * 用 -EncodedCommand（UTF-16LE + base64）传脚本，避开 Windows 命令行引号转义和
 * PowerShell 5.1 的 ANSI 读法问题 —— 脚本里可以放心用引号与中文注释。
 */
const INVENTORY_PS = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$p = @(Get-CimInstance Win32_Process | ForEach-Object {',
  '  $s = $null;',
  '  if ($_.CreationDate) { $s = $_.CreationDate.ToString("o") }',
  '  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name;',
  '                    started = $s; exe = $_.ExecutablePath; cmd = $_.CommandLine }',
  '})',
  '$l = @(); try { $l = @(Get-NetTCPConnection -State Listen | ForEach-Object {',
  '  [pscustomobject]@{ addr = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } }) } catch { }',
  '$e = @(); try { $e = @(Get-NetTCPConnection -State Established | ForEach-Object {',
  '  [pscustomobject]@{ lport = [int]$_.LocalPort; raddr = $_.RemoteAddress; rport = [int]$_.RemotePort; pid = [int]$_.OwningProcess } }) } catch { }',
  '[pscustomobject]@{ procs = $p; listen = $l; est = $e } | ConvertTo-Json -Depth 5 -Compress',
].join('\n');

const INVENTORY_ENCODED = Buffer.from(INVENTORY_PS, 'utf16le').toString('base64');

function exec(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: MAX_BUFFER, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(String(stdout || ''));
    });
  });
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v === null || v === undefined ? [] : [v];
}

/** LISTENING / ESTABLISHED 的兜底（Get-NetTCPConnection 不可用时） */
async function netstatPorts() {
  const out = await exec('netstat', ['-ano', '-p', 'tcp'], { timeout: 15000 });
  const listen = [];
  const est = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)$/);
    if (!m) continue;
    const [, laddr, lport, raddr, rport, state, pid] = m;
    if (state === 'LISTENING') listen.push({ addr: laddr, port: Number(lport), pid: Number(pid) });
    else if (state === 'ESTABLISHED') est.push({ lport: Number(lport), raddr, rport: Number(rport), pid: Number(pid) });
  }
  return { listen, est };
}

/**
 * 读一次本机清单。
 * @returns {Promise<{ms:number, procs:Array, listen:Array, est:Array, fallback?:string}>}
 */
export async function readInventory({ timeoutMs = INVENTORY_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  let data;
  try {
    const out = await exec(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', INVENTORY_ENCODED], {
      timeout: timeoutMs,
    });
    data = JSON.parse(out.replace(/^\uFEFF/, '').trim());
  } catch (e) {
    throw new Error(`读取进程清单失败：${e.message}${e.stderr ? ' / ' + String(e.stderr).trim().slice(0, 300) : ''}`);
  }

  const procs = asArray(data.procs).map((p) => ({
    pid: Number(p.pid),
    ppid: Number(p.ppid),
    name: p.name || '',
    started: p.started || null,
    exe: p.exe || null,
    cmd: p.cmd || null,
  })).filter((p) => Number.isFinite(p.pid));

  let listen = asArray(data.listen).map((l) => ({ addr: l.addr || '', port: Number(l.port), pid: Number(l.pid) }));
  let est = asArray(data.est).map((l) => ({
    lport: Number(l.lport), raddr: l.raddr || '', rport: Number(l.rport), pid: Number(l.pid),
  }));

  let fallback = null;
  if (!listen.length && procs.length) {
    // Get-NetTCPConnection 被策略禁用时，退到 netstat（进程命令行还有，只是端口慢一点）
    try {
      const ns = await netstatPorts();
      listen = ns.listen;
      est = ns.est;
      fallback = 'netstat';
    } catch {
      fallback = 'none';
    }
  }

  return { ms: Date.now() - t0, procs, listen, est, fallback };
}

/* ── 路径映射（只用于开发机试跑，生产不传） ──────────────── */

/**
 * 启动工作目录：`start.cwd` 一律相对 localRoot（`.` 或缺省 = localRoot 本身）。
 * 跨机器路径不同，写绝对路径只可能对一台机器有效，所以除了本地临时排查，不建议用。
 */
export function resolveStartCwd(localRoot, start) {
  const cwd = start?.cwd;
  if (cwd && isAbsolute(cwd)) return cwd;
  if (!localRoot) return null;
  return resolvePath(localRoot, cwd || '.');
}

export function applyRemap(p, remaps = []) {
  if (!p) return p;
  const low = String(p).toLowerCase();
  for (const r of remaps) {
    if (!r || !r.from) continue;
    if (low.startsWith(String(r.from).toLowerCase())) return r.to + String(p).slice(String(r.from).length);
  }
  return p;
}

/* ── 组件定义 ────────────────────────────────────────────── */

function fillPlaceholders(value, ctx) {
  if (typeof value === 'string') {
    return value
      .replace(/\{port\}/g, ctx.port === null || ctx.port === undefined ? '' : String(ctx.port))
      .replace(/\{webapiHost\}/g, ctx.webapiHost || '');
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillPlaceholders(v, ctx);
    return out;
  }
  return value;
}

function mergeHealth(base, override) {
  if (!base && !override) return null;
  if (!override) return base;
  if (!base) return override;
  return { ...base, ...override };
}

/**
 * 把 cluster 配置折算成「某台机器实际该管哪些组件、装在哪」。
 * 规则：节点没声明的组件不管；enabled:false 不管；localRoot 为 null（未确认）不管。
 */
export function componentSpecs(config, ip) {
  const node = config?.nodes?.[ip];
  if (!node) return null;

  const out = {};
  for (const [name, base] of Object.entries(config.components || {})) {
    if (!base) continue;
    const ov = node.components?.[name];
    if (!ov) continue;
    if (ov.enabled === false || base.enabled === false) continue;

    const localRoot = ov.localRoot === undefined ? (base.localRoot ?? null) : ov.localRoot;
    if (localRoot === null) continue;

    const port = ov.port === undefined ? (base.port ?? null) : ov.port;
    out[name] = fillPlaceholders({
      kind: base.kind || 'service',
      localRoot,
      port,
      updateMode: base.updateMode || 'in-place',
      identify: base.identify || null,
      health: mergeHealth(base.health, ov.health),
      dependsOn: base.dependsOn || [],
      start: base.start || null,
      startCwd: resolveStartCwd(localRoot, base.start),
      localConfig: base.localConfig || [],
      restartOn: base.restartOn ?? null,
    }, { port, webapiHost: ip });
  }
  return out;
}

/* ── 认进程 ──────────────────────────────────────────────── */

const lc = (s) => String(s ?? '').toLowerCase();
const bareIp = (s) => String(s ?? '').replace(/^::ffff:/, '');

function cmdMatches(proc, includes) {
  if (!includes || !includes.length) return true;
  const cmd = lc(proc.cmd);
  if (!cmd) return false; // 读不到命令行就不能认领，宁可报未知
  return includes.every((x) => cmd.includes(lc(x)));
}

function sameExe(proc, name) {
  if (!name) return true;
  // name 可以是数组：同一个组件允许两种启动形态（dotnet X.dll / X.exe 自宿主）
  const names = Array.isArray(name) ? name : [name];
  return names.some((n) => lc(proc?.name) === lc(n));
}

/**
 * 定位「我们的进程」。
 *
 * 顺序：端口归属 > 进程名 + 命令行关键字。
 * 端口归属是最硬证据 —— shp_* 是 `node index.js`，命令行里根本没有目录名，
 * 但它们是 4000/4001 的监听者，按端口认不会错。
 */
export function locate(spec, inv) {
  const identify = spec.identify || null;
  const port = spec.port === null || spec.port === undefined ? null : Number(spec.port);

  const listeners = port ? inv.listen.filter((l) => Number(l.port) === port) : [];
  const listening = listeners.length > 0;
  const listenerPids = [...new Set(listeners.map((l) => Number(l.pid)))];
  const base = { listening, matchBy: null, portOwner: null, ambiguous: 0 };

  if (port && listening) {
    const owner = inv.procs.find((p) => p.pid === listenerPids[0]) || null;
    if (identify?.name && owner && !sameExe(owner, identify.name)) {
      // 端口有人占，但不是我们该管的进程 —— 典型的「野进程」
      return {
        ...base,
        pid: null,
        proc: null,
        portOwner: { pid: owner.pid, name: owner.name, exe: owner.exe, started: owner.started },
        foreign: true,
      };
    }
    return {
      ...base,
      pid: owner?.pid ?? listenerPids[0],
      proc: owner,
      matchBy: 'port',
      foreign: false,
    };
  }

  if (!identify?.name) return { ...base, pid: null, proc: null, foreign: false };

  const cands = inv.procs.filter((p) => sameExe(p, identify.name) && cmdMatches(p, identify.cmdlineIncludes));
  if (!cands.length) return { ...base, pid: null, proc: null, foreign: false };

  cands.sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));
  return {
    ...base,
    pid: cands[0].pid,
    proc: cands[0],
    matchBy: 'cmdline',
    foreign: false,
    ambiguous: cands.length > 1 ? cands.length : 0,
  };
}

/* ── 探活 ────────────────────────────────────────────────── */

function checkTcp(port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port, timeout: timeoutMs });
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

function checkHttp({ port, path = '/' }, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ status: Number(res.statusCode) || 0 });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: `timeout ${timeoutMs}ms` });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req.end();
  });
}

function checkConn(health, inv, pid) {
  const rport = Number(health.remotePort);
  const raddr = health.remoteHost ? bareIp(health.remoteHost) : null;
  const target = raddr ? `${raddr}:${rport}` : `:${rport}`;

  if (!pid) {
    return { ok: false, remote: target, count: 0, note: '进程不在，无法建立连接' };
  }

  // 必须按 pid 过滤：同一台机器上好几个客户端都连 3601，
  // 不按 pid 的话「A 连着」会让 B 也显示成健康 —— 那正是假活漏判的根源。
  const owned = inv.est.filter((e) => Number(e.pid) === Number(pid) && Number(e.rport) === rport);
  const exact = raddr ? owned.filter((e) => bareIp(e.raddr) === raddr) : owned;

  if (exact.length) {
    return { ok: true, remote: `${raddr || bareIp(exact[0].raddr)}:${rport}`, count: exact.length, note: null };
  }
  if (owned.length) {
    const actual = [...new Set(owned.map((e) => `${bareIp(e.raddr)}:${rport}`))].join(', ');
    // 连上了，但不是配置里那台 —— 最常见的是 SignalRUrl 写错，属于假活
    return { ok: false, remote: actual, count: owned.length, note: `期望 ${target}，实际连的是 ${actual}` };
  }

  const others = inv.est.filter((e) => Number(e.rport) === rport && Number(e.pid) !== Number(pid));
  return {
    ok: false,
    remote: target,
    count: 0,
    note: others.length ? `本进程没有到 ${target} 的连接（同机另有 ${others.length} 个进程连着 ${rport}）` : null,
  };
}

/* ── 单个组件观测 ────────────────────────────────────────── */

export async function observeComponent(id, spec, inv, { remaps = [], now = Date.now() } = {}) {
  const root = applyRemap(spec.localRoot, remaps);
  const kind = spec.kind || 'service';
  const notes = [];

  let rootExists = false;
  try {
    rootExists = !!root && existsSync(root);
  } catch {
    rootExists = false;
  }
  if (!rootExists) notes.push(`localRoot 不存在：${root || '(未配置)'}`);

  const loc = locate(spec, inv);
  if (loc.foreign && loc.portOwner) {
    notes.push(`端口 ${spec.port} 被 ${loc.portOwner.name}(pid ${loc.portOwner.pid}) 占用`);
  }
  if (loc.ambiguous) notes.push(`命令行匹配到 ${loc.ambiguous} 个进程，取最新的一个`);

  let health = null;
  let conn = null;

  if (kind === 'asset') {
    // 纯文件，没有进程可查
  } else if (spec.health) {
    const h = spec.health;
    if (h.type === 'connection') {
      const c = checkConn(h, inv, loc.pid);
      conn = { remote: c.remote, established: c.ok, count: c.count };
      health = { ok: c.ok, checkedAt: now, detail: c.ok ? `ESTABLISHED ×${c.count}` : (c.note || '没有到目标的已建立连接') };
      if (c.note) notes.push(c.note);
    } else if (h.type === 'tcp') {
      const p = Number(h.port ?? spec.port);
      const ok = loc.pid ? await checkTcp(p, h.timeoutMs || 3000) : false;
      health = { ok, checkedAt: now, detail: ok ? `tcp ${p} open` : (loc.pid ? `tcp ${p} 不通` : '进程不在，跳过探活') };
    } else if (h.type === 'http') {
      const p = Number(spec.port ?? h.port);
      const expect = Number(h.expectStatus || 200);
      const r = loc.pid ? await checkHttp({ port: p, path: h.path || '/' }, h.timeoutMs || 5000) : { status: 0, error: '进程不在' };
      const ok = r.status === expect;
      health = {
        ok,
        checkedAt: now,
        status: r.status || 0,
        detail: r.status ? `HTTP ${r.status}${ok ? '' : `（期望 ${expect}）`}` : String(r.error || '请求失败'),
      };
    }
  }

  let state;
  if (kind === 'asset') state = rootExists ? 'running' : 'unknown';
  else if (loc.pid) state = 'running';
  else if (!rootExists) state = 'unknown';
  else state = 'stopped';

  return {
    id,
    kind,
    state,
    pid: loc.pid ?? null,
    createdAt: loc.proc?.started || null,
    exe: loc.proc?.exe || null,
    cmdline: loc.proc?.cmd ? String(loc.proc.cmd).slice(0, 400) : null,
    cmdHash: loc.proc?.cmd
      ? 'sha256:' + createHash('sha256').update(String(loc.proc.cmd).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
      : null,
    cwd: null, // Win32_Process 不提供工作目录；需要它只能由我们自己 spawn 时记录
    port: spec.port ?? null,
    listening: loc.listening,
    portOwner: loc.portOwner,
    matchBy: loc.matchBy,
    conn,
    health,
    notes,
  };
}

/* ── 整机采样 ────────────────────────────────────────────── */

/**
 * @param {Object} specs  componentSpecs() 的结果
 * @returns {Promise<{ok:boolean, ms:number, inv?:object, components?:Array, error?:string}>}
 */
export async function sampleSpecs(specs, { remaps = [], now = Date.now() } = {}) {
  const t0 = Date.now();
  const entries = Object.entries(specs || {});
  if (!entries.length) return { ok: true, ms: 0, inv: null, components: [] };

  let inv;
  try {
    inv = await readInventory();
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, components: [], error: e.message };
  }

  const components = await Promise.all(
    entries.map(([id, spec]) => observeComponent(id, spec, inv, { remaps, now })),
  );

  return {
    ok: true,
    ms: Date.now() - t0,
    inv: { procs: inv.procs.length, listen: inv.listen.length, est: inv.est.length, invMs: inv.ms, fallback: inv.fallback || null },
    components,
  };
}

/** 主节点本机采样用：直接从 cluster 配置折算 */
export async function sampleNode(config, ip, opts = {}) {
  const specs = componentSpecs(config, ip);
  if (!specs) return { ok: false, ms: 0, components: [], error: `配置里没有节点 ${ip}` };
  return sampleSpecs(specs, opts);
}
