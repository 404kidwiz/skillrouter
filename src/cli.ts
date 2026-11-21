#!/usr/bin/env node
import { AGENTS, HOOK_AGENTS, SR_DIR, type AgentId, type HookAgent } from "./paths.js";
// Everything else is imported where used: hooks run on every prompt and tool call, so they load only what they need.

const USAGE = `skillrouter — a big skill library without the context bloat

  skillrouter doctor [--live] [agents]   what each agent preloads today and what it costs; --live starts each configured MCP server
  skillrouter index [--root DIR]... [--embeddings]
                                          scan every skill folder into ~/.skillrouter/index.json (+ local vectors)
  skillrouter search "<task>" [-k N] [--exploratory] [--lexical]
                                          relevant skills, or a few labeled weak ones when none is strong; exploratory lists all weak matches
  skillrouter explain "<task>" [-k N] [--lexical]
                                          ranking, relevance, applicability, duplicate and semantic decisions
  skillrouter core list|add <id>...|remove <id>...|suggest [N]|sync [agents]
                                          the small set every agent preloads (sync relinks agent folders)
  skillrouter core skip|unskip <id> <agent>...
                                          don't link a core skill for agents that already have it (e.g. via a plugin)
  skillrouter trim [agents] [--apply] [--keep NAME]...
                                          move everything except core out of agent folders (dry run by default)
  skillrouter restore <manifest.json> [--apply]
                                          restore what trim removed, skill by skill (dry run; skips and lists skills changed since)
  skillrouter install <agent>... [--accept-hooks] [--hooks]
                                          wire MCP + hooks: claude codex cursor gemini opencode hermes; MCP only: openclaude antigravity
                                          --accept-hooks: approve the router's hooks in Hermes (needed for gateway/cron profiles)
                                          --hooks: also install Antigravity's hooks (experimental)
  skillrouter recurring [reset | forget <hash>]
                                          requests seen more than once and the skills they used (named at once next time)
  skillrouter backups [--older-than DAYS] [--apply]
                                          list ~/.skillrouter/backups; --apply removes entries older than DAYS (default 30),
                                          never the newest trim's restore manifest and archives (dry run by default)
  skillrouter eval [-v] [--ci]           routing quality on the bundled fixture (what CI runs)
  skillrouter eval --live [file] [--lexical] [-v] [--ci]
                                          the same on the real index and ~/.skillrouter/eval.jsonl
  skillrouter eval add "<prompt>" <id,id|none>
                                          label a prompt for the live eval
  skillrouter report [days] | --since <date>
                                          who searched, what got loaded, did checks help, per-skill accept rates
  skillrouter suppress [keep|unkeep|reset] [id]...
                                          skills held back after repeated declines; keep exempts one, reset forgets counts
  skillrouter mcp                        stdio MCP server (search_skills, read_skill)
  skillrouter hint <agent> [tool|stop|gate]  hooks: prompt check (default), PostToolUse triggers, Stop decision, PreToolUse search gate
  skillrouter service [status|start|stop|restart]
                                          the warm background service hooks talk to (starts itself; SKILLROUTER_SERVICE=0 turns it off)
  skillrouter serve [--start]            run the service in the foreground (--start: make sure one is running, then return)
`;

function flag(args: string[], name: string): boolean { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; }
function opt(args: string[], name: string): string[] { const out: string[] = []; for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) { out.push(args[i + 1]); args.splice(i, 2); } return out; }
function agentsFrom(args: string[]): AgentId[] { const a = args.filter((x): x is AgentId => (AGENTS as string[]).includes(x)); return a.length ? a : AGENTS; }

/**
 * Write and exit: a worker must not linger on pending work (a slow model load) after its answer is out. On Windows every
 * hook leaves at once: a connect to a busy pipe waits in a thread (up to 30 s) that Node cannot cancel, and the host
 * waits for the process, not for its output.
 */
function finish(out: string, exit: boolean): Promise<void> {
  const leave = exit || process.platform === "win32";
  return new Promise((resolve) => {
    if (!out) { if (leave) process.exit(0); resolve(); return; }
    process.stdout.write(out + "\n", () => { if (leave) process.exit(0); resolve(); });
  });
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "hint":
    case "hint-worker": {
      const agent = args[0] as HookAgent;
      const mode = args[1];
      if (!HOOK_AGENTS.includes(agent)) return;
      const { readHintInput, runHint, formatHint, hint } = await import("./hint.js");
      const { silent } = await import("./hosts.js");
      const worker = cmd === "hint-worker";
      // Hermes and Antigravity have the prompt check, the gate, and the end-of-turn verdict record; any other mode there has nothing to do.
      if ((agent === "hermes" || agent === "antigravity") && mode && mode !== "gate" && mode !== "decision") return finish(silent(agent, false), worker);
      // Hermes's end-of-turn payload carries the whole conversation, and pre_llm_call can carry large context in extra.
      const input = await readHintInput(agent, 1500, agent === "hermes" && mode === "decision" ? 64 * 1024 * 1024 : mode || agent === "hermes" ? 8 * 1024 * 1024 : 256 * 1024);
      if (input === null) return finish(mode ? silent(agent, mode === "gate") : formatHint(agent, ""), worker);
      // SKILLROUTER_GATE=0 is the hook's own environment: the warm service has its own and must not be asked.
      if (mode === "gate") { const { gateEnabled } = await import("./gate.js"); if (!gateEnabled()) return finish(silent(agent, true), worker); }
      // The warm service answers in milliseconds when it is running; any failure falls through to doing the work here.
      if (!worker) {
        const { serviceEnabled, ask, startServiceSoon } = await import("./service-client.js");
        // (SKILLROUTER_RECURRING=0 is this hook's own setting: the service has its own environment and would not see it.)
        if (serviceEnabled() && process.env.SKILLROUTER_SERVICE_TRIED !== "1" && process.env.SKILLROUTER_RECURRING !== "0") {
          const answer = await ask(agent, mode ?? "-", input);
          if (answer.kind === "ok") return finish(answer.out, false);
          if (answer.kind === "failed") startServiceSoon(); // not reachable: start one for the next hook (not after a mere decline)
        }
      }
      if (mode === "gate") { const { gateEvent } = await import("./gate.js"); return finish(gateEvent(agent, input), worker); }
      if ((agent === "hermes" || agent === "antigravity") && mode === "decision") { const { decisionEvent } = await import("./events.js"); decisionEvent(agent, input); return finish("{}", worker); }
      if (agent === "hermes" || agent === "antigravity") {
        // The prompt check, in this process: these hosts allow seconds, and the killable-worker path below is not needed for them.
        return finish(await hint(agent, input), worker);
      }
      if (mode === "stop") { const { stopEvent } = await import("./events.js"); return finish(stopEvent(agent, input), worker); }
      if (mode === "decision") { const { decisionEvent } = await import("./events.js"); return finish(decisionEvent(agent, input), worker); }
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
      {
        // Pins: what each host's config and the hook launcher actually point at.
        const { mcpSpec, hermesSpec } = await import("./live.js");
        const { INSTALL_TARGETS, pinProblems } = await import("./pins.js");
        const { HOME, SR_DIR, BACKUP_DIR, USAGE_LOG } = await import("./paths.js");
        const fs = await import("node:fs"), path = await import("node:path");
        const specs: { host: string; command: unknown; args: unknown }[] = [];
        for (const t of INSTALL_TARGETS) { try { const sp = mcpSpec(t as any); if (sp) specs.push({ host: `${t} MCP`, command: sp.command, args: sp.args }); } catch { /* unreadable config: reported above */ } }
        try {
          for (const name of fs.readdirSync(path.join(HOME, ".hermes", "profiles"))) {
            try { const sp = hermesSpec(fs.readFileSync(path.join(HOME, ".hermes", "profiles", name, "config.yaml"), "utf8")); if (sp) specs.push({ host: `hermes profile ${name} MCP`, command: sp.command, args: sp.args }); } catch { /* no config */ }
          }
        } catch { /* no profiles */ }
        const problems = pinProblems(specs);
        const codes = new Set(specs.map((x) => (Array.isArray(x.args) ? x.args : []).find((a) => typeof a === "string" && /cli\.js$/.test(a))).filter(Boolean));
        if (codes.size > 1) problems.push(`hosts run ${codes.size} different copies of the code (${[...codes].join(", ")}); run \`skillrouter install\` so all use one`);
        console.log(problems.length ? "\nPins (Node and code paths the hosts are configured with):\n  " + problems.join("\n  ") : specs.length ? `\nPins: ${specs.length} configured Node and code paths exist and are stable.` : "\nPins: no host has the skillrouter MCP server configured.");
        try {
          const { readCore } = await import("./core.js");
          const { findSkill } = await import("./search.js");
          const count = (id: string) => { try { return findSkill(id).length; } catch { return 1; } };
          const core = readCore(), lost = core.filter((id) => count(id) === 0), many = core.filter((id) => count(id) > 1);
          if (lost.length) console.log(`Core entries that match no indexed skill (a retired or misspelled name; edit core.txt or reindex): ${lost.join(", ")}`);
          if (many.length) console.log(`Core entries that match several skills (\`core sync\` links none of them; name one id, e.g. name~2): ${many.join(", ")}`);
        } catch { /* no index */ }
        const size = (p: string): number => { try { const st = fs.lstatSync(p); if (!st.isDirectory()) return st.size; return fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0); } catch { return 0; } };
        const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
        const { usageArchives, logMaxMB } = await import("./search.js");
        const archives = usageArchives();
        const limit = logMaxMB() > 0 ? `rotates at ${logMaxMB()} MB` : "rotation off";
        console.log(`Disk: usage log ${mb(size(USAGE_LOG))}${archives.length ? ` + ${archives.length} rotated (${mb(archives.reduce((n, f) => n + size(f), 0))})` : ""} (${limit}); backups ${mb(size(BACKUP_DIR))} in ${BACKUP_DIR} (never deleted automatically; "skillrouter backups" lists them and can remove old ones)`);
        void SR_DIR;
      }
      if (live) {
        const { liveCheck } = await import("./live.js");
        const { INSTALL_TARGETS } = await import("./pins.js");
        const targets = args.filter((x) => (INSTALL_TARGETS as string[]).includes(x));
        console.log("\nLive MCP check (each configured server started and asked for its tools):");
        console.log((await liveCheck((targets.length ? targets : INSTALL_TARGETS) as any)).join("\n"));
      }
      break;
    }
    case "index": {
      const { buildIndex, loadIndex, saveIndex } = await import("./index.js");
      const { embedSkills, vectorsExist, saveVectors } = await import("./embed.js");
      const withEmb = flag(args, "--embeddings");
      // Extra roots stick: an index rebuilt without --root keeps the roots of the previous one.
      const roots = opt(args, "--root");
      const previous = loadIndex();
      const index = buildIndex(roots.length ? roots : (previous?.roots ?? []));
      // Vectors are rebuilt with the index once a vector store exists. Save index and vectors together
      // after embedding so concurrent prompt checks never see an index without matching vectors.
      let vec = "";
      if (withEmb || vectorsExist()) {
        try {
          const { rows, hashes, reused } = await embedSkills(index.skills, previous?.skills, true);
          saveIndex(index);
          saveVectors(index.skills.map((s) => s.id), rows, index.builtAt, hashes);
          vec = ` with embeddings (${reused}/${index.skills.length} cached)`;
        } catch (e) {
          saveIndex(index);
          vec = ` (embeddings not rebuilt: ${(e as Error).message}; hints use BM25 until \`index --embeddings\` succeeds)`;
          process.exitCode = 1;
        }
      } else {
        saveIndex(index);
      }
      console.log(`Indexed ${index.skills.length} skills from ${index.roots.length} folders${vec} -> ${SR_DIR}/index.json`);
      break;
    }
    case "search":
    case "explain": {
      const { routeSearch, formatSearch, formatExplanation } = await import("./routing.js");
      const exploratory = flag(args, "--exploratory"), lexicalOnly = flag(args, "--lexical");
      const k = Number(opt(args, "-k")[0] ?? 5);
      if (!Number.isInteger(k) || k < 1 || k > 20 || !args.join(" ").trim()) throw new Error('Provide a task and -k between 1 and 20.');
      const result = await routeSearch(args.join(" "), { k, exploratory, lexicalOnly });
      console.log(cmd === "explain" ? formatExplanation(result) : formatSearch(result));
      break;
    }
    case "core": {
      const { readCore, writeCore, syncCore, suggestCore, skipCore } = await import("./core.js");
      const [sub, ...rest] = args;
      if (sub === "list") console.log(readCore().join("\n") || "(empty core — try: skillrouter core suggest)");
      else if (sub === "add") writeCore([...readCore(), ...rest]);
      else if (sub === "remove") writeCore(readCore().filter((id) => !rest.includes(id)));
      else if (sub === "suggest") {
        const { readCounts } = await import("./report.js");
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
      const { trim } = await import("./trim.js");
      const apply = flag(args, "--apply");
      const keep = opt(args, "--keep");
      const s = trim(agentsFrom(args), apply, keep);
      console.log(`${apply ? "Applied" : "Dry run"}: move ${s.moved} folders, re-link ${s.linked} links, drop ${s.dangling} broken links, keep ${s.kept}, ${s.conflicts} same-name conflicts kept under library/.conflicts`);
      if (apply) { console.log("Restore manifest: " + s.manifest); console.log("Backups:\n  " + s.backups.join("\n  ")); console.log("Next: skillrouter index && skillrouter core sync"); }
      else console.log("Nothing changed. Re-run with --apply.");
      break;
    }
    case "restore": {
      const { restore } = await import("./restore.js");
      const path = await import("node:path");
      const apply = flag(args, "--apply");
      if (args.length !== 1 || !args[0] || args[0].startsWith("-")) throw new Error("usage: skillrouter restore <manifest.json> [--apply]");
      const s = restore(args[0], apply);
      console.log(`${apply ? "Applied" : "Dry run"}: ${s.missing} missing entries, ${s.unchanged} unchanged, ${s.restored} restored across ${s.sources.length} agent folders.`);
      if (s.kept) console.log(`Left alone: ${s.kept} entr${s.kept === 1 ? "y" : "ies"} trim kept in place (your later edits or deletions of them stand).`);
      if (s.conflicts.length) {
        // Every changed skill, not just the first: each is kept exactly as it is now, and the rest is restored.
        console.log(`${apply ? "Skipped" : "Will skip"} ${s.conflicts.length} skill${s.conflicts.length === 1 ? "" : "s"} that changed since the trim (current version kept, nothing overwritten):`);
        for (const c of s.conflicts) console.log(`  ${path.join(c.source, c.name)}  (differs: ${c.paths.slice(0, 3).join(", ")}${c.paths.length > 3 ? `, and ${c.paths.length - 3} more` : ""})`);
        console.log("To restore one of them, move the current copy aside and run restore again.");
      }
      if (!apply) console.log("Nothing changed. Re-run with --apply.");
      else console.log("Restored to original agent folders. Re-run skillrouter index if needed.");
      break;
    }
    case "recurring": {
      const { formatRecurring, forgetRecurring } = await import("./recurring.js");
      if (args[0] === "reset") { forgetRecurring(); console.log("Forgot every remembered request."); break; }
      if (args[0] === "forget" && args[1]) { const { forgetRequest } = await import("./recurring.js"); const n = forgetRequest(args[1]); console.log(n ? `Forgot ${n} request${n === 1 ? "" : "s"}.` : `No remembered request starts with ${args[1]}.`); break; }
      console.log(formatRecurring());
      break;
    }
    case "backups": {
      const { backupPlan, pruneBackups, formatBackups } = await import("./backups.js");
      const apply = flag(args, "--apply");
      const raw = opt(args, "--older-than")[0];
      const days = raw !== undefined && raw.trim() !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 30; // an empty value (an unset shell variable) is not "0 days"
      const plan = backupPlan(days);
      console.log(formatBackups(plan, days, apply ? pruneBackups(plan) : undefined));
      break;
    }
    case "install": {
      const { install, NODE, INSTALL_TARGETS, snapshotApp, setInstallCli, volatileNode } = await import("./install.js");
      const installOptions = { acceptHooks: flag(args, "--accept-hooks"), hooks: flag(args, "--hooks") };
      const app = snapshotApp();
      setInstallCli(app.cli);
      console.log(app.note);
      { const fs = await import("node:fs"), path = await import("node:path"); if (path.isAbsolute(NODE) && !fs.existsSync(NODE)) console.log(`Warning: ${NODE} does not exist${process.env.SKILLROUTER_NODE ? " (from SKILLROUTER_NODE)" : ""}; hooks will fall back to another Node, MCP servers will not start. Fix the path and install again.`); }
      if (volatileNode(NODE)) console.log(`Warning: no stable Node found; pinned ${NODE}, which sits in a versioned or managed folder. Set SKILLROUTER_NODE=/path/to/node and install again.`);
      const targets = args.filter((x) => (INSTALL_TARGETS as string[]).includes(x));
      console.log(process.platform === "win32" ? `Node for MCP: ${NODE} (override with SKILLROUTER_NODE=C:/path/to/node.exe); hooks run the node on PATH` : `Node pinned for hooks and MCP: ${NODE} (override with SKILLROUTER_NODE=/path/to/node)`);
      const seen = new Set<string>();
      for (const a of (targets.length ? targets : INSTALL_TARGETS) as any[]) for (const line of install(a, undefined, undefined, installOptions)) if (!seen.has(line)) { seen.add(line); console.log(line); }
      // A running service holds the old code and launcher paths: stop it, the next hook starts the new one.
      try { const { serviceSnapshot } = await import("./service-client.js"); if (serviceSnapshot().running) { const { stopService } = await import("./service.js"); await stopService(); console.log("Stopped the running warm service; the next hook starts it with the new install."); } } catch { /* best effort */ }
      break;
    }
    case "suppress": {
      const { readVerdicts, suppressedByAgent, setKeep, resetVerdicts, suppressAfter } = await import("./verdicts.js");
      const [sub, ...ids] = args;
      if (sub === "keep" || sub === "unkeep") {
        if (!ids.length) { console.log(`usage: skillrouter suppress ${sub} <id>...`); process.exitCode = 1; break; }
        const kept = setKeep(ids, sub === "keep");
        if (!kept) { console.log("verdicts.json is busy (another hook is writing); try again"); process.exitCode = 1; break; }
        console.log(`kept (never held back): ${kept.join(", ") || "none"}`);
      } else if (sub === "reset") {
        const n = resetVerdicts(ids);
        if (n === undefined) { console.log("verdicts.json is busy (another hook is writing); try again"); process.exitCode = 1; break; }
        console.log(`forgot decision counts for ${n} skill(s)`);
      }
      else if (sub && sub !== "list") { console.log(USAGE); process.exitCode = 1; }
      else {
        const v = readVerdicts();
        const byAgent = suppressedByAgent(v);
        console.log(suppressAfter() > 0 ? `Held back after declines in ${suppressAfter()}+ sessions with under 10% accepted, per host, for 30 days (SKILLROUTER_SUPPRESS_AFTER; 0 = off):` : "Suppression is off (SKILLROUTER_SUPPRESS_AFTER=0).");
        for (const [agent, held] of byAgent) for (const id of held) console.log(`  ${agent}: ${id}: accepted ${v.agents[agent][id].accepted} of ${v.agents[agent][id].shown}, last ${v.agents[agent][id].last.slice(0, 10)}`);
        if (!byAgent.size) console.log("  none");
        if (v.keep.length) console.log(`Kept (never held back): ${v.keep.join(", ")}`);
      }
      break;
    }
    case "serve": {
      const svc = await import("./service.js");
      if (args.includes("--start")) await svc.ensureStarted(); else await svc.serve();
      break;
    }
    case "service": {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { runDir } = await import("./service-client.js");
      const svc = await import("./service.js");
      const sub = args[0] ?? "status";
      if (sub === "status") {
        const s = await svc.status(1500);
        if (!s) { console.log("Service: not running. It starts on the first hook (SKILLROUTER_SERVICE=0 turns it off)."); break; }
        console.log(`Service: running, pid ${s.pid}, up ${Math.round((Date.now() - Date.parse(s.startedAt)) / 60000)} min, ${s.requests} requests (${s.fallbacks} handed back), ${s.rssMB} MB`);
        console.log(`  index ${s.skills} skills, vectors ${s.vectors}, exits after ${s.idleMin} idle min, v${s.version}`);
        for (const [m, v] of Object.entries(s.byMode)) console.log(`  ${m === "-" ? "prompt check" : m}: ${v.count} requests, ${v.avgMs} ms average`);
        console.log(`  socket ${s.socket}`);
      } else if (sub === "stop") console.log((await svc.stopService()) ? "Service stopped." : "Service was not running.");
      else if (sub === "start" || sub === "restart") {
        if (sub === "restart") await svc.stopService();
        try { fs.rmSync(path.join(runDir(), "svc.off"), { force: true }); } catch { /* none */ } // a deliberate start clears the failure pause
        if (!(await svc.ensureStarted(true))) { console.log(`Could not start the service: ${runDir()} is not writable. Hooks keep working without it.`); process.exitCode = 1; break; }
        let s = null;
        for (let i = 0; i < 40 && !s; i++) { await new Promise((r) => setTimeout(r, 100)); s = await svc.status(500); }
        console.log(s ? `Service running, pid ${s.pid}.` : "Service did not start; see ~/.skillrouter/run/svc.err (hooks keep working without it).");
        if (!s) process.exitCode = 1;
      } else { console.log(USAGE); process.exitCode = 1; }
      break;
    }
    case "eval": {
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      if (args[0] === "add") {
        const { addCase } = await import("./eval.js");
        if (!args[1] || !args[2]) { console.log('usage: skillrouter eval add "<prompt>" <id,id|none>'); process.exitCode = 1; break; }
        const c = addCase(path.join(SR_DIR, "eval.jsonl"), args[1], args[2]);
        console.log(`labeled: ${JSON.stringify(c.prompt)} -> ${c.expect.join(", ") || "none"} (${path.join(SR_DIR, "eval.jsonl")})`);
        break;
      }
      const live = flag(args, "--live"), ci = flag(args, "--ci"), lexical = flag(args, "--lexical"), verbose = flag(args, "-v") || flag(args, "--verbose");
      const roots = opt(args, "--root");
      const thresholds: Record<string, number> = {};
      for (const key of ["top1", "top3", "hintRecall", "hintPrecision", "falseHints", "copiesShown"]) { const v = opt(args, `--${key}`)[0]; if (v !== undefined) thresholds[key] = Number(v); }
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
        const r = spawnSync(process.execPath, [process.argv[1], "eval", "--live", "--lexical", "--root", path.join(fixture, "skills"), "--root", path.join(tmp, "fillers"), path.join(fixture, "prompts.jsonl"), ...pass],
          { env: { ...process.env, SKILLROUTER_HOME: tmp }, stdio: "inherit", windowsHide: true });
        fs.rmSync(tmp, { recursive: true, force: true });
        process.exitCode = r.status ?? 1;
        break;
      }
      if (roots.length) { const { buildIndexFrom, saveIndex } = await import("./index.js"); saveIndex(buildIndexFrom(roots.map((r) => path.resolve(r)))); }
      const { readCases, evaluate, formatEval, checkThresholds, DEFAULT_THRESHOLDS } = await import("./eval.js");
      const file = args.find((a) => !a.startsWith("-")) ?? path.join(SR_DIR, "eval.jsonl");
      const cases = readCases(file);
      if (!cases.length) { console.log(`No labeled prompts at ${file}. Add one: skillrouter eval add "<prompt>" <skill-id|none>`); process.exitCode = 1; break; }
      const result = await evaluate(cases, { lexicalOnly: lexical });
      console.log(formatEval(result, verbose));
      if (ci) {
        const failures = checkThresholds(result.summary, { ...DEFAULT_THRESHOLDS, ...thresholds });
        if (failures.length) { console.log("\nFAIL:\n  " + failures.join("\n  ")); process.exitCode = 1; } else console.log("\nPASS");
      }
      break;
    }
    case "report": {
      const { report, readLog } = await import("./report.js");
      // --since DATE measures from a change onward (a fix, an install), so older rows do not blur what it did.
      const at = args.indexOf("--since"), since = at >= 0 ? Date.parse(args[at + 1] ?? "") : NaN;
      if (at >= 0 && !(since < Date.now())) { console.log("usage: skillrouter report [days] | report --since <date, e.g. 2026-11-16 or 2026-11-16T20:00>"); process.exitCode = 1; break; }
      if (at >= 0) { const days = (Date.now() - since) / 86400e3; console.log(report(days, readLog(days), `Since ${new Date(since).toISOString().slice(0, 16).replace("T", " ")} UTC`)); }
      else console.log(report(Number(args[0] ?? 7)));
      break;
    }
    case "mcp": { const { serveMcp } = await import("./mcp.js"); await serveMcp(); break; }
    default: console.log(USAGE); if (cmd && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
