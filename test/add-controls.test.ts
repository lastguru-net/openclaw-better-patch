import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyVerifiedPatch, inTemp } from "./helpers.js";

for (const [name, body, expected] of [
  ["strip", "+hello\n.-", "hello"],
  ["strip runs after all content", ".-\n+hello\n+\n.-\n+", "hello"],
  ["ensure preserves trailing empty lines", "+hello\n+\n.+", "hello\n\n"],
  ["strip preserves whitespace", "+hello\n+ \t\n+\n.-", "hello\n \t"],
  ["strip preserves a leading BOM", "+\uFEFFhello\n.-", "\uFEFFhello"],
  ["BOM-only strip", "+\uFEFF\n.-", "\uFEFF"],
  ["BOM-only ensure", "+\uFEFF\n.+", "\uFEFF\n"],
  ["control-only strip", ".-", ""],
  ["control-only ensure", ".+", "\n"],
  ["prefixed directives remain literal", "+.-\n+.+\n.-", ".-\n.+"],
] as const) {
  test(`Add File final-terminator control: ${name}`, () => inTemp(async cwd => {
    await applyVerifiedPatch(`*** Add File: file\n${body}`, cwd);
    assert.deepEqual(await readFile(join(cwd, "file")), Buffer.from(expected));
  }));
}

test("dependent updates see the Add File control's final bytes", () => inTemp(async cwd => {
  await applyVerifiedPatch(
    "*** Add File: file\n+hello\n.-\n*** Update File: file\n@@.\n+world", cwd);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "hello\nworld");
}));

test("dependent matching sees a control-only Add's ensured empty line", () => inTemp(async cwd => {
  await applyVerifiedPatch(
    "*** Add File: file\n.+\n*** Update File: file\n@@.\n-", cwd);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "");
}));

test("conflicting Add File controls reject before any operation writes", () => inTemp(async cwd => {
  await writeFile(join(cwd, "file"), "existing");
  await assert.rejects(applyVerifiedPatch(
    "*** Add File: untouched\n+new\n*** Add File: file\n.+\n+hello\n.-", cwd), /Conflicting final-terminator controls/);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "existing");
  await assert.rejects(readFile(join(cwd, "untouched")), { code: "ENOENT" });
}));

test("separate Add File controls do not conflict or leak into later operations", () => inTemp(async cwd => {
  await applyVerifiedPatch(
    "*** Add File: stripped\n+one\n.-\n*** Add File: ensured\n+two\n.+\n*** Add File: default\n+three", cwd);
  assert.equal(await readFile(join(cwd, "stripped"), "utf8"), "one");
  assert.equal(await readFile(join(cwd, "ensured"), "utf8"), "two\n");
  assert.equal(await readFile(join(cwd, "default"), "utf8"), "three\n");
}));

test("Add File compares finalized bytes for overwrites and no-ops", () => inTemp(async cwd => {
  const path = join(cwd, "file");
  await writeFile(path, "hello\n");
  const patch = "*** Add File: file\n+hello\n.-";
  const changed = await applyVerifiedPatch(patch, cwd);
  assert.deepEqual(changed.modified, ["file"]);
  assert.equal(await readFile(path, "utf8"), "hello");
  const unchanged = await applyVerifiedPatch(patch, cwd);
  assert.deepEqual(unchanged.unchanged, ["file"]);
  assert.equal(await readFile(path, "utf8"), "hello");
}));
