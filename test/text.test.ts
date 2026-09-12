import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyPatch, applyVerifiedPatch, inTemp } from "./helpers.js";

test("replacement lines inherit the original first line ending", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "crlf.txt"), Buffer.from("one\r\ntwo\r\n"));
  await applyPatch("*** Update File: crlf.txt\n@@\n-one\n+uno", cwd);
  assert.deepEqual(await readFile(join(cwd, "crlf.txt")), Buffer.from("uno\r\ntwo\r\n"));
}));

const preservationCases = [
  { name: "multiple added lines inherit previous replacement ending", source: "first\r\nold\nlast\r\n",
    body: " first\n-old\n+one\n+two\n last", expected: "first\r\none\r\ntwo\r\nlast\r\n" },
  { name: "first-line insertion uses original first ending", source: "first\r\nlast\n",
    body: "+one\n+two\n first", expected: "one\r\ntwo\r\nfirst\r\nlast\n" },
  { name: "whole-file replacement uses first ending then original EOF ending", source: "first\r\nlast\n",
    body: "-first\n-last\n+one\n+two\n+three", expected: "one\r\ntwo\r\nthree\n" },
  { name: "single-line replacement uses original EOF ending", source: "first\r\nlast\n",
    body: "-first\n-last\n+one", expected: "one\n" },
  { name: "append to unterminated CRLF source uses preceding source ending", source: "first\r\nlast",
    body: " last\n+one\n+two", expected: "first\r\nlast\r\none\r\ntwo" },
  { name: "pure insertion at unterminated CRLF EOF", source: "first\r\nlast",
    body: "+one\n+two", expected: "first\r\nlast\r\none\r\ntwo" },
  { name: "mixed EOF append uses nearest preceding ending", source: "first\r\nsecond\nlast",
    body: " last\n+one\n+two", expected: "first\r\nsecond\nlast\none\ntwo" },
  { name: "delete last line transfers CRLF EOF ending to context", source: "keep\nold\r\n",
    body: " keep\n-old", expected: "keep\r\n" },
  { name: "delete last line transfers LF EOF ending to untouched line", source: "keep\r\nold\n",
    body: "-old", expected: "keep\n" },
  { name: "single unterminated line expansion defaults to LF", source: "old",
    body: "-old\n+one\n+two", expected: "one\ntwo" },
  { name: "delete all terminated lines produces empty file", source: "old\r\n",
    body: "-old", expected: "" },

  { name: "exact mixed-ending context and trailing blank lines", source: "before\r\nold\nlast\r\n\r\n",
    body: " before\n-old\n+new\n last", expected: "before\r\nnew\r\nlast\r\n\r\n" },
  { name: "trailing-whitespace context", source: "keep \t\r\nold\n",
    body: " keep\n-old\n+new", expected: "keep \t\r\nnew\n" },
  { name: "surrounding-whitespace context and interleaved edits", source: "  keep\t\r\nold\n  tail \n",
    body: "+first\n keep\n-old\n+new\n tail\n+last", expected: "first\r\n  keep\t\r\nnew\r\n  tail \nlast\n" },
  { name: "Unicode-tolerant context", source: "\ufeffheading\r\n\u201chello\u201d\u00a0\u2013\u00a0world\r\nold\n",
    body: ' "hello" - world\n-old\n+new', expected: "\ufeffheading\r\n\u201chello\u201d\u00a0\u2013\u00a0world\r\nnew\n" },
  { name: "unterminated replacement", source: "old", body: "-old\n+new", expected: "new" },
  { name: "unterminated context-only update", source: "  keep \t", body: " keep", expected: "  keep \t" },
  { name: "unterminated tail context", source: "old\r\n  tail \t", body: "-old\n+new\n tail", expected: "new\r\n  tail \t" },
  { name: "append after unterminated context", source: "keep", body: " keep\n+new", expected: "keep\nnew" },
  { name: "insertion-only append without EOF newline", source: "keep", body: "+new", expected: "keep\nnew" },
  { name: "empty source insertion", source: "", body: "+new", expected: "new\n" },
  { name: "empty additions follow unterminated source ending inheritance", source: "old", body: "-old\n+new\n+\n+", expected: "new\n\n" },
  { name: "delete entire unterminated file", source: "old", body: "-old", expected: "" },
  { name: "delete last line transfers absent EOF ending to context", source: "keep\r\nold", body: " keep\n-old", expected: "keep" },
  { name: "omitted empty context before addition", source: "old", body: "-old\n \n+new", expected: "new" },
  { name: "multiple chunks preserve separate source context", source: "  a\r\nold\n  b\r\nlast",
    body: " a\n-old\n+new\n@@\n b\n-last\n+end", expected: "  a\r\nnew\r\n  b\r\nend" },
];
for (const scenario of preservationCases) {
  test(`preserves source: ${scenario.name}`, async () => inTemp(async (cwd) => {
    const path = join(cwd, "source.txt");
    await writeFile(path, scenario.source);
    await applyVerifiedPatch(`*** Update File: source.txt\n@@\n${scenario.body}`, cwd);
    assert.deepEqual(await readFile(path), Buffer.from(scenario.expected));
  }));
}

test("moves preserve source context and absent final newline", async () => inTemp(async (cwd) => {
  await writeFile(join(cwd, "source.txt"), "  keep\r\nold");
  await applyVerifiedPatch("*** Update File: source.txt\n*** Move to: moved.txt\n@@\n keep\n-old\n+new", cwd);
  assert.deepEqual(await readFile(join(cwd, "moved.txt")), Buffer.from("  keep\r\nnew"));
  await assert.rejects(readFile(join(cwd, "source.txt")), { code: "ENOENT" });
}));


const logicalEndings = ["\n", "\r", "\r\n", "\n\r"];
for (const ending of logicalEndings) {
  test(`logical matching and output inheritance for ${JSON.stringify(ending)}`, () => inTemp(async dir => {
    await writeFile(join(dir, "f"), `head${ending}old${ending}tail${ending}`);
    await applyVerifiedPatch("*** Update File: f\n@@ head\n-old\n+new\n tail", dir);
    assert.equal(await readFile(join(dir, "f"), "utf8"), `head${ending}new${ending}tail${ending}`);
  }));
  test(`patch transport accepts ${JSON.stringify(ending)}`, () => inTemp(async dir => {
    await writeFile(join(dir, "f"), "old\n");
    await applyVerifiedPatch("*** Update File: f\n@@\n-old\n+new".replaceAll("\n", ending), dir);
    assert.equal(await readFile(join(dir, "f"), "utf8"), "new\n");
  }));
  test(`explicit blank tail inherits ${JSON.stringify(ending)}`, () => inTemp(async dir => {
    await writeFile(join(dir, "f"), `head${ending}old`);
    await applyVerifiedPatch("*** Update File: f\n@@\n-old\n+new\n+\n+", dir);
    assert.equal(await readFile(join(dir, "f"), "utf8"), `head${ending}new${ending}${ending}`);
  }));
}

for (const body of ["@@\n-target\n+new", "@@ target\n+new"]) {
  test(`mixed endings do not hide ambiguity: ${JSON.stringify(body)}`, () => inTemp(async dir => {
    const original = logicalEndings.map(ending => `target${ending}`).join("");
    await writeFile(join(dir, "f"), original);
    await assert.rejects(applyVerifiedPatch(`*** Update File: f\n${body}`, dir), /4 matches at exact tolerance/);
    assert.equal(await readFile(join(dir, "f"), "utf8"), original);
  }));
}

for (const [name, original, body, expected] of [
  ["replace first", "\uFEFFold\r", "@@\n-old\n+new", "\uFEFFnew\r"],
  ["insert before first", "\uFEFFfirst\n", "@@\n+before\n first", "\uFEFFbefore\nfirst\n"],
  ["delete first", "\uFEFFfirst\nsecond", "@@\n-first\n second", "\uFEFFsecond"],
  ["delete all text", "\uFEFFold", "@@\n-old", "\uFEFF"],
  ["insert into BOM only", "\uFEFF", "@@\n+new", "\uFEFFnew\n"],
  ["BOM with explicit blank", "\uFEFF", "@@\n+", "\uFEFF\n"],
  ["interior BOM is content", "\uFEFFfirst\n\uFEFFinside", "@@ first\n-\uFEFFinside\n+new", "\uFEFFfirst\nnew"],
  ["empty file blank", "", "@@\n+", "\n"],
  ["missing empty context preserves additions", "old", "@@\n-old\n \n+new\n+", "new\n"],
] as const) {
  test(`file metadata and explicit lines: ${name}`, () => inTemp(async dir => {
    await writeFile(join(dir, "f"), original);
    await applyVerifiedPatch(`*** Update File: f\n${body}`, dir);
    assert.equal(await readFile(join(dir, "f"), "utf8"), expected);
  }));
}

test("moves preserve BOM and empty-addition ending inheritance", () => inTemp(async dir => {
  await writeFile(join(dir, "f"), "\uFEFFold");
  await applyVerifiedPatch("*** Update File: f\n*** Move to: moved\n@@\n-old\n+new\n+", dir);
  assert.equal(await readFile(join(dir, "moved"), "utf8"), "\uFEFFnew\n");
}));

for (const [source, expected] of [["", "first\nsecond\n"], ["a\n\n", "a\nfirst\nsecond\n\n"]]) {
  test(`same-position insertions retain patch order in ${JSON.stringify(source)}`, () => inTemp(async dir => {
    await writeFile(join(dir, "f"), source);
    await applyVerifiedPatch("*** Update File: f\n@@\n+first\n@@\n+second", dir);
    assert.equal(await readFile(join(dir, "f"), "utf8"), expected);
  }));
}
