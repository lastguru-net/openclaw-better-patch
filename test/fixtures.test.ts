import assert from "node:assert/strict";
import { cp, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { PatchResult } from "../src/patch.js";
import { applyPatch, inTemp } from "./helpers.js";

const fixtures = fileURLToPath(new URL("fixtures", import.meta.url));
const rejectFixtures = new Set([
  "005_rejects_empty_patch",
  "006_rejects_missing_context",
  "008_rejects_empty_update_hunk",
  "009_requires_existing_file_for_update",
  "012_delete_directory_fails",
  "013_rejects_invalid_hunk_header",
  "015_failure_after_partial_success_leaves_changes",
]);

const fixtureResults: Record<string, Omit<PatchResult, "text" | "unchanged" | "verification"> & { unchanged?: string[] }> = {
  "007_rejects_missing_file_delete": { added: [], modified: [], deleted: [], unchanged: ["missing.txt"] },
  "001_add_file": { added: ["bar.md"], modified: [], deleted: [] },
  "002_multiple_operations": { added: ["nested/new.txt"], modified: ["modify.txt"], deleted: ["delete.txt"] },
  "003_multiple_chunks": { added: [], modified: ["multi.txt"], deleted: [] },
  "004_move_to_new_directory": { added: ["renamed/dir/name.txt"], modified: [], deleted: ["old/name.txt"] },
  "010_move_overwrites_existing_destination": { added: [], modified: ["renamed/dir/name.txt"], deleted: ["old/name.txt"] },
  "011_add_overwrites_existing_file": { added: [], modified: ["duplicate.txt"], deleted: [] },
  "014_update_file_appends_trailing_newline": { added: [], modified: ["no_newline.txt"], deleted: [] },
  "016_pure_addition_update_chunk": { added: [], modified: ["input.txt"], deleted: [] },
  "017_whitespace_padded_hunk_header": { added: [], modified: ["foo.txt"], deleted: [] },
  "019_unicode_simple": { added: [], modified: ["foo.txt"], deleted: [] },
  "020_delete_file_success": { added: [], modified: [], deleted: ["obsolete.txt"] },
  "021_update_file_deletion_only": { added: [], modified: ["lines.txt"], deleted: [] },
};

type TreeEntry = { kind: "directory" } | { kind: "file"; bytes: string };

async function snapshotTree(root: string): Promise<Record<string, TreeEntry>> {
  const result: Record<string, TreeEntry> = {};
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        result[name] = { kind: "directory" };
        await visit(path);
      } else {
        result[name] = { kind: "file", bytes: (await readFile(path)).toString("hex") };
      }
    }
  }
  await visit(root);
  return result;
}

const fixtureNames = (await readdir(fixtures, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(fixtureNames, [...Object.keys(fixtureResults), ...rejectFixtures].sort());

for (const name of fixtureNames) {
  test(`upstream fixture: ${name}`, async () => inTemp(async (cwd) => {
    const fixture = join(fixtures, name);
    await cp(join(fixture, "input"), cwd, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const patch = await readFile(join(fixture, "patch.txt"), "utf8");
    let result: PatchResult | undefined;
    let failure: unknown;
    try { result = await applyPatch(patch, cwd); }
    catch (error) { failure = error; }

    assert.deepEqual(await snapshotTree(cwd), await snapshotTree(join(fixture, "expected")));
    if (rejectFixtures.has(name)) {
      assert.ok(failure instanceof Error, "fixture should reject");
      assert.equal(result, undefined);
      if (name === "015_failure_after_partial_success_leaves_changes") assert.match(failure.message, /Failed to read file to update/);
    } else {
      assert.ifError(failure);
      const expected = fixtureResults[name];
      const { text: _text, verification, ...categories } = result!;
      assert.deepEqual(categories, { unchanged: [], ...expected });
      assert.deepEqual(verification, {
        status: "passed", checkedPaths: Object.values({ unchanged: [], ...expected }).flat().length,
      });
    }
  }));
}

