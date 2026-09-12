import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hostFileSystem } from '../src/host.js';
import { applyVerifiedPatch } from '../src/patch.js';
const add = (path: string, text: string) => `*** Add File: ${path}\n+${text}`;
const update = (path: string, old: string, text: string) => `*** Update File: ${path}\n@@\n-${old}\n+${text}`;
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'patch-dependencies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = await hostFileSystem(dir, dir);
  const mutations: string[] = [];
  const fs = { ...base, write: async (...args: Parameters<typeof base.write>) => { mutations.push('write'); return base.write(...args); },
    remove: async (path: string) => { mutations.push('remove'); return base.remove(path); } };
  return { dir, mutations, run: (body: string) => applyVerifiedPatch(body, dir, fs) };
}
test('add then update is one added path with final content', async t => {
  const { dir, run } = await setup(t);
  const result = await run(`${add('f', 'one')}\n${update('./f', 'one', 'two')}`);
  assert.deepEqual(result.added, ['f']); assert.deepEqual(result.modified, []);
  assert.equal(await readFile(join(dir, 'f'), 'utf8'), 'two\n');
});
test('bad dependent update rejects before any mutations', async t => {
  const { run, mutations } = await setup(t);
  await assert.rejects(run(`${add('f', 'one')}\n${update('f', 'wrong', 'two')}`), /expected lines/);
  assert.deepEqual(mutations, []);
});
test('move destination contents feed the next update', async t => {
  const { dir, run } = await setup(t);
  await writeFile(join(dir, 'a'), 'one\n'); await writeFile(join(dir, 'b'), 'old\n');
  const result = await run(`*** Update File: a\n*** Move to: b\n@@\n-one\n+two\n${update('b', 'two', 'three')}`);
  assert.deepEqual(result.deleted, ['a']); assert.deepEqual(result.modified, ['b']);
  assert.equal(await readFile(join(dir, 'b'), 'utf8'), 'three\n');
});
test('delete then add then update replaces contents in order', async t => {
  const { dir, run } = await setup(t);
  await writeFile(join(dir, 'f'), Buffer.from([255]));
  const result = await run(`*** Delete File: f\n${add('f', 'one')}\n${update('f', 'one', 'two')}`);
  assert.deepEqual(result.modified, ['f']); assert.deepEqual(result.added, []);
  assert.equal(await readFile(join(dir, 'f'), 'utf8'), 'two\n');
});
test('add then delete has no net file change', async t => {
  const { run } = await setup(t);
  const result = await run(`${add('f', 'one')}\n*** Delete File: f`);
  assert.deepEqual(result.unchanged, ['f']); assert.deepEqual(result.added, []);
});
test('noop add update and missing delete do not call mutation methods', async t => {
  const { dir, run, mutations } = await setup(t);
  await writeFile(join(dir, 'f'), 'one\n');
  const result = await run(`${add('f', 'one')}\n${update('f', 'one', 'one')}\n*** Delete File: absent`);
  assert.deepEqual(mutations, []); assert.deepEqual(result.unchanged, ['f', 'absent']);
  assert.equal(result.text, 'Success. Verified final file bytes and expected path presence/absence for all touched paths.\nN f\nN absent\n');
});
test('BOM and mixed context preserve exact bytes without writes', async t => {
  const { dir, run, mutations } = await setup(t);
  await writeFile(join(dir, 'f'), '\uFEFF  one \r\ntwo');
  const result = await run('*** Update File: f\n@@\n one\n two');
  assert.deepEqual(mutations, []); assert.deepEqual(result.unchanged, ['f']);
});
test('visually identical replacement that changes ending is not noop', async t => {
  const { dir, run, mutations } = await setup(t);
  await writeFile(join(dir, 'f'), 'head\r\none\ntail');
  const result = await run(update('f', 'one', 'one'));
  assert.deepEqual(result.modified, ['f']); assert.deepEqual(mutations, ['write']);
  assert.equal(await readFile(join(dir, 'f'), 'utf8'), 'head\r\none\r\ntail');
});
test('unchanged contents moved to a new path still move', async t => {
  const { dir, run, mutations } = await setup(t);
  await writeFile(join(dir, 'f'), 'one\n');
  const result = await run('*** Update File: f\n*** Move to: moved\n@@\n one');
  assert.deepEqual(result.added, ['moved']); assert.deepEqual(result.deleted, ['f']);
  assert.deepEqual(mutations, ['write', 'remove']);
});
test('virtual parent directories track child deletion and recreation', async t => {
  const { dir, run } = await setup(t);
  await mkdir(join(dir, 'd')); await writeFile(join(dir, 'd/old'), 'old');
  await run(`*** Delete File: d/old\n*** Delete File: d\n${add('d/new', 'one')}\n${update('d/new', 'one', 'two')}`);
  assert.equal(await readFile(join(dir, 'd/new'), 'utf8'), 'two\n');
});
test('virtual nonempty directory rejects before writes', async t => {
  const { run, mutations } = await setup(t);
  await assert.rejects(run(`${add('d/f', 'one')}\n*** Delete File: d`), /not empty/);
  assert.deepEqual(mutations, []);
});

test('dangling symlink deletion is not a missing-path noop', async t => {
  const { dir, run, mutations } = await setup(t);
  await symlink('absent', join(dir, 'link'));
  const result = await run('*** Delete File: link');
  assert.deepEqual(result.deleted, ['link']); assert.deepEqual(mutations, ['remove']);
  await assert.rejects(lstat(join(dir, 'link')), { code: 'ENOENT' });
});
test('unchanged symlink update skips replacement but Add replaces the entry', async t => {
  const { dir, run, mutations } = await setup(t);
  await writeFile(join(dir, 'f'), 'one\n'); await symlink('f', join(dir, 'link'));
  const result = await run(update('link', 'one', 'one'));
  assert.deepEqual(result.unchanged, ['link']); assert.deepEqual(mutations, []);
  assert.equal((await lstat(join(dir, 'link'))).isSymbolicLink(), true);
  const added = await run(add('link', 'one'));
  assert.deepEqual(added.modified, ['link']); assert.equal((await lstat(join(dir, 'link'))).isSymbolicLink(), false);
});
test('delete a file then create a child at that path', async t => {
  const { dir, run } = await setup(t);
  await writeFile(join(dir, 'd'), 'old');
  const result = await run(`*** Delete File: d\n${add('d/f', 'one')}`);
  assert.deepEqual(result.added, ['d/f']);
  assert.equal(await readFile(join(dir, 'd/f'), 'utf8'), 'one\n');
});
test('pure binary deletion never reads file contents', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'patch-binary-delete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'f'), Buffer.from([255]));
  const base = await hostFileSystem(dir, dir);
  const result = await applyVerifiedPatch('*** Delete File: f', dir, {
    ...base, read: async () => { throw new Error('delete must not read'); },
  });
  assert.deepEqual(result.deleted, ['f']);
});
