#!/usr/bin/env node
import { AGENTS, SR_DIR } from "./paths.js";
// Everything else is imported where used: hooks run on every prompt and tool call, so they load only what they need.
const NO_SERVICE = "The warm service is not available on Windows yet. Hooks run on their own and work the same, just a little slower.";
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
  skillrouter eval [-v] [--ci]           routing quality on the bundled fixture (what CI runs)
  skillrouter eval --live [file] [--lexical] [-v] [--ci]
                                          the same on the real index and ~/.skillrouter/eval.jsonl
  skillrouter eval add "<prompt>" <id,id|none>
                                          label a prompt for the live eval
  skillrouter report [days]              who searched, what got loaded, did checks help, per-skill accept rates
  skillrouter suppress [keep|unkeep|reset] [id]...
                                          skills held back after repeated declines; keep exempts one, reset forgets counts
  skillrouter mcp                        stdio MCP server (search_skills, read_skill)
  skillrouter hint <agent> [tool|stop]   hooks: prompt check (default), PostToolUse triggers, Stop decision
  skillrouter service [status|start|stop|restart]
                                          the warm background service hooks talk to (starts itself; SKILLROUTER_SERVICE=0 turns it off)
  skillrouter serve [--start]            run the service in the foreground (--start: make sure one is running, then return)
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
            // The warm service answers in milliseconds when it is running; any failure falls through to doing the work here.
            if (!worker) {
                const { serviceEnabled, ask, startServiceSoon } = await import("./service-client.js");
                if (serviceEnabled() && process.env.SKILLROUTER_SERVICE_TRIED !== "1") {
                    const answer = await ask(agent, mode ?? "-", input);
                    if (answer.kind === "ok")
                        return finish(answer.out, false);
                    if (answer.kind === "failed")
                        startServiceSoon(); // not reachable: start one for the next hook (not after a mere decline)
                }
            }
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
            console.log(process.platform === "win32" ? `Node for MCP: ${NODE} (override with SKILLROUTER_NODE=C:/path/to/node.exe); hooks run the node on PATH` : `Node pinned for hooks and MCP: ${NODE} (override with SKILLROUTER_NODE=/path/to/node)`);
            const seen = new Set();
            for (const a of (targets.length ? targets : INSTALL_TARGETS))
                for (const line of install(a))
                    if (!seen.has(line)) {
                        seen.add(line);
                        console.log(line);
                    }
            // A running service holds the old code and launcher paths: stop it, the next hook starts the new one.
            try {
                const { serviceSnapshot } = await import("./service-client.js");
                if (serviceSnapshot().running) {
                    const { stopService } = await import("./service.js");
                    await stopService();
                    console.log("Stopped the running warm service; the next hook starts it with the new install.");
                }
            }
            catch { /* best effort */ }
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
        case "serve": {
            const { serviceSupported } = await import("./service-client.js");
            if (!serviceSupported()) {
                console.log(NO_SERVICE);
                break;
            }
            const svc = await import("./service.js");
            if (args.includes("--start"))
                await svc.ensureStarted();
            else
                await svc.serve();
            break;
        }
        case "service": {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { runDir, serviceSupported } = await import("./service-client.js");
            if (!serviceSupported()) {
                console.log(NO_SERVICE);
                break;
            }
            const svc = await import("./service.js");
            const sub = args[0] ?? "status";
            if (sub === "status") {
                const s = await svc.status(1500);
                if (!s) {
                    console.log("Service: not running. It starts on the first hook (SKILLROUTER_SERVICE=0 turns it off).");
                    break;
                }
                console.log(`Service: running, pid ${s.pid}, up ${Math.round((Date.now() - Date.parse(s.startedAt)) / 60000)} min, ${s.requests} requests (${s.fallbacks} handed back), ${s.rssMB} MB`);
                console.log(`  index ${s.skills} skills, vectors ${s.vectors}, exits after ${s.idleMin} idle min, v${s.version}`);
                for (const [m, v] of Object.entries(s.byMode))
                    console.log(`  ${m === "-" ? "prompt check" : m}: ${v.count} requests, ${v.avgMs} ms average`);
                console.log(`  socket ${s.socket}`);
            }
            else if (sub === "stop")
                console.log((await svc.stopService()) ? "Service stopped." : "Service was not running.");
            else if (sub === "start" || sub === "restart") {
                if (sub === "restart")
                    await svc.stopService();
                try {
                    fs.rmSync(path.join(runDir(), "svc.off"), { force: true });
                }
                catch { /* none */ } // a deliberate start clears the failure pause
                if (!(await svc.ensureStarted())) {
                    console.log(`Could not start the service: ${runDir()} is not writable. Hooks keep working without it.`);
                    process.exitCode = 1;
                    break;
                }
                let s = null;
                for (let i = 0; i < 40 && !s; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    s = await svc.status(500);
                }
                console.log(s ? `Service running, pid ${s.pid}.` : "Service did not start; see ~/.skillrouter/run/svc.err (hooks keep working without it).");
                if (!s)
                    process.exitCode = 1;
            }
            else {
                console.log(USAGE);
                process.exitCode = 1;
            }
            break;
        }
        case "eval": {
            const path = await import("node:path");
            const { fileURLToPath } = await import("node:url");
            if (args[0] === "add") {
                const { addCase } = await import("./eval.js");
                if (!args[1] || !args[2]) {
                    console.log('usage: skillrouter eval add "<prompt>" <id,id|none>');
                    process.exitCode = 1;
                    break;
                }
                const c = addCase(path.join(SR_DIR, "eval.jsonl"), args[1], args[2]);
                console.log(`labeled: ${JSON.stringify(c.prompt)} -> ${c.expect.join(", ") || "none"} (${path.join(SR_DIR, "eval.jsonl")})`);
                break;
            }
            const live = flag(args, "--live"), ci = flag(args, "--ci"), lexical = flag(args, "--lexical"), verbose = flag(args, "-v") || flag(args, "--verbose");
            const roots = opt(args, "--root");
            const thresholds = {};
            for (const key of ["top1", "top3", "hintRecall", "hintPrecision", "falseHints", "copiesShown"]) {
                const v = opt(args, `--${key}`)[0];
                if (v !== undefined)
                    thresholds[key] = Number(v);
            }
            if (!live && !roots.length) {
                // The bundled fixture, in an isolated state dir so the real index, core and verdicts play no part.
                const os = await import("node:os");
                const fs = await import("node:fs");
                const { spawnSync } = await import("node:child_process");
                const fixture = fileURLToPath(new URL("../../eval/", import.meta.url));
                const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-eval-"));
                const { writeFillers } = await import("./eval.js");
                writeFillers(path.join(tmp, "fillers")); // the same 400 unrelated skills every run
                const pass = [...(ci ? ["--ci"] : []), ...(verbose ? ["-v"] : []), ...Object.entries(thresholds).flatMap(([k, v]) => [`--${k}`, String(v)])];
                const r = spawnSync(process.execPath, [process.argv[1], "eval", "--live", "--lexical", "--root", path.join(fixture, "skills"), "--root", path.join(tmp, "fillers"), path.join(fixture, "prompts.jsonl"), ...pass], { env: { ...process.env, SKILLROUTER_HOME: tmp }, stdio: "inherit", windowsHide: true });
                fs.rmSync(tmp, { recursive: true, force: true });
                process.exitCode = r.status ?? 1;
                break;
            }
            if (roots.length) {
                const { buildIndexFrom, saveIndex } = await import("./index.js");
                saveIndex(buildIndexFrom(roots.map((r) => path.resolve(r))));
            }
            const { readCases, evaluate, formatEval, checkThresholds, DEFAULT_THRESHOLDS } = await import("./eval.js");
            const file = args.find((a) => !a.startsWith("-")) ?? path.join(SR_DIR, "eval.jsonl");
            const cases = readCases(file);
            if (!cases.length) {
                console.log(`No labeled prompts at ${file}. Add one: skillrouter eval add "<prompt>" <skill-id|none>`);
                process.exitCode = 1;
                break;
            }
            const result = await evaluate(cases, { lexicalOnly: lexical });
            console.log(formatEval(result, verbose));
            if (ci) {
                const failures = checkThresholds(result.summary, { ...DEFAULT_THRESHOLDS, ...thresholds });
                if (failures.length) {
                    console.log("\nFAIL:\n  " + failures.join("\n  "));
                    process.exitCode = 1;
                }
                else
                    console.log("\nPASS");
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
