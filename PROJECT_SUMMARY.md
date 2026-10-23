# PROJECT_SUMMARY.md

## Project
skillrouter: keep a large agent-skill library (thousands of SKILL.md folders) without preloading it into every prompt. Small preloaded core + one MCP router (search_skills / read_skill) + per-prompt hints + usage log + safe trim. Targets Claude Code, Codex, Cursor, Gemini CLI, OpenCode. TypeScript, Node >= 20, pnpm.

## Status
v0.1.0 on GitHub (public), not yet published to npm.

## Last Updated
2026-10-23

## Done
- All commands implemented and exercised on a real 4,500-skill library and in a scratch home: doctor, index, search, core (list/add/remove/suggest/sync), trim (dry run default, tar backups + RESTORE file), install (5 agents, backs up configs), report, mcp (verified with an MCP SDK client), hint (all four hook dialects).
- 5 unit tests (`pnpm test`): tokenizer, BM25 ranking, frontmatter parsing, hint formats, index build.
- Claude Code plugin files: .claude-plugin/plugin.json, marketplace.json, hooks/hooks.json, .mcp.json, skills/skillrouter/SKILL.md.

## Next
- `npm publish` (README and hook configs use `npx -y skillrouter`; until then `npx -y github:404kidwiz/skillrouter` or `install --local` work).
- Dogfooding since 2026-10-23 on the author's machine via `install --local` (8 agents). Review `report 7` after a few days.
- `core sync` should skip skills an agent already gets from a plugin (Claude: plugin-provided skills get linked twice).
- Search quality: BM25 misfires on vague prompts ("docker build slow on M1" -> llama-cpp). Candidates: boost name matches, synonym list, or the optional embeddings path by default once the model download is acceptable.

## Blockers
- None. Hermes Agent is out of scope (own skill system; use its `skills.disabled`).
