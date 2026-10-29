/* 按天切分的 JSONL 流水（事件 / 启停台账共用）
 *
 *   <dir>\<prefix>-YYYYMMDD.jsonl     每行一个 JSON，append-only
 *   <dir>\YYYYMMDD.jsonl              prefix 给空串时（启停台账就这么用）
 *
 * 为什么落盘：事件页要追「昨晚 22:13 到底断没断过」，启停记录要追
 * 「谁在什么时候停了 145 的 mcpserver、成功没有、为什么失败」——
 * 只在内存里的话重启就没了。
 *
 * 设计取舍：
 *   - 内存里保留最近 maxMemory 条（默认 5 万），查询/分页/统计全在内存里做；
 *     启动时把 30 天内的文件读回来，所以重启后页面不是空的。
 *   - 写盘串行排队（append 异步、顺序必须保），失败只打日志、不影响业务。
 *   - 过期文件在启动时和跨天时各清理一次。
 */
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAY_MS = 86400000;
const RESULT_SET = ['ok', 'warn', 'fail'];

/** 本地日期键 YYYYMMDD（按本机时区切天，跟人看到的日期一致） */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** 本地时间 ISO（带时区偏移），界面直接截取显示 */
function localIso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 本地当天 0 点 */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {object} opts
 * @param {string} opts.dir           目录（不存在会自动建）
 * @param {string} [opts.prefix]      文件名前缀，默认 'events'；给 '' 就是 YYYYMMDD.jsonl
 * @param {number} [opts.keepDays]    保留天数，默认 30
 * @param {number} [opts.maxMemory]   内存里最多留多少条，默认 5 万
 */
export function createEventLog({
  dir,
  prefix = 'events',
  keepDays = 30,
  maxMemory = 50000,
  now = () => Date.now(),
  onError = (e) => console.error(`[${prefix || 'log'}]`, e.message),
} = {}) {
  if (!dir) throw new Error('createEventLog 需要 dir');

  const stem = prefix ? `${prefix}-` : '';
  const fileRe = new RegExp(`^${escapeRe(stem)}(\\d{8})\\.jsonl$`);
  const dayOfFile = (name) => (name.match(fileRe) || [])[1] || '';

  let events = [];          // 新→旧
  let queue = Promise.resolve();
  let lastDay = null;

  const fileOf = (ms) => join(dir, `${stem}${dayKey(ms)}.jsonl`);

  /** 记录统一成这一份形状（老文件里可能没有 ts / message） */
  function normalize(e) {
    if (!e || e.at === null || e.at === undefined || e.at === '') return null;
    const at = Number(e.at);
    if (!Number.isFinite(at) || at <= 0) return null;
    // 事件页用 ms，启停台账用 durationMs，两种都认（master 落盘时带的是 durationMs）
    const rawMs = (e.durationMs === null || e.durationMs === undefined || e.durationMs === '') ? e.ms : e.durationMs;
    const ms = (rawMs === null || rawMs === undefined || rawMs === '') ? null : Number(rawMs);
    const pid = (e.pid === null || e.pid === undefined || e.pid === '') ? null : Number(e.pid);
    const detail = String(e.detail ?? e.message ?? '');
    return {
      id: e.id ? String(e.id) : null,
      at,
      ts: e.ts || localIso(at),
      node: String(e.node || ''),
      action: String(e.action || ''),
      result: RESULT_SET.includes(e.result) ? e.result : 'ok',
      component: e.component ? String(e.component) : null,
      code: e.code ? String(e.code) : null,
      pid: Number.isFinite(pid) ? pid : null,
      durationMs: Number.isFinite(ms) ? ms : null,
      taskId: e.taskId ? String(e.taskId) : null,
      detail,
      message: String(e.message ?? detail),
      ms: Number.isFinite(ms) ? ms : null,
    };
  }

  async function files() {
    const names = await readdir(dir).catch(() => []);
    return names.filter((n) => fileRe.test(n)).sort();
  }

  /** 删掉超过 keepDays 的按天文件 */
  async function prune() {
    const cutoff = dayKey(now() - (keepDays - 1) * DAY_MS);
    const all = await files();
    let removed = 0;
    for (const f of all) {
      if (dayOfFile(f) < cutoff) {
        await rm(join(dir, f), { force: true }).catch((e) => onError(e));
        removed++;
      }
    }
    return removed;
  }

  /** 启动时：建目录、清过期、把 30 天内记录读回内存 */
  async function init() {
    await mkdir(dir, { recursive: true });
    await prune();

    const cutoff = dayKey(now() - (keepDays - 1) * DAY_MS);
    const keep = (await files()).filter((f) => dayOfFile(f) >= cutoff);
    const loaded = [];
    // 从最新的一天往前读，读够 maxMemory 就停（超大量记录时不至于把内存吃满）
    for (let i = keep.length - 1; i >= 0 && loaded.length < maxMemory; i--) {
      let text = '';
      try { text = await readFile(join(dir, keep[i]), 'utf8'); } catch (e) { onError(e); continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = normalize(JSON.parse(line));
          if (ev) loaded.push(ev);
        } catch { /* 半行/坏行：跳过，不影响其它 */ }
        if (loaded.length >= maxMemory) break;
      }
    }
    loaded.sort((a, b) => b.at - a.at);
    events = loaded.slice(0, maxMemory);
    lastDay = dayKey(now());
    return events.length;
  }

  /** 追加一条（内存 + 当天的文件）；返回规范化后的记录，方便调用方复用 */
  function append(ev) {
    const rec = normalize(ev);
    if (!rec) return null;
    events.unshift(rec);
    if (events.length > maxMemory) events.length = maxMemory;

    const day = dayKey(rec.at);
    if (lastDay && day !== lastDay) {
      lastDay = day;
      prune().catch(onError);           // 跨天顺手清一次过期文件
    } else {
      lastDay = day;
    }

    queue = queue
      .then(() => appendFile(fileOf(rec.at), `${JSON.stringify(rec)}\n`, 'utf8'))
      .catch((e) => onError(e));
    return rec;
  }

  // 节点 id 有两种写法：配置里的 node-149，界面上显示的 149 —— 筛选时两种都认
  const shortNode = (x) => String(x || '').replace(/^node-/, '');
  const matches = (e, { node, component, action, result }) => (
    (!node || shortNode(e.node) === shortNode(node))
    && (!component || e.component === component)
    && (!action || e.action === action)
    && (!result || e.result === result)
  );

  /** 分页查询：page 从 1 开始，size 默认 15、上限 200 */
  function query({ page = 1, size = 15, node = '', component = '', action = '', result = '' } = {}) {
    const sizeN = Math.min(200, Math.max(1, Math.floor(Number(size)) || 15));
    const filtered = events.filter((e) => matches(e, { node, component, action, result }));
    const pages = Math.max(1, Math.ceil(filtered.length / sizeN));
    const pageN = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
    const start = (pageN - 1) * sizeN;
    return {
      total: filtered.length,
      page: pageN,
      size: sizeN,
      pages,
      items: filtered.slice(start, start + sizeN),
    };
  }

  /** 顶部统计卡：今日启停次数 / 失败数 / 最近一次失败 / 最近一条 */
  function stats({ todayStart } = {}) {
    const t0 = todayStart ?? startOfDay(now());
    let today = 0;
    let fail = 0;
    let lastFail = null;
    for (const e of events) {
      if ((e.action === 'start' || e.action === 'stop' || e.action === 'restart') && e.at >= t0) today++;
      if (e.result === 'fail') {
        fail++;
        if (!lastFail) lastFail = e;       // 新→旧，第一条就是最近的一次
      }
    }
    return { today, fail, lastFail, last: events[0] || null };
  }

  const recent = (n = 30) => events.slice(0, Math.max(0, n));
  const count = () => events.length;
  const ids = () => new Set(events.map((e) => e.id).filter(Boolean));

  return { init, append, prune, query, stats, recent, count, ids, dir, keepDays, prefix };
}
