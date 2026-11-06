/**
 * Host 半：注册 `paper` 智能体工具 + 面板 RPC 路由。
 *
 * 工具与面板共用 `PaperLibrary` 的同一套方法（一个操作只实现一次）。
 * 0.2.0：PDF 页面阅读所需的字节流与 pdf.js 静态资源由 lib/http.js 提供。
 */
import * as path from 'node:path';
import { PaperLibrary } from './lib/library.js';
import { registerPanelRpc } from './lib/rpc.js';
import { toPosix } from './lib/text.js';

/** Loader 诊断用的插件名 */
export const name = 'paper-reader';
/** 硬依赖：工具注册表。其余服务（webServer/translator/subprocess/sessionController）都是可选的。 */
export const inject = ['tools'];

const ACTIONS = [
  'list',
  'outline',
  'read',
  'search',
  'notes_read',
  'note_add',
  'review',
  'translate',
  'bib',
  'roots',
  'root_add',
  'root_remove',
];

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description:
        'list=列论文库；outline=章节树；read=按节读正文；search=全文检索；notes_read=读笔记；note_add=追加一条笔记（会写文件）；review=生成审稿材料（章节+全部定理原文+可疑引用）；translate=翻译一段文本；bib=参考文献条目；roots=看论文目录；root_add/root_remove=增删论文目录（与面板共用同一份状态）。',
    },
    id: { type: 'string', description: '论文 id（list 返回的短 id）。与 path 二选一。' },
    path: { type: 'string', description: '论文路径（read/outline 等），或要增删的目录（root_add/root_remove）。与 id 二选一。' },
    section: {
      type: 'string',
      description: 'read 限定章节：标题子串（不区分大小写）或章节序号（从 1 开始，对应 outline 顺序）。',
    },
    query: { type: 'string', description: 'search 的关键词（字面匹配）。' },
    text: { type: 'string', description: 'translate 要翻译的文本。' },
    targetLanguage: { type: 'string', description: 'translate 的目标语言，默认取插件配置（zh）。' },
    maxChars: { type: 'number', description: 'read/translate/review 的最大返回字符数，默认 60000。' },
    note: {
      type: 'object',
      description: 'note_add 的笔记条目。',
      properties: {
        kind: { type: 'string', enum: ['quote', 'insight', 'question', 'review'], description: '条目类型。' },
        text: { type: 'string', description: '笔记正文。' },
        quote: { type: 'string', description: '原文引文（可选）。' },
        section: { type: 'string', description: '章节标题（可选，写进出处）。' },
        page: { type: 'number', description: '页码（可选）。' },
        line: { type: 'number', description: '源码行号（可选）。' },
      },
      additionalProperties: false,
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    status: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: true,
};

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）` : text);

function locationOf(block) {
  if (Number.isFinite(block.line)) return `L${block.line}`;
  if (Number.isFinite(block.page)) return `p.${block.page}`;
  return '';
}

/** 把工具结果渲染成模型直接可读的文本（纯函数：直播与回放都会执行）。 */
export function renderPaperResult(_args, value) {
  const action = value?.action ?? '';
  if (value?.status === 'error') return [{ type: 'text', text: `paper ${action} 失败：${value.message ?? '未知错误'}` }];
  const lines = [];
  switch (action) {
    case 'list': {
      lines.push(`论文库（${value.papers.length} 篇）`);
      for (const paper of value.papers) {
        const extra = paper.kind === 'tex' && paper.hasPdf ? '（有 PDF）' : '';
        lines.push(`- ${paper.title} [${paper.kind}] ${paper.path}${extra} — id: ${paper.id}`);
      }
      if (value.roots?.length) lines.push('', `根目录：${value.roots.map((root) => `${root.path}${root.exists ? '' : '（不存在）'}`).join('；')}`);
      break;
    }
    case 'outline': {
      lines.push(`${value.title}（${value.kind}）${value.path ? ` — ${value.path}` : ''}`);
      if (value.authors) lines.push(`作者：${value.authors}`);
      if (value.abstract) lines.push('', '摘要：', clip(value.abstract, 1200));
      lines.push('', `章节（${value.outline.length}）：`);
      for (const section of value.outline) {
        const where = section.line !== undefined ? `L${section.line}` : section.page !== undefined ? `p.${section.page}` : '';
        lines.push(`${'  '.repeat(Math.max(0, section.level - 1))}- ${section.title}${where ? ` (${where})` : ''}`);
      }
      break;
    }
    case 'read': {
      lines.push(`# ${value.title}${value.section ? ` · ${value.section}` : ''}`);
      if (value.path) lines.push(value.path);
      lines.push('');
      for (const block of value.blocks) {
        const where = locationOf(block);
        if (block.kind === 'heading') lines.push(`\n## ${block.text}`);
        else if (block.kind === 'page') lines.push(`\n--- 第 ${block.page} 页 ---`);
        else if (block.kind === 'math') lines.push(`$$${block.text}$$${where ? `  ${where}` : ''}`);
        else if (block.kind === 'theorem') lines.push(`**${block.name}${block.number ? ` ${block.number}` : ''}**${block.title ? `（${block.title}）` : ''}${where ? `  ${where}` : ''}\n${block.text}`);
        else if (block.kind === 'proof') lines.push(`*Proof.*${where ? `  ${where}` : ''} ${block.text}`);
        else lines.push(`${where ? `[${where}] ` : ''}${block.text}`);
      }
      if (value.truncated) lines.push('', '（内容已按 maxChars 截断）');
      break;
    }
    case 'search': {
      lines.push(`命中 ${value.total} 处：`);
      for (const match of value.matches) lines.push(`- ${locationOf(match)} ${match.snippet}`);
      break;
    }
    case 'notes_read': {
      lines.push(`笔记文件：${value.path}${value.exists ? '' : '（尚不存在）'}`);
      if (value.markdown) lines.push('', value.markdown);
      break;
    }
    case 'note_add': {
      lines.push(`已写入 ${value.path}`);
      break;
    }
    case 'review': {
      lines.push(value.brief);
      break;
    }
    case 'translate': {
      lines.push(value.text ?? '');
      break;
    }
    case 'bib': {
      lines.push(`参考文献条目 ${value.entries.length} 条，正文引用 ${value.cited.length} 个 key`);
      for (const entry of value.entries) lines.push(`- [${entry.key}] ${entry.author} (${entry.year}) ${entry.title} — ${entry.venue}`);
      break;
    }
    case 'roots':
    case 'root_add':
    case 'root_remove': {
      lines.push(`论文目录（${value.roots.length}）：`);
      for (const root of value.roots) {
        const source = root.source === 'cwd' ? '工作目录' : root.source === 'config' ? '配置默认' : '手动添加';
        lines.push(
          `- ${root.path}${root.exists === false ? '（不存在）' : ` · ${root.count} 篇`} · ${source}${root.removable === false ? ' · 固定' : ''}`,
        );
      }
      if (value.rootsFile) lines.push('', `状态文件：${value.rootsFile}`);
      if (value.version) lines.push(`插件版本：${value.version}`);
      break;
    }
    default: {
      lines.push(JSON.stringify(value, null, 2));
    }
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/** 把工具参数解析成论文 id：id 优先，其次 path。 */
async function resolvePaperId(library, args) {
  if (typeof args.id === 'string' && args.id.trim() !== '') return args.id.trim();
  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const papers = await library.scan();
    const wanted = toPosix(path.resolve(args.path)).toLowerCase();
    const byPath = papers.find((paper) => toPosix(path.resolve(paper.path)).toLowerCase() === wanted);
    if (byPath) return byPath.id;
    const bySuffix = papers.find((paper) => toPosix(path.resolve(paper.path)).toLowerCase().endsWith(wanted));
    if (bySuffix) return bySuffix.id;
    throw new Error(`路径不在论文库里：${args.path}`);
  }
  throw new Error('缺少 id 或 path');
}

async function runAction(library, args) {
  const action = args.action;
  const maxChars = Number.isFinite(args.maxChars) && args.maxChars > 0 ? args.maxChars : 60000;
  switch (action) {
    case 'list': {
      const [state, list] = await Promise.all([library.state(), library.list()]);
      return { action, papers: list.papers, roots: state.roots };
    }
    case 'outline': {
      const id = await resolvePaperId(library, args);
      const view = await library.view(id, { maxChars: 1 });
      return {
        action,
        id: view.id,
        title: view.title,
        authors: view.authors,
        abstract: view.abstract,
        path: view.path,
        kind: view.kind,
        outline: view.outline,
        theoremCount: view.theoremCount,
        mathCount: view.mathCount,
        pages: view.pages,
      };
    }
    case 'read': {
      const id = await resolvePaperId(library, args);
      // 先取完整块列表再按节过滤，避免 maxChars 在过滤前就把目标章节截掉
      const view = await library.view(id, { maxChars: 5_000_000 });
      let blocks = view.blocks;
      let sectionLabel = '';
      if (typeof args.section === 'string' && args.section.trim() !== '') {
        const needle = args.section.trim().toLowerCase();
        const index = Number.parseInt(needle, 10);
        const matched =
          view.outline.find((item) => Number.isFinite(index) && String(item.ordinal + 1) === String(index)) ??
          view.outline.find((item) => item.title.toLowerCase().includes(needle));
        if (!matched) throw new Error(`找不到章节：${args.section}（先用 outline 看章节列表）`);
        const ids = new Set([matched.id]);
        for (const item of view.outline) {
          if (item.ordinal > matched.ordinal && item.level > matched.level) ids.add(item.id);
          else if (item.ordinal > matched.ordinal) break;
        }
        blocks = blocks.filter((block) => ids.has(block.sectionId));
        sectionLabel = matched.title;
      }
      let used = 0;
      const kept = [];
      let truncated = false;
      for (const block of blocks) {
        const size = (block.text ?? '').length;
        if (used + size > maxChars) {
          truncated = true;
          break;
        }
        used += size;
        kept.push(block);
      }
      return {
        action,
        id: view.id,
        title: view.title,
        path: view.path,
        kind: view.kind,
        section: sectionLabel,
        blocks: kept,
        truncated: truncated || view.truncated,
      };
    }
    case 'search': {
      const id = await resolvePaperId(library, args);
      const result = await library.search(id, args.query ?? '');
      return { action, ...result };
    }
    case 'notes_read': {
      const id = await resolvePaperId(library, args);
      return { action, ...(await library.notes(id)) };
    }
    case 'note_add': {
      const id = await resolvePaperId(library, args);
      const note = args.note ?? {};
      const result = await library.appendNote(id, {
        kind: note.kind,
        text: note.text,
        quote: note.quote,
        section: note.section,
        page: note.page,
        line: note.line,
      });
      return { action, ...result };
    }
    case 'review': {
      const id = await resolvePaperId(library, args);
      const result = await library.review(id, { maxChars });
      return { action, ...result };
    }
    case 'translate': {
      const result = await library.translate(args.text ?? '', { targetLanguage: args.targetLanguage });
      if (!result.ok) return { action, status: 'error', message: result.error?.message ?? '翻译失败' };
      return { action, text: result.text };
    }
    case 'bib': {
      const id = await resolvePaperId(library, args);
      return { action, ...(await library.bib(id)) };
    }
    case 'roots': {
      const state = await library.state();
      return { action, roots: state.roots, rootsFile: state.rootsFile };
    }
    case 'root_add': {
      const state = await library.addRoot(args.path ?? '');
      return { action, roots: state.roots, rootsFile: state.rootsFile };
    }
    case 'root_remove': {
      const state = await library.removeRoot(args.path ?? '');
      return { action, roots: state.roots, rootsFile: state.rootsFile };
    }
    default:
      throw new Error(`未知 action：${action}`);
  }
}

function registerPaperTool(ctx, library) {
  const definition = {
    name: 'paper',
    description:
      '读取和记录论文（本地 .tex 源码或 .pdf）。先 list 找论文，再 outline 看章节，再 read 按节读正文——不要把整篇一次性读进来。note_add 会写入论文同目录的 <论文>.notes.md。review 会汇总章节、全部定理类命题原文、未定义的 \\ref 与缺失的 bib key，用于审稿式挑问题。',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderPaperResult(_args, value),
    },
    async execute(args, exec) {
      try {
        return await runAction(library, args ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 让模型看见失败原因：既返回结构化字段，也走错误结果
        throw new Error(message);
      }
    },
    isConcurrencySafe: () => false,
  };
  const disposer = ctx.tools.register(definition);
  const effect = ctx.effect;
  if (typeof effect === 'function') {
    effect.call(
      ctx,
      () => () => {
        try {
          disposer?.();
        } catch {
          /* 忽略 */
        }
      },
      'paper-reader: tool',
    );
  }
}

export function apply(ctx, config) {
  const resolved = config ?? {};
  const workingDirectory = (() => {
    try {
      const service = ctx.get?.('workingDirectory');
      const directory = service?.defaultDirectory;
      if (typeof directory === 'string' && directory !== '') return directory;
    } catch {
      /* 忽略 */
    }
    return process.cwd();
  })();

  const library = new PaperLibrary({ config: resolved, ctx, cwd: workingDirectory });

  registerPanelRpc(ctx, library);

  if (resolved.tool?.enabled !== false) {
    registerPaperTool(ctx, library);
  }

  const logger = (() => {
    try {
      const factory = ctx.logger;
      return typeof factory === 'function' ? factory.call(ctx, 'paper-reader') : undefined;
    } catch {
      return undefined;
    }
  })();
  logger?.info?.(`论文阅读器已就绪；根目录：${library.rootPaths().join('；')}`);
}
