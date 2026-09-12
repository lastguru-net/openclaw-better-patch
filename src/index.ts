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
    description: `Create, edit, move or delete files. Supply a sequence of file operations:

- \`*** Add File: path\`: create/overwrite from \`+text\` lines.
- \`*** Delete File: path\`: delete.
- \`*** Update File: path\`: edit; optional \`*** Move to: path\` before chunks.

Update lines: \` text\` keeps, \`-text\` removes, \`+text\` adds. Whole-line matching ignores terminators; ambiguity fails.
Chunk headers:
- \`@@\`: search forward for context.
- \`@@ anchor\`: after a matching whole line.
- \`@@^ prefix\`: after a line starting with this exact prefix.
- \`@@@ N\`: exact original-source line N (1-based).
- \`@@.\`: file suffix; additions-only append at EOF.

In Add bodies or \`@@.\` chunks, choose \`.-\` to strip all trailing newline sequences or \`.+\` to ensure termination. Standalone controls apply after rendering; no content is required.

Add uses LF; updates inherit endings (LF if empty). Success includes final-state verification. Failures may leave partial changes.`,
    parameters: {
      type: "object",
      properties: { input: { type: "string", description: "File operations in patch syntax." } },
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
  version: "0.2.1",
  register(api) {
    api.registerTool(ctx => createBetterPatchTool(ctx, sandboxResolver(api)), { name: "better_patch" });
  },
} satisfies OpenClawPluginDefinition;
