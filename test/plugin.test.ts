import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin, { createBetterPatchTool } from '../src/index.js';

const add = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+hello\n*** End Patch`;

test('registers a per-session factory and edits the workspace through the tool contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'better-patch-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let factory: typeof createBetterPatchTool | undefined;
  plugin.register({ registerTool(fn: typeof createBetterPatchTool) { factory = fn; } } as any);
  const tool = factory!({ workspaceDir: root, sandboxed: false });
  assert.ok(tool);
  assert.equal(tool.name, 'better_patch');
  const result = await tool.execute('test', { input: add('nested/file.txt') });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Success. Verified final file bytes and expected path presence/absence for all touched paths.\nA nested/file.txt\n' }],
    details: { added: ['nested/file.txt'], modified: [], deleted: [], unchanged: [],
      verification: { status: 'passed', checkedPaths: 1 } } });
  assert.equal(await readFile(join(root, 'nested/file.txt'), 'utf8'), 'hello\n');
  await assert.rejects(tool.execute('bad', { input: 7 }), /requires a string/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute('abort', { input: add('aborted') }, controller.signal), /abort/i);
  await assert.rejects(readFile(join(root, 'aborted')), { code: 'ENOENT' });
});

test('sandbox sessions never fall back to host writes; workspace-less sessions have no tool', async () => {
  const tool = createBetterPatchTool({ sandboxed: true, workspaceDir: '/tmp' })!;
  await assert.rejects(tool.execute('unavailable', { input: add('forbidden') }), /host fallback is forbidden/);
  assert.equal(createBetterPatchTool({}), null);
});

test('workspace-only policy rejects traversal, absolute escapes, symlink escapes and move escapes before editing', async t => {
  const base = await mkdtemp(join(tmpdir(), 'better-patch-boundary-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  const tool = createBetterPatchTool({ workspaceDir: root, fsPolicy: { workspaceOnly: true, root } })!;
  for (const path of ['../escaped', join(outside, 'escaped')]) {
    await assert.rejects(tool.execute('escape', { input: add(path) }), { code: "outside-workspace" });
  }
  if (process.platform !== 'win32') {
    await symlink(outside, join(root, 'link'));
    await assert.rejects(tool.execute('link', { input: add('link/escaped') }), { code: "outside-workspace" });
    await symlink(join(outside, 'missing'), join(root, 'dangling'));
    await assert.rejects(tool.execute('dangling', { input: add('dangling/escaped') }), { code: "outside-workspace" });
  }
  await tool.execute('source', { input: add('source') });
  await assert.rejects(tool.execute('move', { input: '*** Begin Patch\n*** Update File: source\n*** Move to: ../outside/moved\n@@\n-hello\n+bye\n*** End Patch' }), { code: "outside-workspace" });
  assert.equal(await readFile(join(root, 'source'), 'utf8'), 'hello\n');
  await assert.rejects(readFile(join(outside, 'escaped')), { code: 'ENOENT' });
});

test('effective policy root can be narrower than workspace; unrestricted sessions allow absolute paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'better-patch-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, 'allowed'); await mkdir(allowed);
  const restricted = createBetterPatchTool({ workspaceDir: root, fsPolicy: { workspaceOnly: true, root: allowed } })!;
  await assert.rejects(restricted.execute('bad', { input: add('not-allowed') }), { code: "outside-workspace" });
  await restricted.execute('ok', { input: add('allowed/file') });
  const free = createBetterPatchTool({ workspaceDir: allowed, fsPolicy: { workspaceOnly: false } })!;
  await free.execute('absolute', { input: add(join(root, 'absolute')) });
  assert.equal(await readFile(join(root, 'absolute'), 'utf8'), 'hello\n');
});

test('sandbox resolution rejects remote placements and stale session identities before provisioning', async () => {
  const { sandboxResolver } = await import('../src/sandbox.js');
  const ctx = { sandboxed: true, sessionKey: 'agent:main:test', sessionId: 'current', workspaceDir: '/tmp', config: {} };
  for (const session of [null, { sessionId: 'stale' }, { sessionId: 'current', placement: { state: 'active' } }]) {
    const resolver = sandboxResolver({ runtime: { gateway: {
      isAvailable: async () => true,
      request: async () => ({ session }),
    } } } as any);
    await assert.rejects(resolver(ctx), /identity|Worker placement/);
  }
});

for (const mode of ['corrupt', 'denied', 'write-error'] as const) {
  test(`sandbox tool reports ${mode} in model-visible text and error details without host fallback`, async () => {
    const files = new Map<string, Buffer>();
    let reads = 0;
    const sandbox = {
      workspaceDir: '/host', agentWorkspaceDir: '/host', docker: {}, containerWorkdir: '/workspace', workspaceAccess: 'rw',
      fsBridge: {
        resolvePath: ({ filePath }: { filePath: string }) => ({
          containerPath: filePath.startsWith('/') ? filePath : `/workspace/${filePath}`,
        }),
        stat: async ({ filePath }: { filePath: string }) => filePath === '/workspace' ? { type: 'directory' }
          : files.has(filePath) ? { type: 'file' } : null,
        readFile: async ({ filePath }: { filePath: string }) => {
          reads++;
          if (mode === 'denied') throw new Error('sandbox readback denied');
          return files.get(filePath)!;
        },
        writeFile: async ({ filePath, data }: { filePath: string; data: string }) => {
          files.set(filePath, Buffer.from(mode === 'corrupt' ? 'wrong' : data));
          if (mode === 'write-error') throw new Error('write acknowledgment failed');
        },
      },
    };
    const tool = createBetterPatchTool({ workspaceDir: '/host', sandboxed: true }, async () => sandbox as any)!;
    const result = await tool.execute('fault', { input: add('file') });
    assert.equal(result.isError, true);
    assert.equal(result.details.phase, mode === 'write-error' ? 'execution' : 'verification');
    assert.equal(result.details.mutationAttempted, true);
    assert.equal(result.details.verification.status, mode === 'write-error' ? 'not-run' : 'failed');
    const text = result.content[0].text;
    assert.match(text, /Changes may already have occurred; no rollback was performed/);
    assert.doesNotMatch(text, /Success/);
    if (mode !== 'write-error') {
      assert.equal(reads, 1);
      assert.deepEqual(result.details.verification.failures.map((f: any) => [f.path, f.status]), [
        ['file', mode === 'corrupt' ? 'mismatch' : 'unreadable'],
      ]);
      assert.match(text, mode === 'corrupt' ? /file: mismatch: Final file bytes differ/ : /file: unreadable: sandbox readback denied/);
    } else {
      assert.equal(reads, 0);
      assert.match(text, /operation 1\/1 \(add file\)/);
    }
    assert.ok(files.has('/workspace/file'));
  });
}
