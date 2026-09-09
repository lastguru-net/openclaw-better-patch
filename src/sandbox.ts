import { posix, resolve } from "node:path";
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
  // The bridge confines operations to its own mounted roots. Its public API
  // cannot atomically narrow that boundary or resolve aliases within a sub-root.
  // A lexical check (or a separate stat check) cannot provide that guarantee.
  if (root && posix.normalize(root) !== posix.normalize(sandbox.containerWorkdir)) {
    throw new Error("Sandbox filesystem cannot enforce a narrower or different workspace root; a root-scoped bridge is required");
  }
  if (root) {
    const separateAgentMount = sandbox.workspaceAccess !== "none"
      && resolve(sandbox.agentWorkspaceDir) !== resolve(sandbox.workspaceDir);
    const outsideResourceMount = sandbox.readOnlyResourceMounts?.some(mount => {
      const rel = posix.relative(root, mount.containerPath);
      return rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel);
    });
    // The bridge can follow aliases into a different permitted mount. Without
    // a root-scoped capability, custom mount topologies cannot prove this policy.
    if (sandbox.docker.binds?.length || separateAgentMount || outsideResourceMount) {
      throw new Error("Sandbox workspace-only access with additional mounts requires a root-scoped bridge");
    }
  }
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
    async inspect(path) {
      signal?.throwIfAborted();
      if (root) assertSandboxRoot(root, path);
      // The provisioned workspace is a directory. Bridge stat anchors an entry
      // through its parent and cannot stat the mount root through outside '/'.
      if (posix.normalize(path) === posix.normalize(sandbox.containerWorkdir)) return { kind: "directory" };
      try {
        const stat = await bridge.stat({ filePath: path, signal });
        return stat === null ? null : { kind: stat.type };
      } catch (error) {
        // Some bridge builds reject existing nonregular entries during stat's
        // preliminary file guard. Preserve existence without assuming a type.
        if ((error as { cause?: { code?: string } }).cause?.code === "not-file") return { kind: "other" };
        // A missing parent can make stat throw rather than return null. Only
        // an explicitly absent ancestor establishes absence; retain all other errors.
        for (let probe = posix.dirname(path); ;) {
          signal?.throwIfAborted();
          const info = await bridge.stat({ filePath: probe, signal }).catch(() => undefined);
          if (info === null) return null;
          if (info !== undefined) throw error;
          const parent = posix.dirname(probe);
          if (parent === probe) throw error;
          probe = parent;
        }
      }
    },
    async write(path, contents, createParents) {
      writable();
      await bridge.writeFile({ filePath: path, data: contents, mkdir: createParents, signal });
    },
    async remove(path) {
      writable();
      try { await bridge.remove({ filePath: path, recursive: false, force: true, signal }); }
      catch (error) {
        signal?.throwIfAborted();
        // Some bridges cannot remove or stat a path with missing parents.
        // Walk upward only on stat errors; a confirmed missing ancestor is
        // sufficient, but an existing entry or no confirmation preserves error.
        for (let probe = path; ;) {
          signal?.throwIfAborted();
          const info = await bridge.stat({ filePath: probe, signal }).catch(() => undefined);
          if (info === null) return;
          if (info !== undefined) throw error;
          const parent = posix.dirname(probe);
          if (parent === probe) throw error;
          probe = parent;
        }
      }
    },
  };
}

export function assertSandboxRoot(root: string, path: string): void {
  const rel = posix.relative(root, path);
  if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${path}`);
  }
}
