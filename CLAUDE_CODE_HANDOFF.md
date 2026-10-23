# Claude Code handoff prompt

Independently review and verify the skillrouter changes and the installed integrations on this Mac, then recommend enhancements. Start with read-only inspection and safe verification. Do not implement recommendations, change models/providers, bypass trust/approval/authentication, publish, push, deploy, trim the library, relink core skills, or restart active work without a separate request. Preserve the existing dirty working tree. Never print credentials or full secret-bearing configs.

Authoritative repository: `/Users/dawizkidmal/Projects/skillrouter`.
Read `/Users/dawizkidmal/AGENTS.md` and applicable repository instructions. Read `PROJECT_SUMMARY.md`, `verification/README.md`, and the JSON evidence under `verification/`. Use actual current state rather than treating the summary as proof.

Implemented scope:
1. Accurate reporting: hinted loads require explicit hint ID or shared agent/session evidence, occur afterward within 30 minutes, and match the hinted skill. Earlier/cross-agent/cross-session/failed reads must not count. Legacy uncorrelated hints are labeled. Successful MCP loads are logged only after file read succeeds. Direct/native reads and actual skill use remain unmeasured.
2. Per-agent diagnostics: user-scope hook/MCP configuration, index age, last observed hook/MCP activity, hook outcomes, and failures. Configuration presence must not be presented as activation/connectivity proof.
3. Reliable hook execution: absolute installed CLI/Node paths; lexical-only matching; bounded stdin and killable worker deadlines; OpenCode subprocess deadline; repeatable hook installation that preserves unrelated commands; per-agent MCP identity; optional hint IDs in read_skill.

Review the diff, especially `src/report.ts`, `src/health.ts`, `src/hint.ts`, `src/install.ts`, `src/mcp.ts`, `src/search.ts`, `src/cli.ts`, `test/reliability.test.ts`, plugin configs, and `skills/skillrouter/SKILL.md`. No commit was requested. Run `pnpm test`, `git diff --check`, and read-only `node dist/src/cli.js doctor` / `report 7`. Existing tests passed 13/13, but independently assess their adequacy.

Operational changes already authorized and completed:
- Reinstalled Claude, Codex, Cursor, Gemini, and OpenCode with `node dist/src/cli.js install claude codex cursor gemini opencode --local`.
- Private pre-install snapshot: `/Users/dawizkidmal/.skillrouter/backups/integrations-20261023T045726Z`. Do not expose its configs or overwrite whole current configs during verification.
- All installed JSON/TOML parsed; unrelated MCP entries and unrelated Codex settings were preserved.
- Actual installed hooks/plugin and SDK search/load probes passed for all five integrations. These are synthetic probes. Their five `python-testing` loads and correlated hints are in the live usage log; they are not organic usage.
- Native Claude startup hooks generated unrelated Ponytail/Graft repository scaffolding. It was moved into the private backup's `native-bootstrap-generated/`, with `.gitignore` restored. Do not mistake this generated scaffolding for part of the skillrouter change; startup hooks may regenerate it during your review.
- Fresh native CLI processes were used; Cursor/OpenCode desktop apps launched. Existing Claude work and the Codex app hosting the chat were preserved, not forcibly restarted. No persistent authentication, trust, permission, model, or provider settings changed.

Native acceptance is incomplete:
- Claude: native MCP Connected; native prompt hook fired; model turn blocked by expired OAuth.
- Cursor: native tool discovery passed; prompt turn blocked by workspace trust.
- Gemini: native MCP Connected; prompt auth failed with IneligibleTierError / UNSUPPORTED_CLIENT.
- OpenCode: native MCP Connected; fresh local server and noReply prompt fired hook. No native model tool/context turn tested; temporary session/server cleaned up.
- Codex: config recognized; native tool attempts denied by approval policy. Invocation-only scoped per-tool approval settings did not resolve this. Native prompt hook delivery remains unverified. Do not bypass the gate.

Prioritize review questions:
- Is attribution semantically accurate, including old records, multiple hints in one session, failures, and synthetic probes?
- Do each host's current input/output and installation contracts match the adapters? Can hints actually reach model context?
- Are deadlines, child cleanup, streaming input, schema validation, and error reporting sound?
- Does repeat installation preserve unrelated settings, environment variables, grouped hooks, and TOML semantics? Are backups/restoration sufficient?
- Are passive diagnostics honest about unknown states, disabled integrations, stale config/index, project/plugin overrides, and failed handshakes?
- Are there meaningful missing regressions or privacy issues?

Return: a concise verified/failed/unverified matrix; severity-ranked findings with file/line evidence and reproduction steps; test results; remaining owner-controlled gates; and the top five enhancements ranked by impact and effort. Separate confirmed bugs from optional improvements. Suggest a small next implementation batch, but make no changes during this review.
