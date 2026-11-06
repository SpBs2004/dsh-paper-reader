/**
 * 论文库：扫描根目录、解析 tex/pdf、内存缓存、笔记、翻译、审稿材料。
 *
 * 面板 RPC 与智能体工具共用本文件的同一套方法（user-actions 规则：
 * 一个操作只实现一次，UI 与工具都是调用方）。
 */
import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { extractPdf, pdfTitleGuess } from './pdf.js';
import { RootStore, samePath } from './roots.js';
import { baseName, detex, extensionOf, formatBytes, formatStamp, toPosix } from './text.js';
import { parseBib, parseTex } from './tex.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'node_modules', '__MACOSX', '.paper-reader', '_pdf_pages']);
const MAX_SCAN_DEPTH = 3;
const MAX_LIST = 500;
const CACHE_LIMIT = 8;

const idOf = (absolutePath) => createHash('sha1').update(absolutePath).digest('hex').slice(0, 12);

function isProbablyText(buffer) {
  return !buffer.includes(0);
}

/** 递归收集 .tex/.pdf/.bib 文件（限深度与数量）。 */
async function walk(root, depth, out, budget) {
  if (depth > MAX_SCAN_DEPTH || budget.count > MAX_LIST * 4) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.count > MAX_LIST * 4) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      await walk(full, depth + 1, out, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extensionOf(entry.name);
    if (ext !== 'tex' && ext !== 'pdf' && ext !== 'bib') continue;
    budget.count += 1;
    out.push({ path: full, ext });
  }
}

/** 从源码前若干字节里快速取标题，避免为列表做完整解析。 */
function peekTexTitle(source, fallback) {
  const head = source.slice(0, 12000);
  const match = /\\title\s*\{([\s\S]{0,400}?)\}/.exec(head);
  if (match === null) return fallback;
  const title = detex(match[1]).replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title : fallback;
}

export class PaperLibrary {
  /**
   * @param {{ config: any, ctx: any, cwd: string, execFile?: Function, stateFile?: string }} deps
   */
  constructor({ config, ctx, cwd, execFile, stateFile }) {
    this.config = config ?? {};
    this.ctx = ctx;
    this.cwd = path.resolve(cwd);
    this.execFile = execFile ?? nodeExecFile;
    this.cache = new Map();
    this.scanCache = null;
    this.roots = new RootStore({ config: this.config, cwd: this.cwd, stateFile });
  }

  // ---------------------------------------------------------------- 基础

  /** 同步快照（日志/首屏用）；面板与工具调用前会先 `await this.roots.load()`。 */
  rootPaths() {
    return this.roots.snapshot();
  }

  notesSuffix() {
    return typeof this.config.notes?.suffix === 'string' ? this.config.notes.suffix : '.notes.md';
  }

  maxChars() {
    return Number.isFinite(this.config.maxChars) ? this.config.maxChars : 400000;
  }

  maxPages() {
    return Number.isFinite(this.config.maxPages) ? this.config.maxPages : 200;
  }

  // ---------------------------------------------------------------- 扫描

  async scan(force = false) {
    if (!force && this.scanCache !== null && Date.now() - this.scanCache.at < 4000) return this.scanCache.papers;
    await this.roots.load();
    const roots = this.rootPaths();
    const papers = [];
    for (const root of roots) {
      let stat;
      try {
        stat = await fs.stat(root);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const files = [];
      await walk(root, 0, files, { count: 0 });
      const byDirBase = new Map();
      const bibByDir = new Map();
      for (const file of files) {
        if (file.ext === 'bib') {
          const dirKey = toPosix(path.dirname(file.path)).toLowerCase();
          if (!bibByDir.has(dirKey)) bibByDir.set(dirKey, file.path);
          continue;
        }
        const key = `${toPosix(path.dirname(file.path)).toLowerCase()}/${baseName(file.path).toLowerCase()}`;
        const slot = byDirBase.get(key) ?? { dir: path.dirname(file.path), base: baseName(file.path) };
        if (file.ext === 'tex') slot.tex = file.path;
        else if (file.ext === 'pdf') slot.pdf = file.path;
        byDirBase.set(key, slot);
      }
      for (const slot of byDirBase.values()) {
        const primary = slot.tex ?? slot.pdf;
        if (primary === undefined) continue;
        let info;
        try {
          info = await fs.stat(primary);
        } catch {
          continue;
        }
        if (info.size > (this.config.maxPaperBytes ?? 33554432)) continue;
        const kind = slot.tex ? 'tex' : 'pdf';
        let title = slot.base;
        let abstract = '';
        if (kind === 'tex') {
          try {
            const handle = await fs.open(slot.tex, 'r');
            try {
              const buffer = Buffer.alloc(12000);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
              title = peekTexTitle(buffer.subarray(0, bytesRead).toString('utf8'), slot.base);
            } finally {
              await handle.close();
            }
          } catch {
            title = slot.base;
          }
        }
        papers.push({
          id: idOf(path.resolve(primary)),
          path: primary,
          dir: slot.dir,
          base: slot.base,
          kind,
          title,
          abstract,
          texPath: slot.tex ?? null,
          pdfPath: slot.pdf ?? null,
          bibPath: slot.tex === undefined ? null : bibByDir.get(toPosix(slot.dir).toLowerCase()) ?? null,
          bytes: info.size,
          bytesLabel: formatBytes(info.size),
          mtime: info.mtimeMs,
        });
      }
    }
    // 根目录可能互相包含（工作目录 + 子目录），同一篇论文只保留一次
    const seen = new Set();
    const unique = papers.filter((paper) => {
      const key = toPosix(paper.path).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.sort((a, b) => b.mtime - a.mtime);
    this.scanCache = { at: Date.now(), papers: unique };
    return unique;
  }

  async find(id) {
    const papers = await this.scan();
    return papers.find((paper) => paper.id === id) ?? null;
  }

  /**
   * 面板 PDF 渲染器要直接读字节：只放行「论文根目录内、真实路径仍是 .pdf」的文件。
   * 用 realpath 解析符号链接/目录联接，避免经由根目录里的链接读到外部文件。
   * @returns {Promise<string|null>} 规范化的绝对路径
   */
  async resolvePdf(filePath) {
    if (typeof filePath !== 'string' || filePath.trim() === '') return null;
    await this.roots.load();
    let real;
    try {
      real = await fs.realpath(path.resolve(filePath.trim()));
    } catch {
      return null;
    }
    if (extensionOf(real) !== 'pdf') return null;
    let stat;
    try {
      stat = await fs.stat(real);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    for (const root of this.rootPaths()) {
      let realRoot;
      try {
        realRoot = await fs.realpath(root);
      } catch {
        realRoot = path.resolve(root);
      }
      const rel = path.relative(realRoot, real);
      if (rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) return real;
    }
    return null;
  }

  // ---------------------------------------------------------------- 解析

  async load(paper) {
    const version = `${paper.path}|${paper.mtime}|${paper.bytes}`;
    const cached = this.cache.get(version);
    if (cached !== undefined) return cached;

    let parsed;
    if (paper.kind === 'tex') {
      const source = await fs.readFile(paper.path, 'utf8');
      const dir = path.dirname(paper.path);
      parsed = parseTex(source, {
        label: paper.base,
        loadInclude: (name) => {
          const candidates = [path.join(dir, name), path.join(dir, `${name}.tex`), path.join(dir, path.basename(name))];
          for (const candidate of candidates) {
            try {
              return readFileSync(candidate, 'utf8');
            } catch {
              continue;
            }
          }
          return undefined;
        },
      });
      if (paper.pdfPath) parsed.pdfPath = paper.pdfPath;
      if (paper.bibPath) {
        try {
          const bibSource = await fs.readFile(paper.bibPath, 'utf8');
          parsed.bib = parseBib(bibSource);
        } catch {
          parsed.bib = [];
        }
      }
    } else {
      const result = await extractPdf({
        filePath: paper.path,
        maxPages: this.maxPages(),
        subprocess: this.ctx?.get?.('subprocess'),
        execFile: this.execFile,
      });
      parsed = {
        kind: 'pdf',
        meta: {
          title: paper.title || pdfTitleGuess(result.blocks.filter((b) => b.kind === 'para').map((b) => b.text).join('\n\n')),
          authors: '',
          abstract: '',
        },
        sections: result.outline,
        blocks: result.blocks,
        pages: result.pages,
        labels: [],
        refs: [],
        cites: [],
        undefinedRefs: [],
        lineCount: 0,
        theoremCount: 0,
        mathCount: 0,
        error: result.error,
        hasText: result.hasText,
        truncated: result.truncated,
      };
    }

    this.cache.set(version, parsed);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    return parsed;
  }

  // ---------------------------------------------------------------- 对外视图

  async state() {
    await this.roots.load();
    const configRoots = this.roots.configRoots();
    const roots = [];
    for (const root of this.rootPaths()) {
      let exists = false;
      let count = 0;
      try {
        const stat = await fs.stat(root);
        exists = stat.isDirectory();
      } catch {
        exists = false;
      }
      if (exists) {
        const papers = (await this.scan()).filter((paper) => toPosix(paper.path).toLowerCase().startsWith(toPosix(root).toLowerCase()));
        count = papers.length;
      }
      const isCwd = samePath(root, this.cwd);
      roots.push({
        path: root,
        exists,
        count,
        source: isCwd ? 'cwd' : configRoots.some((item) => samePath(item, root)) ? 'config' : 'user',
        removable: true,
      });
    }
    return { roots, defaultRoot: roots[0]?.path ?? null, rootsFile: this.roots.stateFile, version: '0.2.0' };
  }

  /** 面板/工具共用：添加一个论文根目录，返回新的目录状态。 */
  async addRoot(input) {
    await this.roots.add(input);
    this.scanCache = null;
    return this.state();
  }

  /** 面板/工具共用：移除一个论文根目录，返回新的目录状态。 */
  async removeRoot(input) {
    await this.roots.remove(input);
    this.scanCache = null;
    return this.state();
  }

  /** 宿主的原生目录选择器（没有就报不支持，由面板退回手输）。 */
  async pickDirectory() {
    let picker;
    try {
      picker = this.ctx?.get?.('directoryPickerController');
    } catch {
      picker = undefined;
    }
    if (picker === undefined || picker === null || typeof picker.pick !== 'function') {
      return { supported: false, path: null };
    }
    try {
      const value = await picker.pick(new AbortController().signal);
      return { supported: true, path: typeof value === 'string' && value.trim() !== '' ? value : null };
    } catch (error) {
      return { supported: true, path: null, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async list(rootPath) {
    await this.roots.load();
    const papers = await this.scan();
    const roots = this.rootPaths();
    const relOf = (target) => {
      const hit = roots.find((root) => toPosix(target).toLowerCase().startsWith(toPosix(root).toLowerCase()));
      return hit === undefined ? target : path.relative(hit, target);
    };
    const filtered =
      typeof rootPath === 'string' && rootPath.trim() !== ''
        ? papers.filter((paper) => toPosix(paper.path).toLowerCase().startsWith(toPosix(rootPath).toLowerCase()))
        : papers;
    return {
      papers: filtered.map((paper) => ({
        id: paper.id,
        path: paper.path,
        relPath: relOf(paper.path),
        kind: paper.kind,
        title: paper.title,
        bytes: paper.bytes,
        bytesLabel: paper.bytesLabel,
        mtime: paper.mtime,
        hasPdf: paper.pdfPath !== null,
        hasBib: paper.bibPath !== null,
      })),
    };
  }

  async view(id, { maxChars } = {}) {
    const paper = await this.find(id);
    if (paper === null) throw new Error(`找不到论文：${id}`);
    const parsed = await this.load(paper);
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : this.maxChars();

    const blocks = [];
    let used = 0;
    let truncated = false;
    for (const block of parsed.blocks) {
      const text = block.text ?? '';
      if (used + text.length > limit) {
        truncated = true;
        break;
      }
      used += text.length;
      blocks.push(block);
    }

    const outline = parsed.sections.map((section) => ({
      id: section.id,
      level: section.level,
      title: section.title,
      line: section.line,
      page: section.page,
      ordinal: section.ordinal,
    }));

    return {
      id: paper.id,
      kind: paper.kind,
      path: paper.path,
      title: parsed.meta?.title || paper.title || paper.base,
      authors: parsed.meta?.authors ?? '',
      abstract: parsed.meta?.abstract ?? '',
      copyright: '',
      outline,
      blocks,
      truncated,
      notesPath: this.notesPath(paper),
      pdfPath: paper.pdfPath,
      bibPath: paper.bibPath,
      pages: parsed.pages ?? 0,
      theoremCount: parsed.theoremCount ?? 0,
      mathCount: parsed.mathCount ?? 0,
      lineCount: parsed.lineCount ?? 0,
      error: parsed.error ?? null,
      hasText: parsed.hasText !== false,
    };
  }

  async search(id, query) {
    const paper = await this.find(id);
    if (paper === null) throw new Error(`找不到论文：${id}`);
    const parsed = await this.load(paper);
    const needle = String(query ?? '').trim();
    if (needle === '') return { matches: [], total: 0 };
    const lower = needle.toLowerCase();
    const matches = [];
    for (const block of parsed.blocks) {
      const text = block.text ?? '';
      const at = text.toLowerCase().indexOf(lower);
      if (at < 0) continue;
      matches.push({
        sectionId: block.sectionId,
        kind: block.kind,
        line: block.line,
        page: block.page,
        snippet: `${at > 60 ? '…' : ''}${text.slice(Math.max(0, at - 60), at + needle.length + 120)}${text.length > at + needle.length + 120 ? '…' : ''}`,
      });
      if (matches.length >= 60) break;
    }
    return { matches, total: matches.length };
  }

  async bib(id) {
    const paper = await this.find(id);
    if (paper === null) throw new Error(`找不到论文：${id}`);
    const parsed = await this.load(paper);
    return { entries: parsed.bib ?? [], cited: parsed.cites ?? [] };
  }

  // ---------------------------------------------------------------- 笔记

  notesPath(paper) {
    const suffix = this.notesSuffix();
    return path.join(paper.dir, `${paper.base}${suffix}`);
  }

  async notes(id) {
    const paper = await this.find(id);
    if (paper === null) throw new Error(`找不到论文：${id}`);
    const target = this.notesPath(paper);
    try {
      const markdown = await fs.readFile(target, 'utf8');
      return { path: target, exists: true, markdown, count: (markdown.match(/^## /gm) ?? []).length };
    } catch (error) {
      if (error?.code === 'ENOENT') return { path: target, exists: false, markdown: '', count: 0 };
      throw error;
    }
  }

  async appendNote(id, entry) {
    const paper = await this.find(id);
    if (paper === null) throw new Error(`找不到论文：${id}`);
    const target = this.notesPath(paper);
    const text = String(entry?.text ?? '').trim();
    const quote = String(entry?.quote ?? '').trim();
    if (text === '' && quote === '') throw new Error('笔记内容为空');
    const kind = ['quote', 'insight', 'question', 'review'].includes(entry?.kind) ? entry.kind : 'insight';
    const kindLabel = { quote: '摘录', insight: '理解', question: '疑问', review: '审稿' }[kind];
    const where = [];
    if (entry?.section) where.push(`§${entry.section}`);
    if (Number.isFinite(entry?.page)) where.push(`p.${entry.page}`);
    if (Number.isFinite(entry?.line)) where.push(`L${entry.line}`);
    const heading = `## ${formatStamp()} · ${kindLabel}${where.length > 0 ? ` · ${where.join(' · ')}` : ''}`;
    const parts = [heading, ''];
    if (quote !== '') parts.push(...quote.split('\n').map((line) => `> ${line}`), '');
    if (text !== '') parts.push(text, '');

    let prefix = '';
    try {
      const existing = await fs.readFile(target, 'utf8');
      prefix = existing.endsWith('\n') ? '\n' : '\n\n';
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      prefix = `# ${paper.title || paper.base} — 阅读笔记\n\n`;
    }
    await fs.appendFile(target, `${prefix}${parts.join('\n')}\n`, 'utf8');
    return { path: target, appended: true };
  }

  // ---------------------------------------------------------------- 审稿材料

  async review(id, { maxChars = 60000 } = {}) {
    const paper = await this.find(id);
    if (paper === null) throw new Error(`找不到论文：${id}`);
    const parsed = await this.load(paper);
    const lines = [];
    lines.push(`# 审稿材料：${parsed.meta?.title || paper.base}`);
    lines.push('');
    lines.push(`- 文件：${paper.path}`);
    lines.push(`- 类型：${paper.kind === 'tex' ? 'LaTeX 源码' : 'PDF 提取文本'}`);
    if (parsed.meta?.authors) lines.push(`- 作者：${parsed.meta.authors}`);
    if (paper.kind === 'tex') {
      lines.push(`- 章节：${parsed.sections.length}，定理类：${parsed.theoremCount}，公式块：${parsed.mathCount}`);
      const cited = new Set(parsed.cites ?? []);
      const bibKeys = new Set((parsed.bib ?? []).map((entry) => entry.key));
      const missing = [...cited].filter((key) => !bibKeys.has(key));
      if (missing.length > 0) lines.push(`- 引用了但 bib 里没有的 key：${missing.join(', ')}`);
      if ((parsed.undefinedRefs ?? []).length > 0) lines.push(`- 未定义的 \\ref：${parsed.undefinedRefs.join(', ')}`);
    } else {
      lines.push(`- 页数：${parsed.pages ?? 0}`);
    }
    lines.push('');
    if (parsed.meta?.abstract) {
      lines.push('## 摘要');
      lines.push(parsed.meta.abstract.slice(0, 3000));
      lines.push('');
    }
    lines.push('## 结构');
    for (const section of parsed.sections.slice(0, 120)) {
      const location = section.line !== undefined ? `L${section.line}` : section.page !== undefined ? `p.${section.page}` : '';
      lines.push(`${'  '.repeat(Math.max(0, section.level - 1))}- ${section.title}${location ? ` (${location})` : ''}`);
    }
    lines.push('');
    const theorems = parsed.blocks.filter((block) => block.kind === 'theorem' || block.kind === 'proof');
    if (theorems.length > 0) {
      lines.push('## 定理类命题（原文）');
      for (const block of theorems) {
        const label = block.kind === 'proof' ? 'Proof' : `${block.name}${block.number ? ` ${block.number}` : ''}`;
        lines.push(`### ${label}${block.title ? `（${block.title}）` : ''} · L${block.line}`);
        lines.push(block.text ?? '');
        lines.push('');
      }
    }
    const body = lines.join('\n');
    return {
      brief: body.length > maxChars ? `${body.slice(0, maxChars)}\n…（已截断）` : body,
      truncated: body.length > maxChars,
    };
  }

  // ---------------------------------------------------------------- 翻译

  async translate(text, { targetLanguage } = {}) {
    const translator = this.ctx?.get?.('translator');
    if (translator === undefined || translator === null) {
      return { ok: false, error: { code: 'translator-missing', message: '宿主没有 translator 服务' } };
    }
    const target = targetLanguage || this.config.translation?.targetLanguage || 'zh';
    const payload = String(text ?? '').trim();
    if (payload === '') return { ok: true, text: '' };
    try {
      const providers = await translator.availableProviders();
      if (!Array.isArray(providers) || providers.length === 0) {
        return { ok: false, error: { code: 'translator-unavailable', message: '没有可用的翻译 provider' } };
      }
      const requested = this.config.translation?.provider;
      const provider =
        typeof requested === 'string' && providers.includes(requested)
          ? requested
          : providers.find((name) => name === 'google' || name === 'bing') ?? providers[0];
      const spec = translator.resolve({ text: payload, targetLanguage: target, provider });
      const translated = await translator.translate(spec);
      return { ok: true, text: translated, provider };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'translator-failed', message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  // ---------------------------------------------------------------- 会话目标

  async targets() {
    const controller = this.ctx?.get?.('sessionController');
    if (controller === undefined || controller === null || typeof controller.list !== 'function') {
      return { sessions: [] };
    }
    try {
      const signal = new AbortController().signal;
      const value = await controller.list({}, signal);
      const items = Array.isArray(value?.items) ? value.items : [];
      const sessions = items
        .filter((item) => item && typeof item.sessionId === 'string' && item.origin !== 'subagent')
        .slice(0, 40)
        .map((item) => ({
          id: item.sessionId,
          cwd: item.cwd ?? '',
          updatedAt: item.updatedAt ?? 0,
          running: item.running === true,
        }));
      return { sessions };
    } catch {
      return { sessions: [] };
    }
  }

  /** 由宿主直接向会话投递一条用户消息（面板的“问 AI”）。 */
  async ask({ sessionId, text, requestId }) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('缺少 sessionId');
    const payload = String(text ?? '').trim();
    if (payload === '') throw new Error('提问内容为空');
    const controller = this.ctx?.get?.('sessionController');
    if (controller === undefined || controller === null || typeof controller.prompt !== 'function') {
      throw new Error('宿主没有 sessionController.prompt，无法投递问题');
    }
    const signal = new AbortController().signal;
    const value = await controller.prompt(
      {
        sessionId,
        requestId: requestId ?? `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: 'queue',
        content: [{ type: 'text', text: payload }],
      },
      signal,
    );
    return { accepted: value?.accepted === true };
  }
}
