/* 成员上报 → 主节点判定
 *
 * 原则：成员只报「观测」，主节点算「结论」。
 * 这样改判定规则不用重发 agent（协议 §4.1）。
 *
 * 成员允许报的 state：running | starting | stopping | stopped | unknown
 * 主节点可能得出的 state：node-offline | unknown | stopped | crashed | orphan | degraded | running
 */

export const OFFLINE_MS = 45_000; // 控制面 45s 无消息 → 节点离线
export const STALE_MS = 90_000;   // 连接还在，但该组件 90s 没上报 → 观测过期

export const DERIVED_LABEL = {
  running: '运行中',
  degraded: '假活',
  orphan: '孤儿',
  crashed: '异常退出',
  stopped: '已停止',
  unknown: '未观测',
  'node-offline': '离线',
};

/**
 * @param {Object} p
 * @param {boolean} p.online   节点控制面是否在线
 * @param {object|null} p.obs  该组件最近一次观测（含 observedAt）
 * @param {number} p.now
 * @param {string} [p.kind]    service | asset
 */
export function deriveComponent({ online, obs, now, kind = 'service' }) {
  if (!online) return { state: 'node-offline', detail: '控制面连接已断开' };
  if (!obs) return { state: 'unknown', detail: '还没有收到观测' };

  const age = now - Number(obs.observedAt || 0);
  if (age > STALE_MS) return { state: 'unknown', detail: `观测已过期 ${Math.round(age / 1000)}s` };

  if (kind === 'asset') {
    if (obs.state === 'unknown') return { state: 'unknown', detail: obs.notes?.[0] || '目录不存在' };
    return { state: 'running', detail: '纯文件，无进程' };
  }

  if (obs.state === 'unknown') return { state: 'unknown', detail: obs.notes?.[0] || '无法观测' };

  if (obs.state === 'stopped') {
    if (obs.listening && obs.portOwner) {
      return { state: 'orphan', detail: `端口 ${obs.port} 被 ${obs.portOwner.name}(pid ${obs.portOwner.pid}) 占用` };
    }
    if (obs.listening) {
      return { state: 'orphan', detail: `端口 ${obs.port} 有人在监听，但不是配置里的那个进程` };
    }
    return { state: 'stopped', detail: obs.notes?.[0] || '进程不在' };
  }

  // running
  if (obs.health && obs.health.ok === false) {
    return { state: 'degraded', detail: obs.health.detail || '探活失败' };
  }
  if (obs.port !== null && obs.port !== undefined && obs.listening === false) {
    return { state: 'degraded', detail: `进程在，但端口 ${obs.port} 未监听` };
  }
  return { state: 'running', detail: obs.health?.detail || (obs.pid ? `pid ${obs.pid}` : '运行中') };
}
