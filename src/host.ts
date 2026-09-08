import { parse, relative, resolve } from "node:path";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import type { PatchFileSystem } from "./filesystem.js";

export async function hostFileSystem(cwd: string, allowedRoot?: string, signal?: AbortSignal): Promise<PatchFileSystem> {
  // On Linux unrestricted sessions use "/", not the agent workspace.
  const files = await root(allowedRoot ?? parse(resolve(cwd)).root, {
    maxBytes: Infinity, // Disable the library default; no plugin-imposed file-size cap.
    symlinks: "follow-within-root",
  });
  const rel = (path: string) => relative(files.rootDir, path);
  const check = () => signal?.throwIfAborted();
  return {
    resolve,
    async checkPath(path) {
      check();
      // Advisory preflight only: retain the original spelling for actual I/O.
      await files.resolve(rel(path));
    },
    async read(path) {
      check();
      return files.readBytes(rel(path));
    },
    async write(path, contents, createParents) {
      check();
      await files.write(rel(path), contents, { mkdir: createParents });
    },
    async remove(path) {
      check();
      try { await files.remove(rel(path)); }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "not-found" && code !== "ENOENT") throw error;
      }
    },
  };
}
