/* 成员侧落地（M2）：按 98 的 manifest 把改后的文件覆盖到本地
 *
 * 顺序（每个文件）：
 *   1. 校验相对路径（不允许 ../、盘符、绝对路径、Windows 非法字符）
 *   2. 目标已存在 → 先备份到 <backupDir>\<relId>\<组件>\<相对路径>
 *   3. 从共享读 blob → 边写临时文件边算 sha256 → 和 manifest 比对（不一致就丢弃，绝不落地）
 *   4. 临时文件 rename 覆盖目标（同分区，近似原子）
 *
 * 不整目录拷贝，只处理 manifest 里列出的文件；删除项同样先备份再删。
 * 输出一律 {ok, landed, deleted, skipped, bytes, files, errors}，不抛裸异常给上层。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const toSlash = (p) => String(p).replace(/\\/g, '/');
const MAX_ERRORS = 20;

/* ── 与 master 同口径的路径校验（agent 只带这几个文件，不依赖 release.mjs） ── */

function safeRel(rel) {
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

function isUnder(root, target) {
  const r = resolve(root).toLowerCase();
  const t = resolve(target).toLowerCase();
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

const joinRel = (root, rel) => join(root, ...safeRel(rel).split('/'));

async function exists(p) {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** 复制 + 边复制边算 sha256 */
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
  return { sha256: hash.digest('hex'), size: st.size };
}

/** rename 覆盖；Windows 上目标被占时会失败，退化成先删再改名 */
async function replace(tmp, target) {
  try {
    await rename(tmp, target);
  } catch (e) {
    if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e;
    await rm(target, { force: true });
    await rename(tmp, target);
  }
}

function describe(e) {
  if (e.code === 'ENOENT') return '文件不存在（共享上被删了？）';
  if (e.code === 'EPERM' || e.code === 'EACCES') return '拒绝访问（目标被占用或权限不足）';
  if (e.code === 'EBUSY') return '文件被占用（服务可能还在跑）';
  if (e.code === 'ENOSPC') return '磁盘空间不足';
  return e.message || String(e);
}

/**
 * 按 manifest 落地。
 *
 * @param {object} o
 * @param {object} o.manifest   同步包清单
 * @param {string} o.share      同步包目录（成员视角的 UNC）
 * @param {Record<string, object>} o.specs  本机组件定义（要 localRoot）
 * @param {string} o.backupRoot 备份根目录
 * @param {string[]|null} o.components 只落这些组件（null = 清单里全部）
 */
export async function applyRelease({ manifest, share, specs = {}, backupRoot, components = null, includeDeletes = true }) {
  const t0 = Date.now();
  const done = (extra) => ({ ...extra, durationMs: Date.now() - t0 });

  if (!manifest || Number(manifest.format) !== 1) {
    return done({ ok: false, code: 'manifest_invalid', message: 'manifest 缺失或 format 不是 1', errors: [] });
  }
  if (!share) return done({ ok: false, code: 'bad_request', message: '没给 share 路径', errors: [] });
  if (!backupRoot) return done({ ok: false, code: 'bad_request', message: '本机没有 backupDir', errors: [] });

  const only = Array.isArray(components) && components.length ? new Set(components) : null;
  const relId = String(manifest.relId || 'unknown');
  const errors = [];
  const files = [];
  let landed = 0;
  let deleted = 0;
  let skipped = 0;
  let bytes = 0;

  const addError = (item) => {
    if (errors.length < MAX_ERRORS) errors.push(item);
  };

  const backupOf = (component, rel) => join(backupRoot, relId, component, ...rel.split('/'));

  /* ── 写入 ── */
  for (const f of manifest.files || []) {
    if (only && !only.has(f.component)) { skipped++; continue; }

    const spec = specs[f.component];
    if (!spec) {
      addError({ code: 'not_configured', component: f.component, path: f.path, message: `本机配置里没有组件 ${f.component}` });
      continue;
    }
    if (!spec.localRoot) {
      addError({ code: 'no_local_root', component: f.component, path: f.path, message: `${f.component} 没有 localRoot` });
      continue;
    }

    let rel;
    let target;
    try {
      rel = safeRel(f.path);
      target = joinRel(spec.localRoot, rel);
      if (!isUnder(spec.localRoot, target)) throw new Error(`越界：${f.path}`);
    } catch (e) {
      addError({ code: 'bad_path', component: f.component, path: f.path, message: e.message });
      continue;
    }

    const tmp = `${target}.vcsnew`;
    try {
      const existed = await exists(target);
      if (existed) {
        const bak = backupOf(f.component, rel);
        await mkdir(dirname(bak), { recursive: true });
        await copyFile(target, bak);
      }

      const got = await copyHash(joinRel(share, f.blob || `files/${f.component}/${rel}`), tmp);
      if (f.sha256 && got.sha256 !== f.sha256) {
        await rm(tmp, { force: true });
        addError({
          code: 'sha_mismatch', component: f.component, path: rel,
          message: `校验不过：manifest ${String(f.sha256).slice(0, 8)} / 实际 ${got.sha256.slice(0, 8)}`,
        });
        continue;
      }

      await replace(tmp, target);
      landed++;
      bytes += got.size;
      files.push({
        component: f.component,
        path: rel,
        action: f.action || 'M',
        sha256: got.sha256,
        size: got.size,
        replaced: existed,
        sourceMtime: f.sourceMtime || null,
      });
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      addError({ code: e.code || 'write_failed', component: f.component, path: rel || f.path, message: describe(e) });
    }
  }

  /* ── 删除 ── */
  if (includeDeletes) {
    for (const d of manifest.deletes || []) {
      if (only && !only.has(d.component)) continue;
      const spec = specs[d.component];
      if (!spec?.localRoot) {
        addError({ code: spec ? 'no_local_root' : 'not_configured', component: d.component, path: d.path, message: `${d.component} 没有可用的 localRoot` });
        continue;
      }
      let rel;
      let target;
      try {
        rel = safeRel(d.path);
        target = joinRel(spec.localRoot, rel);
        if (!isUnder(spec.localRoot, target)) throw new Error(`越界：${d.path}`);
      } catch (e) {
        addError({ code: 'bad_path', component: d.component, path: d.path, message: e.message });
        continue;
      }
      try {
        if (!(await exists(target))) { skipped++; continue; }
        const bak = backupOf(d.component, rel);
        await mkdir(dirname(bak), { recursive: true });
        await copyFile(target, bak);
        await unlink(target);
        deleted++;
        files.push({ component: d.component, path: rel, action: 'D', sha256: null, size: 0, replaced: true });
      } catch (e) {
        addError({ code: e.code || 'delete_failed', component: d.component, path: rel, message: describe(e) });
      }
    }
  }

  return done({
    ok: errors.length === 0,
    releaseId: relId,
    landed,
    deleted,
    skipped,
    bytes,
    files,
    errors,
    truncated: errors.length >= MAX_ERRORS,
    code: errors.length ? 'partial' : undefined,
  });
}

export { safeRel, isUnder, joinRel };
