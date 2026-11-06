export const PANEL_CHANNEL = '/paper-reader';

/**
 * 面板 → 宿主 RPC。信封与宿主 `lib/rpc.js` 对齐：
 * `connection.rpc.call(channel, endpoint, payload)` 返回 `{ ok, value | error }`。
 */
export class PanelApi {
  constructor(getConnection, getLocale) {
    this.getConnection = getConnection;
    this.getLocale = getLocale ?? (() => 'zh');
  }

  async call(endpoint, payload = {}) {
    const connection = this.getConnection();
    const rpc = connection?.rpc;
    if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
      throw new Error('当前宿主没有 Connection 服务，面板无法与宿主通信（智能体工具仍可用）');
    }
    const result = await rpc.call(PANEL_CHANNEL, endpoint, { locale: this.getLocale(), ...payload });
    if (result === undefined || result === null || result.ok !== true) {
      throw new Error(result?.error?.message ?? `调用 ${endpoint} 失败`);
    }
    return result.value;
  }

  state() {
    return this.call('state');
  }

  addRoot(path) {
    return this.call('roots/add', { path });
  }

  removeRoot(path) {
    return this.call('roots/remove', { path });
  }

  pickDirectory() {
    return this.call('roots/pick');
  }

  list(root) {
    return this.call('library/list', root === undefined || root === null ? {} : { root });
  }

  view(id, maxChars) {
    return this.call('paper/view', maxChars === undefined ? { id } : { id, maxChars });
  }

  search(id, query) {
    return this.call('paper/search', { id, query });
  }

  translate(text, targetLanguage) {
    return this.call('paper/translate', targetLanguage === undefined ? { text } : { text, targetLanguage });
  }

  notesRead(id) {
    return this.call('notes/read', { id });
  }

  notesAppend(id, entry) {
    return this.call('notes/append', { id, entry });
  }

  targets() {
    return this.call('ask/target');
  }

  ask(sessionId, text) {
    return this.call('ask/send', { sessionId, text });
  }
}
