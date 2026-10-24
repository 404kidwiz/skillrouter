# Release validation

The current candidate is **0.2.0-beta.1**. It has not been published to npm. Publishing, pushing, or tagging is a separate owner-authorized action.

## Prepare a candidate

1. Update `package.json`, `.claude-plugin/plugin.json`, and the plugin entry in `.claude-plugin/marketplace.json` to the same new version. Claude plugin caches use this version, so a changed release must not reuse it.
2. Synchronize `npm-shrinkwrap.json` with the package metadata and dependencies using npm's lock-only workflow. Prefer generating in an isolated directory containing the new package manifest and current shrinkwrap; copy the result back. Keep `pnpm-lock.yaml` as the development lockfile. Runtime dependency changes require updating and testing both locks.
3. Run `pnpm install --frozen-lockfile`, `pnpm test`, and `npm run smoke:release`. The smoke command builds, checks version/lock consistency, packs the npm artifact, installs it with real runtime dependencies, and tests the clean source-plugin copy too. No global installation is needed.
4. Run the full CI matrix for the exact candidate: Windows, macOS and Linux on Node 20 and 22. Record the commit and job URLs. Inspect any skips; mock Windows tests on macOS do not replace Windows execution.
5. Perform the supported host acceptance in [SUPPORT.md](SUPPORT.md), record unresolved limits, then obtain publication authorization. A local pass is not a registry release or marketplace-install acceptance.

## Required smoke behavior

Both distribution forms must initialize MCP, advertise exactly `search_skills` and `read_skill`, return a known synthetic search result, load its expected text, report the candidate version, and pass the bundled routing evaluation. The test also installs and probes Claude, Codex, Cursor, Gemini, OpenCode and Antigravity configuration in separate temporary homes, then verifies trim and restore previews do not mutate files and applied recovery reproduces exact bytes. All temporary state is synthetic; no real user files or host settings are used.

The plugin test models the documented production dependency-install contract using `npm ci --omit=dev --omit=optional --ignore-scripts`. It does not claim to be an interactive Claude marketplace install. Test one such install before declaring that host accepted for a release. Optional semantic-model downloads are deliberately excluded from clean-install tests.

## Distribution boundaries

Ship built runtime files, the routing skill, hooks, plugin metadata, lockfile, docs, license, and evaluation fixtures. Do not ship personal indexes, usage logs, transcripts, restore manifests, private verification evidence, installed dependencies, or compiled tests. Smoke tests inspect the actual archive contents.

The npm package declares its dependencies; `npm-shrinkwrap.json` additionally makes clean plugin dependency installation reproducible. The router's license does not grant rights to redistribute arbitrary third-party skill libraries.

## Recovery

Test trim and restore on disposable skills before releases. Restoration must use the recorded original folders, restore only what trim removed, leave identical and kept files alone, skip and list skills changed since the trim instead of overwriting them, and never ask a user to remove an agent folder. Preserve archives and manifests on failure. For old tar-only backups, inspect archive contents and determine the original agent folder manually; the old generated extraction destination was incorrect.
