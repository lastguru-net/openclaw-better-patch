import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePatch } from "../src/parser.js";
import { applyVerifiedPatch, inTemp, wrap } from "./helpers.js";

for (const prefix of ["paragraph", " paragraph ", "\tparagraph\t", " ", ".*[literal]"]) {
  test("prefix parser preserves " + JSON.stringify(prefix), () => {
    const [edit] = parsePatch(wrap("*** Update File: file\n@@^ " + prefix + "\n+x"));
    assert.equal(edit.kind, "update");
    if (edit.kind === "update") assert.deepEqual(edit.blocks, [
      { prefix, atEnd: false, lines: [{ kind: "insert", text: "x" }] },
    ]);
  });
}
for (const marker of ["@@^", "@@^ ", "@@^text", "@@^\ttext"]) {
  test("reject malformed prefix marker " + JSON.stringify(marker), () => {
    for (const before of ["", "@@\n+first\n"]) {
      assert.throws(() => parsePatch(wrap("*** Update File: file\n" + before + marker + "\n+x")),
        /one space and a nonempty literal prefix/);
    }
  });
}

const long = "My recommendation is " + "a long paragraph. ".repeat(10000);
const cases = [
  ["long paragraph", long + "\nafter\n", "@@^ My recommendation is\n+note", long + "\nnote\nafter\n"],
  ["literal metacharacters", ".*[literal] suffix\nlast\n", "@@^ .*[literal]\n+x", ".*[literal] suffix\nx\nlast\n"],
  ["whitespace-only prefix", " indented\nlast\n", "@@^  \n+x", " indented\nx\nlast\n"],
  ["leading and trailing whitespace", "\tprefix rest\nlast\n", "@@^ \tprefix \n+x", "\tprefix rest\nx\nlast\n"],
  ["BOM and mixed endings", "\ufefffirst\r\nprefix paragraph\n\rtail\rend", "@@^ prefix\n+note",
    "\ufefffirst\r\nprefix paragraph\n\rnote\n\rtail\rend"],
  ["first line BOM", "\ufeffprefix paragraph\r\ntail\n", "@@^ prefix\n+note", "\ufeffprefix paragraph\r\nnote\r\ntail\n"],
  ["unterminated last line", "first\rprefix paragraph", "@@^ prefix\n+note", "first\rprefix paragraph\rnote"],
  ["eligible region and ordinary anchor", "prefix before\nsection\nprefix after\nold\n",
    "@@ section\n+note\n@@^ prefix\n-old\n+new", "prefix before\nsection\nnote\nprefix after\nnew\n"],
  ["numbered cursor excludes earlier matches", "prefix before\nold\nprefix after\ntail\n",
    "@@@ 2\n-old\n+new\n@@^ prefix\n+note", "prefix before\nnew\nprefix after\nnote\ntail\n"],
  ["sequential prefixes keep source positions", "first paragraph\nsecond paragraph\nlast\n",
    "@@^ first\n+one\n@@^ second\n+two", "first paragraph\none\nsecond paragraph\ntwo\nlast\n"],
  ["body still searches forward", "prefix paragraph\nkeep\nold\n", "@@^ prefix\n-old\n+new",
    "prefix paragraph\nkeep\nnew\n"],
  ["body retains context tolerance", "prefix paragraph\n old \n", "@@^ prefix\n-old\n+new",
    "prefix paragraph\nnew\n"],
  ["EOF body targets final match", "prefix paragraph\nold\nmiddle\nold\n",
    "@@^ prefix\n-old\n+new\n*** End of File", "prefix paragraph\nold\nmiddle\nnew\n"],
];
for (const [name, source, body, expected] of cases) {
  test("prefix anchors: " + name, () => inTemp(async cwd => {
    await writeFile(join(cwd, "file"), source);
    await applyVerifiedPatch(wrap("*** Update File: file\n" + body), cwd);
    assert.equal(await readFile(join(cwd, "file"), "utf8"), expected);
  }));
}

const invalid = [
  ["missing", "other\n", "@@^ prefix\n+x", /Failed to find prefix/],
  ["case", "Prefix\n", "@@^ prefix\n+x", /Failed to find prefix/],
  ["leading whitespace", " prefix\n", "@@^ prefix\n+x", /Failed to find prefix/],
  ["trailing whitespace", "prefix\n", "@@^ prefix \n+x", /Failed to find prefix/],
  ["punctuation", "a\u2013b\n", "@@^ a-b\n+x", /Failed to find prefix/],
  ["substring", "before prefix\n", "@@^ prefix\n+x", /Failed to find prefix/],
  ["empty source", "", "@@^ prefix\n+x", /Failed to find prefix/],
  ["ambiguous despite following text", "prefix one\nold\nprefix two\ntarget\n",
    "@@^ prefix\n-target\n+new\n*** End of File", /Ambiguous prefix anchor.*2 matches/],
  ["full-line equality does not outrank longer prefix match", "prefix\nprefix longer\n",
    "@@^ prefix\n+x", /Ambiguous prefix anchor.*2 matches/],
  ["backward anchor", "prefix\nold\n", "@@@ 2\n-old\n+new\n@@^ prefix\n+x", /Failed to find prefix/],
  ["overlap with numbered chunk", "prefix\nold\n", "@@^ prefix\n-old\n+new\n@@@ 2\n-old\n+again",
    /Overlapping chunks/],
  ["partial removal remains invalid", "prefix\nold suffix\n", "@@^ prefix\n-old\n+new", /Failed to find expected lines/],
  ["anchor line cannot be removed by its chunk", "prefix paragraph\nlast\n",
    "@@^ prefix\n-prefix paragraph\n+new", /Failed to find expected lines/],
  ["ordinary anchor remains whole-line", "prefix paragraph\nlast\n", "@@ prefix\n+x", /Failed to find anchor/],
] as const;
for (const [name, source, body, error] of invalid) {
  test("prefix preflight rejects " + name + " before writes", () => inTemp(async cwd => {
    await writeFile(join(cwd, "file"), source);
    await assert.rejects(applyVerifiedPatch(wrap("*** Add File: untouched\n+new\n*** Update File: file\n" + body), cwd), error);
    assert.equal(await readFile(join(cwd, "file"), "utf8"), source);
    await assert.rejects(readFile(join(cwd, "untouched")), { code: "ENOENT" });
  }));
}

test("prefix anchors use earlier operation output and support moves", () => inTemp(async cwd => {
  await applyVerifiedPatch(wrap("*** Add File: file\n+prefix paragraph\n+old\n*** Update File: file\n*** Move to: moved\n@@^ prefix\n-old\n+new"), cwd);
  assert.equal(await readFile(join(cwd, "moved"), "utf8"), "prefix paragraph\nnew\n");
  await assert.rejects(readFile(join(cwd, "file")), { code: "ENOENT" });
}));
