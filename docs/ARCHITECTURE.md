# How Skillrouter works

[Back to README](../README.md) · [Installation](INSTALL.md) · [Command reference](REFERENCE.md)

Implementation detail for contributors and users tuning routing. Host-specific behavior depends on installed host versions; see [support and evidence](SUPPORT.md). Historical timings below are measurements from the author’s setup, not guaranteed performance or measurements of every release.

## Hints, action triggers and decisions

Hints alone get ignored when they are often wrong. Three mechanisms work together:

| Mechanism | When it fires | What it does |
|---|---|---|
| Prompt check | every user prompt (system-generated turns skipped) | lists candidates that pass the gate, each with its "when" line and exact load call, and asks for a one-line decision, `Skills: <ids>` or `Skills: none (<why>)`, before the work and again at the end of the final reply (some hosts don't keep mid-turn text where the end-of-turn check can see it) |
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
| Antigravity, OpenClaude, Hermes | MCP only; save a standing rule separately (see INSTALL.md) | | |

Skill loads count wherever they happen: the router's `read_skill` under each host's MCP naming, Claude's Skill tool, Gemini's `activate_skill`, OpenCode's `skill` tool, and reads of a `SKILL.md` file.

Local embeddings are opt-in: install `@huggingface/transformers` next to skillrouter (an optional peer dependency, ~450 MB of ONNX runtime packages), then run `skillrouter index --embeddings` (a one-time ~90 MB MiniLM model download into `~/.skillrouter/models`). With them, a candidate passes on meaning (cosine ≥ 0.45) or on words and meaning together (cosine ≥ 0.20 and cosine + BM25/100 ≥ 0.52); on 16 labeled real prompts this dropped every junk hit but one name collision. Hooks never download; the semantic step has an 800 ms budget and falls back to BM25, as it does when the vectors were built for an older index (`doctor` shows "Vectors: STALE"). Prompt checks take ~0.4-0.5 s with embeddings (~0.2 s without); tool calls that match no trigger rule add ~50-90 ms.

Checks are bound to the turn that produced them (Claude `prompt_id`, Codex `turn_id`, Cursor `generation_id`; Gemini by time since its prompt), so a later turn is never nudged for an earlier turn's hints; subagents keep their own trigger slots; a skill already loaded in the session is not suggested again.

Every decided turn also records a verdict: each suggested skill is accepted (it, or a sibling the check named, is on the final reply's `Skills:` line, or it was loaded) or declined, on Claude Code, Codex, Cursor and Gemini CLI at the end of the turn, and on OpenCode once the next prompt arrives. A turn that answers a nudge is credited to the nudged turn. `report` shows accept rates per skill. On each host separately, a skill declined in at least 5 sessions (one decline per session counts) and accepted in under 10% of its counted turns is held back from prompt checks and triggers for 30 days after its last verdict, then offered again with fresh counts. `search_skills` always finds it, and an agent loading it on its own counts as accepting it: see it with `skillrouter suppress`, exempt one with `skillrouter suppress keep <id>`, forget counts with `skillrouter suppress reset [id]`, change the threshold with `SKILLROUTER_SUPPRESS_AFTER` (0 turns it off). Counts live in `~/.skillrouter/verdicts.json`.

`report` credits a check when the hinted skill is loaded in the same session, through `read_skill` or the native Skill tool, and counts decided / nudged turns and fired triggers.

`report` also prints a search-gate funnel per agent from the session logs on disk (kept 7 days): task turns, turns that did work and how many of those had no search or load, refusals, whether a search followed a refusal, whether a skill was loaded after a search, and how often the gate stepped aside. A search or load is read from the session's own records (the gate hook writes a `searched` row with `via: search` or `via: load`; the post-tool hook writes loads). A session whose hooks ran is judged on its own records alone. Only a session with none, as with Codex before its hook is trusted, borrows searches from the router's MCP log by agent and time; each MCP row is credited to one turn at most, one prompt counts once however often its hook ran, and the report says how many turns relied on the borrowed log, because it can still credit a search that belongs to another session of the same agent.

## How routing works

1. If a preloaded (core) skill clearly fits, the agent uses it.
2. Otherwise the prompt hook has already attached the confident library matches as hints ("use only if it fits"). A hint costs context on every prompt, so the gate is strict: with embeddings, a skill is shown on meaning alone (cosine 0.5 or more) or on meaning (0.4) plus at least two matched words that are rare in the library; without them, on the lexical floor plus two matched words, one of them rare. Prompts that point back at the conversation ("what's next", "do suggestion 2", "go ahead with your plan") get a hint only on unmistakable meaning (0.55). Calibrated on 57 real prompts from this machine in October 2026: hints went from 48 prompts to 13, and hints on prompts that needed none from 29 to 7. Everything weaker is left to `search_skills`, which the **search gate** makes unskippable on hosts with a blocking pre-tool hook: on a task turn (the prompt check marks it; conversational prompts, commands and system text are not tasks) the first edit or command that does more than read is refused with a message naming the next step, until the agent has called `search_skills` or loaded a skill that turn. After two refusals in a turn it steps aside, so an agent that cannot search is never stuck; subagents, reads and searches are never gated. Before it existed, Claude Code made 0 searches in a week and Codex 33 under the same written rule, and only 61 of 971 real task prompts had any skill loaded. Hooks cannot be blocked from the model's side, and every host fails open if the hook itself crashes. One exception to the hint gate's strictness: a skill the host has accepted in three or more turns and at least half the time (`skillrouter report` lists them as endorsed) passes on a lower bar, since a weak match for a skill the agent keeps using is worth more than a strong one for an unknown skill.
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

`skillrouter eval` scores the prompt check on labeled prompts: top-1 and top-3 accuracy of the ranked search, hint recall and precision through the real hint gate, the false-hint rate on prompts that should get nothing, and copies shown. The repository bundles a fixture library (`eval/skills`, 47 realistic skills with copies, siblings and generic stubs, plus 400 unrelated fillers so term rarity resembles a real library) and `eval/prompts.jsonl`; `eval --ci` fails below the floors in `DEFAULT_THRESHOLDS`, and GitHub Actions runs it with the tests on configured branches and pull requests; the release smoke also runs it from the installed npm artifact. `eval --live` runs the same metrics on your real index with `~/.skillrouter/eval.jsonl`; label prompts with `skillrouter eval add "<prompt>" <id,id|none>`. The lexical floor scales with the log of the library size (`minRawFor`), so a 450-skill library isn't held to a floor calibrated on 4,500.

## Reporting, diagnostics, and hook reliability

`report 7` counts successful MCP loads separately from skill use, and keeps traffic from probe/self-test MCP clients (client names containing `probe`, `selftest`, `regression`, `smoke`) out of the organic numbers. If an agent already gets a core skill from a plugin, `skillrouter core skip <id> <agent>` stops `core sync` from linking a duplicate into that agent's folder (stored as `pdf !claude` in `core.txt`). A shown hint gets credit only for a matching skill loaded within 30 minutes with its `hint_id`, or with matching agent/session identity. Earlier reads, other agents, mismatched sessions, and failed loads do not count. Legacy hints without correlation metadata are labeled unattributable. Some native skill/file reads are detected by host hooks; unobserved reads and actual application of a skill cannot be inferred from a successful MCP load.

`doctor` shows user-scope hook/MCP configuration for each agent, index age (flagged stale after 7 days), last observed hook and MCP activity, hook outcome counts, and failures over the last 7 days. Configuration presence does not verify trust, activation, or connectivity; project/plugin configuration may be outside its view. Newly installed MCP integrations set `SKILLROUTER_AGENT` for attribution. Hook session IDs are hashed; an optional `SKILLROUTER_SESSION_ID` on the MCP process supports matching sessions where a host can supply one. Hint IDs work without shared host session support.

Hooks call a fixed launcher, `~/.skillrouter/bin/skillrouter-hint <agent>`, and `install` rewrites only what the launcher execs, so a hook's command text (what Codex hashes for trust) never changes across upgrades. `install openclaude antigravity hermes` wires the MCP server into hosts that have no prompt hooks (Hermes through its own config API). `doctor --live` starts every configured server and lists its tools, which is the connectivity proof plain `doctor` can't give. Hint lines carry a "when:" trigger and say exactly how to load the skill (preloaded → Skill tool; otherwise `read_skill(id, hint_id=…)`). The lexical hint gate uses a library-size-adjusted floor (or explicit `SKILLROUTER_MIN_RAW`) and proximity to the strongest result; optional semantic vectors use the combined gate described above. Search adds query-side synonyms, a name-match bonus and plural folding.

The installer pins the MCP server to the current package's absolute CLI path and to a Node binary no other tool manages (not one under `~/.hermes` or `node_modules`; override with `SKILLROUTER_NODE=/path/to/node`). `dist/` is committed; runtime dependencies must also be installed before a plugin can start. Keep that installation available and rerun `install` after moving/upgrading it; `--local` remains accepted for compatibility. Hooks never run npm or embeddings. Input is limited to 256 KiB for prompt checks and 8 MiB for tool and Stop events, with a 1.5-second stdin deadline; matching runs in a killable worker with a separate 1.5-second deadline. Failures return the host's empty/continue response and record an outcome. OpenCode additionally caps the subprocess wait at 2 seconds. These budgets exclude host and initial Node startup time.

Repeated installation replaces existing router hooks while preserving unrelated hook commands. Existing host configs receive first-copy backups before installer edits; keep a separate current snapshot when upgrading. Existing multiline TOML command/args require manual adjustment; the installer refuses to rewrite that syntax.


## Source map

| Concern | Source |
| --- | --- |
| CLI and installation | `src/cli.ts`, `src/install.ts`, `src/platform.ts` |
| Index, matching and embeddings | `src/index.ts`, `src/search.ts`, `src/bm25.ts`, `src/embed.ts` |
| Hint lifecycle | `src/hint.ts`, `src/events.ts`, `src/triggers.ts`, `src/verdicts.ts` |
| MCP and reporting | `src/mcp.ts`, `src/report.ts`, `src/funnel.ts`, `src/health.ts`, `src/live.ts` |
| Recovery and service | `src/trim.ts`, `src/restore.ts`, `src/service.ts`, `src/service-client.ts` |
