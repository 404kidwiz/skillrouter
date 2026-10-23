# skillrouter

Keep thousands of agent skills without paying for them on every prompt.

Agent skills (`SKILL.md` folders) are cheap one at a time: the agent only preloads each skill's name and description. At hundreds or thousands of skills that preload *is* the problem. Claude Code caps the list at about 1% of the context window and silently drops descriptions, so routing degrades to guessing from names; Codex, Cursor, Gemini CLI and OpenCode send the whole list every turn. One real library of 3,500 skills cost ~21k tokens per prompt in Claude Code and ~44k in Hermes, and skills still went unused because the agent couldn't find them.

skillrouter splits the library into two tiers and adds the plumbing that makes the split work:

| Tier | What | Cost per prompt |
|---|---|---|
| **core** | ~30 skills you actually use, preloaded in every agent | ~2k tokens |
| **library** | everything else, behind one MCP server with two tools (`search_skills`, `read_skill`) | ~500 tokens of tool schema |

Plus:

- **Prompt hints:** a hook runs on every prompt, searches the library (lexical BM25 only, no model download) and attaches up to 3 matching skill names. The agent no longer has to remember to look.
- **Usage log:** every search, read and hint is logged per agent, so you can see which skills get used and move them in or out of core.
- **Safe trim:** moves the long tail out of agent auto-load folders with tar backups, a restore file, and a dry run by default. Nothing is deleted except broken symlinks.

Works with Claude Code, Codex, Cursor, Gemini CLI and OpenCode. Plays well with [skills.sh](https://skills.sh) (`npx skills add …`): keep installing skills the same way, then let skillrouter decide what gets preloaded.

## Quick start

```bash
npx -y skillrouter doctor            # what each agent preloads today, and what it costs
npx -y skillrouter index             # scan every skill folder into ~/.skillrouter/index.json
npx -y skillrouter search "postgres migration add index"
npx -y skillrouter install claude codex cursor gemini opencode   # MCP server + prompt hook per agent
```

That already gives every agent the router and the hints. To cut the preload cost:

```bash
npx -y skillrouter core add impeccable python-testing writing-plans   # whatever you use weekly
npx -y skillrouter trim                 # dry run: what would move
npx -y skillrouter trim --apply         # tar backups first, then move
npx -y skillrouter index && npx -y skillrouter core sync
```

A week later:

```bash
npx -y skillrouter report 7             # searches/reads per agent, most-read skills, did hints help
npx -y skillrouter core suggest         # most-read skills -> candidates for core
```

### Claude Code plugin

The repo is also a Claude Code plugin: it bundles the MCP server, the `UserPromptSubmit` hook and a `skillrouter` skill that teaches the agent the routing rule and the maintenance commands.

```bash
claude plugin marketplace add 404kidwiz/skillrouter
claude plugin install skillrouter
```

## How routing works

1. If a preloaded (core) skill clearly fits, the agent uses it.
2. Otherwise the prompt hook has already attached the top library matches as hints ("use only if it fits").
3. If still unsure, the agent calls `search_skills` with the task intent as a short phrase, then `read_skill(id)` for the best hit.

Search is BM25 over name + description (weighted) + the start of the body. On a 4,500-skill library it gets the obvious cases right (pytest → `python-testing`, landing page audit → `landing-page-design`, postgres index → `postgres-optimization`) and misses on vague or oddly worded prompts. Optional embeddings (`pnpm add @huggingface/transformers`, then `skillrouter index --embeddings`) blend a MiniLM vector score into the ranking.

## Reporting, diagnostics, and hook reliability

`report 7` counts successful MCP loads separately from skill use. A shown hint gets credit only for a matching skill loaded within 30 minutes with its `hint_id`, or with matching agent/session identity. Earlier reads, other agents, mismatched sessions, and failed loads do not count. Legacy hints without correlation metadata are labeled unattributable. Direct filesystem reads and native skill invocations remain outside these metrics.

`doctor` shows user-scope hook/MCP configuration for each agent, index age (flagged stale after 7 days), last observed hook and MCP activity, hook outcome counts, and failures over the last 7 days. Configuration presence does not verify trust, activation, or connectivity; project/plugin configuration may be outside its view. Newly installed MCP integrations set `SKILLROUTER_AGENT` for attribution. Hook session IDs are hashed; an optional `SKILLROUTER_SESSION_ID` on the MCP process supports matching sessions where a host can supply one. Hint IDs work without shared host session support.

The installer pins hooks and MCP to the current package's absolute CLI path and to a Node binary no other tool manages (not one under `~/.hermes` or `node_modules`; override with `SKILLROUTER_NODE=/path/to/node`). `dist/` is committed so the Claude Code plugin works straight from the repo. Keep that installation available and rerun `install` after moving/upgrading it; `--local` remains accepted for compatibility. Hooks never run npm or embeddings. Input is limited to 256 KiB with a 1.5-second stdin deadline; matching runs in a killable worker with a separate 1.5-second deadline. Failures return the host's empty/continue response and record an outcome. OpenCode additionally caps the subprocess wait at 2 seconds. These budgets exclude host and initial Node startup time.

Repeated installation replaces existing router hooks while preserving unrelated hook commands. JSON config files are backed up before writes. Existing multiline TOML command/args require manual adjustment; the installer refuses to rewrite that syntax.

## Where things live

```
~/.skillrouter/
  index.json     every skill: id, name, description, path, tokens
  core.txt       skill ids every agent preloads
  core/          symlinks to the core skills (agent folders point here)
  library/       long tail moved out of agent folders (.conflicts/ keeps same-name variants)
  usage.jsonl    one line per search / read / hint (hints never log prompt text)
  backups/       tar of each folder before trim, plus RESTORE-<stamp>.md
```

Agent folders it knows about: `~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills`, `~/.gemini/skills`, `~/.config/opencode/skills`, and the shared `~/.agents/skills` that Codex, Cursor, Gemini CLI and OpenCode read. `install` backs up every config file it touches as `<file>.bak-skillrouter`.

## Limits

- Codex asks you to trust a new hook once; the hint hook stays off until you approve it.
- Gemini CLI's hook uses `BeforeAgent`; Cursor's uses `beforeSubmitPrompt`. Antigravity has no hooks, so it only gets the MCP server and the `AGENTS.md`-style instruction.
- `trim` leaves plugin-format folders (`.claude-plugin/plugin.json`) and dot-entries alone and never touches a folder that is itself a symlink.
- Hermes Agent has its own skill system; use its `skills.disabled` list instead of `trim`.

## Development

```bash
pnpm install && pnpm test
node dist/src/cli.js doctor
```

MIT.
