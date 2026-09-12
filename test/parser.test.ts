import assert from "node:assert/strict";
import test from "node:test";
import { parsePatch } from "../src/parser.js";

test("parser preserves ordered edit operations and their literal text", () => {
  assert.deepEqual(parsePatch("*** Update File: sample\n*** Move to: moved\n@@.\n same \n-old\n+new\n.+"), [{
    kind: "update", path: "sample", destination: "moved", finalTerminator: "ensure", blocks: [{
      atEnd: true, lines: [
        { kind: "keep", text: "same " }, { kind: "remove", text: "old" }, { kind: "insert", text: "new" },
      ],
    }],
  }]);
});

test("header-like context belongs to its update rather than another file", () => {
  const parsed = parsePatch("*** Update File: sample\n *** Add File: literal\n+next\n*** Delete File: other");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, "update");
  if (parsed[0].kind === "update") assert.deepEqual(parsed[0].blocks[0].lines[0], { kind: "keep", text: "*** Add File: literal" });
});

test("directive-only EOF chunks preserve a following block and carry no content", () => {
  const parsed = parsePatch("*** Update File: sample\n@@.\n.-\n@@ next\n+extra");
  assert.equal(parsed[0].kind, "update");
  if (parsed[0].kind === "update") {
    assert.equal(parsed[0].finalTerminator, "strip");
    assert.equal(parsed[0].blocks.length, 2);
    assert.deepEqual(parsed[0].blocks[0], { atEnd: true, lines: [] });
    assert.equal(parsed[0].blocks[1].anchor, "next");
  }
});

test("only exact EOF directives are removed from chunk content", () => {
  assert.deepEqual(parsePatch("*** Update File: sample\n@@.\n .-\n+.+\n.+"), [{
    kind: "update", path: "sample", finalTerminator: "ensure", blocks: [{ atEnd: true, lines: [
      { kind: "keep", text: ".-" }, { kind: "insert", text: ".+" },
    ] }],
  }]);
});

test("repeated final-terminator controls agree but contradictory controls reject", () => {
  const [edit] = parsePatch("*** Update File: sample\n@@.\n.+\n.+");
  assert.equal(edit.kind, "update");
  if (edit.kind === "update") assert.equal(edit.finalTerminator, "ensure");
  assert.throws(() => parsePatch("*** Update File: sample\n@@.\n.+\n@@.\n.-"), /^Error: Invalid patch/);
});

test("bare operations preserve significant final-line whitespace and explicit blank context", () => {
  assert.deepEqual(parsePatch("*** Add File: added\n+last  "), [{
    kind: "add", path: "added", contents: "last  \n",
  }]);
  assert.deepEqual(parsePatch("*** Update File: sample\n@@.\n "), [{
    kind: "update", path: "sample", blocks: [{
      atEnd: true, lines: [{ kind: "keep", text: "" }],
    }],
  }]);
});

test("the final record ends at EOF and a transport newline is discarded", () => {
  const body = "*** Add File: first\n+one\n*** Delete File: second";
  assert.deepEqual(parsePatch(body), [
    { kind: "add", path: "first", contents: "one\n" },
    { kind: "delete", path: "second" },
  ]);
  for (const ending of ["\n", "\r\n", "\r", "\n\r"]) {
    assert.deepEqual(parsePatch(body.replaceAll("\n", ending) + ending), parsePatch(body));
    assert.deepEqual(parsePatch(`*** Add File: last${ending}+text \t${ending}`), [
      { kind: "add", path: "last", contents: "text \t\n" },
    ]);
  }
});

test("header-like final context remains part of its update", () => {
  assert.deepEqual(parsePatch("*** Update File: sample\n@@.\n *** Add File: literal"), [{
    kind: "update", path: "sample", blocks: [{
      atEnd: true, lines: [{ kind: "keep", text: "*** Add File: literal" }],
    }],
  }]);
});

for (const body of [
  "*** Update File: sample\n@@",
  "*** Update File: sample\n@@\n.+",
  "*** Update File: sample\n@@.\n.+ ",
  "*** Update File: sample\n@@.\n. +",
  "*** Delete File: sample\n+x",
  "*** Add File: sample\ntext",
  "*** Add File: sample\n+hello\n.- ",
  "*** Add File: sample\n+hello\n .-",
  "*** Delete File: sample\n.-",
  "*** Environment ID: remote\n*** Add File: sample\n+x",
]) {
  test(`parser rejects malformed record ${JSON.stringify(body)}`, () => {
    assert.throws(() => parsePatch(body), /^Error: Invalid patch/);
  });
}
