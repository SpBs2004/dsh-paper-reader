/**
 * 客户端产物构建：esbuild 打成 CJS（react 保持外部），
 * 再包一层 `window.__ModuleLoader__.load` 的 lazy 工厂外壳。
 *
 * 用法：node build.mjs
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [path.join(here, 'client-src', 'entry.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110'],
  external: ['react'],
  write: false,
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
});

const code = result.outputFiles[0].text;
const indented = code
  .split('\n')
  .map((line) => (line === '' ? '' : `    ${line}`))
  .join('\n');

const wrapped = `// 由 build.mjs 生成：注册 lazy-CJS 工厂，模块体在首次 materialize 时执行
window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${indented}
    return module.exports;
  },
});
`;

await writeFile(path.join(here, 'client.js'), wrapped, 'utf8');
console.log(`client.js 已生成：${(wrapped.length / 1024).toFixed(1)} KiB`);
