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
const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

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
  await tool.execute('add', { input: wrap('*** Add File: nested/file\n+old') });
  await tool.execute('move', { input: wrap('*** Update File: nested/file\n*** Move to: moved/file\n@@\n-old\n+new') });
  assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/moved/file` })).toString(), 'new\n');
  await assert.rejects(readFile(join(workspace, 'nested/file')), { code: 'ENOENT' });
  await assert.rejects(tool.execute('escape', { input: wrap('*** Add File: /tmp/escape\n+bad') }), /outside|escape|workspace/i);
  execFileSync('docker', ['exec', active.runtimeId, 'ln', '-s', '/tmp', `${active.containerWorkdir}/link`]);
  await assert.rejects(tool.execute('symlink', { input: wrap('*** Add File: link/escape\n+bad') }), /outside|escape|symlink|workspace/i);
  await active.fsBridge.writeFile({ filePath: `${active.containerWorkdir}/preserved`, data: '  keep \t\r\nold\r\ntail' });
  await tool.execute('preserve', { input: wrap('*** Update File: preserved\n@@\n keep\n-old\n+new\n tail') });
  assert.deepEqual(await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/preserved` }),
    Buffer.from('  keep \t\r\nnew\r\ntail'));
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
    await assert.rejects(restrictedTool.execute('restricted', { input: wrap(body) }), /root-scoped bridge is required/);
  }
  assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/outside/keep` })).toString(), 'unchanged');
  assert.equal(await active.fsBridge.stat({ filePath: `${active.containerWorkdir}/outside/leak` }), null);
  assert.equal(await active.fsBridge.stat({ filePath: `${active.containerWorkdir}/allowed/plain` }), null);
  await tool.execute('same-path-move', { input: wrap('*** Update File: moved/file\n*** Move to: moved/./file\n@@\n-new\n+same path retained') });
  assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/moved/file` })).toString(), 'same path retained\n');
  await tool.execute('delete', { input: wrap('*** Delete File: moved/file') });
  await assert.rejects(readFile(join(workspace, 'moved/file')), { code: 'ENOENT' });
  await active.fsBridge.writeFile({ filePath: `${active.containerWorkdir}/binary`, data: Buffer.from([0xff, 0xfe]) });
  await active.fsBridge.mkdirp({ filePath: `${active.containerWorkdir}/empty` });
  await active.fsBridge.writeFile({ filePath: `${active.containerWorkdir}/nonempty/keep`, data: 'keep', mkdir: true });
  for (const path of ['binary', 'empty', 'absent', 'missing/parents/absent', 'binary']) {
    const result = await tool.execute('delete', { input: wrap(`*** Delete File: ${path}`) });
    assert.deepEqual(result.details, { added: [], modified: [], deleted: [path] });
    execFileSync('docker', ['exec', active.runtimeId, 'test', '!', '-e', `${active.containerWorkdir}/${path}`]);
  }
  await assert.rejects(tool.execute('nonempty', { input: wrap('*** Delete File: nonempty') }), /not empty|ENOTEMPTY/);
  assert.equal((await active.fsBridge.readFile({ filePath: `${active.containerWorkdir}/nonempty/keep` })).toString(), 'keep');
  await assert.rejects(tool.execute('delete-escape', { input: wrap('*** Delete File: /tmp/absent') }), /outside|escape|workspace/i);
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
  await assert.rejects(mountedTool.execute('mounted-escape', { input: wrap('*** Add File: mounted-link/leak\n+bad') }), /additional mounts requires a root-scoped bridge/);
  assert.equal(await readFile(join(extraMount, 'keep'), 'utf8'), 'outside workspace');
  await assert.rejects(readFile(join(extraMount, 'leak')), { code: 'ENOENT' });
  for (const access of ['none', 'ro'] as const) {
    const isolatedConfig = { agents: { defaults: { ...config.agents.defaults, sandbox: { ...config.agents.defaults.sandbox, workspaceAccess: access } } } };
    const isolatedCtx = { ...ctx, config: isolatedConfig, runtimeConfig: isolatedConfig, sessionKey: `${ctx.sessionKey}:${access}` };
    const isolated = await resolveSandboxContext({ config: isolatedConfig, agentId: ctx.agentId, sessionKey: isolatedCtx.sessionKey, workspaceDir: workspace });
    assert.ok(isolated?.fsBridge);
    t.after(() => execFileSync('docker', ['rm', '-f', isolated.runtimeId], { stdio: 'pipe' }));
    const isolatedTool = createBetterPatchTool(isolatedCtx, resolve)!;
    if (access === 'ro') {
      await assert.rejects(isolatedTool.execute('readonly', { input: wrap('*** Add File: forbidden\n+bad') }), /read-only/);
    } else {
      await writeFile(join(workspace, 'same-name'), 'host must stay unchanged\n');
      await isolatedTool.execute('isolated', { input: wrap('*** Add File: same-name\n+sandbox only') });
      assert.equal(await readFile(join(workspace, 'same-name'), 'utf8'), 'host must stay unchanged\n');
      assert.equal((await isolated.fsBridge.readFile({ filePath: `${isolated.containerWorkdir}/same-name` })).toString(), 'sandbox only\n');
    }
  }
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', active.runtimeId], { encoding: 'utf8' }).trim(), 'true');
});
