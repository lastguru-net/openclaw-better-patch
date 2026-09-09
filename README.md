# OpenClaw Better Patch

`@lastguru-net/openclaw-better-patch` provides the `better_patch` file-editing tool
for OpenClaw, with dependency-aware validation and source-preserving edits.
It requires **OpenClaw 2026.9.2+** and has no runtime dependency other than its
OpenClaw host. SDK integration is tested against 2026.9.2. No Codex binary, service, or caller-supplied shell patch command
is required.

## Install from this repository

With Node.js 22.22.3+ and npm installed:

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
agent's tool policy. Installation does not override tool deny rules. Start a new
session after activation. The plugin does not disable or replace an existing
`apply_patch` tool; agent instructions can prefer `better_patch`.

## Syntax and results

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

Results summarize each explicitly named path once, comparing initial and final
state: `A` added, `M` modified, `D` deleted, and `N` unchanged. Add then update
reports only `A`; Add overwriting an existing file reports `M`. Moves report source
and destination changes. An all-unchanged result says `No changes made.`; otherwise
it starts with `Success. Updated the following files:`. Structured results include
`added`, `modified`, `deleted`, and `unchanged` arrays. Net unchanged does not mean
no intermediate writes occurred when separate operations cancel each other.
Errors are surfaced through OpenClaw's normal tool-error handling.

## Execution

Operations run in written order. Adds and move destinations can overwrite existing
files and create missing parent directories. Updates require existing UTF-8 files;
Adds may overwrite arbitrary bytes. Deletion does not read file contents, so binary
files can be removed. A move to the same resolved path is an ordinary update.

Preflight simulates preceding operations, so updates can depend on earlier adds,
edits, moves and deletions. Invalid dependent matches reject before writes.
Execution re-reads current source bytes. Preflight tracks normalized paths, not
filesystem alias identities, and does not prove permissions or prevent concurrent
changes. Actual adapter checks remain authoritative. I/O failures can leave partial
changes; no rollback is attempted. Whole-patch atomicity is tracked in
[issue #2](https://github.com/lastguru-net/openclaw-better-patch/issues/2).

Byte-identical updates (including same-path moves), identical Adds to regular files,
and missing Deletes skip mutation calls. Equality includes whitespace, BOM and
line-ending bytes. Moving to a different path still executes.

## Matching and text preservation

Matching ignores LF, CR, CRLF and LFCR terminators. Both textual anchors and complete
old-line chunk patterns require exactly one match at the first tolerance level
with candidates: exact text, trailing whitespace, surrounding whitespace, then
common Unicode punctuation. Multiple candidates at that level reject; use more
context, a unique anchor or EOF anchoring to disambiguate.

- Context and untouched lines retain their source text and endings, even with
  tolerant matching, except when a line becomes or ceases to be the last line.
- Added/replacement lines inherit the preceding output line's ending. At the start,
  they use the original first line's ending. After an unterminated line, they use
  the nearest preceding ending. LF is the fallback when none exists.
- The new last line inherits the original last line's ending, including no ending.
  This also applies when deletion exposes a context or untouched line at EOF.
  Explicit inserted empty lines always survive; a final inserted empty line gets
  an inferred terminator if needed to represent it, overriding an absent final
  newline. Ordinary nonempty replacements preserve the original EOF state.
  Newly added files use LF.
- A leading UTF-8 BOM is metadata, excluded from matching and preserved once at
  the start of updated or moved files. Inserting before the first line keeps the
  BOM ahead of the new text; deleting all text leaves a BOM-only file. Interior
  U+FEFF characters remain content. Delete File removes the entire file.

## Filesystem boundaries

Relative paths use the agent workspace, or the sandbox workspace in sandboxed runs.
Absolute paths are subject to the same effective filesystem policy. Sessions without
an identified workspace do not receive the tool.

### Host

Host access uses OpenClaw's guarded root API. Unrestricted Linux sessions use `/`;
workspace-only sessions use the effective allowed root, including narrower roots.
Checks cover resolved ancestors and move destinations, but are not an OS sandbox
against concurrent hostile filesystem changes. They grant no additional OS permissions.

- Reads have no plugin-imposed size cap. The engine processes complete files in memory.
- Content access requires regular files, excluding FIFOs, sockets and unsafe
  device/process-descriptor paths.
- Portable destination checks can reject legal POSIX names such as a leading
  `C:name.txt`; colons are not generally banned.
- Writes use atomic per-file replacement. New files use the library's `0600`
  default; replacement normally preserves permission bits, not other metadata or
  inode identity. A post-write identity-check error does not imply rollback.
- Symlink reads follow targets within the allowed root. Writing replaces a leaf
  file symlink rather than its target; directory symlinks may be followed within
  the root. Default guards reject files with multiple hardlinks.

### Sandbox

Configured sandboxes use their filesystem bridge, never a host-file fallback.
Read-only workspaces reject writes; backend read limits still apply.

Workspace-only access requires the allowed root to map to the full sandbox workspace.
Narrower or different roots, custom binds, separate agent-workspace mounts and resource
mounts outside the root reject before I/O: the public bridge cannot enforce these
restrictions against aliases across its permitted mounts. Unrestricted sandbox calls
retain the bridge's own mount policy.

The bridge has no directory-listing API, and some nonregular entries cannot be typed
by its stat operation. Preflight therefore leaves unobserved directory contents and
unknown entry types to actual I/O checks. Nonrecursive removal rejects nonempty
directories. Remote-worker placements are unsupported because the plugin cannot
obtain their runtime-owned filesystem capability.

## Development

```sh
npm ci
npm run check
```

Tests cover patch syntax, text preservation, ordered dependencies, results and adapter
boundaries. Compatibility fixtures reference Codex **rust-v0.153.4**, commit
[`3d2ee51`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch).
The tool accepts a JSON `input` string, not a freeform argument. Environment ID routing
is rejected. Literal EOF wrappers are tolerated but never executed. Codex-specific
approval, UI diffs, execution metadata and filesystem events are not reproduced;
errors use Node.js messages.

The parser emits ordered keep/insert/remove blocks. The engine ranks matches, builds
non-overlapping source-coordinate changes and renders source ranges plus inserted
text. Preflight and execution share the engine through `PatchFileSystem`, implemented
by the separate host and sandbox adapters.

OpenClaw 2026.9.2 is pinned for SDK verification, not bundled. The development-only
`@openclaw/fs-safe` 0.8.1 dependency supplies declarations missing from that SDK's
`file-access-runtime` export; runtime imports still go through OpenClaw. Host metadata
uses guarded parent resolution and leaf-only lstat, preserving dangling-link existence
without sibling-listing races. Sandbox resolution is lazy per tool instance, uses
`resolveSandboxContext` and stored skill selections, and checks Gateway placement
through `sessions.describe` before provisioning.

### Docker integration

With Docker access and `python:3.12-slim` available locally:

```sh
node --import tsx --test test/sandbox.integration.ts
```

Rootful Docker needs sufficient cleanup privileges, for example
`sudo node --import tsx --test test/sandbox.integration.ts`.
The test shares disposable containers across named phases and uses temporary OpenClaw
state; no Gateway is started. It checks bridge operations, dependencies, no-ops,
representative text preservation, path/mount boundaries, host isolation and read-only
policy. Regular tests do not need Docker. Other sandbox backends share the bridge
interface but are not integration-tested here.

## License

Original plugin code and project contributions use [MIT](LICENSE). OpenAI scenario
fixtures use [Apache-2.0](LICENSES/Apache-2.0.txt), with attribution in
[test/fixtures/NOTICE](test/fixtures/NOTICE). [NOTICE](NOTICE) preserves
upstream attribution. MIT does not relicense third-party material. Both license
texts and NOTICE are packaged; fixture data is excluded.
