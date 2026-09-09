# OpenClaw Better Patch

File patching for OpenClaw with dependency-aware validation and source-preserving
edits. Provides the `better_patch` tool. Requires OpenClaw 2026.9.2+.

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
- Context must match uniquely. Add more context or use `*** End of File` after a
  chunk to select the file ending.
- `*** Delete File: path` removes a file or empty directory. Missing paths succeed;
  nonempty directories are rejected.

Relative paths start at the agent workspace, not the shell's current directory.
Absolute paths remain subject to OpenClaw's filesystem policy.

## Behavior

Operations run in written order, so an update can follow an add in the same patch.
Preflight validates the patch before writing. Execution is not transactional:
I/O failures can leave partial changes.

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
