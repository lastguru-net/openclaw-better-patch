import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyVerifiedPatch, applyPatch, PatchError } from "../src/patch.js";
import { hostFileSystem } from "../src/host.js";
import { createBetterPatchTool } from "../src/index.js";
import { inTemp, wrap } from "./helpers.js";

const add = (path: string, text: string) => `*** Add File: ${path}\n+${text}`;
const update = (path: string, old: string, text: string) => `*** Update File: ${path}\n@@\n-${old}\n+${text}`;

test("opt-in returns exact verified readback in both model text and details", () => inTemp(async cwd => {
  await writeFile(join(cwd, "f"), "\uFEFFold\r\n😀\n\rtail");
  const tool = createBetterPatchTool({ workspaceDir: cwd })!;
  const result = await tool.execute("contents", { input: wrap(update("f", "old", "new")), returnContents: 1000 });
  const expected = "\uFEFFnew\r\n😀\n\rtail";
  const contents = { byteLimit: 1000, files: [
    { path: "f", status: "M", byteLength: Buffer.byteLength(expected), content: expected },
  ] };
  assert.deepEqual(result.details.contents, contents);
  assert.equal(result.details.verification.status, "passed");
  assert.deepEqual(JSON.parse(result.content[0].text.trimEnd().split("\n").at(-1)!), contents);
  assert.equal(await readFile(join(cwd, "f"), "utf8"), expected);
}));

for (const option of [undefined, 0]) {
  test(`returnContents=${option} leaves existing output shape unchanged`, () => inTemp(async cwd => {
    const tool = createBetterPatchTool({ workspaceDir: cwd })!;
    const result = await tool.execute("default", { input: wrap(add("f", "hello")), returnContents: option });
    assert.equal("contents" in result.details, false);
    assert.equal(result.content[0].text,
      "Success. Verified final file bytes and expected path presence/absence for all touched paths.\nA f\n");
    assert.equal(result.details.verification.status, "passed");
  }));
}

test("invalid byte budgets reject before writes through tool and engine entrypoints", () => inTemp(async cwd => {
  const tool = createBetterPatchTool({ workspaceDir: cwd })!;
  const fs = await hostFileSystem(cwd);
  for (const returnContents of [true, false, "1000", null, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const options = { returnContents } as any;
    await assert.rejects(tool.execute("invalid", { input: wrap(add("f", "hello")), ...options }), /non-negative safe integer/);
    await assert.rejects(applyVerifiedPatch(wrap(add("f", "hello")), cwd, fs, options), /non-negative safe integer/);
    await assert.rejects(readFile(join(cwd, "f")), { code: "ENOENT" });
  }
}));

test("content comes from decoded persisted bytes, not the intended string", () => inTemp(async cwd => {
  const result = await applyPatch(wrap(add("f", "\ud800")), cwd, await hostFileSystem(cwd), { returnContents: 1000 });
  const file = result.contents!.files[0];
  assert.ok("content" in file);
  assert.equal(file.content, "\uFFFD\n");
  assert.equal(file.content, await readFile(join(cwd, "f"), "utf8"));
}));

test("returning contents does not add reads and still verifies on opt-out", () => inTemp(async cwd => {
  const reads: string[][] = [];
  for (const returnContents of [0, 1000]) {
    await writeFile(join(cwd, "f"), "old\n");
    const base = await hostFileSystem(cwd);
    const calls: string[] = [];
    const result = await applyVerifiedPatch(wrap(update("f", "old", "new")), cwd, {
      ...base, async read(path) { calls.push(path); return base.read(path); },
    }, { returnContents });
    assert.equal(result.verification.status, "passed");
    reads.push(calls);
  }
  assert.ok(reads[0].length > 0);
  assert.deepEqual(reads[0], reads[1]);
}));

test("final paths include no-ops, move endpoints, recreations, deletions and directories once", () => inTemp(async cwd => {
  await writeFile(join(cwd, "a"), "one\n");
  await writeFile(join(cwd, "same"), "same\n");
  await mkdir(join(cwd, "d"));
  const result = await applyVerifiedPatch(wrap(
    "*** Update File: a\n*** Move to: b\n@@\n-one\n+two\n"
    + add("a", "recreated") + "\n" + update("./a", "recreated", "final") + "\n"
    + "*** Delete File: b\n" + update("same", "same", "same") + "\n"
    + "*** Delete File: d\n" + add("d/child", "child") + "\n*** Delete File: missing",
  ), cwd, await hostFileSystem(cwd), { returnContents: 1000 });
  assert.deepEqual(result.contents!.files, [
    { path: "a", status: "M", byteLength: 6, content: "final\n" },
    { path: "b", status: "N", omitted: "absent" },
    { path: "same", status: "N", byteLength: 5, content: "same\n" },
    { path: "d", status: "N", omitted: "directory" },
    { path: "d/child", status: "A", byteLength: 6, content: "child\n" },
    { path: "missing", status: "N", omitted: "absent" },
  ]);
}));

test("move destinations return contents and deleted binary sources are never decoded", () => inTemp(async cwd => {
  await writeFile(join(cwd, "source"), "one\n");
  await writeFile(join(cwd, "binary"), Buffer.from([0xff]));
  const result = await applyVerifiedPatch(wrap(
    "*** Update File: source\n*** Move to: destination\n@@\n one\n*** Delete File: binary",
  ), cwd, await hostFileSystem(cwd), { returnContents: 1000 });
  assert.deepEqual(result.contents!.files, [
    { path: "source", status: "D", omitted: "absent" },
    { path: "destination", status: "A", byteLength: 4, content: "one\n" },
    { path: "binary", status: "D", omitted: "absent" },
  ]);
}));

test("unchanged symlink and empty file return complete contents", () => inTemp(async cwd => {
  await writeFile(join(cwd, "target"), "same\n");
  await symlink("target", join(cwd, "link"));
  const result = await applyVerifiedPatch(wrap(update("link", "same", "same") + "\n*** Add File: empty"),
    cwd, await hostFileSystem(cwd), { returnContents: 1000 });
  assert.deepEqual(result.contents!.files, [
    { path: "link", status: "N", byteLength: 5, content: "same\n" },
    { path: "empty", status: "A", byteLength: 0, content: "" },
  ]);
}));

for (const delta of [0, 1]) {
  test(`complete content at a 100000-byte caller budget +${delta} bytes`, () => inTemp(async cwd => {
    const budget = 100000;
    const content = "x".repeat(budget + delta);
    await writeFile(join(cwd, "f"), content);
    const result = await applyVerifiedPatch(wrap(update("f", content, content)), cwd, await hostFileSystem(cwd), { returnContents: budget });
    assert.equal(result.contents!.byteLimit, budget);
    const file = result.contents!.files[0];
    if (delta === 0) {
      assert.ok("content" in file);
      assert.equal(file.content, content);
    } else {
      assert.deepEqual(file, { path: "f", status: "N", byteLength: content.length, omitted: "size-limit" });
    }
  }));
}

test("shared budget counts UTF-8 bytes, not JSON escaping, and identifies every omitted file", () => inTemp(async cwd => {
  const budget = 40008;
  const emoji = "😀".repeat(8000);
  const controls = "\u0000".repeat(8000);
  const huge = "x".repeat(budget);
  const result = await applyVerifiedPatch(wrap(
    add("first", emoji) + "\n" + add("escaped", controls) + "\n" + add("huge", huge)
    + "\n" + add("too-big", "123456") + "\n" + add("last", "small"),
  ), cwd, await hostFileSystem(cwd), { returnContents: budget });
  const files = result.contents!.files;
  assert.ok("content" in files[0]);
  assert.deepEqual(files[1], { path: "escaped", status: "A", byteLength: 8001, content: controls + "\n" });
  assert.deepEqual(files[2], { path: "huge", status: "A", byteLength: budget + 1, omitted: "size-limit" });
  assert.deepEqual(files[3], { path: "too-big", status: "A", byteLength: 7, omitted: "size-limit" });
  assert.deepEqual(files[4], { path: "last", status: "A", byteLength: 6, content: "small\n" });
  const cost = files.reduce((sum, f) => sum + ("content" in f ? Buffer.byteLength(f.content) : 0), 0);
  assert.equal(cost, budget);
}));

test("a one-byte budget skips a multibyte file, returns a fitting file and includes an empty file", () => inTemp(async cwd => {
  await writeFile(join(cwd, "unicode"), "é");
  await writeFile(join(cwd, "ascii"), "a");
  const result = await applyVerifiedPatch(wrap(
    update("unicode", "é", "é") + "\n" + update("ascii", "a", "a") + "\n*** Add File: empty",
  ), cwd, await hostFileSystem(cwd), { returnContents: 1 });
  assert.deepEqual(result.contents!.files, [
    { path: "unicode", status: "N", byteLength: 2, omitted: "size-limit" },
    { path: "ascii", status: "N", byteLength: 1, content: "a" },
    { path: "empty", status: "A", byteLength: 0, content: "" },
  ]);
}));

test("verification failure never returns cached or unverified contents", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await assert.rejects(applyVerifiedPatch(wrap(add("f", "expected")), cwd, {
    ...base, write: (path, _content, parents) => base.write(path, "corrupted", parents),
  }, { returnContents: 1000 }), error => {
    assert.ok(error instanceof PatchError);
    assert.equal(error.details.phase, "verification");
    assert.equal(error.details.verification.status, "failed");
    assert.equal("contents" in error.details, false);
    return true;
  });
}));
