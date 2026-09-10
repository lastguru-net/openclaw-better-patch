import type { AnyAgentTool, OpenClawPluginDefinition, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolve } from "node:path";
import { applyVerifiedPatch, PatchError } from "./patch.js";
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
    description: `Patch files inside *** Begin Patch / *** End Patch. Paths use the agent workspace and filesystem policy.

File operations:
- *** Add File: path with + lines creates or overwrites.
- *** Update File: path requires an existing UTF-8 file; optional *** Move to: path may overwrite the destination.
- *** Delete File: path removes files or empty directories; missing paths succeed.

Update chunks:
Use space/-/+ for context/removal/addition. Context and removed text must contain complete source lines.
- @@ searches from the current source cursor.
- @@ context locates a whole line; @@^ prefix locates an exact literal line beginning. Both continue after a unique anchor. Prefix syntax: one ASCII-space delimiter, then a nonempty, untrimmed prefix.
- @@@ N selects exact 1-based source line N, relative to the update's initial source, unaffected by earlier chunks.
Ordinary matching requires a unique best match, tolerating whitespace and common Unicode punctuation. Numbered chunks and prefix anchors match exactly.
Insertion-only chunks insert after an anchor, before numbered line N (line count + 1 appends), or otherwise before a trailing blank line/at EOF. *** End of File constrains context matching or a numbered chunk to EOF.

Execution:
Operations run in written order with dependency-aware preflight. I/O failures may leave partial changes. Success verifies final file bytes and expected presence/absence at readback, not crash durability, future state, edit intent or application tests.`,
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
      try {
        const result = await applyVerifiedPatch(params.input, workdir, fs);
        return { content: [{ type: "text", text: result.text }],
          details: { added: result.added, modified: result.modified, deleted: result.deleted,
            unchanged: result.unchanged, verification: result.verification } };
      } catch (error) {
        if (!(error instanceof PatchError) || error.details.phase === "preparation") throw error;
        return { isError: true, content: [{ type: "text", text: error.message }], details: error.details };
      }
    },
  };
}

export default {
  id: "better-patch",
  name: "Better Patch",
  description: "Reliable file editing for OpenClaw agents, with safer matching and fewer formatting surprises",
  version: "0.1.0",
  register(api) {
    api.registerTool(ctx => createBetterPatchTool(ctx, sandboxResolver(api)), { name: "better_patch" });
  },
} satisfies OpenClawPluginDefinition;
