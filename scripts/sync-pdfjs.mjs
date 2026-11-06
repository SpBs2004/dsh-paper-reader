/**
 * 把 pdfjs-dist 的运行时文件拷进插件 `vendor/pdfjs/`。
 *
 * 面板按需 `import('/paper-reader/static/pdfjs/build/pdf.min.mjs')`，
 * 所以 DSH 运行时不需要 node_modules；升级 pdfjs 时改 package.json 再跑一次本脚本。
 *
 * 用法：node scripts/sync-pdfjs.mjs
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(here, 'node_modules', 'pdfjs-dist');
const out = path.join(here, 'vendor', 'pdfjs');

async function main() {
  const version = JSON.parse(await readFile(path.join(src, 'package.json'), 'utf8')).version;
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, 'build'), { recursive: true });

  // legacy 构建带 core-js 垫片，Chrome 110 也能用；min 版体积只有 unmin 的一半
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    await cp(path.join(src, 'legacy', 'build', name), path.join(out, 'build', name));
  }
  for (const name of ['cmaps', 'standard_fonts']) {
    await cp(path.join(src, name), path.join(out, name), { recursive: true });
  }
  await cp(path.join(src, 'LICENSE'), path.join(out, 'LICENSE'));
  await writeFile(
    path.join(out, 'VERSION'),
    `pdfjs-dist ${version}\nserved at /paper-reader/static/pdfjs/\n`,
    'utf8',
  );

  let bytes = 0;
  for (const name of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs']) {
    bytes += (await stat(path.join(out, name))).size;
  }
  console.log(`vendor/pdfjs 已同步：pdfjs-dist ${version}，主包 ${(bytes / 1024).toFixed(0)} KiB + cmaps/standard_fonts`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
