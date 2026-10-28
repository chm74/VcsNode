/* 配置读写：只改需要改的那几行，不动注释
 *
 * 为什么不做「解析成对象再整个重新生成」：
 *   config/vcsnode.yaml 里的注释是这套系统唯一的说明文档，重新生成会全丢。
 * 所以这里的做法是：解析出结构（用于校验），修改时按行号定位，只替换值；
 * 写盘之前再把新文本解析一遍，和「预期结构」逐字段比对 ——
 * 只要有一处对不上就放弃保存，宁可保存失败，也不留一份读不懂的配置。
 */

import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseYaml, scanLines, parseFlowMap, emitValue, emitFlowMap, stripComment } from './yaml.mjs';
import { readJson, writeJsonAtomic } from './state.mjs';
import { localIso } from './scan.mjs';

const COMPONENT_FIELDS = new Set(['localRoot', 'port', 'enabled']);
const NODE_FIELDS = new Set(['sharedRoot']);

const ABS_PATH = /^[A-Za-z]:[\\/]|^\\\\[^\\/]+[\\/][^\\/]+/;

/* ── 读取 ─────────────────────────────────────────────── */

export async function readConfigText(configPath) {
  const text = await readFile(configPath, 'utf8');
  const data = parseYaml(text);
  if (!data || typeof data !== 'object') throw new Error('配置文件为空或格式不对');
  return { text, data };
}

/* ── 校验 ─────────────────────────────────────────────── */

function trimPath(p) {
  const s = String(p).trim();
  if (/^[A-Za-z]:[\\/]$/.test(s)) return s;       // 盘符根不动
  if (s === '\\\\') return s;
  return s.replace(/[\\/]+$/, '');
}

export function normalizeChange(change) {
  if (!change || typeof change !== 'object') throw new Error('改动格式不对');

  const ip = String(change.ip || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`节点地址不合法：${ip || '(空)'}`);

  if (change.component === undefined || change.component === null) {
    const field = String(change.field || '');
    if (!NODE_FIELDS.has(field)) throw new Error(`不支持修改节点级字段：${field}`);
    if (field === 'sharedRoot') {
      const value = trimPath(change.value ?? '');
      if (!value) throw new Error('共享目录不能为空');
      if (!ABS_PATH.test(value)) throw new Error(`共享目录必须是绝对路径或 UNC：${value}`);
      return { ip, component: null, field, value };
    }
    throw new Error(`不支持修改节点级字段：${field}`);
  }

  const component = String(change.component);
  const field = String(change.field || '');
  if (!COMPONENT_FIELDS.has(field)) throw new Error(`不支持修改组件字段：${field}`);

  if (field === 'localRoot') {
    const raw = change.value;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      return { ip, component, field, value: null };
    }
    const value = trimPath(raw);
    if (!ABS_PATH.test(value)) throw new Error(`部署目录必须是绝对路径或 UNC：${value}`);
    return { ip, component, field, value };
  }

  if (field === 'port') {
    const raw = change.value;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      return { ip, component, field, value: null };
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`端口不合法：${raw}`);
    return { ip, component, field, value: n };
  }

  // enabled
  if (typeof change.value !== 'boolean') throw new Error('enabled 只能是 true / false');
  return { ip, component, field, value: change.value };
}

/* ── 行定位 ───────────────────────────────────────────── */

function keyOf(text) {
  const m = text.match(/^([^:\s]+):(?:\s|$)/);
  return m ? m[1] : null;
}

function findKey(ls, from, to, indent, key) {
  for (let i = from; i < to; i++) {
    const l = ls[i];
    if (l.indent === indent && keyOf(l.text) === key) return i;
  }
  return -1;
}

function endOfBlock(ls, idx) {
  const indent = ls[idx].indent;
  let i = idx + 1;
  while (i < ls.length && ls[i].indent > indent) i++;
  return i;
}

function childKeys(ls, from, to, indent) {
  const out = [];
  for (let i = from; i < to; i++) {
    const l = ls[i];
    if (l.indent !== indent) continue;
    const k = keyOf(l.text);
    if (k) out.push({ key: k, idx: i });
  }
  return out;
}

/** 替换 `key: value  # 注释` 里的 value，保留缩进和注释 */
function replaceValue(raw, value) {
  const visible = stripComment(raw);
  const comment = raw.slice(visible.length).replace(/\s+$/, '');
  const head = visible.replace(/\s+$/, '');
  const colon = head.indexOf(':');
  if (colon < 0) throw new Error(`认不出这一行：${raw}`);
  return `${head.slice(0, colon + 1)} ${emitValue(value)}${comment ? `  ${comment}` : ''}`;
}

/* ── 打补丁 ───────────────────────────────────────────── */

function buildPatch(text, changes) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rawLines = text.split(/\r?\n/);
  const ls = scanLines(text);

  const nodesIdx = findKey(ls, 0, ls.length, 0, 'nodes');
  if (nodesIdx < 0) throw new Error('配置里找不到 nodes: 块');
  const nodesEnd = endOfBlock(ls, nodesIdx);
  const nodeMap = new Map(childKeys(ls, nodesIdx + 1, nodesEnd, 2).map(n => [n.key, n]));

  const replacements = new Map();
  const insertBefore = new Map();
  const insertAfter = new Map();
  const flowCache = new Map();

  const addBefore = (no, lines) => insertBefore.set(no, (insertBefore.get(no) || []).concat(lines));
  const addAfter = (no, lines) => insertAfter.set(no, (insertAfter.get(no) || []).concat(lines));

  for (const ch of changes) {
    const node = nodeMap.get(ch.ip);
    if (!node) throw new Error(`配置里没有节点 ${ch.ip}`);
    const nodeEnd = endOfBlock(ls, node.idx);

    if (!ch.component) {
      const storageIdx = findKey(ls, node.idx + 1, nodeEnd, 4, 'storage');
      if (storageIdx >= 0) {
        const sEnd = endOfBlock(ls, storageIdx);
        const srIdx = findKey(ls, storageIdx + 1, sEnd, 6, 'sharedRoot');
        if (srIdx >= 0) {
          replacements.set(ls[srIdx].no, replaceValue(rawLines[ls[srIdx].no], ch.value));
        } else {
          addAfter(ls[storageIdx].no, [`${' '.repeat(6)}sharedRoot: ${emitValue(ch.value)}`]);
        }
      } else {
        const compIdx = findKey(ls, node.idx + 1, nodeEnd, 4, 'components');
        const block = [`${' '.repeat(4)}storage:`, `${' '.repeat(6)}sharedRoot: ${emitValue(ch.value)}`];
        if (compIdx >= 0) addBefore(ls[compIdx].no, block);
        else addAfter(ls[nodeEnd - 1].no, block);
      }
      continue;
    }

    const compsIdx = findKey(ls, node.idx + 1, nodeEnd, 4, 'components');
    if (compsIdx < 0) throw new Error(`${ch.ip} 没有 components: 块，不能改组件配置`);
    const comps = new Map(childKeys(ls, compsIdx + 1, endOfBlock(ls, compsIdx), 6).map(c => [c.key, c]));

    const comp = comps.get(ch.component);
    if (!comp) throw new Error(`${ch.ip} 没有部署 ${ch.component}，不能修改它的配置（新增部署暂不支持）`);

    const line = ls[comp.idx];
    const raw = rawLines[line.no];
    const afterColon = line.text.slice(line.text.indexOf(':') + 1).trim();

    if (afterColon.startsWith('{') && afterColon.endsWith('}')) {
      let obj = flowCache.get(line.no);
      if (!obj) {
        obj = parseFlowMap(afterColon.slice(1, -1));
        flowCache.set(line.no, obj);
      }
      obj[ch.field] = ch.value;

      const braceStart = raw.indexOf('{');
      const braceEnd = raw.lastIndexOf('}');
      replacements.set(
        line.no,
        braceStart >= 0 && braceEnd > braceStart
          ? raw.slice(0, braceStart) + emitFlowMap(obj) + raw.slice(braceEnd + 1)
          : `${' '.repeat(6)}${ch.component}: ${emitFlowMap(obj)}`,
      );
      continue;
    }

    if (afterColon === '') {
      const cEnd = endOfBlock(ls, comp.idx);
      const fIdx = findKey(ls, comp.idx + 1, cEnd, 8, ch.field);
      if (fIdx >= 0) {
        replacements.set(ls[fIdx].no, replaceValue(rawLines[ls[fIdx].no], ch.value));
      } else {
        addAfter(ls[cEnd - 1].no, [`${' '.repeat(8)}${ch.field}: ${emitValue(ch.value)}`]);
      }
      continue;
    }

    throw new Error(`${ch.ip} 的 ${ch.component} 写法不认识：${line.text}`);
  }

  const out = [];
  for (let i = 0; i < rawLines.length; i++) {
    const before = insertBefore.get(i);
    if (before) out.push(...before);
    out.push(replacements.has(i) ? replacements.get(i) : rawLines[i]);
    const after = insertAfter.get(i);
    if (after) out.push(...after);
  }
  return out.join(eol);
}

/* ── 结构比对 ─────────────────────────────────────────── */

const clone = x => JSON.parse(JSON.stringify(x));

function applyExpected(data, changes) {
  const d = clone(data);
  for (const ch of changes) {
    const node = d.nodes[ch.ip];
    if (!ch.component) {
      if (ch.field === 'sharedRoot') {
        node.storage = node.storage || {};
        node.storage.sharedRoot = ch.value;
      }
      continue;
    }
    node.components[ch.component][ch.field] = ch.value;
  }
  return d;
}

function firstDiff(a, b, path = '') {
  if (a === b) return null;

  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const ka = kind(a);
  const kb = kind(b);
  if (ka !== kb) return `${path || '(根)'}：${ka} ≠ ${kb}`;

  if (ka === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }

  if (ka === 'array') {
    if (a.length !== b.length) return `${path}.length：${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }

  return `${path}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
}

/* ── 备份 ─────────────────────────────────────────────── */

function stampNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 同一秒内连续保存时给备份名加 -2 / -3 后缀，避免后一次覆盖前一次的备份 */
async function copyBackup(configPath, dir) {
  const stamp = stampNow();
  for (let i = 1; i <= 100; i++) {
    const p = join(dir, i === 1 ? `vcsnode-${stamp}.yaml` : `vcsnode-${stamp}-${i}.yaml`);
    try {
      await copyFile(configPath, p, FS.COPYFILE_EXCL);
      return p;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('备份文件名冲突过多，已放弃保存');
}

async function pruneBackups(dir, keep) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const backups = names.filter(n => /^vcsnode-.*\.yaml$/.test(n)).sort();
  for (const n of backups.slice(0, Math.max(0, backups.length - keep))) {
    await unlink(join(dir, n)).catch(() => {});
  }
}

async function bumpRevision(stateDir, changes) {
  const file = join(stateDir, 'config-revision.json');
  const cur = (await readJson(file, { revision: 0 })) || { revision: 0 };
  const next = {
    revision: (cur.revision || 0) + 1,
    updatedAt: localIso(new Date()),
    changes: changes.length,
    last: changes.map(c => ({ ip: c.ip, component: c.component, field: c.field })),
  };
  await writeJsonAtomic(file, next);
  return next;
}

/* ── 保存 ─────────────────────────────────────────────── */

export async function saveConfig({ configPath, stateDir, changes }) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { changed: 0, revision: null, backup: null, configPath };
  }

  // 同一个字段改多次，以最后一次为准
  const byTarget = new Map();
  for (const raw of changes) {
    const n = normalizeChange(raw);
    byTarget.set(`${n.ip}|${n.component || ''}|${n.field}`, n);
  }

  const { text, data } = await readConfigText(configPath);

  const effective = [];
  for (const ch of byTarget.values()) {
    const node = data.nodes?.[ch.ip];
    if (!node) throw new Error(`配置里没有节点 ${ch.ip}`);

    let cur;
    if (ch.component) {
      if (!node.components?.[ch.component]) {
        throw new Error(`${ch.ip} 没有部署 ${ch.component}，不能修改它的配置`);
      }
      cur = node.components[ch.component][ch.field];
    } else if (ch.field === 'sharedRoot') {
      cur = node.storage?.sharedRoot;
    }

    if (cur !== ch.value) effective.push(ch);
  }

  if (effective.length === 0) {
    return { changed: 0, revision: null, backup: null, configPath };
  }

  const newText = buildPatch(text, effective);

  let newData;
  try {
    newData = parseYaml(newText);
  } catch (e) {
    throw new Error(`改完的配置解析不了（${e.message}），已放弃保存`);
  }

  const diff = firstDiff(applyExpected(data, effective), newData);
  if (diff) throw new Error(`写入前结构校验没通过：${diff}。已放弃保存，原文件未改动`);

  const backupDir = join(dirname(configPath), 'backup');
  await mkdir(backupDir, { recursive: true });
  const backup = await copyBackup(configPath, backupDir);

  const tmp = `${configPath}.tmp-${process.pid}`;
  await writeFile(tmp, newText, 'utf8');
  await rename(tmp, configPath);
  await pruneBackups(backupDir, 10);

  const revision = await bumpRevision(stateDir, effective);

  return {
    changed: effective.length,
    revision: revision.revision,
    updatedAt: revision.updatedAt,
    backup,
    configPath,
  };
}

/* ── 给界面看的视图 ───────────────────────────────────── */

export function buildConfigView(data, revision = null) {
  const componentNames = Object.keys(data.components || {});

  const nodes = Object.entries(data.nodes || {}).map(([ip, n]) => {
    const comps = n.components || {};

    return {
      ip,
      id: String(n.id || ip).replace(/^node-/, ''),
      role: n.role || 'member',
      env: n.env || null,
      note: n.note || null,
      sharedRoot: n.storage?.sharedRoot ?? data.storage?.sharedRoot ?? null,
      sharedRootInherited: !(n.storage && n.storage.sharedRoot),
      components: componentNames
        .filter((name) => comps[name])
        .map((name) => {
          const v = comps[name] || {};
          const def = data.components?.[name] || {};
          return {
            name,
            kind: def.kind || 'service',
            updateMode: def.updateMode || 'in-place',
            localRoot: v.localRoot === undefined ? null : v.localRoot,
            configured: v.localRoot !== undefined && v.localRoot !== null,
            port: v.port !== undefined ? v.port : (def.port ?? null),
            portOverridden: v.port !== undefined,
            enabled: v.enabled !== false && def.enabled !== false,
            enabledOverride: v.enabled,
          };
        }),
      undeployed: componentNames.filter((name) => !comps[name]),
    };
  });

  return {
    revision: revision?.revision || 0,
    updatedAt: revision?.updatedAt || null,
    master: data.cluster?.master || null,
    system: data.system || null,
    componentNames,
    nodes,
  };
}
