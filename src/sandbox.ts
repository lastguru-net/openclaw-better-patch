import { posix } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { resolveSandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PatchFileSystem } from "./filesystem.js";

type Sandbox = NonNullable<Awaited<ReturnType<typeof resolveSandboxContext>>>;
export type SandboxResolver = (ctx: OpenClawPluginToolContext) => Promise<Sandbox | null>;

/** Resolve through the host SDK, never by guessing container names or mapping host paths. */
export function sandboxResolver(api: OpenClawPluginApi): SandboxResolver {
  return async ctx => {
    if (!ctx.sessionKey || !ctx.workspaceDir) throw new Error("Sandbox patching requires a session and workspace");
    const config = ctx.runtimeConfig ?? ctx.config;
    if (!config) throw new Error("Sandbox patching requires the session configuration");
    // Remote worker placements carry a runtime-owned bridge that this resolver cannot reconstruct.
    if (await api.runtime.gateway.isAvailable()) {
      const { session } = await api.runtime.gateway.request<{ session: { sessionId?: string; placement?: { state: string } } | null }>(
        "sessions.describe", { key: ctx.sessionKey },
      );
      if (!session || (ctx.sessionId && session.sessionId !== ctx.sessionId)) throw new Error("Sandbox session identity changed or is unavailable");
      if (session.placement && session.placement.state !== "local") {
        throw new Error("Worker placement requires its active filesystem bridge; OpenClaw does not expose it to plugin tools");
      }
    }
    const entry = api.runtime.agent.session.getSessionEntry({
      agentId: ctx.agentId, sessionKey: ctx.sessionKey, readConsistency: "latest", hydrateSkillPromptRefs: true,
    });
    const { resolveSandboxContext } = await import("openclaw/plugin-sdk/agent-harness-runtime");
    return resolveSandboxContext({
      config, agentId: ctx.agentId, sessionKey: ctx.sessionKey, workspaceDir: ctx.workspaceDir,
      skillsSnapshot: entry?.skillsSnapshot, requireCurrentConfig: true,
    });
  };
}

export function sandboxFileSystem(sandbox: Sandbox, signal?: AbortSignal, allowedRoot?: string): PatchFileSystem {
  const bridge = sandbox.fsBridge;
  if (!bridge) throw new Error("Sandbox filesystem bridge is unavailable");
  const root = allowedRoot === undefined ? undefined
    : bridge.resolvePath({ filePath: allowedRoot, cwd: sandbox.workspaceDir }).containerPath;
  const writable = () => {
    signal?.throwIfAborted();
    if (sandbox.workspaceAccess === "ro") throw new Error("Sandbox workspace is read-only");
  };
  return {
    resolve: (cwd, path) => bridge.resolvePath({ filePath: path, cwd }).containerPath,
    async checkPath(path) {
      signal?.throwIfAborted();
      if (root) assertSandboxRoot(root, path);
    },
    read: path => bridge.readFile({ filePath: path, signal }),
    async write(path, contents, createParents) {
      writable();
      await bridge.writeFile({ filePath: path, data: contents, mkdir: createParents, signal });
    },
    async remove(path) {
      writable();
      const info = await bridge.stat({ filePath: path, signal });
      if (info?.type === "directory") throw new Error(`path is a directory: ${path}`);
      await bridge.remove({ filePath: path, recursive: false, force: false, signal });
    },
  };
}

export function assertSandboxRoot(root: string, path: string): void {
  const rel = posix.relative(root, path);
  if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${path}`);
  }
}
