import assert from 'node:assert/strict';
import { posix } from 'node:path';
import test from 'node:test';
import { sandboxFileSystem } from '../src/sandbox.js';

function sandbox() {
  let calls = 0;
  const bridge = {
    resolvePath: ({ filePath }: { filePath: string }) => ({ containerPath: posix.normalize(filePath.replace(/^\/host(?=\/|$)/, '/workspace')) }),
    readFile: async () => { calls++; return Buffer.from('text'); },
    writeFile: async () => { calls++; },
    remove: async () => { calls++; },
  };
  return { context: { workspaceDir: '/host', agentWorkspaceDir: '/host', docker: {}, containerWorkdir: '/workspace', workspaceAccess: 'rw', fsBridge: bridge } as any,
    calls: () => calls };
}

for (const root of ['/host/allowed', '/workspace/alias', '/other']) {
  test(`sandbox rejects unenforceable custom root ${root} before any filesystem operation`, () => {
    const fixture = sandbox();
    assert.throws(() => sandboxFileSystem(fixture.context, undefined, root), /root-scoped bridge is required/);
    assert.equal(fixture.calls(), 0);
  });
}

test('sandbox accepts its mapped workspace root and keeps lexical path rejection', async () => {
  const fixture = sandbox();
  const files = sandboxFileSystem(fixture.context, undefined, '/host/.');
  await files.checkPath('/workspace/file');
  await assert.rejects(files.checkPath('/outside/file'), /outside the workspace/);
  assert.equal(fixture.calls(), 0);
  await files.write('/workspace/file', 'text', true);
  assert.equal(fixture.calls(), 1);
});

test('unrestricted sandbox delegates to the bridge without inventing an additional root', async () => {
  const fixture = sandbox();
  const files = sandboxFileSystem(fixture.context);
  await files.write('/workspace/file', 'text', true);
  assert.equal(fixture.calls(), 1);
});

for (const [name, extra] of [
  ['custom bind', { docker: { binds: ['/elsewhere:/extra:rw'] } }],
  ['separate agent workspace', { agentWorkspaceDir: '/agent' }],
  ['external resource mount', { readOnlyResourceMounts: [{ hostPath: '/resource', containerPath: '/resource' }] }],
] as const) {
  test(`workspace-only sandbox rejects ${name} without a root-scoped capability`, () => {
    const fixture = sandbox();
    assert.throws(() => sandboxFileSystem({ ...fixture.context, ...extra }, undefined, '/host'), /additional mounts requires a root-scoped bridge/);
    assert.equal(fixture.calls(), 0);
    assert.doesNotThrow(() => sandboxFileSystem({ ...fixture.context, ...extra }));
  });
}

test('sandbox metadata confirms missing parents without swallowing unconfirmed errors', async () => {
  const fixture = sandbox();
  const denied = new Error('permission denied');
  fixture.context.fsBridge.stat = async ({ filePath }: { filePath: string }) => {
    if (filePath === '/workspace/missing') return null;
    if (filePath === '/workspace/file') return { type: 'file' };
    if (filePath === '/workspace') return { type: 'directory' };
    throw denied;
  };
  const files = sandboxFileSystem(fixture.context, undefined, '/host');
  assert.deepEqual(await files.inspect('/workspace/file'), { kind: 'file' });
  assert.equal(await files.inspect('/workspace/missing/parents/file'), null);
  await assert.rejects(files.inspect('/workspace/denied'), error => error === denied);
  await assert.rejects(files.inspect('/outside/file'), /outside the workspace/);
  assert.equal(files.list, undefined);
});

test('sandbox metadata respects cancellation', async () => {
  const fixture = sandbox();
  fixture.context.fsBridge.stat = async () => { throw new Error('must not call'); };
  const controller = new AbortController();
  controller.abort();
  const files = sandboxFileSystem(fixture.context, controller.signal);
  await assert.rejects(files.inspect('/workspace/file'), { name: 'AbortError' });
});

test('sandbox workspace metadata does not stat outside the mount root', async () => {
  const fixture = sandbox();
  fixture.context.fsBridge.stat = async () => { throw new Error('root stat unsupported'); };
  const files = sandboxFileSystem(fixture.context, undefined, '/host');
  assert.deepEqual(await files.inspect('/workspace'), { kind: 'directory' });
});
