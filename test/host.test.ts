import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostFileSystem } from "../src/host.js";
import { createBetterPatchTool } from "../src/index.js";

test("host patches files above 16 MiB but rejects reads above 64 MiB before editing", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "better-patch-large-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "large");
  const prefix = "x".repeat(17 * 1024 * 1024) + "\n";
  await writeFile(path, prefix + "old\n");
  const tool = createBetterPatchTool({ workspaceDir: cwd })!;
  await tool.execute("large", { input: "*** Begin Patch\n*** Update File: large\n@@\n-old\n+new\n*** End Patch" });
  assert.equal(await readFile(path, "utf8"), prefix + "new\n");
  await truncate(path, 64 * 1024 * 1024 + 1);
  await assert.rejects(tool.execute("oversize", { input: "*** Begin Patch\n*** Add File: untouched\n+no\n*** Delete File: large\n*** End Patch" }), /too large|exceeds|too-large/i);
  await assert.rejects(readFile(join(cwd, "untouched")), { code: "ENOENT" });
});

test("host adapter preserves file-only deletion and guards direct writes outside its root", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "better-patch-host-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const allowed = join(cwd, "allowed");
  await mkdir(allowed);
  const fs = await hostFileSystem(cwd, allowed);
  await mkdir(join(allowed, "empty"));
  await assert.rejects(fs.remove(join(allowed, "empty")), /directory/);
  await assert.rejects(fs.write(join(cwd, "outside"), "no", true), { code: "outside-workspace" });
  await assert.rejects(readFile(join(cwd, "outside")), { code: "ENOENT" });
  await assert.rejects(fs.read(join(allowed, "empty")), /file/i);
});
