# OpenClaw Better Patch

Better Patch is an alternative to `apply_patch` for OpenClaw agents. It edits
multiple files in one patch, rejects ambiguous edits instead of guessing, and
preserves existing formatting. It checks the complete patch before writing,
including edits that depend on earlier operations. Requires OpenClaw 2026.9.2+.

## Installation

Build and install from source with Node.js 22.22.3+:

```sh
git clone https://github.com/lastguru-net/openclaw-better-patch.git
cd openclaw-better-patch
npm ci
npm pack
openclaw plugins install ./lastguru-net-openclaw-better-patch-0.2.1.tgz
```

If you use a plugin allowlist, add `better-patch` to `plugins.allow`. Allow
`better_patch` in your agent's tool policy and start a new session after activation.
The plugin does not disable `apply_patch`; agent instructions can prefer `better_patch`.

## Usage

Call `better_patch` with an `input` string containing file operations. Each operation
runs from its file declaration to the next declaration or the end of the input:

```json
{"input":"*** Add File: hello.txt\n+Hello, world!"}
```

A patch can add, update, move or delete multiple files:

```diff
*** Update File: hello.txt
*** Move to: greetings/hello.txt
@@
-Hello, world!
+Hello, OpenClaw!
*** Delete File: obsolete.txt
```

- Use `*** Add File: path` with `+`-prefixed lines to create or overwrite a file.
- Use `*** Update File: path` for an existing UTF-8 file, optionally followed by
  `*** Move to: path`. Move destinations can also be overwritten.
- Within update chunks, prefix context with ` `, removals with `-`, additions
  with `+`. Separate chunks with `@@`, allowing any number of source lines to be
  skipped before matching context and removals. `@@ anchor` locates a whole anchor line.
- Use `@@^ prefix` to locate a line by its exact literal beginning. One ASCII space
  separates `@@^` from a nonempty prefix; any further spaces, tabs and trailing
  whitespace belong to the prefix. Case and punctuation must match exactly.
  The prefix must match exactly one line from the current source cursor to EOF.
  Like `@@ anchor`, it leaves the cursor after that line: insertions go there,
  and context/removals search from there. The anchor line itself is unchanged.
- Use `@@@ N` instead of `@@` to start a chunk at an exact 1-based line number.
  Context and removed text must match exactly there, without whitespace or
  punctuation tolerance. Numbers refer to the source at the start of that update;
  earlier chunks do not shift them. Insertion-only chunks insert before N;
  line count + 1 appends.
- Without line numbers, context must match uniquely. Add more context or use
  `@@.` to match the final source lines. Additions-only `@@.` chunks append after
  every existing line, including trailing empty lines. Bare `@@` additions-only
  chunks instead insert before an existing final empty line.
- `*** Delete File: path` removes a file or empty directory. Missing paths succeed;
  nonempty directories are rejected.

Body-line whitespace is literal, including on the final input line. A final
transport newline ends that patch line; it does not add an empty context line.

Relative paths start at the agent workspace, not the shell's current directory.
Absolute paths remain subject to OpenClaw's filesystem policy.

For example, insert a note after a long paragraph without repeating the paragraph:

```diff
*** Update File: notes.md
@@^ My recommendation is
+Follow-up note.
```

This matches a unique line beginning `My recommendation is`, preserving the whole
line and inserting the note after it. Prefix anchors do not enable substring
edits: context and removed text still require complete source lines. Missing or
ambiguous prefixes fail preflight before any writes, even if later context could
distinguish the candidates.

### EOF edits and final terminators

An `@@.` chunk matches its context and removed lines against the file suffix,
ignoring their LF, CRLF, CR or LFCR terminators. It never searches earlier or
drops unmatched empty context. Additions retain their written position:

```diff
*** Update File: notes.md
@@.
+Inserted before the final line.
 Last line.
```

Inside Add File bodies or `@@.` update chunks, use exact standalone `.-` or `.+`
directives:

- `.-` removes all trailing newline sequences, including trailing empty lines,
  but never spaces, tabs or the BOM.
- `.+` ensures a final terminator. An already terminated tail is unchanged,
  including its type and any empty lines. Otherwise it uses the inherited ending
  type, or LF when none is available. Empty/BOM-only output receives LF.

Directives apply after all content in that Add File or Update File operation,
including when moving a file. They do not match source lines or move the source cursor.
Repeated identical directives are harmless; opposing directives in one operation
fail preflight. Separate operations run in written order.

A directive needs no dummy content edit. For example, create an unterminated file:

```diff
*** Add File: hello.txt
+hello
.-
```

The result contains `hello` without a final terminator. To edit text that itself
looks like a directive, use the usual prefixes, such as `+.-` or ` .+`.
Add File uses LF before applying its control. A body containing only `.-` creates
an empty file; only `.+` creates one LF. Controls may appear before or after content.

The optional literal wrapper opens with `<<EOF`, `<<'EOF'` or `<<"EOF"` and closes
with an exact `EOF` line. Surrounding whitespace outside the complete wrapper is
ignored; extra text or remaining indentation on its closing line is rejected.
This is literal parsing, not shell execution.

## Behavior

Operations run in written order, so an update can follow an add in the same patch.
Preflight validates the patch before writing. Every successful result also verifies
final file bytes and expected path presence/absence, including unchanged paths.
This checks filesystem state at readback, not edit intent or application tests.
Execution is not transactional: I/O failures can leave partial changes, and
readback does not guarantee crash durability or prevent subsequent changes.
Failures distinguish rejection before execution, incomplete execution, and
final-verification mismatches or unavailable readback. Changes are not rolled back.

Ordinary context matching tolerates whitespace and common Unicode punctuation
differences; numbered chunks and prefix anchors use exact matching.
Unchanged text, line endings and a leading UTF-8 BOM are preserved. Inserted lines
inherit the preceding output ending, or the first source ending when inserting at
the beginning, with LF fallback. Empty and BOM-only files use LF for every added
line. Otherwise the final output item inherits the original final terminator,
including its absence, unless a final-terminator directive overrides it.

Empty added text follows the same rendering rule as other text: appending `a` to
`"last"` yields `"last\na"`, and appending empty text yields `"last\n"`, not two
newlines. The empty final item has no bytes or terminator of its own. A later
operation parses the resulting bytes normally; it does not see a synthetic empty
line after a terminator. For example, `"last\n"` has one terminated line, whereas
`"last\n\n"` also contains a terminated empty line.

Unchanged operations skip writes. Results report each named path's net change:
`A` added, `M` modified, `D` deleted, `N` unchanged.

Host and configured sandbox access respect OpenClaw's filesystem policy. Remote
workers and workspace-only sandboxes with narrower roots or extra mount layouts
are unsupported. Host writes replace leaf symlinks rather than their targets;
files with multiple hardlinks are rejected by the host guards.

## License

[MIT](LICENSE). Copied test fixtures are [Apache-2.0](LICENSES/Apache-2.0.txt);
see [NOTICE](NOTICE) for attribution.
