import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostFileSystem } from "../src/host.js";
import { createBetterPatchTool } from "../src/index.js";

test("host patches a 65 MiB file", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "better-patch-large-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "large");
  const prefix = "x".repeat(65 * 1024 * 1024) + "\n";
  await writeFile(path, prefix + "old\n");
  const tool = createBetterPatchTool({ workspaceDir: cwd })!;
  await tool.execute("large", { input: "*** Begin Patch\n*** Update File: large\n@@\n-old\n+new\n*** End Patch" });
  assert.equal(await readFile(path, "utf8"), prefix + "new\n");
});

test("host adapter guards direct writes outside its root", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "better-patch-host-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const allowed = join(cwd, "allowed");
  await mkdir(allowed);
  const fs = await hostFileSystem(cwd, allowed);
  await mkdir(join(allowed, "empty"));
  await assert.rejects(fs.write(join(cwd, "outside"), "no", true), { code: "outside-workspace" });
  await assert.rejects(readFile(join(cwd, "outside")), { code: "ENOENT" });
  await assert.rejects(fs.read(join(allowed, "empty")), /file/i);
});


test("deletion accepts binary files, empty directories and missing paths but not non-empty directories", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "better-patch-delete-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "binary"), Buffer.from([0xff, 0xfe]));
  await mkdir(join(cwd, "empty"));
  await mkdir(join(cwd, "nonempty"));
  await writeFile(join(cwd, "nonempty/keep"), "keep");
  const tool = createBetterPatchTool({ workspaceDir: cwd, fsPolicy: { workspaceOnly: true } })!;
  const deletion = (path: string) => `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`;
  for (const path of ["binary", "empty", "absent", "missing/parents/absent", "binary"]) {
    const result = await tool.execute("delete", { input: deletion(path) });
    assert.deepEqual(result.details, { added: [], modified: [], deleted: [path] });
    await assert.rejects(lstat(join(cwd, path)), { code: "ENOENT" });
  }
  await assert.rejects(tool.execute("nonempty", { input: deletion("nonempty") }), /not empty|ENOTEMPTY/);
  assert.equal(await readFile(join(cwd, "nonempty/keep"), "utf8"), "keep");
  await assert.rejects(tool.execute("escape", { input: deletion("../absent") }), { code: "outside-workspace" });
});
