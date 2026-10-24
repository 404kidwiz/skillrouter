# Contributing

Thanks for helping make task-driven skill discovery dependable across agents.

## Development setup

Use Node 22.13+ for pnpm 11 itself; the runtime also targets Node 20. CI installs dependencies on Node 22 before switching to the test matrix runtime.

```sh
pnpm install --frozen-lockfile
pnpm test
npm run smoke:release
```

`pnpm-lock.yaml` is the development lock. `npm-shrinkwrap.json` supports distribution installs. Dependency changes must keep both consistent; see [release preparation](docs/RELEASING.md).

## Make a focused change

Inspect existing repository instructions and working-tree changes first. Explain the problem, expected behavior and smallest complete correction. Preserve unrelated edits.

| Change | Appropriate verification |
| --- | --- |
| README, guides or artwork | Links, anchors, command accuracy, rendered layout and package asset inclusion |
| Routing or hint behavior | Focused regressions plus fixture evaluation |
| Host adapter | Disposable config tests preserving unrelated settings, then live MCP |
| Trim/restore | Real disposable round trips, collisions, links and partial failures |
| Distribution or transport | Clean artifact smoke and relevant native OS tests |

Do not use your real skill library for trim tests. Set both HOME and USERPROFILE when isolating test profiles, plus SKILLROUTER_HOME. Avoid secret-bearing fixtures or paid model calls for routine tests.

## Cross-platform expectations

Keep paths and child-process arguments portable. Test spaces/Unicode, Windows junctions and transport fragmentation where relevant. Prefer argument arrays over shell interpolation. Preserve host approval settings.

A platform-injected unit test is not native Windows execution. Record OS/runtime, command results, skips and remaining acceptance gaps honestly. See the [support recipe](docs/SUPPORT.md).

## Pull requests

Describe the concrete problem and resulting behavior, affected hosts, verification performed and material limits. Include a regression for a meaningful bug. Rebuild committed `dist` after TypeScript changes; do not commit installed dependencies or user state.

For documentation or artwork, retain source/provenance, meaningful alt text and useful mobile rendering. Avoid unsupported performance claims and automatic animation that carries essential information without a readable alternative.

## Skills, privacy and licensing

The router's MIT license does not license third-party libraries. Keep private paths, indexes, credentials, transcripts and logs out of patches. Use synthetic examples.

## Releases

Publishing, pushing tags and changing production settings require maintainer authorization. Follow [RELEASING.md](docs/RELEASING.md); a local green test suite is not evidence of registry publication or universal compatibility.

