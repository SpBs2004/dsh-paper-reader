/**
 * 浏览器冒烟测试：用本机 Chrome 真跑一遍
 *   动态 import pdf.js → Worker → Range 读 PDF → Canvas 渲染 → TextLayer
 * 路由直接复用 lib/http.js 与 PaperLibrary，等价于面板里的请求路径。
 *
 * 用法：node scripts/browser-smoke.mjs [pdfPath] [screenshotPath]
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const shotPath = path.resolve(process.argv[3] ?? path.join(os.tmpdir(), 'dsh-pdf-smoke.png'));

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>pdf smoke</title>
<style>
  html,body { margin:0; padding:0; background:#e9ebef; }
  #wrap { position:relative; margin:20px auto; background:#fff; box-shadow:0 1px 5px rgba(0,0,0,.3); }
  #wrap canvas { display:block; }
  .textLayer { position:absolute; inset:0; overflow:hidden; line-height:1; transform-origin:0 0; }
  .textLayer span { position:absolute; white-space:pre; color:transparent; transform-origin:0% 0%; }
</style></head>
<body>
<div id="wrap"></div>
<div id="result" data-status="pending" style="font:13px sans-serif;padding:8px 20px">pending</div>
<script type="module">
import * as pdfjs from '/paper-reader/static/pdfjs/build/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/paper-reader/static/pdfjs/build/pdf.worker.min.mjs';
try {
  const doc = await pdfjs.getDocument({
    url: '/paper-reader/file?path=' + encodeURIComponent(${JSON.stringify(pdfPath)}),
    cMapUrl: '/paper-reader/static/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/paper-reader/static/pdfjs/standard_fonts/',
    isEvalSupported: false,
  }).promise;
  const page = await doc.getPage(1);
  const scale = 1.25;
  const viewport = page.getViewport({ scale });
  const wrap = document.getElementById('wrap');
  wrap.style.width = Math.ceil(viewport.width) + 'px';
  wrap.style.height = Math.ceil(viewport.height) + 'px';
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  wrap.appendChild(canvas);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const textDiv = document.createElement('div');
  textDiv.className = 'textLayer';
  textDiv.style.setProperty('--scale-factor', String(scale));
  wrap.appendChild(textDiv);
  const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
  await layer.render();
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) dark += 1;
  const result = document.getElementById('result');
  result.dataset.status = 'ok';
  result.dataset.pages = String(doc.numPages);
  result.dataset.spans = String(textDiv.children.length);
  result.dataset.dark = String(dark);
  result.textContent = 'ok ' + doc.numPages + ' pages, ' + textDiv.children.length + ' spans, ' + dark + ' dark px';
} catch (error) {
  const result = document.getElementById('result');
  result.dataset.status = 'error';
  result.textContent = 'FAIL ' + (error && error.message ? error.message : String(error));
}
</script></body></html>`;

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (chrome === undefined) throw new Error('没有找到 Chrome/Edge，无法做浏览器冒烟测试');

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
  const library = new PaperLibrary({
    config: { roots: [path.dirname(pdfPath)] },
    cwd: path.dirname(pdfPath),
    stateFile: path.join(os.tmpdir(), `dsh-pdf-smoke-roots-${process.pid}.json`),
  });
  const resolved = await library.resolvePdf(pdfPath);
  if (resolved === null) throw new Error(`PDF 不在论文根目录内：${pdfPath}`);

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/test.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page);
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
  console.log(`smoke server ${url}`);
  console.log(`pdf ${resolved}`);

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-profile-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--user-data-dir=' + profile,
      '--window-size=980,1320',
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
      /* 端口还没就绪 */
    }
    if (pageWs === undefined) await sleep(100);
  }
  if (pageWs === undefined) {
    child.kill();
    throw new Error('找不到测试页的 DevTools target');
  }

  const cdp = await cdpConnect(pageWs);
  await cdp.send('Page.enable');
  let data = {};
  let status = 'none';
  for (let i = 0; i < 160; i += 1) {
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: "JSON.stringify(document.getElementById('result')?.dataset ?? {})",
      returnByValue: true,
    });
    try {
      data = JSON.parse(evaluated.result.value ?? '{}');
    } catch {
      data = {};
    }
    status = data.status ?? 'none';
    if (status === 'ok' || status === 'error') break;
    await sleep(150);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  cdp.close();
  child.kill();
  server.close();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});

  if (status !== 'ok') throw new Error(`页面报告失败：${status} ${JSON.stringify(data)}`);
  if (!(Number(data.spans) > 50)) throw new Error(`文本层几乎为空：${data.spans} spans`);
  if (!(Number(data.dark) > 1000)) throw new Error(`画布几乎是空白：${data.dark} 个暗像素`);
  console.log(`OK pages=${data.pages} spans=${data.spans} dark=${data.dark} screenshot=${shotPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
