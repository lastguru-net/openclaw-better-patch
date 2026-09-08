import { parse, relative, resolve } from "node:path";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import type { PatchFileSystem } from "./filesystem.js";

/** File bytes read internally, not the size of the patch request. */
export const HOST_MAX_READ_BYTES = 64 * 1024 * 1024;

export async function hostFileSystem(cwd: string, allowedRoot?: string, signal?: AbortSignal): Promise<PatchFileSystem> {
  // On Linux unrestricted sessions use "/", not the agent workspace.
  const files = await root(allowedRoot ?? parse(resolve(cwd)).root, {
    maxBytes: HOST_MAX_READ_BYTES,
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
      // Root.remove also supports empty directories; patch deletion does not.
      if ((await files.stat(rel(path))).isDirectory) throw new Error(`path is a directory: ${path}`);
      await files.remove(rel(path));
    },
  };
}
