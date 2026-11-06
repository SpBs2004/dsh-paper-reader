import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PaperReaderPanel } from '../client-src/panel.js';

// 面板只用到这几个 window 成员：目录弹窗的 Esc 监听、toast 定位、大纲跳转
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  document: { getElementById: () => null },
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOTS = [
  { path: 'C:/work', exists: true, count: 1, source: 'cwd', removable: true },
  { path: 'E:/papers', exists: true, count: 32, source: 'config', removable: true },
];

function makeApi() {
  const calls = [];
  const api = {
    calls,
    async state() {
      return { roots: ROOTS, defaultRoot: ROOTS[0].path };
    },
    async list() {
      return { papers: [{ id: 'p1', title: 'Paper', kind: 'tex', bytes: 100, mtime: 0, relPath: 'a.tex' }] };
    },
    async view() {
      return {
        id: 'p1',
        title: 'Paper',
        kind: 'tex',
        path: 'C:/work/a.tex',
        authors: '',
        outline: [],
        blocks: [],
        truncated: false,
        error: null,
      };
    },
    async notesRead() {
      return { path: '', exists: false, markdown: '' };
    },
    async targets() {
      return { sessions: [] };
    },
    async addRoot(path) {
      calls.push(['add', path]);
      return { roots: [...ROOTS, { path, exists: true, count: 0, source: 'user', removable: true }], defaultRoot: ROOTS[0].path };
    },
    async removeRoot(path) {
      calls.push(['remove', path]);
      return { roots: ROOTS.filter((root) => root.path !== path), defaultRoot: ROOTS[0].path };
    },
    async pickDirectory() {
      return { supported: true, path: 'E:/picked' };
    },
  };
  return api;
}

async function renderPanel(api, ctx) {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PaperReaderPanel, {
        api,
        ctx: ctx ?? { get: () => undefined },
        t: (key, params) => (params ? `${key}(${Object.values(params).join(',')})` : key),
        tracker: { current: () => null },
      }),
    );
  });
  return renderer;
}

const textOf = (renderer) => JSON.stringify(renderer.toJSON());

function findButton(renderer, label) {
  return renderer.root.findAllByType('button').find((node) => node.children.join('') === label);
}

function findInput(renderer, placeholder) {
  return renderer.root.findAllByType('input').find((node) => node.props.placeholder === placeholder);
}

test('目录按钮打开弹窗，列出根目录并显示来源', async () => {
  const api = makeApi();
  const renderer = await renderPanel(api);
  try {
    assert.ok(findButton(renderer, '＋'), '根目录栏应有添加按钮');
    assert.ok(findButton(renderer, '⚙'), '根目录栏应有管理按钮');

    assert.equal(textOf(renderer).includes('library.roots.title'), false, '弹窗默认关闭');
    await act(async () => {
      findButton(renderer, '＋').props.onClick();
    });

    const body = textOf(renderer);
    assert.ok(body.includes('library.roots.title'));
    assert.ok(body.includes('C:/work'), '弹窗应列出工作目录');
    assert.ok(body.includes('E:/papers'), '弹窗应列出手动/配置目录');
    assert.ok(body.includes('library.roots.sourceCwd'));
    assert.ok(findInput(renderer, 'library.roots.inputPlaceholder'), '弹窗应有路径输入框');
  } finally {
    renderer.unmount();
  }
});

test('输入路径 → 调用 addRoot → 弹窗关闭并选中新目录', async () => {
  const api = makeApi();
  const renderer = await renderPanel(api);
  try {
    await act(async () => {
      findButton(renderer, '＋').props.onClick();
    });
    const input = findInput(renderer, 'library.roots.inputPlaceholder');
    await act(async () => {
      input.props.onChange({ target: { value: 'E:/new' } });
    });
    const confirm = findButton(renderer, 'library.roots.confirm');
    await act(async () => {
      confirm.props.onClick();
    });

    assert.deepEqual(api.calls, [['add', 'E:/new']]);
    const body = textOf(renderer);
    assert.equal(body.includes('library.roots.title'), false, '成功后弹窗关闭');
    assert.ok(body.includes('E:/new'), '新目录应出现在根目录下拉里');
  } finally {
    renderer.unmount();
  }
});

test('移除目录走 removeRoot，错误显示在弹窗里', async () => {
  const api = makeApi();
  const renderer = await renderPanel(api);
  try {
    await act(async () => {
      findButton(renderer, '＋').props.onClick();
    });
    const rows = renderer.root.findAll((node) => node.props?.className === 'pr-rootrow');
    assert.equal(rows.length, 2);
    const removeButton = rows[1].findAllByType('button').find((node) => node.children.join('') === '×');
    assert.ok(removeButton, '每行应有移除按钮');
    await act(async () => {
      removeButton.props.onClick();
    });
    assert.deepEqual(api.calls, [['remove', 'E:/papers']]);

    // 失败路径：addRoot 抛错 → 弹窗保留并显示错误
    api.addRoot = async () => {
      throw new Error('目录不存在');
    };
    await act(async () => {
      findButton(renderer, '＋').props.onClick();
    });
    const input = findInput(renderer, 'library.roots.inputPlaceholder');
    await act(async () => {
      input.props.onChange({ target: { value: 'E:/ghost' } });
    });
    await act(async () => {
      findButton(renderer, 'library.roots.confirm').props.onClick();
    });
    const body = textOf(renderer);
    assert.ok(body.includes('library.roots.title'), '失败后弹窗保留');
    assert.ok(body.includes('library.roots.addFailed'), '应显示添加失败');
    assert.ok(body.includes('目录不存在'), '应带上宿主给的原因');
  } finally {
    renderer.unmount();
  }
});

test('浏览按钮优先用宿主 uiWorkspace.pickDirectory', async () => {  const api = makeApi();
  const picked = [];
  const ctx = {
    get(name) {
      if (name === 'uiWorkspace') {
        return {
          async pickDirectory() {
            picked.push(true);
            return 'E:/from-native';
          },
        };
      }
      return undefined;
    },
  };
  const renderer = await renderPanel(api, ctx);
  try {
    await act(async () => {
      findButton(renderer, '＋').props.onClick();
    });
    await act(async () => {
      findButton(renderer, 'library.roots.browse').props.onClick();
    });
    assert.deepEqual(picked, [true]);
    const input = findInput(renderer, 'library.roots.inputPlaceholder');
    assert.equal(input.props.value, 'E:/from-native');
  } finally {
    renderer.unmount();
  }
});

test('PDF 默认进入页面阅读，可切回文本模式', async () => {
  const api = makeApi();
  api.list = async () => ({
    papers: [{ id: 'pdf1', title: 'Pdf Paper', kind: 'pdf', bytes: 1024, mtime: 0, relPath: 'p.pdf' }],
  });
  api.view = async () => ({
    id: 'pdf1',
    title: 'Pdf Paper',
    kind: 'pdf',
    path: 'C:/work/p.pdf',
    authors: '',
    outline: [{ id: 's1', level: 1, title: 'Intro', page: 1, ordinal: 0 }],
    blocks: [
      { kind: 'page', page: 1 },
      { kind: 'para', text: 'hello from pdf text layer', page: 1, sectionId: 's1' },
    ],
    truncated: false,
    pages: 2,
    hasText: true,
    error: null,
  });
  const renderer = await renderPanel(api);
  try {
    await act(async () => {
      renderer.root.findAllByProps({ className: 'pr-item' })[0].props.onClick();
    });
    const body = textOf(renderer);
    assert.ok(body.includes('pr-article-pdf'), 'PDF 默认应渲染页面阅读器');
    assert.ok(findButton(renderer, 'reader.pdfTextMode'), '标题栏应有切回文本模式的按钮');

    await act(async () => {
      findButton(renderer, 'reader.pdfTextMode').props.onClick();
    });
    const textBody = textOf(renderer);
    assert.equal(textBody.includes('pr-article-pdf'), false, '切回文本后不再有页面阅读器');
    assert.ok(textBody.includes('hello from pdf text layer'));
    assert.ok(findButton(renderer, 'reader.pdfPageMode'), '文本模式可切回页面阅读');
  } finally {
    renderer.unmount();
  }
});
