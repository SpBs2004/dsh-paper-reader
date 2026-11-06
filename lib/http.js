/**
 * 面板的只读 HTTP 资源：
 *   GET /paper-reader/file?path=<绝对路径>   → 流式返回论文根目录内的 PDF 字节（支持 Range）
 *   GET /paper-reader/static/pdfjs/<相对路径> → pdf.js 运行时与字体/cmaps
 *
 * 这两条路由给浏览器原生 fetch / 动态 import / Worker 使用，
 * 不能用 RPC 信封，也不做宿主 `connection.requestRejection`（它只认 RPC 客户端），
 * 依赖 DSH Web 自身的会话鉴权（未登录请求在更外层就被 401 拦掉）。
 */
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATIC_ROOT = path.join(here, '..', 'vendor', 'pdfjs');

const MIME = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

/** Windows 盘符大小写不敏感；路径包含判断用统一小写 + 分隔符归一。 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 解析 `Range: bytes=...`；返回 null=不支持/忽略，{invalid}=416。 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  let start = match[1] === '' ? null : Number.parseInt(match[1], 10);
  let end = match[2] === '' ? null : Number.parseInt(match[2], 10);
  if (start === null && end === null) return null;
  if (!Number.isFinite(start) && start !== null) return null;
  if (!Number.isFinite(end) && end !== null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start < 0 || end < 0 || start > end || start >= size) return { invalid: true };
  return { start, end };
}

function notFound(response, text = 'not found') {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

function sendRangeNotSatisfiable(response, size) {
  response.writeHead(416, {
    'content-type': 'text/plain; charset=utf-8',
    'content-range': `bytes */${size}`,
    'cache-control': 'no-store',
  });
  response.end('range not satisfiable');
}

/** 统一流式响应（GET/HEAD）。 */
function streamFile(request, response, filePath, { size, mtimeMs }, { cacheControl, contentType, name }) {
  const range = request.method === 'HEAD' ? null : parseRange(request.headers.range, size);
  const base = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
    'last-modified': new Date(mtimeMs).toUTCString(),
    'x-content-type-options': 'nosniff',
  };
  if (range !== null && range.invalid === true) {
    sendRangeNotSatisfiable(response, size);
    return;
  }
  const start = range === null ? 0 : range.start;
  const end = range === null ? size - 1 : range.end;
  const length = Math.max(0, end - start + 1);
  const headers = { ...base, 'content-length': String(length) };
  if (range !== null) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  if (typeof name === 'string' && name !== '') {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    headers['content-disposition'] = `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  response.writeHead(range === null ? 200 : 206, headers);
  if (request.method === 'HEAD' || length === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(filePath, { start, end });
  stream.on('error', () => {
    try {
      response.destroy();
    } catch {
      /* 连接已断开 */
    }
  });
  stream.pipe(response);
}

/** `/paper-reader/file?path=...`：只允许论文根目录内的 PDF。 */
export async function servePaperFile(request, response, service) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end('method not allowed');
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const requested = url.searchParams.get('path') ?? '';
  const resolved = await service.resolvePdf(requested);
  if (resolved === null) {
    notFound(response, 'pdf not found under paper roots');
    return;
  }
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    notFound(response, 'pdf not readable');
    return;
  }
  streamFile(request, response, resolved, { size: stat.size, mtimeMs: stat.mtimeMs }, {
    cacheControl: 'private, max-age=0, must-revalidate',
    contentType: 'application/pdf',
    name: path.basename(resolved),
  });
}

/** `/paper-reader/static/pdfjs/<rel>`：只读 vendor 目录里的白名单扩展名。 */
export async function serveStaticAsset(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end('method not allowed');
    return;
  }
  const prefix = '/paper-reader/static/pdfjs/';
  if (!pathname.startsWith(prefix)) {
    notFound(response);
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    notFound(response);
    return;
  }
  if (rel === '' || rel.includes('\0')) {
    notFound(response);
    return;
  }
  const resolved = path.resolve(STATIC_ROOT, rel);
  const ext = path.extname(resolved).toLowerCase();
  const allowed = MIME[ext] !== undefined || path.basename(resolved) === 'VERSION';
  if (!isInside(path.resolve(STATIC_ROOT), resolved) || !allowed) {
    notFound(response);
    return;
  }
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    notFound(response);
    return;
  }
  if (!stat.isFile()) {
    notFound(response);
    return;
  }
  streamFile(request, response, resolved, { size: stat.size, mtimeMs: stat.mtimeMs }, {
    cacheControl: 'public, max-age=86400',
    contentType: MIME[ext] ?? 'text/plain; charset=utf-8',
    name: path.basename(resolved),
  });
}
