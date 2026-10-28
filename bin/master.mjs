#!/usr/bin/env node
/* vcsNode 主节点（最小可用版）
 *
 *   静态托管 ui/
 *   GET  /api/ui/pending   读取上一次扫描产出的变更清单
 *   POST /api/ui/scan      现场扫描一次（没有基线时会先建基线）
 *   GET  /api/ui/config    读取当前配置（节点 × 组件）
 *   POST /api/ui/config    保存配置改动（只改目标行，写前做结构校验）
 *   POST /api/ui/config/probe  检查主节点本机路径是否真的存在
 *   GET  /api/ui/nodes     各节点实时状态（M0：由成员上报的观测推导）
 *   GET  /api/agent/stream 成员常驻 SSE（HMAC 鉴权）
 *   POST /api/agent/report 成员上报（hello / snapshot / ack / nack / probe）
 *   GET  /healthz          自检
 *
 * 现在做到：变更清单（扫描 + 待发布区）、配置页读写、节点观测、启停指令（M1）、
 * 更新文件 / 预发布（M2，就地覆盖 + 发布记录）。还没做：切换上线（commit）、一键回退、构建。
 *
 * 用法：
 *   node bin/master.mjs                        # 读 config/vcsnode.yaml，端口 47821
 *   node bin/master.mjs --port 47830
 *   node bin/master.mjs --remap D:\SceneAutomationV3=E:\tmp\deploy   # 开发机试跑
 *   node bin/master.mjs --config E:\tmp\vcsnode.yaml                # 改副本，不动真配置
 *   node bin/master.mjs --no-local-sample      # 不采样主节点本机（开发机上跑时用）
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../src/yaml.mjs';
import { buildSnapshot, buildManifestPayload, buildBaseline, collectSources, remapPath, localIso } from '../src/scan.mjs';
import { readJson, writeJsonAtomic } from '../src/state.mjs';
import { buildConfigView, readConfigText, saveConfig } from '../src/config-edit.mjs';
import { NodeRegistry, shortId } from '../src/nodes.mjs';
import { sampleNode } from '../src/probe.mjs';
import {
  buildRelease, targetsFor, checkLayout, mergeIntoBaseline,
  saveRelease, listReleases, getRelease, sharedRootFor, storeDirOf,
} from '../src/release.mjs';
import { verifyRequest, NonceStore } from '../src/agent-auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_ROOT = join(ROOT, 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function parseArgs(argv) {
  const out = {
    config: join(ROOT, 'config', 'vcsnode.yaml'),
    stateDir: join(ROOT, 'state'),
    port: null,
    host: '0.0.0.0',
    remaps: [],
    localSample: true,
    sampleInterval: 15000,
    offlineMs: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log('用法：node bin/master.mjs [--config <file>] [--state <dir>] [--port <n>] [--host <ip>] [--remap OLD=NEW] [--no-local-sample] [--sample-interval <ms>] [--offline-ms <ms>]');
      process.exit(0);
    } else if (a === '--config') out.config = resolve(argv[++i]);
    else if (a === '--state') out.stateDir = resolve(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--no-local-sample') out.localSample = false;
    else if (a === '--sample-interval') out.sampleInterval = Math.max(3000, Number(argv[++i]) || 15000);
    else if (a === '--offline-ms') out.offlineMs = Math.max(3000, Number(argv[++i]) || 45000);
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

let config = parseYaml(await readFile(args.config, 'utf8'));
const baselineFile = join(args.stateDir, 'baseline.json');
const pendingFile = join(args.stateDir, 'pending.json');
const revisionFile = join(args.stateDir, 'config-revision.json');
const nodesFile = join(args.stateDir, 'nodes.json');
const port = args.port || Number(String(config?.cluster?.master || '').split(':').pop()) || 47821;

/* ── 节点观测（M0 只读） ──────────────────────────────── */

let revisionNo = 0;
async function refreshRevision() {
  const r = await readJson(revisionFile, null);
  revisionNo = Number(r?.revision) || 0;
  return revisionNo;
}
await refreshRevision();

const registry = new NodeRegistry({
  config,
  stateFile: nodesFile,
  offlineMs: args.offlineMs || Number(config?.cluster?.offlineMs) || undefined,
  localGraceMs: args.sampleInterval * 2 + 5000,
  getRevision: () => revisionNo,
});
await registry.load();

const nonceStore = new NonceStore();

/** 成员请求的鉴权：path 必须含 query，body 必须是原始字节 */
function checkAgentAuth(req, url, rawBody) {
  return verifyRequest({
    secret: String(config?.cluster?.secret || ''),
    headers: req.headers,
    method: req.method,
    path: `${url.pathname}${url.search}`,
    body: rawBody ?? '',
    nonceStore,
  });
}

const sourceIp = Object.entries(config?.nodes || {}).find(([, n]) => n.role === 'source')?.[0] || null;

let localSampling = false;
async function sampleLocalOnce() {
  if (!sourceIp || !args.localSample || localSampling) return;
  localSampling = true;
  try {
    const r = await sampleNode(config, sourceIp, { remaps: args.remaps });
    if (!r.ok) {
      console.warn(`[local] 采样失败：${r.error}`);
      return;
    }
    registry.applyLocalSample(sourceIp, r);
  } catch (e) {
    console.warn(`[local] 采样失败：${e.message}`);
  } finally {
    localSampling = false;
  }
}

/* ── 扫描 ─────────────────────────────────────────────── */

let scanning = null;

async function runScan() {
  if (scanning) throw new Error('已有扫描在进行中');
  const started = Date.now();

  scanning = (async () => {
    const snapshot = await buildSnapshot(config, { remaps: args.remaps });
    const baseline = await readJson(baselineFile);

    if (!baseline) {
      const created = buildBaseline(snapshot);
      await writeJsonAtomic(baselineFile, created);

      // 顺手写一份「零变更」清单，界面才能区分「建过基线、暂时没改」
      // 和「从来没扫过」——否则刚建完基线页面还提示去扫描
      const empty = buildManifestPayload(snapshot, created, config);
      await writeJsonAtomic(pendingFile, empty);

      const total = Object.values(snapshot.components).reduce((a, c) => a + Object.keys(c.files).length, 0);
      return { baselineCreated: true, files: total, createdAt: snapshot.createdAt, ms: Date.now() - started };
    }

    const payload = buildManifestPayload(snapshot, baseline, config);
    await writeJsonAtomic(pendingFile, payload);
    return {
      baselineCreated: false,
      id: payload.id,
      createdAt: payload.createdAt,
      stats: payload.stats,
      groups: payload.groups.map(g => ({ component: g.component, counts: g.counts })),
      errors: payload.errors.length,
      warnings: payload.warnings.length,
      ms: Date.now() - started,
    };
  })();

  try {
    return await scanning;
  } finally {
    scanning = null;
  }
}

/* ── 配置 ─────────────────────────────────────────────── */

let savingConfig = null;

async function getConfigPayload() {
  const { data } = await readConfigText(args.config);
  const revision = await readJson(revisionFile, null);
  return buildConfigView(data, revision);
}

async function doSaveConfig(changes) {
  if (savingConfig) throw new Error('上一次保存还没结束，请稍后重试');

  savingConfig = (async () => {
    const result = await saveConfig({ configPath: args.config, stateDir: args.stateDir, changes });
    if (result.changed > 0) {
      const fresh = await readConfigText(args.config);
      config = fresh.data;
      // 总览/矩阵的 localRoot、port 都来自 registry 手里那份配置，
      // 只换 master 的局部变量会让总览一直显示启动时的旧目录
      registry.setConfig(config);
      await refreshRevision();
      // 已连上的成员重新拿一份 hello，刷新 node-config.json 并立即重采样
      const pushed = registry.pushHello();
      console.log(
        `[config] 保存 ${result.changed} 处 → rev ${result.revision}（备份 ${result.backup}）`
        + (pushed ? `，已向 ${pushed} 个成员重发 hello` : ''),
      );
    }
    return result;
  })();

  try {
    return await savingConfig;
  } finally {
    savingConfig = null;
  }
}

/** 只能检查主节点本机的路径；其余机器要等 agent 接上 */
async function probeLocalPaths() {
  const source = Object.entries(config.nodes || {}).find(([, n]) => n.role === 'source');
  if (!source) return { ok: false, error: '配置里没有 role: source 的节点', results: [] };

  const [ip, node] = source;
  const results = [];

  for (const [name, v] of Object.entries(node.components || {})) {
    const p = v.localRoot;
    if (!p) {
      results.push({ ip, component: name, path: null, state: 'unset' });
      continue;
    }
    const real = remapPath(p, args.remaps);
    try {
      const st = await stat(real);
      results.push({ ip, component: name, path: p, state: st.isDirectory() ? 'ok' : 'not-dir' });
    } catch (e) {
      results.push({
        ip,
        component: name,
        path: p,
        state: e.code === 'ENOENT' ? 'missing' : (e.code || 'error'),
        message: e.message,
      });
    }
  }

  const unchecked = Object.keys(config.nodes || {}).filter((k) => k !== ip);
  return { ok: true, ip, results, unchecked };
}

/* ── 控制指令（M1：启动 / 停止 / 重启） ───────────────── */

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** UI 传 node-149 / 149 / 172.16.1.149 都能认 */
function findNode(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const want = s.startsWith('node-') ? s : `node-${s}`;
  for (const [id, n] of registry.nodes) {
    if (id === want || id === s || n.ip === s) return { id, n };
  }
  return null;
}

async function runTask(body = {}, req = null) {
  const action = String(body.action || '').trim();
  const component = String(body.component || '').trim();

  if (!action) throw fail(400, 'bad_request', '缺 action');
  if (!component) throw fail(400, 'bad_request', '缺 component');
  if (!['start', 'stop', 'restart'].includes(action)) {
    throw fail(400, 'bad_action', `不认识的 action ${action}，只支持 start / stop / restart`);
  }

  const found = findNode(body.node);
  if (!found) throw fail(404, 'unknown_node', `配置里没有节点 ${body.node || '(空)'}`);
  const { id, n } = found;
  if (n.local || n.role === 'source') {
    throw fail(400, 'manual_node', `${n.ip} 是发布源，由人工操作，控制面不下发指令`);
  }

  const spec = registry.specsFor(n.ip)[component];
  if (!spec) throw fail(404, 'not_configured', `${id} 的配置里没有组件 ${component}`);
  if ((spec.kind || 'service') === 'asset') {
    throw fail(400, 'no_process', `${component} 是纯文件组件，没有进程可启停`);
  }
  // 启动类指令没有 start 就没有任何可执行的东西；在这里挡住比让成员绕一圈报错更清楚
  if (action !== 'stop' && !spec.start?.cmd) {
    throw fail(400, 'no_start', `${component} 的配置里没有 start.cmd，只能人工启动`);
  }

  const by = req ? String(req.socket.remoteAddress || '').replace(/^::ffff:/, '') : null;
  const timeoutMs = action === 'stop' ? 30000 : 60000; // 启动/重启要等进程被认出来
  let r;
  try {
    r = await registry.sendTask(id, { kind: action, component, by }, { timeoutMs });
  } catch (e) {
    throw fail(409, 'node_offline', e.message);
  }

  if (r.timeout) throw fail(504, 'task_timeout', `${id} 没有回执（指令可能没送到，或成员卡住了）`);

  const reply = r.reply || {};
  if (reply.code || reply.status !== 'ok') {
    throw fail(409, reply.code || 'nack', reply.message || '成员拒绝了这条指令');
  }

  console.log(`[task] ${id} ${action} ${component} ok pid=${reply.pid} ${reply.durationMs ?? '?'}ms`);
  return {
    ok: true,
    taskId: r.task.id,
    node: id,
    action,
    component,
    pid: reply.pid ?? null,
    matchBy: reply.matchBy ?? null,
    durationMs: reply.durationMs ?? null,
    listening: reply.listening ?? null,
    portFree: reply.portFree ?? null,
    alreadyRunning: reply.alreadyRunning === true,
    wasRunning: reply.wasRunning ?? null,
    logFile: reply.logFile ?? null,
    message: reply.message || '完成',
  };
}

/* ── 更新文件（M2）：把 98 上勾选的改动做成发布包，成员只读拉取落地 ── */

let staging = null;

async function runStage(body = {}, req = null) {
  if (staging) throw fail(409, 'busy', '上一次更新还没走完，稍等');

  const pending = await readJson(pendingFile);
  if (!pending || !(pending.groups || []).some((g) => (g.files || []).length)) {
    throw fail(409, 'no_pending', '待发布区是空的：先扫描一次');
  }

  const comps = Array.isArray(body.components) ? body.components.map((c) => String(c)).filter(Boolean) : [];
  if (!comps.length) throw fail(400, 'bad_request', '没选组件');
  const wantPaths = body.paths && typeof body.paths === 'object' ? body.paths : {};
  const selections = comps.map((c) => ({
    component: c,
    paths: Array.isArray(wantPaths[c]) ? wantPaths[c].map(String) : [],
  }));

  // 1) 布局先对齐：扫描源必须就是 98 在跑的目录
  const groups = new Map((pending.groups || []).map((g) => [g.component, g]));
  for (const c of comps) {
    const g = groups.get(c);
    if (!g) throw fail(400, 'not_in_pending', `待发布区里没有组件 ${c}`);
    try {
      checkLayout(config, c, g.root);
    } catch (e) {
      throw fail(409, e.code || 'layout_mismatch', e.message);
    }
  }

  // 2) 目标节点：这些组件部署在哪些机器上
  const targets = new Map();     // shortId -> { ip, id, nodeId, comps:Set }
  for (const c of comps) {
    for (const t of targetsFor(config, c)) {
      const cur = targets.get(t.id) || { ip: t.ip, id: t.id, comps: new Set() };
      cur.comps.add(c);
      targets.set(t.id, cur);
    }
  }
  if (body.nodes && Array.isArray(body.nodes) && body.nodes.length) {
    const keep = new Set(body.nodes.map((n) => shortId(String(n).replace(/^node-/, ''))));
    for (const k of [...targets.keys()]) if (!keep.has(k)) targets.delete(k);
  }
  if (!targets.size) throw fail(400, 'no_target', '这些组件没有任何已部署的成员节点（localRoot 都没填？）');

  // 配了这个组件、但 localRoot 还空着的节点：不会收到文件。别让它静默漏掉。
  const warnings = [];
  for (const c of comps) {
    for (const [ip, n] of Object.entries(config.nodes || {})) {
      if (!n || n.role === 'source') continue;
      const def = n.components?.[c];
      if (!def || def.enabled === false || def.localRoot) continue;
      warnings.push(`${shortId(n.id || ip)}/${c}：localRoot 没填，不在本次目标里`);
    }
  }

  // 3) 目标节点必须在等：不允许「半套发布」
  const offline = [];
  for (const [id, t] of targets) {
    const found = [...registry.nodes].find(([k]) => shortId(k) === id);
    if (!found) { offline.push(id); continue; }
    t.nodeId = found[0];
    if (!found[1].online) offline.push(id);
  }
  if (offline.length) throw fail(409, 'node_offline', `${offline.join('、')} 不在线：等它连上再发（不允许只发一半）`);

  // 4) 要覆盖的组件不能还在跑（覆盖正被读的文件只会得到一堆半新半旧）
  const matrix = registry.uiPayload().matrix || {};
  const running = [];
  for (const t of targets.values()) {
    for (const c of t.comps) {
      const cell = matrix[c]?.[t.id];
      if (cell && (cell.state === 'running' || cell.state === 'degraded')) {
        running.push(`${t.id}/${c}（${cell.label || cell.state}）`);
      }
    }
  }
  if (running.length && body.force !== true) {
    throw fail(409, 'not_stopped', `这些组件还在跑，先在抽屉里停止再更新文件：${running.join('、')}`);
  }

  const by = req ? String(req.socket.remoteAddress || '').replace(/^::ffff:/, '') : null;

  staging = (async () => {
    const started = Date.now();

    // 5) 98 侧做发布包（只复制勾选的文件，复制时重新算 sha）
    const built = await buildRelease({
      config,
      pending,
      selections,
      includeDeletes: body.includeDeletes === true,
      note: body.note,
      by,
    });
    console.log(`[stage] ${built.relId} 打包 ${built.stats.files} 个文件 ${built.stats.deletes} 个删除 · ${built.stats.bytes}B → ${built.dir}`);

    // 6) 发指令：每台一条（同一台上多个组件合并成一条）
    const timeoutMs = Math.max(60_000, Number(config.cluster?.taskLeaseMs) || 180_000);
    const nodes = {};
    await Promise.all([...targets.values()].map(async (t) => {
      const nodeDef = config.nodes?.[t.ip] || {};
      const share = join(sharedRootFor(config, nodeDef), storeDirOf(config), 'releases', built.relId);
      const common = {
        releaseId: built.relId,
        share,
        components: [...t.comps],
        includeDeletes: body.includeDeletes === true,
      };
      try {
        const r = await registry.sendTask(t.nodeId, { kind: 'stage', by, params: common }, { timeoutMs });
        if (r.timeout) {
          nodes[t.id] = { ok: false, error: `${timeoutMs / 1000}s 没有回执（可能还在拷，稍后看事件）`, landedAt: localIso(new Date()) };
          return;
        }
        const rep = r.reply || {};
        if (rep.code || rep.status !== 'ok') {
          nodes[t.id] = {
            ok: false,
            error: rep.message || rep.code || 'nack',
            landed: rep.landed || 0,
            deleted: rep.deleted || 0,
            bytes: rep.bytes || 0,
            ms: rep.durationMs || 0,
            landedAt: localIso(new Date()),
          };
          return;
        }
        nodes[t.id] = {
          ok: true,
          landed: rep.landed || 0,
          deleted: rep.deleted || 0,
          skipped: rep.skipped || 0,
          bytes: rep.bytes || 0,
          ms: rep.durationMs || 0,
          landedAt: localIso(new Date()),
        };
      } catch (e) {
        nodes[t.id] = { ok: false, error: e.message, landedAt: localIso(new Date()) };
      }
    }));

    const list = Object.values(nodes);
    const status = list.length && list.every((v) => v.ok) ? 'landed'
      : list.some((v) => v.ok) ? 'partial' : 'failed';

    const detail = {
      format: 1,
      relId: built.relId,
      createdAt: built.manifest.createdAt,
      by,
      note: String(body.note || ''),
      status,
      dir: built.dir,
      components: built.manifest.components,
      counts: {
        A: built.stats.added,
        M: built.stats.modified,
        D: built.stats.deletes,
      },
      files: built.manifest.files,
      deletes: built.manifest.deletes,
      bytes: built.stats.bytes,
      durationMs: Date.now() - started,
      nodes,
    };
    await saveRelease(args.stateDir, detail);

    // 7) 全部落地才推进基线；有失败就留在待发布区，重发时不至于漏文件
    if (status === 'landed') {
      await mergeIntoBaseline({ baselineFile, pendingFile, manifest: built.manifest });
    }

    const msg = list.map((v) => `${v.ok ? '✔' : '✘'}${v.error ? ` ${v.error}` : ''}`).join(' ');
    console.log(`[stage] ${built.relId} ${status} · ${detail.durationMs}ms · ${msg}`);
    return {
      ok: status === 'landed',
      code: status === 'landed' ? undefined : status,
      releaseId: built.relId,
      status,
      dir: built.dir,
      stats: built.stats,
      nodes,
      warnings,
      durationMs: detail.durationMs,
    };
  })();

  try {
    return await staging;
  } finally {
    staging = null;
  }
}

/* ── 写入保护 ─────────────────────────────────────────── */

function ipInCidr(ip, cidr) {
  const [range, bitsRaw] = String(cidr).split('/');
  if (!range) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const toInt = (s) => {
    const p = s.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  };
  const a = toInt(ip);
  const b = toInt(range);
  if (a === null || b === null) return false;
  if (bits <= 0) return true;
  if (bits >= 32) return a === b;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/** 读接口对内网开放，写接口只认回环 + cluster.allowedPeers */
function writeAllowed(req) {
  const peers = config.cluster?.allowedPeers || [];
  if (!peers.length) return true;                       // 没配就不过滤（开发机）

  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return peers.some((c) => ipInCidr(ip, c));
}

/* ── HTTP ─────────────────────────────────────────────── */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limit = 2 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const file = join(UI_ROOT, normalize(rel).replace(/^([/\\])+/, ''));

  // 不许跳出 ui/
  if (!file.startsWith(UI_ROOT + sep) && file !== join(UI_ROOT, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !writeAllowed(req)) {
      console.warn(`[http] 拒绝写入：${req.socket.remoteAddress} ${req.method} ${url.pathname}`);
      return sendJson(res, 403, {
        ok: false,
        error: `客户端地址 ${req.socket.remoteAddress} 不在 cluster.allowedPeers 内，只能查看不能修改`,
      });
    }

    if (url.pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        role: 'master',
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        port,
        sources: collectSources(config).length,
      });
    }

    if (url.pathname === '/api/ui/pending' && req.method === 'GET') {
      const payload = await readJson(pendingFile);
      if (!payload) return sendJson(res, 404, { empty: true, reason: '还没有扫描结果' });
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/ui/scan' && req.method === 'POST') {
      try {
        const result = await runScan();
        console.log(`[scan] ${result.baselineCreated ? '基线' : '清单'} ok ${result.ms}ms`);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        console.error(`[scan] 失败：${e.message}`);
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/ui/stage' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        return sendJson(res, 200, await runStage(body, req));
      } catch (e) {
        console.warn(`[stage] 拒绝：${e.code || ''} ${e.message}`);
        return sendJson(res, e.status || 500, { ok: false, code: e.code || 'failed', error: e.message });
      }
    }

    if (url.pathname === '/api/ui/releases' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, items: await listReleases(args.stateDir) });
    }

    if (url.pathname.startsWith('/api/ui/releases/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/ui/releases/'.length));
      const detail = await getRelease(args.stateDir, id);
      if (!detail) return sendJson(res, 404, { ok: false, code: 'not_found', error: `没有发布记录 ${id}` });
      return sendJson(res, 200, detail);
    }

    if (url.pathname === '/api/ui/config' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...(await getConfigPayload()) });
    }

    if (url.pathname === '/api/ui/config' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await doSaveConfig(body.changes);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        console.error(`[config] 保存失败：${e.message}`);
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/ui/config/probe' && req.method === 'POST') {
      try {
        return sendJson(res, 200, { ok: true, ...(await probeLocalPaths()) });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/ui/task' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        return sendJson(res, 200, await runTask(body, req));
      } catch (e) {
        console.warn(`[task] 拒绝：${e.code || ''} ${e.message}`);
        return sendJson(res, e.status || 400, { ok: false, code: e.code || 'failed', error: e.message });
      }
    }

    if (url.pathname === '/api/ui/nodes' && req.method === 'GET') {
      return sendJson(res, 200, registry.uiPayload());
    }

    /* ── 成员控制面 ─────────────────────────────────── */

    if (url.pathname === '/api/agent/stream' && req.method === 'GET') {
      const auth = checkAgentAuth(req, url, '');
      if (!auth.ok) {
        console.warn(`[agent] 拒绝 SSE：${auth.code} · ${req.socket.remoteAddress}`);
        return sendJson(res, auth.status, { ok: false, code: auth.code, error: auth.message });
      }
      if (!registry.ensure(auth.nodeId)) {
        console.warn(`[agent] 拒绝 SSE：配置里没有节点 ${auth.nodeId}`);
        return sendJson(res, 403, { ok: false, code: 'not_configured', error: `配置里没有节点 ${auth.nodeId}` });
      }

      const since = Number(url.searchParams.get('since') || 0);
      const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      registry.attachStream(auth.nodeId, res, { addr });
      console.log(`[agent] ${auth.nodeId} 已连接 since=${since} from ${addr}`);

      res.on('close', () => registry.detachStream(auth.nodeId, res));
      res.on('error', () => registry.detachStream(auth.nodeId, res));
      return; // 常驻连接：不结束响应
    }

    if (url.pathname === '/api/agent/report' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const auth = checkAgentAuth(req, url, raw);
      if (!auth.ok) {
        console.warn(`[agent] 拒绝上报：${auth.code} · ${req.socket.remoteAddress}`);
        return sendJson(res, auth.status, { ok: false, code: auth.code, error: auth.message });
      }

      let body;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, code: 'bad_json', error: '请求体不是合法 JSON' });
      }
      if (body.node && body.node !== auth.nodeId) {
        return sendJson(res, 400, { ok: false, code: 'node_mismatch', error: `body.node=${body.node}，签名里的节点是 ${auth.nodeId}` });
      }
      if (!registry.ensure(auth.nodeId)) {
        return sendJson(res, 403, { ok: false, code: 'not_configured', error: `配置里没有节点 ${auth.nodeId}` });
      }

      const p = body.payload || {};
      switch (body.type) {
        case 'hello': registry.applyHello(auth.nodeId, p); break;
        case 'snapshot': registry.applySnapshot(auth.nodeId, p); break;
        case 'ack': registry.applyAck(auth.nodeId, p); break;
        case 'nack': registry.applyNack(auth.nodeId, p); break;
        case 'probe': registry.event(auth.nodeId, 'probe', `${(p.items || []).length} 项`, (p.items || []).every((i) => i.ok) ? 'ok' : 'warn'); break;
        case 'log': break;
        default:
          return sendJson(res, 400, { ok: false, code: 'unknown_type', error: `未知上报类型：${body.type}` });
      }

      return sendJson(res, 200, { ok: true, serverTime: Date.now(), rev: revisionNo });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(res, url.pathname);
    }

    sendJson(res, 405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error(`[http] ${url.pathname} -> ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用（${args.host}:${port}）—— 大概率 vcsNode 已经在跑了。`);
    console.error(`  谁占的：Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess`);
    console.error(`  是不是 vcsNode：curl http://localhost:${port}/healthz`);
    console.error('  是的话直接用浏览器打开，不要重复启动；要重启用 Stop-ScheduledTask，或停掉旧进程再起。');
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`端口 ${port} 没有绑定权限（EACCES），换一个端口：node bin\\master.mjs --port ${port + 1}`);
    process.exit(1);
  }
  console.error(`[http] 启动失败：${err.code || ''} ${err.message}`);
  process.exit(1);
});

server.listen(port, args.host, () => {
  const sources = collectSources(config);
  console.log(`vcsNode master  http://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${port}/`);
  console.log(`  PID      ${process.pid}`);
  console.log(`  配置     ${args.config}`);
  console.log(`  状态目录 ${args.stateDir}`);
  console.log(`  配置版本 rev ${revisionNo}`);
  console.log(`  节点     ${[...registry.nodes.values()].map((n) => n.id).join(' · ')}`);
  console.log(`  控制面   ${args.host === '0.0.0.0' ? '0.0.0.0' : args.host}:${port}/api/agent/stream（成员出站连入）`);
  console.log(`  本机采样 ${args.localSample ? `开（${sourceIp || '无 source 节点'}，每 ${args.sampleInterval / 1000}s）` : '关'}`);
  console.log(`  扫描源   ${sources.length} 个组件`);
  for (const s of sources) console.log(`    ${s.component.padEnd(16)} ${s.root}${s.includes ? `  （白名单 ${s.includes.length} 项）` : ''}`);
  if (args.remaps.length) {
    console.log('  路径重映射（仅开发机）：');
    for (const r of args.remaps) console.log(`    ${r.from} → ${r.to}`);
  }

  // 主节点本机（98）不走 SSE，直接采样
  if (args.localSample && sourceIp) sampleLocalOnce();
  if (args.localSample) setInterval(sampleLocalOnce, args.sampleInterval).unref();

  // 保活 + 离线判定
  setInterval(() => registry.pingAll(), Math.max(5000, Number(config?.cluster?.heartbeatMs) || 15000)).unref();
  setInterval(() => registry.sweep(), 5000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，退出`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
