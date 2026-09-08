/** Shared connector: the patch engine has no host or sandbox dependencies. */
export interface PatchFileSystem {
  resolve(cwd: string, path: string): string;
  /** Preflight boundary checks; each I/O operation must enforce its own guards too. */
  checkPath(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, contents: string, createParents: boolean): Promise<void>;
  remove(path: string): Promise<void>;
}
