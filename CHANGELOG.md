# Changelog

## 0.2.0-beta.1 — unreleased

- Windows launcher, filesystem and named-pipe service support from the preceding implementation, now covered by release-candidate hardening.
- Trim records original destinations and file inventory in a restore manifest. The new restore command previews changes and brings back only what trim removed, skill by skill: a skill changed since the trim is skipped and listed with every other one, never overwritten, and skills trim kept are left alone. Each archive is extracted once, so large restores take seconds rather than one tar run per file.
- Antigravity installation and diagnostics use the current global configuration location and preserve unrelated settings.
- Service health probes buffer fragmented reply lines before validating them.
- Hint precision: the prompt check shows a skill only on meaning alone (cosine 0.5), or on meaning plus matched words that are rare in the library; prompts that point back at the conversation ("what's next", "do suggestion 2") need unmistakable meaning; at most three hints; a skill the host keeps accepting (three turns, at least half the time) passes on a lower bar, the mirror of suppression. On 57 real prompts, hints fell from 48 prompts to 13 and hints on prompts needing none from 29 to 7; the bundled fixture keeps its recall and precision.
- Trim and restore run tar from the backup folder with relative paths: Windows's tar.exe reads its arguments through the ANSI code page, so a home folder with a non-ASCII name broke every backup.
- The embedding package is imported by its real path. On Node 26 the warm service imported it under its pnpm link path, could not find `onnxruntime-common`, and silently fell back to BM25 for every hint. `doctor` and `report` now show how many prompt checks ran with the semantic layer on, and the last error.
- Claude plugin runtime dependencies are pinned in a supported npm shrinkwrap; development continues to use pnpm.
- Package, plugin, marketplace and MCP versions agree. npm archives include the evaluation fixture and omit compiled tests.
- Prerelease setup instructions use a stable source checkout. Clean source-plugin and npm-artifact smoke tests exercise MCP search/read, evaluation and six host configurations in disposable homes.
- CI includes Node 20 and 22 on Windows, macOS and Linux. Candidate CI execution and native desktop acceptance must be reported separately.

## 0.1.0

Initial development version: shared MCP skill discovery, core/library management, prompt hints, usage reporting, host adapters and a warm local service. Not published to npm.
