/* 极简 YAML 子集解析器（零依赖）
 *
 * 只支持 config/vcsnode.yaml 实际用到的语法：
 *   - 注释（# 到行尾，引号内不生效）
 *   - 缩进嵌套的 map / seq
 *   - 行内 flow：{ a: 1, b: 'x' } / [1, 'a']
 *   - 标量：单引号、双引号、裸字符串、true/false/null/数字
 *   - seq 的元素是 map（`- key: value`，后续键与 value 同缩进）
 *
 * 不支持（用到就报错，不静默猜）：多行标量 | >、锚点 & *、标签 !!、tab 缩进、复杂键 ?。
 * 与其写个半吊子解析器把配置读歪，不如直接拒。
 */

export class YamlError extends Error {
  constructor(message, lineNo, lineText) {
    super(`${message}（第 ${lineNo} 行：${String(lineText).trim()}）`);
    this.name = 'YamlError';
    this.lineNo = lineNo;
  }
}

/** 去掉行尾注释，引号内的 # 不算注释 */
export function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") { i++; continue; }   // '' 是转义的 '
        quote = null;
      } else if (quote === '"' && c === '\\') {
        i++;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 找到 map 键值分隔的冒号：第一个不在引号/括号内的冒号 */
function findColon(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") { i++; continue; }
        quote = null;
      } else if (quote === '"' && c === '\\') {
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') { depth--; continue; }
    if (c === ':' && depth === 0) {
      // 必须后面是空格或行尾，否则可能是 Windows 路径里的冒号
      if (i === text.length - 1 || /\s/.test(text[i + 1])) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切分 flow 内容 */
function splitFlow(text) {
  const out = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") { i++; continue; }
        quote = null;
      } else if (quote === '"' && c === '\\') {
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') { depth--; continue; }
    if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const tail = text.slice(start);
  if (tail.trim() || out.length) out.push(tail);
  return out.map(s => s.trim()).filter(s => s !== '');
}

function unquote(text) {
  const s = text.trim();
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\/nrt])/g, (_, c) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
  }
  return s;
}

/** 把源码切成「有内容的行」并记录缩进与行号
 *
 *  注释与空行会被丢掉，所以这里的 `no` 是原文件里的真实下标 ——
 *  改配置时要靠它把新内容写回正确的那一行。
 */
export function scanLines(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    if (raw.includes('\t')) throw new YamlError('不支持 tab 缩进', idx + 1, raw);
    const noComment = stripComment(raw);
    if (!noComment.trim()) return;
    const indent = noComment.match(/^ */)[0].length;
    lines.push({ no: idx, indent, text: noComment.trim(), lineNo: idx + 1, raw });
  });
  return lines;
}

/** 解析 flow map 的内部（`a: 1, b: 'x'`） */
export function parseFlowMap(inner) {
  const obj = {};
  for (const part of splitFlow(inner)) {
    const c = findColon(part);
    if (c < 0) throw new YamlError(`flow map 里缺少冒号：${part}`);
    obj[String(parseScalar(part.slice(0, c)))] = parseScalar(part.slice(c + 1));
  }
  return obj;
}

/** 把值写成 YAML 标量。字符串一律单引号，反斜杠原样保留 */
export function emitValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** 把对象写成 flow map，保持配置里 `{ localRoot: '...', port: 3071 }` 的风格 */
export function emitFlowMap(obj) {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${emitValue(v)}`);
  return `{ ${parts.join(', ')} }`;
}

function parseScalar(text) {
  const s = text.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('{') && s.endsWith('}')) {
    return parseFlowMap(s.slice(1, -1));
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitFlow(s.slice(1, -1)).map(parseScalar);
  }
  if (s[0] === "'" || s[0] === '"') return unquote(s);
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(text) {
  const lines = scanLines(text);

  if (lines.length === 0) return null;

  let i = 0;

  const expectIndent = (want, l) => {
    if (l.indent !== want) throw new YamlError(`缩进不一致（期望 ${want} 空格）`, l.lineNo, l.raw);
  };

  function parseBlock(indent) {
    const first = lines[i];
    return first.text.startsWith('-') ? parseSeq(indent) : parseMap(indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (i < lines.length) {
      const l = lines[i];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError(`意外的缩进（应为 ${indent} 空格）`, l.lineNo, l.raw);
      if (l.text.startsWith('- ')) break;

      const c = findColon(l.text);
      if (c < 0) throw new YamlError('这一行不是 key: value', l.lineNo, l.raw);

      const key = String(parseScalar(l.text.slice(0, c)));
      const rest = l.text.slice(c + 1).trim();
      i++;

      if (rest === '') {
        if (i < lines.length && lines[i].indent > indent) {
          obj[key] = parseBlock(lines[i].indent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.indent !== indent || !l.text.startsWith('-')) break;

      const rest = l.text.slice(1).trim();
      if (rest === '') {
        i++;
        if (i < lines.length && lines[i].indent > indent) {
          arr.push(parseBlock(lines[i].indent));
        } else {
          arr.push(null);
        }
        continue;
      }

      if (findColon(rest) >= 0 && !/^['"{\[]/.test(rest)) {
        // `- key: value` → 视作缩进 2 格的 map，后续同缩进的键接着读
        const virtual = { indent: indent + 2, text: rest, lineNo: l.lineNo, raw: l.raw };
        lines[i] = virtual;
        arr.push(parseMap(indent + 2));
      } else {
        arr.push(parseScalar(rest));
        i++;
      }
    }
    return arr;
  }

  const root = parseBlock(lines[0].indent);
  if (i < lines.length) {
    throw new YamlError('文件末尾有多余内容', lines[i].lineNo, lines[i].raw);
  }
  return root;
}
