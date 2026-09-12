// Project provenance and license: see NOTICE.
export type EditLine = { kind: "keep" | "insert" | "remove"; text: string };
export type EditBlock = { anchor?: string; prefix?: string; line?: number; atEnd: boolean; lines: EditLine[] };
export type FinalTerminator = "strip" | "ensure";
export type FileEdit =
  | { kind: "add"; path: string; contents: string; finalTerminator?: FinalTerminator }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; destination?: string; blocks: EditBlock[]; finalTerminator?: FinalTerminator };

type Token = { raw: string; right: string; stripped: string; number: number };
type FileRecord = { kind: FileEdit["kind"]; path: string; header: Token; body: Token[] };
const fail = (reason: string, token?: Token): never => {
  throw new Error(`Invalid patch${token ? ` at line ${token.number}` : ""}: ${reason}`);
};
const strip = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");

function tokenize(input: string): Token[] {
  const trimmed = strip(input);
  if (!trimmed) return [];
  const rows = trimmed.split(/\r\n|\n\r|\r|\n/);
  const wrapped = /^<<(?:EOF|'EOF'|"EOF")$/.test(rows[0]);
  if (wrapped && rows.at(-1) !== "EOF") fail("Missing literal heredoc EOF closing marker");
  // Only a wrapper protects the payload from whole-input whitespace trimming.
  // Otherwise preserve the last line's literal text and discard just the empty
  // split item produced by a final transport newline.
  const payload = wrapped ? rows.slice(1, -1) : input.split(/\r\n|\n\r|\r|\n/);
  if (!wrapped && payload.at(-1) === "") payload.pop();
  return payload.map((raw, index) => ({
    raw, right: raw.replace(/\p{White_Space}+$/u, ""), stripped: strip(raw), number: index + 1,
  }));
}

/** Separate file records before interpreting their individual bodies. */
function records(tokens: Token[]): FileRecord[] {
  const result: FileRecord[] = [];
  let active: FileRecord | undefined;
  for (const token of tokens) {
    // In update bodies, leading whitespace belongs to context, including text
    // that resembles a header, even on the final input line.
    const header = active?.kind === "update" ? token.right : token.stripped;
    const declaration = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(header);
    if (declaration) {
      active = {
        kind: declaration[1].toLowerCase() as FileEdit["kind"], path: declaration[2], header: token, body: [],
      };
      result.push(active);
    } else if (active) {
      active.body.push(token);
    } else {
      fail(token.stripped.startsWith("*** Environment ID:")
        ? "Environment ID routing is not supported; paths use the OpenClaw workspace"
        : "Expected a file declaration", token);
    }
  }
  return result;
}

const anchorOf = (token: Token): boolean => token.right === "@@" || token.right === "@@." || token.right.startsWith("@@ ") || token.right.startsWith("@@@") || token.raw.startsWith("@@^");

function controlOf(token: Token, current?: FinalTerminator): FinalTerminator | undefined {
  const control = token.raw === ".-" ? "strip" : token.raw === ".+" ? "ensure" : undefined;
  if (control !== undefined && current !== undefined && current !== control) {
    fail("Conflicting final-terminator controls in one file operation", token);
  }
  return control;
}

function editLine(token: Token): EditLine {
  const prefix = token.raw[0];
  const kind = prefix === "+" ? "insert" : prefix === "-" ? "remove" :
    prefix === " " || prefix === undefined ? "keep" : undefined;
  if (kind === undefined) return fail("Expected context, insertion, removal, or an @@ marker", token);
  return { kind, text: token.raw.slice(1) };
}

function updateRecord(record: FileRecord): FileEdit {
  const { body } = record;
  const blocks: EditBlock[] = [];
  let destination: string | undefined;
  let finalTerminator: FinalTerminator | undefined;
  let position = 0;
  if (body[0]?.right.startsWith("*** Move to: ")) {
    destination = body[0].right.slice("*** Move to: ".length);
    position++;
  }
  while (position < body.length) {
    const start = body[position];
    const block: EditBlock = { atEnd: false, lines: [] };
    if (anchorOf(start)) {
      if (start.right === "@@.") {
        block.atEnd = true;
      } else if (start.right.startsWith("@@@")) {
        const match = /^@@@ ([1-9][0-9]*)$/.exec(start.raw);
        if (!match || !Number.isSafeInteger(Number(match[1]))) return fail("Expected @@@ followed by a positive safe integer", start);
        block.line = Number(match[1]);
      } else if (start.raw.startsWith("@@^")) {
        if (!start.raw.startsWith("@@^ ") || start.raw.length === 4) return fail("Expected @@^ followed by one space and a nonempty literal prefix", start);
        block.prefix = start.raw.slice(4);
      } else if (start.right !== "@@") block.anchor = start.right.slice(3);
      position++;
    }
    let hasControl = false;
    while (position < body.length && !anchorOf(body[position])) {
      const token = body[position++];
      const control = controlOf(token, finalTerminator);
      if (control !== undefined) {
        if (!block.atEnd) fail("Final-terminator controls require an @@. chunk", token);
        finalTerminator = control;
        hasControl = true;
      } else {
        block.lines.push(editLine(token));
      }
    }
    if (!block.lines.length && !hasControl) fail("Update block is empty", start);
    blocks.push(block);
  }
  if (!blocks.length) fail("Update file has no edit blocks", record.header);
  return { kind: "update", path: record.path, ...(destination === undefined ? {} : { destination }), blocks,
    ...(finalTerminator === undefined ? {} : { finalTerminator }) };
}

/** Parse and validate the whole document without accessing the filesystem. */
export function parsePatch(input: string): FileEdit[] {
  return records(tokenize(input)).map(record => {
    if (record.kind === "update") return updateRecord(record);
    if (record.kind === "delete") {
      if (record.body.length) fail("Delete declarations do not accept a body", record.body[0]);
      return { kind: "delete", path: record.path };
    }
    let finalTerminator: FinalTerminator | undefined;
    const contents = record.body.map(token => {
      const control = controlOf(token, finalTerminator);
      if (control !== undefined) {
        finalTerminator = control;
        return "";
      }
      if (!token.raw.startsWith("+")) fail("Add file contents must start with +", token);
      return token.raw.slice(1) + "\n";
    }).join("");
    return { kind: "add", path: record.path, contents,
      ...(finalTerminator === undefined ? {} : { finalTerminator }) };
  });
}
