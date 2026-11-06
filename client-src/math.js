import { Fragment, createElement as h } from 'react';
import katex from 'katex';

const MATH_RE = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]+\$|\\\([\s\S]*?\\\))/g;
const KEYED = ['paragraph', 'math'];

/**
 * 用 KaTeX 的 MathML 输出渲染公式：浏览器原生排版，不需要 KaTeX 的 CSS 与字体资源。
 * 渲染失败时退回等宽源码，绝不因为一条公式让整块正文崩掉。
 */
export function renderMath(source, displayMode = false) {
  const tex = String(source ?? '').trim();
  if (tex === '') return null;
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      output: 'mathml',
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
    return h('span', {
      className: displayMode ? 'pr-mathml pr-mathml-display' : 'pr-mathml',
      dangerouslySetInnerHTML: { __html: html },
    });
  } catch {
    return h('code', { className: 'pr-math-src' }, tex);
  }
}

/** 把含 `$...$` / `$$...$$` / `\\(...\\)` / `\\[...\\]` 的正文切成 React 节点。 */
export function renderRich(text, keyPrefix = 'p') {
  const source = String(text ?? '');
  const nodes = [];
  let last = 0;
  let index = 0;
  MATH_RE.lastIndex = 0;
  let match;
  while ((match = MATH_RE.exec(source)) !== null) {
    if (match.index > last) nodes.push(source.slice(last, match.index));
    const raw = match[0];
    const display = raw.startsWith('$$') || raw.startsWith('\\[');
    const inner = display ? raw.slice(2, -2) : raw.slice(1, -1);
    nodes.push(h(Fragment, { key: `${keyPrefix}-m${KEYED.length}-${index}` }, renderMath(inner, display)));
    index += 1;
    last = match.index + raw.length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}
