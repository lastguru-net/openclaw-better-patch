import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePatch } from '../src/parser.js';
import { applyVerifiedPatch, inTemp, wrap } from './helpers.js';

const cases = [
  ['select repeated text', 'same\nsame\n', '@@@ 2\n-same\n+new', 'same\nnew\n'],
  ['source coordinates', 'a\nb\nc\n', '@@@ 1\n-a\n+x\n+y\n@@@ 3\n-c\n+z', 'x\ny\nb\nz\n'],
  ['insert before first', 'a\n', '@@@ 1\n+x', 'x\na\n'],
  ['append after trailing blank', 'a\n\n', '@@@ 3\n+x', 'a\n\nx\n'],
  ['empty file', '', '@@@ 1\n+x', 'x\n'],
  ['text matching after numbered chunk', 'a\nb\nc\n', '@@@ 1\n-a\n+x\n@@\n-b\n+y', 'x\ny\nc\n'],
  ['number after textual anchor', 'a\nb\nc\n', '@@ a\n-b\n+y\n@@@ 3\n-c\n+z', 'a\ny\nz\n'],
  ['same-position insertions', 'a\n', '@@@ 1\n+x\n@@@ 1\n+y', 'x\ny\na\n'],
];
for (const [name, source, body, expected] of cases) {
  test(`numbered chunks: ${name}`, () => inTemp(async cwd => {
    await writeFile(join(cwd, 'file'), source);
    await applyVerifiedPatch(wrap(`*** Update File: file\n${body}`), cwd);
    assert.equal(await readFile(join(cwd, 'file'), 'utf8'), expected);
  }));
}
for (const ending of ['\n', '\r', '\r\n', '\n\r']) {
  test(`numbered chunks preserve BOM and ${JSON.stringify(ending)}`, () => inTemp(async cwd => {
    await writeFile(join(cwd, 'file'), `\ufeffa${ending}b${ending}`);
    await applyVerifiedPatch(wrap('*** Update File: file\n@@@ 1\n-a\n+x'), cwd);
    assert.equal(await readFile(join(cwd, 'file'), 'utf8'), `\ufeffx${ending}b${ending}`);
  }));
}
for (const marker of ['@@@', '@@@ 0', '@@@ -1', '@@@ 1.5', '@@@ 1 extra', '@@@ 01', '@@@ 9007199254740992', '@@@ 1 ']) {
  test(`reject invalid numbered marker ${JSON.stringify(marker)}`, () => {
    assert.throws(() => parsePatch(wrap(`*** Update File: file\n${marker}\n+x`)), /positive safe integer/);
  });
}
for (const body of [
  '@@@ 1\n-a\n+x', // Only line 2 matches; do not search.
  '@@@ 2\n-a \n+x', // No whitespace tolerance.
  '@@@ 1\n-"a"\n+x', // No punctuation folding.
  '@@@ 4\n+x',
  '@@@ 3\n-a\n+x',
  '@@@ 2\n-a\n \n+x', // No missing-empty-context fallback.
  '@@@ 2\n-a\n+x\n@@@ 2\n-a\n+y',
]) {
  test(`numbered preflight rejects without writes: ${JSON.stringify(body)}`, () => inTemp(async cwd => {
    const source = '“a”\na\n';
    await writeFile(join(cwd, 'file'), source);
    await assert.rejects(applyVerifiedPatch(wrap(`*** Add File: created\n+new\n*** Update File: file\n${body}`), cwd));
    assert.equal(await readFile(join(cwd, 'file'), 'utf8'), source);
    await assert.rejects(readFile(join(cwd, 'created')), { code: 'ENOENT' });
  }));
}
test('numbered chunks use preceding operation contents and support moves', () => inTemp(async cwd => {
  await applyVerifiedPatch(wrap('*** Add File: file\n+a\n+b\n*** Update File: file\n*** Move to: moved\n@@@ 2\n-b\n+c'), cwd);
  assert.equal(await readFile(join(cwd, 'moved'), 'utf8'), 'a\nc\n');
  await assert.rejects(readFile(join(cwd, 'file')), { code: 'ENOENT' });
}));
