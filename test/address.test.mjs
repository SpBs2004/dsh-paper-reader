import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileAddressFor } from '../client-src/address.js';

test('cwd 内的路径相对化', () => {
  assert.equal(
    fileAddressFor('s1', 'D:\\papers', 'D:\\papers\\paper.tex'),
    'dsh-resource://file/session/s1/paper.tex',
  );
});

test('cwd 外的绝对路径保留盘符，冒号保持字面量', () => {
  assert.equal(
    fileAddressFor('s1', 'C:\\work', 'C:\\papers\\a b.tex'),
    'dsh-resource://file/session/s1/C:/papers/a%20b.tex',
  );
});

test('POSIX 绝对路径保留前导斜杠（双斜杠）', () => {
  assert.equal(fileAddressFor('s', '/root', '/etc/hosts'), 'dsh-resource://file/session/s//etc/hosts');
});

test('未知 cwd 时按绝对路径处理，中文路径被编码', () => {
  assert.equal(
    fileAddressFor('abc', undefined, 'C:\\论文库\\qin TCYB.tex'),
    'dsh-resource://file/session/abc/C:/%E8%AE%BA%E6%96%87%E5%BA%93/qin%20TCYB.tex',
  );
});

test('大小写不同的 cwd 前缀仍能相对化', () => {
  assert.equal(fileAddressFor('s', 'e:\\papers', 'E:\\papers\\x.tex'), 'dsh-resource://file/session/s/x.tex');
});
