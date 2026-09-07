// Adapted from OpenAI Codex rust-v0.153.4 (Apache-2.0). See NOTICE.
export type Chunk = { context?: string; old: string[]; replacement: string[]; eof: boolean };
export type Hunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; move?: string; chunks: Chunk[]; line: number };

// Rust str::trim uses Unicode White_Space, unlike JavaScript trim (notably BOM/NEL).
export const trim = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
export const trimEnd = (s: string): string => s.replace(/\p{White_Space}+$/u, "");
const begin = "*** Begin Patch";
const end = "*** End Patch";
const invalid = (message: string): never => { throw new Error(`Invalid patch: ${message}`); };
const invalidHunk = (line: number, message: string): never => {
  throw new Error(`Invalid patch hunk on line ${line}: ${message}`);
};
const empty = (chunk: Chunk): boolean => !chunk.old.length && !chunk.replacement.length;
const chunk = (context?: string): Chunk => ({ context, old: [], replacement: [], eof: false });

/** Parse the complete patch before making any filesystem changes. */
export function parsePatch(patch: string): Hunk[] {
  let lines = trim(patch).split(/\r?\n/);
  if (!(trim(lines[0]) === begin && trim(lines.at(-1)!) === end) &&
      lines.length >= 4 && ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]) &&
      lines.at(-1)!.endsWith("EOF")) {
    lines = lines.slice(1, -1);
  }
  if (trim(lines[0]) !== begin) invalid(`The first line of the patch must be '${begin}'`);
  if (trim(lines.at(-1)!) !== end) invalid(`The last line of the patch must be '${end}'`);

  const hunks: Hunk[] = [];
  let ended = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const number = i + 1;
    const current = hunks.at(-1);
    const trimmed = trim(line);
    if (ended) {
      if (trimmed) invalid(`The last line of the patch must be '${end}'`);
      continue;
    }
    // The upstream streaming parser only right-trims headers within updates;
    // its final End Patch marker is separately fully trimmed by finish().
    const header = current?.kind === "update" && i < lines.length - 1 ? trimEnd(line) : trimmed;
    const match = /^(\*\*\* (Add|Delete|Update) File: )(.+)$/.exec(header);
    if (header === end || match) {
      if (current?.kind === "update") {
        if (!current.chunks.length) {
          invalidHunk(current.line, `Update file hunk for path '${current.path}' is empty`);
        }
        if (empty(current.chunks.at(-1)!)) {
          invalidHunk(number, header === end ? "Update hunk does not contain any lines" :
            `Unexpected line found in update hunk: '${header}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
        }
      }
      if (header === end) { ended = true; continue; }
      const path = match![3];
      switch (match![2]) {
        case "Add": hunks.push({ kind: "add", path, contents: "" }); break;
        case "Delete": hunks.push({ kind: "delete", path }); break;
        case "Update": hunks.push({ kind: "update", path, chunks: [], line: number }); break;
      }
      continue;
    }
    if (!current && trimmed.startsWith("*** Environment ID:")) {
      invalid("Environment ID routing is not supported by better_patch; paths use the OpenClaw workspace");
    }
    if (current?.kind === "add" && line.startsWith("+")) {
      current.contents += line.slice(1) + "\n";
      continue;
    }
    if (current?.kind !== "update") {
      invalidHunk(number, `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`);
    }
    const update = current as Extract<Hunk, { kind: "update" }>;
    const right = trimEnd(line);
    const last = update.chunks.at(-1);
    const isContext = right === "@@" || right.startsWith("@@ ");
    const unexpected = () => invalidHunk(number,
      `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
    const expectedContext = () => invalidHunk(number,
      `Expected update hunk to start with a @@ context marker, got: '${line}'`);
    if (last?.eof) {
      if (!right) continue;
      if (!isContext) expectedContext();
    }
    if (!update.chunks.length && update.move === undefined && right.startsWith("*** Move to: ")) {
      update.move = right.slice("*** Move to: ".length);
      continue;
    }
    if (isContext) {
      if (last && empty(last)) unexpected();
      update.chunks.push(chunk(right === "@@" ? undefined : right.slice(3)));
      continue;
    }
    if (right === "*** End of File") {
      if (last && empty(last)) invalidHunk(number, "Update hunk does not contain any lines");
      if (last) last.eof = true;
      continue;
    }
    if (!line || [" ", "+", "-"].includes(line[0])) {
      if (!last) update.chunks.push(chunk());
      const target = update.chunks.at(-1)!;
      const text = line.slice(1);
      if (!line || line[0] === " ") { target.old.push(text); target.replacement.push(text); }
      else if (line[0] === "+") target.replacement.push(text);
      else target.old.push(text);
      continue;
    }
    if (last && !empty(last)) expectedContext();
    unexpected();
  }
  return hunks;
}
