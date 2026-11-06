/**
 * LaTeX 源解析：标题/作者/摘要、章节树、定理类块、数学块、引用与标签。
 *
 * 设计取舍：
 *  - 只做“阅读需要”的解析，不做完整 TeX 展开；未知命令原样保留，绝不吞内容。
 *  - 每块的 `line` 指向主源文件行号（include 进来的内容指向那一行 `\input`），供面板跳转。
 *  - 纯函数，不读文件；include 由调用方注入 `loadInclude(name)`。
 */
import { collectCommandArgs, detex, readBraceGroup, readOptionalBracket, stripComments } from './text.js';

const THEOREM_ENVS = [
  'theorem',
  'lemma',
  'corollary',
  'proposition',
  'definition',
  'assumption',
  'remark',
  'example',
  'conjecture',
  'claim',
];
const MATH_ENVS = ['equation', 'align', 'gather', 'multline', 'eqnarray', 'displaymath', 'alignat', 'flalign'];
const SKIP_ENVS = ['figure', 'table', 'tabular', 'algorithm', 'algorithmic'];
const SECTION_LEVEL = { section: 1, subsection: 2, subsubsection: 3 };

const ENV_LABELS = {
  theorem: 'Theorem',
  lemma: 'Lemma',
  corollary: 'Corollary',
  proposition: 'Proposition',
  definition: 'Definition',
  assumption: 'Assumption',
  remark: 'Remark',
  example: 'Example',
  conjecture: 'Conjecture',
  claim: 'Claim',
};

/** 由字符偏移构造 offset → 行号 的查询函数。 */
function makeLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 解析 preamble 里的 \newtheorem 定义，得到显示名与是否按节编号。 */
function parseNewTheorems(preamble) {
  const specs = new Map();
  const re = /\\newtheorem\*?\s*\{([^{}]+)\}\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}\s*(?:\[([^\]]*)\])?/g;
  let match;
  while ((match = re.exec(preamble)) !== null) {
    const [, env, sharedCounter, display, counterParent] = match;
    if (sharedCounter) continue; // \newtheorem{x}[theorem]{...} 共享计数器
    specs.set(env.trim(), {
      display: display.trim(),
      perSection: (counterParent ?? '').trim() === 'section',
    });
  }
  return specs;
}

/** 去掉整段 figure/table 等不参与阅读的环境。 */
function stripSkipEnvs(text) {
  let out = text;
  for (const env of SKIP_ENVS) {
    const re = new RegExp(`\\\\begin\\{${env}\\*?\\}[\\s\\S]*?\\\\end\\{${env}\\*?\\}`, 'g');
    out = out.replace(re, '\n');
  }
  return out;
}

/** 列表、居中、引用块统一成可读文本。 */
function normalizeListEnvs(text) {
  return text
    .replace(/\\(?:begin|end)\{(?:itemize|enumerate|description|center|flushleft|flushright|quote|quotation)\}/g, '\n')
    .replace(/\\item\b\s*(?:\[([^\]]*)\])?/g, (_m, head) => (head ? `\n• ${head} ` : '\n• '));
}

/** 用空白行占位替换掉摘要环境，保持行号不变。 */
function blankOut(text, from, to) {
  const removed = text.slice(from, to);
  const newlines = removed.replace(/[^\n]/g, '').length;
  return `${text.slice(0, from)}${'\n'.repeat(newlines)}${text.slice(to)}`;
}

/**
 * 去掉正文里的 \title/\author/\date/\thanks 与 \maketitle：
 * 这些内容要么已经在 meta 里，要么只是排版噪声，不该出现在正文段落里。
 * 用同数量空行替换，保证行号不变。
 */
function stripBodyMeta(text) {
  let out = text;
  for (const command of ['title', 'author', 'date', 'thanks']) {
    let from = 0;
    for (;;) {
      const at = out.indexOf(`\\${command}`, from);
      if (at < 0) break;
      let cursor = at + command.length + 1;
      if (out[at + command.length] === '*') cursor += 1;
      while (cursor < out.length && /\s/.test(out[cursor])) cursor += 1;
      const group = readBraceGroup(out, cursor);
      if (group === undefined) {
        from = cursor;
        continue;
      }
      out = blankOut(out, at, group.end);
      from = at;
    }
  }
  out = out.replace(/\\maketitle\b/g, (match) => ' '.repeat(match.length));
  return out;
}

/**
 * 展开 \input / \include。每行尾部标记 `\u0001<主文件行号>`，
 * 之后据此建立“展开行 → 主文件行”的映射。
 */
function expandIncludes(body, loadInclude, bodyFirstLine, depth, seen) {
  if (!loadInclude || depth > 3) return body;
  const lines = body.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const mainLine = bodyFirstLine + i;
    const match = /^\s*\\(?:input|include)\s*\{([^{}]+)\}\s*$/.exec(line);
    if (match && !seen.has(match[1].trim())) {
      const name = match[1].trim();
      const nested = loadInclude(name);
      if (typeof nested === 'string') {
        const nextSeen = new Set(seen);
        nextSeen.add(name);
        const inner = expandIncludes(stripComments(nested), loadInclude, 0, depth + 1, nextSeen);
        for (const innerLine of inner.split('\n')) {
          out.push(innerLine.includes('\u0001') ? innerLine : `${innerLine}\u0001${mainLine}`);
        }
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 解析一篇 LaTeX 稿。
 * @param {string} source 源文本
 * @param {{ loadInclude?: (name: string) => string | undefined, label?: string }} [options]
 */
export function parseTex(source, options = {}) {
  const raw = stripComments(source);
  const documentAt = raw.indexOf('\\begin{document}');
  const hasDocument = documentAt >= 0;
  const preambleRaw = hasDocument ? raw.slice(0, documentAt) : '';
  const newlinesBeforeBody = hasDocument ? (preambleRaw.match(/\n/g) ?? []).length : 0;
  // bodyText 第 0 个字符所在的主文件行号（1 基）
  const bodyFirstLine = newlinesBeforeBody + 1;
  const bodyRaw = hasDocument ? raw.slice(documentAt + '\\begin{document}'.length) : raw;
  const bodyEnd = bodyRaw.indexOf('\\end{document}');
  const bodyWithOffset = bodyEnd >= 0 ? bodyRaw.slice(0, bodyEnd) : bodyRaw;

  const newTheorems = parseNewTheorems(preambleRaw);
  const normalized = normalizeListEnvs(stripBodyMeta(stripSkipEnvs(bodyWithOffset)));
  const expanded = expandIncludes(normalized, options.loadInclude, bodyFirstLine, 0, new Set());

  const expandedLines = expanded.split('\n');
  const mainLineOf = expandedLines.map((line, i) => {
    const marker = /\u0001(\d+)$/.exec(line);
    return marker === null ? bodyFirstLine + i : Number(marker[1]);
  });
  const bodyText = expandedLines.map((line) => line.replace(/\u0001\d+$/, '')).join('\n');
  const expandedLineOf = makeLineIndex(bodyText);
  const lineOf = (offset) => {
    const index = Math.min(expandedLineOf(offset) - 1, mainLineOf.length - 1);
    return mainLineOf[Math.max(0, index)] ?? 1;
  };

  const abstractMatch = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/.exec(bodyText);
  const abstractText = abstractMatch === null ? '' : detex(abstractMatch[1]);
  const scanText =
    abstractMatch === null ? bodyText : blankOut(bodyText, abstractMatch.index, abstractMatch.index + abstractMatch[0].length);

  const meta = {
    title: (() => {
      const rawTitle = collectCommandArgs(preambleRaw, 'title')[0] ?? collectCommandArgs(bodyWithOffset, 'title')[0] ?? '';
      return detex(rawTitle).replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
    })(),
    authors: (() => {
      const rawAuthors = collectCommandArgs(preambleRaw, 'author')[0] ?? collectCommandArgs(bodyWithOffset, 'author')[0] ?? '';
      const firstLine = rawAuthors.split('\n')[0] ?? '';
      return detex(firstLine.replace(/[{}]/g, ' ').replace(/\\and\b/g, ', '))
        .replace(/\$[^$]*\$/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s+,/g, ',')
        .replace(/[,\s]+$/, '')
        .trim();
    })(),
    abstract: abstractText,
  };

  const blocks = [];
  const sections = [];
  const labels = new Set();
  const refs = new Set();
  const cites = new Set();
  const theoremCounters = new Map();
  let currentSection = null;
  let sectionOrdinal = 0;

  const pushSection = (level, title, line, counted = true) => {
    const id = `s${sections.length}`;
    if (level === 1 && counted) sectionOrdinal += 1;
    const section = { id, level, title: detex(title) || String(title).trim(), line, ordinal: sections.length };
    sections.push(section);
    currentSection = section;
    blocks.push({ kind: 'heading', level, text: section.title, line, sectionId: id });
    return section;
  };

  if (abstractText) {
    // LaTeX 里 abstract 不参与 section 计数，所以不计入定理编号
    pushSection(1, 'Abstract', abstractMatch === null ? 1 : lineOf(abstractMatch.index), false);
    blocks.push({
      kind: 'para',
      text: abstractText,
      line: abstractMatch === null ? 1 : lineOf(abstractMatch.index),
      sectionId: currentSection.id,
    });
  }

  const collectRefsFrom = (text) => {
    for (const m of text.matchAll(/\\label\{([^{}]+)\}/g)) labels.add(m[1].trim());
    for (const m of text.matchAll(/\\(?:ref|autoref|cref|Cref|eqref)\{([^{}]+)\}/g)) refs.add(m[1].trim());
    for (const m of text.matchAll(/\\(?:cite|citep|citet|parencite|textcite)\*?(?:\[[^\]]*\])*\{([^{}]+)\}/g)) {
      for (const key of m[1].split(',')) {
        const k = key.trim();
        if (k) cites.add(k);
      }
    }
  };

  /** 数学块：收集标签/引用，去掉 KaTeX 不认的排版命令。 */
  const cleanMath = (text) => {
    collectRefsFrom(text);
    return text
      .replace(/\\label\{[^{}]*\}/g, '')
      .replace(/\\(?:nonumber|notag)\b/g, '')
      .replace(/\\begin\{(?:split|aligned)\}/g, '\\begin{aligned}')
      .trim();
  };

  const flushProse = (text, startOffset) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const leading = Math.max(0, text.indexOf(trimmed));
    const paragraphs = trimmed.split(/\n\s*\n/);
    let searchFrom = 0;
    for (const paragraph of paragraphs) {
      const at = trimmed.indexOf(paragraph, searchFrom);
      if (at >= 0) searchFrom = at + paragraph.length;
      const absolute = startOffset + leading + Math.max(0, at);
      collectRefsFrom(paragraph);
      const shown = detex(paragraph);
      if (!shown) continue;
      blocks.push({
        kind: 'para',
        text: shown,
        line: lineOf(absolute),
        sectionId: currentSection?.id ?? 's0',
      });
    }
  };

  const specialRe = new RegExp(
    [
      '\\\\(section|subsection|subsubsection)\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{',
      `\\\\begin\\{(${[...THEOREM_ENVS, 'proof', ...MATH_ENVS].join('|')})\\*?\\}`,
      '\\\\\\[',
      '\\$\\$',
    ].join('|'),
    'g',
  );

  let index = 0;
  while (index < scanText.length) {
    specialRe.lastIndex = index;
    const match = specialRe.exec(scanText);
    if (match === null) {
      flushProse(scanText.slice(index), index);
      break;
    }
    if (match.index > index) flushProse(scanText.slice(index, match.index), index);
    const line = lineOf(match.index);

    if (match[1]) {
      const open = match.index + match[0].length - 1;
      const group = readBraceGroup(scanText, open);
      if (group === undefined) break;
      pushSection(SECTION_LEVEL[match[1]] ?? 1, group.text, line);
      index = group.end;
      continue;
    }

    if (match[0] === '\\[' || match[0] === '$$') {
      const closer = match[0] === '\\[' ? '\\]' : '$$';
      const end = scanText.indexOf(closer, match.index + match[0].length);
      const inner = scanText.slice(match.index + match[0].length, end < 0 ? scanText.length : end);
      blocks.push({ kind: 'math', text: cleanMath(inner), line, sectionId: currentSection?.id ?? 's0' });
      index = end < 0 ? scanText.length : end + closer.length;
      continue;
    }

    const env = match[2];
    const beginTag = match[0];
    const endTag = `\\end{${env}${beginTag.includes('*') ? '*' : ''}}`;
    const endAt = scanText.indexOf(endTag, match.index + beginTag.length);
    const inner = scanText.slice(match.index + beginTag.length, endAt < 0 ? scanText.length : endAt);
    index = endAt < 0 ? scanText.length : endAt + endTag.length;

    if (MATH_ENVS.includes(env)) {
      blocks.push({ kind: 'math', text: cleanMath(inner), line, sectionId: currentSection?.id ?? 's0', display: true });
      continue;
    }
    if (env !== 'proof' && !THEOREM_ENVS.includes(env)) continue;

    const bracket = readOptionalBracket(inner, 0);
    const headline = bracket.text.trim();
    const body = bracket.text ? inner.slice(bracket.end) : inner;
    collectRefsFrom(body);
    const isProof = env === 'proof';
    let number = '';
    if (!isProof) {
      const counter = (theoremCounters.get(env) ?? 0) + 1;
      theoremCounters.set(env, counter);
      const spec = newTheorems.get(env);
      number = spec?.perSection ? `${sectionOrdinal || 1}.${counter}` : String(counter);
    }
    blocks.push({
      kind: isProof ? 'proof' : 'theorem',
      env,
      name: isProof ? 'Proof' : newTheorems.get(env)?.display ?? ENV_LABELS[env] ?? env,
      number,
      title: headline ? detex(headline) : '',
      text: detex(body),
      line,
      sectionId: currentSection?.id ?? 's0',
    });
  }

  if (!meta.title) meta.title = options.label ?? '';

  return {
    kind: 'tex',
    meta,
    sections,
    blocks,
    labels: [...labels],
    refs: [...refs],
    cites: [...cites],
    undefinedRefs: [...refs].filter((ref) => !labels.has(ref)),
    lineCount: raw.split('\n').length,
    theoremCount: blocks.filter((b) => b.kind === 'theorem').length,
    mathCount: blocks.filter((b) => b.kind === 'math').length,
  };
}

/**
 * 解析 .bib：返回 {key, type, title, author, year, venue} 列表。
 * 只做括号平衡的浅解析，足够阅读与“未定义引用”检查。
 */
export function parseBib(source) {
  const entries = [];
  const text = String(source);
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    const typeMatch = /^@([A-Za-z]+)\s*[{(]/.exec(text.slice(at));
    if (!typeMatch) {
      i = at + 1;
      continue;
    }
    const type = typeMatch[1].toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') {
      i = at + typeMatch[0].length;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let j = at + 1; j < text.length; j += 1) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    const chunk = text.slice(at + typeMatch[0].length, end);
    const comma = chunk.indexOf(',');
    const key = (comma >= 0 ? chunk.slice(0, comma) : chunk).trim();
    const fields = {};
    const fieldRe = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/g;
    let match;
    while ((match = fieldRe.exec(chunk)) !== null) {
      let cursor = match.index + match[0].length;
      let value = '';
      const ch = chunk[cursor];
      if (ch === '{') {
        const group = readBraceGroup(chunk, cursor);
        if (group === undefined) continue;
        value = group.text;
        cursor = group.end;
      } else if (ch === '"') {
        let j = cursor + 1;
        let out = '';
        while (j < chunk.length && chunk[j] !== '"') {
          if (chunk[j] === '\\') {
            out += chunk[j + 1] ?? '';
            j += 2;
            continue;
          }
          out += chunk[j];
          j += 1;
        }
        value = out;
        cursor = j;
      } else {
        const plain = /^[^,\n}]+/.exec(chunk.slice(cursor));
        if (plain === null) continue;
        value = plain[0];
        cursor += value.length;
      }
      fields[match[1].toLowerCase()] = value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
      fieldRe.lastIndex = Math.max(cursor, fieldRe.lastIndex);
    }
    entries.push({
      key,
      type,
      title: fields.title ?? '',
      author: fields.author ?? '',
      year: fields.year ?? fields.date ?? '',
      venue: fields.journal ?? fields.booktitle ?? fields.publisher ?? '',
    });
    i = end + 1;
  }
  // 同一 key 重复出现时保留最后一条，避免大纲/审稿材料里重复列出
  const byKey = new Map();
  for (const entry of entries) byKey.set(entry.key.toLowerCase(), entry);
  return [...byKey.values()];
}
