import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PaperLibrary } from '../lib/library.js';
import { parseRange, servePaperFile, serveStaticAsset } from '../lib/http.js';

async function makeTempDir(t, tag) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-paper-${tag}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeLibrary(t) {
  const root = await makeTempDir(t, 'http');
  const pdfBytes = Buffer.from('%PDF-1.4\nfake pdf body for range tests\n%%EOF\n', 'utf8');
  const pdfPath = path.join(root, 'sample.pdf');
  await fs.writeFile(pdfPath, pdfBytes);
  await fs.writeFile(path.join(root, 'sample.tex'), '\\documentclass{article}', 'utf8');
  const outside = await makeTempDir(t, 'outside');
  const outsidePath = path.join(outside, 'outside.pdf');
  await fs.writeFile(outsidePath, pdfBytes);
  const library = new PaperLibrary({
    config: { roots: [root] },
    cwd: root,
    stateFile: path.join(root, '.paper-reader-roots.json'),
  });
  return { root, pdfPath, pdfBytes, outsidePath, library };
}

async function listen(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function routeHandler(library) {
  return (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/paper-reader/file') return servePaperFile(request, response, library);
    if (url.pathname.startsWith('/paper-reader/static/')) return serveStaticAsset(request, response, url.pathname);
    response.writeHead(404);
    response.end('nope');
  };
}

test('parseRange：完整/前缀/后缀/越界', () => {
  assert.deepEqual(parseRange('bytes=0-3', 100), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=0-1000', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=200-', 100), { invalid: true });
  assert.equal(parseRange('items=0-3', 100), null);
  assert.equal(parseRange(undefined, 100), null);
});

test('resolvePdf：只放行论文根目录内的 PDF', async (t) => {
  const { root, pdfPath, outsidePath, library } = await makeLibrary(t);
  assert.equal(await library.resolvePdf(pdfPath), await fs.realpath(pdfPath));
  assert.equal(await library.resolvePdf(path.join(root, 'sample.tex')), null, '非 PDF 拒绝');
  assert.equal(await library.resolvePdf(outsidePath), null, '根目录外拒绝');
  assert.equal(await library.resolvePdf(path.join(root, 'missing.pdf')), null, '不存在的文件拒绝');
  assert.equal(await library.resolvePdf(''), null, '空路径拒绝');
});

test('GET /paper-reader/file：整份、Range、越界、目录外', async (t) => {
  const { pdfPath, pdfBytes, outsidePath, library } = await makeLibrary(t);
  const base = await listen(t, routeHandler(library));
  const target = `${base}/paper-reader/file?path=${encodeURIComponent(pdfPath)}`;

  const full = await fetch(target);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'application/pdf');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), pdfBytes);

  const ranged = await fetch(target, { headers: { range: 'bytes=0-7' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${pdfBytes.length}`);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString('utf8'), '%PDF-1.4');

  const bad = await fetch(target, { headers: { range: `bytes=${pdfBytes.length + 5}-` } });
  assert.equal(bad.status, 416);

  const missing = await fetch(`${base}/paper-reader/file?path=${encodeURIComponent(path.join(path.dirname(pdfPath), 'ghost.pdf'))}`);
  assert.equal(missing.status, 404);

  const outside = await fetch(`${base}/paper-reader/file?path=${encodeURIComponent(outsidePath)}`);
  assert.equal(outside.status, 404, '论文根目录外的 PDF 不能读');
});

test('GET /paper-reader/static/pdfjs：vendor 文件与路径穿越', async (t) => {
  const { library } = await makeLibrary(t);
  const base = await listen(t, routeHandler(library));

  const version = await fetch(`${base}/paper-reader/static/pdfjs/VERSION`);
  assert.equal(version.status, 200);
  assert.match(await version.text(), /pdfjs-dist/);

  const main = await fetch(`${base}/paper-reader/static/pdfjs/build/pdf.min.mjs`);
  assert.equal(main.status, 200);
  assert.equal(main.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.ok((await main.text()).length > 1000);

  for (const attack of [
    `${base}/paper-reader/static/pdfjs/../../index.js`,
    `${base}/paper-reader/static/pdfjs/%2e%2e/%2e%2e/package.json`,
    `${base}/paper-reader/static/pdfjs/build/..%2f..%2f..%2findex.js`,
    `${base}/paper-reader/static/pdfjs/nope.txt`,
  ]) {
    const response = await fetch(attack);
    assert.equal(response.status, 404, `应拒绝 ${attack}`);
  }
});
