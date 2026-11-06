/**
 * 生成 README 截图用的演示 PDF：把 test/fixtures/demo.html 用本机 Chrome 打成 PDF。
 *
 * 用法：node scripts/make-demo-pdf.mjs [html] [pdf]
 * 默认：test/fixtures/demo.html → test/fixtures/sample.pdf
 *
 * 依赖本机 Chrome/Edge（与 smoke 脚本相同的候选列表）；不依赖 node_modules。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const htmlPath = path.resolve(process.argv[2] ?? path.join(here, 'test', 'fixtures', 'demo.html'));
const pdfPath = path.resolve(process.argv[3] ?? path.join(here, 'test', 'fixtures', 'sample.pdf'));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (chrome === undefined) throw new Error('没有找到 Chrome/Edge，无法生成演示 PDF');
if (!existsSync(htmlPath)) throw new Error(`演示 HTML 不存在：${htmlPath}`);

await fs.mkdir(path.dirname(pdfPath), { recursive: true });
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-pdf-header-footer',
  `--print-to-pdf=${pdfPath}`,
  pathToFileURL(htmlPath).href,
];

const code = await new Promise((resolve, reject) => {
  const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', reject);
  child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  setTimeout(() => child.kill(), 60000).unref?.();
});

if (code !== 0) throw new Error(`Chrome 退出码 ${code}`);
const info = await fs.stat(pdfPath).catch(() => null);
if (info === null || info.size < 10_000) throw new Error(`PDF 没有生成或太小：${pdfPath}`);
console.log(`OK ${pdfPath} (${(info.size / 1024).toFixed(0)} KiB)`);
