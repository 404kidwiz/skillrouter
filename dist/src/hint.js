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
// Calibrated on a 4,500-skill library: real matches scored raw 15-38, small talk ~12. Override with SKILLROUTER_MIN_RAW.
export async function hint(agent, input, minRaw = Number(process.env.SKILLROUTER_MIN_RAW ?? 14), k = 3) {
    const started = performance.now();
    const hint_id = randomUUID();
    let payload = {};
    const record = (reason, hits = []) => logUsage({
        client: `hook/${agent}`, agent, tool: "hint", hint_id, reason,
        session: typeof payload.session_id === "string" ? createHash("sha256").update(payload.session_id).digest("hex") : undefined,
        duration_ms: Math.round(performance.now() - started), hits: hits.map((h) => [h.skill.id, h.score]),
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
        hits = (await search(prompt.slice(0, 1000), k, { lexicalOnly: true }))
            .filter((h) => h.matched >= 2 && h.raw >= minRaw && h.score >= 0.6);
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
/** The hint the model reads: each candidate's trigger, and the exact way to load it (already preloaded, or via read_skill). */
export function hintText(hits, hint_id, core, agent = "claude") {
    const lines = hits.map((h) => {
        const id = h.skill.id;
        const how = core.has(id) || core.has(h.skill.name)
            ? (agent === "claude" ? "preloaded: invoke it with the Skill tool" : `preloaded: use the skill named ${id} from your skill list`)
            : `not preloaded: read_skill("${id}", hint_id="${hint_id}")`;
        return `- ${id} (${h.score.toFixed(2)}) — ${how}\n  when: ${(h.skill.description || "(no description)").split(/\s+/).join(" ").slice(0, 220)}`;
    }).join("\n");
    return "Skill hints from skillrouter. Use a skill only if this task matches its \"when\" line; then load it exactly as its line says (one skill, before starting the work). Otherwise ignore these.\n" + lines;
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
