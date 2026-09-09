import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch as apply, applyVerifiedPatch as verify } from "../src/patch.js";
import { hostFileSystem } from "../src/host.js";

export const applyPatch = async (patch: string, cwd: string) => apply(patch, cwd, await hostFileSystem(cwd));
export const applyVerifiedPatch = async (patch: string, cwd: string) => verify(patch, cwd, await hostFileSystem(cwd));
export const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

export async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "better-patch-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
