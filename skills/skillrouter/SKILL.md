---
name: skillrouter
description: Use when a task is non-trivial and no preloaded skill clearly fits, when the user asks which skill to use, or when the user wants to manage, trim or audit a large skill library. Routes to the right skill via search_skills/read_skill and runs skillrouter maintenance commands.
---

# skillrouter

Only a small core of skills is preloaded in this session. The full library is behind the `skillrouter` MCP server.

## Routing (every non-trivial task)

1. Use every preloaded skill that fits.
2. For each distinct part of the task no preloaded skill covers (tests, a migration, the UI, a review), call `search_skills` with that part's intent as one short phrase (e.g. "postgres migration add index", "landing page conversion audit"). Do not paste the whole prompt.
3. `read_skill(id)` every hit whose description matches its part. Usually 1-3 skills; load all that fit, not just the first.
4. Before starting the work, write one line: `Skills: <ids>` or `Skills: none (<why>)`. End your final answer with the same line, updated if you loaded more along the way.

skillrouter attaches "Skill check (skillrouter)" notes: on the user's prompt, and mid-task when what you do (editing tests, a Dockerfile, a migration; running docker, kubectl, git rebase) points at a skill. Judge each candidate by its "when" line; load the ones that fit exactly as the note says, copying its `hint_id` into `read_skill` so reporting can credit the hint. If a turn did real work after a note without loading a skill or writing the `Skills:` line, the Stop hook sends it back once to decide. A load is not evidence that the skill was used.

## Maintenance commands (run with the host shell)

Use the installed `skillrouter` binary. For an unpublished source checkout without a global binary, run `node /absolute/path/to/skillrouter/dist/src/cli.js` with the same arguments; do not fetch an unpublished package with npx.

| Need | Command |
|---|---|
| See what each agent preloads and what it costs | `skillrouter doctor` |
| Rebuild the index after adding skills | `skillrouter index` |
| Review the core list / add / remove | `skillrouter core list` / `core add <id>` / `core remove <id>` |
| Promote often-read skills to core | `skillrouter core suggest` then `core add …` then `core sync` |
| Move the long tail out of agent folders (dry run first) | `skillrouter trim` then `trim --apply` |
| Usage and whether hints helped | `skillrouter report 7` |

`trim --apply` tars each folder into `~/.skillrouter/backups/` first and writes a JSON restore manifest; nothing is deleted except broken symlinks. Always show the dry-run numbers and get a yes before `--apply`.

Restore from the JSON manifest with `skillrouter restore "<manifest.json>"` (dry run), then `--apply` only when authorized. It brings back what trim removed, skill by skill, keeps identical files, and skips and lists skills that changed since the trim; it never overwrites. Do not delete agent folders to restore.
