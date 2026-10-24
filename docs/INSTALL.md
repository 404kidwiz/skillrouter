# Install and connect Skillrouter

[Back to README](../README.md) · [Copy the agent-install prompt](../README.md#let-your-agent-install-it) · [Troubleshooting](TROUBLESHOOTING.md)

## Choose your route

| Route | Use it when | What to verify |
| --- | --- | --- |
| Stable source checkout | You want the local candidate or several agents | Version, runtime dependencies, selected host config and MCP |
| Claude Code plugin | You want Claude-managed plugin installation | Marketplace version, dependency bootstrap, plugin activation and MCP |
| Manual MCP configuration | Your host supports local stdio MCP but has no adapter | Exact command/arguments and a persistent routing instruction |

Use one route per host. Installing both the Claude plugin hooks and standalone Claude hooks can duplicate hints. One stable source installation can serve multiple other hosts.

The candidate is not published to npm. A Git clone retrieves a public revision, not uncommitted local changes. Inspect `package.json` and the selected revision's documentation before proceeding.

## Source checkout

### 1. Check prerequisites

Use Git, Node 20+ and npm. Node must be visible to the process that launches your agent, which can differ from your terminal.

```sh
git --version
node --version
npm --version
```

Choose a permanent checkout directory. Installed settings use absolute paths. Avoid temporary/download locations that will be cleaned up.

### 2. Obtain the intended version

```sh
git clone https://github.com/404kidwiz/skillrouter.git
cd skillrouter
git rev-parse HEAD
node -p "require('./package.json').version"
```

For an existing checkout, inspect `git status --short` before any update. Do not overwrite local changes. If you need a specific release, select a verified tag or commit; do not invent a prerelease tag.

The documented candidate needs `dist/src/cli.js` and `npm-shrinkwrap.json`. If either is absent, you may have an older revision or an incomplete source copy. Follow that revision's instructions or obtain the complete candidate.

### 3. Install dependencies and index

From the candidate checkout:

```sh
npm ci --omit=dev --omit=optional --ignore-scripts
node dist/src/cli.js doctor
node dist/src/cli.js index --root "./skills"
node dist/src/cli.js search "manage trim audit skill library"
```

The built JavaScript avoids requiring a compiler for this route. The explicit root indexes this repository's routing skill alongside default roots. Additional roots persist in the index across normal rebuilds.

This does not install a third-party skill collection, change core, or move existing skills.

### 4. Configure the selected host

Create a timestamped copy of existing host settings before changes. The installer also creates first-copy backups beside existing config files, but those backups may be older than your latest settings.

```sh
node dist/src/cli.js install claude
node dist/src/cli.js doctor --live claude
```

Replace `claude` with the actual target: `codex`, `cursor`, `gemini`, `opencode`, `antigravity`, `openclaude` or `hermes`. Multiple explicit names are accepted. Do not pass a display name such as `Claude Code` or placeholders such as `<host>`.

The installer writes only the named adapters, preserves unrelated settings where supported, and stops an existing router service during installation. Review every printed result: Hermes can report a skipped setup, and live doctor can print a connection failure without a failing process exit code.

For Hermes, the adapter expects its local config plus its Python environment under `~/.hermes/hermes-agent`. Nonstandard installs and named profiles require profile-aware setup using that host's supported configuration mechanism. One install is not evidence that every profile was configured.

### 5. Verify inside the host

Reload/restart the host and complete its normal trust prompts. Confirm both MCP tools are available. Ask the agent to search an intent matching a skill in your index and read that result.

Then start a fresh session and give it an ordinary relevant task, without telling it which tool to call. Record whether it discovers, reads, and applies the skill. This last check validates automatic behavior; `doctor --live` validates only the configured MCP process and tool list.

If the current session cannot refresh its tool inventory, finish the filesystem setup and provide the exact reload step. Do not claim the native-host check already passed.

## Persistent routing instructions

The standalone installer does **not** edit user instruction files. Hook-enabled hosts get reminders from hooks. MCP-only hosts need a standing rule if you want task-driven discovery across sessions.

Add a marked section through the host's documented user-level instruction mechanism, preserving existing content. Consult the installed host's documentation for the correct location and profile scope. Project-only instructions do not cover every future project.

Suggested text:

```text
Skillrouter:
Before non-trivial work, use relevant preloaded skills. For uncovered parts
of the task, call search_skills with a short intent phrase and read_skill
for matching results. Copy hint_id when a router hint provides one.
Use only relevant instructions and preserve host permissions.
State the skills actually used; a successful read is not proof of use.
If the router is unavailable, report the limitation and continue appropriately.
```

The bundled [routing skill](../skills/skillrouter/SKILL.md) provides the fuller workflow. A skill indexed behind MCP is not automatically preloaded; hooks or standing instructions must make discovery likely.

## Claude Code plugin alternative

The repository includes `.claude-plugin/plugin.json`, the marketplace catalogue, hooks, the routing skill, a built CLI, and a supported npm lockfile.

From a shell with Claude Code installed:

```sh
claude plugin marketplace add 404kidwiz/skillrouter
claude plugin install skillrouter@skillrouter
```

Check the installed marketplace/plugin version before assuming it contains the local candidate. Preserve normal plugin/MCP approvals. Avoid adding the standalone Claude adapter on top of the plugin's hooks.

The clean-plugin smoke models production dependency installation with `npm ci --omit=dev --omit=optional --ignore-scripts`. That passing test is separate from native marketplace acceptance. If your host does not bootstrap dependencies, use a stable local checkout with the explicit dependency step rather than relying on the developer's existing `node_modules`.

For a local plugin checkout, install its runtime dependencies first, then use the local-plugin mechanism supported by your installed Claude Code version. See [official plugin loading documentation](https://code.claude.com/docs/en/plugins/loading) for host-specific behavior.

## Windows notes

The CLI examples above work in PowerShell and cmd when Node and npm are available. Git Bash is also usable; test the shell your host actually launches.

| Area | Behavior |
| --- | --- |
| Node | Hook launcher invokes `node`; make it available to GUI-launched hosts |
| Links | Directory junctions avoid requiring privileged directory symlinks |
| Paths | Quote paths with spaces; the installer rejects unsafe shell-sensitive Windows paths |
| Recovery notes | Separate PowerShell and POSIX commands; do not paste them into cmd |
| Service | Authenticated named pipe; service disabled when its state directory is outside the user profile |

Windows install paths containing dollar signs, backticks or percent signs can be refused. Read the exact error to identify the offending checkout, Node or state path. Choosing a plain checkout path may be necessary; changing only the state folder does not fix an unsafe CLI path.

If overriding the state location, set `SKILLROUTER_HOME` consistently for all relevant processes. Keeping state inside the user profile allows the Windows service's private-key model. Do not weaken permissions to force the service on; standalone hooks are the fallback.

Native Windows host acceptance remains a release gate. Consult [SUPPORT.md](SUPPORT.md) rather than treating a test matrix definition as a completed run.

## Upgrading

1. Record your version, checkout path and changed settings. Preserve local edits and make current config backups.
2. Obtain the intended revision through your normal Git workflow. Keep the checkout path stable.
3. Repeat the documented dependency-install step. For development builds use pnpm and regenerate `dist`.
4. Rerun `install` for your selected standalone targets, rebuild the index and run their live checks.
5. Reload hosts and repeat one normal-task test in a fresh session. Plugin-managed installations use the host's plugin-update workflow instead.

Optional global command: from the stable checkout, `npm install --global . --ignore-scripts --omit=dev --omit=optional` exposes `skillrouter` on PATH. It is not required; all documentation works with the explicit Node entrypoint.

## Removing an integration

There is no `uninstall` subcommand in this candidate.

1. Disable the selected host's router integration first. Remove only its Skillrouter MCP entry, router hooks/plugin and any separately added marked instruction block.
2. Reload the host and run `node dist/src/cli.js service stop` from the still-existing checkout. Active hooks can otherwise restart it.
3. Preserve `~/.skillrouter/library` and backups. They may contain original skills moved by trim. Use [recovery](REFERENCE.md#core-trim-and-recovery) before considering deletion.
4. Compare config backups before restoring them; a wholesale old backup can erase newer unrelated settings.
5. Remove the checkout or global command only after no host references it and required library contents have been recovered.

For plugin-managed installs, disable/remove the plugin through the host's supported workflow. Do not delete its cache while other plugin processes are using it.

