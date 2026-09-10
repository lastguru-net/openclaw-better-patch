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
    description: `Apply multi-file patches inside *** Begin Patch / *** End Patch.

Files: *** Add File: path (+ lines), *** Update File: path (optional *** Move to: path), *** Delete File: path. Adds/moves may overwrite.

Updates: space/-/+ means context/removal/addition; context and removals require whole source lines.
- @@: search forward with whitespace/punctuation tolerance.
- @@ context: continue after a unique whole-line anchor.
- @@^ prefix: continue after a unique exact prefix; one separator space, no trimming.
- @@@ N: exact text at 1-based source line N; insertions go before N.
*** End of File constrains matching to EOF. Ambiguous matches reject.

Paths use the workspace and filesystem policy. Ordered preflight precedes writes; failures may leave partial changes. Success verifies filesystem readback, not edit intent or application correctness.`,
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
