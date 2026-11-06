import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PANEL_CHANNEL, panelEndpoints, registerPanelRpc } from '../lib/rpc.js';

function makeService(overrides = {}) {
  const calls = [];
  const record = (name, value) => (...args) => {
    calls.push({ name, args });
    return value;
  };
  const service = {
    state: record('state', { roots: [] }),
    addRoot: record('addRoot', { roots: [] }),
    removeRoot: record('removeRoot', { roots: [] }),
    pickDirectory: record('pickDirectory', { supported: true, path: 'E:/picked' }),
    list: record('list', { papers: [] }),
    view: record('view', { id: 'x' }),
    search: record('search', { matches: [] }),
    bib: record('bib', { entries: [] }),
    translate: record('translate', { ok: true, text: 'translated' }),
    review: record('review', { brief: 'brief' }),
    notes: record('notes', { path: 'p', exists: false, markdown: '' }),
    appendNote: record('appendNote', { path: 'p', appended: true }),
    targets: record('targets', { sessions: [] }),
    ask: record('ask', { accepted: true }),
    ...overrides,
  };
  return { service, calls };
}

test('端点把 payload 映射成服务层参数', async () => {
  const { service, calls } = makeService();
  const endpoints = panelEndpoints(service);

  await endpoints['library/list']({ root: 'E:/papers' });
  assert.deepEqual(calls.at(-1), { name: 'list', args: ['E:/papers'] });

  await endpoints['paper/view']({ id: 'abc', maxChars: 1000 });
  assert.deepEqual(calls.at(-1), { name: 'view', args: ['abc', { maxChars: 1000 }] });

  await endpoints['notes/append']({
    id: 'abc',
    entry: { kind: 'quote', text: 't', quote: 'q', section: 'Intro', page: 3, line: 12 },
  });
  assert.deepEqual(calls.at(-1).args, [
    'abc',
    { kind: 'quote', text: 't', quote: 'q', section: 'Intro', page: 3, line: 12 },
  ]);

  await endpoints['ask/send']({ sessionId: 's1', text: 'hello' });
  assert.deepEqual(calls.at(-1).args, [{ sessionId: 's1', text: 'hello', requestId: undefined }]);

  await endpoints['paper/translate']({ text: 'hi', targetLanguage: 'en' });
  assert.deepEqual(calls.at(-1).args, ['hi', { targetLanguage: 'en' }]);

  await endpoints['roots/add']({ path: 'E:/papers' });
  assert.deepEqual(calls.at(-1), { name: 'addRoot', args: ['E:/papers'] });

  await endpoints['roots/remove']({ path: 42 });
  assert.deepEqual(calls.at(-1), { name: 'removeRoot', args: [''] });

  await endpoints['roots/pick']({});
  assert.equal(calls.at(-1).name, 'pickDirectory');

  // 非字符串参数被清成空串，避免把对象塞进路径/查询
  await endpoints['paper/search']({ id: 42, query: { bad: true } });
  assert.deepEqual(calls.at(-1).args, ['', '']);
});

function makeRequest({ method = 'POST', url = `${PANEL_CHANNEL}/state`, headers = {}, body = '' }) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8');
    },
  };
}

function makeResponse() {
  const record = { status: 0, headers: {}, body: '' };
  return {
    record,
    writeHead(status, headers) {
      record.status = status;
      record.headers = headers ?? {};
    },
    end(body) {
      record.body = body ?? '';
    },
  };
}

function makeCtx() {
  const routes = [];
  const ctx = {
    effect(fn) {
      fn();
      return () => {};
    },
    on() {
      return () => {};
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route);
            return () => {};
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, routes };
}

test('RPC 信封：成功响应带 rpcId 与 result.ok', async () => {
  const { service } = makeService();
  const { ctx, routes } = makeCtx();
  registerPanelRpc(ctx, service);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, PANEL_CHANNEL);

  const response = makeResponse();
  await routes[0].handler(
    makeRequest({
      body: JSON.stringify({ type: 'client-request', method: 'state', payload: {}, rpcId: 'r1' }),
    }),
    response,
  );
  assert.equal(response.record.status, 200);
  const parsed = JSON.parse(response.record.body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.rpcId, 'r1');
  assert.equal(parsed.result.ok, true);
  assert.deepEqual(parsed.result.value, { roots: [] });
});

test('RPC 信封：未知端点 404、信封非法 400、服务层异常转成 ok:false', async () => {
  const { service } = makeService({
    list: () => {
      throw new Error('boom');
    },
  });
  const { ctx, routes } = makeCtx();
  registerPanelRpc(ctx, service);

  const unknown = makeResponse();
  await routes[0].handler(makeRequest({ url: `${PANEL_CHANNEL}/nope`, body: '{}' }), unknown);
  assert.equal(unknown.record.status, 404);

  const bad = makeResponse();
  await routes[0].handler(makeRequest({ body: JSON.stringify({ type: 'wrong', method: 'state' }) }), bad);
  assert.equal(bad.record.status, 400);

  const failing = makeResponse();
  await routes[0].handler(
    makeRequest({ url: `${PANEL_CHANNEL}/library/list`, body: JSON.stringify({ type: 'client-request', method: 'library/list', payload: {} }) }),
    failing,
  );
  assert.equal(failing.record.status, 200);
  const parsed = JSON.parse(failing.record.body);
  assert.equal(parsed.result.ok, false);
  assert.match(parsed.result.error.message, /boom/);

  const get = makeResponse();
  await routes[0].handler(makeRequest({ method: 'GET' }), get);
  assert.equal(get.record.status, 405);
});

test('宿主没有 webServer 时注册被静默跳过', () => {
  const { service } = makeService();
  assert.doesNotThrow(() => registerPanelRpc({ effect: () => {}, get: () => undefined, on: () => {} }, service));
});
