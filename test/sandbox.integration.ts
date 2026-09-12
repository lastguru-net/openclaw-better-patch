// Opt-in: runs disposable Docker sandboxes, never a Gateway.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createBetterPatchTool } from '../src/index.js';
import { sandboxResolver } from '../src/sandbox.js';

const root = await mkdtemp(join(tmpdir(), 'better-patch-sandbox-test-'));
process.env.OPENCLAW_STATE_DIR = join(root, 'state');
process.env.OPENCLAW_CONFIG_PATH = join(root, 'config.json');
await writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}');
const { resolveSandboxContext } = await import('openclaw/plugin-sdk/agent-harness-runtime');
test('stable SDK uses the existing Docker sandbox for patch operations and enforces its boundary', async t => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const config = { agents: { defaults: { skipBootstrap: true, sandbox: {
    mode: 'all', scope: 'session', workspaceAccess: 'rw', workspaceRoot: join(root, 'sandboxes'),
    docker: { image: 'python:3.12-slim', containerPrefix: 'better-patch-test-', network: 'none' },
    prune: { idleHours: 0, maxAgeDays: 0 },
  } } } } as const;
  const ctx = { config, runtimeConfig: config, agentId: 'main', sessionKey: 'agent:main:better-patch-test', workspaceDir: workspace, sandboxed: true, fsPolicy: { workspaceOnly: true } };
  const active = await resolveSandboxContext({ config, agentId: ctx.agentId, sessionKey: ctx.sessionKey, workspaceDir: workspace });
  assert.ok(active?.fsBridge);
  t.after(() => execFileSync('docker', ['rm', '-f', active.runtimeId], { stdio: 'pipe' }));
  const resolve = sandboxResolver({ runtime: { gateway: { isAvailable: async () => false }, agent: { session: { getSessionEntry: () => undefined } } } } as any);
  const resolved = await resolve(ctx);
  assert.equal(resolved?.runtimeId, active.runtimeId);
  assert.equal(resolved?.workspaceDir, active.workspaceDir);
  const tool = createBetterPatchTool(ctx, resolve)!;
  await t.test('ordered dependencies and no-op results', async () => {
    const dependent = await tool.execute('dependent', { input: '*** Add File: dependent\n+one\n*** Update File: dependent\n@@\n-one\n+two' });
    assert.deepEqual(dependent.details, { added: ['dependent'], modified: [], deleted: [], unchanged: [],
      verification: { status: 'passed', checkedPaths: 1 } });
    const noop = await tool.execute('noop', { input: '*** Add File: dependent\n+two\n*** Update File: dependent\n@@\n-two\n+two\n*** Delete File: not-present' });
    assert.deepEqual(noop.details, { added: [], modified: [], deleted: [], unchanged: ['dependent', 'not-present'],
      verification: { status: 'passed', checkedPaths: 2 } });
    await assert.rejects(tool.execute('bad-dependent', { input: '*** Add File: uncreated\n+one\n*** Update File: uncreated\n@@\n-wrong\n+two' }), /expected lines/);
    assert.equal(await active.fsBridge.stat({ filePath: `${active.containerWorkdir}/uncreated` }), null);
  });
  await t.test('exact numbered chunks', async () => {
    await tool.execute('numbered', { input: '*** Add File: numbered\n+same\n+same\n*** Update File: numbered\n@@@ 2\n-same\n+changed' });
    assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/numbered` })).toString(), 'same\nchanged\n');
    await assert.rejects(tool.execute('numbered-mismatch', { input: '*** Add File: numbered-uncreated\n+new\n*** Update File: numbered\n@@@ 1\n-changed\n+wrong' }), /Exact text mismatch/);
    assert.equal(await active.fsBridge.stat({ filePath: `${active.containerWorkdir}/numbered-uncreated` }), null);
  });
  await t.test('add, move and path boundaries', async () => {
    await tool.execute('add', { input: '*** Add File: nested/file\n+old' });
    await tool.execute('move', { input: '*** Update File: nested/file\n*** Move to: moved/file\n@@\n-old\n+new' });
    assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/moved/file` })).toString(), 'new\n');
    await assert.rejects(readFile(join(workspace, 'nested/file')), { code: 'ENOENT' });
    await assert.rejects(tool.execute('escape', { input: '*** Add File: /tmp/escape\n+bad' }), /outside|escape|workspace/i);
    execFileSync('docker', ['exec', active.runtimeId, 'ln', '-s', '/tmp', `${active.containerWorkdir}/link`]);
    await assert.rejects(tool.execute('symlink', { input: '*** Add File: link/escape\n+bad' }), /outside|escape|symlink|workspace/i);
  });
  await t.test('source text, BOM and line endings', async () => {
    await active.fsBridge.writeFile({ filePath: `${active.containerWorkdir}/preserved`, data: '  keep \t\r\nold\r\ntail' });
    await tool.execute('preserve', { input: '*** Update File: preserved\n@@\n keep\n-old\n+new\n tail' });
    assert.deepEqual(await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/preserved` }),
      Buffer.from('  keep \t\r\nnew\r\ntail'));
    await active.fsBridge.writeFile({ filePath: `${active.containerWorkdir}/logical`, data: '\uFEFFhead\n\rold' });
    await tool.execute('logical-endings', { input: '*** Update File: logical\n@@\n+before\n head\n-old\n+new\n+' });
    assert.deepEqual(await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/logical` }),
      Buffer.from('\uFEFFbefore\n\rhead\n\rnew\n\r'));
  });
  await t.test('EOF chunks and final-terminator controls', async () => {
    const path = `${active.containerWorkdir}/eof`;
    await active.fsBridge.writeFile({ filePath: path, data: '\uFEFFsame\r\nsame' });
    await tool.execute('eof-append', { input: '*** Update File: eof\n@@.\n same\n+' });
    assert.deepEqual(await active.fsBridge.readFile({ filePath: path }), Buffer.from('\uFEFFsame\r\nsame\r\n'));
    const noop = await tool.execute('eof-ensure', { input: '*** Update File: eof\n@@.\n.+' });
    assert.deepEqual(noop.details, { added: [], modified: [], deleted: [], unchanged: ['eof'],
      verification: { status: 'passed', checkedPaths: 1 } });
    await tool.execute('eof-move-strip', { input: '*** Update File: eof\n*** Move to: moved/eof\n@@.\n.-' });
    assert.equal(await active.fsBridge.stat({ filePath: path }), null);
    assert.deepEqual(await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/moved/eof` }),
      Buffer.from('\uFEFFsame\r\nsame'));
    await tool.execute('eof-create', { input: '*** Add File: unterminated\n+hello\n.-' });
    assert.deepEqual(await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/unterminated` }), Buffer.from('hello'));
  });
  await t.test('narrow-root rejection', async () => {
    await active.fsBridge.mkdirp({ filePath: `${active.containerWorkdir}/allowed` });
    await active.fsBridge.writeFile({ filePath: `${active.containerWorkdir}/outside/keep`, data: 'unchanged', mkdir: true });
    execFileSync('docker', ['exec', active.runtimeId, 'ln', '-s', '../outside', `${active.containerWorkdir}/allowed/link`]);
    const restrictedTool = createBetterPatchTool({ ...ctx, fsPolicy: { workspaceOnly: true, root: join(workspace, 'allowed') } }, resolve)!;
    for (const body of [
      '*** Add File: allowed/link/leak\n+bad',
      '*** Update File: allowed/link/keep\n@@\n-unchanged\n+bad',
      '*** Delete File: allowed/link/keep',
      '*** Add File: allowed/plain\n+also cannot safely enforce this root',
    ]) {
      await assert.rejects(restrictedTool.execute('restricted', { input: body }), /root-scoped bridge is required/);
    }
    assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/outside/keep` })).toString(), 'unchanged');
    assert.equal(await active.fsBridge.stat({ filePath: `${active.containerWorkdir}/outside/leak` }), null);
    assert.equal(await active.fsBridge.stat({ filePath: `${active.containerWorkdir}/allowed/plain` }), null);
  });
  await t.test('same-path updates and deletion', async () => {
    await tool.execute('same-path-move', { input: '*** Update File: moved/file\n*** Move to: moved/./file\n@@\n-new\n+same path retained' });
    assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/moved/file` })).toString(), 'same path retained\n');
    await tool.execute('delete', { input: '*** Delete File: moved/file' });
    await assert.rejects(readFile(join(workspace, 'moved/file')), { code: 'ENOENT' });
    await active.fsBridge.writeFile({ filePath: `${active.containerWorkdir}/binary`, data: Buffer.from([0xff, 0xfe]) });
    await active.fsBridge.mkdirp({ filePath: `${active.containerWorkdir}/empty` });
    await active.fsBridge.writeFile({ filePath: `${active.containerWorkdir}/nonempty/keep`, data: 'keep', mkdir: true });
    const remainingDeleteTargets = new Set(['binary', 'empty']);
    for (const path of ['binary', 'empty', 'absent', 'missing/parents/absent', 'binary']) {
      const existed = remainingDeleteTargets.delete(path);
      const result = await tool.execute('delete', { input: `*** Delete File: ${path}` });
      assert.deepEqual(result.details, { added: [], modified: [], deleted: existed ? [path] : [], unchanged: existed ? [] : [path],
        verification: { status: 'passed', checkedPaths: 1 } });
      execFileSync('docker', ['exec', active.runtimeId, 'test', '!', '-e', `${active.containerWorkdir}/${path}`]);
    }
    const nonempty = await tool.execute('nonempty', { input: '*** Delete File: nonempty' });
    assert.equal(nonempty.isError, true);
    assert.equal(nonempty.details.phase, 'execution');
    assert.equal(nonempty.details.verification.status, 'not-run');
    assert.match(nonempty.content[0].text, /not empty|ENOTEMPTY/);
    assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/nonempty/keep` })).toString(), 'keep');
    await assert.rejects(tool.execute('delete-escape', { input: '*** Delete File: /tmp/absent' }), /outside|escape|workspace/i);
  });
  await t.test('additional-mount rejection', async () => {
    const extraMount = join(workspace, 'extra-mount'); await mkdir(extraMount);
    await writeFile(join(extraMount, 'keep'), 'outside workspace');
    const mountedConfig = { agents: { defaults: { ...config.agents.defaults, sandbox: { ...config.agents.defaults.sandbox,
      docker: { ...config.agents.defaults.sandbox.docker, binds: [`${extraMount}:/extra:rw`] },
    } } } };
    const mountedCtx = { ...ctx, config: mountedConfig, runtimeConfig: mountedConfig, sessionKey: `${ctx.sessionKey}:mount` };
    const mounted = await resolveSandboxContext({ config: mountedConfig, agentId: ctx.agentId, sessionKey: mountedCtx.sessionKey, workspaceDir: workspace });
    assert.ok(mounted?.fsBridge);
    t.after(() => execFileSync('docker', ['rm', '-f', mounted.runtimeId], { stdio: 'pipe' }));
    execFileSync('docker', ['exec', mounted.runtimeId, 'ln', '-s', '/extra', `${mounted.containerWorkdir}/mounted-link`]);
    const mountedTool = createBetterPatchTool(mountedCtx, resolve)!;
    await assert.rejects(mountedTool.execute('mounted-escape', { input: '*** Add File: mounted-link/leak\n+bad' }), /additional mounts requires a root-scoped bridge/);
    assert.equal(await readFile(join(extraMount, 'keep'), 'utf8'), 'outside workspace');
    await assert.rejects(readFile(join(extraMount, 'leak')), { code: 'ENOENT' });
  });
  await t.test('host isolation and read-only policy', async () => {
    for (const access of ['none', 'ro'] as const) {
      const isolatedConfig = { agents: { defaults: { ...config.agents.defaults, sandbox: { ...config.agents.defaults.sandbox, workspaceAccess: access } } } };
      const isolatedCtx = { ...ctx, config: isolatedConfig, runtimeConfig: isolatedConfig, sessionKey: `${ctx.sessionKey}:${access}` };
      const isolated = await resolveSandboxContext({ config: isolatedConfig, agentId: ctx.agentId, sessionKey: isolatedCtx.sessionKey, workspaceDir: workspace });
      assert.ok(isolated?.fsBridge);
      t.after(() => execFileSync('docker', ['rm', '-f', isolated.runtimeId], { stdio: 'pipe' }));
      const isolatedTool = createBetterPatchTool(isolatedCtx, resolve)!;
      if (access === 'ro') {
        await assert.rejects(isolatedTool.execute('readonly', { input: '*** Add File: forbidden\n+bad' }), /read-only/);
      } else {
        await writeFile(join(workspace, 'same-name'), 'host must stay unchanged\n');
        await isolatedTool.execute('isolated', { input: '*** Add File: same-name\n+sandbox only' });
        assert.equal(await readFile(join(workspace, 'same-name'), 'utf8'), 'host must stay unchanged\n');
        assert.equal((await isolated.fsBridge.readFile({ filePath: `${isolated.containerWorkdir}/same-name` })).toString(), 'sandbox only\n');
      }
    }
  });
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', active.runtimeId], { encoding: 'utf8' }).trim(), 'true');
});
