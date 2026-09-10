# Changelog

## [0.2.1] - 2026-09-10

- Clarify that success means the final filesystem state has already been verified, without implying the patch fulfills the caller's intent.

## [0.2.0] - 2026-09-10

- Verify final file bytes and path presence or absence after every patch, with explicit execution and verification failure reports.
- Add exact `@@^ prefix` anchors for locating lines without repeating their full text.
- Clarify patch syntax, file operations and anchor terminology in the tool description and documentation.

## [0.1.0] - 2026-09-09

- Initial release.

[0.2.1]: https://github.com/lastguru-net/openclaw-better-patch/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lastguru-net/openclaw-better-patch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lastguru-net/openclaw-better-patch/releases/tag/v0.1.0
