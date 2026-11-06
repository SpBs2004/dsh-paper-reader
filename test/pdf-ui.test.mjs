import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampScale,
  pdfFileUrl,
  readProgress,
  sectionForPage,
  writeProgress,
  PDF_STORAGE_PREFIX,
  browserSupportsPdf,
} from '../client-src/pdfview.js';

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

test('pdfFileUrl：路径必须完整编码', () => {
  const url = pdfFileUrl('D:\\papers\\A Novel Paper.pdf');
  assert.ok(url.startsWith('/paper-reader/file?path='));
  assert.equal(url.includes(' '), false);
  assert.equal(decodeURIComponent(url.slice(url.indexOf('path=') + 5)), 'D:\\papers\\A Novel Paper.pdf');
});

test('clampScale：限制在 25%–400%', () => {
  assert.equal(clampScale(1), 1);
  assert.equal(clampScale(0.01), 0.25);
  assert.equal(clampScale(99), 4);
  assert.equal(clampScale('bad'), 1);
  assert.equal(clampScale(1.234), 1.23);
});

test('readProgress / writeProgress：往返 + 坏数据容错', () => {
  const storage = fakeStorage();
  assert.equal(readProgress(storage, 'p1'), null);
  writeProgress(storage, 'p1', { page: 7, scale: 1.35, fit: false });
  assert.deepEqual(readProgress(storage, 'p1'), { page: 7, scale: 1.35, fit: false });
  assert.equal(storage.map.get(`${PDF_STORAGE_PREFIX}p1`) !== undefined, true);

  storage.setItem(`${PDF_STORAGE_PREFIX}p2`, '{bad json');
  assert.equal(readProgress(storage, 'p2'), null);
  storage.setItem(`${PDF_STORAGE_PREFIX}p3`, JSON.stringify({ page: 0, scale: 99, fit: 'yes' }));
  assert.deepEqual(readProgress(storage, 'p3'), { page: 1, scale: 4, fit: true });

  // 配额满/隐私模式不能影响阅读
  writeProgress({ setItem() { throw new Error('quota'); } }, 'p4', { page: 1, scale: 1, fit: true });
});

test('sectionForPage：按页码取最近章节', () => {
  const outline = [
    { id: 'a', title: 'Intro', page: 1 },
    { id: 'b', title: 'Method', page: 3 },
    { id: 'c', title: 'No page' },
    { id: 'd', title: 'Results', page: 7 },
  ];
  assert.equal(sectionForPage(outline, 1).id, 'a');
  assert.equal(sectionForPage(outline, 5).id, 'b');
  assert.equal(sectionForPage(outline, 99).id, 'd');
  assert.equal(sectionForPage(outline, 0), null);
  assert.equal(sectionForPage([], 3), null);
  assert.equal(sectionForPage(undefined, 3), null);
});

test('无浏览器全局时不声称支持 PDF', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(browserSupportsPdf(), false);
});
