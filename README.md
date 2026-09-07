# OpenClaw Better Patch

`@lastguru-net/openclaw-better-patch` provides the `better_patch` file-editing tool
for OpenClaw. Version **0.1.0** is a compatibility baseline based on OpenAI
Codex's `apply_patch` implementation, not yet a redesigned patch format.

Works with stable **OpenClaw 2026.9.2** and its built-in harness. No Codex binary,
Codex service, model-provider dependency, or shell command is used to edit files.
The package contains compiled JavaScript and has no runtime dependency other than
its OpenClaw host. Older OpenClaw releases are not supported.

## Install from this repository

This initial version is not published to npm. With Node.js 22.22.3+ and npm installed:

```sh
git clone https://github.com/lastguru-net/openclaw-better-patch.git
cd openclaw-better-patch
npm ci
npm run check
npm pack
openclaw plugins install ./lastguru-net-openclaw-better-patch-0.1.0.tgz
```

The plugin ID is `better-patch`; the tool name is `better_patch`. Allow the plugin
in `plugins.allow` if you use a plugin allowlist, and allow `better_patch` in your
agent's tool policy. Plugin installation alone does not override a tool deny rule.
Start a new session after activating the plugin. This plugin does not disable or
replace an existing `apply_patch` tool; agent instructions can prefer `better_patch`.

## Use

The tool takes one JSON field, `input`, containing the complete patch:

```json
{
  "input": "*** Begin Patch\n*** Add File: hello.txt\n+Hello, world!\n*** End Patch"
}
```

Patch syntax supports multiple files, adds, deletes, updates, and moves:

```diff
*** Begin Patch
*** Update File: hello.txt
*** Move to: greetings/hello.txt
@@
-Hello, world!
+Hello, OpenClaw!
*** End Patch
```

- Add files with `*** Add File: path` and `+`-prefixed lines.
- Delete with `*** Delete File: path`.
- Update with `*** Update File: path`, optionally followed by `*** Move to: path`.
- Prefix update lines with a space for context, `-` for removal, or `+` for addition.
- Separate chunks with `@@`; use `@@ context text` to locate a later section.
- Use `*** End of File` after a chunk to match the file's ending.

Success returns `Success. Updated the following files:` followed by `A`, `M`, and
`D` paths. Moves are reported as `M` with the destination path. Errors are surfaced
through OpenClaw's normal tool-error handling.

## Compatibility and boundaries

The reference is Codex **rust-v0.153.4**, commit
[`3d2ee51`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch).
The parser, matching order, default file-update algorithm, preflight validation,
and summary format are adapted into TypeScript. There is no streaming parser or
Codex-specific execution/approval/environment machinery.

Important inherited behavior:

- Match exact lines first, then tolerate trailing whitespace, surrounding
  whitespace, and common Unicode punctuation differences.
- Adds and move destinations can overwrite existing files; missing parent
  directories are created. Deletes require an existing file.
- Validate all update/delete sources and reject repeated source paths before
  editing. A later I/O failure can still leave earlier changes; patches are **not
  transactional** and no rollback is attempted.
- Files being read must be valid UTF-8. Adds may overwrite arbitrary bytes.
- Default Codex newline behavior is retained, including appending a trailing
  newline on updates and replacing matched context with patch text. Untouched
  CRLF lines can retain their CR while changed lines use LF. This is not a
  byte-preserving editor; the optional upstream line-ending preservation feature
  is intentionally not included in this baseline.

OpenClaw-specific adaptation:

- Patch text is a JSON `input` string rather than a freeform tool argument.
- Relative paths use the agent workspace, not the Gateway process directory.
  Absolute paths and paths outside it are allowed only when OpenClaw's effective
  filesystem policy does not require workspace-only access.
- Workspace-only policy checks both path spelling and resolved existing ancestors,
  including move destinations. Like ordinary path-based filesystem operations,
  these checks are not an OS sandbox against concurrent hostile filesystem changes.
- Sandboxed sessions do not receive this tool: OpenClaw's stable public plugin
  context does not expose a sandbox filesystem bridge. Sessions without a known
  workspace also do not receive it. Host files are never used as a sandbox fallback.
- Codex `*** Environment ID:` routing is rejected. Shell wrappers are not executed;
  only the upstream literal `<<EOF` patch wrapper tolerance is supported.
- OS error details use Node.js messages, not Rust's exact wording. Codex approval
  prompts, execution metadata, diffs for its UI, and filesystem change events are
  not reproduced.

## Development

```sh
npm ci
npm run check
```

Tests include adapted upstream filesystem scenarios plus matching, parser,
preflight, and OpenClaw adapter behavior. OpenClaw 2026.9.2 is pinned as a development
dependency for SDK type checking; it is not bundled into the plugin.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for upstream attribution
and the adaptation reference.
