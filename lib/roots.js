/**
 * 论文根目录集合：配置里的 `roots` 是默认值，面板里的增删是增量。
 *
 * 状态文件只记录 `added` / `removed` 两个列表，而不是复制一份完整目录：
 * 这样以后改配置仍然生效，面板里移除过的默认目录也不会自己冒回来。
 * 文件位置：`<DSH_PROFILE_DIR>/paper-reader/roots.json`（没有 profile 时退回 ~/.dsh）。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toPosix } from './text.js';

const VERSION = 1;

/** Windows 下大小写不敏感；比较前统一成正斜杠。 */
export function samePath(a, b) {
  return toPosix(path.resolve(a)).toLowerCase() === toPosix(path.resolve(b)).toLowerCase();
}

/** 去掉引号、展开 `~`；空串返回 null。 */
function cleanPath(input) {
  let value = String(input ?? '').trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1).trim();
  }
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value === '' ? null : value;
}

export function defaultStateFile() {
  const profile = process.env.DSH_PROFILE_DIR;
  const base = typeof profile === 'string' && profile.trim() !== '' ? profile : path.join(os.homedir(), '.dsh');
  return path.join(base, 'paper-reader', 'roots.json');
}

export class RootStore {
  /**
   * @param {{ config?: any, cwd: string, stateFile?: string }} deps
   */
  constructor({ config, cwd, stateFile }) {
    this.config = config ?? {};
    this.cwd = path.resolve(cwd);
    this.stateFile = stateFile ?? defaultStateFile();
    this.state = { added: [], removed: [] };
    this.loaded = false;
    this.loading = undefined;
    this.queue = Promise.resolve();
  }

  /** 配置里声明的默认根目录（已解析成绝对路径）。 */
  configRoots() {
    const configured = Array.isArray(this.config.roots) ? this.config.roots : [];
    const out = [];
    for (const value of configured) {
      const cleaned = cleanPath(value);
      if (cleaned === null) continue;
      out.push(path.resolve(this.cwd, cleaned));
    }
    return out;
  }

  isRemoved(root) {
    return this.state.removed.some((value) => samePath(value, root));
  }

  /** 同步快照：未读盘时先按配置给答案，适合日志/首屏这类不能 await 的地方。 */
  snapshot() {
    const out = [];
    const push = (value) => {
      if (!out.some((root) => samePath(root, value))) out.push(path.resolve(value));
    };
    if (!this.isRemoved(this.cwd)) push(this.cwd);
    for (const root of this.configRoots()) {
      if (!this.isRemoved(root)) push(root);
    }
    for (const root of this.state.added) {
      if (!this.isRemoved(root)) push(root);
    }
    return out;
  }

  async load() {
    if (this.loaded) return this;
    if (this.loading === undefined) this.loading = this.readState();
    await this.loading;
    this.loaded = true;
    return this;
  }

  async readState() {
    let parsed;
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      // 坏文件不该让整个论文库打不开：当作没有增量，下次写入时覆盖。
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== VERSION) return;
    const readList = (value) =>
      Array.isArray(value)
        ? value
            .filter((item) => typeof item === 'string' && item.trim() !== '')
            .map((item) => path.resolve(this.cwd, item.trim()))
        : [];
    this.state.added = readList(parsed.added);
    this.state.removed = readList(parsed.removed);
  }

  async save() {
    const payload = {
      version: VERSION,
      added: this.state.added,
      removed: this.state.removed,
    };
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.stateFile);
  }

  /** 串行化读改写，避免两次点击互相覆盖。 */
  mutate(operation) {
    const run = this.queue.then(async () => {
      await this.load();
      return operation();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 添加目录：必须是已存在的目录；已移除的默认目录会被恢复。
   * @returns 新的快照
   */
  add(input) {
    return this.mutate(async () => {
      const cleaned = cleanPath(input);
      if (cleaned === null) throw new Error('目录路径为空');
      const target = path.resolve(this.cwd, cleaned);
      const info = await fs.stat(target).catch(() => null);
      if (info === null) throw new Error(`目录不存在：${target}`);
      if (!info.isDirectory()) throw new Error(`不是目录：${target}`);
      if (this.snapshot().some((root) => samePath(root, target))) throw new Error(`这个目录已经在论文目录里：${target}`);
      this.state.removed = this.state.removed.filter((root) => !samePath(root, target));
      if (samePath(target, this.cwd)) {
        // 恢复被移除的工作目录，不写进 added
      } else if (!this.configRoots().some((root) => samePath(root, target))) {
        this.state.added = [...this.state.added.filter((root) => !samePath(root, target)), target];
      }
      await this.save();
      return this.snapshot();
    });
  }

  /**
   * 移除目录：默认目录记进 removed，手动目录直接从 added 删掉。
   * @returns 新的快照
   */
  remove(input) {
    return this.mutate(async () => {
      const cleaned = cleanPath(input);
      if (cleaned === null) throw new Error('目录路径为空');
      const target = path.resolve(this.cwd, cleaned);
      const inConfig = this.configRoots().some((root) => samePath(root, target));
      const inAdded = this.state.added.some((root) => samePath(root, target));
      const isCwd = samePath(target, this.cwd);
      if (!isCwd && !inConfig && !inAdded) throw new Error(`不在论文目录里：${target}`);
      this.state.added = this.state.added.filter((root) => !samePath(root, target));
      if ((isCwd || inConfig) && !this.state.removed.some((root) => samePath(root, target))) {
        this.state.removed = [...this.state.removed, target];
      }
      await this.save();
      return this.snapshot();
    });
  }
}
