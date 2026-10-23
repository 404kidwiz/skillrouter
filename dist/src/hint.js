import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { INDEX_FILE } from "./paths.js";
import { logUsage, search } from "./search.js";
import { readCore } from "./core.js";
const EVENT = { gemini: "BeforeAgent" }; // claude/codex: UserPromptSubmit
export function formatHint(agent, text) {
    if (agent === "cursor")
        return JSON.stringify(text ? { continue: true, additional_context: text } : { continue: true });
    if (!text)
        return "";
    return JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT[agent] ?? "UserPromptSubmit", additionalContext: text } });
}
/** Reads the hook JSON on stdin, prints the agent-specific hook output. Never blocks a prompt. */
// Calibrated 2026-10-23 on a 4,500-skill library with synonyms + name bonus: real matches score raw 28-44,
// small talk ~13, a noisy word match ~19. Override with SKILLROUTER_MIN_RAW.
export async function hint(agent, input, minRaw = Number(process.env.SKILLROUTER_MIN_RAW ?? 20), k = 3) {
    const started = performance.now();
    const hint_id = randomUUID();
    let payload = {};
    const record = (reason, hits = []) => logUsage({
        client: `hook/${agent}`, agent, tool: "hint", hint_id, reason,
        session: typeof payload.session_id === "string" ? createHash("sha256").update(payload.session_id).digest("hex") : undefined,
        duration_ms: Math.round(performance.now() - started), hits: hits.map((h) => [h.skill.id, h.score, h.raw]),
    });
    try {
        const parsed = JSON.parse(input);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.prompt !== "string")
            throw new Error();
        payload = parsed;
    }
    catch {
        record("invalid_input");
        return formatHint(agent, "");
    }
    const prompt = payload.prompt.trim();
    if (prompt.startsWith("/")) {
        record("skipped_command");
        return formatHint(agent, "");
    }
    if (prompt.length < 20) {
        record("skipped_short_prompt");
        return formatHint(agent, "");
    }
    let hits = [];
    try {
        // Fewer, surer candidates: a skill the model can't judge (no description) is never a hint, and
        // only hits close to the best one are shown, so a hint is a recommendation rather than a list.
        hits = selectHints(await search(prompt.slice(0, 1000), k * 2, { lexicalOnly: true }), minRaw, k);
    }
    catch {
        record(fs.existsSync(INDEX_FILE) ? "index_error" : "missing_index");
        return formatHint(agent, "");
    }
    record(hits.length ? "shown" : "no_match", hits);
    if (!hits.length)
        return formatHint(agent, "");
    return formatHint(agent, hintText(hits, hint_id, new Set(readCore()), agent));
}
export function selectHints(hits, minRaw, k) {
    const described = hits.filter((h) => h.skill.description.trim().length >= 20 && h.matched >= 2 && h.raw >= minRaw);
    const top = described[0]?.raw ?? 0;
    return described.filter((h) => h.raw >= 0.85 * top).slice(0, k);
}
/** The hint the model reads: each candidate's trigger, and the exact way to load it (already preloaded, or via read_skill). */
export function hintText(hits, hint_id, core, agent = "claude") {
    const lines = hits.map((h) => {
        const id = h.skill.id;
        const how = core.has(id) || core.has(h.skill.name)
            ? (agent === "claude" ? "preloaded: invoke it with the Skill tool" : `preloaded: use the skill named ${id} from your skill list`)
            : `not preloaded: read_skill("${id}", hint_id="${hint_id}")`;
        return `- ${id} (${h.score.toFixed(2)}) — ${how}\n  when: ${(h.skill.description || "(no description)").split(/\s+/).join(" ").slice(0, 220)}`;
    }).join("\n");
    return "Skill hints from skillrouter. If this task matches a \"when\" line, load that skill exactly as its line says before your first tool call and follow it; if none matches, ignore this.\n" + lines;
}
/** Run matching in a killable process: synchronous index work cannot defeat the deadline. */
export function runHint(agent, input, cli, timeout = 1500) {
    const started = performance.now();
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [cli, "hint-worker", agent], {
            timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
        }, (error, stdout) => {
            if (error) {
                logUsage({ client: `hook/${agent}`, agent, tool: "hint", reason: error.killed ? "timeout" : "execution_error",
                    duration_ms: Math.round(performance.now() - started), hits: [] });
                resolve(formatHint(agent, ""));
            }
            else
                resolve(stdout.trim());
        });
        child.stdin?.on("error", () => { });
        child.stdin?.end(input);
    });
}
/** Bound stdin too: a host that never closes its pipe must not hang prompt submission. */
export function readHintInput(agent, timeout = 1500) {
    return new Promise((resolve) => {
        let input = "";
        const done = (reason) => {
            clearTimeout(timer);
            process.stdin.removeListener("data", onData);
            process.stdin.removeListener("end", onEnd);
            process.stdin.removeListener("error", onError);
            process.stdin.pause();
            if (reason)
                logUsage({ client: `hook/${agent}`, agent, tool: "hint", reason, hits: [] });
            resolve(reason ? null : input);
        };
        const onData = (chunk) => {
            input += chunk;
            if (Buffer.byteLength(input) > 256 * 1024)
                done("input_too_large");
        };
        const onEnd = () => done();
        const onError = () => done("invalid_input");
        const timer = setTimeout(() => done("input_timeout"), timeout);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", onData).once("end", onEnd).once("error", onError);
        process.stdin.resume();
    });
}
