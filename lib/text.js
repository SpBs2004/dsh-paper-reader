/**
 * 纯文本与 LaTeX 词法小工具。不依赖任何宿主服务，方便单测。
 */

/** 把 Windows 路径统一成正斜杠（仅用于显示与比对，不用于 fs 访问）。 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 取基名（不含扩展名）。 */
export function baseName(filePath) {
  const normalized = toPosix(filePath);
  const file = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/** 取扩展名（小写，不含点）。 */
export function extensionOf(filePath) {
  const normalized = toPosix(filePath);
  const file = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
}

/**
 * 从 `open` 位置（必须指向左花括号）读取一个配平的 `{...}` 组。
 * 返回组内文本与 `}` 之后的位置；未配平时返回 undefined。
 */
export function readBraceGroup(text, open) {
  if (text[open] !== '{') return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { text: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return undefined;
}

/**
 * 读取命令后面的可选方括号参数 `[...]`；不存在时返回空串。
 */
export function readOptionalBracket(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] !== '[') return { text: '', end: start };
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '\\') {
      j += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return { text: text.slice(i + 1, j), end: j + 1 };
    }
  }
  return { text: '', end: start };
}

/** 收集一段文本里所有 `\cmd{...}` 的第一个参数。 */
export function collectCommandArgs(text, command) {
  const out = [];
  const needle = `\\${command}`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    const after = text[at + needle.length];
    if (after !== undefined && /[a-zA-Z]/.test(after)) {
      from = at + needle.length;
      continue;
    }
    let i = at + needle.length;
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t')) i += 1;
    const group = readBraceGroup(text, i);
    if (group === undefined) {
      from = at + needle.length;
      continue;
    }
    out.push(group.text);
    from = group.end;
  }
  return out;
}

/** 去掉 LaTeX 注释（保留转义的 `\%`）。 */
export function stripComments(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== '%') continue;
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) backslashes += 1;
      if (backslashes % 2 === 0) {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join('\n');
}

const FORMAT_MACROS = [
  'emph',
  'textit',
  'textbf',
  'textsc',
  'texttt',
  'textrm',
  'textsf',
  'underline',
  'mbox',
  'hbox',
  'text',
  'url',
];

const DROP_WITH_ARG = [
  'label',
  'vspace',
  'hspace',
  'setlength',
  'addtolength',
  'begin',
  'end',
  'index',
  'bibliography',
  'bibliographystyle',
  'pagestyle',
  'thispagestyle',
  'documentclass',
  'usepackage',
  'newcommand',
  'renewcommand',
  'graphicspath',
  'includegraphics',
  'caption',
  'centering',
  'noindent',
  'indent',
  'smallskip',
  'medskip',
  'bigskip',
  'hfill',
  'vfill',
  'newline',
  'pagebreak',
  'protect',
  'relax',
  'nonumber',
  'notag',
  'thanks',
];

const SYMBOLS = [
  ['\\%', '%'],
  ['\\&', '&'],
  ['\\_', '_'],
  ['\\#', '#'],
  ['\\$', '$'],
  ['\\{', '{'],
  ['\\}', '}'],
  ['\\ldots', '…'],
  ['\\dots', '…'],
  ['\\cdots', '⋯'],
  ['\\textbackslash', '\\'],
  ['\\LaTeX', 'LaTeX'],
  ['\\TeX', 'TeX'],
  ['\\,', ' '],
  ['\\;', ' '],
  ['\\:', ' '],
  ['\\!', ''],
  ['\\ ', ' '],
  ['~~', ' '],
  ['~', ' '],
  ['---', '—'],
  ['--', '–'],
  ['``', '“'],
  ["''", '”'],
  ['`', '‘'],
];

/** 把 `\cite{a,b}` 变成 `[a, b]`，保留可点击感。 */
function replaceCitations(text) {
  return text.replace(/\\(?:cite|citep|citet|parencite|textcite)\*?(?:\[[^\]]*\])*\{([^{}]*)\}/g, (_m, keys) => {
    const list = keys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    return list.length > 0 ? `[${list.join(', ')}]` : '';
  });
}

function replaceRefs(text) {
  return text
    .replace(/\\(?:ref|autoref|cref|Cref)\{([^{}]*)\}/g, (_m, label) => `(${label})`)
    .replace(/\\eqref\{([^{}]*)\}/g, (_m, label) => `(${label})`);
}

function replaceFormatMacros(text) {
  let out = text;
  for (const macro of FORMAT_MACROS) {
    const re = new RegExp(`\\\\${macro}\\*?\\s*\\{`, 'g');
    let match;
    while ((match = re.exec(out)) !== null) {
      const open = match.index + match[0].length - 1;
      const group = readBraceGroup(out, open);
      if (group === undefined) break;
      const inner = macro === 'href' ? group.text.replace(/^[^{}]*\{/, '{') : group.text;
      out = `${out.slice(0, match.index)}${macro === 'href' ? '' : inner}${out.slice(group.end)}`;
      re.lastIndex = Math.max(0, match.index);
    }
  }
  return out;
}

function dropCommands(text) {
  let out = text;
  for (const macro of DROP_WITH_ARG) {
    const re = new RegExp(`\\\\${macro}\\*?(?:\\[[^\\]]*\\])?\\s*\\{`, 'g');
    let match;
    while ((match = re.exec(out)) !== null) {
      const open = match.index + match[0].length - 1;
      const group = readBraceGroup(out, open);
      if (group === undefined) break;
      out = `${out.slice(0, match.index)}${out.slice(group.end)}`;
      re.lastIndex = Math.max(0, match.index);
    }
  }
  // 无参数的命令
  out = out.replace(/\\(?:noindent|centering|small|footnotesize|normalsize|large|Large|hfill|vfill|newline|linebreak|par|quad|qquad)\b/g, '');
  return out;
}

/**
 * 把 LaTeX 片段变成可读纯文本：保留 `$...$`、`\[...\]` 数学片段原样，
 * 只处理周围的排版命令。
 */
export function detex(text) {
  if (!text) return '';
  let out = String(text);
  // 先把行间数学环境变成 \[...\]，让后面的“藏起来”一步统一处理
  out = out.replace(
    /\\begin\{(equation|equation\*|align|align\*|gather|gather\*|multline|multline\*|eqnarray|eqnarray\*)\}/g,
    (m) => m,
  );
  out = out.replace(
    /\\begin\{(equation|align|gather|multline|eqnarray)\*?\}([\s\S]*?)\\end\{\1\*?\}/g,
    (_m, _env, body) => `\\[${body}\\]`,
  );
  out = out.replace(/\\href\{([^{}]*)\}\{([^{}]*)\}/g, '$2');
  // 数学环境先“藏起来”
  const stashed = [];
  const stash = (snippet) => {
    stashed.push(snippet);
    return `\u0000M${stashed.length - 1}\u0000`;
  };
  out = out.replace(/\\\[[\s\S]*?\\\]/g, (m) => stash(m));
  out = out.replace(/\$\$[\s\S]*?\$\$/g, (m) => stash(m));
  out = out.replace(/\\\([\s\S]*?\\\)/g, (m) => stash(m));
  out = out.replace(/\$[^$\n]*\$/g, (m) => stash(m));

  out = replaceCitations(out);
  out = replaceRefs(out);
  out = replaceFormatMacros(out);
  out = dropCommands(out);
  out = out.replace(/\\item\b(?:\[[^\]]*\])?/g, '\n• ');
  out = out.replace(/\\(?:begin|end)\{[^{}]*\}/g, '');
  out = out.replace(/\\\\/g, '\n');
  out = out.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, '');
  for (const [from, to] of SYMBOLS) out = out.split(from).join(to);
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.replace(/\u0000M(\d+)\u0000/g, (_m, i) => stashed[Number(i)]);
  return out.trim();
}

/** 把多行块拼成一个段落：合并软换行，保留空行分段。 */
export function joinParagraph(lines) {
  const text = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/** 稳定短 id：sha1 前 12 位。 */
export async function shortHash(input) {
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(String(input)).digest('hex').slice(0, 12);
}

/** 人类可读时间（本地时区）。 */
export function formatStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把字节数变成可读尺寸。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
