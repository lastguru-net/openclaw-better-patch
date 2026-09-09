import { dirname, basename } from 'node:path';
import type { PatchFileSystem } from './filesystem.js';

type Entry = { kind: 'file' | 'directory' | 'other'; data?: Uint8Array; fresh?: boolean };

/** An ordered overlay. Only reads reach the adapter; simulated mutations stay here. */
export function preflightFileSystem(base: PatchFileSystem): PatchFileSystem {
  const entries = new Map<string, Entry | null>();
  const parent = (path: string) => dirname(path);
  async function inspect(path: string): Promise<Entry | null> {
    if (entries.has(path)) return entries.get(path)!;
    for (let ancestor = parent(path); ; ancestor = parent(ancestor)) {
      if (entries.has(ancestor)) {
        const entry = entries.get(ancestor);
        if (!entry || entry.kind === 'file' || entry.fresh) return null;
      }
      if (parent(ancestor) === ancestor) break;
    }
    const entry = await base.inspect(path);
    entries.set(path, entry && { ...entry });
    return entries.get(path)!;
  }
  async function directory(path: string, create: boolean): Promise<void> {
    const entry = await inspect(path);
    if (entry?.kind === 'directory' || entry?.kind === 'other') return;
    if (entry) throw new Error(`Parent is not a directory: ${path}`);
    if (!create || parent(path) === path) throw new Error(`Missing parent directory: ${path}`);
    await base.checkPath(path);
    await directory(parent(path), true);
    entries.set(path, { kind: 'directory', fresh: true });
  }
  async function list(path: string): Promise<string[]> {
    const entry = await inspect(path);
    const children = new Set(entry?.fresh ? [] : await base.list!(path));
    for (const [child, value] of entries) {
      if (child !== path && parent(child) === path) {
        const name = basename(child);
        if (value) children.add(name); else children.delete(name);
      }
    }
    return [...children];
  }
  return {
    resolve: (cwd, path) => base.resolve(cwd, path),
    checkPath: path => base.checkPath(path),
    inspect,
    ...(base.list ? { list } : {}),
    async read(path) {
      const entry = await inspect(path);
      if (!entry) throw new Error(`File does not exist: ${path}`);
      return entry.data ??= await base.read(path);
    },
    async write(path, contents, createParents) {
      await base.checkPath(path);
      await directory(parent(path), createParents);
      if ((await inspect(path))?.kind === 'directory') throw new Error(`Cannot write a directory: ${path}`);
      entries.set(path, { kind: 'file', data: new TextEncoder().encode(contents) });
    },
    async remove(path) {
      const entry = await inspect(path);
      if (entry?.kind === 'directory') {
        // Without SDK listing, actual nonrecursive removal remains authoritative.
        if (entry.fresh || base.list) {
          if ((await list(path)).length) throw new Error(`Directory is not empty: ${path}`);
        } else {
          for (const [child, value] of entries) {
            if (child !== path && parent(child) === path && value) throw new Error(`Directory is not empty: ${path}`);
          }
        }
      }
      entries.set(path, null);
    },
  };
}
