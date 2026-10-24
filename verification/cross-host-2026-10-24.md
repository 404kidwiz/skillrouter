# Cross-host skillrouter acceptance — 2026-10-24

## Outcome
Task-driven skillrouter discovery is configured globally for Cursor, Antigravity, OpenCode, and all 14 local Hermes profiles. The library contains 4,547 indexed skills. Discovery happens for substantive tasks, including when a preloaded skill fits; agents load relevant matches before applying them. Simple conversation is exempt. These are persistent instructions, not an unconditional enforcement guarantee.

| Host | Persistent setup | Native evidence | Remaining limit |
|---|---|---|---|
| Cursor 3.26.13 | Global user rule in `~/.cursor/rules/skill_discovery.mdc`; existing global MCP and prompt/tool/stop hooks | Desktop User Rules visibly lists the file. A normal pytest strategy task triggered a hook, a router search, and loads of `tool-use-guardian` and `python-testing-patterns`; completion reported both skills. Router log client: `cursor-vscode/1.0.0`. | CLI acceptance separately stopped at workspace trust; no trust bypass used. Desktop passed. |
| Antigravity IDE 2.5.5 | Updated global `~/.gemini/GEMINI.md`; added router to current `~/.gemini/config/mcp_config.json` and installed IDE compatibility config `~/.gemini/antigravity-ide/mcp_config.json`; existing old `~/.gemini/antigravity/mcp_config.json` retained | Native MCP manager shows skillrouter 2/2 and both tools enabled. A fresh normal async-job-runner task automatically selected `skillrouter/search_skills` then `skillrouter/read_skill`, returning `async-python-patterns`. Router log client: `antigravity-client/v1.0.0`. | Individual read-only tool calls used the normal one-time approval prompts. Permanent permissions unchanged. CLI model test separately stopped at a headless file-read permission gate. |
| OpenCode | Updated `~/.config/opencode/AGENTS.md`; existing enabled router and `skillrouter-hints.js` plugin retained | `doctor --live` connected; direct search/load passed. A fresh native run fired the actual plugin hint with matching testing skills. | Model turn failed with HTTP 502 from the configured local provider at 127.0.0.1:8787: upstream connection attempts failed. Native model search/load is unverified. Provider/model/auth settings unchanged. |
| Hermes 0.22.4 | Updated all 14 SOUL.md prompts; added existing local router entry to 13 named profiles | 14/14 native MCP tests passed. Effective prompt and CLI/API/Telegram toolset checks passed for all. A fresh default-profile model turn automatically searched and loaded `async-python-patterns`, then completed. | Automatic model selection tested on default only. Named profiles passed native connectivity/prompt checks. No VPS changes or gateway restart. |

## Antigravity repair
The original router installer covered `~/.gemini/antigravity/mcp_config.json`, while the installed IDE's raw-config control opens `~/.gemini/config/mcp_config.json`. Added the router to the current and installed IDE compatibility files, refreshed MCPs, and reloaded the launched IDE window. The native tool cache and UI subsequently exposed both tools.

An initial task selected the legacy `skill-vault` service with identical tool names. Disabled that obsolete service through `agy mcp disable skill-vault` in the shared current Antigravity config, and made the global rule explicitly select server `skillrouter`. Retained its configuration for rollback. The subsequent fresh task selected the correct server. No broad permission allowlist or dangerous execution flags were added.

## Files and backups
- Rules: `~/.cursor/rules/skill_discovery.mdc`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`.
- Antigravity configs: `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-ide/mcp_config.json`.
- Hermes: 14 SOUL.md files and 13 profile config.yaml files (default plus bizdev, captain, closer, foreman, glasses, jobsearch, mainman, outbound, press, research, sage, scout, social).
- Private backups: `~/.skillrouter/backups/cross-host-20261024/`, `~/.skillrouter/backups/hermes-profiles-20261024T024013/`.
- Unrelated Antigravity config values compared against backups and preserved. Hermes worker verified unrelated config values and original file modes. Rule checks passed. No runtime code changes, publication, or deployment.

## Evidence handling
`doctor --live` connected to all eight already-configured hosts and found both router tools. Additional direct configured-command probes for Cursor, current-path Antigravity, and OpenCode searched and loaded successfully. Those probes use `skillrouter-acceptance-probe/<host>` clients and are synthetic, not native model behavior.

Private evidence: `~/.skillrouter/usage.jsonl`, `/tmp/skillrouter-cross-host-direct-probes.json`, `/tmp/skillrouter-opencode-native.jsonl`, `/tmp/skillrouter-antigravity-native.jsonl`, `/tmp/hermes-skillrouter-report.md`, `/tmp/hermes-skillrouter-mcp-results.json`, `/tmp/hermes-skillrouter-substantial.jsonl`. Do not publish raw host configuration or transcripts.

## Activation
Start a fresh conversation for new prompts and tool configuration. Existing model contexts can retain older instructions. Hermes gateways may require a normal MCP reload/restart before newly added profile servers appear in an already-running process; no active gateway was restarted here. All changes are local to this Mac.

## Official references
- [Cursor global user rule files](https://prod.cursor.com/help/customization/rules)
- [Antigravity global rules](https://antigravity.google/docs/rules)
- [Antigravity MCP configuration](https://antigravity.google/docs/mcp)
- [OpenCode global instructions](https://opencode.ai/docs/rules)
