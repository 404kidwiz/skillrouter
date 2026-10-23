#!/usr/bin/env node
import fs from "node:fs";
import { buildIndex, loadIndex, saveIndex } from "./index.js";
import { search, embed, getIndex } from "./search.js";
import { hint } from "./hint.js";
import { serveMcp } from "./mcp.js";
import { readCore, writeCore, syncCore, suggestCore } from "./core.js";
import { trim } from "./trim.js";
import { install } from "./install.js";
import { doctor, report, readCounts } from "./report.js";
import { AGENTS, SR_DIR, type AgentId } from "./paths.js";

const USAGE = `skillrouter — a big skill library without the context bloat

  skillrouter doctor                     what each agent preloads today and what it costs
  skillrouter index [--root DIR]... [--embeddings]
                                          scan every skill folder into ~/.skillrouter/index.json
  skillrouter search "<task>" [-k N]     try the router from the shell
  skillrouter core list|add <id>...|remove <id>...|suggest [N]|sync [agents]
                                          the small set every agent preloads (sync relinks agent folders)
  skillrouter trim [agents] [--apply] [--keep NAME]...
                                          move everything except core out of agent folders (dry run by default)
  skillrouter install <agent>... [--local] wire MCP + prompt hook: claude codex cursor gemini opencode (--local = this checkout, no npm)
  skillrouter report [days]              who searched, what got read, did hints help
  skillrouter mcp                        stdio MCP server (search_skills, read_skill)
  skillrouter hint <agent>               prompt hook: reads hook JSON on stdin
`;

function flag(args: string[], name: string): boolean { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; }
function opt(args: string[], name: string): string[] { const out: string[] = []; for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) { out.push(args[i + 1]); args.splice(i, 2); } return out; }
function agentsFrom(args: string[]): AgentId[] { const a = args.filter((x): x is AgentId => (AGENTS as string[]).includes(x)); return a.length ? a : AGENTS; }

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "doctor": console.log(doctor()); break;
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
      } else if (sub === "sync") { const r = syncCore(agentsFrom(rest)); console.log(`linked ${r.linked} core skills${r.missing.length ? `; not found: ${r.missing.join(", ")}` : ""}`); }
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
    case "install": for (const a of agentsFrom(args)) for (const line of install(a)) console.log(line); break;
    case "report": console.log(report(Number(args[0] ?? 7))); break;
    case "mcp": await serveMcp(); break;
    case "hint": {
      const agent = args[0] as AgentId;
      if (!AGENTS.includes(agent)) { process.stdout.write(""); return; }
      const input = fs.readFileSync(0, "utf8");
      const out = await hint(agent, input);
      if (out) process.stdout.write(out + "\n");
      break;
    }
    default: console.log(USAGE); if (cmd && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
void getIndex;
