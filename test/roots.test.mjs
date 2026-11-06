import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { RootStore } from '../lib/roots.js';

async function makeStore() {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'pr-roots-'));
  const cwd = path.join(base, 'work');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');
  const stateFile = path.join(base, 'state', 'roots.json');
  for (const dir of [cwd, first, second]) await fs.mkdir(dir, { recursive: true });
  return {
    base,
    cwd,
    first,
    second,
    stateFile,
    build: (roots) => new RootStore({ config: { roots }, cwd, stateFile }),
  };
}

test('默认快照：工作目录在最前，配置目录随后、去重', async () => {
  const { base, cwd, first, build } = await makeStore();
  try {
    const store = build([first, cwd, first]);
    await store.load();
    const roots = store.snapshot();
    assert.equal(roots.length, 2);
    assert.equal(roots[0], cwd);
    assert.equal(roots[1], first);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('添加目录会持久化，新的实例能读回来', async () => {
  const { base, cwd, first, second, stateFile, build } = await makeStore();
  try {
    const store = build([first]);
    await store.add(second);
    assert.deepEqual(store.snapshot(), [cwd, first, second]);

    const reloaded = build([first]);
    await reloaded.load();
    assert.deepEqual(reloaded.snapshot(), [cwd, first, second]);

    const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.added, [second]);
    assert.deepEqual(raw.removed, []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('重复目录、不存在的目录、工作目录本身都被拒绝', async () => {
  const { base, cwd, first, build } = await makeStore();
  try {
    const store = build([first]);
    await assert.rejects(() => store.add(first), /已经在论文目录里/);
    await assert.rejects(() => store.add(cwd), /已经在论文目录里/);
    await assert.rejects(() => store.add(path.join(base, 'nope')), /目录不存在/);
    await assert.rejects(() => store.add('   '), /路径为空/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('移除配置目录后不会再出现，重新添加会恢复且不重复', async () => {
  const { base, cwd, first, second, build } = await makeStore();
  try {
    const store = build([first, second]);
    await store.remove(first);
    assert.deepEqual(store.snapshot(), [cwd, second]);

    const reloaded = build([first, second]);
    await reloaded.load();
    assert.deepEqual(reloaded.snapshot(), [cwd, second]);

    await reloaded.add(first);
    assert.deepEqual(reloaded.snapshot(), [cwd, first, second]);
    assert.deepEqual(reloaded.state.added, []);
    assert.deepEqual(reloaded.state.removed, []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('工作目录可以移除并恢复，未知目录不能移除', async () => {
  const { base, cwd, build } = await makeStore();
  try {
    const store = build([]);
    await store.remove(cwd);
    assert.deepEqual(store.snapshot(), []);
    await store.add(cwd);
    assert.deepEqual(store.snapshot(), [cwd]);
    await assert.rejects(() => store.remove(path.join(base, 'ghost')), /不在论文目录里/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('状态文件损坏时退回“只有默认目录”，不阻塞使用', async () => {
  const { base, cwd, first, stateFile, build } = await makeStore();
  try {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, '{ 这不是 JSON', 'utf8');
    const reloaded = build([first]);
    await reloaded.load();
    assert.deepEqual(reloaded.snapshot(), [cwd, first]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
