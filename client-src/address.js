/**
 * `dsh-resource://file/session/<sessionId>/<path>` 地址拼装。
 *
 * 与宿主 `@deepseek-ai/dsh-util-workspace-path` 的 `fileAddressFor` 同一语法：
 *  - 反斜杠转正斜杠、去掉开头的 `./`；
 *  - 在 cwd 内时相对化，否则保留绝对路径（前导 `/` 属于路径）；
 *  - 每段 component-encode，但保留 `:` 字面量（`C:/x` 仍可读）。
 * 纯函数、无依赖，便于单测。
 */
export function fileAddressFor(sessionId, cwd, target) {
  const encode = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':');
  const normalized = String(target ?? '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
  const root =
    typeof cwd === 'string' && cwd !== ''
      ? cwd
          .replace(/\\/g, '/')
          .replace(/\/+$/, '')
          .toLowerCase()
      : '';
  let relative = normalized;
  if (root !== '' && normalized.toLowerCase().startsWith(`${root}/`)) relative = normalized.slice(root.length + 1);
  return `dsh-resource://file/session/${encode(String(sessionId))}/${relative
    .split('/')
    .map(encode)
    .join('/')}`;
}
