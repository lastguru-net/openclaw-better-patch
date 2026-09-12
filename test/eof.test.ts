import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyVerifiedPatch, inTemp, wrap } from "./helpers.js";

async function expectUpdate(source: string, body: string, expected: string): Promise<void> {
  await inTemp(async cwd => {
    const path = join(cwd, "file");
    await writeFile(path, source);
    await applyVerifiedPatch(wrap(`*** Update File: file\n${body}`), cwd);
    assert.deepEqual(await readFile(path), Buffer.from(expected));
  });
}

for (const scenario of [
  {
    name: "inserts before only the final repeated line",
    source: "linex\nlinex\nlinex\n",
    body: "@@.\n+liney\n linex",
    expected: "linex\nlinex\nliney\nlinex\n",
  },
  {
    name: "keeps addition order around a multi-line suffix",
    source: "head\nb\nc\n",
    body: "@@.\n+before\n b\n+between\n-c\n+after",
    expected: "head\nbefore\nb\nbetween\nafter\n",
  },
  {
    name: "uses source coordinates after an earlier insertion",
    source: "a\nc\n",
    body: "@@ a\n+b\n@@.\n-c\n+C",
    expected: "a\nb\nC\n",
  },
  {
    name: "retains tolerant matching at the true suffix",
    source: "same\n  same \t\n",
    body: "@@.\n-same\n+last",
    expected: "same\nlast\n",
  },
  {
    name: "matches multi-line content across mixed terminators",
    source: "head\r\nold\ntail\r",
    body: "@@.\n old\n tail",
    expected: "head\r\nold\ntail\r",
  },
] as const) {
  test(`EOF suffix ${scenario.name}`, () => expectUpdate(scenario.source, scenario.body, scenario.expected));
}

for (const ending of ["\n", "\r", "\r\n", "\n\r"]) {
  test(`EOF suffix matches final text without its ${JSON.stringify(ending)} terminator`, () =>
    expectUpdate(`head${ending}old${ending}`, "@@.\n-old\n+new", `head${ending}new${ending}`));
}

test("EOF suffix mismatch does not search earlier or write preceding operations", () => inTemp(async cwd => {
  const path = join(cwd, "file");
  await writeFile(path, "target\nother\n");
  await assert.rejects(applyVerifiedPatch(wrap(
    "*** Add File: untouched\n+new\n*** Update File: file\n@@.\n-target\n+changed",
  ), cwd), /Failed to find expected lines/);
  assert.equal(await readFile(path, "utf8"), "target\nother\n");
  await assert.rejects(readFile(join(cwd, "untouched")), { code: "ENOENT" });
}));

test("EOF suffix treats a terminated empty line as source content", async () => {
  await expectUpdate("last\n\n", "@@.\n-", "last\n");
  await inTemp(async cwd => {
    const path = join(cwd, "file");
    await writeFile(path, "last\n");
    await assert.rejects(applyVerifiedPatch(wrap("*** Update File: file\n@@.\n-"), cwd), /Failed to find expected lines/);
    assert.equal(await readFile(path, "utf8"), "last\n");
  });
});

const appendCases = [
  ["last", ["a"], "last\na"],
  ["last", [""], "last\n"],
  ["last", ["", "a"], "last\n\na"],
  ["last", ["", ""], "last\n\n"],
  ["last\n", [""], "last\n\n"],
  ["last\n\n", ["a"], "last\n\na\n"],
  ["first\r\nlast", [""], "first\r\nlast\r\n"],
  ["last\r\n", ["a"], "last\r\na\r\n"],
  ["", ["a", ""], "a\n\n"],
  ["\uFEFF", ["a"], "\uFEFFa\n"],
  ["\r\n", ["a"], "\r\na\r\n"],
] as const;
for (const [source, additions, expected] of appendCases) {
  test(`EOF append ${JSON.stringify(additions)} to ${JSON.stringify(source)}`, () =>
    expectUpdate(source, `@@.\n${additions.map(line => `+${line}`).join("\n")}`, expected));
}

const controlCases = [
  ["strip", "hello\r\n\n\r", ".-", "hello"],
  ["strip leaves spaces and tabs", "hello\n \t\r\n", ".-", "hello\n \t"],
  ["strip preserves the BOM", "\uFEFF\r\n\n", ".-", "\uFEFF"],
  ["ensure", "hello", ".+", "hello\n"],
  ["ensure preserves a complete trailing run", "hello\r\n\r\n", ".+", "hello\r\n\r\n"],
  ["ensure uses nearest preceding ending", "first\r\nsecond\nlast", ".+", "first\r\nsecond\nlast\n"],
  ["ensure uses LF for empty output", "", ".+", "\n"],
  ["ensure uses LF after a BOM", "\uFEFF", ".+", "\uFEFF\n"],
] as const;
for (const [name, source, directive, expected] of controlCases) {
  test(`final terminator control ${name}`, () => expectUpdate(source, `@@.\n${directive}`, expected));
}

test("ensure falls back to the original first ending after whole-file replacement", () =>
  expectUpdate("first\r\nlast", "@@.\n-first\n-last\n+new\n.+", "new\r\n"));

test("ensure uses LF when content edits delete the whole file", () =>
  expectUpdate("old\r\n", "@@.\n-old\n.+", "\n"));

test("strip runs after all content chunks have rendered", () =>
  expectUpdate("a\n", "@@.\n.-\n+tail\n+", "a\ntail"));

for (const ending of ["\n", "\r", "\r\n", "\n\r"]) {
  test(`ensure inherits ${JSON.stringify(ending)}`, () =>
    expectUpdate(`head${ending}last`, "@@.\n.+", `head${ending}last${ending}`));
  test(`strip removes a trailing ${JSON.stringify(ending)} run`, () =>
    expectUpdate(`head${ending}last${ending}${ending}`, "@@.\n.-", `head${ending}last`));
}

test("directive-only EOF chunks do not advance the source cursor", () =>
  expectUpdate("a", "@@.\n.+\n@@\n-a\n+b", "b\n"));

test("repeating the same final terminator control is harmless", () =>
  expectUpdate("hello", "@@.\n.+\n.+", "hello\n"));

test("contradictory controls reject preflight before earlier operations write", () => inTemp(async cwd => {
  const path = join(cwd, "file");
  await writeFile(path, "hello");
  await assert.rejects(applyVerifiedPatch(wrap(
    "*** Add File: untouched\n+new\n*** Update File: file\n@@.\n.+\n@@.\n.-",
  ), cwd), /Invalid patch|Contradictory|Conflicting/i);
  assert.equal(await readFile(path, "utf8"), "hello");
  await assert.rejects(readFile(join(cwd, "untouched")), { code: "ENOENT" });
}));

test("separate update operations apply opposing controls in order", () => inTemp(async cwd => {
  const path = join(cwd, "file");
  await writeFile(path, "hello");
  await applyVerifiedPatch(wrap(
    "*** Update File: file\n@@.\n.+\n*** Update File: file\n@@.\n.-",
  ), cwd);
  assert.equal(await readFile(path, "utf8"), "hello");
}));

test("an Add followed by strip creates an unterminated file", () => inTemp(async cwd => {
  await applyVerifiedPatch(wrap("*** Add File: file\n+hello\n*** Update File: file\n@@.\n.-"), cwd);
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "hello");
}));

test("a move applies final terminator control to the destination", () => inTemp(async cwd => {
  await writeFile(join(cwd, "source"), "hello\n");
  await applyVerifiedPatch(wrap(
    "*** Update File: source\n*** Move to: moved\n@@.\n.-",
  ), cwd);
  assert.equal(await readFile(join(cwd, "moved"), "utf8"), "hello");
  await assert.rejects(readFile(join(cwd, "source")), { code: "ENOENT" });
}));

test("ensure on an already terminated file is reported as unchanged", () => inTemp(async cwd => {
  const path = join(cwd, "file");
  await writeFile(path, "hello\r\n\r\n");
  const result = await applyVerifiedPatch(wrap("*** Update File: file\n@@.\n.+"), cwd);
  assert.deepEqual(result.unchanged, ["file"]);
  assert.deepEqual(await readFile(path), Buffer.from("hello\r\n\r\n"));
}));
