/* 同步包（M2：把 98 上改后的文件做成一个可拉的 release）
 *
 * 目录结构（在 98 的共享里，成员只读）：
 *
 *   <sharedRoot>\_vcs\releases\<relId>\
 *     manifest.json                  ← 唯一事实来源，成员按它落地
 *     files\<component>\<相对路径>    ← 只放「改了的」文件，不是整目录
 *
 * 原则：
 *   - 只复制清单里勾选的文件；清单来自上一次扫描（pending），复制时重新算 sha256，
 *     不信任 8 位短哈希 —— 扫描到同步之间文件可能又变了，那就以同步时的内容为准。
 *   - `path` 一律相对**组件根**，成员用它拼自己的 localRoot：四台机器路径不同，
 *     写绝对路径只可能对一台有效。
 *   - 98 的「扫描源」必须就是 98 实际在跑的目录（= node-98 的 localRoot）。
 *     源码目录 ≠ 运行目录时拒绝同步（layout_mismatch）—— 把 .cs 覆盖进同步目录会直接搞坏服务。
 *   - 同步成功后才推进基线：没发出去的文件继续留在待同步区。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { readJson, writeJsonAtomic } from './state.mjs';
import { localIso } from './scan.mjs';

const toSlash = (p) => String(p).replace(/\\/g, '/');

/* ── 路径 ────────────────────────────────────────────────── */

/** 相对路径的安全校验：不允许绝对路径 / 盘符 / .. / Windows 非法字符 */
export function safeRel(rel) {
  const s = toSlash(String(rel ?? '')).trim();
  if (!s) throw new Error('path 为空');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) throw new Error(`path 是绝对路径：${rel}`);
  const segs = s.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') throw new Error(`path 含非法段：${rel}`);
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) throw new Error(`path 含非法字符：${rel}`);
    if (/[. ]$/.test(seg)) throw new Error(`path 段以点或空格结尾（Windows 不接受）：${rel}`);
  }
  return segs.join('/');
}

/** target 是否真的在 root 里面（防止 ../ 或软链接式越界） */
export function isUnder(root, target) {
  const r = resolve(root).toLowerCase();
  const t = resolve(target).toLowerCase();
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

export function joinRel(root, rel) {
  return join(root, ...safeRel(rel).split('/'));
}

const normRoot = (p) => toSlash(String(p ?? '')).replace(/\/+$/, '').toLowerCase();

/* ── 配置推导 ────────────────────────────────────────────── */

export function storeDirOf(config) {
  return String(config?.storage?.storeDir || '_vcs');
}

export function sharedRootOf(config) {
  return String(config?.storage?.sharedRoot || '').replace(/[\\/]+$/, '');
}

/** 某个节点看到的共享根：节点可以覆盖（映射盘 / 共享名不同） */
export function sharedRootFor(config, nodeDef) {
  const own = nodeDef?.storage?.sharedRoot || nodeDef?.sharedRoot;
  return String(own || sharedRootOf(config) || '').replace(/[\\/]+$/, '');
}

/** 98（同步源）的 localRoot —— 扫描源必须和它一致，否则拒绝同步 */
export function sourceRootOf(config, component) {
  const entry = Object.entries(config?.nodes || {}).find(([, n]) => n.role === 'source');
  return entry ? entry[1]?.components?.[component]?.localRoot ?? null : null;
}

/**
 * 扫描源 vs 98 运行目录。
 * 不一致时不能「就地覆盖」：典型例子 sources.webapi 指向源码目录，
 * 而 98 跑的是 publish 出来的另一个目录 —— 把源码铺进同步目录会直接起不来。
 */
export function checkLayout(config, component, srcRoot) {
  const runRoot = sourceRootOf(config, component);
  if (!runRoot) {
    const e = new Error(`98 的配置里没有 ${component}.localRoot，不知道该和哪个目录对齐`);
    e.code = 'layout_mismatch';
    throw e;
  }
  if (normRoot(runRoot) !== normRoot(srcRoot)) {
    const e = new Error(
      `扫描源和 98 实际运行目录不一致：sources.${component} = ${srcRoot}，` +
      `但 98 的 localRoot = ${runRoot}。M2 只做「就地覆盖运行目录」，` +
      `请把 sources.${component} 改成实际运行目录（源码→产物的构建在 M3）`,
    );
    e.code = 'layout_mismatch';
    e.detail = { component, srcRoot, localRoot: runRoot };
    throw e;
  }
  return true;
}

/** 这些组件要发到哪些节点（只算启用且 localRoot 已知的） */
export function targetsFor(config, component) {
  const out = [];
  for (const [ip, n] of Object.entries(config?.nodes || {})) {
    if (!n || n.role === 'source') continue;
    const c = n.components?.[component];
    if (!c || c.enabled === false) continue;
    if (!c.localRoot) continue;
    out.push({ ip, id: String(n.id || ip).replace(/^node-/, ''), localRoot: c.localRoot });
  }
  return out;
}

/* ── 同步包 ──────────────────────────────────────────────── */

export function makeReleaseId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `rel-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
}

/** 复制 + 边复制边算 sha256（大文件不占内存） */
async function copyHash(src, dst) {
  await mkdir(dirname(dst), { recursive: true });
  const hash = createHash('sha256');
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), tap, createWriteStream(dst));
  const st = await stat(dst);
  const srcStat = await stat(src);
  return { sha256: hash.digest('hex'), size: st.size, mtimeMs: srcStat.mtimeMs };
}

/**
 * 按清单复制文件到共享，写 manifest.json。
 *
 * @param {object} o
 * @param {object} o.config      完整配置
 * @param {object} o.pending     state/pending.json
 * @param {Array<{component:string, paths:string[]}>} o.selections 勾选的组件与文件
 * @param {boolean} o.includeDeletes 是否把 D（删除）也带上
 * @param {string} o.note
 */
export async function buildRelease({ config, pending, selections, includeDeletes = false, note = '', by = null }) {
  const sharedRoot = sharedRootOf(config);
  if (!sharedRoot) {
    const e = new Error('配置里没有 storage.sharedRoot，无法放同步包');
    e.code = 'share_not_configured';
    throw e;
  }
  const storeDir = storeDirOf(config);
  const releasesDir = join(sharedRoot, storeDir, 'releases');
  const relId = makeReleaseId();
  const dir = join(releasesDir, relId);

  const groups = new Map((pending.groups || []).map((g) => [g.component, g]));

  // 1) 先把勾选项和清单对上（大小写不敏感），不认识的直接拒绝
  const plan = [];
  for (const sel of selections) {
    const g = groups.get(sel.component);
    if (!g) {
      const e = new Error(`清单里没有组件 ${sel.component}`);
      e.code = 'not_in_pending';
      throw e;
    }
    checkLayout(config, sel.component, g.root);

    const wanted = sel.paths?.length ? new Set(sel.paths.map((p) => toSlash(p).toLowerCase())) : null;
    const files = g.files.filter((f) => {
      if (f.action === 'D') return includeDeletes && (!wanted || wanted.has(toSlash(f.path).toLowerCase()));
      return !wanted || wanted.has(toSlash(f.path).toLowerCase());
    });
    if (!files.length) continue;
    plan.push({ component: sel.component, root: g.root, files });
  }
  if (!plan.length) {
    const e = new Error('没有可同步的文件（勾选项和清单对不上，或只勾了删除项但没确认删除）');
    e.code = 'empty_selection';
    throw e;
  }

  // 2) 共享可写？
  try {
    await mkdir(join(dir, 'files'), { recursive: true });
  } catch (e) {
    const err = new Error(`共享目录不可写（${dir}）：${e.message}`);
    err.code = 'share_not_writable';
    throw err;
  }

  // 3) 复制 + 校验
  const manifest = {
    format: 1,
    relId,
    createdAt: localIso(new Date()),
    by: by || null,
    note: String(note || ''),
    storeDir,
    files: [],
    deletes: [],
    components: plan.map((p) => p.component),
  };

  let bytes = 0;
  for (const p of plan) {
    for (const f of p.files) {
      const rel = safeRel(f.path);
      if (f.action === 'D') {
        manifest.deletes.push({ component: p.component, path: rel, size: f.sizeBytes || 0 });
        continue;
      }
      const src = joinRel(p.root, rel);
      const dst = join(dir, 'files', p.component, ...rel.split('/'));
      let got;
      try {
        got = await copyHash(src, dst);
      } catch (e) {
        const err = new Error(`复制失败 ${p.component}/${rel}：${e.code === 'ENOENT' ? '源文件不见了（扫描后又被删/改名）' : e.message}`);
        err.code = 'copy_failed';
        err.detail = { component: p.component, path: rel };
        err.cleanup = dir;
        throw err;
      }
      manifest.files.push({
        component: p.component,
        path: rel,
        action: f.action,
        blob: `files/${p.component}/${rel}`,
        sha256: got.sha256,
        size: got.size,
        mtimeMs: got.mtimeMs,
        sourceMtime: localIso(new Date(got.mtimeMs)),
      });
      bytes += got.size;
    }
  }

  await writeJsonAtomic(join(dir, 'manifest.json'), manifest);
  await pruneReleases(releasesDir, Number(config?.storage?.keepReleases) || 5, relId);

  return {
    relId,
    dir,
    manifest,
    stats: {
      files: manifest.files.length,
      deletes: manifest.deletes.length,
      added: manifest.files.filter((f) => f.action === 'A').length,
      modified: manifest.files.filter((f) => f.action === 'M').length,
      bytes,
      components: manifest.components,
    },
  };
}

/** 只留最近 keep 个同步包（新的一律保留） */
export async function pruneReleases(releasesDir, keep = 5, keepId = null) {
  let names = [];
  try {
    names = (await readdir(releasesDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith('rel-'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const drop = names.slice(0, Math.max(0, names.length - Math.max(1, keep))).filter((n) => n !== keepId);
  const removed = [];
  for (const n of drop) {
    try {
      await rm(join(releasesDir, n), { recursive: true, force: true });
      removed.push(n);
    } catch { /* 有人正读着，下次再说 */ }
  }
  return removed;
}

/** 成员侧用：读同步包清单 */
export async function readManifest(dir) {
  return readJson(join(dir, 'manifest.json'));
}

/* ── 落地台账：哪台机器上已经是哪份内容 ───────────────────── */

/**
 * 台账（state/landed.json）只记「某台机器上这个文件已经是这份内容了」。
 *
 * 为什么不塞进 pending.json：pending 每次扫描都被整体重写，落地进度会跟着丢；
 * 而「只发部分节点」时又必须记住谁已经发了——否则要么重复发，要么以为发过。
 */
export const LANDED_FORMAT = 1;

const markerOf = (f) => String(f.sha256 || '').slice(0, 8);

export async function readLanded(landedFile) {
  const j = await readJson(landedFile);
  if (!j || Number(j.format) !== LANDED_FORMAT || !j.components || typeof j.components !== 'object') {
    return { format: LANDED_FORMAT, updatedAt: null, components: {} };
  }
  return j;
}

/**
 * 把这次成功的落地记进台账。
 * 内容变了（marker 不同）就清掉旧记录：不能拿「同一路径、旧内容」的落地记录冒充这一次。
 */
export async function recordLanding({ landedFile, manifest, nodeResults }) {
  const ledger = await readLanded(landedFile);
  let marked = 0;

  const mark = (component, path, marker, nodeId, at) => {
    const bucket = (ledger.components[component] ||= {});
    const key = toSlash(path);
    const cur = bucket[key];
    if (!cur || cur.marker !== marker) bucket[key] = { marker, nodes: {} };
    bucket[key].nodes[nodeId] = at;
    marked++;
  };

  for (const [nodeId, r] of Object.entries(nodeResults || {})) {
    if (!r || r.ok !== true) continue;
    const mine = new Set(r.comps || []);
    const at = r.landedAt || localIso(new Date());
    for (const f of manifest.files || []) {
      if (mine.has(f.component)) mark(f.component, f.path, markerOf(f), nodeId, at);
    }
    if (r.includeDeletes) {
      for (const d of manifest.deletes || []) {
        if (mine.has(d.component)) mark(d.component, d.path, 'D', nodeId, at);
      }
    }
  }

  if (marked) {
    ledger.updatedAt = localIso(new Date());
    await writeJsonAtomic(landedFile, ledger);
  }
  return { ledger, marked };
}

/** 给界面用：标出每个文件已经在哪些节点落地（按当前清单里的哈希比对，旧内容不算） */
export function annotatePending(pending, ledger) {
  for (const g of pending?.groups || []) {
    for (const f of g.files || []) {
      const marker = f.action === 'D' ? 'D' : String(f.sha256 || '').slice(0, 8);
      const e = ledger?.components?.[g.component]?.[toSlash(f.path)];
      f.landedOn = e && e.marker === marker ? Object.keys(e.nodes).sort() : [];
    }
  }
  return pending;
}

/* ── 落地完成后推进基线 ─────────────────────────────────── */

/**
 * 逐个文件判断「声明的目标节点是不是都落地了这份内容」：
 *   - 都齐了   → 写进基线，并从待同步区移除；
 *   - 还差节点 → 原样留在待同步区，界面显示「已发 149 · 待发 145」。
 *
 * 这样「只发 149」不会把 145 悄悄落下：基线没推进，下次扫描照样看得见这批文件。
 * targetsByComponent 必须是**配置里声明的全部目标**，不能只传本次勾选的那几台。
 */
export async function mergeIntoBaseline({
  baselineFile, pendingFile, landedFile, manifest,
  targetsByComponent = {}, nodeResults = null,
}) {
  if (nodeResults) await recordLanding({ landedFile, manifest, nodeResults });
  const ledger = await readLanded(landedFile);

  const baseline = (await readJson(baselineFile)) || { format: 1, components: {} };
  baseline.components ||= {};

  const waiting = [];
  const consumed = [];
  const advanced = { files: 0, deletes: 0 };

  /** 还缺哪些节点（空数组 = 齐了）。没有目标节点的文件一律不算齐，免得白推进基线。 */
  const missingOf = (component, path, marker) => {
    const all = targetsByComponent[component] || [];
    const e = ledger.components?.[component]?.[toSlash(path)];
    const got = e && e.marker === marker ? e.nodes || {} : {};
    return { all, missing: all.filter((id) => !got[id]) };
  };

  for (const f of manifest.files || []) {
    const { all, missing } = missingOf(f.component, f.path, markerOf(f));
    if (!all.length || missing.length) {
      waiting.push({ component: f.component, path: f.path, action: f.action, missing, reason: all.length ? null : 'no_target' });
      continue;
    }
    const c = (baseline.components[f.component] ||= { root: null, files: {} });
    c.files ||= {};
    c.files[f.path] = { sha256: f.sha256, size: f.size, mtimeMs: f.mtimeMs };
    advanced.files++;
    consumed.push([f.component, f.path]);
  }

  for (const d of manifest.deletes || []) {
    const { all, missing } = missingOf(d.component, d.path, 'D');
    if (!all.length || missing.length) {
      waiting.push({ component: d.component, path: d.path, action: 'D', missing, reason: all.length ? null : 'no_target' });
      continue;
    }
    const c = baseline.components[d.component];
    if (c?.files) delete c.files[d.path];
    advanced.deletes++;
    consumed.push([d.component, d.path]);
  }

  // 已齐的条目用完就从台账里删掉：台账只留「还没发齐」的，不会无限长大
  for (const [comp, path] of consumed) {
    const bucket = ledger.components?.[comp];
    if (!bucket) continue;
    delete bucket[toSlash(path)];
    if (!Object.keys(bucket).length) delete ledger.components[comp];
  }
  if (consumed.length) {
    ledger.updatedAt = localIso(new Date());
    await writeJsonAtomic(landedFile, ledger);
  }

  if (advanced.files || advanced.deletes) {
    baseline.createdAt = localIso(new Date());
    await writeJsonAtomic(baselineFile, baseline);
  }

  const pending = await readJson(pendingFile);
  if (!pending) return { advanced, waiting, remaining: 0 };

  const gone = new Set(consumed.map(([c, p]) => `${c}\u0000${toSlash(p).toLowerCase()}`));
  for (const g of pending.groups || []) {
    g.files = (g.files || []).filter((f) => !gone.has(`${g.component}\u0000${toSlash(f.path).toLowerCase()}`));
    g.counts = {
      A: g.files.filter((f) => f.action === 'A').length,
      M: g.files.filter((f) => f.action === 'M').length,
      D: g.files.filter((f) => f.action === 'D').length,
    };
  }

  const rest = pending.groups || [];
  pending.stats = {
    ...(pending.stats || {}),
    components: rest.filter((g) => g.files.length).length,
    added: rest.reduce((a, g) => a + g.counts.A, 0),
    modified: rest.reduce((a, g) => a + g.counts.M, 0),
    deleted: rest.reduce((a, g) => a + g.counts.D, 0),
    bytes: rest.reduce((a, g) => a + g.files.reduce((x, f) => x + (f.action === 'D' ? 0 : f.sizeBytes || 0), 0), 0),
  };
  pending.publishedAt = localIso(new Date());
  pending.lastReleaseId = manifest.relId;
  await writeJsonAtomic(pendingFile, pending);
  return { advanced, waiting, remaining: rest.reduce((a, g) => a + g.files.length, 0) };
}

/* ── 同步记录（state/releases.json + state/releases/<relId>.json） ── */

const REL_ID_RE = /^rel-\d{8}-\d{6}-[a-z0-9]{4}$/;

export function isReleaseId(id) {
  return REL_ID_RE.test(String(id || ''));
}

function summaryOf(detail) {
  const nodes = {};
  for (const [k, v] of Object.entries(detail.nodes || {})) {
    nodes[k] = {
      ok: v.ok === true,
      landed: v.landed || 0,
      deleted: v.deleted || 0,
      bytes: v.bytes || 0,
      ms: v.ms || 0,
      landedAt: v.landedAt || null,
      error: v.error || null,
    };
  }
  return {
    relId: detail.relId,
    createdAt: detail.createdAt,
    by: detail.by || null,
    note: detail.note || '',
    status: detail.status,
    scope: detail.scope || null,
    components: detail.components || [],
    counts: detail.counts || { A: 0, M: 0, D: 0 },
    files: (detail.files || []).length,
    deletes: (detail.deletes || []).length,
    bytes: detail.bytes || 0,
    durationMs: detail.durationMs || 0,
    nodes,
  };
}

export async function saveRelease(stateDir, detail) {
  const dir = join(stateDir, 'releases');
  await writeJsonAtomic(join(dir, `${detail.relId}.json`), detail);

  const indexFile = join(stateDir, 'releases.json');
  const idx = (await readJson(indexFile)) || { format: 1, items: [] };
  idx.items = [summaryOf(detail), ...(idx.items || []).filter((i) => i.relId !== detail.relId)].slice(0, 50);
  await writeJsonAtomic(indexFile, idx);
  return summaryOf(detail);
}

export async function listReleases(stateDir) {
  const idx = (await readJson(join(stateDir, 'releases.json'))) || { format: 1, items: [] };
  return idx.items || [];
}

export async function getRelease(stateDir, relId) {
  if (!isReleaseId(relId)) return null;
  return readJson(join(stateDir, 'releases', `${relId}.json`));
}
