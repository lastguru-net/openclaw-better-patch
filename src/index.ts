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
    description: `Create, edit, move or delete files with patches enclosed in \`*** Begin Patch\` and \`*** End Patch\`.
- \`*** Add File: path\` creates or overwrites a file; prefix content lines with \`+\`.
- \`*** Delete File: path\` deletes a file.
- \`*** Update File: path\` edits a file. To move it, put \`*** Move to: destination\` before its chunks.

Chunks use whole lines: \` \` keeps context, \`-\` removes, \`+\` adds. Match context and removed lines using:
- \`@@\` skipping any number of lines before the match.
- \`@@ anchor\` after that whole anchor line.
- \`@@^ prefix\` after a line beginning with that exact prefix.
- \`@@@ N\` exactly at original source line N (1-based).
- \`@@.\` matching the file suffix, or appending at EOF when only adding lines.

In Add File bodies or \`@@.\` update chunks, standalone \`.-\` strips all trailing newline sequences; \`.+\` ensures a final terminator without changing an already terminated tail. Controls apply after all content in that file operation; opposing controls conflict. Control-only bodies or chunks are valid.

Matching ignores line terminators. Added lines inherit source endings, with LF for empty files; empty added text follows the same rules. Ambiguous matches fail. Success means the final filesystem state has been verified, not that the patch fulfills your intent. Failures may leave partial changes.`,
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
  version: "0.2.1",
  register(api) {
    api.registerTool(ctx => createBetterPatchTool(ctx, sandboxResolver(api)), { name: "better_patch" });
  },
} satisfies OpenClawPluginDefinition;
