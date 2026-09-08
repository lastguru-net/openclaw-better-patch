import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyPatch as apply, applyVerifiedPatch as verify, type PatchResult } from "../src/patch.js";

import { hostFileSystem } from "../src/host.js";

const applyPatch = async (patch: string, cwd: string) => apply(patch, cwd, await hostFileSystem(cwd));
const applyVerifiedPatch = async (patch: string, cwd: string) => verify(patch, cwd, await hostFileSystem(cwd));

const fixtures = fileURLToPath(new URL("fixtures", import.meta.url));
const rejectFixtures = new Set([
  "005_rejects_empty_patch",
  "006_rejects_missing_context",
  "008_rejects_empty_update_hunk",
  "009_requires_existing_file_for_update",
  "012_delete_directory_fails",
  "013_rejects_invalid_hunk_header",
  "015_failure_after_partial_success_leaves_changes",
]);

const fixtureResults: Record<string, Omit<PatchResult, "text">> = {
  "007_rejects_missing_file_delete": { added: [], modified: [], deleted: ["missing.txt"] },
  "001_add_file": { added: ["bar.md"], modified: [], deleted: [] },
  "002_multiple_operations": { added: ["nested/new.txt"], modified: ["modify.txt"], deleted: ["delete.txt"] },
  "003_multiple_chunks": { added: [], modified: ["multi.txt"], deleted: [] },
  "004_move_to_new_directory": { added: [], modified: ["renamed/dir/name.txt"], deleted: [] },
  "010_move_overwrites_existing_destination": { added: [], modified: ["renamed/dir/name.txt"], deleted: [] },
  "011_add_overwrites_existing_file": { added: ["duplicate.txt"], modified: [], deleted: [] },
  "014_update_file_appends_trailing_newline": { added: [], modified: ["no_newline.txt"], deleted: [] },
  "016_pure_addition_update_chunk": { added: [], modified: ["input.txt"], deleted: [] },
  "017_whitespace_padded_hunk_header": { added: [], modified: ["foo.txt"], deleted: [] },
  "018_whitespace_padded_patch_markers": { added: [], modified: ["file.txt"], deleted: [] },
  "019_unicode_simple": { added: [], modified: ["foo.txt"], deleted: [] },
  "020_delete_file_success": { added: [], modified: [], deleted: ["obsolete.txt"] },
  "020_whitespace_padded_patch_marker_lines": { added: [], modified: ["file.txt"], deleted: [] },
  "021_update_file_deletion_only": { added: [], modified: ["lines.txt"], deleted: [] },
  "022_update_file_end_of_file_marker": { added: [], modified: ["tail.txt"], deleted: [] },
};

function summary(result: Omit<PatchResult, "text">): string {
  return "Success. Updated the following files:\n" + [
    ...result.added.map((path) => `A ${path}\n`),
    ...result.modified.map((path) => `M ${path}\n`),
    ...result.deleted.map((path) => `D ${path}\n`),
  ].join("");
}

async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "better-patch-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function copyTree(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTree(from, to);
    } else {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

type TreeEntry = { kind: "directory" } | { kind: "file"; bytes: string };

async function snapshotTree(root: string): Promise<Record<string, TreeEntry>> {
  const result: Record<string, TreeEntry> = {};
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        result[name] = { kind: "directory" };
        await visit(path);
      } else {
        result[name] = { kind: "file", bytes: (await readFile(path)).toString("hex") };
      }
    }
  }
  await visit(root);
  return result;
}

const fixtureNames = (await readdir(fixtures, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(fixtureNames, [...Object.keys(fixtureResults), ...rejectFixtures].sort());

for (const name of fixtureNames) {
  test(`upstream fixture: ${name}`, async () => inTemp(async (cwd) => {
    const fixture = join(fixtures, name);
    await copyTree(join(fixture, "input"), cwd).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const patch = await readFile(join(fixture, "patch.txt"), "utf8");
    let result: PatchResult | undefined;
    let failure: unknown;
    try { result = await applyPatch(patch, cwd); }
    catch (error) { failure = error; }

    assert.deepEqual(await snapshotTree(cwd), await snapshotTree(join(fixture, "expected")));
    if (rejectFixtures.has(name)) {
      assert.ok(failure instanceof Error, "fixture should reject");
      assert.equal(result, undefined);
    } else {
      assert.ifError(failure);
      const expected = fixtureResults[name];
      assert.deepEqual(result, { ...expected, text: summary(expected) });
    }
  }));
}

const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

test("matches update context with trailing and surrounding whitespace", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "space.txt"), "tail   \n  both\t\n");
  await applyPatch(wrap("*** Update File: space.txt\n@@\n-tail\n+TAIL\n@@\n-both\n+BOTH"), cwd);
  assert.equal(await readFile(join(cwd, "space.txt"), "utf8"), "TAIL\nBOTH\n");
}));

test("normalizes Unicode punctuation while seeking an update", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "unicode.py"), "import asyncio  # local import \u2013 avoids top\u2011level dep\n");
  await applyPatch(wrap("*** Update File: unicode.py\n@@\n-import asyncio  # local import - avoids top-level dep\n+import asyncio  # HELLO"), cwd);
  assert.equal(await readFile(join(cwd, "unicode.py"), "utf8"), "import asyncio  # HELLO\n");
}));

test("an end-of-file marker selects the final repeated match", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "tail.txt"), "same\nmiddle\nsame\n");
  await applyPatch(wrap("*** Update File: tail.txt\n@@\n-same\n+last\n*** End of File"), cwd);
  assert.equal(await readFile(join(cwd, "tail.txt"), "utf8"), "same\nmiddle\nlast\n");
}));

test("updates reconstruct touched CRLF lines with LF", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "crlf.txt"), Buffer.from("one\r\ntwo\r\n"));
  await applyPatch(wrap("*** Update File: crlf.txt\n@@\n-one\n+uno"), cwd);
  assert.deepEqual(await readFile(join(cwd, "crlf.txt")), Buffer.from("uno\ntwo\r\n"));
}));

test("standalone application allows repeated source paths and reports each operation", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "same.txt"), "one\n");
  const result = await applyPatch(wrap(
    "*** Update File: same.txt\n@@\n-one\n+two\n*** Update File: same.txt\n@@\n-two\n+three",
  ), cwd);
  assert.equal(await readFile(join(cwd, "same.txt"), "utf8"), "three\n");
  assert.deepEqual(result, {
    text: "Success. Updated the following files:\nM same.txt\nM same.txt\n",
    added: [], modified: ["same.txt", "same.txt"], deleted: [],
  });
}));

test("invalid UTF-8 update targets reject without changing bytes", async () => inTemp(async (cwd) => {
  const path = join(cwd, "binary.dat");
  const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
  await writeFile(path, bytes);
  await assert.rejects(applyPatch(wrap("*** Update File: binary.dat\n@@\n-old\n+new"), cwd), /Failed to read file to update/);
  assert.deepEqual(await readFile(path), bytes);
}));

test("empty patches and missing update context reject without changes", async () => inTemp(async (cwd) => {
  const path = join(cwd, "file.txt");
  await writeFile(path, "present\n");
  await assert.rejects(applyPatch("*** Begin Patch\n*** End Patch", cwd), /No files were modified/);
  await assert.rejects(applyPatch(wrap("*** Update File: file.txt\n@@\n-missing\n+changed"), cwd), /Failed to find expected lines/);
  assert.equal(await readFile(path, "utf8"), "present\n");
}));

test("standalone failures retain earlier successfully applied hunks", async () => inTemp(async (cwd) => {
  const patch = wrap("*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new");
  await assert.rejects(applyPatch(patch, cwd), /Failed to read file to update/);
  assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "hello\n");
}));

test("accepts the standalone quoted heredoc wrapper", async () => inTemp(async (cwd) => {
  const patch = "<<'EOF'\n*** Begin Patch\n*** Add File: wrapped.txt\n+inside\n*** End Patch\nEOF\n";
  const result = await applyPatch(patch, cwd);
  assert.deepEqual(result, {
    text: "Success. Updated the following files:\nA wrapped.txt\n",
    added: ["wrapped.txt"], modified: [], deleted: [],
  });
}));

test("native verification rejects duplicate target paths before writes", async () => inTemp(async (cwd) => {
  const path = join(cwd, "same.txt");
  await writeFile(path, "one\n");
  const patch = wrap("*** Update File: same.txt\n@@\n-one\n+two\n*** Update File: same.txt\n@@\n-one\n+three");
  await assert.rejects(applyVerifiedPatch(patch, cwd), /multiple operations target/);
  assert.equal(await readFile(path, "utf8"), "one\n");
}));

test("native verification rejects a later invalid update before an earlier add", async () => inTemp(async (cwd) => {
  const patch = wrap("*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new");
  await assert.rejects(applyVerifiedPatch(patch, cwd), /Failed to read/);
  await assert.rejects(readFile(join(cwd, "created.txt")), { code: "ENOENT" });
}));

test("native verification applies valid operations and groups the A/M/D summary", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "modify.txt"), "old\n");
  await writeFile(join(cwd, "delete.txt"), "obsolete\n");
  const patch = wrap(
    "*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-old\n+new\n*** Add File: add.txt\n+created",
  );
  const result = await applyVerifiedPatch(patch, cwd);
  assert.deepEqual(result, {
    text: "Success. Updated the following files:\nA add.txt\nM modify.txt\nD delete.txt\n",
    added: ["add.txt"], modified: ["modify.txt"], deleted: ["delete.txt"],
  });
  assert.equal(await readFile(join(cwd, "modify.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(cwd, "add.txt"), "utf8"), "created\n");
  await assert.rejects(readFile(join(cwd, "delete.txt")), { code: "ENOENT" });
}));
