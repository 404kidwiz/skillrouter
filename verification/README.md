# Skillrouter integration verification — 2026-10-23

The integrations were reinstalled from `/Users/dawizkidmal/Projects/skillrouter` with `node dist/src/cli.js install claude codex cursor gemini opencode --local`. New integrations use the absolute CLI/Node paths and per-agent MCP identity. All affected JSON and TOML parsed successfully afterward. Unrelated MCP entries and unrelated Codex TOML settings matched the pre-install backup.

Private pre-install backup: `/Users/dawizkidmal/.skillrouter/backups/integrations-20261023T045726Z` (directory 0700, copied files 0600). Its manifest includes OpenCode's generated plugin. Do not copy these configs into a review or chat: they can contain credentials. Restore individual router settings after inspection, rather than overwriting whole live configs that may have changed since the snapshot.

## Evidence levels

| Host | Installed hook/plugin + MCP SDK probe | Native host evidence | Remaining limit |
|---|---|---|---|
| Claude | Hint, search, load, correlation passed | `claude mcp get skillrouter`: Connected. Fresh print session fired a shown hint. | Native model/tool turn stopped at expired OAuth. |
| Codex | Hint, search, load, correlation passed | Fresh CLI recognized config and attempted both tools. | Tools denied: `MCP tool call requires approval, but approval policy is never`. No native hook event observed. Invocation-only scoped per-tool approval settings did not resolve it. |
| Cursor | Hint, search, load, correlation passed | `cursor-agent mcp list-tools skillrouter` discovered both tools and `hint_id`. Desktop launched. | Native print prompt stopped at workspace trust; native prompt hint delivery unverified. |
| Gemini | Hint, search, load, correlation passed | `gemini mcp list`: Connected. | Native prompt authentication returned `IneligibleTierError` / `UNSUPPORTED_CLIENT` for the configured account. No native hook event observed. |
| OpenCode | Generated plugin hint injection, search, load, correlation passed | `opencode mcp list`: Connected. Fresh loopback server v1.18.34 reported MCP connected; a `noReply` prompt fired the installed hook. Desktop launched. | No native model tool-execution/context-delivery turn was run. |

`integration-probes.json` records five **synthetic direct probes**, not native model turns. They used the actual installed commands/configuration and actual live usage log. Each MCP client was named `skillrouter-integration-probe/<agent>`; these searches and five loads of `python-testing` now appear in `report 7`. Do not interpret those counts/conversions as organic skill adoption or use. Additional native Claude/OpenCode hooks were observed without correlated loads.

The native JSON files record the relevant host-specific evidence. `codex-native.json` is the initial bounded run, `codex-native-diagnostic.json` narrows the approval error, and `codex-native-scoped.json` records the invocation-only scoped follow-up. `native-activity.json` covers an earlier bounded CLI observation window, not every subsequent check. `claude-native.json` and `opencode-native.json` include the corresponding native hook IDs.

Native Claude startup hooks generated unrelated Ponytail/Graft scaffolding and ignore rules in this repo. Those newly generated files (including the Graft cache) were quarantined under the private backup's `native-bootstrap-generated/` directory, and `.gitignore` was restored to its pre-verification content. These generated tools/instructions are outside the skillrouter change.

Fresh CLI/server processes were started and disposed where applicable. Cursor and OpenCode desktop apps were launched. Existing Claude Desktop/Code activity and the Codex app running this chat were preserved. They were not forcibly terminated or restarted. Models, authentication, persisted permissions, and trust controls were not changed. The temporary OpenCode server and its verification session were removed.

## Checks

- `pnpm test`: 13/13 passed before reinstall.
- All installed JSON and Codex TOML parsed after reinstall.
- All five direct hook/plugin and MCP tool probes passed.
- Native MCP checks passed for Claude, Cursor, Gemini, OpenCode; Codex config recognized and tool approvals denied.
- `doctor` and `report 7` ran after reinstall. They still label configuration as activation/connectivity unverified because they are passive diagnostics, not native acceptance tests.
- No push, publication, deployment, model/provider changes, or authentication changes.

## Next native acceptance steps

Use each host's normal authentication/trust/approval workflow. Do not bypass controls to make a test pass. Claude needs reauthentication for a model turn; Cursor needs a trusted workspace; Gemini needs an eligible supported client/account path; Codex needs an interactive tool-approval review and hook trust/activation inspection. After those owner-controlled steps, use a fresh session to verify actual hint context and `search_skills` → `read_skill` with the hint ID. Reconnect skillrouter or restart preserved sessions when convenient.

References used for verification mechanics: [OpenCode server API](https://opencode.ai/docs/server/) (`noReply`, loopback host, temporary session cleanup); [Codex configuration reference](https://developers.openai.com/codex/config-reference/) (invocation-scoped per-tool settings, which did not override this host's gate).
