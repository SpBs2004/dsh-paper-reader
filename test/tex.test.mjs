import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBib, parseTex } from '../lib/tex.js';
import { detex, stripComments } from '../lib/text.js';

const SAMPLE = String.raw`
\documentclass{article}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}{Lemma}
\title{Attention Is All You Need}
\author{Alice \and Bob}
\begin{document}
\maketitle
\begin{abstract}
We study $x+y$ with 50\% noise.
\end{abstract}
\section{Introduction}
Hello \cite{vaswani2017} and see \ref{thm:main}. % 这行注释要消失
Another sentence in the same paragraph.
\section{Method}
\begin{theorem}\label{thm:main}
Let $f$ be convex. Then $f$ is continuous.
\end{theorem}
\begin{proof}
Standard; see \cite{rockafellar1970}.
\end{proof}
\subsection{Details}
More text here.
\begin{equation}\label{eq:one}
a = b
\end{equation}
\section*{Acknowledgment}
Thanks.
\end{document}
`;

test('标题、作者、摘要在 preamble 与正文两种写法下都能取到', () => {
  const parsed = parseTex(SAMPLE);
  assert.equal(parsed.meta.title, 'Attention Is All You Need');
  assert.equal(parsed.meta.authors, 'Alice, Bob');
  assert.match(parsed.meta.abstract, /We study/);
  assert.match(parsed.meta.abstract, /50% noise/, '转义的百分号要还原成字面量');
  assert.doesNotMatch(parsed.meta.abstract, /这行注释/, '注释内容不进摘要');
});

test('章节树含 Abstract 与层级', () => {
  const parsed = parseTex(SAMPLE);
  const titles = parsed.sections.map((section) => `${section.level}:${section.title}`);
  assert.deepEqual(titles, ['1:Abstract', '1:Introduction', '1:Method', '2:Details', '1:Acknowledgment']);
  assert.ok(parsed.sections.every((section) => section.line > 0));
});

test('定理按节编号并保留行号', () => {
  const parsed = parseTex(SAMPLE);
  const theorem = parsed.blocks.find((block) => block.kind === 'theorem');
  assert.equal(theorem.name, 'Theorem');
  assert.equal(theorem.number, '2.1', '\\newtheorem{theorem}{Theorem}[section] → 第 2 节第 1 个');
  assert.ok(theorem.line > 0);
  assert.match(theorem.text, /\$f\$/);
  assert.ok(parsed.blocks.some((block) => block.kind === 'proof'));
});

test('引用与标签：未定义的 ref 会被点名', () => {
  const parsed = parseTex(SAMPLE);
  assert.deepEqual([...parsed.labels].sort(), ['eq:one', 'thm:main']);
  assert.deepEqual(parsed.refs, ['thm:main']);
  assert.deepEqual(parsed.undefinedRefs, []);
  assert.deepEqual([...parsed.cites].sort(), ['rockafellar1970', 'vaswani2017']);
});

test('数学块去掉 label，引用计数正确', () => {
  const parsed = parseTex(SAMPLE);
  const math = parsed.blocks.find((block) => block.kind === 'math');
  assert.equal(math.text.trim(), 'a = b');
  assert.equal(parsed.mathCount, 1);
});

test('注释掉的章节不会被当成正文', () => {
  const parsed = parseTex(String.raw`
\begin{document}
\section{Real}
Text.
% \section{Ghost}
More.
\end{document}
`);
  assert.deepEqual(parsed.sections.map((section) => section.title), ['Real']);
  assert.ok(!parsed.blocks.some((block) => String(block.text ?? '').includes('Ghost')));
});

test('include 的内容被展开，行号落在 \\input 那一行', () => {
  const parsed = parseTex(String.raw`\begin{document}
\section{Intro}
before.
\input{sec2}
\end{document}`, {
    loadInclude: (name) => (name === 'sec2' ? '\\section{Extra}\nIncluded text.' : undefined),
  });
  assert.deepEqual(parsed.sections.map((section) => section.title), ['Intro', 'Extra']);
  const heading = parsed.blocks.find((block) => block.kind === 'heading' && block.text === 'Extra');
  const inputLine = parsed.blocks.find((block) => block.text === 'before.')?.line;
  assert.equal(heading.line, (inputLine ?? 0) + 1, 'Extra 落在 \\input 所在行的下一行附近');
});

test('detex 保留数学片段、替换引用', () => {
  assert.equal(detex(String.raw`See \cite{a,b} for $x_i$ and~\ref{a}.`), 'See [a, b] for $x_i$ and (a).');
  assert.equal(detex(String.raw`\emph{styled} and 50\% done`), 'styled and 50% done');
});

test('stripComments 保留转义百分号', () => {
  assert.equal(stripComments('a 50\\% b % gone\nc % gone too'), 'a 50\\% b \nc ');
});

test('parseBib 去重并取字段', () => {
  const entries = parseBib(`
@article{a1, title={First}, author={A and B}, year={2020}, journal={J}}
@book{a1, title={First again}, author={A}, year={2020}}
@inproceedings{b2, title = "Second", booktitle={Conf}, year=2021}
`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].key, 'a1');
  assert.equal(entries[0].title, 'First again');
  assert.equal(entries[1].venue, 'Conf');
});
