// Project provenance and license: see NOTICE.
import { dirname } from "node:path";
import { parsePatch, type EditBlock, type FileEdit, type FinalTerminator } from "./parser.js";
import type { PatchFileSystem } from "./filesystem.js";
import { preflightFileSystem } from "./preflight.js";
import { equalBytes as equal, verifyFinalState, type ExpectedState, type VerificationFailure } from "./verification.js";

/** A source line is an offset range, not a normalized copy of its contents. */
class Source {
  readonly offsets: number[] = [0];
  readonly text: string;
  readonly bom: string;
  constructor(original: string) {
    this.bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
    this.text = original.slice(this.bom.length);
    for (const match of this.text.matchAll(/\r\n|\n\r|\r|\n/g)) {
      this.offsets.push(match.index! + match[0].length);
    }
    if (this.offsets.at(-1) !== this.text.length) this.offsets.push(this.text.length);
  }
  get size(): number { return this.offsets.length - 1; }
  raw(index: number): string { return this.text.slice(this.offsets[index], this.offsets[index + 1]); }
  ending(index: number): string {
    const end = this.offsets[index + 1];
    const last = this.text[end - 1];
    if (last !== "\r" && last !== "\n") return "";
    const previous = this.text[end - 2];
    return end - this.offsets[index] >= 2 && (previous === "\r" || previous === "\n") && previous !== last
      ? previous + last : last;
  }
  matchText(index: number): string {
    const raw = this.raw(index);
    return raw.slice(0, raw.length - this.ending(index).length);
  }
}

const whitespaceRight = /\p{White_Space}+$/u;
const whitespaceLeft = /^\p{White_Space}+/u;
const punctuation = /[\u2010-\u2015\u2212\u2018-\u201f\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu;
function forms(value: string): string[] {
  const right = value.replace(whitespaceRight, "");
  const surrounding = right.replace(whitespaceLeft, "");
  const folded = surrounding.replace(punctuation, character => {
    const code = character.charCodeAt(0);
    if (code >= 0x2018 && code <= 0x201b) return "'";
    if (code >= 0x201c && code <= 0x201f) return '"';
    if (code >= 0x2010 && code <= 0x2015 || code === 0x2212) return "-";
    return " ";
  });
  return [value, right, surrounding, folded];
}

/** Rank each candidate once; only candidates tied for the best rank compete. */
function locate(source: Source, expected: string[], cursor: number, atEnd: boolean, path: string): number | undefined {
  if (expected.length === 0) return cursor;
  const last = source.size - expected.length;
  if (last < cursor) return undefined;
  const needles = expected.map(forms);
  let best = 4;
  let winner: number | undefined;
  let count = 0;
  for (let position = atEnd ? last : cursor; position <= last; position++) {
    let rank = 0;
    for (let offset = 0; offset < needles.length; offset++) {
      const actual = forms(source.matchText(position + offset));
      while (rank < 4 && actual[rank] !== needles[offset][rank]) rank++;
      if (rank > best || rank === 4) break;
    }
    if (rank < best) { best = rank; winner = position; count = 1; }
    else if (rank === best && rank < 4) count++;
  }
  if (count > 1) {
    const tier = ["exact", "trailing whitespace", "surrounding whitespace", "Unicode punctuation"][best];
    throw new Error(`Ambiguous match in ${path}: ${count} matches at ${tier} tolerance. Supply a unique anchor, more context, or an @@. EOF chunk.`);
  }
  return winner;
}

/** Prefix anchors are literal and unique within the remaining source region. */
function locatePrefix(source: Source, prefix: string, cursor: number, path: string): number {
  let winner: number | undefined;
  let count = 0;
  for (let position = cursor; position < source.size; position++) {
    if (source.matchText(position).startsWith(prefix)) { winner = position; count++; }
  }
  if (count > 1) throw new Error(`Ambiguous prefix anchor in ${path}: ${count} matches. Supply a longer unique prefix or use @@@ N.`);
  if (winner === undefined) throw new Error(`Failed to find prefix '${prefix}' in ${path}`);
  return winner;
}

// Numbers reference source lines; strings are newly supplied text. A piece table
// keeps untouched ranges compact while edits change the logical line sequence.
type Token = number | string;
type Piece = { first: number; count: number; inserted?: Token[] };
type Change = { position: number; consumed: number; output: Token[] };

function compile(source: Source, blocks: EditBlock[], path: string): Change[] {
  const changes: Change[] = [];
  let cursor = 0;
  for (const block of blocks) {
    // File-level terminator directives neither match lines nor move the cursor.
    if (!block.lines.length) continue;
    if (block.anchor !== undefined) {
      const anchor = locate(source, [block.anchor], cursor, false, path);
      if (anchor === undefined) throw new Error(`Failed to find anchor '${block.anchor}' in ${path}`);
      cursor = anchor + 1;
    }
    if (block.prefix !== undefined) cursor = locatePrefix(source, block.prefix, cursor, path) + 1;
    const expected = block.lines.filter(line => line.kind !== "insert").map(line => line.text);
    let consumed = expected.length;
    let position: number | undefined;
    if (block.line !== undefined) {
      position = block.line - 1;
      if (position > source.size || position + consumed > source.size) {
        throw new Error(`Line ${block.line} is outside the available range in ${path}`);
      }
      if (!expected.every((text, offset) => source.matchText(position! + offset) === text)) {
        throw new Error(`Exact text mismatch at line ${block.line} in ${path}`);
      }
      cursor = position + consumed;
    } else if (consumed === 0) {
      const append = source.size && source.raw(source.size - 1) === source.ending(source.size - 1) ? source.size - 1 : source.size;
      position = block.atEnd ? source.size : block.anchor === undefined && block.prefix === undefined ? append : cursor;
    } else {
      position = locate(source, expected, cursor, block.atEnd, path);
      if (!block.atEnd && position === undefined && expected[consumed - 1] === "") {
        consumed--;
        position = locate(source, expected.slice(0, consumed), cursor, block.atEnd, path);
      }
      if (position === undefined) throw new Error(`Failed to find expected lines in ${path}`);
      cursor = position + consumed;
    }
    const output: Token[] = [];
    let input = 0;
    // Missing final empty context has no source bytes. Explicit insertions,
    // including empty lines, always remain part of the requested output.
    for (const line of block.lines) {
      if (line.kind === "insert") {
        output.push(line.text);
      } else {
        if (line.kind === "keep" && input < consumed) output.push(position + input);
        input++;
      }
    }
    changes.push({ position, consumed, output });
  }
  changes.sort((a, b) => a.position - b.position);
  let consumedUntil = 0;
  for (const change of changes) {
    if (change.position < consumedUntil) throw new Error(`Overlapping chunks in ${path}`);
    consumedUntil = change.position + change.consumed;
  }
  return changes;
}

function finalize(content: string, control?: FinalTerminator, inherited = "\n"): string {
  if (control === "strip") {
    let end = content.length;
    while (end && (content[end - 1] === "\r" || content[end - 1] === "\n")) end--;
    return content.slice(0, end);
  }
  if (control === "ensure" && !content.endsWith("\r") && !content.endsWith("\n")) {
    return content + (content ? inherited : "\n");
  }
  return content;
}

function render(source: Source, changes: Change[], finalTerminator?: FinalTerminator): string {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const change of changes) {
    if (change.position > cursor) pieces.push({ first: cursor, count: change.position - cursor });
    pieces.push({ first: 0, count: change.output.length, inserted: change.output });
    cursor = change.position + change.consumed;
  }
  if (cursor < source.size) pieces.push({ first: cursor, count: source.size - cursor });
  const finalEnding = source.size ? source.ending(source.size - 1) : "\n";
  const size = pieces.reduce((total, piece) => total + piece.count, 0);
  let emitted = 0;
  let inherited = source.size ? source.ending(0) || "\n" : "\n";
  const output: string[] = [];
  for (const piece of pieces) {
    for (let index = piece.first; index < piece.first + piece.count; index++) {
      const token = piece.inserted ? piece.inserted[index] : index;
      const ending = typeof token === "number" ? source.ending(token) : "";
      const raw = typeof token === "number" ? source.raw(token) : token;
      const text = raw.slice(0, raw.length - ending.length);
      const chosen = ++emitted === size ? finalEnding : ending || inherited;
      if (chosen) inherited = chosen;
      output.push(text + chosen);
    }
  }
  return source.bom + finalize(output.join(""), finalTerminator, inherited);
}

export type PatchResult = {
  text: string; added: string[]; modified: string[]; deleted: string[]; unchanged: string[];
  verification: { status: "passed"; checkedPaths: number };
};
export type PatchFailureDetails = {
  phase: "preparation" | "execution" | "verification";
  completedOperations: number;
  totalOperations: number;
  mutationAttempted: boolean;
  verification: { status: "not-run" | "failed"; failures?: VerificationFailure[] };
};
export class PatchError extends Error {
  readonly code?: string;
  constructor(message: string, readonly details: PatchFailureDetails, cause?: unknown) {
    super(message, { cause });
    this.name = "PatchError";
    this.code = (cause as { code?: string } | undefined)?.code;
  }
}
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

async function revised(source: string, blocks: EditBlock[], fs: PatchFileSystem, finalTerminator?: FinalTerminator): Promise<{ original: Uint8Array; content: string }> {
  let original: Uint8Array;
  let text: string;
  try {
    original = await fs.read(source);
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
  } catch (cause) { throw new Error(`Failed to read file to update ${source}: ${(cause as Error).message}`, { cause }); }
  const document = new Source(text);
  return { original, content: render(document, compile(document, blocks, source), finalTerminator) };
}

async function perform(
  edit: FileEdit, cwd: string, fs: PatchFileSystem,
  expected?: Map<string, ExpectedState>, onMutation?: () => void,
): Promise<boolean> {
  const write = async (path: string, content: string, createParents: boolean) => {
    onMutation?.();
    await fs.write(path, content, createParents);
    // Later writes can recreate an explicitly deleted ancestor as a directory.
    if (expected && createParents) {
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        if (expected.get(parent) === null) expected.set(parent, { kind: "directory" });
        if (dirname(parent) === parent) break;
      }
    }
  };
  const source = fs.resolve(cwd, edit.path);
  await fs.checkPath(source);
  if (edit.kind === "delete") {
    expected?.set(source, null);
    if (!await fs.inspect(source)) return false;
    try { onMutation?.(); await fs.remove(source); }
    catch (cause) { throw new Error(`Failed to delete path ${source}: ${(cause as Error).message}`, { cause }); }
  } else if (edit.kind === "add") {
    const content = finalize(edit.contents, edit.finalTerminator);
    const data = bytes(content);
    expected?.set(source, { kind: "file", data });
    const info = await fs.inspect(source);
    if (info?.kind === "file" && equal(await fs.read(source), data)) return false;
    await write(source, content, true);
  } else {
    const { original, content } = await revised(source, edit.blocks, fs, edit.finalTerminator);
    const destination = edit.destination === undefined ? source : fs.resolve(cwd, edit.destination);
    await fs.checkPath(destination);
    const data = bytes(content);
    const unchanged = destination === source && equal(original, data);
    // An unchanged update may retain a readable leaf symlink.
    expected?.set(destination, { kind: "file", data, allowOther: unchanged });
    if (unchanged) return false;
    await write(destination, content, destination !== source);
    if (destination !== source) {
      await fs.checkPath(source);
      onMutation?.();
      await fs.remove(source);
      expected?.set(source, null);
    }
  }
  return true;
}

async function execute(input: string, cwd: string, fs: PatchFileSystem, preflight: boolean): Promise<PatchResult> {
  let edits: FileEdit[] = [];
  const paths = new Map<string, { label: string; written: boolean }>();
  const initial = new Map<string, { kind: string; data?: Uint8Array } | null>();
  try {
    edits = parsePatch(input);
    if (!edits.length) throw new Error("No files were modified.");
    if (preflight) {
      const virtual = preflightFileSystem(fs);
      for (const edit of edits) await perform(edit, cwd, virtual);
    }
    // Capture only explicitly named paths. Pure deletes never read file contents.
    for (const edit of edits) {
      const source = fs.resolve(cwd, edit.path);
      const previous = paths.get(source);
      paths.set(source, { label: previous?.label ?? edit.path, written: previous?.written || edit.kind !== "delete" });
      if (edit.kind === "update" && edit.destination !== undefined) {
        const destination = fs.resolve(cwd, edit.destination);
        paths.set(destination, { label: paths.get(destination)?.label ?? edit.destination, written: true });
      }
    }
    for (const [path, spec] of paths) {
      await fs.checkPath(path);
      const info = await fs.inspect(path);
      initial.set(path, info ? { ...info, ...(spec.written && info.kind === "file" ? { data: await fs.read(path) } : {}) } : null);
    }
  } catch (cause) {
    throw new PatchError(`Patch rejected before execution; no changes made. ${(cause as Error).message}`, {
      phase: "preparation", completedOperations: 0, totalOperations: edits.length,
      mutationAttempted: false, verification: { status: "not-run" },
    }, cause);
  }
  const expected = new Map<string, ExpectedState>();
  const mutated = new Set<string>();
  let mutationAttempted = false;
  let completedOperations = 0;
  // Mark attempts before entering I/O: an adapter can mutate and then throw.
  const onMutation = () => { mutationAttempted = true; };
  // Re-evaluate against current bytes, not the discarded preflight snapshot.
  for (const edit of edits) {
    try {
      if (await perform(edit, cwd, fs, expected, onMutation)) {
        mutated.add(fs.resolve(cwd, edit.path));
        if (edit.kind === "update" && edit.destination !== undefined) mutated.add(fs.resolve(cwd, edit.destination));
      }
      completedOperations++;
    } catch (cause) {
      const state = mutationAttempted
        ? "Changes may already have occurred; no rollback was performed."
        : "No filesystem mutations were attempted.";
      throw new PatchError(
        `Patch execution failed at operation ${completedOperations + 1}/${edits.length} (${edit.kind} ${edit.path}). `
        + `${completedOperations} operations completed; later operations were not executed. ${state} `
        + `Final-state verification was not run. ${(cause as Error).message}`,
        { phase: "execution", completedOperations, totalOperations: edits.length, mutationAttempted,
          verification: { status: "not-run" } }, cause,
      );
    }
  }
  const { observed, failures } = await verifyFinalState(paths, expected, fs);
  if (failures.length) {
    const state = mutationAttempted
      ? "Changes may already have occurred; no rollback was performed."
      : "No filesystem mutations were attempted.";
    throw new PatchError(
      `Patch verification failed after execution. ${state}\n`
      + failures.map(failure => `${failure.path}: ${failure.status}: ${failure.message}`).join("\n"),
      { phase: "verification", completedOperations, totalOperations: edits.length, mutationAttempted,
        verification: { status: "failed", failures } },
    );
  }
  const result: PatchResult = { text: "", added: [], modified: [], deleted: [], unchanged: [],
    verification: { status: "passed", checkedPaths: paths.size } };
  for (const [path, spec] of paths) {
    const before = initial.get(path)!;
    const after = observed.get(path)!;
    if (!before && after) result.added.push(spec.label);
    else if (before && !after) result.deleted.push(spec.label);
    else if (!before && !after) result.unchanged.push(spec.label);
    else if (!mutated.has(path) && before?.kind === after?.kind) result.unchanged.push(spec.label);
    else if (before?.kind === "directory" && after?.kind === "directory") result.unchanged.push(spec.label);
    else if (before?.data && after?.kind === "file" && after.data && equal(before.data, after.data)) result.unchanged.push(spec.label);
    else result.modified.push(spec.label);
  }
  result.text = "Success. Verified final file bytes and expected path presence/absence for all touched paths.\n";
  const rows = [["A", result.added], ["M", result.modified], ["D", result.deleted], ["N", result.unchanged]] as const;
  for (const [label, paths] of rows) for (const path of paths) result.text += `${label} ${path}\n`;
  return result;
}

export const applyVerifiedPatch = (input: string, cwd: string, fs: PatchFileSystem): Promise<PatchResult> => execute(input, cwd, fs, true);
export const applyPatch = (input: string, cwd: string, fs: PatchFileSystem): Promise<PatchResult> => execute(input, cwd, fs, false);
