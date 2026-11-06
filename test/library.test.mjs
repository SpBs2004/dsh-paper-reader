import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { PaperLibrary } from '../lib/library.js';

async function makeLibrary(source) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pr-test-'));
  await fs.writeFile(path.join(root, 'paper.tex'), source, 'utf8');
  const library = new PaperLibrary({
    config: { roots: [root], notes: { suffix: '.notes.md' } },
    ctx: { get: () => undefined },
    cwd: root,
    stateFile: path.join(root, '.paper-reader', 'roots.json'),
  });
  return { root, library };
}

test('扫描 → 解析 → 笔记追加/读取', async () => {
  const { root, library } = await makeLibrary(String.raw`\documentclass{article}
\title{Tiny Paper}
\begin{document}
\begin{abstract}
Short abstract.
\end{abstract}
\section{Intro}
Body text.
\end{document}
`);
  try {
    const papers = await library.scan();
    assert.equal(papers.length, 1);
    assert.equal(papers[0].kind, 'tex');
    assert.equal(papers[0].title, 'Tiny Paper');

    const view = await library.view(papers[0].id);
    assert.equal(view.title, 'Tiny Paper');
    assert.equal(view.outline.length, 2);
    assert.ok(view.error === null || view.error === undefined);

    const missing = await library.notes(papers[0].id);
    assert.equal(missing.exists, false);

    const written = await library.appendNote(papers[0].id, {
      kind: 'quote',
      quote: 'Body text.',
      text: '这是我的理解。',
      section: 'Intro',
      line: 7,
    });
    assert.match(written.path, /paper\.notes\.md$/);
    const noteFile = await fs.readFile(written.path, 'utf8');
    assert.match(noteFile, /^# Tiny Paper/);
    assert.match(noteFile, /摘录/);
    assert.match(noteFile, /> Body text\./);
    assert.match(noteFile, /这是我的理解。/);

    const second = await library.appendNote(papers[0].id, { kind: 'question', text: '为什么？' });
    assert.equal(second.appended, true);
    const after = await library.notes(papers[0].id);
    assert.equal(after.exists, true);
    assert.equal(after.count, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('空笔记被拒绝而不是写一个空条目', async () => {
  const { root, library } = await makeLibrary(String.raw`\begin{document}\section{A}text\end{document}`);
  try {
    const papers = await library.scan();
    await assert.rejects(() => library.appendNote(papers[0].id, { kind: 'insight', text: '   ' }), /笔记内容为空/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('找不到论文时 view 抛错', async () => {
  const { root, library } = await makeLibrary(String.raw`\begin{document}\section{A}text\end{document}`);
  try {
    await assert.rejects(() => library.view('nope'), /找不到论文/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('运行时增删论文目录并持久化', async () => {
  const { root, library } = await makeLibrary(String.raw`\begin{document}\section{A}text\end{document}`);
  try {
    const extra = path.join(root, 'extra');
    await fs.mkdir(extra);
    await fs.writeFile(path.join(extra, 'b.tex'), String.raw`\begin{document}\section{B}body\end{document}`, 'utf8');

    const before = await library.state();
    assert.equal(before.roots.length, 1);
    assert.equal(before.roots[0].path, root);
    assert.equal(before.roots[0].source, 'cwd');
    assert.equal(before.roots[0].removable, true);

    const added = await library.addRoot(extra);
    assert.equal(added.roots.length, 2);
    assert.equal(added.roots[1].source, 'user');
    assert.equal(added.roots[1].count, 1);
    assert.equal((await library.scan()).length, 2);

    // 另一个实例读同一个状态文件也能看到新目录
    const second = new PaperLibrary({
      config: { roots: [root] },
      ctx: { get: () => undefined },
      cwd: root,
      stateFile: path.join(root, '.paper-reader', 'roots.json'),
    });
    assert.equal((await second.scan()).length, 2);

    const removed = await second.removeRoot(extra);
    assert.equal(removed.roots.length, 1);
    // extra 位于工作目录内部，移除的只是“单独一层根目录”，文件仍在工作目录的扫描范围里
    assert.equal((await second.scan()).length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('搜索限定在解析出的块里', async () => {
  const { root, library } = await makeLibrary(String.raw`\begin{document}
\section{Alpha}
The quick brown fox.
\section{Beta}
Jumped over the lazy dog.
\end{document}`);
  try {
    const papers = await library.scan();
    const hit = await library.search(papers[0].id, 'brown fox');
    assert.equal(hit.total, 1);
    assert.equal(hit.matches[0].sectionId, 's0', 'Alpha 是第一个 section');
    const miss = await library.search(papers[0].id, 'zebra');
    assert.equal(miss.total, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
