/* 节点注册表 + SSE 通道（M0）
 *
 * 职责：
 *   - 记住每台机器最后一次 hello / snapshot
 *   - 把「成员观测」推导成「界面状态」（判定规则在 node-state.mjs）
 *   - 管住成员那条常驻 SSE 连接（hello / ping / 断开）
 *   - 落 state/nodes.json，主节点重启后还能显示「最后一次看到它是什么时候」
 *
 * 这一层不启停任何东西。
 */

import { readJson, writeJsonAtomic } from './state.mjs';
import { deriveComponent, OFFLINE_MS, DERIVED_LABEL } from './node-state.mjs';
import { componentSpecs } from './probe.mjs';

const MAX_EVENTS = 300;
const MAX_STREAMS = 64;

const shortId = (id) => String(id || '').replace(/^node-/, '');
const pad2 = (n) => String(n).padStart(2, '0');

function hhmmss(t) {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return '—';
  let s = Math.max(0, Math.round(Number(sec)));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分`;
  return `${s} 秒`;
}

export class NodeRegistry {
  constructor({ config, stateFile, offlineMs = OFFLINE_MS, localGraceMs = null, getRevision = () => 0, now = () => Date.now(), onEvent = null }) {
    this.config = config;
    this.stateFile = stateFile;
    this.offlineMs = offlineMs;
    this.localGraceMs = localGraceMs;
    this.getRevision = getRevision;
    this.now = now;
    this.onEvent = onEvent;   // 落盘钩子（master 用它写 logs\events-*.jsonl）

    this.nodes = new Map();   // nodeId -> state
    this.streams = new Map(); // nodeId -> { res, openedAt, addr }
    this.taskWaiters = new Map(); // taskId -> { task, resolve }
    this.events = [];
    this.saveTimer = null;
    this.saving = null;

    this.byIp = new Map();
    let order = 0;
    for (const [ip, def] of Object.entries(config?.nodes || {})) {
      const id = def.id || `node-${shortId(ip)}`;
      const node = {
        id, ip,
        // 列的先后顺序 = vcsnode.yaml 里 nodes: 的书写顺序（98 在最前、149 紧随其后）
        order: order++,
        role: def.role || 'target',
        local: def.role === 'source',
        online: false,
        connectedAt: null,
        lastSeenAt: null,
        remoteAddr: null,
        hostname: null,
        agentVersion: null,
        // 成员自报的控制权限：observe / stage / full（老 agent 不报 = observe）
        control: def.role === 'source' ? 'full' : 'observe',
        uptimeSec: null,
        configRevision: null,
        lastSeq: 0,
        since: 0,
        components: {},
        derived: {},
      };
      this.nodes.set(id, node);
      this.byIp.set(ip, id);
    }
  }

  /* ── 持久化 ───────────────────────────────────────────── */

  async load() {
    const saved = await readJson(this.stateFile, null);
    if (!saved?.nodes) return;
    for (const [id, s] of Object.entries(saved.nodes)) {
      const n = this.nodes.get(id);
      if (!n) continue;
      // 只恢复「历史」，在线状态一律从这次启动重新建立
      Object.assign(n, {
        lastSeenAt: s.lastSeenAt ?? null,
        connectedAt: s.connectedAt ?? null,
        hostname: s.hostname ?? null,
        agentVersion: s.agentVersion ?? null,
        control: s.control || (n.role === 'source' ? 'full' : 'observe'),
        uptimeSec: s.uptimeSec ?? null,
        configRevision: s.configRevision ?? null,
        lastSeq: s.lastSeq ?? 0,
        components: s.components || {},
      });
      n.online = false;
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(() => {});
    }, 1000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  async save() {
    if (this.saving) return this.saving;
    const nodes = {};
    for (const [id, n] of this.nodes) {
      nodes[id] = {
        ip: n.ip, role: n.role,
        lastSeenAt: n.lastSeenAt, connectedAt: n.connectedAt,
        hostname: n.hostname, agentVersion: n.agentVersion,
        uptimeSec: n.uptimeSec, configRevision: n.configRevision,
        lastSeq: n.lastSeq, components: n.components,
      };
    }
    this.saving = writeJsonAtomic(this.stateFile, {
      format: 1,
      updatedAt: new Date(this.now()).toISOString(),
      nodes,
    }).finally(() => { this.saving = null; });
    return this.saving;
  }

  /* ── 事件流 ───────────────────────────────────────────── */

  event(nodeId, action, detail, result = 'ok', ms = null) {
    const ev = {
      t: hhmmss(this.now()),
      at: this.now(),
      node: shortId(nodeId),
      nodeId,
      action,
      detail,
      result,
      ms,
    };
    this.events.unshift(ev);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    // 落盘（失败不能影响业务：事件只是记录）
    if (this.onEvent) {
      try { this.onEvent(ev); } catch { /* 忽略 */ }
    }
    return ev;
  }

  /* ── 成员上下线 / 上报 ────────────────────────────────── */

  ensure(nodeId) {
    return this.nodes.get(nodeId) || null;
  }

  markOnline(nodeId, { remoteAddr } = {}) {
    const n = this.ensure(nodeId);
    if (!n) return null;
    const t = this.now();
    if (!n.online) {
      n.online = true;
      n.connectedAt = t;
      this.event(nodeId, 'connect', `控制面已连接${remoteAddr ? ` · ${remoteAddr}` : ''}`, 'ok');
    }
    n.lastSeenAt = t;
    if (remoteAddr) n.remoteAddr = remoteAddr;
    this.scheduleSave();
    return n;
  }

  applyHello(nodeId, payload = {}) {
    const n = this.markOnline(nodeId);
    if (!n) return null;
    n.hostname = payload.host || n.hostname;
    n.agentVersion = payload.agentVersion ?? n.agentVersion;
    if (payload.control) n.control = String(payload.control);
    n.uptimeSec = payload.uptimeSec ?? n.uptimeSec;
    n.configRevision = payload.configRevision ?? n.configRevision;
    n.lastSeq = payload.lastSeq ?? n.lastSeq;
    this.scheduleSave();
    return n;
  }

  applySnapshot(nodeId, payload = {}) {
    const n = this.markOnline(nodeId);
    if (!n) return null;

    const t = this.now();
    n.uptimeSec = payload.uptimeSec ?? n.uptimeSec;
    n.agentVersion = payload.agentVersion ?? n.agentVersion;
    if (payload.control) n.control = String(payload.control);
    n.configRevision = payload.configRevision ?? n.configRevision;
    n.lastSeq = payload.lastSeq ?? n.lastSeq;
    if (payload.host) n.hostname = payload.host;

    const next = {};
    for (const c of payload.components || []) {
      if (!c || !c.id) continue;
      next[c.id] = { ...c, observedAt: t };
    }
    n.components = next;

    const changed = this.refreshDerived(n, t);
    if (changed.length) {
      const bad = changed.filter((c) => ['degraded', 'crashed', 'orphan'].includes(c.to));
      this.event(
        nodeId, 'state',
        changed.map((c) => `${c.id} ${c.from || '—'}→${c.to}`).join(' · '),
        bad.length ? 'warn' : 'ok',
      );
    }

    this.scheduleSave();
    return n;
  }

  /** 主节点本机（98）直接采样，不走 SSE */
  applyLocalSample(ip, sample) {
    const nodeId = this.byIp.get(ip);
    if (!nodeId) return null;
    const n = this.ensure(nodeId);
    const t = this.now();
    n.local = true;
    n.online = true;
    n.connectedAt = n.connectedAt || t;
    n.lastSeenAt = t;
    n.uptimeSec = n.uptimeSec ?? Math.round(process.uptime());
    n.hostname = n.hostname || 'localhost';
    const next = {};
    for (const c of sample?.components || []) if (c?.id) next[c.id] = { ...c, observedAt: t };
    n.components = next;
    this.refreshDerived(n, t);
    this.scheduleSave();
    return n;
  }

  /** 重新推导并记录状态跃迁，返回本次变化 */
  refreshDerived(n, now = this.now(), onlineOverride = null) {
    const online = onlineOverride === null ? n.online : onlineOverride;
    const changed = [];
    const nextDerived = {};
    for (const [comp, obs] of Object.entries(n.components)) {
      const kind = obs.kind || this.kindOf(n, comp);
      const d = deriveComponent({ online, obs, now, kind });
      const prev = n.derived?.[comp];
      const since = prev && prev.state === d.state ? prev.since : now;
      nextDerived[comp] = { state: d.state, detail: d.detail, since };
      if (!prev || prev.state !== d.state) {
        changed.push({ id: comp, from: prev?.state || null, to: d.state });
      }
    }
    n.derived = nextDerived;
    return changed;
  }

  kindOf(node, comp) {
    return node?.components?.[comp]?.kind
      || this.config?.components?.[comp]?.kind
      || 'service';
  }

  applyAck(nodeId, payload = {}) {
    const n = this.ensure(nodeId);
    if (!n) return null;
    this.markOnline(nodeId);
    this.event(nodeId, 'ack', `task ${payload.taskId || payload.seq || '—'} · ${payload.status || 'ok'}`, payload.status === 'ok' ? 'ok' : 'warn', payload.durationMs ?? null);
    this.settleTask(payload);
    return n;
  }

  applyNack(nodeId, payload = {}) {
    const n = this.ensure(nodeId);
    if (!n) return null;
    this.markOnline(nodeId);
    this.event(nodeId, 'nack', `task ${payload.taskId || payload.seq || '—'} · ${payload.code || 'nack'}${payload.message ? ` · ${payload.message}` : ''}`, 'fail');
    this.settleTask(payload);
    return n;
  }

  /* ── 下发指令（M1：启动 / 停止 / 重启） ──────────────── */

  /**
   * 给成员发一条 task，等它的 ack / nack。
   * 解析成 { task, reply } 或 { task, timeout: true }；连接不在时直接拒绝。
   */
  sendTask(nodeId, data = {}, { timeoutMs = 30000 } = {}) {
    const n = this.ensure(nodeId);
    if (!n) return Promise.reject(new Error(`配置里没有节点 ${nodeId}`));
    if (!this.streams.has(nodeId)) return Promise.reject(new Error(`${nodeId} 没有在线连接，指令发不出去`));

    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const task = {
      id,
      kind: data.kind,
      component: data.component ?? null,
      issuedAt: this.now(),
      by: data.by || null,
    };
    if (data.params) task.params = data.params;
    const seq = (n.seq || 0) + 1;

    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.taskWaiters.delete(id);
        resolve({ task, timeout: true });
      }, Math.max(1000, timeoutMs));
      timer.unref?.();
      this.taskWaiters.set(id, {
        task,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve({ task, reply: payload });
        },
      });
    });

    if (!this.sendEvent(nodeId, 'task', { ...task, seq }, seq)) {
      this.taskWaiters.delete(id);
      return Promise.reject(new Error(`${nodeId} 连接已断，指令没发出去`));
    }
    n.seq = seq;
    this.event(nodeId, 'task', `${task.kind} ${task.component || task.params?.releaseId || ''}`.trim(), 'ok');
    return promise;
  }

  /** 收到 ack / nack 时唤醒在等这条指令的调用方 */
  settleTask(payload) {
    const id = payload?.taskId ?? null;
    if (!id) return false;
    const w = this.taskWaiters.get(id);
    if (!w) return false;
    this.taskWaiters.delete(id);
    w.resolve(payload);
    return true;
  }

  /* ── 离线判定 ─────────────────────────────────────────── */

  sweep(now = this.now()) {
    const dropped = [];
    for (const [id, n] of this.nodes) {
      // 「在线」的唯一依据是**成员还在上报**，不是「socket 还开着」。
      // 拔网线时 TCP 那头毫无反应（没有 FIN/RST），主节点往 socket 写 ping 也会成功，
      // 所以只有「超过 offlineMs 没收到任何上报」才可信。
      // 这里只改状态，不主动断流 —— 断流会把一个其实活着的 agent 踢下去（曾经踩过）。
      if (n.online && n.lastSeenAt && now - n.lastSeenAt > this.graceOf(n)) {
        n.online = false;
        this.event(id, 'disconnect', `${Math.round((now - n.lastSeenAt) / 1000)}s 没有上报`, 'warn');
        dropped.push(id);
      }
    }
    return dropped;
  }

  /** 主节点本机是「轮询采样」，给两倍采样间隔的宽限；成员靠 30s 心跳，用正式阈值 */
  graceOf(n) {
    return n.local && this.localGraceMs ? this.localGraceMs : this.offlineMs;
  }

  /* ── SSE ──────────────────────────────────────────────── */

  attachStream(nodeId, res, { addr } = {}) {
    const n = this.ensure(nodeId);
    if (!n) return false;

    if (this.streams.size >= MAX_STREAMS) this.closeStream([...this.streams.keys()][0]);
    if (this.streams.has(nodeId)) {
      // 同一 nodeId 又连进来：几乎总是成员机上起了两个 agent（旧进程没退 / 计划任务和前台各一个），
      // 两边会互相把对方挤掉，表现为「连上 1 秒就断、一直重连」。
      console.warn(`[stream] ${nodeId} 重复连接：关掉旧连接（成员机上是不是起了两个 agent？）`);
    }
    this.closeStream(nodeId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setTimeout(0);
    }
    res.write('retry: 3000\n\n');

    this.streams.set(nodeId, { res, openedAt: this.now(), addr: addr || null });
    this.markOnline(nodeId, { remoteAddr: addr });

    // hello：seq 固定 0，后续事件按节点内的 seq 递增
    n.seq = 0;
    this.sendEvent(nodeId, 'hello', this.helloPayload(n), 0);

    return true;
  }

  /** hello 载荷：成员据此写 node-config.json。配置变更后也复用它重发 */
  helloPayload(n) {
    return {
      seq: 0,
      serverTime: this.now(),
      configRevision: this.getRevision(),
      proto: 1,
      node: {
        id: n.id,
        ip: n.ip,
        hostname: n.hostname,
        components: this.specsFor(n.ip),
      },
    };
  }

  specsFor(ip) {
    return componentSpecs(this.config, ip) || {};
  }

  /**
   * 配置保存后换用新的解析结果。
   * 只换引用，不重建节点：在线状态、最近观测、事件都保留。
   */
  setConfig(config) {
    if (config && typeof config === 'object') this.config = config;
  }

  /** 配置变更后重新下发 hello，成员刷新本地缓存并立即重采样 */
  pushHello(nodeId = null) {
    const ids = nodeId ? [nodeId] : [...this.streams.keys()];
    let sent = 0;
    for (const id of ids) {
      const n = this.ensure(id);
      if (!n) continue;
      n.seq = 0;
      this.sendEvent(id, 'hello', this.helloPayload(n), 0);
      sent++;
    }
    return sent;
  }

  detachStream(nodeId, res) {
    const cur = this.streams.get(nodeId);
    if (!cur || cur.res !== res) return;
    this.streams.delete(nodeId);
    const n = this.ensure(nodeId);
    if (n && !n.local && n.online) {
      n.online = false;
      this.event(nodeId, 'disconnect', '控制面连接断开', 'warn');
      this.scheduleSave();
    }
  }

  closeStream(nodeId) {
    const cur = this.streams.get(nodeId);
    if (!cur) return;
    this.streams.delete(nodeId);
    try { cur.res.end(); } catch { /* 已经断了 */ }
  }

  sendEvent(nodeId, event, data, id = null) {
    const s = this.streams.get(nodeId);
    if (!s) return false;
    const n = this.ensure(nodeId);
    let seq = id;
    if (seq === null) {
      n.seq = (n.seq || 0) + 1;
      seq = n.seq;
    }
    const text = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    try {
      s.res.write(text);
      return true;
    } catch {
      this.closeStream(nodeId);
      return false;
    }
  }

  pingAll() {
    // ping 只是保活 + 喂给对端读超时，**不算「节点在线」的证据**。
    // 在线与否只看成员有没有按周期上报快照。
    for (const id of [...this.streams.keys()]) this.sendEvent(id, 'ping', {});
  }

  /* ── 给界面 ───────────────────────────────────────────── */

  uiPayload(now = this.now()) {
    const compOrder = Object.keys(this.config?.components || {});
    const extra = new Set();
    for (const n of this.nodes.values()) {
      for (const k of Object.keys(n.components)) if (!compOrder.includes(k)) extra.add(k);
    }
    const allComps = [...compOrder, ...extra];

    const kinds = {};
    for (const c of allComps) kinds[c] = this.config?.components?.[c]?.kind || 'service';

    const nodes = [];
    const matrix = {};
    for (const c of allComps) matrix[c] = {};

    let onlineCount = 0;
    let badCount = 0;
    let observedCount = 0;

    // 列顺序：同步源（98）永远第一列，其余按配置里 nodes: 的书写顺序，不按 IP 排
    for (const n of [...this.nodes.values()].sort((a, b) => (
      a.role === b.role ? (a.order ?? 0) - (b.order ?? 0) : (a.role === 'source' ? -1 : 1)
    ))) {
      const online = !!(n.online && n.lastSeenAt && now - n.lastSeenAt <= this.graceOf(n));
      if (online) onlineCount++;
      else this.refreshDerived(n, now, false);

      const nodeComps = Object.keys(this.config?.nodes?.[n.ip]?.components || {});
      const specs = this.specsFor(n.ip);
      let running = 0;
      let stopped = 0;
      let bad = 0;

      for (const comp of allComps) {
        const obs = n.components[comp] || null;
        const declared = nodeComps.includes(comp);
        if (!declared && !obs) continue;

        const kind = this.kindOf(n, comp);
        const d = deriveComponent({ online, obs, now, kind });
        const prev = n.derived?.[comp];
        const since = prev && prev.state === d.state ? prev.since : now;
        n.derived[comp] = { state: d.state, detail: d.detail, since };

        observedCount++;
        if (d.state === 'running') running++;
        else if (d.state === 'stopped') stopped++;
        else if (['degraded', 'crashed', 'orphan'].includes(d.state)) { bad++; badCount++; }

        matrix[comp][shortId(n.id)] = {
          state: d.state,
          label: DERIVED_LABEL[d.state] || d.state,
          detail: d.detail,
          since,
          pid: obs?.pid ?? null,
          port: obs?.port ?? (this.config?.nodes?.[n.ip]?.components?.[comp]?.port ?? null),
          listening: obs?.listening ?? null,
          conn: obs?.conn ?? null,
          health: obs?.health ?? null,
          matchBy: obs?.matchBy ?? null,
          notes: obs?.notes ?? [],
          kind,
          localRoot: specs[comp]?.localRoot ?? null,
          updateMode: specs[comp]?.updateMode ?? null,
          start: specs[comp]?.start ?? null,
          startCwd: specs[comp]?.startCwd ?? null,
          restartOn: specs[comp]?.restartOn ?? null,
          startedAt: obs?.createdAt ?? null,
          observedAt: obs?.observedAt ?? null,
        };
      }

      const seenAgo = n.lastSeenAt ? Math.max(0, Math.round((now - n.lastSeenAt) / 1000)) : null;
      nodes.push({
        id: shortId(n.id),
        nodeId: n.id,
        ip: n.ip,
        role: n.role === 'source' ? '主节点 · 同步源' : '成员',
        online,
        local: !!n.local,
        hostname: n.hostname,
        uptime: fmtDuration(n.uptimeSec),
        uptimeSec: n.uptimeSec,
        lastReport: n.lastSeenAt ? hhmmss(n.lastSeenAt) : '—',
        lastSeenAgoSec: seenAgo,
        agentVersion: n.agentVersion,
        control: n.control || 'observe',
        controlLabel: { observe: '只读', stage: '可同步', full: '可启停' }[n.control] || '只读',
        configRevision: n.configRevision,
        note: online
          ? `${running} 运行 · ${bad} 异常 · ${stopped} 已停${n.agentVersion ? ` · agent ${n.agentVersion}` : ''}${
            n.control && n.control !== 'full' ? ` · ${n.control === 'stage' ? '可同步，不能启停' : '只读'}` : ''
          }`
          : (seenAgo === null ? '从未连上' : `控制面断开 ${fmtDuration(seenAgo)}`),
        tone: !online ? 'alert' : (bad ? 'warn' : ''),
      });
    }

    // 没有任何节点声明过的组件不占行（例如全局 enabled:false 的 aigenerate）
    for (const c of allComps) {
      if (!Object.keys(matrix[c] || {}).length) {
        delete matrix[c];
        delete kinds[c];
      }
    }

    return {
      ok: true,
      serverTime: now,
      protocol: 1,
      nodes,
      matrix,
      kinds,
      events: this.events.slice(0, 30),
      summary: {
        total: this.nodes.size,
        online: onlineCount,
        components: observedCount,
        bad: badCount,
        streams: this.streams.size,
      },
    };
  }
}

export { shortId };
