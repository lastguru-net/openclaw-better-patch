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
    description: "Apply file patches using *** Begin Patch / *** End Patch. Use *** Add File: path with + lines, *** Delete File: path, or *** Update File: path with optional *** Move to: path. Update chunks use @@ or @@ context and space/-/+ for context/removal/addition. Use @@@ N for exact text at a 1-based source line; insertion-only chunks insert before N (line count + 1 appends). Line numbers refer to the source at the start of each update; *** End of File anchors at EOF. Without @@@, insertion-only chunks insert after a textual anchor, otherwise before a trailing blank line or at EOF. Supply enough context for a unique match; whitespace and common Unicode punctuation differences are tolerated. Paths resolve from the agent workspace under its filesystem policy. Adds and moves may overwrite; updates require existing UTF-8 files. Deletes accept binary files and empty directories; missing paths succeed. Operations run in written order with dependency-aware preflight, but I/O failures may leave partial changes. Success always verifies final file bytes and expected path presence/absence at readback, not crash durability, future state, edit intent or application tests.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Complete patch text, including Begin/End Patch markers." },
        returnContents: { type: "boolean", default: false,
          description: "Return verified final text for all named files, including unchanged files. Content strings share a 64 KiB JSON-encoded budget in first-mentioned path order; oversized files are omitted whole. Every path has a net status and complete content or an explicit omission reason. Verification remains mandatory." },
      },
      required: ["input"],
      additionalProperties: false,
    },
    async execute(_id, params: { input: string; returnContents?: boolean }, signal) {
      if (typeof params?.input !== "string") throw new Error("better_patch requires a string input");
      if (params.returnContents !== undefined && typeof params.returnContents !== "boolean") {
        throw new Error("better_patch returnContents must be a boolean");
      }
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
        const result = await applyVerifiedPatch(params.input, workdir, fs, { returnContents: params.returnContents });
        return { content: [{ type: "text", text: result.text }],
          details: { added: result.added, modified: result.modified, deleted: result.deleted,
            unchanged: result.unchanged, verification: result.verification,
            ...(result.contents ? { contents: result.contents } : {}) } };
      } catch (error) {
        if (!(error instanceof PatchError) || error.details.phase === "preparation") throw error;
        const text = error.message + (params.returnContents ? "\nRequested final contents were not returned." : "");
        return { isError: true, content: [{ type: "text", text }], details: error.details };
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
