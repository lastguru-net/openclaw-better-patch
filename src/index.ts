import type { AnyAgentTool, OpenClawPluginDefinition, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { applyVerifiedPatch } from "./patch.js";

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

export function createBetterPatchTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  // Plugin tools run on the host. Stable OpenClaw exposes no sandbox fs bridge here.
  if (ctx.sandboxed || !ctx.workspaceDir) return null;
  const cwd = resolve(ctx.workspaceDir);
  const root = ctx.fsPolicy?.workspaceOnly ? resolve(ctx.fsPolicy.root ?? cwd) : undefined;
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
      const checkPath = async (path: string) => {
        signal?.throwIfAborted();
        if (root) await assertWithinRoot(root, path);
      };
      const result = await applyVerifiedPatch(params.input, cwd, checkPath);
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
    api.registerTool(createBetterPatchTool, { name: "better_patch" });
  },
} satisfies OpenClawPluginDefinition;
