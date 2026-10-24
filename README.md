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

Works with Claude Code, Codex, Cursor, Gemini CLI and OpenCode, on macOS, Linux and Windows. Plays well with [skills.sh](https://skills.sh) (`npx skills add …`): keep installing skills the same way, then let skillrouter decide what gets preloaded.

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

## Making agents use every relevant skill

Hints alone get ignored when they are often wrong. Three mechanisms work together:

| Mechanism | When it fires | What it does |
|---|---|---|
| Prompt check | every user prompt (system-generated turns skipped) | lists up to 4 candidates that pass the gate, each with its "when" line and exact load call, and asks for a one-line decision, `Skills: <ids>` or `Skills: none (<why>)`, before the work and again at the end of the final reply (some hosts don't keep mid-turn text where the end-of-turn check can see it) |
| Action triggers | after an edit or command that shows the kind of work: tests, Dockerfiles, migrations, CI, Kubernetes, Terraform, frontend, auth, APIs, git history, PRs, releases | once per session per rule, names the fitting skills not yet loaded. Rules are editable in `~/.skillrouter/triggers.json` |
| Decision nudge | at the end of a turn that ran 3+ tool calls after a check, with no skill loaded and no `Skills:` line | sends the turn back once to decide; never twice in a row |

What each host gets from `install`:

| Host | Prompt check | Action triggers | Decision nudge |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` | `PostToolUse` | `Stop` (reads the transcript) |
| Codex | `UserPromptSubmit` | `PostToolUse` on `Bash`, `apply_patch` | `Stop` (reads the turn's text from the session transcript; no nudge if it can't) |
| Cursor | `beforeSubmitPrompt` | `postToolUse` | `stop` sends one `followup_message` (`loop_limit: 1`); counts edits and commands only, and waits for the final text in the transcript |
| Gemini CLI | `BeforeAgent` | `AfterTool` | `AfterAgent` retries with the nudge as the prompt |
| OpenCode | plugin `chat.message` | plugin `tool.execute.after` (appended to the tool result) | none |
| Antigravity, OpenClaude, Hermes | none: rule text in the host's instruction file, plus the MCP server | | |

Skill loads count wherever they happen: the router's `read_skill` under each host's MCP naming, Claude's Skill tool, Gemini's `activate_skill`, OpenCode's `skill` tool, and reads of a `SKILL.md` file.

Local embeddings are opt-in: install `@huggingface/transformers` next to skillrouter (an optional peer dependency, ~450 MB of ONNX runtime packages), then run `skillrouter index --embeddings` (a one-time ~90 MB MiniLM model download into `~/.skillrouter/models`). With them, a candidate passes on meaning (cosine ≥ 0.45) or on words and meaning together (cosine ≥ 0.20 and cosine + BM25/100 ≥ 0.52); on 16 labeled real prompts this dropped every junk hit but one name collision. Hooks never download; the semantic step has an 800 ms budget and falls back to BM25, as it does when the vectors were built for an older index (`doctor` shows "Vectors: STALE"). Prompt checks take ~0.4-0.5 s with embeddings (~0.2 s without); tool calls that match no trigger rule add ~50-90 ms.

Checks are bound to the turn that produced them (Claude `prompt_id`, Codex `turn_id`, Cursor `generation_id`; Gemini by time since its prompt), so a later turn is never nudged for an earlier turn's hints; subagents keep their own trigger slots; a skill already loaded in the session is not suggested again.

Every decided turn also records a verdict: each suggested skill is accepted (it, or a sibling the check named, is on the final reply's `Skills:` line, or it was loaded) or declined, on Claude Code, Codex, Cursor and Gemini CLI at the end of the turn, and on OpenCode once the next prompt arrives. A turn that answers a nudge is credited to the nudged turn. `report` shows accept rates per skill. On each host separately, a skill declined in at least 5 sessions (one decline per session counts) and accepted in under 10% of its counted turns is held back from prompt checks and triggers for 30 days after its last verdict, then offered again with fresh counts. `search_skills` always finds it, and an agent loading it on its own counts as accepting it: see it with `skillrouter suppress`, exempt one with `skillrouter suppress keep <id>`, forget counts with `skillrouter suppress reset [id]`, change the threshold with `SKILLROUTER_SUPPRESS_AFTER` (0 turns it off). Counts live in `~/.skillrouter/verdicts.json`.

`report` credits a check when the hinted skill is loaded in the same session, through `read_skill` or the native Skill tool, and counts decided / nudged turns and fired triggers.

## How routing works

1. If a preloaded (core) skill clearly fits, the agent uses it.
2. Otherwise the prompt hook has already attached the top library matches as hints ("use only if it fits").
3. If still unsure, the agent calls `search_skills` with the task intent as a short phrase, then `read_skill(id)` for the best hit.

Search is BM25 over name + description (weighted) + the start of the body. On a 4,500-skill library it gets the obvious cases right (pytest → `python-testing`, landing page audit → `landing-page-design`, postgres index → `postgres-optimization`) and misses on vague or oddly worded prompts. Optional embeddings (`pnpm add @huggingface/transformers`, then `skillrouter index --embeddings`) blend a MiniLM vector score into the ranking.

## The warm service

Every hook used to start Node, and a prompt check also parsed the 8 MB index and loaded the embedding model: about 430 ms per prompt and 50 to 75 ms per tool call. `skillrouter` now keeps one background process per user that holds the index, the BM25 tables and the model in memory and answers hooks over an owner-only Unix socket (on Windows a named pipe that hooks only trust once it proves it holds a secret key) (`~/.skillrouter/run/svc.sock`):

| Hook | Before | With the service |
|---|---|---|
| Prompt check | ~410 ms | ~20 ms |
| Tool and end-of-turn hooks | ~50 ms | ~17 ms |

It starts itself the first time a hook finds no service, reloads when the index or vectors change, restarts when you rebuild or upgrade skillrouter, and exits after 30 idle minutes (`SKILLROUTER_SERVICE_IDLE_MIN`). It holds about 420 MB while running (the embedding model is most of it).

The hook launcher hands each hook to a small Perl client (Perl is preinstalled on macOS and nearly every Linux, and starts in 10 ms where Node needs 30). The client reads the hook's input (waiting at most 1.5 s, like before), asks the service (one 0.8 s budget for connecting, sending and reading, using a non-blocking socket so a wedged service can never trap it), and when there is no healthy service it starts one in the background and runs the hook with Node itself, exactly as before. Without Perl, the Node client does the same. A missing, stopped, wedged or refusing service therefore only costs the old speed, never a hook: output and exit code are the same either way. Payloads over 1 MB, unknown hook modes, and hooks whose state folder (`SKILLROUTER_HOME`, else `$HOME/.skillrouter`) is not the one the service serves, skip the service. A wedged service is killed (only after checking that the process really is a skillrouter service) and replaced. `SKILLROUTER_SERVICE=0` turns the whole thing off.

```
skillrouter service status    # pid, uptime, requests, average latency per hook type
skillrouter service stop      # it comes back on the next hook; SKILLROUTER_SERVICE=0 keeps it off
skillrouter service restart
skillrouter serve             # run it in the foreground (debugging)
```

`doctor` shows whether it is running. Settings such as `SKILLROUTER_MIN_RAW` are read when the service starts, so `service restart` after changing them. Re-run `skillrouter install` after upgrading: it rewrites the launcher and stops the old service so the next hook starts the new code.

The protocol is for skillrouter's own clients, which keep their side of the socket open until the reply arrives (the reply carries its length, so they never wait for the connection to close). A client that closes its side first is treated as having left, and no work is done for it.

## Measuring routing quality

`skillrouter eval` scores the prompt check on labeled prompts: top-1 and top-3 accuracy of the ranked search, hint recall and precision through the real hint gate, the false-hint rate on prompts that should get nothing, and copies shown. The repo bundles a fixture library (`eval/skills`, 47 realistic skills with copies, siblings and generic stubs, plus 400 unrelated fillers so term rarity resembles a real library) and `eval/prompts.jsonl`; `eval --ci` fails below the floors in `DEFAULT_THRESHOLDS`, and GitHub Actions runs it with the tests on every push. `eval --live` runs the same metrics on your real index with `~/.skillrouter/eval.jsonl`; label prompts with `skillrouter eval add "<prompt>" <id,id|none>`. The lexical floor scales with the log of the library size (`minRawFor`), so a 450-skill library isn't held to a floor calibrated on 4,500.

## Reporting, diagnostics, and hook reliability

`report 7` counts successful MCP loads separately from skill use, and keeps traffic from probe/self-test MCP clients (client names containing `probe`, `selftest`, `regression`, `smoke`) out of the organic numbers. If an agent already gets a core skill from a plugin, `skillrouter core skip <id> <agent>` stops `core sync` from linking a duplicate into that agent's folder (stored as `pdf !claude` in `core.txt`). A shown hint gets credit only for a matching skill loaded within 30 minutes with its `hint_id`, or with matching agent/session identity. Earlier reads, other agents, mismatched sessions, and failed loads do not count. Legacy hints without correlation metadata are labeled unattributable. Direct filesystem reads and native skill invocations remain outside these metrics.

`doctor` shows user-scope hook/MCP configuration for each agent, index age (flagged stale after 7 days), last observed hook and MCP activity, hook outcome counts, and failures over the last 7 days. Configuration presence does not verify trust, activation, or connectivity; project/plugin configuration may be outside its view. Newly installed MCP integrations set `SKILLROUTER_AGENT` for attribution. Hook session IDs are hashed; an optional `SKILLROUTER_SESSION_ID` on the MCP process supports matching sessions where a host can supply one. Hint IDs work without shared host session support.

Hooks call a fixed launcher, `~/.skillrouter/bin/skillrouter-hint <agent>`, and `install` rewrites only what the launcher execs, so a hook's command text (what Codex hashes for trust) never changes across upgrades. `install openclaude antigravity hermes` wires the MCP server into hosts that have no prompt hooks (Hermes through its own config API). `doctor --live` starts every configured server and lists its tools, which is the connectivity proof plain `doctor` can't give. Hint lines carry a "when:" trigger and say exactly how to load the skill (preloaded → Skill tool; otherwise `read_skill(id, hint_id=…)`). A hint is shown only for described skills scoring at least `SKILLROUTER_MIN_RAW` (default 20) and within 85% of the best hit, at most three, so it reads as a recommendation rather than a list. Search adds query-side synonyms, a name-match bonus and plural folding.

The installer pins the MCP server to the current package's absolute CLI path and to a Node binary no other tool manages (not one under `~/.hermes` or `node_modules`; override with `SKILLROUTER_NODE=/path/to/node`). `dist/` is committed so the Claude Code plugin works straight from the repo. Keep that installation available and rerun `install` after moving/upgrading it; `--local` remains accepted for compatibility. Hooks never run npm or embeddings. Input is limited to 256 KiB for prompt checks and 8 MiB for tool and Stop events, with a 1.5-second stdin deadline; matching runs in a killable worker with a separate 1.5-second deadline. Failures return the host's empty/continue response and record an outcome. OpenCode additionally caps the subprocess wait at 2 seconds. These budgets exclude host and initial Node startup time.

Repeated installation replaces existing router hooks while preserving unrelated hook commands. JSON config files are backed up before writes. Existing multiline TOML command/args require manual adjustment; the installer refuses to rewrite that syntax.

## Where things live

```
~/.skillrouter/
  index.json     every skill: id, name, description, path, tokens
  core.txt       skill ids every agent preloads
  core/          symlinks to the core skills (agent folders point here)
  library/       long tail moved out of agent folders (.conflicts/ keeps same-name variants)
  usage.jsonl    one line per search / read / hint / verdict (hints never log prompt text)
  run/           the warm service: socket, pid, lock, status snapshot, error log
  verdicts.json  per-skill accepted / declined counts and the keep list (drives suppression)
  backups/       tar of each folder before trim, plus RESTORE-<stamp>.md
```

Agent folders it knows about: `~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills`, `~/.gemini/skills`, `~/.config/opencode/skills`, and the shared `~/.agents/skills` that Codex, Cursor, Gemini CLI and OpenCode read. `install` backs up every config file it touches as `<file>.bak-skillrouter`.

## Windows

Hooks, the installer, the MCP server, `core`, `trim` and the triggers run on Windows 10 and 11 with Node 20 or newer on your PATH. The commands are the same as everywhere else.

- Each hook runs `node "C:/Users/you/.skillrouter/bin/skillrouter-hint.mjs" <agent>`. That shape reads the same in Git Bash, cmd.exe and PowerShell, so it works whichever shell a host picks. The launcher is a small module that runs the CLI in the same Node process, and its path never changes, so hook text stays stable across upgrades.
- `core` and `trim` link folders with junctions, which need neither admin rights nor Developer Mode.
- Config writes retry for a moment when antivirus or the search indexer has a file open, and no spawned process flashes a console window.
- Claude's PowerShell tool, and Codex's `powershell -Command` and `cmd /c` wrappers, are understood by triggers and skill-load detection. Config files saved with a BOM still load.
- The warm service works on Windows too, over a named pipe. Windows lets any local user list pipe names, so a name proves nothing: before a hook sends anything it sends a random nonce, and the service must answer with an HMAC of it under a key kept in `~/.skillrouter/run/svc.key`. Anything else listening on that pipe gets only the nonce and counts as no service. The key is only private inside your profile folder, so the service stays off when `SKILLROUTER_HOME` points outside it, and `doctor` says so. `service stop` is a request over the pipe, since Windows has no signals; a service that stops answering is ended only after PowerShell, run by its full path, confirms the process is a skillrouter service. A service that dies within a minute of starting without cleaning up pauses automatic restarts for five minutes; `service start` ignores the pause. On a GitHub Windows runner with 447 skills a hook took about 215 ms without the service and 98 ms with it, 62 ms of which is starting Node, which a hook cannot avoid because Windows has no Perl client. A real library of thousands of skills makes the no-service time longer and leaves the service time about the same.
- An install path containing `$`, a backtick or `%` is refused, because the shells that run hooks would expand it. Point `SKILLROUTER_HOME` at another folder.

CI runs the test suite on `windows-latest`, including the service tests that use a real named pipe; only the tests that need `sh`, Perl, signals or file modes are skipped there. If a host kills background processes when a hook ends, the service cannot stay up; hooks keep working without it, and the pause above stops every hook from trying to start one. Nobody has run each agent by hand on a Windows PC yet, so expect rough edges and report them.

## Limits

- Codex asks you to trust each new hook once (`/hooks` in Codex); a hook stays off until you approve it.
- Cursor's headless mode (`cursor-agent -p`) fires tool hooks but not `beforeSubmitPrompt` or `stop`, and has no transcript, so prompt checks and the nudge only run in interactive sessions.
- Gemini's `AfterAgent` nudge rejects the final response and retries, so the nudge asks the model to give its answer again.
- Antigravity has no hooks, so it only gets the MCP server and the `AGENTS.md`-style instruction.
- `trim` leaves plugin-format folders (`.claude-plugin/plugin.json`) and dot-entries alone and never touches a folder that is itself a symlink.
- Hermes Agent has its own skill system; use its `skills.disabled` list instead of `trim`.
- On Windows a PowerShell command split across lines with backticks can read as extra commands to the decision nudge.

## Development

```bash
pnpm install && pnpm test
node dist/src/cli.js doctor
```

MIT.
