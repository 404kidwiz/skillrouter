# Troubleshooting and FAQ

[Back to README](../README.md) · [Installation](INSTALL.md) · [Reference](REFERENCE.md)

Start from the installation directory:

```sh
node dist/src/cli.js doctor
node dist/src/cli.js doctor --live claude
```

Replace `claude` with the affected target. Inspect printed results; a successful process exit does not mean every host connected.

## Installation and connection

| Symptom | Check | Next action |
| --- | --- | --- |
| `npx skillrouter` fails | Candidate is unpublished | Use the documented checkout route |
| `npm ci` reports no lockfile | Wrong or incomplete revision | Check version and obtain matching release files; do not invent a lockfile |
| Missing MCP SDK module | Dependencies were not installed in this copy | Run the documented `npm ci --omit=dev --omit=optional --ignore-scripts` in that checkout |
| Terminal works, GUI host fails | Different PATH/environment or moved checkout | Make Node discoverable to the host, rerun selected adapter install and reload |
| Tools absent after config change | Existing session has an old tool inventory | Reload/restart and approve normal trust prompts |

Plugin cache and source checkout are separate installations. Dependencies installed in one do not fix the other. Check the exact command/path the host launches.

For version-sensitive host behavior, consult the installed host's official documentation. Do not disable approval controls to make a test pass.

## Tools connect but skills are not used

Check each layer separately:

1. **Discovery:** does shell search return the skill? If not, inspect its index root and description.
2. **Access:** can the host call `read_skill` and retrieve the actual body?
3. **Reminders:** are hooks active, or does an MCP-only host have a persistent routing instruction?
4. **Behavior:** does an ordinary relevant task cause a search/read in a fresh session?
5. **Application:** did the agent follow useful instructions from the skill? A read alone cannot answer that.

Antigravity, Hermes and OpenClaude get MCP configuration from the adapter, not prompt hooks or an automatically written standing rule. See [persistent routing instructions](INSTALL.md#persistent-routing-instructions).

Cursor headless behavior differs from interactive behavior. Codex hooks can require trust. OpenCode has no final nudge. Do not test one mode and claim all modes work.

## Search and index problems

| Symptom | Likely cause | Next action |
| --- | --- | --- |
| Empty index | No skills in the scanned roots | Add your library with `index --root "/path/to/skills"`; the repo's `./skills` is a starter root |
| Skill moved or removed | Stale index | Run `index` again |
| Similar names or ambiguity | Several matching IDs | Use the exact ID returned by search |
| Poor matches | Vague query or weak description | Use a short task intent and improve relevant skill metadata |
| A skill stopped appearing in hints | Declines caused suppression, or it was already loaded | Inspect `suppress` and session state; direct search still works |
| Hints are mostly off-topic, or `doctor` says most prompt checks fell back to BM25 | The semantic layer failed in the hook process (for example a Node version that imports the embedding package under its link path, so it cannot find its own dependencies) | Read the `Semantic layer in prompt checks` line in `doctor`; its last error names the cause. Since 0.2.0-beta.1 the package is imported by its real path |

The router does not ship a general-purpose library of thousands of skills. The large library described in project history belongs to the author's setup. The `eval/skills` directory is test data, not a recommended production skill pack.

Optional vectors can become stale after indexing. `doctor` identifies this. Rebuild embeddings intentionally, or continue with lexical search.

## Host-specific setup

Antigravity's current adapter writes `~/.gemini/config/mcp_config.json`. A legacy file alone is not enough for current-path diagnostics. Rerun the adapter to migrate only the router entry; unrelated legacy servers stay untouched.

Hermes may print that its config or Python environment was not found. Check the actual installation/profile. The adapter expects a known local layout and cannot configure arbitrary remote profiles. Do not report success merely because the CLI exited.

If a TOML configuration uses unsupported multiline values, the installer may refuse it. Inspect the file and make a narrow, backed-up correction using the host's supported schema. Do not replace the whole configuration.

Repeated hints can indicate duplicate plugin and standalone integration, especially in Claude Code. Inspect both sources and retain one intended route.

## Recovery problems

| Symptom | Meaning | Next action |
| --- | --- | --- |
| Restore lists skipped skills | Those skills changed since the trim (edited, re-added by `core sync`, replaced) | Their current version is kept and the rest is restored. To bring back a backup copy, move the current one aside and run restore again; do not delete the agent folder |
| Archive missing or changed | Checksum/file verification failed | Find the original matching archive; keep the manifest and archives together |
| Parent is not a real directory | A linked or invalid ancestor blocks safe recovery | Inspect the layout; do not force writes through it |
| Legacy backup has no JSON manifest | It predates structured restore | Inspect its tar contents and recover to the original agent location manually |
| Trim failed after some moves | A later source or destination failed | Preserve all files and preview the generated manifest before applying recovery |

Generated recovery notes have separate POSIX and PowerShell commands. They are not cmd.exe scripts. Use your actual CLI path if no global `skillrouter` command is installed.

## Service and Windows

A stopped service can restart when a hook runs. Set `SKILLROUTER_SERVICE=0` in the relevant environment to use standalone hooks.

On Windows, the service stays off if its state directory is outside the user's profile. This protects the authentication key's expected privacy. Keep the state private or use the fallback; changing permissions broadly is not a fix.

If the host kills background processes, the service may not remain alive. Standalone hooks still work. A service that crashes soon after startup can pause automatic restarts; inspect status rather than repeatedly forcing a restart.

Windows shell-sensitive install paths can be rejected. Read the exact offending path, use a plain permanent location, and preserve spaces with appropriate quoting.

## FAQ

### Does this save a fixed number of tokens?

No. Savings depend on the host, library, core selection, and actual reads. Installing MCP alone does not remove the existing preload. `doctor` provides estimates; compare your host's actual context behavior before and after a deliberate trim.

### Does MCP access mean the agent will use the skill?

No. MCP makes the skill reachable. Hooks and standing instructions encourage discovery. Native task testing establishes whether the model searches, reads and applies it.

### Can I use it without moving any skills?

Yes. Install, index and search first. Trim and core sync are separate operations.

### Is everything private because it runs locally?

The index and logs live locally, but search queries are logged and skill bodies are sent to the requesting host. That host may use a remote model provider. Follow its data policy and review skills before loading them.

### Does it work with every agent, including cloud assistants?

The repository has named local adapters and a generic stdio MCP entrypoint. An arbitrary cloud assistant needs a supported connection/bridge. This repository does not create one automatically.

## Reporting an issue

Include OS, Node version, package version/commit, host version, shell and install route. Describe expected versus observed behavior and provide a small synthetic reproduction.

Sanitize diagnostics first. Do not attach credential-bearing host configs, full indexes, private skill bodies, raw search logs or recovery manifests by default. [Open an issue](https://github.com/404kidwiz/skillrouter/issues).

