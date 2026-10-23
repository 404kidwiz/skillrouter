# PROJECT_SUMMARY.md

## Project
skillrouter: keep a large agent-skill library (thousands of SKILL.md folders) without preloading it into every prompt. Small preloaded core + one MCP router (search_skills / read_skill) + per-prompt hints + usage log + safe trim. Targets Claude Code, Codex, Cursor, Gemini CLI, OpenCode. TypeScript, Node >= 20, pnpm.

## Status
v0.1.0 on GitHub (public), not yet published to npm.

## Last Updated
2026-10-23

## Done
- All commands implemented and exercised on a real 4,500-skill library and in a scratch home: doctor, index, search, core (list/add/remove/suggest/sync), trim (dry run default, tar backups + RESTORE file), install (5 agents, backs up configs), report, mcp (verified with an MCP SDK client), hint (all four hook dialects).
- 13 tests (`pnpm test`): original routing checks plus attribution, malformed logs, repeat installation/config preservation, lexical hook outcomes/privacy, worker/OpenCode deadlines, stdin limits, and MCP successful/failed loads.
- Claude Code plugin files: .claude-plugin/plugin.json, marketplace.json, hooks/hooks.json, .mcp.json, skills/skillrouter/SKILL.md.

## Reporting and hook improvements (2026-10-23)
- Reports correlate hinted loads by explicit hint ID or matching agent/session, require subsequent successful loads within 30 minutes, and label legacy hints unattributable. Native/direct reads and actual skill use are outside these metrics.
- Doctor adds index age and per-agent user-scope config presence, observed hook/MCP activity, outcome counts, and failures. Configuration presence does not verify activation/connectivity.
- Hooks use lexical search, bounded stdin and killable worker deadlines; generated integrations use absolute installed CLI/Node paths, with repeat installation preserving unrelated hooks. OpenCode also bounds its subprocess wait. MCP success is logged after the file loads.
- README and routing skill document correlation and limits. Validation: `pnpm test` (13/13), read-only `doctor` and `report 7`, and `git diff --check`.
- Integrations subsequently reinstalled for all five hosts; private timestamped pre-install backup retained. Config parsing/preservation and all five configured hook/plugin + MCP SDK probes passed. Fresh native CLI/server and desktop launch evidence, host-specific acceptance limits, and synthetic metrics caveats are recorded in `verification/README.md`. Claude/Codex active desktop sessions preserved. Unrelated native-startup Ponytail/Graft scaffolding was quarantined into the private backup and its ignore rules removed. Independent review prompt: `CLAUDE_CODE_HANDOFF.md`. No publish/push.

- 2026-10-23 review fixes: stray `graft` server removed from `.mcp.json`; `dist/` un-ignored so plugin installs have the CLI; installer resolves a Node outside managed trees (`resolveNode`, `SKILLROUTER_NODE` override) and prints the pin; five agents reinstalled.

## Next
- npm publication remains a separate owner-authorized action. Installer now pins the installed absolute CLI/Node paths; a stable local checkout supports `install --local`.
- Dogfooding since 2026-10-23 on the author's machine via `install --local` (8 agents). Review `report 7` after a few days.
- Done 2026-10-23: `core skip/unskip <id> <agent>` (`!agent` markers in core.txt; shared folders drop a skill only when all readers skip it); `report` excludes synthetic probe clients and shows them separately.
- Search quality: BM25 misfires on vague prompts ("docker build slow on M1" -> llama-cpp). Candidates: boost name matches, synonym list, or the optional embeddings path by default once the model download is acceptable.

## Blockers
- None. Hermes Agent is out of scope (own skill system; use its `skills.disabled`).
