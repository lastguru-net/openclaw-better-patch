import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  await tool.execute("large", { input: "*** Update File: large\n@@\n-old\n+new" });
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

test("host metadata inspects binary files, directories, in-root links and missing parents", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "better-patch-inspect-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "binary"), Buffer.from([0xff]));
  await mkdir(join(cwd, "directory"));
  await writeFile(join(cwd, "directory/child"), "child");
  await symlink("binary", join(cwd, "link"));
  await symlink("missing", join(cwd, "dangling"));
  const fs = await hostFileSystem(cwd, cwd);
  assert.deepEqual(await fs.inspect(join(cwd, "binary")), { kind: "file" });
  assert.deepEqual(await fs.inspect(join(cwd, "directory")), { kind: "directory" });
  assert.deepEqual(await fs.inspect(join(cwd, "link")), { kind: "other" });
  assert.deepEqual(await fs.inspect(join(cwd, "dangling")), { kind: "other" });
  assert.equal(await fs.inspect(join(cwd, "absent/parents/file")), null);
  assert.deepEqual(await fs.list!(join(cwd, "directory")), ["child"]);
  await assert.rejects(fs.inspect(join(cwd, "../outside")), /escape root|outside/);
  await assert.rejects(fs.list!(join(cwd, "../outside")), /escape root|outside/);
});


test("deletion accepts binary files, empty directories and missing paths but not non-empty directories", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "better-patch-delete-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "binary"), Buffer.from([0xff, 0xfe]));
  await mkdir(join(cwd, "empty"));
  await mkdir(join(cwd, "nonempty"));
  await writeFile(join(cwd, "nonempty/keep"), "keep");
  const tool = createBetterPatchTool({ workspaceDir: cwd, fsPolicy: { workspaceOnly: true } })!;
  const deletion = (path: string) => `*** Delete File: ${path}`;
  for (const path of ["binary", "empty", "absent", "missing/parents/absent", "binary"]) {
    const existed = await lstat(join(cwd, path)).then(() => true, () => false);
    const result = await tool.execute("delete", { input: deletion(path) });
    assert.deepEqual(result.details, { added: [], modified: [], deleted: existed ? [path] : [], unchanged: existed ? [] : [path],
      verification: { status: "passed", checkedPaths: 1 } });
    await assert.rejects(lstat(join(cwd, path)), { code: "ENOENT" });
  }
  await assert.rejects(tool.execute("nonempty", { input: deletion("nonempty") }), /not empty|ENOTEMPTY/);
  assert.equal(await readFile(join(cwd, "nonempty/keep"), "utf8"), "keep");
  await assert.rejects(tool.execute("escape", { input: deletion("../absent") }), { code: "outside-workspace" });
});
