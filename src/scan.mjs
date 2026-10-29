/* 扫描与变更比对（只读）
 *
 * 做的事：
 *   1. 按 config.sources 的白名单遍历 98 的部署目录
 *   2. 应用 exclude 规则（含否定规则）
 *   3. 逐文件 sha256（写入前后各 stat 一次，防止读到半个文件）
 *   4. 与基线 manifest 比对，产出 A / M / D 清单
 *
 * 判定只看内容哈希，mtime 只用来判断「这个文件有没有被动过」的提示信息。
 * 因此 build 之后 mtime 变了但内容没变的文件，不会出现在清单里。
 */

import { readdir, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createIgnore } from './ignore.mjs';

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MAX_FILES = 200000;
const MAX_DEPTH = 48;

/* ── 路径工具 ──────────────────────────────────────────── */

const toSlash = p => p.replace(/\\/g, '/');

/** 把配置里的绝对路径前缀替换掉，仅用于在开发机上用假目录试跑 */
export function remapPath(p, remaps = []) {
  const norm = String(p);
  for (const r of remaps) {
    const from = String(r.from || '');
    if (!from) continue;
    const lp = norm.toLowerCase();
    const lf = from.toLowerCase();
    if (lp === lf) return r.to;
    if (lp.startsWith(lf) && (norm[from.length] === '\\' || norm[from.length] === '/')) {
      return r.to + norm.slice(from.length);
    }
  }
  return norm;
}

function localIso(d) {
  const p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export function stampId(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `scan-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function humanSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

/* ── 配置 → 扫描源 ─────────────────────────────────────── */

/**
 * sources 支持两种写法：
 *   web: 'D:\...'                                  → 整目录
 *   tools: { path: 'D:\...', include: ['A','B'] }   → 白名单
 */
export function collectSources(config) {
  const sources = config?.sources || {};
  const comps = config?.components || {};
  const out = [];
  for (const [component, v] of Object.entries(sources)) {
    if (!v) continue;
    if (comps[component] && comps[component].enabled === false) continue;

    if (typeof v === 'string') {
      out.push({ component, root: v, includes: null });
    } else if (typeof v === 'object') {
      const root = v.path || v.root;
      if (!root) continue;
      const includes = Array.isArray(v.include) && v.include.length ? v.include.map(String) : null;
      out.push({ component, root, includes });
    }
  }
  return out;
}

/* ── 哈希 ──────────────────────────────────────────────── */

async function hashFile(abs) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await stat(abs);
    const hash = createHash('sha256');
    const fh = await open(abs, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let pos = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        hash.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
    const after = await stat(abs);
    // 前后一致才算数，否则说明扫描期间有人在写，重来
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { sha256: hash.digest('hex'), size: after.size, mtimeMs: after.mtimeMs };
    }
    lastErr = new Error('file changed while hashing');
  }
  throw lastErr;
}

async function hashPool(files, concurrency) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      const f = files[i];
      try {
        const r = await hashFile(f.abs);
        f.sha256 = r.sha256;
        f.size = r.size;
        f.mtimeMs = r.mtimeMs;
      } catch (e) {
        f.error = e.code || e.message;
      }
    }
  });
  await Promise.all(workers);
}

/* ── 遍历 ──────────────────────────────────────────────── */

function describeError(e) {
  if (e.code === 'ENOENT') return '路径不存在';
  if (e.code === 'EPERM' || e.code === 'EACCES') return '拒绝访问';
  if (e.code === 'EBUSY') return '文件被占用';
  if (e.code === 'ENOTDIR') return '不是目录';
  return e.message || String(e);
}

async function safeStat(abs, errors) {
  try {
    return await stat(abs);
  } catch (e) {
    errors.push({ code: e.code || 'EIO', path: abs, message: describeError(e) });
    return null;
  }
}

async function walkInto(absRoot, relRoot, ctx) {
  const stack = [{ abs: absRoot, rel: relRoot, depth: 0 }];

  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur.abs, { withFileTypes: true });
    } catch (e) {
      ctx.errors.push({ code: e.code || 'EIO', path: cur.abs, message: describeError(e) });
      continue;
    }

    for (const ent of entries) {
      const rel = cur.rel ? `${cur.rel}/${ent.name}` : ent.name;

      // junction / 符号链接一律不跟：桌面快捷方式式的链接会绕成环，也可能指到范围外
      if (ent.isSymbolicLink()) {
        ctx.warnings.push({ code: 'symlink-skipped', path: join(cur.abs, ent.name) });
        continue;
      }

      if (ent.isDirectory()) {
        if (ctx.ignore.pruneDir(rel)) { ctx.stats.prunedDirs++; continue; }
        if (cur.depth >= MAX_DEPTH) {
          ctx.warnings.push({ code: 'max-depth', path: join(cur.abs, ent.name) });
          continue;
        }
        stack.push({ abs: join(cur.abs, ent.name), rel, depth: cur.depth + 1 });
        continue;
      }

      if (ent.isFile()) {
        if (ctx.ignore.isIgnored(rel, false)) { ctx.stats.skippedFiles++; continue; }
        const key = toSlash(join(cur.abs, ent.name)).toLowerCase();
        if (ctx.seen.has(key)) continue;
        ctx.seen.add(key);
        ctx.files.push({ rel, abs: join(cur.abs, ent.name) });
        if (ctx.files.length > ctx.maxFiles) {
          throw new Error(`文件数超过上限 ${ctx.maxFiles}，扫描中止（先确认 sources 没指到部署根）`);
        }
      }
    }
  }
}

/* ── 快照 ──────────────────────────────────────────────── */

/**
 * @returns {{
 *   createdAt: string,
 *   components: Record<string, {root: string, files: Record<string, {sha256:string,size:number,mtimeMs:number}>}>,
 *   stats: object, errors: any[], warnings: any[]
 * }}
 */
export async function buildSnapshot(config, opts = {}) {
  const {
    remaps = [],
    concurrency = DEFAULT_CONCURRENCY,
    maxFiles = DEFAULT_MAX_FILES,
    onProgress,
  } = opts;

  const ignore = createIgnore(config.exclude || []);
  const sources = collectSources(config).map(s => ({ ...s, root: remapPath(s.root, remaps) }));

  const components = {};
  const errors = [];
  const warnings = [];
  const stats = { sources: sources.length, files: 0, hashed: 0, bytes: 0, skippedFiles: 0, prunedDirs: 0, failed: 0 };

  for (const src of sources) {
    const ctx = {
      ignore, errors, warnings, stats,
      files: [],
      seen: new Set(),
      maxFiles,
    };

    const roots = src.includes && src.includes.length
      ? src.includes.map(inc => ({ abs: join(src.root, toSlash(inc)), rel: toSlash(inc) }))
      : [{ abs: src.root, rel: '' }];

    for (const r of roots) {
      const st = await safeStat(r.abs, errors);
      if (!st) continue;
      if (st.isDirectory()) {
        await walkInto(r.abs, r.rel, ctx);
      } else if (st.isFile()) {
        if (ignore.isIgnored(r.rel, false)) { stats.skippedFiles++; continue; }
        const key = toSlash(r.abs).toLowerCase();
        if (!ctx.seen.has(key)) {
          ctx.seen.add(key);
          ctx.files.push({ rel: r.rel, abs: r.abs });
        }
      }
    }

    await hashPool(ctx.files, concurrency);

    const files = {};
    for (const f of ctx.files) {
      if (!f.sha256) { stats.failed++; continue; }
      files[f.rel] = { sha256: f.sha256, size: f.size, mtimeMs: f.mtimeMs };
    }

    components[src.component] = { root: src.root, files };

    const n = Object.keys(files).length;
    stats.files += n;
    stats.hashed += n;
    stats.bytes += Object.values(files).reduce((a, f) => a + f.size, 0);
    if (onProgress) onProgress({ component: src.component, root: src.root, files: n });
  }

  return {
    format: 1,
    createdAt: localIso(new Date()),
    components,
    stats,
    errors,
    warnings,
  };
}

/* ── 比对 ──────────────────────────────────────────────── */

function indexCi(files) {
  const m = new Map();
  for (const [k, v] of Object.entries(files || {})) m.set(k.toLowerCase(), { path: k, ...v });
  return m;
}

/**
 * @returns {{groups: any[], stats: object}}
 */
export function buildPending(snapshot, baseline) {
  const groups = [];
  const stats = {
    components: 0,
    tracked: 0,
    unchanged: 0,
    added: 0,
    modified: 0,
    deleted: 0,
    bytes: 0,
  };

  for (const [component, cur] of Object.entries(snapshot.components)) {
    const baseFiles = baseline?.components?.[component]?.files || {};
    const baseMap = indexCi(baseFiles);
    const curMap = indexCi(cur.files);

    const files = [];
    let a = 0; let m = 0; let d = 0; let unchanged = 0;

    for (const [lk, f] of curMap) {
      const b = baseMap.get(lk);
      if (!b) {
        files.push({ action: 'A', path: f.path, sha256: (f.sha256 || '').slice(0, 8), sizeBytes: f.size || 0, mtime: localIso(new Date(f.mtimeMs || Date.now())) });
        a++;
        stats.bytes += f.size || 0;
      } else if (b.sha256 !== f.sha256) {
        files.push({ action: 'M', path: f.path, sha256: (f.sha256 || '').slice(0, 8), sizeBytes: f.size || 0, mtime: localIso(new Date(f.mtimeMs || Date.now())) });
        m++;
        stats.bytes += f.size || 0;
      } else {
        unchanged++;
      }
    }

    for (const [lk, b] of baseMap) {
      if (curMap.has(lk)) continue;
      files.push({ action: 'D', path: b.path, sha256: '', sizeBytes: b.size || 0, mtime: '' });
      d++;
    }

    files.sort((x, y) => (x.path.toLowerCase() < y.path.toLowerCase() ? -1 : 1));

    stats.components++;
    stats.tracked += curMap.size;
    stats.unchanged += unchanged;
    stats.added += a;
    stats.modified += m;
    stats.deleted += d;

    groups.push({
      component,
      root: cur.root,
      counts: { A: a, M: m, D: d },
      files,
    });
  }

  return { groups, stats, baselineAt: baseline?.createdAt || null };
}

/* ── 从配置推导「这次改动会落到哪些节点 / 怎么落地」 ───── */

export function computeTargets(config) {
  const out = {};
  for (const [ip, node] of Object.entries(config?.nodes || {})) {
    if (node.role === 'source') continue;          // 源节点不接收同步
    const id = String(node.id || ip).replace(/^node-/, '');
    for (const [comp, v] of Object.entries(node.components || {})) {
      if (!v || v.enabled === false) continue;
      if (v.localRoot === null) continue;          // 路径没确认的不算目标
      (out[comp] = out[comp] || []).push(id);
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

export function computeModes(config) {
  const out = {};
  for (const [name, c] of Object.entries(config?.components || {})) {
    if (c && c.updateMode) out[name] = c.updateMode;
  }
  return out;
}

/** 打包成界面 / API 用的清单 */
export function buildManifestPayload(snapshot, baseline, config = null) {
  const { groups, stats, baselineAt } = buildPending(snapshot, baseline);
  return {
    format: 1,
    id: stampId(new Date(snapshot.createdAt)),
    createdAt: snapshot.createdAt,
    baselineAt,
    sources: Object.entries(snapshot.components).map(([component, c]) => ({ component, root: c.root })),
    stats: {
      ...stats,
      hashed: snapshot.stats.hashed,
      skippedFiles: snapshot.stats.skippedFiles,
      prunedDirs: snapshot.stats.prunedDirs,
      failed: snapshot.stats.failed,
    },
    groups,
    targets: computeTargets(config),
    modes: computeModes(config),
    errors: snapshot.errors,
    warnings: snapshot.warnings,
  };
}

/** 基线文件（只保留哈希与大小，不带时间以外的冗余） */
export function buildBaseline(snapshot) {
  return {
    format: 1,
    createdAt: snapshot.createdAt,
    components: snapshot.components,
    note: '上一次同步/建基线时的文件清单。扫描结果与它比对得出变更。',
  };
}

export { localIso, toSlash };
