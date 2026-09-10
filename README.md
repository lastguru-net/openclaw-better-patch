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
openclaw plugins install ./lastguru-net-openclaw-better-patch-0.1.0.tgz
```

If you use a plugin allowlist, add `better-patch` to `plugins.allow`. Allow
`better_patch` in your agent's tool policy and start a new session after activation.
The plugin does not disable `apply_patch`; agent instructions can prefer `better_patch`.

## Usage

Call `better_patch` with an `input` string containing the patch:

```json
{"input":"*** Begin Patch\n*** Add File: hello.txt\n+Hello, world!\n*** End Patch"}
```

A patch can add, update, move or delete multiple files:

```diff
*** Begin Patch
*** Update File: hello.txt
*** Move to: greetings/hello.txt
@@
-Hello, world!
+Hello, OpenClaw!
*** Delete File: obsolete.txt
*** End Patch
```

- Use `*** Add File: path` with `+`-prefixed lines to create or overwrite a file.
- Use `*** Update File: path` for an existing UTF-8 file, optionally followed by
  `*** Move to: path`. Move destinations can also be overwritten.
- Within update chunks, prefix context with a space, removals with `-`, additions
  with `+`. Separate chunks with `@@`; `@@ context text` locates a section.
- Use `@@@ N` instead of `@@` to start a chunk at an exact 1-based line number.
  Context and removed text must match exactly there, without whitespace or
  punctuation tolerance. Numbers refer to the source at the start of that update;
  earlier chunks do not shift them. Insertion-only chunks insert before N;
  line count + 1 appends. An EOF marker additionally requires the chunk to end at EOF.
- Without line numbers, context must match uniquely. Add more context or use
  `*** End of File` after a chunk to select the file ending.
- `*** Delete File: path` removes a file or empty directory. Missing paths succeed;
  nonempty directories are rejected.

Relative paths start at the agent workspace, not the shell's current directory.
Absolute paths remain subject to OpenClaw's filesystem policy.

### Returned contents

Set `returnContents` to a positive integer byte budget alongside `input` to
include verified final text, for example `returnContents: 100000`. Omit it or
use `0` to return no contents. Negative, fractional, non-finite and unsafe
integer values are rejected before execution. Mandatory verification is
unaffected, and no extra filesystem reads are needed.

The response includes a JSON object in the model-facing text and in
`details.contents`. Its `files` array covers every explicitly named path once,
in first-mentioned order, with its net `status` (`A`, `M`, `D` or `N`).
Final files, including unchanged files, have complete `content` and UTF-8
`byteLength`. BOM and line endings are preserved. Deleted or still-missing
paths have `omitted: "absent"`; recreated directories have `omitted: "directory"`.

Complete files share the requested UTF-8 content-byte budget, reported as
`byteLimit`; JSON formatting and path/status metadata are separate.
Files that do not fit the remaining budget have `omitted: "size-limit"` and
their full `byteLength`, never partial text.
An omitted file does not consume the budget, so later smaller files can fit.
Execution or verification failures return no contents and retain their failure
details; this option does not expose unverified text.

## Behavior

Operations run in written order, so an update can follow an add in the same patch.
Preflight validates the patch before writing. Every successful result also verifies
final file bytes and expected path presence/absence, including unchanged paths.
This checks filesystem state at readback, not edit intent or application tests.
Execution is not transactional: I/O failures can leave partial changes, and
readback does not guarantee crash durability or prevent subsequent changes.
Failures distinguish rejection before execution, incomplete execution, and
final-verification mismatches or unavailable readback. Changes are not rolled back.

Matching tolerates whitespace and common Unicode punctuation differences.
Unchanged text, line endings and a leading UTF-8 BOM are preserved. Inserted lines
inherit surrounding line endings; new files use LF. The original final-newline
state is retained except where explicitly added blank lines require a newline.

Unchanged operations skip writes. Results report each named path's net change:
`A` added, `M` modified, `D` deleted, `N` unchanged.

Host and configured sandbox access respect OpenClaw's filesystem policy. Remote
workers and workspace-only sandboxes with narrower roots or extra mount layouts
are unsupported. Host writes replace leaf symlinks rather than their targets;
files with multiple hardlinks are rejected by the host guards.

## License

[MIT](LICENSE). Copied test fixtures are [Apache-2.0](LICENSES/Apache-2.0.txt);
see [NOTICE](NOTICE) for attribution.
