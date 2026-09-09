/** Shared connector: the patch engine has no host or sandbox dependencies. */
export interface PatchFileSystem {
  resolve(cwd: string, path: string): string;
  /** Preflight boundary checks; each I/O operation must enforce its own guards too. */
  checkPath(path: string): Promise<void>;
  /** Read leaf-entry metadata without following leaf links or decoding contents; null means absent. */
  inspect(path: string): Promise<{ kind: "file" | "directory" | "other" } | null>;
  /** Direct child names where the guarded backend supports directory listing. */
  list?(path: string): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, contents: string, createParents: boolean): Promise<void>;
  /** Remove a file or empty directory; missing paths succeed. Never recursive. */
  remove(path: string): Promise<void>;
}
