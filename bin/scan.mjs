#!/usr/bin/env node
/* 变更清单扫描器（命令行）
 *
 *   node bin/scan.mjs                     比对基线，输出清单到 state/pending.json
 *   node bin/scan.mjs --init-baseline     把当前状态记为基线（不产生清单）
 *   node bin/scan.mjs --json              只输出 JSON
 *   node bin/scan.mjs --remap D:\SceneAutomationV3=E:\tmp\deploy
 *                                         把自己的假目录顶上去试跑（仅开发机）
 *
 * 第一次运行时没有基线 → 自动建基线，不会把所有文件当成「新增」推出去。
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../src/yaml.mjs';
import { buildSnapshot, buildManifestPayload, buildBaseline, humanSize } from '../src/scan.mjs';
import { readJson, writeJsonAtomic } from '../src/state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`用法：node bin/scan.mjs [选项]

  --config <file>          配置文件，默认 config/vcsnode.yaml
  --state <dir>            状态目录，默认 <root>/state
  --init-baseline          重建基线（覆盖已有基线）
  --remap OLD=NEW          替换源路径前缀，可重复（仅开发机试跑用）
  --max-files <n>          文件数上限，超过即中止，默认 200000
  --json                   只输出 JSON，不打表格
  -h, --help               显示本帮助
`);
}

function parseArgs(argv) {
  const out = {
    config: join(ROOT, 'config', 'vcsnode.yaml'),
    stateDir: join(ROOT, 'state'),
    initBaseline: false,
    remaps: [],
    maxFiles: 200000,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a === '--init-baseline') out.initBaseline = true;
    else if (a === '--json') out.json = true;
    else if (a === '--list') out.list = true;
    else if (a === '--config') out.config = resolve(argv[++i]);
    else if (a === '--state') out.stateDir = resolve(argv[++i]);
    else if (a === '--max-files') out.maxFiles = Number(argv[++i]);
    else if (a === '--remap') {
      const v = argv[++i] || '';
      const at = v.indexOf('=');
      if (at < 1) throw new Error(`--remap 需要 OLD=NEW 形式，收到：${v}`);
      out.remaps.push({ from: v.slice(0, at), to: v.slice(at + 1) });
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  return out;
}

/* 终端表格：中文按 2 列宽计算，否则列会错位 */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

function padEnd(s, w) {
  const str = String(s);
  return str + ' '.repeat(Math.max(0, w - dispWidth(str) + 2));
}

function clip(s, w) {
  const str = String(s);
  if (dispWidth(str) <= w) return str;
  let out = '';
  let used = 0;
  for (const ch of str) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + '…';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = parseYaml(await readFile(args.config, 'utf8'));
  } catch (e) {
    console.error(`读取配置失败：${e.message}`);
    process.exit(1);
  }
  if (!config || typeof config !== 'object') {
    console.error('配置为空');
    process.exit(1);
  }

  const started = Date.now();
  const snapshot = await buildSnapshot(config, {
    remaps: args.remaps,
    maxFiles: args.maxFiles,
  });

  const baselineFile = join(args.stateDir, 'baseline.json');
  const pendingFile = join(args.stateDir, 'pending.json');
  const baseline = await readJson(baselineFile);

  if (args.initBaseline || !baseline) {
    const created = buildBaseline(snapshot);
    await writeJsonAtomic(baselineFile, created);

    // 基线刚建时清单是空的，但仍然写一份，界面据此显示「暂无变更」而不是「未扫描」
    await writeJsonAtomic(pendingFile, buildManifestPayload(snapshot, created, config));

    const total = Object.values(snapshot.components).reduce((a, c) => a + Object.keys(c.files).length, 0);
    if (args.json) {
      console.log(JSON.stringify({ baselineCreated: true, files: total, createdAt: snapshot.createdAt }, null, 2));
    } else {
      console.log(`已建立基线：${total} 个文件 → ${baselineFile}`);
      console.log('（基线 = 当前状态。从现在起，扫描结果表示「相对这个状态的改动」。）');
      console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    return;
  }

  const payload = buildManifestPayload(snapshot, baseline, config);
  await writeJsonAtomic(pendingFile, payload);

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const st = payload.stats;
  console.log('');
  console.log(`扫描完成  ${payload.createdAt.replace('T', ' ').slice(0, 19)}   基线 ${String(payload.baselineAt || '—').replace('T', ' ').slice(0, 19)}`);
  console.log('');

  const rows = payload.groups.map(g => [
    clip(g.root, 52),
    g.component,
    String(Object.keys(snapshot.components[g.component].files).length),
    String(g.counts.A),
    String(g.counts.M),
    String(g.counts.D),
  ]);
  const headers = ['源', '组件', '文件', '新增', '修改', '删除'];
  const widths = headers.map((h, i) => Math.max(dispWidth(h), ...rows.map(r => dispWidth(r[i]))));

  const line = cells => cells.map((c, i) => padEnd(c, widths[i])).join('');
  console.log(line(headers));
  console.log('─'.repeat(widths.reduce((a, w) => a + w + 2, 0)));
  for (const r of rows) console.log(line(r));
  console.log('─'.repeat(widths.reduce((a, w) => a + w + 2, 0)));
  console.log(`合计：${st.tracked} 个文件受管，未变 ${st.unchanged}，变更 ${st.added + st.modified + st.deleted}（+${st.added} ~${st.modified} -${st.deleted}），待传 ${humanSize(st.bytes)}`);

  if (st.failed) console.log(`⚠ ${st.failed} 个文件读取失败，未计入清单`);
  if (payload.errors.length) {
    console.log(`⚠ ${payload.errors.length} 个路径访问失败：`);
    for (const e of payload.errors.slice(0, 5)) console.log(`   ${e.path}  ${e.message}`);
  }
  if (payload.warnings.length) console.log(`⚠ ${payload.warnings.length} 条提示（如跳过的链接/超深目录）`);

  if (args.list) {
    console.log('');
    for (const g of payload.groups) {
      if (!g.files.length) continue;
      console.log(`[${g.component}]`);
      for (const f of g.files) {
        const action = f.action === 'A' ? '+' : f.action === 'M' ? '~' : '-';
        console.log(`  ${action} ${f.path}${f.sizeBytes ? `  ${humanSize(f.sizeBytes)}` : ''}`);
      }
    }
  }

  console.log('');
  console.log(`清单已写入 ${pendingFile}`);
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(`扫描失败：${e.message}`);
  process.exit(1);
});
