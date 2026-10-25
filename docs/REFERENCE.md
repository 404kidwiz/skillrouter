# Command and configuration reference

[Back to README](../README.md) · [Installation](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)

Examples run from the checkout. After optional global installation, `skillrouter` can replace `node dist/src/cli.js`. Angle-bracket values below are placeholders, not shell-ready arguments.

## Discovery and diagnostics

| Command | Purpose |
| --- | --- |
| `node dist/src/cli.js doctor` | Inspect index age, preload estimates, service and observed host activity |
| `node dist/src/cli.js doctor --live claude cursor` | Start selected configured MCP processes and list tools |
| `node dist/src/cli.js index` | Rebuild from defaults and remembered extra roots |
| `node dist/src/cli.js index --root "/absolute/path/to/skills"` | Include another library root; repeat the flag for several roots |
| `node dist/src/cli.js search "postgres migration" -k 5` | Inspect ranked matches from the shell |

Indexing scans supported agent directories, the shared `~/.agents/skills`, `~/.skills`, the router library and explicit roots. It does not import a remote library. Run it after adding, moving or removing skills.

A search with no matches is not necessarily an error. Check roots and descriptions before changing ranking thresholds. A live doctor exit code alone is insufficient: inspect the per-host result.

## Core, trim and recovery

### Choose a real core

```sh
node dist/src/cli.js core list
node dist/src/cli.js core suggest 10
```

Select IDs that exist in your own index:

```text
node dist/src/cli.js core add <id>...
node dist/src/cli.js core remove <id>...
node dist/src/cli.js core sync claude cursor
```

`core sync` changes directory links; it is not a read-only preview. It can remove links previously managed for skills no longer in core. Narrow its targets deliberately. Some hosts share the same `~/.agents/skills` directory, so a shared-folder change can affect more than one reader.

For a skill a host already receives from a plugin:

```text
node dist/src/cli.js core skip <id> claude
node dist/src/cli.js core unskip <id> claude
```

Run the appropriate sync after changing skip markers. Keep the core small enough to be useful; there is no universal correct size or fixed token savings.

### Preview before moving

```sh
node dist/src/cli.js trim claude
```

Review counts and selected host folders. Only after deciding to move those contents:

```sh
node dist/src/cli.js trim claude --apply
node dist/src/cli.js index
node dist/src/cli.js core sync claude
```

Trim defaults to a dry run. Omitting targets covers all five trim-capable agents, so explicit names are safer. `--keep NAME` preserves additional folders for that run.

Real non-core folders move to the library. Usable links are recreated there and removed from the source; dangling links are removed. Same-name variants go under `library/.conflicts`. Dot entries, plugin-format folders and directly linked skill roots are retained/skipped. Linked or invalid agent ancestors are rejected before any requested source moves.

Trim writes tar backups and a JSON manifest identifying original paths and checksums before moving source contents. If a later operation fails, retain the printed recovery files. Hermes's separate skill system is outside this trim command.

### Recover to original paths

Use the exact manifest printed by trim:

```text
node dist/src/cli.js restore "<absolute-manifest-path>"
node dist/src/cli.js restore "<absolute-manifest-path>" --apply
```

Use shell-safe quoting for the actual path. The generated recovery Markdown supplies separately quoted PowerShell and POSIX examples. Its short `skillrouter` command assumes a global binary; otherwise substitute your quoted absolute Node/CLI invocation.

Restore previews by default. It brings back only what trim removed (moved folders, re-created links, dropped broken links), skill by skill: missing files are added and identical ones left alone. A skill that changed since the trim, because it was edited, re-added by `core sync` or replaced, is skipped as a whole and listed; its current version is kept and nothing is overwritten. Skills trim kept in place are not touched, so later edits or deliberate deletions of them stand. Archive and file hashes are verified, every needed file is staged before any agent folder changes, and an agent folder is never deleted. Each archive is extracted once, into a private staging folder next to the backups, so restore needs free space about the size of the archives it reads.

Version 2 manifests record removed entries; version 1 manifests lack that list and consider the whole recorded inventory. Inspect the preview when recovering an older backup.

Use only your own trusted manifests with their accompanying archives, in the original user's home. Library copies and backups remain after restoration. Supported file modes and bytes are restored; hardlink identity, ACLs, extended attributes and timestamps are not promised. Legacy tar-only backups need manual recovery to the original agent folder.

## MCP interface

Start a stdio MCP server:

```sh
node dist/src/cli.js mcp
```

It waits for MCP protocol messages; this is not an interactive shell command.

| Tool | Arguments | Result |
| --- | --- | --- |
| `search_skills` | `query`: short intent; optional `top_k`: integer 1–20, default 5 | Ranked IDs, descriptions, scores and local paths |
| `read_skill` | `id`: returned ID; optional `hint_id` copied from a hint | Full matching SKILL.md body, or a useful not-found/ambiguity/read error |

Example calls, inside an MCP-capable agent:

```json
{"query":"python async testing","top_k":3}
```

Use an ID from that response in `read_skill`. Do not assume a similarly named skill exists in every user's library.

A conceptual manual MCP entry is below. Adapt its container/schema to the host; OpenCode and other hosts use different configuration dialects.

```json
{
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/skillrouter/dist/src/cli.js", "mcp"],
  "env": { "SKILLROUTER_AGENT": "your-host-name" }
}
```

Keep command and args separate, and escape Windows backslashes in JSON. Do not place shell commands or secrets in this example.

## Reports, suppression and evaluation

| Command | Purpose |
| --- | --- |
| `node dist/src/cli.js report 7` | Recent searches, reads, hints, decisions, attribution, and the search-gate funnel per agent |
| `node dist/src/cli.js suppress` | Skills held back after repeated declines |
| `node dist/src/cli.js suppress keep <id>` | Exempt a skill from suppression |
| `node dist/src/cli.js suppress unkeep <id>` | Remove that exemption |
| `node dist/src/cli.js suppress reset <id>` | Forget that skill's suppression history |
| `node dist/src/cli.js expand [--url U] [--model M] [--concurrency N] [--limit N]` | Optional: have a local Ollama model write three example requests and six keywords per skill into `~/.skillrouter/expansions.jsonl`; resumable, one request per distinct description. `index --embeddings` then embeds them with the skill |
| `node dist/src/cli.js expand status` | How many skills have an expansion that still matches their text, and how many stored rows match nothing now |

Search still finds suppressed skills. Successful loading does not prove an agent followed the instructions. Probe/self-test traffic is separated from ordinary usage where client names identify it.

```sh
node dist/src/cli.js eval --ci
node dist/src/cli.js eval --live --lexical
```

The first command evaluates the bundled synthetic fixture and enforces its thresholds. The second evaluates live labels against your index without semantic blending. Add your own labels with `eval add "<prompt>" <id,id|none>`; avoid secrets because these prompts are stored locally.

## Service and configuration

```sh
node dist/src/cli.js service status
node dist/src/cli.js service restart
node dist/src/cli.js service stop
```

Hooks can restart a stopped service. Disable service use in the relevant process environment if you need standalone behavior. The warm service uses a Unix socket on macOS/Linux and an authenticated named pipe on Windows. Failure falls back to standalone execution.

| Environment variable | Meaning |
| --- | --- |
| `SKILLROUTER_HOME` | State directory; default `~/.skillrouter`. Set consistently across processes |
| `SKILLROUTER_NODE` | Node executable override used when installing adapters |
| `SKILLROUTER_AGENT` | Usage attribution for an MCP process |
| `SKILLROUTER_SESSION_ID` | Optional session correlation; hashed before logging |
| `SKILLROUTER_SERVICE=0` | Disable warm-service use for that process |
| `SKILLROUTER_GATE=0` | Turn the search gate off (it holds the first edit or command of a task turn until the agent has searched or loaded a skill). Read from the hook's environment, so it works whether or not the warm service is running |

Advanced tuning:

| Variable | Meaning |
| --- | --- |
| `SKILLROUTER_SERVICE_IDLE_MIN` | Service idle shutdown interval; default 30 minutes |
| `SKILLROUTER_MIN_RAW` | Explicit lexical floor; default otherwise scales with library size |
| `SKILLROUTER_EXPAND_URL` / `SKILLROUTER_EXPAND_MODEL` | Ollama base URL (default `http://127.0.0.1:11434`) and model (default `qwen3:8b`) for `expand`; the flags win |
| `SKILLROUTER_ENDORSE_AFTER` | Accepted turns before a host's skill passes the hint gate on a lower bar (default 3; 0 turns it off) |
| `SKILLROUTER_SUPPRESS_AFTER` | Decline-session threshold; default 5; 0 disables suppression |

For example, run standalone diagnostics in a POSIX shell:

```sh
SKILLROUTER_SERVICE=0 node dist/src/cli.js doctor
```

In PowerShell:

```powershell
$env:SKILLROUTER_SERVICE = "0"
node dist/src/cli.js doctor
Remove-Item Env:SKILLROUTER_SERVICE
```

These examples affect the terminal process environment, not necessarily an already-running GUI agent. Save the intended setting through the host's supported environment mechanism when needed.

### Optional embeddings

Lexical routing is the default. Semantic routing requires the optional `@huggingface/transformers` dependency and a local model download, plus `index --embeddings`. Follow your dependency-management workflow and expect extra disk/memory use; do not silently add it during ordinary setup.

An existing vector store also causes subsequent index rebuilds to attempt refreshing embeddings. Stale or unavailable vectors fall back to lexical matching. Use `doctor` to inspect vector state and [architecture](ARCHITECTURE.md) for scoring details.

## State layout

```text
~/.skillrouter/
  index.json       paths and skill metadata
  core.txt         selected IDs and per-agent skip markers
  core/            managed core links
  library/         trimmed skills; .conflicts/ retains variants
  usage.jsonl      events, model-written queries and attribution
  verdicts.json    acceptance/decline history and suppression
  run/             socket/pipe state, PID, status, Windows key
  backups/         trim archives plus restore JSON and Markdown
```

Other state files support vectors, triggers and session decisions. Treat this directory as private data, not a folder to commit or erase casually. Configuration backups beside host files may contain credentials.

