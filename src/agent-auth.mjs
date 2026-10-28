/* vcsNode 控制面鉴权（协议 §1.1）
 *
 * 两端共用同一份实现：agent 签名，master 验签。零依赖，只用 node:crypto。
 *
 *   sign = HMAC-SHA256(secret, nodeId \n ts \n nonce \n METHOD \n path \n sha256(body))
 *
 * - path 含 query（GET /api/agent/stream?since=41 也要签）
 * - body 用原始字节，不要先 JSON.parse 再 stringify（空格/键序会变）
 * - ts 为 Unix 毫秒，偏差 > ±5 分钟拒绝
 * - nonce 10 分钟内不可重复
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const PROTO = 1;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const NONCE_TTL_MS = 10 * 60 * 1000;

export function sha256Hex(data = '') {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalString({ nodeId, ts, nonce, method, path, bodyHash }) {
  return [nodeId, ts, nonce, String(method).toUpperCase(), path, bodyHash].join('\n');
}

/**
 * 生成签名头。
 * @param {{secret:string, nodeId:string, method:string, path:string,
 *          body?:Buffer|string, ts?:number, nonce?:string}} p
 */
export function signRequest({ secret, nodeId, method, path, body = '', ts = Date.now(), nonce = randomUUID() }) {
  const bodyHash = sha256Hex(body);
  const sign = createHmac('sha256', secret)
    .update(canonicalString({ nodeId, ts, nonce, method, path, bodyHash }))
    .digest('hex');

  return {
    ts,
    nonce,
    sign,
    headers: {
      'X-VCS-Node': nodeId,
      'X-VCS-Ts': String(ts),
      'X-VCS-Nonce': nonce,
      'X-VCS-Sign': sign,
      'X-VCS-Proto': String(PROTO),
    },
  };
}

/** 定长的十六进制比较，避免时序侧信道 */
function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export class NonceStore {
  constructor(ttlMs = NONCE_TTL_MS) {
    this.ttlMs = ttlMs;
    this.seen = new Map();
  }

  /** 返回 false 表示重复（重放） */
  admit(nonce, now = Date.now()) {
    this.prune(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }

  prune(now = Date.now()) {
    const cut = now - this.ttlMs;
    for (const [k, t] of this.seen) {
      if (t < cut) this.seen.delete(k);
      else break; // Map 按插入顺序，后面的都更新
    }
  }
}

/**
 * 校验一次请求。
 * @returns {{ok:true,nodeId:string,ts:number}|{ok:false,status:number,code:string,message:string}}
 */
export function verifyRequest({ secret, headers, method, path, body = '', nonceStore, now = Date.now() }) {
  const h = headers || {};
  const nodeId = h['x-vcs-node'];
  const tsRaw = h['x-vcs-ts'];
  const nonce = h['x-vcs-nonce'];
  const sign = h['x-vcs-sign'];
  const proto = h['x-vcs-proto'];

  if (!nodeId || !tsRaw || !nonce || !sign) {
    return { ok: false, status: 401, code: 'missing_headers', message: '缺少 X-VCS-Node / X-VCS-Ts / X-VCS-Nonce / X-VCS-Sign' };
  }
  if (proto && String(proto) !== String(PROTO)) {
    return { ok: false, status: 426, code: 'proto_mismatch', message: `协议版本不一致：请求 ${proto}，本机支持 ${PROTO}` };
  }

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) {
    return { ok: false, status: 401, code: 'bad_timestamp', message: 'X-VCS-Ts 不是数字' };
  }
  if (Math.abs(now - ts) > CLOCK_SKEW_MS) {
    return {
      ok: false, status: 401, code: 'clock_skew',
      message: `时间偏差 ${Math.round((now - ts) / 1000)}s 超过 ±5 分钟`,
    };
  }

  const bodyHash = sha256Hex(body);
  const expect = createHmac('sha256', secret)
    .update(canonicalString({ nodeId, ts, nonce, method, path, bodyHash }))
    .digest('hex');

  if (!safeEqualHex(expect, sign)) {
    return { ok: false, status: 401, code: 'bad_signature', message: '签名不匹配（secret 或 path 不一致）' };
  }

  if (nonceStore && !nonceStore.admit(nonce, now)) {
    return { ok: false, status: 401, code: 'replay', message: 'nonce 重复（10 分钟内已用过）' };
  }

  return { ok: true, nodeId: String(nodeId), ts };
}
