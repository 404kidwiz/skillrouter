# Compatibility and evidence

Version under validation: **0.2.0-beta.1**. “Configured,” “MCP connected,” and “a model automatically searched/read” are different checks.

## Operating systems

| Environment | Automated coverage | Native host acceptance |
| --- | --- | --- |
| macOS, Node 20/22 | CI matrix; local candidate tests report the actual Node version | Several flows were checked on the author's Mac; see the release report for candidate-specific evidence |
| Windows 10/11, Node 20/22 | Windows runner matrix, actual pipe tests, portable launcher and filesystem tests | Individual Windows agent acceptance remains required; hosted runner tests do not establish all Windows 10/11 desktop behavior |
| Linux, Node 20/22 | CI matrix | Individual host acceptance remains required |

The previous commit `d686716` passed Windows Node 22, macOS Node 22 and Linux Node 20/22 CI. The expanded candidate matrix must run before its new entries can be marked passed. No native Windows desktop was available for the local implementation session.

## Host capabilities

| Host | MCP search/read | Automatic prompt hint | Action hints / final decision | Search gate (before the first work call) |
| --- | --- | --- | --- | --- |
| Claude Code | Installed server or plugin | Yes | Both | `PreToolUse` |
| Codex | Installed server | Yes, after normal hook trust | Both | `PreToolUse`, trusted once like the other hooks |
| Cursor | Installed server | Interactive mode | Both interactive; headless behavior differs | `preToolUse` |
| Gemini CLI | Installed server | Yes | Both; final nudge retries the answer | `BeforeTool` |
| OpenCode | Installed server | Plugin message hook | Action hints; no final nudge | None: the plugin API has no blocking step here |
| Antigravity | Current global config | Separately saved standing rule; no hook integration here | Not installed by this adapter | None |
| OpenClaude / Hermes | Host configuration | Separately saved standing rule | No hook integration here | None |

The gate fails open on every host: a crashed or timed-out gate hook lets the call through. It prints nothing when it allows, never an explicit allow, so it cannot skip a host's own approval prompts.

The installer preserves host approval controls. It does not write standing instructions into user instruction files; see [persistent routing instructions](INSTALL.md#persistent-routing-instructions). Antigravity uses `~/.gemini/config/mcp_config.json`; the legacy router entry can be migrated without copying unrelated servers. Cloud-only assistants may require a distinct bridge and are not covered by these local adapters.

## Native acceptance recipe

1. In a fresh disposable OS profile, install the candidate by its documented route. Record OS, Node, agent version and shell. Check spaces/Unicode in the profile path; on Windows test cmd, PowerShell and Git Bash where the host supports them.
2. Run `doctor --live <host>`. Confirm the host's own tool list shows both router tools, then complete its normal trust prompts without weakening permissions.
3. Give the agent a normal task whose relevant synthetic skill is outside core. Observe automatic discovery, successful body read, and actual use. Test a no-skill task for unnecessary hints too.
4. Start a new session, upgrade/reinstall the candidate, and repeat. Check no duplicate hooks or loss of unrelated config. Exercise service-off fallback, stale index, unavailable skill and a malformed configuration.
5. In the disposable profile, trim and restore a library containing retained core files, links and same-name variants. Compare bytes and original paths. Record failures and skipped cases separately from passes.

## Current limitations

GUI hosts need Node discoverable under their supported launch environment; Windows hooks use `node` on PATH. Install paths containing `$`, backtick or `%` are rejected on Windows. Junctions are used instead of privileged symlinks. The Windows warm service stays off outside the user's profile and falls back to standalone hooks. Full semantic quality depends on separately installed optional embeddings; default smoke tests exercise lexical routing.

Restore accepts trusted generated manifests for the current user's original agent paths and brings back only what trim removed, skill by skill; skills changed since the trim are skipped and listed, never overwritten. It preserves bytes and supported file modes, not hardlink identity, ACLs, extended attributes or timestamps. Linked agent ancestors are rejected before trim. Legacy tar-only backups need manual recovery; manifests are not a portable library migration format.
