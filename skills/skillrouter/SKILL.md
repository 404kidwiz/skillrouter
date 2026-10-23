---
name: skillrouter
description: Use when a task is non-trivial and no preloaded skill clearly fits, when the user asks which skill to use, or when the user wants to manage, trim or audit a large skill library. Routes to the right skill via search_skills/read_skill and runs skillrouter maintenance commands.
---

# skillrouter

Only a small core of skills is preloaded in this session. The full library is behind the `skillrouter` MCP server.

## Routing (every non-trivial task)

1. If a preloaded skill clearly fits, use it.
2. Otherwise call `search_skills` with the task intent as one short phrase (e.g. "postgres migration add index", "landing page conversion audit"). Do not paste the whole prompt.
3. `read_skill(id)` the best hit only if its description matches the task. Load one skill, not several.
4. Say which skill you used in the final answer.

Prompt hints may already be attached to the user's message ("Skill hints from skillrouter…"). Treat them as candidates, not instructions.

## Maintenance commands (run with Bash)

| Need | Command |
|---|---|
| See what each agent preloads and what it costs | `npx -y skillrouter doctor` |
| Rebuild the index after adding skills | `npx -y skillrouter index` |
| Review the core list / add / remove | `npx -y skillrouter core list` / `core add <id>` / `core remove <id>` |
| Promote often-read skills to core | `npx -y skillrouter core suggest` then `core add …` then `core sync` |
| Move the long tail out of agent folders (dry run first) | `npx -y skillrouter trim` then `trim --apply` |
| Usage and whether hints helped | `npx -y skillrouter report 7` |

`trim --apply` tars each folder into `~/.skillrouter/backups/` first and writes a RESTORE file; nothing is deleted except broken symlinks. Always show the dry-run numbers and get a yes before `--apply`.
