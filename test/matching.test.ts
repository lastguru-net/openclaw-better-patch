import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyPatch, applyVerifiedPatch, inTemp, wrap } from "./helpers.js";

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

for (const scenario of [
  { name: "exact", source: "same\nsame\n", pattern: "same" },
  { name: "trailing whitespace", source: "same \nsame\t\n", pattern: "same" },
  { name: "surrounding whitespace", source: " same\n\tsame\n", pattern: "same" },
  { name: "Unicode punctuation", source: "a\u2013b\na\u2014b\n", pattern: "a-b" },
]) {
  test(`rejects ambiguous ${scenario.name} matches before any writes`, async () => inTemp(async cwd => {
    const path = join(cwd, "source.txt");
    await writeFile(path, scenario.source);
    await assert.rejects(applyVerifiedPatch(wrap(
      `*** Add File: new.txt\n+new\n*** Update File: source.txt\n@@\n-${scenario.pattern}\n+changed`,
    ), cwd), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`Ambiguous match in ${path}: 2 matches at ${scenario.name} tolerance`));
      return true;
    });
    assert.equal(await readFile(path, "utf8"), scenario.source);
    await assert.rejects(readFile(join(cwd, "new.txt")), { code: "ENOENT" });
  }));
}

for (const scenario of [
  { name: "unique exact match wins over multiple fuzzy matches", source: "same \nsame\nsame\t\n",
    body: "@@\n-same\n+changed", expected: "same \nchanged\nsame\t\n" },
  { name: "unique trailing-whitespace match wins over weaker matches", source: " same\nsame \n\tsame\n",
    body: "@@\n-same\n+changed", expected: " same\nchanged\n\tsame\n" },
  { name: "full chunk context disambiguates repeated removed lines", source: "first\nsame\nsecond\nsame\n",
    body: "@@\n second\n-same\n+changed", expected: "first\nsame\nsecond\nchanged\n" },
  { name: "unique anchor narrows the search region", source: "same\nanchor\nsame\n",
    body: "@@ anchor\n-same\n+changed", expected: "same\nanchor\nchanged\n" },
  { name: "previous chunk advances the matching cursor", source: "first\nsame\nsecond\nsame\n",
    body: "@@\n-first\n+FIRST\n same\n@@\n-same\n+changed", expected: "FIRST\nsame\nsecond\nchanged\n" },
]) {
  test(`matching: ${scenario.name}`, async () => inTemp(async cwd => {
    await writeFile(join(cwd, "source.txt"), scenario.source);
    await applyVerifiedPatch(wrap(`*** Update File: source.txt\n${scenario.body}`), cwd);
    assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), scenario.expected);
  }));
}

for (const scenario of [
  { name: "ambiguous anchor", source: "anchor\none\nanchor\ntwo\n", body: "@@ anchor\n-two\n+changed" },
  { name: "overlapping matches", source: "same\nsame\nsame\n", body: "@@\n same\n-same\n+changed" },
  { name: "trimmed empty-context fallback", source: "same\nsame\n", body: "@@\n-same\n+changed\n " },
]) {
  test(`rejects ${scenario.name}`, async () => inTemp(async cwd => {
    const path = join(cwd, "source.txt");
    await writeFile(path, scenario.source);
    await assert.rejects(applyVerifiedPatch(wrap(`*** Update File: source.txt\n${scenario.body}`), cwd), /Ambiguous match/);
    assert.equal(await readFile(path, "utf8"), scenario.source);
  }));
}


for (const scenario of [
  { name: "middle anchor with tolerant matching and CRLF inheritance", source: "before\n  anchor \t\r\nafter",
    body: "@@ anchor\n+one\n+two", expected: "before\n  anchor \t\r\none\r\ntwo\r\nafter" },
  { name: "first-line anchor", source: "anchor\nlast\n",
    body: "@@ anchor\n+inserted", expected: "anchor\ninserted\nlast\n" },
  { name: "unterminated last-line anchor", source: "first\r\nanchor",
    body: "@@ anchor\n+inserted", expected: "first\r\nanchor\r\ninserted" },
  { name: "multiple anchors keep source positions", source: "first\nsecond\nlast\n",
    body: "@@ first\n+one\n@@ second\n+two", expected: "first\none\nsecond\ntwo\nlast\n" },
  { name: "following update at the insertion cursor", source: "anchor\nold\nlast\n",
    body: "@@ anchor\n+inserted\n@@\n-old\n+new", expected: "anchor\ninserted\nnew\nlast\n" },
]) {
  test(`insertion-only chunk respects ${scenario.name}`, async () => inTemp(async cwd => {
    const path = join(cwd, "source.txt");
    await writeFile(path, scenario.source);
    await applyVerifiedPatch(wrap(`*** Update File: source.txt\n${scenario.body}`), cwd);
    assert.equal(await readFile(path, "utf8"), scenario.expected);
  }));
}

for (const scenario of [
  { name: "missing", source: "other\n", error: /Failed to find anchor/ },
  { name: "ambiguous", source: "anchor\nanchor\n", error: /Ambiguous match/ },
]) {
  test(`insertion-only chunk rejects a ${scenario.name} anchor before writes`, async () => inTemp(async cwd => {
    const path = join(cwd, "source.txt");
    await writeFile(path, scenario.source);
    await assert.rejects(applyVerifiedPatch(wrap(
      "*** Add File: new.txt\n+new\n*** Update File: source.txt\n@@ anchor\n+inserted",
    ), cwd), scenario.error);
    assert.equal(await readFile(path, "utf8"), scenario.source);
    await assert.rejects(readFile(join(cwd, "new.txt")), { code: "ENOENT" });
  }));
}

test("EOF chunks cannot reuse source consumed by an earlier chunk", () => inTemp(async dir => {
  await writeFile(join(dir, "f"), "a\nb\nc\n");
  await assert.rejects(applyVerifiedPatch(wrap("*** Add File: untouched\n+x\n*** Update File: f\n@@\n-b\n+B\n c\n@@\n-c\n+C\n*** End of File"), dir), /Failed to find expected lines/);
  assert.equal(await readFile(join(dir, "f"), "utf8"), "a\nb\nc\n");
  await assert.rejects(readFile(join(dir, "untouched")), { code: "ENOENT" });
}));

test("an unanchored insertion cannot intersect a consumed trailing blank", () => inTemp(async dir => {
  await writeFile(join(dir, "f"), "a\n\n");
  await assert.rejects(applyVerifiedPatch(wrap("*** Update File: f\n@@\n-a\n+A\n \n@@\n+tail"), dir), /Overlapping chunks/);
  assert.equal(await readFile(join(dir, "f"), "utf8"), "a\n\n");
}));

for (const ending of ["\n", "\r\n"]) {
  test(`unanchored addition precedes a trailing blank with ${JSON.stringify(ending)}`, () => inTemp(async dir => {
    await writeFile(join(dir, "f"), `a${ending}${ending}`);
    await applyVerifiedPatch(wrap("*** Update File: f\n@@\n+new"), dir);
    assert.equal(await readFile(join(dir, "f"), "utf8"), `a${ending}new${ending}${ending}`);
  }));
}

