/**
 * 面板 RPC：浏览器 → 宿主。
 *
 * 信封与 `connection.rpc.call(channel, endpoint, payload)` 对齐：
 *   请求 { type: 'client-request', method, payload, rpcId }
 *   响应 { type: 'server-response', rpcId, result: { ok, value } | { ok: false, error } }
 * 鉴权沿用宿主的 `connection.requestRejection`，并额外做同源检查。
 */
import { servePaperFile, serveStaticAsset } from './http.js';

export const PANEL_CHANNEL = '/paper-reader';

const MAX_BODY_BYTES = 1024 * 1024;

const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  try {
    return new URL(origin).host === (request.headers.host ?? '');
  } catch {
    return false;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const asString = (value) => (typeof value === 'string' ? value : '');
const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** 端点表：取参 → 调服务层 → 返回，业务判断全部在 PaperLibrary。 */
export function panelEndpoints(service) {
  return {
    state: () => service.state(),
    'roots/add': (payload) => service.addRoot(asString(payload.path)),
    'roots/remove': (payload) => service.removeRoot(asString(payload.path)),
    'roots/pick': () => service.pickDirectory(),
    'library/list': (payload) => service.list(asString(payload.root)),
    'paper/view': (payload) => service.view(asString(payload.id), { maxChars: asNumber(payload.maxChars) }),
    'paper/search': (payload) => service.search(asString(payload.id), asString(payload.query)),
    'paper/bib': (payload) => service.bib(asString(payload.id)),
    'paper/translate': (payload) =>
      service.translate(asString(payload.text), { targetLanguage: asString(payload.targetLanguage) }),
    'paper/review': (payload) => service.review(asString(payload.id), { maxChars: asNumber(payload.maxChars) ?? 60000 }),
    'notes/read': (payload) => service.notes(asString(payload.id)),
    'notes/append': (payload) =>
      service.appendNote(asString(payload.id), {
        kind: payload.entry?.kind,
        text: payload.entry?.text,
        quote: payload.entry?.quote,
        section: payload.entry?.section,
        page: asNumber(payload.entry?.page),
        line: asNumber(payload.entry?.line),
      }),
    'ask/target': () => service.targets(),
    'ask/send': (payload) =>
      service.ask({ sessionId: asString(payload.sessionId), text: asString(payload.text), requestId: payload.requestId }),
  };
}

/**
 * 注册面板 HTTP 路由。宿主没有 `webServer` 时静默跳过（智能体工具不受影响）。
 * 只用 façade 放行的 `ctx.get` / `ctx.on` / `ctx.effect`。
 */
export function registerPanelRpc(ctx, service) {
  const endpoints = panelEndpoints(service);
  const serviceOf = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get.call(ctx, name) : undefined;
    } catch {
      return undefined;
    }
  };

  let dispose;
  let registered = false;

  const handler = async (request, response) => {
    try {
      if (!sameOrigin(request)) {
        response.writeHead(403);
        response.end('cross-origin request refused');
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      // 浏览器原生请求：PDF 字节流 + pdf.js 运行时（见 lib/http.js）
      if (pathname === `${PANEL_CHANNEL}/file`) {
        await servePaperFile(request, response, service);
        return;
      }
      if (pathname.startsWith(`${PANEL_CHANNEL}/static/`)) {
        await serveStaticAsset(request, response, pathname);
        return;
      }
      const rejection = serviceOf('connection')?.requestRejection?.(request);
      if (rejection !== undefined) {
        response.writeHead(rejection);
        response.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405);
        response.end('method not allowed');
        return;
      }
      const endpoint = pathname.startsWith(`${PANEL_CHANNEL}/`)
        ? decodeURIComponent(pathname.slice(PANEL_CHANNEL.length + 1))
        : '';
      const entry = endpoints[endpoint];
      if (entry === undefined) {
        sendJson(response, 404, {
          type: 'server-response',
          rpcId: '',
          result: fail('unknown-endpoint', `未知端点 ${endpoint}（可用：${Object.keys(endpoints).join(', ')}）`),
        });
        return;
      }
      let message = {};
      try {
        const raw = await readBody(request);
        message = raw === '' ? {} : JSON.parse(raw);
      } catch {
        sendJson(response, 400, {
          type: 'server-response',
          rpcId: '',
          result: fail('bad-request', '请求体不是 JSON'),
        });
        return;
      }
      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : '';
      if (message.type !== 'client-request' || message.method !== endpoint) {
        sendJson(response, 400, {
          type: 'server-response',
          rpcId,
          result: fail('bad-envelope', '请求信封非法'),
        });
        return;
      }
      const payload = message.payload !== null && typeof message.payload === 'object' ? message.payload : {};
      let result;
      try {
        result = ok(await entry(payload));
      } catch (error) {
        result = fail('internal', error instanceof Error ? error.message : String(error));
      }
      sendJson(response, 200, { type: 'server-response', rpcId, result });
    } catch {
      try {
        response.writeHead(500);
        response.end('handler failure');
      } catch {
        /* 响应已结束 */
      }
    }
  };

  const registerWith = (webServer) => {
    if (registered) return;
    const disposing = webServer.register({ kind: 'prefix', path: PANEL_CHANNEL, handler });
    registered = true;
    dispose = () => {
      try {
        void disposing();
      } catch {
        /* 卸载期清理失败不影响其它插件 */
      }
    };
  };

  const effect = ctx.effect;
  if (typeof effect === 'function') {
    effect.call(
      ctx,
      () => () => {
        dispose?.();
        dispose = undefined;
        registered = false;
      },
      'paper-reader: panel rpc',
    );
  }

  const existing = serviceOf('webServer');
  if (existing !== undefined && typeof existing.register === 'function') {
    registerWith(existing);
    if (registered) return;
  }

  const inject = ctx.inject;
  if (typeof inject === 'function') {
    try {
      inject.call(ctx, ['webServer'], (scope) => {
        const webServer = scope?.webServer;
        if (webServer !== undefined && typeof webServer.register === 'function') registerWith(webServer);
      });
      return;
    } catch {
      /* façade 上没有 inject，退回 internal/service 事件 */
    }
  }
  const on = ctx.on;
  if (typeof on === 'function') {
    on.call(ctx, 'internal/service', (name) => {
      if (name !== 'webServer') return;
      const webServer = serviceOf('webServer');
      if (webServer !== undefined && typeof webServer.register === 'function') registerWith(webServer);
    });
  }
}
