import assert from "node:assert/strict";
import test from "node:test";
import { parsePatch } from "../src/parser.js";

const patch = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

test("parser preserves ordered edit operations and their literal text", () => {
  assert.deepEqual(parsePatch(patch("*** Update File: sample\n*** Move to: moved\n@@ section\n same \n-old\n+new\n*** End of File")), [{
    kind: "update", path: "sample", destination: "moved", blocks: [{
      anchor: "section", atEnd: true, lines: [
        { kind: "keep", text: "same " }, { kind: "remove", text: "old" }, { kind: "insert", text: "new" },
      ],
    }],
  }]);
});

test("header-like context belongs to its update rather than another file", () => {
  const parsed = parsePatch(patch("*** Update File: sample\n *** Add File: literal\n+next\n*** Delete File: other"));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, "update");
  if (parsed[0].kind === "update") assert.deepEqual(parsed[0].blocks[0].lines[0], { kind: "keep", text: "*** Add File: literal" });
});

test("EOF gaps separate edit blocks without adding blank context", () => {
  const parsed = parsePatch(patch("*** Update File: sample\n-old\n+new\n*** End of File\n \n\n@@ next\n+extra"));
  assert.equal(parsed[0].kind, "update");
  if (parsed[0].kind === "update") {
    assert.equal(parsed[0].blocks.length, 2);
    assert.equal(parsed[0].blocks[0].lines.length, 2);
    assert.equal(parsed[0].blocks[1].anchor, "next");
  }
});

for (const body of [
  "*** Update File: sample\n@@",
  "*** Update File: sample\n+x\n@@\n*** End of File",
  "*** Update File: sample\n+x\n*** End of File\n+y",
  "*** Delete File: sample\n+x",
  "*** Add File: sample\ntext",
  "*** Environment ID: remote\n*** Add File: sample\n+x",
]) {
  test(`parser rejects malformed record ${JSON.stringify(body)}`, () => {
    assert.throws(() => parsePatch(patch(body)), /^Error: Invalid patch/);
  });
}
