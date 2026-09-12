import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyPatch, applyVerifiedPatch, PatchError } from "../src/patch.js";
import { hostFileSystem } from "../src/host.js";
import { inTemp } from "./helpers.js";

const add = (path: string, text: string) => `*** Add File: ${path}\n+${text}`;
const update = (path: string, old: string, text: string) => `*** Update File: ${path}\n@@\n-${old}\n+${text}`;
async function failure(run: Promise<unknown>): Promise<PatchError> {
  try { await run; } catch (error) { assert.ok(error instanceof PatchError); return error; }
  assert.fail("Expected patch failure");
}

for (const apply of [applyPatch, applyVerifiedPatch]) {
  test(`${apply.name} unconditionally detects acknowledged but corrupted additions`, () => inTemp(async cwd => {
    const base = await hostFileSystem(cwd);
    const error = await failure(apply(add("f", "expected"), cwd, {
      ...base, write: (path, _content, parents) => base.write(path, "corrupted\n", parents),
    }));
    assert.equal(error.details.phase, "verification");
    assert.deepEqual(error.details.verification.failures, [{
      path: "f", status: "mismatch", message: "Final file bytes differ from the expected result",
    }]);
    assert.match(error.message, /Changes may already have occurred/);
    assert.equal(await readFile(join(cwd, "f"), "utf8"), "corrupted\n");
  }));
}

for (const [name, corrupt] of [
  ["BOM", (text: string) => text.replace("\uFEFF", "")],
  ["line endings", (text: string) => text.replaceAll("\r\n", "\n")],
  ["final newline", (text: string) => text + "\r\n"],
] as const) {
  test(`verification detects changes to exact ${name} bytes`, () => inTemp(async cwd => {
    const base = await hostFileSystem(cwd);
    await writeFile(join(cwd, "f"), "\uFEFFold\r\ntail");
    const error = await failure(applyVerifiedPatch(update("f", "old", "new"), cwd, {
      ...base, write: (path, content, parents) => base.write(path, corrupt(content), parents),
    }));
    assert.equal(error.details.verification.failures?.[0].status, "mismatch");
  }));
}

test("acknowledged but missing writes and retained deletions both fail verification", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await writeFile(join(cwd, "old"), "obsolete");
  const error = await failure(applyVerifiedPatch(add("new", "expected") + "\n*** Delete File: old", cwd, {
    ...base, write: async () => {}, remove: async () => {},
  }));
  assert.deepEqual(error.details.verification.failures?.map(f => [f.path, f.status]), [
    ["new", "mismatch"], ["old", "mismatch"],
  ]);
  assert.match(error.message, /Expected absence/);
}));

test("readback failures are unverified results, not byte mismatches", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  let wrote = false;
  const error = await failure(applyVerifiedPatch(add("a", "one") + "\n" + add("b", "two"), cwd, {
    ...base,
    async write(...args) { await base.write(...args); wrote = true; },
    async read(path) { if (wrote) throw new Error("readback denied"); return base.read(path); },
  }));
  assert.deepEqual(error.details.verification.failures?.map(f => [f.path, f.status]), [
    ["a", "unreadable"], ["b", "unreadable"],
  ]);
  assert.match(error.message, /readback denied/);
}));

test("final readback is shared by verification and net reporting", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await writeFile(join(cwd, "old"), "before\n");
  let finalPhase = false;
  const reads: string[] = [];
  const result = await applyVerifiedPatch(update("old", "before", "after") + "\n" + add("new", "added"), cwd, {
    ...base,
    async write(...args) { await base.write(...args); if (args[0] === join(cwd, "new")) finalPhase = true; },
    async read(path) { if (finalPhase) reads.push(path); return base.read(path); },
  });
  assert.deepEqual(reads, [join(cwd, "old"), join(cwd, "new")]);
  assert.deepEqual(result.verification, { status: "passed", checkedPaths: 2 });
  assert.deepEqual(result.modified, ["old"]);
  assert.deepEqual(result.added, ["new"]);
}));

test("no-op files are read back even when no mutations occur", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await writeFile(join(cwd, "f"), "same\n");
  let readyForReadback = false;
  let missingInspections = 0;
  const error = await failure(applyVerifiedPatch(update("f", "same", "same") + "\n*** Delete File: missing", cwd, {
    ...base,
    async inspect(path) {
      // The last operation observes absence; corrupt the earlier no-op file.
      if (path === join(cwd, "missing")) {
        // Its third inspection is execution, after preflight and the initial snapshot.
        if (++missingInspections === 3) {
          await base.write(join(cwd, "f"), "changed externally\n", false);
          readyForReadback = true;
        }
      }
      return base.inspect(path);
    },
    write: async () => { assert.fail("No-op patch must not write"); },
    remove: async () => { assert.fail("Missing delete must not remove"); },
  }));
  assert.ok(readyForReadback);
  assert.equal(error.details.mutationAttempted, false);
  assert.equal(error.details.verification.failures?.[0].path, "f");
  assert.match(error.message, /No filesystem mutations were attempted/);
}));

test("moves verify both endpoints, including an acknowledged failed source removal", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await writeFile(join(cwd, "source"), "old\n");
  const error = await failure(applyVerifiedPatch("*** Update File: source\n*** Move to: destination\n@@\n-old\n+new", cwd, {
    ...base, remove: async () => {},
  }));
  assert.deepEqual(error.details.verification.failures?.map(f => f.path), ["source"]);
  assert.equal(await readFile(join(cwd, "destination"), "utf8"), "new\n");
}));

test("final expectations follow recreated move sources and deleted destinations", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await writeFile(join(cwd, "a"), "one\n");
  const result = await applyVerifiedPatch(
    "*** Update File: a\n*** Move to: b\n@@\n-one\n+two\n"
    + add("a", "recreated") + "\n*** Delete File: b", cwd, base);
  assert.deepEqual(result.modified, ["a"]);
  assert.deepEqual(result.unchanged, ["b"]);
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "recreated\n");
}));

test("explicitly deleted ancestors can become directories again", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await mkdir(join(cwd, "d"));
  const result = await applyVerifiedPatch("*** Delete File: d\n" + add("d/nested/f", "one"), cwd, base);
  assert.deepEqual(result.unchanged, ["d"]);
  assert.deepEqual(result.added, ["d/nested/f"]);
  assert.equal(result.verification.checkedPaths, 2);
}));

test("net no-ops verify the final state after intermediate writes", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await writeFile(join(cwd, "f"), "one\n");
  const result = await applyVerifiedPatch(
    update("f", "one", "two") + "\n" + update("f", "two", "one") + "\n"
    + add("transient", "gone") + "\n*** Delete File: transient", cwd, base);
  assert.deepEqual(result.unchanged, ["f", "transient"]);
  assert.deepEqual(result.verification, { status: "passed", checkedPaths: 2 });
}));

test("execution validates current source and verification uses its output, not preflight bytes", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await writeFile(join(cwd, "f"), "snapshot\nold\n");
  const result = await applyVerifiedPatch(add("trigger", "one") + "\n" + update("f", "old", "new"), cwd, {
    ...base,
    async write(...args) {
      await base.write(...args);
      if (args[0] === join(cwd, "trigger")) await base.write(join(cwd, "f"), "live\nold\n", false);
    },
  });
  assert.equal(result.verification.status, "passed");
  assert.equal(await readFile(join(cwd, "f"), "utf8"), "live\nnew\n");
}));

test("stale execution-time source rejects even after a successful preflight", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  await writeFile(join(cwd, "f"), "old\n");
  const error = await failure(applyVerifiedPatch(add("trigger", "one") + "\n" + update("f", "old", "new"), cwd, {
    ...base,
    async write(...args) {
      await base.write(...args);
      if (args[0] === join(cwd, "trigger")) await base.write(join(cwd, "f"), "no longer matches\n", false);
    },
  }));
  assert.equal(error.details.phase, "execution");
  assert.equal(error.details.completedOperations, 1);
  assert.equal(error.details.verification.status, "not-run");
  assert.match(error.message, /expected lines/);
}));

test("preflight rejection is distinct from an adapter mutating and then throwing mid-move", () => inTemp(async cwd => {
  const base = await hostFileSystem(cwd);
  const rejected = await failure(applyVerifiedPatch(add("new", "one") + "\n" + update("missing", "old", "new"), cwd, base));
  assert.equal(rejected.details.phase, "preparation");
  assert.equal(rejected.details.mutationAttempted, false);
  assert.match(rejected.message, /before execution; no changes made/);
  await writeFile(join(cwd, "source"), "old\n");
  const error = await failure(applyVerifiedPatch(
    "*** Update File: source\n*** Move to: destination\n@@\n-old\n+new\n" + add("later", "unexecuted"), cwd, {
    ...base, async remove(path) { await base.remove(path); throw new Error("lost acknowledgment"); },
  }));
  assert.equal(error.details.phase, "execution");
  assert.equal(error.details.completedOperations, 0);
  assert.equal(error.details.totalOperations, 2);
  assert.equal(error.details.mutationAttempted, true);
  assert.equal(error.details.verification.status, "not-run");
  assert.match(error.message, /later operations were not executed/);
  assert.equal(await readFile(join(cwd, "destination"), "utf8"), "new\n");
  await assert.rejects(readFile(join(cwd, "source")), { code: "ENOENT" });
  await assert.rejects(readFile(join(cwd, "later")), { code: "ENOENT" });
}));

test("cancellation after execution stops readback and marks remaining paths unchecked", () => inTemp(async cwd => {
  const controller = new AbortController();
  const base = await hostFileSystem(cwd, undefined, controller.signal);
  const error = await failure(applyVerifiedPatch(add("a", "one") + "\n" + add("b", "two"), cwd, {
    ...base,
    async write(...args) { await base.write(...args); if (args[0] === join(cwd, "b")) controller.abort(); },
  }));
  assert.equal(error.details.phase, "verification");
  assert.deepEqual(error.details.verification.failures?.map(f => [f.path, f.status]), [
    ["a", "unreadable"], ["b", "not-checked"],
  ]);
  assert.equal(error.details.completedOperations, 2);
}));

test("cancellation between operations reports partial execution without claiming verification", () => inTemp(async cwd => {
  const controller = new AbortController();
  const base = await hostFileSystem(cwd, undefined, controller.signal);
  const error = await failure(applyVerifiedPatch(add("a", "one") + "\n" + add("b", "two"), cwd, {
    ...base, async write(...args) { await base.write(...args); controller.abort(); },
  }));
  assert.equal(error.details.phase, "execution");
  assert.equal(error.details.completedOperations, 1);
  assert.equal(error.details.verification.status, "not-run");
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "one\n");
  await assert.rejects(readFile(join(cwd, "b")), { code: "ENOENT" });
}));
