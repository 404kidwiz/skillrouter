#!/usr/bin/env node
import { buildIndex, loadIndex, saveIndex } from "./index.js";
import { search, embed, getIndex } from "./search.js";
import { hint, runHint, readHintInput, formatHint } from "./hint.js";
import { serveMcp } from "./mcp.js";
import { readCore, writeCore, syncCore, suggestCore, skipCore } from "./core.js";
import { trim } from "./trim.js";
import { install, NODE, INSTALL_TARGETS, type InstallTarget } from "./install.js";
import { liveCheck } from "./live.js";
import { doctor, report, readCounts } from "./report.js";
import { AGENTS, SR_DIR, type AgentId } from "./paths.js";

const USAGE = `skillrouter — a big skill library without the context bloat

  skillrouter doctor [--live] [agents]   what each agent preloads today and what it costs; --live starts each configured MCP server
  skillrouter index [--root DIR]... [--embeddings]
                                          scan every skill folder into ~/.skillrouter/index.json
  skillrouter search "<task>" [-k N]     try the router from the shell
  skillrouter core list|add <id>...|remove <id>...|suggest [N]|sync [agents]
                                          the small set every agent preloads (sync relinks agent folders)
  skillrouter core skip|unskip <id> <agent>...
                                          don't link a core skill for agents that already have it (e.g. via a plugin)
  skillrouter trim [agents] [--apply] [--keep NAME]...
                                          move everything except core out of agent folders (dry run by default)
  skillrouter install <agent>...         wire MCP + prompt hook: claude codex cursor gemini opencode; MCP only: openclaude antigravity hermes
  skillrouter report [days]              who searched, what got read, did hints help
  skillrouter mcp                        stdio MCP server (search_skills, read_skill)
  skillrouter hint <agent>               prompt hook: reads hook JSON on stdin
`;

function flag(args: string[], name: string): boolean { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; }
function opt(args: string[], name: string): string[] { const out: string[] = []; for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) { out.push(args[i + 1]); args.splice(i, 2); } return out; }
function agentsFrom(args: string[]): AgentId[] { const a = args.filter((x): x is AgentId => (AGENTS as string[]).includes(x)); return a.length ? a : AGENTS; }
function targetsFrom(args: string[]): InstallTarget[] { const a = args.filter((x): x is InstallTarget => (INSTALL_TARGETS as string[]).includes(x)); return a.length ? a : INSTALL_TARGETS; }

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "doctor": {
      const live = flag(args, "--live");
      console.log(doctor());
      if (live) { console.log("\nLive MCP check (each configured server started and asked for its tools):"); console.log((await liveCheck(targetsFrom(args))).join("\n")); }
      break;
    }
    case "index": {
      const withEmb = flag(args, "--embeddings");
      // Extra roots stick: an index rebuilt without --root keeps the roots of the previous one.
      const roots = opt(args, "--root");
      const index = buildIndex(roots.length ? roots : (loadIndex()?.roots ?? []));
      if (withEmb) {
        const vecs = await embed(index.skills.map((s) => `${s.name}: ${s.description}`));
        index.embeddings = Object.fromEntries(index.skills.map((s, i) => [s.id, vecs[i].map((x) => Math.round(x * 1e4) / 1e4)]));
      }
      saveIndex(index);
      console.log(`Indexed ${index.skills.length} skills from ${index.roots.length} folders${withEmb ? " with embeddings" : ""} -> ${SR_DIR}/index.json`);
      break;
    }
    case "search": {
      const k = Number(opt(args, "-k")[0] ?? 5);
      for (const h of await search(args.join(" "), k)) console.log(`${h.score.toFixed(2)} (raw ${h.raw})  ${h.skill.id}  —  ${h.skill.description.slice(0, 110)}`);
      break;
    }
    case "core": {
      const [sub, ...rest] = args;
      if (sub === "list") console.log(readCore().join("\n") || "(empty core — try: skillrouter core suggest)");
      else if (sub === "add") writeCore([...readCore(), ...rest]);
      else if (sub === "remove") writeCore(readCore().filter((id) => !rest.includes(id)));
      else if (sub === "suggest") {
        const ids = suggestCore(readCounts(90), Number(rest[0] ?? 30));
        console.log(ids.length ? ids.join("\n") : "No reads logged yet. Add skills you use with: skillrouter core add <id>...");
      } else if (sub === "sync") { const r = syncCore(agentsFrom(rest)); console.log(`linked ${r.linked} core skills${r.skipped ? `, ${r.skipped} agent-specific skips honored` : ""}${r.unlinked ? `, ${r.unlinked} removed-from-core links taken out of agent folders` : ""}${r.missing.length ? `; not found: ${r.missing.join(", ")}` : ""}`); }
      else if (sub === "skip" || sub === "unskip") {
        const [id, ...names] = rest;
        const agents = names.filter((x): x is AgentId => (AGENTS as string[]).includes(x)); // never default to "all" here
        const ok = id && agents.length === names.length && agents.length > 0 && skipCore(id, agents, sub === "skip");
        console.log(ok ? `${id}: ${sub === "skip" ? "not linked for" : "linked again for"} ${agents.join(", ")} (run: skillrouter core sync)` : `usage: skillrouter core ${sub} <id> <agent>...  (id must already be in core; agents: ${AGENTS.join(" ")})`);
      }
      else console.log(USAGE);
      break;
    }
    case "trim": {
      const apply = flag(args, "--apply");
      const keep = opt(args, "--keep");
      const s = trim(agentsFrom(args), apply, keep);
      console.log(`${apply ? "Applied" : "Dry run"}: move ${s.moved} folders, re-link ${s.linked} links, drop ${s.dangling} broken links, keep ${s.kept}, ${s.conflicts} same-name conflicts kept under library/.conflicts`);
      if (apply) { console.log("Backups:\n  " + s.backups.join("\n  ")); console.log("Next: skillrouter index && skillrouter core sync"); }
      else console.log("Nothing changed. Re-run with --apply.");
      break;
    }
    case "install":
      console.log(`Node pinned for hooks and MCP: ${NODE} (override with SKILLROUTER_NODE=/path/to/node)`);
      { const seen = new Set<string>(); for (const a of targetsFrom(args)) for (const line of install(a)) if (!seen.has(line)) { seen.add(line); console.log(line); } }
      break;
    case "report": console.log(report(Number(args[0] ?? 7))); break;
    case "mcp": await serveMcp(); break;
    case "hint":
    case "hint-worker": {
      const agent = args[0] as AgentId;
      if (!AGENTS.includes(agent)) { process.stdout.write(""); return; }
      const input = await readHintInput(agent);
      if (input === null) { process.stdout.write(formatHint(agent, "")); return; }
      const out = cmd === "hint"
        ? await runHint(agent, input, process.argv[1])
        : await hint(agent, input);
      if (out) process.stdout.write(out + "\n");
      break;
    }
    default: console.log(USAGE); if (cmd && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
void getIndex;
