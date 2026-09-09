import type { AnyAgentTool, OpenClawPluginDefinition, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolve } from "node:path";
import { applyVerifiedPatch } from "./patch.js";
import { hostFileSystem } from "./host.js";
import { sandboxFileSystem, sandboxResolver, type SandboxResolver } from "./sandbox.js";

export function createBetterPatchTool(ctx: OpenClawPluginToolContext, resolveSandbox?: SandboxResolver): AnyAgentTool | null {
  if (!ctx.workspaceDir) return null;
  const cwd = resolve(ctx.workspaceDir);
  const root = ctx.fsPolicy?.workspaceOnly ? resolve(ctx.fsPolicy.root ?? cwd) : undefined;
  let sandboxPromise: ReturnType<SandboxResolver> | undefined;
  return {
    name: "better_patch",
    label: "Better Patch",
    description: "Apply a patch to files. Update contents must be valid UTF-8. Deletion accepts binary files and empty directories; missing paths succeed, and non-empty directories are not removed. Use *** Begin Patch and *** End Patch, with *** Add File: path (lines prefixed +), *** Delete File: path, or *** Update File: path. Updates accept optional *** Move to: path, @@ or @@ context anchors, and lines prefixed space (context), - (remove), + (add). Insertion-only chunks with @@ context insert immediately after the matched anchor; without a textual anchor they append at the file ending. *** End of File anchors a chunk at EOF. Paths are relative to the agent workspace unless absolute. Context matching tolerates whitespace and common Unicode punctuation while preserving source context text. Anchors and chunk patterns must match exactly once at the first tolerance level with any matches; ambiguous matches reject before edits. Added lines inherit the preceding output line ending (original first line at the start, LF fallback). Other source endings stay unchanged except at EOF: the new last line inherits the original final ending, including no newline. Send patch text in the input field, not a shell command. Changes are not transactional; I/O failures can leave partial edits.",
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
      const fs = sandbox
        ? sandboxFileSystem(sandbox, signal, root ? ctx.fsPolicy?.root ?? sandbox.workspaceDir : undefined)
        : await hostFileSystem(cwd, root, signal);
      const workdir = sandbox?.workspaceDir ?? cwd;
      const result = await applyVerifiedPatch(params.input, workdir, fs);
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
