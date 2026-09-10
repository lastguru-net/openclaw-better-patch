import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyPatch, applyVerifiedPatch, inTemp, wrap } from "./helpers.js";

test("standalone application allows repeated source paths and reports one net modification", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "same.txt"), "one\n");
  const result = await applyPatch(wrap(
    "*** Update File: same.txt\n@@\n-one\n+two\n*** Update File: same.txt\n@@\n-two\n+three",
  ), cwd);
  assert.equal(await readFile(join(cwd, "same.txt"), "utf8"), "three\n");
  assert.deepEqual(result, {
    text: "Success. Verified final file bytes and expected path presence/absence for all touched paths.\nM same.txt\n",
    added: [], modified: ["same.txt"], deleted: [], unchanged: [],
    verification: { status: "passed", checkedPaths: 1 },
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

for (const ending of ["\n", "\r\n"]) {
  test(`literal quoted wrapper preserves add contents with ${JSON.stringify(ending)} transport`, () => inTemp(async cwd => {
    const patch = `<<'EOF'\n${wrap("*** Add File: wrapped.txt\n+one\n+two")}\nEOF\n`.replaceAll("\n", ending);
    const result = await applyPatch(patch, cwd);
    assert.deepEqual(result.added, ["wrapped.txt"]);
    assert.equal(await readFile(join(cwd, "wrapped.txt"), "utf8"), "one\ntwo\n");
  }));
}

test("preflight checks repeated updates against preceding output", async () => inTemp(async (cwd) => {
  const path = join(cwd, "same.txt");
  await writeFile(path, "one\n");
  const patch = wrap("*** Update File: same.txt\n@@\n-one\n+two\n*** Update File: same.txt\n@@\n-one\n+three");
  await assert.rejects(applyVerifiedPatch(patch, cwd), /Failed to find expected lines/);
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
    text: "Success. Verified final file bytes and expected path presence/absence for all touched paths.\nA add.txt\nM modify.txt\nD delete.txt\n",
    added: ["add.txt"], modified: ["modify.txt"], deleted: ["delete.txt"], unchanged: [],
    verification: { status: "passed", checkedPaths: 3 },
  });
  assert.equal(await readFile(join(cwd, "modify.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(cwd, "add.txt"), "utf8"), "created\n");
  await assert.rejects(readFile(join(cwd, "delete.txt")), { code: "ENOENT" });
}));


const moveA = "*** Update File: a\n*** Move to: ./b\n@@\n-A\n+M";
test("stale context after a move rejects before any writes", () => inTemp(async dir => {
  await writeFile(join(dir, "a"), "A\n");
  await writeFile(join(dir, "b"), "B\n");
  await assert.rejects(applyVerifiedPatch(wrap(`*** Add File: untouched\n+x\n${moveA}\n*** Update File: b\n@@\n-B\n+C`), dir), /Failed to find expected lines/);
  assert.equal(await readFile(join(dir, "a"), "utf8"), "A\n");
  assert.equal(await readFile(join(dir, "b"), "utf8"), "B\n");
  await assert.rejects(readFile(join(dir, "untouched")), { code: "ENOENT" });
}));

for (const destination of ["f", "./f", "sub/../f"]) {
  test(`same resolved move destination ${destination} retains the updated file`, () => inTemp(async dir => {
    await writeFile(join(dir, "f"), "old\n");
    await applyVerifiedPatch(wrap(`*** Update File: f\n*** Move to: ${destination}\n@@\n-old\n+new`), dir);
    assert.equal(await readFile(join(dir, "f"), "utf8"), "new\n");
  }));
}

