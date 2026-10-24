#!/usr/bin/env node
import { AGENTS, SR_DIR } from "./paths.js";
// Everything else is imported where used: hooks run on every prompt and tool call, so they load only what they need.
const USAGE = `skillrouter — a big skill library without the context bloat

  skillrouter doctor [--live] [agents]   what each agent preloads today and what it costs; --live starts each configured MCP server
  skillrouter index [--root DIR]... [--embeddings]
                                          scan every skill folder into ~/.skillrouter/index.json (+ local vectors)
  skillrouter search "<task>" [-k N]     try the router from the shell
  skillrouter core list|add <id>...|remove <id>...|suggest [N]|sync [agents]
                                          the small set every agent preloads (sync relinks agent folders)
  skillrouter core skip|unskip <id> <agent>...
                                          don't link a core skill for agents that already have it (e.g. via a plugin)
  skillrouter trim [agents] [--apply] [--keep NAME]...
                                          move everything except core out of agent folders (dry run by default)
  skillrouter install <agent>...         wire MCP + hooks: claude codex cursor gemini opencode; MCP only: openclaude antigravity hermes
  skillrouter report [days]              who searched, what got loaded, did checks help, per-skill accept rates
  skillrouter suppress [keep|unkeep|reset] [id]...
                                          skills held back after repeated declines; keep exempts one, reset forgets counts
  skillrouter mcp                        stdio MCP server (search_skills, read_skill)
  skillrouter hint <agent> [tool|stop]   hooks: prompt check (default), PostToolUse triggers, Stop decision
`;
function flag(args, name) { const i = args.indexOf(name); if (i >= 0) {
    args.splice(i, 1);
    return true;
} return false; }
function opt(args, name) { const out = []; for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    out.push(args[i + 1]);
    args.splice(i, 2);
} return out; }
function agentsFrom(args) { const a = args.filter((x) => AGENTS.includes(x)); return a.length ? a : AGENTS; }
/** Write and exit: a worker must not linger on pending work (a slow model load) after its answer is out. */
function finish(out, exit) {
    return new Promise((resolve) => {
        if (!out) {
            if (exit)
                process.exit(0);
            resolve();
            return;
        }
        process.stdout.write(out + "\n", () => { if (exit)
            process.exit(0); resolve(); });
    });
}
async function main(argv) {
    const [cmd, ...args] = argv;
    switch (cmd) {
        case "hint":
        case "hint-worker": {
            const agent = args[0];
            const mode = args[1];
            if (!AGENTS.includes(agent))
                return;
            const { readHintInput, runHint, formatHint, hint } = await import("./hint.js");
            const worker = cmd === "hint-worker";
            const input = await readHintInput(agent, 1500, mode ? 8 * 1024 * 1024 : 256 * 1024);
            if (input === null)
                return finish(mode ? "" : formatHint(agent, ""), worker);
            if (mode === "stop") {
                const { stopEvent } = await import("./events.js");
                return finish(stopEvent(agent, input), worker);
            }
            if (mode === "decision") {
                const { decisionEvent } = await import("./events.js");
                return finish(decisionEvent(agent, input), worker);
            }
            if (mode === "tool") {
                const { toolEvent } = await import("./events.js");
                const first = await toolEvent(agent, input, worker);
                return finish(typeof first === "string" ? first : await runHint(agent, first.spawn, process.argv[1], 1500, "tool"), worker);
            }
            return finish(worker ? await hint(agent, input) : await runHint(agent, input, process.argv[1]), worker);
        }
        case "doctor": {
            const live = flag(args, "--live");
            const { doctor } = await import("./report.js");
            console.log(doctor());
            if (live) {
                const { liveCheck } = await import("./live.js");
                const { INSTALL_TARGETS } = await import("./install.js");
                const targets = args.filter((x) => INSTALL_TARGETS.includes(x));
                console.log("\nLive MCP check (each configured server started and asked for its tools):");
                console.log((await liveCheck((targets.length ? targets : INSTALL_TARGETS))).join("\n"));
            }
            break;
        }
        case "index": {
            const { buildIndex, loadIndex, saveIndex } = await import("./index.js");
            const { embed, vectorsExist, saveVectors, skillText } = await import("./embed.js");
            const withEmb = flag(args, "--embeddings");
            // Extra roots stick: an index rebuilt without --root keeps the roots of the previous one.
            const roots = opt(args, "--root");
            const index = buildIndex(roots.length ? roots : (loadIndex()?.roots ?? []));
            saveIndex(index);
            // Vectors are rebuilt with the index once a vector store exists. They carry the index's builtAt,
            // so if this step fails the old vectors read as stale and hints fall back to lexical.
            let vec = "";
            if (withEmb || vectorsExist()) {
                try {
                    const rows = [];
                    const texts = index.skills.map(skillText);
                    for (let i = 0; i < texts.length; i += 64)
                        rows.push(...(await embed(texts.slice(i, i + 64), true)));
                    saveVectors(index.skills.map((s) => s.id), rows, index.builtAt);
                    vec = " with embeddings";
                }
                catch (e) {
                    vec = ` (embeddings not rebuilt: ${e.message}; hints use BM25 until \`index --embeddings\` succeeds)`;
                    process.exitCode = 1;
                }
            }
            console.log(`Indexed ${index.skills.length} skills from ${index.roots.length} folders${vec} -> ${SR_DIR}/index.json`);
            break;
        }
        case "search": {
            const { search } = await import("./search.js");
            const { coreIds } = await import("./core.js");
            const k = Number(opt(args, "-k")[0] ?? 5);
            for (const h of await search(args.join(" "), k, { prefer: coreIds() }))
                console.log(`${h.score.toFixed(2)} (raw ${h.raw}${h.cos !== undefined ? `, cos ${h.cos}` : ""})  ${h.skill.id}  —  ${h.skill.description.slice(0, 110)}${h.similar?.length ? `  [similar: ${h.similar.join(", ")}]` : ""}`);
            break;
        }
        case "core": {
            const { readCore, writeCore, syncCore, suggestCore, skipCore } = await import("./core.js");
            const [sub, ...rest] = args;
            if (sub === "list")
                console.log(readCore().join("\n") || "(empty core — try: skillrouter core suggest)");
            else if (sub === "add")
                writeCore([...readCore(), ...rest]);
            else if (sub === "remove")
                writeCore(readCore().filter((id) => !rest.includes(id)));
            else if (sub === "suggest") {
                const { readCounts } = await import("./report.js");
                const ids = suggestCore(readCounts(90), Number(rest[0] ?? 30));
                console.log(ids.length ? ids.join("\n") : "No reads logged yet. Add skills you use with: skillrouter core add <id>...");
            }
            else if (sub === "sync") {
                const r = syncCore(agentsFrom(rest));
                console.log(`linked ${r.linked} core skills${r.skipped ? `, ${r.skipped} agent-specific skips honored` : ""}${r.unlinked ? `, ${r.unlinked} removed-from-core links taken out of agent folders` : ""}${r.missing.length ? `; not found: ${r.missing.join(", ")}` : ""}`);
            }
            else if (sub === "skip" || sub === "unskip") {
                const [id, ...names] = rest;
                const agents = names.filter((x) => AGENTS.includes(x)); // never default to "all" here
                const ok = id && agents.length === names.length && agents.length > 0 && skipCore(id, agents, sub === "skip");
                console.log(ok ? `${id}: ${sub === "skip" ? "not linked for" : "linked again for"} ${agents.join(", ")} (run: skillrouter core sync)` : `usage: skillrouter core ${sub} <id> <agent>...  (id must already be in core; agents: ${AGENTS.join(" ")})`);
            }
            else
                console.log(USAGE);
            break;
        }
        case "trim": {
            const { trim } = await import("./trim.js");
            const apply = flag(args, "--apply");
            const keep = opt(args, "--keep");
            const s = trim(agentsFrom(args), apply, keep);
            console.log(`${apply ? "Applied" : "Dry run"}: move ${s.moved} folders, re-link ${s.linked} links, drop ${s.dangling} broken links, keep ${s.kept}, ${s.conflicts} same-name conflicts kept under library/.conflicts`);
            if (apply) {
                console.log("Backups:\n  " + s.backups.join("\n  "));
                console.log("Next: skillrouter index && skillrouter core sync");
            }
            else
                console.log("Nothing changed. Re-run with --apply.");
            break;
        }
        case "install": {
            const { install, NODE, INSTALL_TARGETS } = await import("./install.js");
            const targets = args.filter((x) => INSTALL_TARGETS.includes(x));
            console.log(`Node pinned for hooks and MCP: ${NODE} (override with SKILLROUTER_NODE=/path/to/node)`);
            const seen = new Set();
            for (const a of (targets.length ? targets : INSTALL_TARGETS))
                for (const line of install(a))
                    if (!seen.has(line)) {
                        seen.add(line);
                        console.log(line);
                    }
            break;
        }
        case "suppress": {
            const { readVerdicts, suppressedByAgent, setKeep, resetVerdicts, suppressAfter } = await import("./verdicts.js");
            const [sub, ...ids] = args;
            if (sub === "keep" || sub === "unkeep") {
                if (!ids.length) {
                    console.log(`usage: skillrouter suppress ${sub} <id>...`);
                    process.exitCode = 1;
                    break;
                }
                const kept = setKeep(ids, sub === "keep");
                if (!kept) {
                    console.log("verdicts.json is busy (another hook is writing); try again");
                    process.exitCode = 1;
                    break;
                }
                console.log(`kept (never held back): ${kept.join(", ") || "none"}`);
            }
            else if (sub === "reset") {
                const n = resetVerdicts(ids);
                if (n === undefined) {
                    console.log("verdicts.json is busy (another hook is writing); try again");
                    process.exitCode = 1;
                    break;
                }
                console.log(`forgot decision counts for ${n} skill(s)`);
            }
            else if (sub && sub !== "list") {
                console.log(USAGE);
                process.exitCode = 1;
            }
            else {
                const v = readVerdicts();
                const byAgent = suppressedByAgent(v);
                console.log(suppressAfter() > 0 ? `Held back after declines in ${suppressAfter()}+ sessions with under 10% accepted, per host, for 30 days (SKILLROUTER_SUPPRESS_AFTER; 0 = off):` : "Suppression is off (SKILLROUTER_SUPPRESS_AFTER=0).");
                for (const [agent, held] of byAgent)
                    for (const id of held)
                        console.log(`  ${agent}: ${id}: accepted ${v.agents[agent][id].accepted} of ${v.agents[agent][id].shown}, last ${v.agents[agent][id].last.slice(0, 10)}`);
                if (!byAgent.size)
                    console.log("  none");
                if (v.keep.length)
                    console.log(`Kept (never held back): ${v.keep.join(", ")}`);
            }
            break;
        }
        case "report": {
            const { report } = await import("./report.js");
            console.log(report(Number(args[0] ?? 7)));
            break;
        }
        case "mcp": {
            const { serveMcp } = await import("./mcp.js");
            await serveMcp();
            break;
        }
        default:
            console.log(USAGE);
            if (cmd && cmd !== "--help" && cmd !== "-h")
                process.exitCode = 1;
    }
}
main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
