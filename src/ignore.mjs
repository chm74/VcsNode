/* 排除规则匹配（gitignore 的常用子集）
 *
 * 支持：
 *   node_modules/      目录名匹配，任意层级
 *   *.log              文件名匹配，任意层级
 *   App_Data/Logs/     含斜杠 → 从源根锚定
 *   public/config.js   含斜杠 → 从源根锚定
 *   **\/cache/          ** 匹配任意层
 *   !TP_xxx.zip        否定规则，后出现的优先
 *
 * 不支持的：转义字符、字符组 [abc]、`!` 之外的 gitignore 扩展。
 * 规则里用到了会怎样：字符组会被当字面量，宁可少排除也不误排除。
 *
 * 遍历时的剪枝：目录一旦被排除就整棵跳过 —— 意味着否定规则**救不回**
 * 被排除目录里的文件。当前配置里的否定规则都是根级 *.zip，不受影响。
 */

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

function compile(pattern) {
  let p = String(pattern).trim();
  let negate = false;
  if (p.startsWith('!')) { negate = true; p = p.slice(1); }

  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }

  let anchored = false;
  if (p.startsWith('/')) { anchored = true; p = p.slice(1); }
  if (p.includes('/')) anchored = true;

  return { source: pattern, negate, dirOnly, anchored, re: globToRegExp(p) };
}

/** 收集 relPath 的所有祖先目录路径（累计形式） */
function dirPathsOf(relPath, isDir) {
  const segments = relPath.split('/');
  const dirSegs = isDir ? segments : segments.slice(0, -1);
  const out = [];
  let acc = '';
  for (const s of dirSegs) {
    acc = acc ? acc + '/' + s : s;
    out.push(acc);
  }
  return { dirSegs, dirPaths: out, segments };
}

function ruleMatches(rule, relPath, isDir) {
  const { dirSegs, dirPaths, segments } = dirPathsOf(relPath, isDir);

  if (rule.anchored) {
    const candidates = rule.dirOnly ? dirPaths : (isDir ? dirPaths : dirPaths.concat([relPath]));
    return candidates.some(p => rule.re.test(p));
  }

  // 无斜杠：按名字匹配任意层级
  const names = rule.dirOnly
    ? dirSegs
    : (isDir ? dirSegs : segments.slice(-1));
  return names.some(n => rule.re.test(n));
}

export function createIgnore(patterns = []) {
  const rules = patterns.map(compile);
  const negations = rules.filter(r => r.negate);

  function isIgnored(relPath, isDir = false) {
    let ignored = false;
    for (const rule of rules) {
      if (ruleMatches(rule, relPath, isDir)) ignored = !rule.negate;
    }
    return ignored;
  }

  /** 目录是否可以直接跳过（忽略且没有否定规则可能救回里面的文件） */
  function pruneDir(relPath) {
    if (!isIgnored(relPath, true)) return false;
    if (negations.length === 0) return true;
    // 有否定规则：只有「锚定到别的路径」时才敢剪枝
    const couldRescue = negations.some(n => n.anchored && (relPath + '/').startsWith(n.source.replace(/^!/, '').replace(/\/$/, '') + '/'));
    return !couldRescue;
  }

  return { isIgnored, pruneDir, rules };
}
