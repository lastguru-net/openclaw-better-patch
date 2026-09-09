// Project parser redesign retaining the patch-language compatibility contract.
// The project originated as a Codex adaptation; see NOTICE for provenance.
export type EditLine = { kind: "keep" | "insert" | "remove"; text: string };
export type EditBlock = { anchor?: string; atEnd: boolean; lines: EditLine[] };
export type FileEdit =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; destination?: string; blocks: EditBlock[] };

type Token = { raw: string; right: string; stripped: string; number: number };
type FileRecord = { kind: FileEdit["kind"]; path: string; header: Token; body: Token[] };
const fail = (reason: string, token?: Token): never => {
  throw new Error(`Invalid patch${token ? ` at line ${token.number}` : ""}: ${reason}`);
};
const strip = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const finish = "*** End Patch";

function tokenize(input: string): Token[] {
  const rows = strip(input).split(/\r\n|\n\r|\r|\n/);
  const wrapped = rows.length >= 4 && /^<<(?:EOF|'EOF'|"EOF")$/.test(rows[0]) && rows.at(-1)!.endsWith("EOF");
  const payload = wrapped ? rows.slice(1, -1) : rows;
  const tokens = payload.map((raw, index) => ({
    raw, right: raw.replace(/\p{White_Space}+$/u, ""), stripped: strip(raw), number: index + 1,
  }));
  if (tokens[0].stripped !== "*** Begin Patch") fail("Missing Begin Patch marker");
  if (tokens.at(-1)!.stripped !== finish) fail("Missing End Patch marker");
  return tokens.slice(1);
}

/** Separate file records before interpreting their individual bodies. */
function records(tokens: Token[]): FileRecord[] {
  const result: FileRecord[] = [];
  let active: FileRecord | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // In update bodies, leading whitespace belongs to context, including text
    // that resembles a header. The final envelope marker is an exception.
    const header = active?.kind === "update" && index !== tokens.length - 1 ? token.right : token.stripped;
    if (header === finish) {
      if (tokens.slice(index + 1).some(item => item.stripped !== "")) fail("Content after End Patch marker", token);
      return result;
    }
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

const anchorOf = (token: Token): boolean => token.right === "@@" || token.right.startsWith("@@ ");
const eofOf = (token: Token): boolean => token.right === "*** End of File";

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
  let position = 0;
  // EOF markers without a block carry no content. A destination declaration
  // may occur once, anywhere in this otherwise-empty update preamble.
  while (position < body.length) {
    const token = body[position];
    if (eofOf(token)) { position++; continue; }
    if (destination === undefined && token.right.startsWith("*** Move to: ")) {
      destination = token.right.slice("*** Move to: ".length);
      position++;
      continue;
    }
    break;
  }
  while (position < body.length) {
    const start = body[position];
    const block: EditBlock = { atEnd: false, lines: [] };
    if (anchorOf(start)) {
      if (start.right !== "@@") block.anchor = start.right.slice(3);
      position++;
    } else if (blocks.length) {
      fail("Expected an @@ marker after an EOF block", start);
    }
    while (position < body.length && !anchorOf(body[position]) && !eofOf(body[position])) {
      block.lines.push(editLine(body[position++]));
    }
    if (!block.lines.length) fail("Update block is empty", start);
    if (position < body.length && eofOf(body[position])) {
      block.atEnd = true;
      position++;
      while (position < body.length && body[position].right === "") position++;
    }
    blocks.push(block);
  }
  if (!blocks.length) fail("Update file has no edit blocks", record.header);
  return { kind: "update", path: record.path, ...(destination === undefined ? {} : { destination }), blocks };
}

/** Parse and validate the whole document without accessing the filesystem. */
export function parsePatch(input: string): FileEdit[] {
  return records(tokenize(input)).map(record => {
    if (record.kind === "update") return updateRecord(record);
    if (record.kind === "delete") {
      if (record.body.length) fail("Delete declarations do not accept a body", record.body[0]);
      return { kind: "delete", path: record.path };
    }
    const contents = record.body.map(token => {
      if (!token.raw.startsWith("+")) fail("Add file contents must start with +", token);
      return token.raw.slice(1) + "\n";
    }).join("");
    return { kind: "add", path: record.path, contents };
  });
}
