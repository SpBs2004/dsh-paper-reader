/**
 * PDF 文本提取（pdftotext）与大纲启发式。
 *
 * 依赖注入：`subprocess` 为宿主 `ctx.subprocess` 服务（可为 undefined），
 * `execFile` 为最后的直连回落；两者都没有时返回结构化错误而不是抛异常。
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const HEADING_PATTERNS = [
  { re: /^(abstract)\b/i, title: 'Abstract' },
  { re: /^(introduction)\b/i, title: 'Introduction' },
  { re: /^(related work|background|preliminaries)\b/i, title: null },
  { re: /^(conclusion|conclusions)\b/i, title: null },
  { re: /^(references|bibliography)\b/i, title: null },
  { re: /^(acknowledge?ments?)\b/i, title: 'Acknowledgments' },
  { re: /^(appendix|appendices)\b/i, title: null },
];

/** 去掉两端空白并合并内部空白。 */
function normalizeLine(rawLine) {
  return rawLine.trim().replace(/\s+/g, ' ');
}

/** 修复小型大写字母被拆开的情况：`I NTRODUCTION` → `INTRODUCTION`。 */
function fixSmallCaps(line) {
  return line.replace(/\b([A-Z])\s([A-Z]{2,})\b/g, '$1$2');
}

/** 从一页文本里挑出候选标题行。 */
function headingCandidates(pageText) {
  const out = [];
  for (const rawLine of pageText.split('\n')) {
    const line = fixSmallCaps(normalizeLine(rawLine));
    if (line.length < 3 || line.length > 90) continue;
    if (/[.;,:]$/.test(line)) continue;
    if (/^[\d\s.\-–—|]+$/.test(line)) continue;

    // I. INTRODUCTION / A. Subsection 这类 IEEE 编号
    const roman = /^([IVXLC]+)\.\s+([A-Z][A-Za-z][^]{1,80})$/.exec(line);
    if (roman) {
      out.push({ level: 1, title: `${roman[1]}. ${roman[2].trim()}`, number: roman[1] });
      continue;
    }
    const letter = /^([A-Z])\.\s+([A-Z][A-Za-z][^]{1,80})$/.exec(line);
    if (letter) {
      out.push({ level: 2, title: `${letter[1]}. ${letter[2].trim()}`, number: letter[1] });
      continue;
    }
    // 1 / 1.2 / 1.2.3 编号标题
    const numbered = /^(\d+(?:\.\d+){0,3})\.?\s+([A-Z][^]{2,80})$/.exec(line);
    if (numbered) {
      out.push({
        level: numbered[1].split('.').length,
        title: `${numbered[1]} ${numbered[2].trim()}`,
        number: numbered[1],
      });
      continue;
    }
    // 常见固定标题
    for (const pattern of HEADING_PATTERNS) {
      if (pattern.re.test(line) && line.split(/\s+/).length <= 4) {
        out.push({ level: 1, title: pattern.title ?? line, number: '' });
        break;
      }
    }
  }
  return out;
}

/** 由分页文本构造页块与大纲。 */
function buildFromPages(pages, maxPages) {
  const blocks = [];
  const sections = [];
  let current = null;
  const pushSection = (level, title, page) => {
    const id = `p${sections.length}`;
    current = { id, level, title, page, ordinal: sections.length };
    sections.push(current);
    blocks.push({ kind: 'heading', level, text: title, page, sectionId: id });
    return current;
  };

  pages.forEach((text, i) => {
    const page = i + 1;
    blocks.push({ kind: 'page', page });
    if (page > maxPages) return;
    const candidates = headingCandidates(text);
    // 一页内标题过多时只取前 8 个，避免目录页把大纲撑爆
    for (const heading of candidates.slice(0, 8)) {
      pushSection(Math.min(3, Math.max(1, heading.level)), heading.title, page);
    }
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
      .filter((p) => p.length > 0 && !headingCandidates(p).length);
    for (const paragraph of paragraphs) {
      blocks.push({ kind: 'para', text: paragraph, page, sectionId: current?.id ?? 'p0' });
    }
  });
  return { blocks, sections };
}

/** pdftotext 的实现：优先宿主 subprocess 服务，其次直连 execFile。 */
async function runPdftotext({ subprocess, execFile, exe, pdfPath, outPath, maxPages }) {
  // 用 raw 模式（不加 -layout）：双栏论文的阅读顺序比保留版面更可靠
  const argv = ['-enc', 'UTF-8', '-f', '1', '-l', String(maxPages), pdfPath, outPath];
  if (subprocess && typeof subprocess.spawn === 'function') {
    const handle = subprocess.spawn({
      argv: [exe, ...argv],
      cwd: path.dirname(pdfPath),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 10000,
    });
    const outcome = await Promise.race([
      handle.done,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          try {
            handle.terminate();
          } catch {
            /* 忽略 */
          }
          reject(new Error('pdftotext 超时（10s）'));
        }, 12000);
        timer.unref?.();
      }),
    ]);
    // 超时后 handle.done 仍可能 reject，避免未处理的 rejection
    handle.done.catch(() => {});
    if (outcome && outcome.exitCode !== 0) {
      const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? '';
      throw new Error(`pdftotext 退出码 ${outcome.exitCode}${stderr ? `：${stderr.trim().slice(0, 400)}` : ''}`);
    }
    return;
  }
  if (typeof execFile !== 'function') throw new Error('宿主没有 subprocess 服务，也没有可用的 execFile');
  await new Promise((resolve, reject) => {
    execFile(exe, argv, { timeout: 12000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`pdftotext 失败：${(stderr || error.message || '').toString().trim().slice(0, 400)}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * 提取一篇 PDF 的文本与大纲。
 * @returns {Promise<{pages: number, outline: object[], blocks: object[], truncated: boolean, error?: object}>}
 */
export async function extractPdf({ filePath, maxPages = 200, subprocess, execFile }) {
  let exe;
  try {
    if (subprocess && typeof subprocess.resolveExecutable === 'function') {
      exe = await subprocess.resolveExecutable('pdftotext');
    }
  } catch {
    exe = undefined;
  }
  if (!exe) exe = 'pdftotext';

  const stamp = createHash('sha1').update(`${filePath}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 10);
  const outPath = path.join(tmpdir(), `dsh-paper-${stamp}.txt`);
  try {
    await runPdftotext({ subprocess, execFile, exe, pdfPath: filePath, outPath, maxPages });
    const text = await fs.readFile(outPath, 'utf8');
    const pages = text.split('\f');
    if (pages.length > 0 && pages[pages.length - 1].trim() === '') pages.pop();
    const { blocks, sections } = buildFromPages(pages, maxPages);
    const hasText = pages.some((p) => p.replace(/\s+/g, '').length > 20);
    return {
      pages: pages.length,
      outline: sections,
      blocks,
      truncated: pages.length > maxPages,
      hasText,
    };
  } catch (error) {
    return {
      pages: 0,
      outline: [],
      blocks: [],
      truncated: false,
      hasText: false,
      error: {
        code: /not found|ENOENT|找不到/i.test(String(error?.message)) ? 'pdftotext-missing' : 'pdftotext-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    fs.rm(outPath, { force: true }).catch(() => {});
  }
}

/** 从 PDF 页面文本里抽出可能的标题行（供“审稿材料”使用）。 */
export function pdfTitleGuess(pages) {
  for (const page of pages) {
    for (const line of page.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= 8 && trimmed.length <= 160 && /[A-Za-z]/.test(trimmed)) return trimmed;
    }
  }
  return '';
}
