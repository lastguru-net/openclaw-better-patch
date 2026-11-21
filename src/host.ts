import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { lstat } from "node:fs/promises";
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
  // A child of a file is absent now, but an earlier patch operation may
  // replace that file with a directory. Still require an admitted ancestor.
  async function probe(path: string): Promise<string | null> {
    let candidate = path;
    for (;;) {
      try {
        const admitted = await files.resolve(rel(candidate));
        return candidate === path ? admitted : null;
      } catch (error) {
        const reason = error as { code?: string; cause?: { code?: string } };
        if (reason.code !== "outside-workspace" || reason.cause?.code !== "ENOTDIR" || dirname(candidate) === candidate) throw error;
        candidate = dirname(candidate);
      }
    }
  }
  return {
    resolve,
    async checkPath(path) {
      check();
      // Advisory preflight only: retain the original spelling for actual I/O.
      await probe(path);
    },
    async read(path) {
      check();
      return files.readBytes(rel(path));
    },
    async inspect(path) {
      check();
      try {
        // Resolve the parent through the guarded root, then inspect only this
        // leaf without following it. SDK typed listing stats every sibling and
        // can fail spuriously when unrelated entries disappear concurrently.
        if (resolve(path) === resolve(files.rootDir)) {
          const stat = await files.stat("");
          return { kind: stat.isFile ? "file" : stat.isDirectory ? "directory" : "other" };
        }
        const parent = await probe(dirname(path));
        if (parent === null) return null;
        const stat = await lstat(join(parent, basename(path)));
        return { kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other" };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "not-found" || code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
    async list(path) {
      check();
      return files.list(rel(path));
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
