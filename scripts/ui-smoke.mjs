/**
 * 界面冒烟测试：把真实的 PaperReaderPanel 挂到无头 Chrome 里，
 * 走一遍「打开 PDF → 页面渲染 → 缩放 → 切文本 → 切回页面 → 划选原文」。
 *
 * 用法：node scripts/ui-smoke.mjs [pdfPath] [screenshotPath]
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PaperLibrary } from '../lib/library.js';
import { servePaperFile, serveStaticAsset } from '../lib/http.js';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PDF = path.join(here, 'test', 'fixtures', 'sample.pdf');
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const pdfPath = path.resolve(process.argv[2] ?? DEFAULT_PDF);
const shotPath = path.resolve(process.argv[3] ?? path.join(os.tmpdir(), 'dsh-ui-smoke.png'));
const pdfDir = path.dirname(pdfPath);

// 演示 PDF 的页数和标题从文件本身读取，冒烟断言不再写死页数。
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdfBytes = await fs.readFile(pdfPath);
const pdfDoc = await getDocument({ data: new Uint8Array(pdfBytes), isEvalSupported: false }).promise;
const pdfMeta = await pdfDoc.getMetadata().catch(() => null);
const PDF_PAGES = pdfDoc.numPages;
const PDF_TITLE = String(pdfMeta?.info?.Title ?? '').trim() || path.basename(pdfPath, path.extname(pdfPath));
const PDF_AUTHORS = String(pdfMeta?.info?.Author ?? '').trim() || 'Demo Author';
const OUTLINE_PAGES = [1, Math.min(2, PDF_PAGES), PDF_PAGES];

const ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PaperReaderPanel } from './client-src/panel.js';
import { PANEL_CSS } from './client-src/styles.js';
import { interpolate, lookup } from './client-src/i18n.js';
import zh from './locale/zh.json';

const style = document.createElement('style');
style.textContent = PANEL_CSS;
document.head.appendChild(style);

const PAPER = {
  id: 'smoke-pdf',
  title: ${JSON.stringify(PDF_TITLE)},
  kind: 'pdf',
  path: ${JSON.stringify(pdfPath)},
  authors: ${JSON.stringify(PDF_AUTHORS)},
  outline: [
    { id: 's1', level: 1, title: 'I. INTRODUCTION', page: ${OUTLINE_PAGES[0]}, ordinal: 0 },
    { id: 's2', level: 1, title: 'II. PROBLEM FORMULATION', page: ${OUTLINE_PAGES[1]}, ordinal: 1 },
    { id: 's3', level: 1, title: 'III. MAIN RESULTS', page: ${OUTLINE_PAGES[2]}, ordinal: 2 },
  ],
  blocks: [
    { kind: 'page', page: 1 },
    { kind: 'heading', level: 1, text: 'I. INTRODUCTION', page: 1, sectionId: 's1' },
    { kind: 'para', text: 'text mode paragraph from the extracted text layer.', page: 1, sectionId: 's1' },
  ],
  truncated: false,
  pages: ${PDF_PAGES},
  hasText: true,
  error: null,
};

const api = {
  async state() {
    return { roots: [{ path: ${JSON.stringify(pdfDir)}, exists: true, count: 1, source: 'config', removable: true }], defaultRoot: ${JSON.stringify(pdfDir)} };
  },
  async list() {
    return { papers: [{ id: PAPER.id, title: PAPER.title, kind: 'pdf', bytes: 362160, mtime: Date.now(), relPath: ${JSON.stringify(path.basename(pdfPath))} }] };
  },
  async view() {
    return PAPER;
  },
  async notesRead() {
    return { path: '', exists: false, markdown: '' };
  },
  async targets() {
    return { sessions: [] };
  },
};
const t = (key, params) => interpolate(lookup(zh.ui, key) ?? key, params);

createRoot(document.getElementById('root')).render(
  React.createElement(PaperReaderPanel, {
    api,
    ctx: { get() { return undefined; } },
    t,
    tracker: { current: () => null },
  }),
);
`;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ui smoke</title>
<style>html,body,#root{height:100%;margin:0;} body{background:#e9ebef;}</style>
</head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>`;

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (chrome === undefined) throw new Error('没有找到 Chrome/Edge');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return;
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'CDP error'));
      else waiter.resolve(message.result);
    });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = (nextId += 1);
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP 超时：${method}`));
              }
            }, 15000).unref?.();
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            /* 忽略 */
          }
        },
      }),
    );
  });
}

async function main() {
  const bundled = await build({
    stdin: { contents: ENTRY, resolveDir: here, loader: 'js', sourcefile: 'ui-smoke-entry.js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: ['chrome110'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const uiJs = bundled.outputFiles[0].text;

  const library = new PaperLibrary({
    config: { roots: [pdfDir] },
    cwd: pdfDir,
    stateFile: path.join(os.tmpdir(), `dsh-ui-smoke-roots-${process.pid}.json`),
  });
  const resolved = await library.resolvePdf(pdfPath);
  if (resolved === null) throw new Error(`PDF 不在论文根目录内：${pdfPath}`);

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/test.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(PAGE);
      return;
    }
    if (url.pathname === '/ui.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(uiJs);
      return;
    }
    if (url.pathname === '/paper-reader/file') {
      servePaperFile(request, response, library).catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
      return;
    }
    if (url.pathname.startsWith('/paper-reader/static/')) {
      serveStaticAsset(request, response, url.pathname).catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/test.html`;
  console.log('ui smoke', url, 'bundle', (uiJs.length / 1024).toFixed(0), 'KiB');

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-ui-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--user-data-dir=' + profile,
      '--window-size=1440,900',
      '--remote-debugging-port=0',
      url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let wsUrl;
  for (let i = 0; i < 120 && wsUrl === undefined; i += 1) {
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
    if (match !== null) wsUrl = match[1];
    else await sleep(100);
  }
  if (wsUrl === undefined) {
    child.kill();
    throw new Error(`Chrome 没有给出 DevTools 地址：${stderr.slice(-800)}`);
  }
  const httpBase = wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');
  let pageWs;
  for (let i = 0; i < 80 && pageWs === undefined; i += 1) {
    try {
      const response = await fetch(`${httpBase}/json/list`);
      const targets = await response.json();
      pageWs = targets.find((target) => target.type === 'page' && target.url.includes('/test.html'))?.webSocketDebuggerUrl;
    } catch {
      /* 等待 */
    }
    if (pageWs === undefined) await sleep(100);
  }
  if (pageWs === undefined) {
    child.kill();
    throw new Error('找不到测试页 target');
  }
  const cdp = await cdpConnect(pageWs);
  await cdp.send('Page.enable');

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 30000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(150);
    }
    throw new Error(`等待超时：${label}`);
  };

  const pageErrors = [];
  await cdp.send('Runtime.enable');
  await evaluate('window.__smokeErrors = []; window.addEventListener("error", (e) => window.__smokeErrors.push(String(e.message))); 1');

  try {
    await waitFor("document.querySelectorAll('.pr-item').length === 1", '论文列表');
    await evaluate("document.querySelector('.pr-item').click(); 1");
    await waitFor(`document.querySelectorAll('[data-pdf-page]').length === ${PDF_PAGES}`, 'PDF 页数');

    await waitFor(
      "(() => { const c = document.querySelector('[data-pdf-page=\"1\"] canvas'); return c && c.width > 0 && c.height > 0 && document.querySelectorAll('[data-pdf-page=\"1\"] .pr-pdf-text span').length > 0; })()",
      '第一页画布与文本层',
    );
    const initial = await evaluate(`(() => {
      const page = document.querySelector('[data-pdf-page="1"]');
      const canvas = page.querySelector('canvas');
      const toolbar = document.querySelector('.pr-pdf-toolbar');
      return {
        pages: document.querySelectorAll('[data-pdf-page]').length,
        canvas: { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width },
        pageWidth: page.getBoundingClientRect().width,
        toolbarText: toolbar ? toolbar.innerText.replace(/\\n/g, ' | ') : null,
        toolbarButtons: toolbar ? toolbar.querySelectorAll('button').length : 0,
        spans: document.querySelectorAll('[data-pdf-page="1"] .pr-pdf-text span').length,
      };
    })()`);
    console.log('initial', JSON.stringify(initial));

    await evaluate(`document.querySelector('[title="放大"]').click(); 1`);
    await waitFor(
      `(() => { const el = document.querySelector('[data-pdf-page="1"]'); return el && el.getBoundingClientRect().width > ${initial.pageWidth} + 2; })()`,
      '放大',
    );
    const zoomed = await evaluate(`document.querySelector('[data-pdf-page="1"]').getBoundingClientRect().width`);
    await evaluate(`document.querySelector('[title="适宽"]').click(); 1`);
    await waitFor(
      `(() => { const el = document.querySelector('[data-pdf-page="1"]'); return el && Math.abs(el.getBoundingClientRect().width - ${initial.pageWidth}) < 2; })()`,
      '适宽恢复',
    );

    await evaluate(`(() => { const b = [...document.querySelectorAll('.pr-doc-actions button')].find((x) => x.textContent === '文本模式'); b?.click(); return !!b; })()`);
    await waitFor("!document.querySelector('.pr-article-pdf') && !!document.querySelector('.pr-article-inner')", '文本模式');
    const textMode = await evaluate(`({
      hasTextBlock: (document.querySelector('.pr-article-inner')?.innerText ?? '').includes('text mode paragraph'),
      modeButton: [...document.querySelectorAll('.pr-doc-actions button')].some((x) => x.textContent === '页面阅读'),
    })`);
    console.log('textMode', JSON.stringify(textMode));

    await evaluate(`(() => { const b = [...document.querySelectorAll('.pr-doc-actions button')].find((x) => x.textContent === '页面阅读'); b?.click(); return !!b; })()`);
    await waitFor(`document.querySelectorAll('[data-pdf-page]').length === ${PDF_PAGES}`, '切回页面');
    await waitFor(
      "(() => { const c = document.querySelector('[data-pdf-page=\"1\"] canvas'); return c && c.width > 0; })()",
      '重渲染第一页',
    );

    const selection = await evaluate(`(() => {
      const page = document.querySelector('[data-pdf-page="1"]');
      const spans = [...page.querySelectorAll('.pr-pdf-text span')].filter((s) => (s.textContent || '').trim().length > 2);
      if (spans.length < 8) return { error: 'not enough spans', spans: spans.length };
      const a = spans[8];
      const b = spans[14];
      const range = document.createRange();
      range.setStart(a.firstChild ?? a, 0);
      range.setEnd(b.firstChild ?? b, Math.min(18, (b.textContent || '').length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      page.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 300 }));
      return { text: sel.toString().replace(/\\s+/g, ' ').slice(0, 90), spans: spans.length };
    })()`);
    await waitFor("!!document.querySelector('.pr-selbar')", '选区浮条');
    const selbar = await evaluate(`(() => {
      const bar = document.querySelector('.pr-selbar');
      return { selbar: bar !== null, buttons: bar ? [...bar.querySelectorAll('button')].map((x) => x.textContent) : [] };
    })()`);
    console.log('selection', JSON.stringify({ ...selection, ...selbar }));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    const runtimeErrors = await evaluate('window.__smokeErrors ?? []');
    if (Array.isArray(runtimeErrors) && runtimeErrors.length > 0) pageErrors.push(...runtimeErrors);

    const failures = [];
    if (initial.pages !== PDF_PAGES) failures.push(`页数 ${initial.pages}`);
    if (!(initial.canvas.width > 500)) failures.push('画布宽度异常');
    if (!(initial.spans > 20)) failures.push(`文本层 ${initial.spans} spans`);
    if (initial.toolbarButtons < 6) failures.push('工具栏按钮不足');
    if (!(zoomed > initial.pageWidth + 2)) failures.push('放大无效');
    if (!textMode.hasTextBlock) failures.push('文本模式没显示提取文本');
    if (!textMode.modeButton) failures.push('文本模式缺切回按钮');
    if (!selbar.selbar) failures.push('划选后没有浮条');
    if (!Array.isArray(selbar.buttons) || selbar.buttons.length < 5) failures.push('浮条按钮不全');
    if (pageErrors.length > 0) failures.push(`页面错误：${pageErrors.join('; ')}`);

    if (failures.length > 0) throw new Error(failures.join(' / '));
    console.log(`OK screenshot=${shotPath}`);
  } finally {
    cdp.close();
    child.kill();
    server.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
