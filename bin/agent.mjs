#!/usr/bin/env node
/* vcsNode agent · M0（只读）
 *
 * 做什么：
 *   1. 读本机 agent.bootstrap.json（主节点地址 / nodeId / secret / 缓存目录）
 *   2. 向主节点建一条出站常驻 SSE 连接（HMAC 签名，不开任何入站端口）
 *   3. 周期性本机采样（进程 / 端口 / 连接），把观测值 POST /api/agent/report
 *   4. 主节点在 hello 里下发「这台机器该管哪些组件、装在哪」，
 *      本地缓存到 <cacheDir>\node-config.json，主节点临时不可达也能继续采样
 *
 * 不做什么：
 *   - 不启停任何进程（M1 才有）
 *   - 不碰业务目录，不读业务文件
 *   - 不监听任何端口
 *
 * 用法：
 *   node bin/agent.mjs                          # 常驻
 *   node bin/agent.mjs --once                   # 采样一次，打印 JSON，退出
 *   node bin/agent.mjs --inventory              # 只打印本机进程/端口清单（不需要主节点）
 *   node bin/agent.mjs --inventory --filter dotnet
 *   node bin/agent.mjs --bootstrap C:\vcsNode\agent.bootstrap.json
 *   node bin/agent.mjs --interval 15000         # 采样间隔（默认 10000ms）
 *   node bin/agent.mjs --remap D:\Deploy=E:\tmp\fake   # 开发机试跑用
 *
 * 日志一律写 stderr，stdout 只留 --once 的 JSON。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';

import { readJson, writeJsonAtomic } from '../src/state.mjs';
import { sampleSpecs, readInventory } from '../src/probe.mjs';
import { stopComponent, startComponent, restartComponent } from '../src/proc.mjs';
import { applyRelease } from '../src/sync.mjs';
import { signRequest, PROTO } from '../src/agent-auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const AGENT_VERSION = '0.1.3-m2';
const DEFAULT_SAMPLE_MS = 10_000;
const HEARTBEAT_MS = 30_000;      // 没变化也每 30s 报一次，主节点才知道「还活着」
const READ_TIMEOUT_MS = 45_000;   // 这么长时间没收到任何字节 → 判定链路死了
const BACKOFF = [1000, 2000, 5000, 10_000, 30_000];

/* ── 参数 ─────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = {
    bootstrap: join(ROOT, 'agent.bootstrap.json'),
    once: false,
    inventory: false,
    json: false,
    filter: null,
    interval: DEFAULT_SAMPLE_MS,
    remaps: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(`用法：node bin/agent.mjs [--bootstrap <file>] [--once] [--inventory] [--filter <s>] [--interval <ms>] [--remap OLD=NEW]`);
      process.exit(0);
    } else if (a === '--bootstrap') out.bootstrap = resolve(argv[++i]);
    else if (a === '--once') out.once = true;
    else if (a === '--inventory') out.inventory = true;
    else if (a === '--json') out.json = true;
    else if (a === '--filter') out.filter = argv[++i] || null;
    else if (a === '--interval') out.interval = Math.max(2000, Number(argv[++i]) || DEFAULT_SAMPLE_MS);
    else if (a === '--remap') {
      const v = argv[++i] || '';
      const at = v.indexOf('=');
      if (at < 1) throw new Error(`--remap 需要 OLD=NEW 形式，收到：${v}`);
      out.remaps.push({ from: v.slice(0, at), to: v.slice(at + 1) });
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const log = (msg) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} [agent] ${msg}\n`);
const warn = (msg) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} [agent] ! ${msg}\n`);

/* ── 引导配置 ─────────────────────────────────────────── */

async function loadBootstrap() {
  const file = args.bootstrap;
  if (!existsSync(file)) {
    throw new Error(
      `找不到引导配置 ${file}\n` +
      `  从 config\\agent.bootstrap.example.json 复制一份，填 master / nodeId / secret / cacheDir`,
    );
  }
  // 记事本 / PowerShell 写出来的 JSON 常带 BOM，JSON.parse 会直接报 Unexpected token
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON：${e.message}（常见原因：结尾多余逗号、注释、中文引号）`);
  }
  for (const k of ['master', 'nodeId', 'secret', 'cacheDir']) {
    if (!raw[k]) throw new Error(`${file} 缺字段 ${k}`);
  }
  const [host, portRaw] = String(raw.master).split(':');
  const port = Number(portRaw) || 47821;
  const cacheDir = resolve(String(raw.cacheDir));
  return {
    file,
    host,
    port,
    // 只有显式写 allowControl: true 才执行启停指令；只读部署不带这一项
    allowControl: raw.allowControl === true,
    nodeId: String(raw.nodeId),
    secret: String(raw.secret),
    cacheDir,
    // 服务自己的 stdout/stderr 落在这里（每个组件一个 <component>.log）
    logDir: raw.logDir ? resolve(String(raw.logDir)) : join(dirname(cacheDir), 'logs'),
    // 覆盖前的旧文件备份在这里：<backupDir>\<relId>\<组件>\<相对路径>
    backupDir: raw.backupDir ? resolve(String(raw.backupDir)) : join(dirname(cacheDir), 'backup'),
  };
}

let boot;

/* ── 采样（--inventory / --once 共用） ─────────────────── */

function printInventory(inv) {
  const byPid = new Map(inv.procs.map((p) => [p.pid, p]));
  const f = args.filter ? String(args.filter).toLowerCase() : null;

  const procs = inv.procs
    .filter((p) => !f || [p.name, p.exe, p.cmd].some((v) => v && String(v).toLowerCase().includes(f)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);

  const lines = [];
  lines.push(`# vcsNode 本机清单  host=${os.hostname()}  ${new Date().toISOString()}  读取 ${inv.ms}ms`);
  lines.push(`# 进程 ${inv.procs.length} 个（显示 ${procs.length}）· 监听 ${inv.listen.length} · ESTABLISHED ${inv.est.length}${inv.fallback ? ` · 端口来源 ${inv.fallback}` : ''}`);
  lines.push('');
  lines.push('## 进程');
  for (const p of procs) {
    const started = (p.started || '').replace('T', ' ').slice(0, 19);
    lines.push(`${String(p.name).padEnd(28)} ${String(p.pid).padStart(6)}  ${started}  ${p.exe || ''}`);
    if (p.cmd) lines.push(`${''.padEnd(28)} ${''.padStart(6)}  ${String(p.cmd).replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  lines.push('');
  lines.push('## 监听端口');
  for (const l of [...inv.listen].sort((a, b) => a.port - b.port)) {
    const owner = byPid.get(l.pid);
    lines.push(`${String(l.addr).padEnd(18)} :${String(l.port).padEnd(6)} pid ${String(l.pid).padStart(6)}  ${owner ? owner.name : '?'}`);
  }

  lines.push('');
  lines.push('## ESTABLISHED（按远端端口归并）');
  const grouped = new Map();
  for (const e of inv.est) {
    const key = `${e.raddr}:${e.rport}`;
    const g = grouped.get(key) || { count: 0, pids: new Set() };
    g.count++;
    g.pids.add(e.pid);
    grouped.set(key, g);
  }
  for (const [key, g] of [...grouped].sort((a, b) => b[1].count - a[1].count).slice(0, 40)) {
    const names = [...g.pids].slice(0, 4).map((pid) => `${byPid.get(pid)?.name || '?'}(${pid})`).join(', ');
    lines.push(`${String(g.count).padStart(4)}  ${key.padEnd(26)} ${names}`);
  }

  return lines.join('\n');
}

/* ── HTTP ─────────────────────────────────────────────── */

function httpPost({ path, headers, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    const req = http.request({
      host: boot.host,
      port: boot.port,
      path,
      method: 'POST',
      timeout: timeoutMs,
      agent: false,
      headers: { ...headers, 'Content-Length': buf.length, 'Content-Type': 'application/json; charset=utf-8' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`POST ${path} 超时`)));
    req.on('error', reject);
    req.end(buf);
  });
}

async function report(type, payload) {
  const body = JSON.stringify({ node: boot.nodeId, type, sentAt: Date.now(), payload });
  const path = '/api/agent/report';
  const signed = signRequest({
    secret: boot.secret, nodeId: boot.nodeId, method: 'POST', path, body,
  });
  const res = await httpPost({ path, headers: signed.headers, body });
  if (res.status !== 200) {
    const code = res.json?.code || res.json?.error || '';
    throw new Error(`上报失败 HTTP ${res.status} ${code} ${res.text.slice(0, 200)}`.trim());
  }
  return res.json;
}

/* ── SSE ──────────────────────────────────────────────── */

function parseSse(raw) {
  let event = 'message';
  let id = null;
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const at = line.indexOf(':');
    const field = at === -1 ? line : line.slice(0, at);
    let value = at === -1 ? '' : line.slice(at + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'id') id = Number(value);
    else if (field === 'data') dataLines.push(value);
  }
  const text = dataLines.join('\n');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { event, id, data };
}

function openStream({ since, onEvent, onOpen, onClose }) {
  const path = `/api/agent/stream?since=${Number(since) || 0}`;
  const signed = signRequest({ secret: boot.secret, nodeId: boot.nodeId, method: 'GET', path });

  const req = http.request({
    host: boot.host,
    port: boot.port,
    path,
    method: 'GET',
    timeout: READ_TIMEOUT_MS,
    agent: false,
    headers: { ...signed.headers, Accept: 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        const err = new Error(`SSE 握手失败 HTTP ${res.statusCode} ${json?.code || json?.error || text.slice(0, 200)}`.trim());
        err.status = res.statusCode;
        err.code = json?.code;
        onClose(err);
      });
      return;
    }

    if (res.socket) res.socket.setKeepAlive(true, 10_000);
    onOpen();
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf = (buf + chunk).replace(/\r\n/g, '\n');
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (!raw.trim()) continue;
        const ev = parseSse(raw);
        try { onEvent(ev); } catch (e) { warn(`处理 ${ev.event} 出错：${e.message}`); }
      }
    });
    res.on('end', () => onClose(new Error('主节点关闭了连接')));
    res.on('error', (e) => onClose(e));
  });

  req.on('timeout', () => req.destroy(new Error(`${READ_TIMEOUT_MS / 1000}s 没收到任何数据`)));
  req.on('error', (e) => onClose(e));
  req.end();
  return req;
}

/* ── 状态 ─────────────────────────────────────────────── */

const st = {
  cfg: null,             // { revision, components, updatedAt }
  connected: false,
  seq: 0,
  lastSentJson: null,
  lastSentAt: 0,
  lastStates: {},
  backoffIndex: 0,
  req: null,
  stopping: false,
};

const configFile = () => join(boot.cacheDir, 'node-config.json');
const agentFile = () => join(boot.cacheDir, 'agent.json');

async function loadCache() {
  const cached = await readJson(configFile(), null);
  if (cached?.components && Object.keys(cached.components).length) {
    st.cfg = cached;
    log(`缓存配置 rev=${cached.revision ?? '?'} 组件 ${Object.keys(cached.components).length} 个（${configFile()}）`);
  }
  const ag = await readJson(agentFile(), null);
  if (ag && Number.isFinite(Number(ag.lastSeq))) st.seq = Number(ag.lastSeq);
}

async function persistSeq() {
  try {
    await writeJsonAtomic(agentFile(), { lastSeq: st.seq, updatedAt: new Date().toISOString() });
  } catch { /* 缓存目录不可写不该影响采样 */ }
}

async function applyConfigFromHello(payload) {
  const comps = payload?.node?.components;
  if (!comps) {
    warn('hello 里没有 node.components，保留本地缓存配置');
    return false;
  }
  const next = {
    revision: payload.configRevision ?? null,
    updatedAt: new Date().toISOString(),
    components: comps,
  };
  const before = st.cfg ? JSON.stringify(st.cfg.components) : '';
  st.cfg = next;
  try {
    await writeJsonAtomic(configFile(), next);
  } catch (e) {
    warn(`写缓存配置失败：${e.message}`);
  }
  if (before !== JSON.stringify(comps)) {
    log(`配置 rev=${next.revision} 组件 ${Object.keys(comps).length} 个：${Object.keys(comps).join(', ')}`);
  }
  return true;
}

/* ── 采样 + 上报 ──────────────────────────────────────── */

async function ensureConfig() {
  if (st.cfg) return st.cfg;
  throw new Error('还没有拿到组件配置：先用在线模式连一次主节点（或用 --once 连一次），本地缓存里就有 node-config.json 了');
}

function summarizeChanges(components) {
  const next = {};
  const out = [];
  for (const c of components) {
    next[c.id] = c.state;
    const prev = st.lastStates[c.id];
    if (prev === c.state) continue;
    // 只有「进程在但探活没过」才值得把探活原因一起打出来
    const why = c.state === 'running' && c.health && c.health.ok === false ? `（${c.health.detail}）` : '';
    out.push(`${c.id} ${prev || '—'}→${c.state}${why}`);
  }
  st.lastStates = next;
  return out;
}

async function sampleAndReport({ force = false } = {}) {
  const cfg = await ensureConfig();
  const res = await sampleSpecs(cfg.components, { remaps: args.remaps });
  if (!res.ok) {
    warn(`采样失败：${res.error}`);
    return;
  }

  const payload = {
    host: os.hostname(),
    agentVersion: AGENT_VERSION,
    uptimeSec: Math.round(process.uptime()),
    configRevision: cfg.revision ?? null,
    lastSeq: st.seq,
    sampleMs: res.ms,
    inventory: res.inv,
    components: res.components,
  };

  const signature = JSON.stringify(res.components.map((c) => [c.id, c.state, c.pid, c.listening, c.health?.ok, c.conn?.established]));
  const changed = signature !== st.lastSentJson;
  const due = Date.now() - st.lastSentAt >= HEARTBEAT_MS;
  if (!force && !changed && !due) return;

  const notes = summarizeChanges(res.components);
  try {
    await report('snapshot', payload);
    st.lastSentJson = signature;
    st.lastSentAt = Date.now();
    if (changed && notes.length) log(`上报 · ${notes.join(' · ')}`);
    else if (changed) log(`上报 · ${res.components.length} 组件`);
    else if (force) log(`上报 · ${res.components.length} 组件（${res.ms}ms）`);
    else log(`上报 · 心跳 ${res.components.length} 组件（${res.ms}ms）`);
  } catch (e) {
    warn(`${e.message}（下个周期重试）`);
  }
}

/* ── 事件处理 ─────────────────────────────────────────── */

async function onEvent(ev) {
  if (ev.id !== null && Number.isFinite(ev.id) && ev.id > st.seq) {
    st.seq = ev.id;
  }

  if (ev.event === 'hello') {
    const p = ev.data || {};
    if (p.proto && Number(p.proto) !== PROTO) {
      warn(`主节点 proto=${p.proto}，本机 ${PROTO}，请同步升级`);
    }
    st.seq = Number(p.seq ?? 0);
    await applyConfigFromHello(p);
    log(`已连接 ${boot.host}:${boot.port} node=${boot.nodeId} configRevision=${p.configRevision ?? '?'}`);
    await sampleAndReport({ force: true });
    return;
  }

  if (ev.event === 'ping') return;

  if (ev.event === 'config') {
    await applyConfigFromHello(ev.data || {});
    await sampleAndReport({ force: true });
    return;
  }

  if (ev.event === 'task') {
    const t = ev.data || {};
    const taskId = t.id ?? null;
    const kind = String(t.kind || '');
    const component = String(t.component || '');
    const seq = t.seq ?? ev.id;
    const nack = async (code, message, extra = {}) => {
      try {
        await report('nack', { seq, taskId, code, message, kind, component, ...extra });
      } catch (e) {
        warn(`回 nack 失败：${e.message}`);
      }
    };

    if (!boot.allowControl) {
      warn(`收到 task ${kind}/${component}，但本地是只读模式，拒绝执行`);
      await nack('control_disabled', '本机 bootstrap 没有 allowControl: true，agent 只观测不执行');
      return;
    }
    if (st.taskRunning) {
      await nack('busy', '上一条指令还在执行，稍后重试');
      return;
    }

    /* ── 更新文件（M2）：不启停进程，只按 manifest 覆盖/删除文件 ── */
    if (kind === 'stage') {
      const p = t.params || {};
      const releaseId = String(p.releaseId || '');
      const share = String(p.share || '');
      if (!releaseId || !share) {
        await nack('bad_request', 'stage 缺 params.releaseId / params.share');
        return;
      }

      st.taskRunning = true;
      log(`收到 task ${taskId || ''} 更新文件 ${releaseId}`);
      let r;
      try {
        const manifest = await readJson(join(share, 'manifest.json'));
        if (!manifest) {
          await nack('manifest_missing', `共享上找不到 ${share}\\manifest.json（共享没挂上？权限？）`);
          return;
        }
        r = await applyRelease({
          manifest,
          share,
          specs: st.cfg?.components || {},
          backupRoot: boot.backupDir,
          components: Array.isArray(p.components) && p.components.length ? p.components : manifest.components,
          includeDeletes: p.includeDeletes !== false,
        });
      } catch (e) {
        warn(`更新文件 ${releaseId} 失败：${e.message}`);
        await nack(e.code || 'error', e.message);
        return;
      } finally {
        st.taskRunning = false;
      }

      const summary = `写入 ${r.landed} · 删除 ${r.deleted} · 跳过 ${r.skipped} · ${(r.bytes / 1024).toFixed(1)} KB`;
      if (r.ok) {
        log(`已更新 ${releaseId}：${summary}（${r.durationMs}ms）`);
        await report('ack', {
          seq, taskId, status: 'ok', kind, component: null, releaseId,
          landed: r.landed, deleted: r.deleted, skipped: r.skipped, bytes: r.bytes,
          durationMs: r.durationMs, message: summary,
        });
      } else {
        const first = r.errors[0];
        warn(`更新 ${releaseId} 有失败：${summary} · ${first?.code} ${first?.component}/${first?.path} ${first?.message}`);
        await report('nack', {
          seq, taskId, code: 'partial', kind, component: null, releaseId,
          message: `部分文件没落成：${summary}；${first ? `${first.component}/${first.path}：${first.message}` : ''}`,
          landed: r.landed, deleted: r.deleted, skipped: r.skipped, bytes: r.bytes,
          durationMs: r.durationMs, errors: r.errors.slice(0, 5),
        });
      }
      return;
    }

    const spec = st.cfg?.components?.[component];
    if (!spec) {
      await nack('not_configured', `本机配置里没有组件 ${component}（可能刚改过配置还没收到 hello）`);
      return;
    }
    const ACTIONS = {
      stop: { label: '停止' },
      start: { label: '启动' },
      restart: { label: '重启' },
    };
    if (!ACTIONS[kind]) {
      await nack('unsupported', `不认识的指令 ${kind || '(空)'}，只支持 ${Object.keys(ACTIONS).join(' / ')}`);
      return;
    }
    if ((spec.kind || 'service') === 'asset') {
      await nack('unsupported', `${component} 是纯文件组件，没有进程可${ACTIONS[kind].label}`);
      return;
    }

    st.taskRunning = true;
    log(`收到 task ${taskId || ''} ${ACTIONS[kind].label} ${component}`);
    let r;
    try {
      if (kind === 'stop') r = await stopComponent(spec);
      else if (kind === 'start') r = await startComponent(spec, component, { logDir: boot.logDir, remaps: args.remaps });
      else r = await restartComponent(spec, component, { logDir: boot.logDir, remaps: args.remaps });
    } catch (e) {
      st.taskRunning = false;
      warn(`${ACTIONS[kind].label} ${component} 异常：${e.message}`);
      await nack('error', e.message);
      return;
    }

    // 先把最新观测推给主节点，再回执：主节点一收到 ack，矩阵里就已经是终态，
    // 界面刷新时不会先看到「运行中 → 假活 → 已停止」的中间态。
    // 失败时没有新状态可推（本来就停着 / 起不来），就别白等 1.5 秒。
    if (r.ok) {
      try { await sampleAndReport({ force: true }); } catch { /* 下一轮会补 */ }
    }

    try {
      if (r.ok) {
        const how = r.alreadyRunning ? '本来就在跑' : (r.wasRunning === false ? '（原本没在跑）' : '');
        log(`已${ACTIONS[kind].label} ${component} pid=${r.pid}（${r.matchBy}）${r.durationMs}ms${how}`);
        await report('ack', {
          seq, taskId, status: 'ok', kind, component,
          pid: r.pid ?? null,
          matchBy: r.matchBy ?? null,
          durationMs: r.durationMs,
          listening: r.listening ?? null,
          alreadyRunning: r.alreadyRunning === true,
          wasRunning: r.wasRunning ?? null,
          portFree: r.portFree ?? null,
          logFile: r.logFile ?? null,
          message: r.message || `已${ACTIONS[kind].label}`,
        });
      } else {
        warn(`${ACTIONS[kind].label} ${component} 失败：${r.code} ${r.message}`);
        await report('nack', {
          seq, taskId, code: r.code, message: r.message, kind, component,
          pid: r.pid ?? null, durationMs: r.durationMs,
          logFile: r.logFile ?? null,
        });
      }
    } finally {
      st.taskRunning = false;
    }
    return;
  }

  if (ev.event === 'bye') {
    st.connected = false;
    return;
  }
}

/* ── 主循环 ───────────────────────────────────────────── */

function scheduleReconnect() {
  if (st.stopping) return;
  const base = BACKOFF[Math.min(st.backoffIndex, BACKOFF.length - 1)];
  st.backoffIndex++;
  const wait = Math.round(base * (1 + Math.random() * 0.3));
  warn(`${Math.round(wait / 1000)}s 后重连（第 ${st.backoffIndex} 次）`);
  setTimeout(startStream, wait);
}

function startStream() {
  if (st.stopping) return;
  log(`连接 ${boot.host}:${boot.port} since=${st.seq}`);
  let opened = false;
  let closed = false;
  st.req = openStream({
    since: st.seq,
    onEvent,
    onOpen: () => {
      opened = true;
      st.connected = true;
      st.backoffIndex = 0;
    },
    onClose: (err) => {
      if (closed) return;
      closed = true;
      const was = st.connected;
      st.connected = false;
      if (err) warn(`连接断开：${err.message}`);
      if (!opened || was) scheduleReconnect();
    },
  });
}

async function main() {
  if (args.inventory) {
    const inv = await readInventory({ timeoutMs: 30000 });
    if (args.json) process.stdout.write(JSON.stringify(inv) + '\n');
    else process.stdout.write(printInventory(inv) + '\n');
    return;
  }

  boot = await loadBootstrap();

  await loadCache();

  if (args.once) {
    if (!st.cfg) {
      log('本地没有缓存配置，向主节点取一次 hello…');
      try {
        const payload = await fetchHelloOnce();
        await applyConfigFromHello(payload);
      } catch (e) {
        throw new Error(
          `连不上主节点 ${boot.host}:${boot.port}（${e.message}）\n` +
          `  依次确认：主节点已启动 / 防火墙放通该端口 / agent.bootstrap.json 里的 master 地址正确`,
        );
      }
    }
    const cfg = await ensureConfig();
    const res = await sampleSpecs(cfg.components, { remaps: args.remaps });
    if (!res.ok) throw new Error(res.error);
    process.stdout.write(JSON.stringify({
      node: boot.nodeId,
      sampledAt: new Date().toISOString(),
      rev: cfg.revision ?? null,
      components: res.components,
    }, null, 2) + '\n');
    const states = res.components.map((c) => `${c.id}=${c.state}${c.pid ? `(${c.pid})` : ''}`).join(' ');
    log(`采样完成 ${res.ms}ms · ${states}`);
    return;
  }

  log(`vcsNode agent ${AGENT_VERSION}  node=${boot.nodeId}  master=${boot.host}:${boot.port}  pid=${process.pid}`);
  log(`采样间隔 ${args.interval}ms · 心跳 ${HEARTBEAT_MS}ms · 缓存 ${boot.cacheDir}`);
  log(`服务日志 ${boot.logDir}\\<组件>.log`);
  log(`旧文件备份 ${boot.backupDir}\\<relId>\\<组件>\\<相对路径>`);
  log(boot.allowControl
    ? '控制模式：可执行启停与更新文件（allowControl: true）'
    : '控制模式：只读（bootstrap 里加 allowControl: true 才会执行启停与更新文件）');

  startStream();

  const timer = setInterval(() => {
    // 没连上也没缓存时不采样（省得每 10s 打一次 PowerShell）
    if (!st.cfg && !st.connected) return;
    sampleAndReport().catch((e) => warn(`采样异常：${e.message}`));
  }, args.interval);
  if (timer.unref) timer.unref();

  const shutdown = (sig) => {
    st.stopping = true;
    log(`${sig} 退出`);
    try { st.req?.destroy(); } catch { /* ignore */ }
    persistSeq().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/* 只连一次、拿 hello 就走（--once 且没有缓存时用） */
function fetchHelloOnce(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let req = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      try { req?.destroy(); } catch { /* ignore */ }
      fn(v);
    };

    const path = '/api/agent/stream?since=0';
    const signed = signRequest({ secret: boot.secret, nodeId: boot.nodeId, method: 'GET', path });
    req = http.request({
      host: boot.host, port: boot.port, path, method: 'GET',
      agent: false,
      headers: { ...signed.headers, Accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(reject, new Error(`HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`)));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf = (buf + chunk).replace(/\r\n/g, '\n');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const ev = parseSse(buf.slice(0, at));
          buf = buf.slice(at + 2);
          if (ev.event === 'hello') finish(resolve, ev.data || {});
        }
      });
    });
    req.setTimeout(timeoutMs, () => finish(reject, new Error('等待 hello 超时')));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

main().catch((e) => {
  warn(e.message);
  process.exit(1);
});
