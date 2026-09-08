import type { AnyAgentTool, OpenClawPluginDefinition, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { applyVerifiedPatch, hostFileSystem } from "./patch.js";
import { assertSandboxRoot, sandboxFileSystem, sandboxResolver, type SandboxResolver } from "./sandbox.js";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

/** Check existing ancestors as well as spelling, including not-yet-created targets. */
async function assertWithinRoot(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error(`Path is outside the workspace: ${path}`);
  const canonicalRoot = await realpath(root);
  let ancestor = path;
  for (;;) {
    try {
      // lstat distinguishes a missing path from a dangling symlink (which must fail closed).
      await lstat(ancestor);
      if (!inside(canonicalRoot, await realpath(ancestor))) throw new Error(`Path resolves outside the workspace: ${path}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a safely missing directory.
      try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Unresolvable symlink: ${ancestor}`); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== "ENOENT") throw check; }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export function createBetterPatchTool(ctx: OpenClawPluginToolContext, resolveSandbox?: SandboxResolver): AnyAgentTool | null {
  if (!ctx.workspaceDir) return null;
  const cwd = resolve(ctx.workspaceDir);
  const root = ctx.fsPolicy?.workspaceOnly ? resolve(ctx.fsPolicy.root ?? cwd) : undefined;
  let sandboxPromise: ReturnType<SandboxResolver> | undefined;
  return {
    name: "better_patch",
    label: "Better Patch",
    description: "Apply a patch to UTF-8 files. Use *** Begin Patch and *** End Patch, with *** Add File: path (lines prefixed +), *** Delete File: path, or *** Update File: path. Updates accept optional *** Move to: path, @@ or @@ context anchors, and lines prefixed space (context), - (remove), + (add). *** End of File anchors a chunk at EOF. Paths are relative to the agent workspace unless absolute. Context matching tolerates whitespace and common Unicode punctuation. Send patch text in the input field, not a shell command. Changes are not transactional; I/O failures can leave partial edits.",
    parameters: {
      type: "object",
      properties: { input: { type: "string", description: "Complete patch text, including Begin/End Patch markers." } },
      required: ["input"],
      additionalProperties: false,
    },
    async execute(_id, params: { input: string }, signal) {
      if (typeof params?.input !== "string") throw new Error("better_patch requires a string input");
      signal?.throwIfAborted();
      const sandbox = ctx.sandboxed && resolveSandbox
        ? await (sandboxPromise ??= resolveSandbox(ctx).catch(error => { sandboxPromise = undefined; throw error; }))
        : undefined;
      if (ctx.sandboxed && !sandbox?.fsBridge) throw new Error("The session sandbox filesystem is unavailable; host fallback is forbidden");
      if (sandbox?.workspaceAccess === "ro") throw new Error("Sandbox workspace is read-only");
      const fs = sandbox ? sandboxFileSystem(sandbox, signal) : hostFileSystem;
      const workdir = sandbox?.workspaceDir ?? cwd;
      const sandboxRoot = sandbox && root ? fs.resolve(workdir, ctx.fsPolicy?.root ?? sandbox.workspaceDir) : undefined;
      const checkPath = async (path: string) => {
        signal?.throwIfAborted();
        if (sandboxRoot) assertSandboxRoot(sandboxRoot, path);
        else if (!sandbox && root) await assertWithinRoot(root, path);
      };
      const result = await applyVerifiedPatch(params.input, workdir, checkPath, fs);
      return { content: [{ type: "text", text: result.text }],
        details: { added: result.added, modified: result.modified, deleted: result.deleted } };
    },
  };
}

export default {
  id: "better-patch",
  name: "Better Patch",
  description: "Codex-style patch editing without a Codex dependency",
  version: "0.1.0",
  register(api) {
    api.registerTool(ctx => createBetterPatchTool(ctx, sandboxResolver(api)), { name: "better_patch" });
  },
} satisfies OpenClawPluginDefinition;
