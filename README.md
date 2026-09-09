# OpenClaw Better Patch

`@lastguru-net/openclaw-better-patch` provides the `better_patch` file-editing tool
for OpenClaw. It is based on OpenAI Codex's `apply_patch` implementation.
The project is under development and has not been released.

Works with stable **OpenClaw 2026.9.2** and its built-in harness. No Codex binary,
Codex service, model-provider dependency, or shell command is used to edit files.
The package contains compiled JavaScript and has no runtime dependency other than
its OpenClaw host. Older OpenClaw releases are not supported.

## Install from this repository

The package is not published to npm. With Node.js 22.22.3+ and npm installed:

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
- Delete a file or empty directory with `*** Delete File: path`. Missing paths
  succeed; non-empty directories are not removed.
- Update with `*** Update File: path`, optionally followed by `*** Move to: path`.
- Prefix update lines with a space for context, `-` for removal, or `+` for addition.
- Separate chunks with `@@`; use `@@ context text` to locate a later section.
  An insertion-only chunk with a textual anchor inserts immediately after that
  matched source line. Without a textual anchor, insertion-only chunks append at
  the file ending (before an existing trailing blank line).
- Use `*** End of File` after a chunk to match the file's ending without moving
  backward over an earlier chunk. Overlapping chunk edits are rejected.

Success returns `Success. Updated the following files:` followed by `A`, `M`, and
`D` paths. Moves are reported as `M` with the destination path. Errors are surfaced
through OpenClaw's normal tool-error handling.

## Compatibility and boundaries

The reference is Codex **rust-v0.153.4**, commit
[`3d2ee51`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch).
The patch language and compatibility scenarios use this reference. The TypeScript
parser tokenizes file records into ordered keep/insert/remove operations. The
engine ranks candidate matches, plans edits using source-line offsets and a piece
table, then renders with the line-ending rules below. Preflight and sequential
execution share this engine. There is no streaming execution or Codex-specific
approval/environment machinery.

Patch behavior:

- Match logical text independently of LF, CR, CRLF, or LFCR terminators.
  Match exact lines first, then tolerate trailing whitespace, surrounding
  whitespace, and common Unicode punctuation differences. At the first tolerance
  level with any matches, require exactly one candidate in the search region;
  multiple matches are an error, not permission to try a weaker tolerance.
  This applies to both `@@ context` anchors and complete old-line chunk patterns.
  Use more context, a unique anchor, or `*** End of File` to disambiguate.
- Adds and move destinations can overwrite existing files; missing parent
  directories are created.
- A move to the same resolved path is an ordinary update, not a deletion.
- Validate update contents and all operation paths, and reject paths shared by
  separate operations (including move destinations) before editing. Dependent
  operations on the same path must be submitted as separate patches. A later I/O
  failure can still leave earlier changes;
  patches are **not transactional** and no rollback is attempted.
- Update sources must be valid UTF-8. Adds may overwrite arbitrary bytes.
- Deletion does not read or decode contents, so binary files can be removed.
  Successful deletions, including missing-path no-ops, are reported with `D`.
- Context and untouched lines retain their source text and line endings, even
  with tolerant matching, except when a line becomes or ceases to be the last line.
- Added/replacement lines inherit the preceding output line's ending. At the start
  of the file, they use the original first line's ending. Appending after an
  unterminated line uses the nearest preceding ending. LF is the fallback when
  there is no ending to inherit.
- The new last line inherits the original last line's ending, including no ending.
  This also applies when deleting the last line exposes a context or untouched line.
  Explicit inserted empty lines are always retained, including at EOF. A final
  inserted empty line receives an inferred terminator when needed to represent it,
  overriding an absent original final newline. Ordinary nonempty replacements
  still preserve an absent final newline. Newly added files use LF.
- A leading UTF-8 BOM is file metadata, excluded from matching and preserved once
  at the start of updated or moved files. Inserting before the first line moves
  the BOM to the new beginning; deleting all text leaves a BOM-only file if one
  was present. Interior U+FEFF characters remain text. `Delete File` still removes
  the entire file, including its BOM.

OpenClaw-specific adaptation:

- Patch text is a JSON `input` string rather than a freeform tool argument.
- Relative paths use the agent workspace (the sandbox workspace in sandboxed runs), not the Gateway process directory.
  Absolute paths and paths outside it are allowed only when OpenClaw's effective
  filesystem policy does not require workspace-only access.
- Host workspace-only policy checks path spelling and resolved existing ancestors,
  including move destinations. Like ordinary path-based filesystem operations,
  these checks are not an OS sandbox against concurrent hostile filesystem changes.
- Sandboxed workspace-only calls require the allowed root to map to the sandbox's
  full workspace. Custom sandbox roots, including narrower subdirectories, reject
  before file access: the public bridge cannot enforce those boundaries at I/O.
  Workspace-only sandbox calls also reject custom binds, a separate agent-workspace
  mount, or resource mounts outside the allowed root, since aliases could enter
  another bridge-permitted mount. Unrestricted sandbox calls retain the bridge's
  own mount policy. Host calls continue to support narrower roots.
- Configured sandboxes use the public `resolveSandboxContext` SDK and its filesystem
  bridge, including the session's stored skill selections. The context is resolved
  lazily once per tool instance; reads, writes, and deletes use the bridge, not host
  filesystem calls. Read-only workspaces reject writes. Missing sandbox context
  is an error, never permission to fall back to host files.
- Remote-worker placements are distinct from configured sandboxes: OpenClaw injects
  their exact runtime-owned bridge separately and does not expose it to plugin tools.
  The plugin checks placement through `sessions.describe` when running in a Gateway
  and rejects non-local placements rather than reconstructing the wrong filesystem.
  Full replacement support for those placements still needs a host API that passes
  the active filesystem capability into plugin tools.
- Sessions without a known workspace do not receive the tool.
- Codex `*** Environment ID:` routing is rejected. Shell wrappers are not executed;
  only the upstream literal `<<EOF` patch wrapper tolerance is supported.
- OS error details use Node.js messages, not Rust's exact wording. Codex approval
  prompts, execution metadata, diffs for its UI, and filesystem change events are
  not reproduced.

## Host filesystem behavior

Host access uses OpenClaw's public `file-access-runtime` guarded root API.
Unrestricted Linux sessions use `/` as the root; workspace-only sessions use
OpenClaw's effective allowed root. Relative patch paths still use the agent
workspace. The root does not grant additional OS permissions.

- Host reads have **no plugin-imposed file-size cap** (`maxBytes: Infinity`
  disables the library's default cap). The engine still reads complete files
  into memory. Sandbox reads retain their backend's behavior.
- File content access is for regular files, not FIFOs, sockets, or unsafe
  device/process-descriptor paths. Deletion accepts files and empty directories
  without reading their contents.
- The library's portable destination checks can reject legal POSIX names such
  as a leading `C:name.txt`. This is not a general ban on colons in filenames.
- Host writes use atomic replacement for each file, not a transaction across
  the patch. Adds overwrite existing files. New files use the library's
  `0600` default; replacement normally preserves existing permission bits.
  Other metadata and inode identity are not preserved as with in-place writes.
- Symlink reads follow targets within the allowed root. Replacement of a file
  symlink replaces the link itself rather than editing its target; directory symlinks can be followed within the root. Files with
  multiple hardlinks are rejected by the library's default read/write guards.
  No custom link-handling workaround is applied.
- The library's default identity checks are enabled. A verification error after
  writing does not guarantee that the replacement was rolled back.

## Development

```sh
npm ci
npm run check
```

Tests include adapted upstream filesystem scenarios plus matching, parser,
preflight, and OpenClaw adapter behavior. OpenClaw 2026.9.2 is pinned as a development
dependency for SDK type checking; it is not bundled into the plugin.
`@openclaw/fs-safe` 0.8.1 is a development-only type dependency because OpenClaw
2026.9.2 exports `file-access-runtime` without declarations. Runtime imports
still go through OpenClaw, not directly through that dependency.

`src/filesystem.ts` defines the shared `PatchFileSystem` connector, implemented
by `src/host.ts` and `src/sandbox.ts`. The patch engine receives that connector
explicitly and performs no direct host I/O or sandbox resolution.

### Docker integration test

With Docker access and `python:3.12-slim` available locally:

```sh
node --import tsx --test test/sandbox.integration.ts
```

With rootful Docker, run the test with sufficient privileges (for example,
`sudo node --import tsx --test test/sandbox.integration.ts`) to clean up
root-owned files created by sandbox provisioning.

This opt-in test uses temporary OpenClaw state and disposable Docker containers;
no Gateway is started. It verifies existing-container reuse, add/update/move/delete,
source-context and EOF preservation, binary-file and empty-directory deletion,
missing-path no-ops, non-empty-directory
rejection, path and symlink boundaries, isolated host-file preservation, and
read-only policy.
The normal test suite does not require Docker. Other configured sandbox backends
use the same bridge interface but have not been integration-tested here.

## License

Original plugin code and project contributions are licensed under
[MIT](LICENSE). The retained OpenAI scenario fixtures are separately licensed
under [Apache-2.0](LICENSES/Apache-2.0.txt), with attribution in
[test/fixtures/NOTICE](test/fixtures/NOTICE).

[NOTICE](NOTICE) preserves project provenance and applicable upstream notices.
MIT does not relicense third-party material or remove any remaining Apache-2.0
obligations. The package includes both license texts and NOTICE; fixture data
is not included in the package.
