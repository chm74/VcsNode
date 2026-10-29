import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// 执行页面实际的确认与提交函数，只替代 DOM 和网络边界，不执行任何真实同步。
const source = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function stageSelected() {');
const end = source.indexOf('/* ══════════════════ 同步记录', start);
assert.ok(start >= 0 && end > start);

async function submitSelection(selected, declared = ['145', '149']) {
  let modal;
  const requests = [];
  const button = { textContent: '预同步', disabled: false };
  const context = vm.createContext({
    DATA_MODE: 'live',
    VIEW: { targets: { webapi: declared } },
    chosenNodes: new Set(selected),
    allChangedFiles: () => [
      { sel: true, component: 'webapi', path: 'SceneAutoApply.dll', action: 'M', sizeBytes: 1024 },
      { sel: false, component: 'webapi', path: 'excluded.dll', action: 'M', sizeBytes: 512 },
    ],
    openModal: (options) => { modal = options; },
    cfgEsc: String,
    fmtSize: String,
    $: () => button,
    toast: () => {},
    refreshPendingState: () => {},
    loadPending: async () => {},
    loadReleases: async () => {},
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, stats: { files: 1, bytes: 1024 }, nodes: { '149': { ok: true } }, durationMs: 1 }),
      };
    },
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext('stageSelected()', context);
  assert.ok(modal, 'selected files must open the confirmation');
  assert.equal(requests.length, 0, 'no request before confirmation');
  await modal.onConfirm();
  assert.equal(requests.length, 1);
  return { request: requests[0], modal };
}

test('confirming only 149 sends nodes [149], matching the selected target in the dialog', async () => {
  const { request, modal } = await submitSelection(['149']);
  assert.match(modal.body, /class="mono">149<\/dd>/);
  assert.deepEqual(request, {
    url: '/api/ui/stage', method: 'POST',
    body: {
      components: ['webapi'], paths: { webapi: ['SceneAutoApply.dll'] },
      includeDeletes: false, nodes: ['149'],
    },
  });
});

test('multiple selected targets are preserved and undeclared nodes are excluded', async () => {
  const { request } = await submitSelection(['149', '145', '207']);
  assert.deepEqual(request.body.nodes, ['145', '149']);
});

test('an empty selection remains explicit instead of omitting nodes and broadcasting to all', async () => {
  const { request } = await submitSelection([]);
  assert.equal(Object.hasOwn(request.body, 'nodes'), true);
  assert.deepEqual(request.body.nodes, []);
});
