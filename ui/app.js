/* ─────────────────────────────────────────────────────────────
   vcsNode UI · 静态原型
   只有界面与交互，没有后端。所有数据都是 mock。
   接真实接口时：把 MOCK 换成 fetch，渲染函数不用改。
   ───────────────────────────────────────────────────────────── */

'use strict';

/* ══════════════════ mock 数据 ══════════════════ */

let NODES = [
  { id: '98',  ip: '172.16.2.98',  role: '主节点 · 发布源', online: true,
    uptime: '6 天 4 小时', lastReport: '10:41:02', note: '本机 agent 兼管 8 个组件' },
  { id: '149', ip: '172.16.1.149', role: '成员', online: false,
    uptime: '—', lastReport: '10:36:51',
    note: '控制面连接已断开 4 分钟', tone: 'alert' },
  { id: '207', ip: '172.16.1.207', role: '成员', online: true,
    uptime: '3 天 11 小时', lastReport: '10:41:01', note: 'set-a 后端所在机' },
  { id: '145', ip: '172.16.1.145', role: '成员', online: true,
    uptime: '1 天 2 小时', lastReport: '10:40:58',
    note: '1 个组件假活：generateclient 未连上 207:3601', tone: 'warn' },
];

let COMPONENTS = [
  { id: 'web',            name: 'web',            kind: 'service' },
  { id: 'webapi',         name: 'webapi',         kind: 'service' },
  { id: 'generateclient', name: 'generateclient', kind: 'service' },
  { id: 'generatetool',   name: 'generatetool',   kind: 'service' },
  { id: 'workerhost',     name: 'workerhost',     kind: 'service' },
  { id: 'mcpserver',      name: 'mcpserver',      kind: 'service' },
  { id: 'shp_plants',     name: 'shp_plants',     kind: 'service' },
  { id: 'shp_buildings',  name: 'shp_buildings',  kind: 'service' },
  { id: 'tools',          name: 'tools',          kind: 'asset'   },
];

/* state: running | degraded | busy | crashed | orphan | stopped | offline */
let MATRIX = {
  web: {
    '98':  { state: 'running', port: 3333, pid: 6120 },
    '207': { state: 'running', port: 3071, pid: 4488 },
    '145': null,
    '149': { state: 'offline' },
  },
  webapi: {
    '98':  { state: 'running', port: 3601, pid: 8812 },
    '207': { state: 'running', port: 3601, pid: 7714 },
    '145': null,
    '149': { state: 'offline' },
  },
  generateclient: {
    '98':  { state: 'running', pid: 5521 },
    '207': null,
    '145': { state: 'degraded', pid: 3390 },
    '149': { state: 'offline' },
  },
  generatetool: {
    '98':  { state: 'running', pid: 5540 },
    '207': null,
    '145': { state: 'busy', pid: 3411, task: 'f3a2' },
    '149': { state: 'offline' },
  },
  /* workerhost = 98/149/145；mcpserver = 98/149/207 */
  workerhost: {
    '98':  { state: 'running', pid: 6180 },
    '207': null,
    '145': { state: 'running', pid: 3420 },
    '149': { state: 'offline' },
  },
  mcpserver: {
    '98':  { state: 'running', port: 7077, pid: 6192 },
    '207': { state: 'running', port: 7077, pid: 7801 },
    '145': null,
    '149': { state: 'offline' },
  },
  shp_plants: {
    '98':  { state: 'running', port: 4000, pid: 9004 },
    '207': null,
    '145': { state: 'stopped' },
    '149': { state: 'offline' },
  },
  shp_buildings: {
    '98':  { state: 'orphan', port: 4001 },
    '207': null,
    '145': { state: 'running', port: 4001, pid: 9055 },
    '149': { state: 'offline' },
  },
  tools: {
    '98':  { state: 'running', asset: true },
    '207': null,
    '145': { state: 'running', asset: true },
    '149': { state: 'offline' },
  },
};

/* 待发布文件数：renderPending() 会更新；总览摘要每 5s 重建一次，必须带上最新值 */
let PENDING_TOTAL = 94;

const STATE_LABEL = {
  running: '运行中', degraded: '假活', busy: '忙', crashed: '异常退出',
  orphan: '孤儿', stopped: '已停止', offline: '离线', 'node-offline': '离线',
  unknown: '未观测',
};

const QUEUE = [
  { title: '切换上线 webapi @ 207', sub: '等待 145 空闲（generatetool 正在生成 f3a2）', chip: 'busy', chipText: '排队中' },
  { title: '重启 generateclient @ 98', sub: '已下发 · 等待 ack · 12s', chip: 'running', chipText: '执行中' },
];

const EVENTS = [
  { t: '10:41:02', node: '98',  action: 'report',    detail: 'snapshot · 8 组件', result: 'ok',   ms: 12 },
  { t: '10:40:58', node: '145', action: 'report',    detail: 'snapshot · generateclient degraded', result: 'ok', ms: 9 },
  { t: '10:39:20', node: '98',  action: 'task stop', detail: 'webapi · 由 运维 发起', result: 'ok', ms: 2870 },
  { t: '10:38:55', node: '98',  action: 'probe',     detail: 'localRoot / sharedRoot / 端口', result: 'ok', ms: 412 },
  { t: '10:36:51', node: '149', action: 'disconnect',detail: '控制面连接断开', result: 'warn', ms: 0 },
  { t: '10:31:07', node: '145', action: 'nack',      detail: 'stop generatetool · busy', result: 'fail', ms: 3 },
  { t: '10:12:44', node: '98',  action: 'scan',      detail: 'vcs-20261026-01 · 94 文件', result: 'ok', ms: 6840 },
  { t: '09:58:12', node: '207', action: 'task start',detail: 'webapi', result: 'ok', ms: 1420 },
];

const PENDING_GROUPS = [
  {
    component: 'web', dir: 'D:\\SceneAutomationV3\\Web',
    files: [
      { a: 'M', path: 'src/views/Generation.vue',    hash: 'a41f9c22', size: '18.4 KB', when: '10:11' },
      { a: 'M', path: 'src/api/scene.ts',            hash: '7d0b31ee', size: '6.1 KB',  when: '10:11' },
      { a: 'M', path: 'src/stores/task.ts',          hash: '2c55a9f0', size: '3.8 KB',  when: '10:10' },
      { a: 'M', path: 'vite.config.ts',              hash: '91fe0d47', size: '1.2 KB',  when: '10:09' },
      { a: 'A', path: 'src/components/PreviewBlock.vue', hash: '5ab2c8d1', size: '9.7 KB', when: '10:08' },
    ],
  },
  {
    component: 'webapi', dir: 'D:\\SceneAutomationV3\\SceneAutoApply',
    files: [
      { a: 'M', path: 'Controllers/PreviewBlockController.cs', hash: 'e3d7019b', size: '14.2 KB', when: '10:11' },
      { a: 'M', path: 'Services/GenerationService.cs',         hash: 'b0c4e552', size: '31.8 KB', when: '10:10' },
      { a: 'M', path: 'Program.cs',                            hash: '1f8a33c7', size: '8.4 KB',  when: '10:07' },
      { a: 'A', path: 'Models/PreviewBlockSnapshot.cs',        hash: 'c7e21d4a', size: '2.1 KB',  when: '10:05' },
      { a: 'A', path: 'Models/PreviewBlockCollection.cs',      hash: 'aa19f0b8', size: '1.9 KB',  when: '10:05' },
      { a: 'D', path: 'Migrations/Old_Init.cs',                hash: '—',        size: '4.0 KB',  when: '10:04', del: true },
    ],
  },
  {
    component: 'generateclient', dir: 'D:\\SceneAutomationV3\\GenerateClient',
    files: [
      { a: 'M', path: 'Utils/ConfigHelper.cs', hash: '4b2d9e11', size: '3.3 KB', when: '09:55' },
      { a: 'M', path: 'Program.cs',            hash: '8e6f1a04', size: '12.7 KB', when: '09:55' },
    ],
  },
  {
    component: 'tools', dir: 'D:\\SceneAutomationV3\\Tools',
    files: [
      { a: 'M', path: 'AutomationUE5.3/Content/Python/auto_ce.py',        hash: 'd90c27ab', size: '22.5 KB', when: '09:48' },
      { a: 'M', path: 'SceneAutomationGeneration/CEScripts/startup.py',   hash: '33a7be65', size: '5.6 KB',  when: '09:47' },
      { a: 'D', path: 'AutomationUE5.3/Content/Python/legacy_export.py',  hash: '—',        size: '7.1 KB',  when: '09:46', del: true },
      { a: 'D', path: 'SceneAutomationGeneration/CEScripts/old_entry.py', hash: '—',        size: '2.2 KB',  when: '09:46', del: true },
    ],
  },
];

/**
 * 发布记录。每一版都带文件级明细的「形状」，详情抽屉直接渲染这些字段。
 * 真实数据将来由 GET /api/ui/releases（M2/M3 才有）返回，字段见 docs/protocol.md §8.2：
 *   id / state / createdAt / finishedAt / components
 *   files[]:   { action, component, path, sizeBytes, sourceMtime, detectedAt }
 *   landing[]: { node, at, ms, files, result, restarted[] }   // 各节点落地时间
 * 现在是演示数据：files 从 PENDING_GROUPS 按组件取，所以和待发布区是同一批文件。
 */
const RELEASES = [
  {
    id: 'vcs-20261026-01', when: '10:12', date: '10-26',
    at: '2026-10-26T10:12:03+08:00',
    comps: 'web · webapi · generateclient · tools',
    components: ['web', 'webapi', 'generateclient', 'tools'],
    sets: 'set-a / set-b / set-c', nodes: '98 149 207 145', state: 'draft',
  },
  {
    id: 'vcs-20261025-03', when: '昨天 18:40', date: '10-25',
    at: '2026-10-25T18:40:11+08:00', finishedAt: '2026-10-25T18:41:25+08:00',
    durationMs: 74200,
    comps: 'webapi · generateclient', components: ['webapi', 'generateclient'],
    sets: 'set-b / set-c', nodes: '98 149', state: 'live',
    landing: [
      { node: '98',  at: '2026-10-25T18:40:12+08:00', ms: 1180, files: 8, result: 'ok', restarted: ['webapi'] },
      { node: '149', at: '2026-10-25T18:41:05+08:00', ms: 1420, files: 8, result: 'ok', restarted: ['webapi'] },
    ],
  },
  {
    id: 'vcs-20261025-02', when: '昨天 15:02', date: '10-25',
    at: '2026-10-25T15:02:40+08:00', finishedAt: '2026-10-25T15:03:09+08:00',
    durationMs: 28600,
    comps: 'web', components: ['web'],
    sets: 'set-c', nodes: '149', state: 'rolledback',
    landing: [
      { node: '149', at: '2026-10-25T15:02:44+08:00', ms: 1310, files: 5, result: 'ok', restarted: [] },
    ],
    rolledBackAt: '2026-10-25T15:47:12+08:00',
  },
  {
    id: 'vcs-20261024-01', when: '10-24 11:20', date: '10-24',
    at: '2026-10-24T11:20:05+08:00', finishedAt: '2026-10-24T11:23:39+08:00',
    durationMs: 214000,
    comps: '全套', components: ['web', 'webapi', 'generateclient', 'generatetool', 'tools'],
    sets: '全部', nodes: '98 149 207 145', state: 'live',
    landing: [
      { node: '98',  at: '2026-10-24T11:20:07+08:00', ms: 1460, files: 17, result: 'ok', restarted: ['webapi', 'generateclient'] },
      { node: '149', at: '2026-10-24T11:21:30+08:00', ms: 1520, files: 17, result: 'ok', restarted: ['webapi', 'generateclient'] },
      { node: '207', at: '2026-10-24T11:22:41+08:00', ms: 1380, files: 11, result: 'ok', restarted: ['webapi'] },
      { node: '145', at: '2026-10-24T11:23:52+08:00', ms: 1290, files: 7,  result: 'ok', restarted: ['generateclient', 'generatetool'] },
    ],
  },
];

const RELEASE_LABEL = {
  draft: { text: '待发布', cls: 'stopped' },
  staging: { text: '预发布中', cls: 'busy' },
  ready: { text: '待切换', cls: 'degraded' },
  live: { text: '已上线', cls: 'running' },
  rolledback: { text: '已回退', cls: 'orphan' },
  failed: { text: '失败', cls: 'crashed' },
};

const CONFIG_ROWS = [
  { comp: 'web', ports: { '98': 3333, '207': 3071, '149': 3333 },
    roots: { '98': 'D:\\SceneAutomationV3\\Web', '207': null, '149': 'D:\\SceneAutomationV3\\Web' } },
  { comp: 'webapi', ports: { '98': 3601, '207': 3601, '149': 3601 },
    roots: { '98': 'D:\\SceneAutomationV3\\SceneAutoApply', '207': null, '149': 'D:\\SceneAutomationV3\\SceneAutoApply' } },
  { comp: 'generateclient', ports: { '98': 0, '145': 0, '149': 0 },
    roots: { '98': 'D:\\SceneAutomationV3\\GenerateClient', '145': 'D:\\SceneAutomationV3\\GenerateClient', '149': 'D:\\SceneAutomationV3\\GenerateClient' } },
  { comp: 'generatetool', ports: { '98': 0, '145': 0, '149': 0 },
    roots: { '98': 'D:\\SceneAutomationV3\\GenerateTool', '145': 'D:\\SceneAutomationV3\\GenerateTool', '149': 'D:\\SceneAutomationV3\\GenerateTool' } },
  { comp: 'tools', ports: {},
    roots: { '98': 'D:\\SceneAutomationV3\\Tools', '207': 'D:\\Digihail\\SceneAutoApply\\Tools',
             '145': 'D:\\SceneAutomationV3\\Tools', '149': 'D:\\SceneAutomationV3\\Tools' } },
  { comp: 'workerhost', ports: { '98': 0, '145': 0, '149': 0 },
    roots: { '98': 'D:\\SceneAutomationV3\\WorkerHost', '145': 'D:\\SceneAutomationV3\\WorkerHost',
             '149': 'D:\\SceneAutomationV3\\WorkerHost' } },
  { comp: 'mcpserver', ports: { '98': 7077, '207': 7077, '149': 7077 },
    roots: { '98': 'D:\\SceneAutomationV3\\McpServer', '207': null, '149': 'D:\\SceneAutomationV3\\McpServer' } },
];

const SHARED_ROOTS = {
  '98': 'D:\\SceneAutomationV3\\Tools',
  '207': '\\\\172.16.2.98\\Tools',
  '145': '\\\\172.16.2.98\\Tools',
  '149': '\\\\172.16.2.98\\Tools',
};

/* ══════════════════ 小工具 ══════════════════ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function chip(state, text) {
  return `<span class="chip ${state}">${text || STATE_LABEL[state] || state}</span>`;
}

function toast(html, ms = 3600) {
  const box = $('#toasts');
  const node = document.createElement('div');
  node.className = 'toast';
  node.innerHTML = html;
  box.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'all .2s';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ══════════════════ 顶栏 ══════════════════ */

function renderClusterSummary() {
  const online = NODES.filter(n => n.online).length;
  // 「已观测」只数真的看到过的格子：离线节点的格子是 node-offline，不算观测
  const comps = Object.values(MATRIX).flatMap(m => Object.values(m).filter(c => c && c.state !== 'node-offline'));
  const bad = comps.filter(c => ['degraded', 'crashed', 'orphan'].includes(c.state)).length;
  $('#clusterSummary').innerHTML = `
    <span>节点 <b>${online}/${NODES.length}</b> 在线</span>
    <span>组件 <b>${comps.length}</b> 已观测</span>
    <span>需处理 <b>${bad}</b></span>
    <span>待发布 <b id="summaryPending">${PENDING_TOTAL}</b> 个文件</span>`;
}

/* ══════════════════ 总览 ══════════════════ */

function renderNodeCards() {
  $('#nodeCards').innerHTML = NODES.map(n => {
    const mine = Object.entries(MATRIX)
      .map(([, m]) => m[n.id])
      .filter(Boolean);

    const up = mine.filter(c => ['running', 'busy'].includes(c.state)).length;
    const bad = mine.filter(c => ['degraded', 'crashed', 'orphan'].includes(c.state)).length;
    const stopped = mine.filter(c => c.state === 'stopped').length;

    return `
      <div class="node-card ${n.online ? '' : 'is-offline'}">
        <div class="node-top">
          ${chip(n.online ? 'running' : 'offline', n.online ? '在线' : '离线')}
          <span class="node-name">node-${n.id}</span>
          <span class="node-ip">${n.ip}</span>
        </div>
        <div class="node-stats">
          <div class="node-stat"><b>${up}</b><span>运行</span></div>
          <div class="node-stat"><b style="color:${bad ? 'var(--err)' : 'inherit'}">${bad}</b><span>异常</span></div>
          <div class="node-stat"><b>${stopped}</b><span>已停</span></div>
          <div class="node-stat"><b style="font-size:12px;font-weight:600">${n.uptime}</b><span>在线时长</span></div>
        </div>
        <div class="node-note ${n.tone || ''}">${n.note}</div>
      </div>`;
  }).join('');
}

function renderMatrix() {
  const head = `<thead><tr><th>组件</th>${
    NODES.map(n => `<th>${n.id}${n.online ? '' : ' · 离线'}</th>`).join('')
  }</tr></thead>`;

  const body = COMPONENTS.map(c => `
    <tr>
      <td><div class="comp-cell"><span>${c.name}</span><span class="kit">${c.kind}</span></div></td>
      ${NODES.map(n => {
        const cell = MATRIX[c.id][n.id];
        if (!cell) return `<td><span class="cell-none">—</span></td>`;
        const port = cell.port ? `<span class="port">:${cell.port}</span>` : '';
        const label = cell.state === 'busy' ? '忙' : STATE_LABEL[cell.state];
        return `<td>
          <button class="cell-btn" data-comp="${c.id}" data-node="${n.id}">
            <span class="dot ${cell.state}"></span>${label}${port}
          </button>
        </td>`;
      }).join('')}
    </tr>`).join('');

  $('#matrix').innerHTML = head + `<tbody>${body}</tbody>`;

  $('#stateLegend').innerHTML = ['running', 'degraded', 'orphan', 'crashed', 'stopped', 'offline']
    .map(s => `<span class="legend-item"><span class="dot ${s}"></span>${STATE_LABEL[s]}</span>`)
    .join('');
}

function renderQueue() {
  $('#queueList').innerHTML = QUEUE.map(q => `
    <li>
      ${chip(q.chip, q.chipText)}
      <div class="q-main">
        <div class="q-title">${q.title}</div>
        <div class="q-sub">${q.sub}</div>
      </div>
      <button class="btn tiny ghost" data-toast="已取消：${q.title}">取消</button>
    </li>`).join('');
}

function renderEventMini() {
  $('#eventMini').innerHTML = EVENTS.slice(0, 5).map(e => `
    <li>
      <time>${e.t}</time>
      <span class="e-text">${e.node} · ${e.action} · ${e.detail}</span>
      ${chip(e.result === 'ok' ? 'running' : e.result === 'warn' ? 'degraded' : 'crashed',
             e.result === 'ok' ? '成功' : e.result === 'warn' ? '警告' : '失败')}
    </li>`).join('');
}

/* ══════════════════ 组件详情抽屉 ══════════════════ */

let DRAWER_CTX = null;   // { comp, node, isLocal }
let arm = null;          // { key, timer, btn, orig } —— 停止/重启的两段式确认

/** 指令回来后把抽屉按最新数据重画（抽屉还开着、还是同一个组件/节点时才画） */
function redrawDrawer(ctx) {
  if (!DRAWER_CTX || DRAWER_CTX.comp !== ctx.comp || DRAWER_CTX.node !== ctx.node) return;
  if (!$('#drawer').classList.contains('open')) return;
  openDrawer(ctx.comp, ctx.node);
}

/**
 * 抽屉里的操作按钮。
 * 停止 / 重启要连点两下（第一下只是「上膛」）；启动是安全的，一下就发。
 */
async function runDrawerAction(act, btn) {
  const ctx = DRAWER_CTX;
  if (!ctx) return;
  const label = { start: '启动', stop: '停止', restart: '重启' }[act] || act;
  if (!['start', 'stop', 'restart'].includes(act)) return;

  if (ctx.isLocal) {
    toast('发布源由人工操作，控制面不下发指令', 5200);
    return;
  }

  const key = `${act}@${ctx.comp}@${ctx.node}`;
  const needsArm = act !== 'start';

  // 第一下只是「上膛」：避免误点就把 prod 的服务停了 / 重启了
  if (needsArm && (!arm || arm.key !== key)) {
    if (arm) {
      clearTimeout(arm.timer);
      if (arm.btn) { arm.btn.textContent = arm.orig; arm.btn.classList.remove('danger'); }
    }
    const orig = btn.textContent;
    btn.textContent = act === 'stop' ? '再点一次确认停止' : '再点一次确认重启';
    btn.classList.add('danger');
    const timer = setTimeout(() => {
      if (arm && arm.key === key) {
        btn.textContent = orig;
        btn.classList.remove('danger');
        arm = null;
      }
    }, 6000);
    arm = { key, timer, btn, orig };
    return;
  }
  if (needsArm) {
    clearTimeout(arm.timer);
    arm = null;
  }

  const prevText = btn.textContent;
  btn.disabled = true;
  btn.classList.remove('danger');
  btn.textContent = { start: '启动中…', stop: '停止中…', restart: '重启中…' }[act];

  try {
    const res = await fetch('/api/ui/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: ctx.node, component: ctx.comp, action: act }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);

    if (body.alreadyRunning) {
      toast(`<b>${cfgEsc(ctx.comp)}</b> @ ${ctx.node} 本来就在跑（pid ${body.pid ?? '—'}），没有重复启动`, 6000);
    } else {
      const bits = [
        `pid ${body.pid ?? '—'}`,
        `${body.durationMs ?? '?'}ms`,
        body.listening === true ? '端口在监听' : null,
        body.portFree === false ? '端口仍被占用' : (act === 'stop' && body.portFree === true ? '端口已释放' : null),
        act === 'restart' && body.wasRunning === false ? '原本没在跑' : null,
      ].filter(Boolean).join(' · ');
      toast(`已${label} <b>${cfgEsc(ctx.comp)}</b> @ ${ctx.node}（${bits}）`, 6000);
    }

    await loadNodes();
    redrawDrawer(ctx);
    // 兜底：成员的下一次采样可能还在路上，2.5s 后再刷一次，别停在中间态
    setTimeout(() => { loadNodes().then(() => redrawDrawer(ctx)).catch(() => {}); }, 2500);
  } catch (e) {
    toast(`${label} <b>${cfgEsc(ctx.comp)}</b> @ ${ctx.node} 失败：${cfgEsc(e.message)}`, 9000);
    // 抽屉可能已经被重画过，旧按钮可能已经不在文档里
    if (document.body.contains(btn)) {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }
}

function openDrawer(compId, nodeId) {
  const c = COMPONENTS.find(x => x.id === compId);
  const cell = MATRIX[compId][nodeId];
  const node = NODES.find(n => n.id === nodeId);
  if (!c || !cell) return;

  // 98 是发布源，只由人工启停；控制面不下发，按钮也就不给按
  const isLocal = !!(node?.local || (node?.role || '').includes('发布源'));

  $('#drawerTitle').textContent = `${c.name} @ node-${nodeId}`;
  $('#drawerSub').textContent = `${node.ip} · 状态由主节点判定（成员只上报观测值）`;

  const isAsset = c.kind === 'asset';
  const canStart = !isLocal && !isAsset && ['stopped', 'crashed', 'orphan'].includes(cell.state);
  const canStop  = !isLocal && !isAsset && ['running', 'busy', 'degraded', 'orphan'].includes(cell.state);

  const connRemote = cell.conn?.remote
    || (cell.health?.detail || '').match(/\d+\.\d+\.\d+\.\d+:\d+/)?.[0]
    || '—';
  const conn = cell.state === 'degraded'
    ? `<span class="conn-bad">未建立</span> · 期望 ${cfgEsc(connRemote)}`
    : c.kind === 'service' && ['running', 'busy'].includes(cell.state) && !cell.port
      ? `<span class="conn-ok">ESTABLISHED</span> · ${cfgEsc(connRemote)}`
      : cell.port ? `<span class="conn-${cell.listening === false ? 'bad' : 'ok'}">${cell.listening === false ? '未监听' : '监听中'}</span> · 0.0.0.0:${cell.port}` : '—';

  $('#drawerBody').innerHTML = `
    <div class="drawer-section">
      <h3>状态</h3>
      <dl class="kv">
        <dt>判定</dt><dd>${chip(cell.state, cell.state === 'busy' ? '忙（正在生成）' : STATE_LABEL[cell.state])}</dd>
        <dt>PID</dt><dd>${cell.pid || '—'}</dd>
        <dt>启动时间</dt><dd>${fmtStarted(cell.startedAt)}</dd>
        <dt>连接 / 端口</dt><dd>${conn}</dd>
        <dt>依据</dt><dd>${cfgEsc(cell.detail || '—')}${cell.matchBy ? ` <span class="muted small">(${cell.matchBy === 'port' ? '按端口认领' : '按命令行认领'})</span>` : ''}</dd>
        <dt>最近上报</dt><dd>${node.lastReport}</dd>
      </dl>
    </div>

    <div class="drawer-section">
      <h3>运行形态</h3>
      <dl class="kv">
        <dt>工作目录</dt><dd style="font-family:var(--mono);font-size:11.5px">${cfgEsc(cell.localRoot || '（未配置）')}</dd>
        <dt>启动方式</dt><dd>${isAsset ? '不启动（纯文件）' : `${cfgEsc(fmtStart(cell.start))}${
          cell.startCwd
            ? `<div class="muted small" style="font-family:var(--mono);font-size:11.5px;margin-top:2px">于 ${cfgEsc(cell.startCwd)}</div>`
            : ''
        }`}</dd>
        <dt>更新策略</dt><dd>${cfgEsc(fmtUpdateMode(cell))}</dd>
      </dl>
    </div>

    ${cell.state === 'degraded' ? `
    <div class="drawer-section">
      <h3>为什么是假活</h3>
      <p class="small" style="margin:0;color:var(--warn)">
        进程在，但探活没过：${cfgEsc(cell.detail || '—')}。
        常见原因：<code class="inline">appsettings.json</code> 的 SignalRUrl 被构建覆盖，或连错了后端。
      </p>
    </div>` : ''}

    ${cell.state === 'orphan' ? `
    <div class="drawer-section">
      <h3>孤儿端口</h3>
      <p class="small" style="margin:0;color:var(--orphan)">
        端口 ${cell.port} 有人在监听，但对不上受管进程。禁止自动重启，先确认占用者。
      </p>
    </div>` : ''}

    ${cell.state === 'unknown' ? `
    <div class="drawer-section">
      <h3>为什么不知道</h3>
      <p class="small" style="margin:0;color:var(--muted)">${cfgEsc(cell.detail || '还没有收到观测')}</p>
    </div>` : ''}

    <div class="drawer-section">
      <h3>操作</h3>
      <div class="drawer-actions">
        <button class="btn" ${canStart ? '' : 'disabled'} data-act="start">启动</button>
        <button class="btn" ${canStop ? '' : 'disabled'} data-act="stop">停止</button>
        <button class="btn" ${canStop ? '' : 'disabled'} data-act="restart">重启</button>
      </div>
      <p class="hint" style="padding:10px 0 0">${isLocal
        ? '发布源由人工操作，控制面不下发启停指令。'
        : isAsset
          ? '纯文件组件没有进程，停止/启动对它没有意义。'
          : '停止 / 重启要点两次确认；启动一下就发。服务输出见成员上的 logs\\<组件>.log。'}</p>
    </div>`;

  DRAWER_CTX = { comp: compId, node: nodeId, isLocal };
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('show');
  $('#drawer').setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  DRAWER_CTX = null;
  if (arm) { clearTimeout(arm.timer); arm = null; }
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('show');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

/* ══════════════════ 待发布区 ══════════════════ */

const SIZE_UNIT = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

function parseSize(text) {
  const m = String(text || '').match(/([\d.]+)\s*(B|KB|MB|GB)/i);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (SIZE_UNIT[m[2].toUpperCase()] || 1));
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const hhmmss = (iso) => {
  const m = String(iso || '').match(/T(\d{2}:\d{2}(?::\d{2})?)/);
  return m ? m[1] : '—';
};

const ymdhm = (iso) => (iso ? `${String(iso).slice(0, 10)} ${hhmmss(iso)}` : '—');

/** 把 mock 整理成和真实接口相同的形状，渲染只认一种结构 */
function mockView() {
  const groups = PENDING_GROUPS.map((g) => {
    const files = g.files.map((f) => ({
      action: f.a,
      path: f.path,
      sha256: f.hash === '—' ? '' : f.hash,
      sizeBytes: parseSize(f.size),
      mtime: `2026-10-26T${f.when}:00+08:00`,
      sel: f.a !== 'D',
    }));
    const counts = { A: 0, M: 0, D: 0 };
    for (const f of files) counts[f.action] += 1;
    return { component: g.component, root: g.dir, counts, files };
  });

  const stats = { tracked: 1284, unchanged: 0, added: 0, modified: 0, deleted: 0, bytes: 0 };
  for (const g of groups) {
    for (const f of g.files) {
      stats[({ A: 'added', M: 'modified', D: 'deleted' })[f.action]] += 1;
      if (f.action !== 'D') stats.bytes += f.sizeBytes;
    }
  }
  stats.unchanged = stats.tracked - stats.added - stats.modified;

  return {
    id: 'vcs-20261026-01',
    createdAt: '2026-10-26T10:12:44+08:00',
    baselineAt: '2026-10-25T18:40:12+08:00',
    sources: groups.map((g) => ({ component: g.component, root: g.root })),
    targets: {
      web: ['207', '149'],
      webapi: ['98', '207'],
      generateclient: ['98', '145', '149'],
      generatetool: ['98', '145', '149'],
      tools: ['98', '145', '149'],
      shp_plants: ['98', '145'],
      shp_buildings: ['98', '145'],
    },
    modes: {
      web: 'in-place',
      webapi: 'release-switch',
      generateclient: 'release-switch',
      generatetool: 'release-switch',
      tools: 'in-place',
      shp_plants: 'in-place',
      shp_buildings: 'in-place',
    },
    stats,
    groups,
    errors: [],
    warnings: [],
  };
}

function emptyView() {
  return {
    id: null,
    createdAt: null,
    baselineAt: null,
    sources: [],
    targets: {},
    modes: {},
    stats: { tracked: 0, unchanged: 0, added: 0, modified: 0, deleted: 0, bytes: 0 },
    groups: [],
    errors: [],
    warnings: [],
  };
}

let VIEW = mockView();
let DATA_MODE = 'mock'; // mock | live | empty

function adopt(payload) {
  VIEW = {
    ...payload,
    groups: (payload.groups || []).map((g) => ({
      ...g,
      files: (g.files || []).map((f) => ({ ...f, sel: f.action !== 'D' })),
    })),
  };
}

const changedGroups = () => VIEW.groups.filter((g) => g.files.length > 0);

function allChangedFiles() {
  return changedGroups().flatMap((g) => g.files.map((f) => ({ ...f, component: g.component })));
}

function renderScanMeta() {
  const v = VIEW;
  $('#scanBase').textContent = v.baselineAt ? ymdhm(v.baselineAt) : '未建立';
  $('#scanId').textContent = v.id || '—';
  $('#scanAt').textContent = v.createdAt ? ymdhm(v.createdAt) : '—';

  const srcs = v.sources || [];
  const el = $('#scanSrc');
  if (srcs.length === 0) el.textContent = '—';
  else if (srcs.length === 1) el.textContent = srcs[0].root;
  else el.textContent = `${srcs.length} 个源 · ${srcs[0].root}`;
  el.title = srcs.map((s) => `${s.component}  ${s.root}`).join('\n');
}

function renderNotice() {
  const box = $('#pendingNotice');
  const parts = [];

  if (DATA_MODE === 'mock') {
    parts.push(`<div class="notice info">演示数据：当前没有连上 master，下面的清单是假的。
      用 <code>node bin/master.mjs</code> 启动后从它给出的地址打开，再点「重新扫描」才是真实结果。</div>`);
  }
  if (DATA_MODE === 'empty') {
    parts.push(`<div class="notice info">这台机器还没有扫描过。第一次扫描会建立基线（把当前状态记为起点），
      不会一下冒出一堆「新增」。</div>`);
  }

  const errs = VIEW.errors || [];
  if (errs.length) {
    const first = errs[0];
    parts.push(`<div class="notice warn"><b>${errs.length} 个路径读取失败</b>　${first.path}：${first.message}${errs.length > 1 ? ' …' : ''}</div>`);
  }
  if (VIEW.stats && VIEW.stats.failed) {
    parts.push(`<div class="notice warn"><b>${VIEW.stats.failed} 个文件读取失败</b>（被占用或无权限），未计入清单。</div>`);
  }

  box.innerHTML = parts.join('');
  box.hidden = parts.length === 0;
}

function renderPending() {
  renderScanMeta();
  renderNotice();

  const groups = changedGroups();
  const total = groups.reduce((a, g) => a + g.files.length, 0);
  const navBadge = $('#navPendingBadge');
  if (navBadge) navBadge.textContent = String(total);
  const sumPending = $('#summaryPending');
  if (sumPending) sumPending.textContent = String(total);
  PENDING_TOTAL = total;

  $('#pendingEmpty').hidden = groups.length > 0;
  $('#filePanel').hidden = groups.length === 0;
  $('#btnCommit').disabled = true;

  $('#compChips').innerHTML = groups.map((g) => `
    <div class="comp-chip">
      <div class="cc-name">${g.component}</div>
      <div class="cc-nums">
        <i class="a">+${g.counts.A}</i> · <i class="m">~${g.counts.M}</i> · <i class="d">-${g.counts.D}</i>
      </div>
    </div>`).join('');

  $('#fileList').innerHTML = `<div class="frow-head">
      <span></span><span></span><span>路径</span><span>sha256</span><span>大小</span><span>修改</span><span>组件</span>
    </div>` + groups.map((g) => `
    <div class="group-row">
      <span class="caret">▾</span>
      <span>${g.component}</span>
      <span class="gpath" title="${g.root}">${g.root}</span>
      <span class="gright"><span class="muted small">${g.files.filter((f) => f.sel).length}/${g.files.length} 已选</span></span>
    </div>
    ${g.files.map((f, i) => `
      <div class="frow ${f.action === 'D' ? 'is-del' : ''} ${f.sel ? '' : 'dropped'}">
        <input type="checkbox" ${f.sel ? 'checked' : ''} data-g="${g.component}" data-i="${i}">
        <span class="action-badge ${f.action}">${f.action}</span>
        <span class="path" title="${f.path}">${f.path}</span>
        <span class="hash">${f.sha256 || '—'}</span>
        <span class="size">${f.action === 'D' ? '—' : fmtSize(f.sizeBytes)}</span>
        <span class="when">${f.mtime ? hhmmss(f.mtime) : '—'}</span>
        <span class="comp">${g.component}</span>
      </div>`).join('')}
  `).join('');

  refreshPendingState();
}

/** 勾选后重绘，但保留列表滚动位置（否则每点一下都跳回顶部） */
function rerenderKeepScroll() {
  const list = $('#fileList');
  const top = list ? list.scrollTop : 0;
  renderPending();
  if (list) list.scrollTop = top;
}

function refreshPendingState() {
  const all = allChangedFiles();
  const sel = all.filter((f) => f.sel);
  const dels = all.filter((f) => f.action === 'D');
  const delSel = dels.filter((f) => f.sel);

  $('#selCount').textContent = all.length ? `已选 ${sel.length} / ${all.length} 个文件` : '没有变更';
  $('#selCount').title = VIEW.stats ? `受管 ${VIEW.stats.tracked} 个文件，未变 ${VIEW.stats.unchanged} 个` : '';
  $('#selectAll').checked = all.length > 0 && sel.length === all.length;
  $('#delCount').textContent = String(dels.length);

  const ckDel = $('#ckDel');
  ckDel.disabled = dels.length === 0;
  if (dels.length === 0) ckDel.checked = false;

  const comps = [...new Set(sel.map((f) => f.component))];
  const targets = VIEW.targets || {};

  const nodes = [...new Set(comps.flatMap((c) => targets[c] || []))].sort();
  const bytes = sel.filter((f) => f.action !== 'D').reduce((a, f) => a + (f.sizeBytes || 0), 0);

  $('#impactKv').innerHTML = `
    <dt>目标节点</dt><dd>${nodes.join(' · ') || '—'}</dd>
    <dt>涉及组件</dt><dd>${comps.join(' · ') || '—'}</dd>
    <dt>落地方式</dt><dd>就地覆盖（先备份，再校验 sha256）</dd>
    <dt>传输量</dt><dd>${fmtSize(bytes)}</dd>
    <dt>删除项</dt><dd style="color:${delSel.length ? 'var(--err)' : 'inherit'}">${delSel.length} / ${dels.length}</dd>
    <dt>前置条件</dt><dd>组件已停止（运行中会被拒绝）</dd>`;

  const ok = $('#ckDb').checked && (dels.length === 0 || ckDel.checked) && sel.length > 0;
  $('#btnStage').disabled = !ok;
}

/* ── 取数：有 master 就用真实清单，没有就退回 mock ── */

function setDataMode() {
  const el = $('#dataMode');
  const map = {
    live: ['实时数据', 'live'],
    empty: ['未扫描', 'empty'],
    mock: ['演示数据', 'mock'],
  };
  const [text, cls] = map[DATA_MODE] || map.mock;
  el.textContent = text;
  el.className = `proto-badge ${cls}`;
}

async function loadPending() {
  try {
    const res = await fetch('/api/ui/pending', { cache: 'no-store' });
    if (res.status === 404) {
      // master 返回 JSON 的 404 = 真的没扫过；静态服务器返回的 404 = 根本没有接口
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('没有 API');
      DATA_MODE = 'empty';
      VIEW = emptyView();
    } else if (res.ok) {
      adopt(await res.json());
      DATA_MODE = 'live';
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch {
    DATA_MODE = 'mock';
    VIEW = mockView();
  }
  setDataMode();
  renderPending();
}

/* ── 取数：节点实时状态（/api/ui/nodes） ──────────────── */

let NODES_LIVE = false;
let NODES_BADGE = 'mock';

function setNodeMode(mode) {
  NODES_BADGE = mode;
  const el = $('#nodeMode');
  if (!el) return;
  const map = {
    live: ['节点数据 · 实时', 'live'],
    stale: ['节点数据 · 已断开', 'empty'],
    mock: ['节点数据 · 演示', 'mock'],
  };
  const [text, cls] = map[mode] || map.mock;
  el.textContent = text;
  el.className = `proto-badge ${cls}`;
}

function fmtStarted(iso) {
  if (!iso) return '—';
  const s = String(iso);
  const d = s.slice(5, 10);
  const t = s.slice(11, 19);
  return d && t ? `${d} ${t}` : s;
}

function fmtStart(start) {
  if (!start || !start.cmd) return '—';
  const args = Array.isArray(start.args) ? start.args : [];
  return [start.cmd, ...args].join(' ');
}

function fmtUpdateMode(cell) {
  const mode = cell.updateMode || 'in-place';
  const suffix = mode === 'release-switch' ? '切换 junction 后重启' : '直接写原目录';
  // restartOn 语义：没配 = 任何改动都要重启；配空数组 = 从不重启；配了列表 = 命中才重启
  const on = Array.isArray(cell.restartOn) ? cell.restartOn : null;
  let restart;
  if (cell.kind === 'asset') restart = '不重启';
  else if (!on) restart = '任何改动后重启';
  else if (!on.length) restart = '不重启';
  else restart = `改 ${on.join('/')} 后重启`;
  return `${mode}（${suffix}，${restart}）`;
}

function applyNodes(payload) {
  const list = Array.isArray(payload?.nodes) ? payload.nodes : [];
  if (!list.length) throw new Error('节点列表为空');

  NODES = list.map((n) => ({
    id: n.id,
    ip: n.ip,
    role: n.role || '成员',
    local: !!n.local,
    online: !!n.online,
    uptime: n.uptime || '—',
    lastReport: n.lastReport || '—',
    note: n.note || '',
    tone: n.tone || '',
  }));

  const matrix = {};
  for (const [comp, per] of Object.entries(payload.matrix || {})) matrix[comp] = per || {};
  MATRIX = matrix;

  COMPONENTS = Object.keys(matrix).map((id) => ({
    id,
    name: id,
    kind: (payload.kinds && payload.kinds[id]) || 'service',
  }));

  if (Array.isArray(payload.events) && payload.events.length) {
    EVENTS.splice(0, EVENTS.length, ...payload.events);
  }

  NODES_LIVE = true;
  setNodeMode('live');
}

function renderOverview() {
  renderClusterSummary();
  renderNodeCards();
  renderMatrix();
}

async function loadNodes() {
  try {
    const res = await fetch('/api/ui/nodes', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) throw new Error('没有 API');
    applyNodes(await res.json());
    renderOverview();
    renderEventMini();
    if ($('#view-events')?.classList.contains('active')) {
      renderEvents($('#eventFilter')?.value || '');
    }
  } catch (e) {
    // 已经是实时数据的话，保留最后一屏，只把徽标改成「已断开」
    setNodeMode(NODES_LIVE ? 'stale' : 'mock');
  }
}

async function runScan() {
  const btn = $('#btnRescan');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '扫描中…';

  try {
    const res = await fetch('/api/ui/scan', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    if (body.baselineCreated) {
      toast(`已建立基线：<b>${body.files}</b> 个文件。从现在起扫描显示相对它的改动。`, 6000);
    } else {
      const s = body.stats || {};
      const n = (s.added || 0) + (s.modified || 0) + (s.deleted || 0);
      toast(`扫描完成：变更 <b>${n}</b> 个文件（+${s.added || 0} ~${s.modified || 0} -${s.deleted || 0}），耗时 ${body.ms} ms`, 6000);
    }
    await loadPending();
  } catch (e) {
    toast(`扫描失败：${e.message}`, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ── 预发布（M2：把勾选的文件覆盖到成员） ──────────────── */

function stageSelected() {
  const sel = allChangedFiles().filter((f) => f.sel);
  if (!sel.length) return;
  if (DATA_MODE !== 'live') {
    toast('没有连上 master，不能发布：先启动主节点再打开这个地址', 6000);
    return;
  }

  const comps = [...new Set(sel.map((f) => f.component))];
  const paths = {};
  sel.forEach((f) => { (paths[f.component] = paths[f.component] || []).push(f.path); });
  const dels = sel.filter((f) => f.action === 'D').length;
  const bytes = sel.filter((f) => f.action !== 'D').reduce((a, f) => a + (f.sizeBytes || 0), 0);
  const targets = [...new Set(comps.flatMap((c) => (VIEW.targets || {})[c] || []))].sort();

  openModal({
    title: `更新文件 · ${sel.length} 个`,
    body: `
      <dl class="kv" style="margin:0 0 12px">
        <dt>组件</dt><dd>${cfgEsc(comps.join(' · '))}</dd>
        <dt>文件</dt><dd>${sel.length} 个${dels ? `（含 ${dels} 个删除）` : ''} · ${fmtSize(bytes)}</dd>
        <dt>目标节点</dt><dd class="mono">${targets.join(' ') || '—'}</dd>
      </dl>
      <p class="muted small" style="margin:0">
        只传这些文件，不整目录覆盖。成员会先校验 sha256，再把旧文件备份到
        <code class="inline">backup\\&lt;relId&gt;\\</code> 后写入；任何一台失败，这批文件就留在待发布区，可以重发。
        还在运行的组件会被拒绝 —— 先在抽屉里停止。
      </p>`,
    confirmText: '开始更新',
    onConfirm: () => doStage({ comps, paths, includeDeletes: dels > 0, count: sel.length }),
  });
}

async function doStage({ comps, paths, includeDeletes, count }) {
  const btn = $('#btnStage');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '更新中…';
  toast(`正在打包 <b>${count}</b> 个文件到共享，然后等成员落地…`, 8000);
  try {
    const res = await fetch('/api/ui/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components: comps, paths, includeDeletes }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    const nodes = Object.entries(body.nodes || {});

    // 200 但 ok=false：指令发出去了，有节点没落地。文件仍留在待发布区，可以重发。
    if (!body.ok) {
      const bad = nodes.filter(([, v]) => !v.ok).map(([k, v]) => `${k}：${v.error || '失败'}`);
      toast(`更新没完全成功 —— ${cfgEsc(bad.join('；'))}。这批文件还在待发布区，修好后重发。`, 14000);
      await loadPending();
      await loadReleases();
      return;
    }

    toast(`更新完成：<b>${body.stats.files}</b> 个文件 · ${fmtSize(body.stats.bytes)} · ` +
      `${nodes.filter(([, v]) => v.ok).length}/${nodes.length} 台已落地（${(body.durationMs / 1000).toFixed(1)}s），可以启动了`,
      9000);
    if (Array.isArray(body.warnings) && body.warnings.length) {
      toast(`注意：${cfgEsc(body.warnings.join('；'))}`, 10000);
    }
    await loadPending();
    await loadReleases();
  } catch (e) {
    toast(`更新失败：${cfgEsc(e.message)}`, 12000);
  } finally {
    btn.textContent = label;
    refreshPendingState();     // 重新按勾选/确认项算一次可用状态，别把按钮一直锁着
  }
}

/* ══════════════════ 发布记录 ══════════════════ */

const RELEASE_STATE = {
  landed: { text: '已落地', cls: 'ok' },
  partial: { text: '部分失败', cls: 'warn' },
  failed: { text: '失败', cls: 'err' },
};

let RELEASES_LIVE = null;   // null = 没有 API（退回演示数据），[] = 真的还没有发布过

async function loadReleases() {
  try {
    const res = await fetch('/api/ui/releases', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    RELEASES_LIVE = Array.isArray(j.items) ? j.items : [];
  } catch {
    RELEASES_LIVE = null;
  }
  renderReleases();
}

function renderReleasesLive() {
  const items = RELEASES_LIVE || [];
  if (!items.length) {
    $('#releaseTable').innerHTML = `
      <thead><tr><th>版本</th><th>时间</th><th>组件</th><th>节点</th><th>状态</th><th></th></tr></thead>
      <tbody><tr><td colspan="6"><p class="muted small" style="margin:18px 0">
        还没有发布记录。去「待发布区」勾选文件 → 预发布，全部落地成功后这里会多一条。
      </p></td></tr></tbody>`;
    return;
  }
  $('#releaseTable').innerHTML = `
    <thead><tr>
      <th>版本</th><th>时间</th><th>组件</th><th>节点</th><th>状态</th><th></th>
    </tr></thead>
    <tbody>${items.map((r) => {
      const st = RELEASE_STATE[r.status] || { text: r.status || '未知', cls: 'warn' };
      const nodes = Object.entries(r.nodes || {});
      const okN = nodes.filter(([, v]) => v.ok).length;
      return `<tr>
        <td class="mono">${cfgEsc(r.relId)}</td>
        <td>${ymdhms(r.createdAt)}</td>
        <td>${cfgEsc((r.components || []).join(' · '))}</td>
        <td class="mono">${nodes.map(([k]) => cfgEsc(k)).join(' ')}</td>
        <td>${chip(st.cls, `${st.text} ${okN}/${nodes.length}`)}</td>
        <td><button class="btn tiny ghost" data-release="${cfgEsc(r.relId)}">详情</button></td>
      </tr>`;
    }).join('')}</tbody>`;
}

function renderReleases() {
  if (RELEASES_LIVE) { renderReleasesLive(); return; }

  $('#releaseTable').innerHTML = `
    <thead><tr>
      <th>版本</th><th>时间</th><th>组件</th><th>set</th><th>节点</th><th>状态</th><th></th>
    </tr></thead>
    <tbody>${RELEASES.map(r => {
      const l = RELEASE_LABEL[r.state];
      return `<tr>
        <td class="mono">${r.id}</td>
        <td>${r.when}</td>
        <td>${r.comps}</td>
        <td><span class="set-tag">${r.sets}</span></td>
        <td class="mono">${r.nodes}</td>
        <td>${chip(l.cls, l.text)}</td>
        <td>
          <button class="btn tiny ghost" data-release="${r.id}">详情</button>
          ${r.state === 'live' ? `<button class="btn tiny ghost" data-rollback="${r.id}">回退</button>` : ''}
        </td>
      </tr>`;
    }).join('')}</tbody>`;
}

/* ── 详情抽屉：这一版更新了哪些文件、各节点分别在什么时间落地 ── */

const fmtDurMs = (ms) => {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n} ms`;
  const s = Math.round(n / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`;
};

const ymdhms = (iso) => (iso ? `${String(iso).slice(0, 10)} ${hhmmss(iso)}` : '—');

/** 只显示非零的那几项：+2 ~1，而不是 +2 ~1 -0 */
function countLine(c = {}) {
  const parts = [];
  if (c.A) parts.push(`+${c.A}`);
  if (c.M) parts.push(`~${c.M}`);
  if (c.D) parts.push(`-${c.D}`);
  return parts.join(' ') || '无改动';
}

/** 这一版的文件明细。演示数据直接从待发布区取同一批文件，保证两边对得上 */
function releaseFiles(r) {
  const comps = r.components || [];
  const out = [];
  for (const g of PENDING_GROUPS) {
    if (!comps.includes(g.component)) continue;
    for (const f of g.files) {
      out.push({
        action: f.a,
        component: g.component,
        path: f.path,
        sizeBytes: parseSize(f.size),
        mtime: `${r.date} ${f.when}`,
      });
    }
  }
  return out;
}

/** 这个文件实际会落到哪几台：发布时的节点 ∩ 当前部署了该组件的节点 */
function landingTextFor(r, comp) {
  if (!r.landing) return '待发布';
  const hit = r.landing.filter((l) => MATRIX[comp] && MATRIX[comp][l.node]);
  const nodes = hit.length ? hit : r.landing;
  const times = nodes.map((l) => hhmmss(l.at)).sort();
  return times[0] === times[times.length - 1]
    ? `落地 ${times[0]}`
    : `落地 ${times[0]} → ${times[times.length - 1]}`;
}

/** 发布记录详情：真实数据来自 GET /api/ui/releases/<relId> */
async function openReleaseDrawer(id) {
  if (!RELEASES_LIVE) { openReleaseDrawerMock(id); return; }
  try {
    const res = await fetch(`/api/ui/releases/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    openReleaseDrawerReal(await res.json());
  } catch (e) {
    toast(`读取发布记录失败：${cfgEsc(e.message)}`, 8000);
  }
}

function openReleaseDrawerReal(d) {
  const st = RELEASE_STATE[d.status] || { text: d.status || '未知', cls: 'warn' };
  const nodes = Object.entries(d.nodes || {});
  const times = nodes.map(([, v]) => v.landedAt).filter(Boolean).sort();
  const first = times[0] || null;
  const last = times[times.length - 1] || null;
  const counts = d.counts || { A: 0, M: 0, D: 0 };
  const files = d.files || [];
  const deletes = d.deletes || [];

  const overview = `
    <div class="drawer-section">
      <h3>本次更新</h3>
      <dl class="kv">
        <dt>发布包</dt><dd class="mono">${cfgEsc(d.relId)}</dd>
        <dt>状态</dt><dd>${chip(st.cls, st.text)}</dd>
        <dt>文件</dt><dd>${files.length} 个 <span class="muted small">${countLine(counts)}</span></dd>
        <dt>合计</dt><dd>${fmtSize(d.bytes || 0)}</dd>
        <dt>组件</dt><dd>${cfgEsc((d.components || []).join(' · '))}</dd>
        <dt>发起</dt><dd>${ymdhms(d.createdAt)}${d.durationMs ? ` · 用时 ${fmtDurMs(d.durationMs)}` : ''}</dd>
        ${d.by ? `<dt>由</dt><dd class="mono">${cfgEsc(d.by)}</dd>` : ''}
        ${d.note ? `<dt>备注</dt><dd>${cfgEsc(d.note)}</dd>` : ''}
      </dl>
    </div>`;

  const landing = `
    <div class="drawer-section">
      <h3>各节点落地</h3>
      ${nodes.length ? nodes.map(([id, v]) => `
        <div class="landing-row">
          <b class="mono">${cfgEsc(id)}</b>
          <span class="mono">${v.landedAt ? ymdhms(v.landedAt).slice(11) : '—'}</span>
          <span class="muted">${v.ok ? '✔' : '✘'} ${v.landed || 0} 个文件${
            v.deleted ? ` · 删 ${v.deleted}` : ''} · ${fmtSize(v.bytes || 0)} · ${fmtDurMs(v.ms || 0)}${
            v.error ? ` · ${cfgEsc(v.error)}` : ''}</span>
        </div>`).join('') : '<p class="muted small">没有节点记录。</p>'}
    </div>`;

  const list = `
    <div class="drawer-section">
      <h3>文件明细（${files.length + deletes.length}）</h3>
      ${[...files, ...deletes.map((x) => ({ ...x, action: 'D' }))].map((f) => `
        <div class="rfile ${f.action === 'D' ? 'is-del' : ''}">
          <span class="action-badge ${f.action}">${f.action}</span>
          <span class="path" title="${cfgEsc(f.component)}/${cfgEsc(f.path)}">${cfgEsc(f.path)}</span>
          <span class="size">${f.action === 'D' ? '—' : fmtSize(f.size)}</span>
          <span class="meta">${cfgEsc(f.component)} · 98 改于 ${ymdhms(f.sourceMtime)} · 落地 ${
            first ? `${first.slice(11, 19)}${last && last !== first ? ` → ${last.slice(11, 19)}` : ''}` : '—'}</span>
        </div>`).join('') || '<p class="muted small">这一版没有文件。</p>'}
    </div>`;

  const foot = `
    <div class="drawer-section">
      <p class="muted small">三个时间点别混：<b>98 改于</b> = 源文件在 98 上的最后修改时间；
        <b>落地</b> = 各节点写盘完成的时间（最早 → 最晚）；<b>发起</b> = 这次更新开始的时间。
        数据来自发布包 manifest 与各节点的回执，不是事后重新扫描猜的。</p>
      ${d.dir ? `<p class="muted small mono">共享：${cfgEsc(d.dir)}</p>` : ''}
      <p class="muted small">被覆盖 / 删除的旧文件在成员本地备份：<code class="inline">backup\\${cfgEsc(d.relId)}\\</code>。</p>
    </div>`;

  $('#drawerTitle').textContent = d.relId;
  $('#drawerSub').textContent = `${st.text} · ${(d.components || []).join(' · ')}`;
  $('#drawerBody').innerHTML = overview + landing + list + foot;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}

function openReleaseDrawerMock(id) {
  const r = RELEASES.find((x) => x.id === id);
  if (!r) return;

  const files = releaseFiles(r);
  const count = { A: 0, M: 0, D: 0 };
  for (const f of files) count[f.action] += 1;
  const bytes = files.reduce((a, f) => a + (f.action === 'D' ? 0 : f.sizeBytes), 0);

  const overview = `
    <div class="drawer-section">
      <h3>本次更新</h3>
      <dl class="kv">
        <dt>文件</dt><dd>${files.length} 个 <span class="muted small">+${count.A} ~${count.M} -${count.D}</span></dd>
        <dt>合计</dt><dd>${fmtSize(bytes)}</dd>
        <dt>组件</dt><dd>${cfgEsc(r.comps)}</dd>
        <dt>set</dt><dd><span class="set-tag">${cfgEsc(r.sets)}</span></dd>
        <dt>发起</dt><dd>${ymdhms(r.at)}${r.durationMs ? ` · 用时 ${fmtDurMs(r.durationMs)}` : ''}</dd>
        ${r.rolledBackAt ? `<dt>回退</dt><dd>${ymdhms(r.rolledBackAt)}</dd>` : ''}
      </dl>
    </div>`;

  const landing = r.landing ? `
    <div class="drawer-section">
      <h3>各节点落地</h3>
      ${r.landing.map((l) => `
        <div class="landing-row">
          <b class="mono">${l.node}</b>
          <span class="mono">${hhmmss(l.at)}</span>
          <span class="muted">${l.files} 个文件 · ${(l.ms / 1000).toFixed(1)}s${
            l.restarted && l.restarted.length ? ` · 重启 ${l.restarted.join('、')}` : ' · 无需重启'
          }</span>
        </div>`).join('')}
    </div>` : `
    <div class="drawer-section">
      <h3>各节点落地</h3>
      <p class="muted small">这一版还在待发布区，没有任何节点动过文件。切换上线后，这里会逐台显示落地时间与耗时。</p>
    </div>`;

  const list = `
    <div class="drawer-section">
      <h3>文件明细（${files.length}）</h3>
      ${files.length ? files.map((f) => `
        <div class="rfile ${f.action === 'D' ? 'is-del' : ''}">
          <span class="action-badge ${f.action}">${f.action}</span>
          <span class="path" title="${cfgEsc(f.component)}/${cfgEsc(f.path)}">${cfgEsc(f.path)}</span>
          <span class="size">${f.action === 'D' ? '—' : fmtSize(f.sizeBytes)}</span>
          <span class="meta">${cfgEsc(f.component)} · 98 改于 ${f.mtime} · ${landingTextFor(r, f.component)}</span>
        </div>`).join('') : '<p class="muted small">这一版没有文件变动。</p>'}
    </div>`;

  const foot = `
    <div class="drawer-section">
      <p class="muted small">三个时间点别混：<b>98 改于</b> = 源文件在 98 上的最后修改时间；
        <b>落地</b> = 各节点写盘完成的时间（取最早 → 最晚）；<b>发起</b> = 这次发布开始的时间。
        记录来自发布 manifest，不是事后重新扫描猜出来的。</p>
      <p class="muted small">当前为演示数据。M2/M3 打通发布后，同一位置直接渲染真实 manifest。</p>
    </div>`;

  $('#drawerTitle').textContent = r.id;
  $('#drawerSub').textContent = `${RELEASE_LABEL[r.state].text} · ${r.comps}`;
  $('#drawerBody').innerHTML = overview + landing + list + foot;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}

/* ══════════════════ 配置 ══════════════════ */

let CFG = null;                 // 服务端视图；null = 没有 API，退回演示数据
const CFG_EDITS = new Map();    // `${ip}|${comp}|${field}` → { ip, component, field, value }

const FIELD_LABEL = { localRoot: '部署目录', port: '端口', enabled: '启用', sharedRoot: '共享目录' };

const cfgEsc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cfgKey = (ip, comp, field) => `${ip}|${comp || ''}|${field}`;

const fmtCfgVal = (v) => (v === null || v === undefined || v === '' ? '（空）' : String(v));

function cfgNodeOf(ip) {
  return CFG ? CFG.nodes.find((n) => n.ip === ip) : null;
}

function cfgOriginal(ip, comp, field) {
  const node = cfgNodeOf(ip);
  if (!node) return undefined;
  if (!comp) return field === 'sharedRoot' ? node.sharedRoot : undefined;
  const c = node.components.find((x) => x.name === comp);
  return c ? c[field] : undefined;
}

function cfgCurrent(ip, comp, field) {
  const k = cfgKey(ip, comp, field);
  return CFG_EDITS.has(k) ? CFG_EDITS.get(k).value : cfgOriginal(ip, comp, field);
}

function cfgSet(ip, comp, field, value) {
  const k = cfgKey(ip, comp, field);
  if (value === cfgOriginal(ip, comp, field)) CFG_EDITS.delete(k);
  else CFG_EDITS.set(k, { ip, component: comp || null, field, value });
  renderCfgDirty();
}

function renderCfgDirty() {
  const n = CFG_EDITS.size;
  const dirty = $('#cfgDirty');
  if (dirty) dirty.textContent = n ? `${n} 处未保存` : '';
  const save = $('#btnSaveConfig');
  if (save) save.disabled = n === 0;
  const undo = $('#btnCfgUndo');
  if (undo) undo.hidden = n === 0;
}

function cfgMeta(name) {
  const c = CFG.nodes.flatMap((n) => n.components).find((x) => x.name === name);
  if (!c) return '';
  return `<div class="muted small" style="margin-top:2px">${cfgEsc(c.kind)} · ${c.updateMode === 'release-switch' ? '切指针' : '就地覆盖'}</div>`;
}

function cfgCell(node, comp) {
  const root = cfgCurrent(node.ip, comp.name, 'localRoot');
  const port = cfgCurrent(node.ip, comp.name, 'port');
  const enabled = cfgCurrent(node.ip, comp.name, 'enabled');
  // 没有部署目录时组件根本不成立，开关保持禁用且不显示为「已启用」
  const switchOn = !!root && !!enabled;

  return `<td>
    <div class="cfg-cell">
      <div class="cfg-line">
        <label class="switch" title="${root ? '启用 / 停用该组件' : '先填部署目录，启用才有意义'}">
          <input type="checkbox" data-cfg data-type="bool" data-ip="${node.ip}" data-comp="${comp.name}" data-field="enabled"
                 ${switchOn ? 'checked' : ''} ${root ? '' : 'disabled'}>
          <span></span>
        </label>
        ${port === null || port === undefined
          ? '<span class="muted small">无端口</span>'
          : `<input class="cfg-port" data-cfg data-type="number" data-ip="${node.ip}" data-comp="${comp.name}" data-field="port" value="${cfgEsc(port)}">`}
      </div>
      <input class="cfg-input" data-cfg data-type="string" data-ip="${node.ip}" data-comp="${comp.name}" data-field="localRoot"
             value="${cfgEsc(root || '')}" placeholder="未填 · 该组件不会启用"
             style="${root ? '' : 'border-color:#f0b9b9;background:#fffafa'}">
      ${root ? '' : '<span class="cfg-null">localRoot 未确认，该组件不会被启用</span>'}
    </div>
  </td>`;
}

function renderConfig() {
  if (!CFG) {
    renderMockConfig();
    return;
  }

  const nodes = CFG.nodes;
  const comps = CFG.componentNames.filter((name) => nodes.some((n) => n.components.some((c) => c.name === name)));

  const head = `<thead><tr><th>组件</th>${nodes.map((n) => `
    <th>${cfgEsc(n.id)}<div class="th-sub">${n.role === 'source' ? '源 · 只读' : '目标'}${n.env ? ` · ${cfgEsc(n.env)}` : ''}</div></th>`).join('')}</tr></thead>`;

  const body = comps.map((name) => `
    <tr>
      <td><b style="font-size:12.5px">${name}</b>${cfgMeta(name)}</td>
      ${nodes.map((n) => {
        const c = n.components.find((x) => x.name === name);
        return c ? cfgCell(n, c) : '<td><div class="cfg-cell off">未部署</div></td>';
      }).join('')}
    </tr>`).join('');

  const shared = `<tr>
      <td title="成员从这里只读地拉取 _vcs\\releases 下的版本，再拷到本地 localRoot；共享目录本身不是服务运行目录">
        <b style="font-size:12.5px">共享目录</b>
        <div class="muted small" style="margin-top:2px">传输通道 · 不是部署路径</div>
      </td>
      ${nodes.map((n) => {
        const edited = CFG_EDITS.has(cfgKey(n.ip, null, 'sharedRoot'));
        return `<td>
          <input class="cfg-input" data-cfg data-type="string" data-ip="${n.ip}" data-comp="" data-field="sharedRoot"
                 value="${cfgEsc(cfgCurrent(n.ip, null, 'sharedRoot') || '')}">
          ${n.sharedRootInherited && !edited ? '<span class="cfg-null" style="color:var(--muted)">继承全局</span>' : ''}
        </td>`;
      }).join('')}
    </tr>`;

  $('#configTable').innerHTML = head + `<tbody>${body}${shared}</tbody>`;

  const banner = $('#driftBanner');
  if (banner) {
    banner.hidden = false;
    banner.className = 'drift-banner info';
    $('#driftText').innerHTML = `配置版本 <b>rev ${CFG.revision}</b>${
      CFG.updatedAt ? ` · 最后保存 ${cfgEsc(CFG.updatedAt.replace('T', ' ').slice(0, 19))}` : ' · 还没通过界面保存过'
    }。成员尚未接入控制面，保存只写主节点配置文件。`;
  }

  const hint = $('#cfgHint');
  if (hint) {
    hint.innerHTML = '保存只改主节点的 <code>config/vcsnode.yaml</code>，且只改对应的那几行，注释保持原样。'
      + '写入前会把新文本重新解析并逐字段比对，校验不过就放弃保存，原文件不动；每次保存前的版本留在 <code>config/backup/</code>。';
  }

  renderCfgDirty();
}

/** 没有 API 时的静态演示表（与之前一致，只是不能保存） */
function renderMockConfig() {
  const head = `<thead><tr><th>组件</th>${NODES.map(n => `<th>${n.id}</th>`).join('')}</tr></thead>`;

  const body = CONFIG_ROWS.map(row => `
    <tr>
      <td><b style="font-size:12.5px">${row.comp}</b></td>
      ${NODES.map(n => {
        const root = row.roots[n.id];
        if (root === undefined) return `<td><div class="cfg-cell off">未部署</div></td>`;
        const port = row.ports[n.id];
        const isNull = root === null;
        return `<td>
          <div class="cfg-cell">
            <div class="cfg-line">
              <label class="switch"><input type="checkbox" ${isNull ? '' : 'checked'}><span></span></label>
              ${port !== undefined && port > 0 ? `<input class="cfg-port" value="${port}">` : '<span class="muted small">无端口</span>'}
            </div>
            <input class="cfg-input" value="${isNull ? '' : root}" placeholder="${isNull ? '未知 · 待探测填充' : ''}"
                   style="${isNull ? 'border-color:#f0b9b9;background:#fffafa' : ''}">
            ${isNull ? '<span class="cfg-null">localRoot 未确认，该组件不会被启用</span>' : ''}
          </div>
        </td>`;
      }).join('')}
    </tr>`).join('');

  const shared = `<tr>
      <td title="成员从这里只读地拉取 _vcs\\releases 下的版本，再拷到本地 localRoot；共享目录本身不是服务运行目录">
        <b style="font-size:12.5px">共享目录</b>
        <div class="muted small" style="margin-top:2px">传输通道 · 不是部署路径</div>
      </td>
      ${NODES.map(n => `<td><input class="cfg-input" value="${SHARED_ROOTS[n.id]}"></td>`).join('')}
    </tr>`;

  $('#configTable').innerHTML = head + `<tbody>${body}${shared}</tbody>`;

  const banner = $('#driftBanner');
  if (banner) {
    banner.hidden = false;
    banner.className = 'drift-banner';
    $('#driftText').textContent = 'node-145 上报 configRevision = 6，主节点为 7。该机仍在用旧配置运行。';
  }

  const hint = $('#cfgHint');
  if (hint) hint.textContent = '演示数据：没有连上 master，这里的改动不会保存。启动 node bin/master.mjs 后再打开即可编辑真实配置。';

  const dirty = $('#cfgDirty');
  if (dirty) dirty.textContent = '演示数据 · 不可保存';
  const save = $('#btnSaveConfig');
  if (save) save.disabled = true;
  const undo = $('#btnCfgUndo');
  if (undo) undo.hidden = true;
}

/* ── 配置取数 / 保存 ──────────────────────────────────── */

async function loadConfig() {
  CFG_EDITS.clear();
  try {
    const res = await fetch('/api/ui/config', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    CFG = await res.json();
  } catch {
    CFG = null;
  }
  renderConfig();
}

function onCfgEdit(el) {
  const { ip, comp, field, type } = el.dataset;
  let value;
  if (type === 'bool') value = el.checked;
  else if (type === 'number') value = el.value.trim() === '' ? null : Number(el.value);
  else value = el.value.trim() === '' ? null : el.value.trim();

  cfgSet(ip, comp || null, field, value);
  // 只更新这一格的红框提示，不整体重绘（否则输入到一半就丢焦点）
  if (field === 'localRoot') {
    el.style.borderColor = value ? '' : '#f0b9b9';
    el.style.background = value ? '' : '#fffafa';
  }
}

function openSaveConfigModal() {
  const changes = [...CFG_EDITS.values()];
  if (!changes.length) return;

  const items = changes.map((c) => {
    const from = cfgOriginal(c.ip, c.component, c.field);
    const label = c.component
      ? `${c.component} · ${FIELD_LABEL[c.field] || c.field}`
      : `${FIELD_LABEL[c.field] || c.field}（传输通道）`;
    return `<li>
      <span class="who">${cfgEsc(c.ip.replace(/^172\.16\./, ''))}</span>
      <span class="what">${cfgEsc(label)}<br>
        <span class="from">${cfgEsc(fmtCfgVal(from))}</span> → <span class="to">${cfgEsc(fmtCfgVal(c.value))}</span>
      </span>
    </li>`;
  }).join('');

  openModal({
    title: `保存前确认 · ${changes.length} 处改动`,
    body: `<ul class="diff-list">${items}</ul>
      <p class="muted small" style="margin:14px 0 0">
        只改 <code>config/vcsnode.yaml</code> 里对应的那几行，注释保留。写入前会重新解析并逐字段比对，
        校验不过就放弃保存，原文件不动。保存后会向已连上的成员重发 hello（它下一轮采样按新配置走）。
      </p>`,
    confirmText: '保存',
    onConfirm: doSaveConfig,
  });
}

async function doSaveConfig() {
  const changes = [...CFG_EDITS.values()];
  if (!changes.length) return;

  try {
    const res = await fetch('/api/ui/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);

    if (!body.changed) toast('没有实际变化，未写文件');
    else {
      const touchedRoots = changes.some((c) => c.field === 'localRoot' || c.field === 'sharedRoot');
      toast(
        `已保存 <b>${body.changed}</b> 处 · 配置版本 rev ${body.revision}`
        + (touchedRoots ? '。目录有变动，建议回待发布区重新扫描。' : ''),
        6000,
      );
    }

    await loadConfig();
  } catch (e) {
    toast(`保存失败：${cfgEsc(e.message)}`, 8000);
  }
}

async function probeConfig() {
  const btn = $('#btnProbe');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '探测中…'; }

  try {
    const res = await fetch('/api/ui/config/probe', { method: 'POST' });
    const b = await res.json().catch(() => ({}));
    if (!res.ok || b.ok === false) throw new Error(b.error || `HTTP ${res.status}`);

    const bad = (b.results || []).filter((r) => r.state !== 'ok');
    const okCount = (b.results || []).length - bad.length;
    const others = (b.unchecked || []).length;

    if (!bad.length) {
      toast(`主节点本机 ${okCount} 个路径都存在。其余 ${others} 台需要 agent，暂未接入。`, 7000);
    } else {
      const detail = bad.slice(0, 3).map((r) => `${r.component} ${r.state}`).join('、');
      toast(`本机有 <b>${bad.length}</b> 个路径不对：${cfgEsc(detail)}${bad.length > 3 ? ' …' : ''}。其余 ${others} 台未探测。`, 9000);
    }
  } catch (e) {
    toast(`探测失败：${cfgEsc(e.message)}`, 7000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/* ══════════════════ 事件 ══════════════════ */

function renderEvents(filter = '') {
  const rows = EVENTS.filter(e => !filter || e.node === filter);
  $('#eventTable').innerHTML = `
    <thead><tr><th>时间</th><th>节点</th><th>动作</th><th>详情</th><th>结果</th><th>耗时</th></tr></thead>
    <tbody>${rows.map(e => `
      <tr>
        <td class="mono">${e.t}</td>
        <td class="mono">${e.node}</td>
        <td>${e.action}</td>
        <td>${e.detail}</td>
        <td>${chip(e.result === 'ok' ? 'running' : e.result === 'warn' ? 'degraded' : 'crashed',
                   e.result === 'ok' ? '成功' : e.result === 'warn' ? '警告' : '失败')}</td>
        <td class="mono">${e.ms ? e.ms + ' ms' : '—'}</td>
      </tr>`).join('')}</tbody>`;
}

/* ══════════════════ 弹层 ══════════════════ */

function openModal({ title, body, confirmText, onConfirm }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = `
    <button class="btn" data-modal-close>取消</button>
    <button class="btn primary" id="modalConfirm">${confirmText || '确定'}</button>`;
  $('#modal').classList.add('open');
  $('#modal').setAttribute('aria-hidden', 'false');
  $('#modalConfirm').onclick = () => { closeModal(); onConfirm && onConfirm(); };
}

function closeModal() {
  $('#modal').classList.remove('open');
  $('#modal').setAttribute('aria-hidden', 'true');
}

/* ══════════════════ 事件绑定 ══════════════════ */

function switchView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-view]');
  if (nav) { switchView(nav.dataset.view); return; }

  const cellBtn = e.target.closest('.cell-btn');
  if (cellBtn) { openDrawer(cellBtn.dataset.comp, cellBtn.dataset.node); return; }

  const rel = e.target.closest('[data-release]');
  if (rel) { openReleaseDrawer(rel.dataset.release); return; }

  if (e.target.closest('[data-toast]')) {
    toast(e.target.closest('[data-toast]').dataset.toast);
    return;
  }

  const rollback = e.target.closest('[data-rollback]');
  if (rollback) {
    openModal({
      title: '回退到 ' + rollback.dataset.rollback,
      body: `<p>回退按 <b>set</b> 整体进行，并会先查忙。</p>
             <ul class="diff-list">
               <li><span class="who">set-a</span><span class="what">207 + 145 一起回退，切回上一版 junction 并重启</span></li>
               <li><span class="who">set-c</span><span class="what">149 当前离线，回退将在它重连后自动重试</span></li>
             </ul>`,
      confirmText: '确认回退',
      onConfirm: () => toast('已下发回退指令，等待各节点 ack'),
    });
    return;
  }

  if (e.target.closest('[data-act]')) {
    const btn = e.target.closest('[data-act]');
    if (btn.disabled) return;
    runDrawerAction(btn.dataset.act, btn);
    return;
  }

  if (e.target.id === 'drawerClose' || e.target.id === 'scrim') { closeDrawer(); return; }
  if (e.target.id === 'modalClose' || e.target.closest('[data-modal-close]')) { closeModal(); return; }
});

/* 待发布区：勾选 */

document.addEventListener('change', (e) => {
  const t = e.target;

  if (t.id === 'selectAll') {
    VIEW.groups.forEach(g => g.files.forEach(f => { f.sel = t.checked; }));
    rerenderKeepScroll();
    return;
  }

  const groupName = t.dataset && t.dataset.g;
  if (groupName !== undefined && t.dataset.i !== undefined) {
    const g = VIEW.groups.find(x => x.component === groupName);
    const f = g && g.files[Number(t.dataset.i)];
    if (!f) return;
    f.sel = t.checked;

    // 取消勾选最后一个删除项时，撤掉删除确认，避免误发
    if (f.action === 'D' && !t.checked) {
      const anyDel = VIEW.groups.some(o => o.files.some(x => x.action === 'D' && x.sel));
      if (!anyDel) $('#ckDel').checked = false;
    }

    rerenderKeepScroll();
    return;
  }

  if (t.id === 'ckDb' || t.id === 'ckDel') { refreshPendingState(); return; }
});

/* 待发布区：按钮 */

document.addEventListener('click', (e) => {
  if (e.target.id === 'btnRescan') {
    runScan();
    return;
  }

  if (e.target.id === 'btnStage') {
    stageSelected();
    return;
  }

  if (e.target.id === 'btnCommit') {
    toast('「切换上线」还没接（M3）：这一版只做「更新文件」。现在请在抽屉里手动停止 → 启动。', 9000);
    return;
  }

  if (e.target.id === 'btnProbe') {
    probeConfig();
    return;
  }

  if (e.target.id === 'btnSaveConfig') {
    openSaveConfigModal();
    return;
  }

  if (e.target.id === 'btnCfgUndo') {
    CFG_EDITS.clear();
    renderConfig();
    return;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-cfg]');
  if (el && el.dataset.type !== 'bool') onCfgEdit(el);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-cfg]');
  if (el && el.dataset.type === 'bool') onCfgEdit(el);
});

$('#eventFilter') && $('#eventFilter').addEventListener('change', (e) => renderEvents(e.target.value));

/* 时钟 */

function tick() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  $('#clock').textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ══════════════════ 启动 ══════════════════ */

renderClusterSummary();
renderNodeCards();
renderMatrix();
renderQueue();
renderEventMini();
loadPending();          // 有 master 就用真实清单，没有就退回演示数据
loadNodes();            // 有 agent 上报就显示真实状态，没有就退回演示数据
setInterval(loadNodes, 5000);
renderReleases();       // 先按演示数据画一帧
loadReleases();         // 有 master 就换成真实发布记录
renderConfig();
loadConfig();           // 有 master 就读真实配置，没有就退回演示表
renderEvents();
tick();
setInterval(tick, 1000);
