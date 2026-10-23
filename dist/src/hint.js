import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { INDEX_FILE } from "./paths.js";
import { getIndex, logUsage, search } from "./search.js";
import { readCore } from "./core.js";
import { semanticScores } from "./embed.js";
import { addShown, bareSkill, loadedSkills } from "./state.js";
const EVENT = { gemini: "BeforeAgent" }; // claude/codex: UserPromptSubmit
export function formatHint(agent, text, event) {
    if (agent === "cursor")
        return JSON.stringify(text ? { continue: true, additional_context: text } : { continue: true });
    if (!text)
        return "";
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event ?? EVENT[agent] ?? "UserPromptSubmit", additionalContext: text } });
}
export const sessionHash = (id) => (typeof id === "string" && id ? createHash("sha256").update(id).digest("hex") : undefined);
/** Host- and harness-generated turns (notifications, subagent hand-backs, command echoes) are not the user's task. */
export function isSystemText(prompt) {
    return /^(?:<task-notification>|<system-reminder>|\[SYSTEM NOTIFICATION|<local-command-|<command-name>|<agent-message|Another Claude session sent a message|Caveat: The messages below)/.test(prompt.trim());
}
/** Reads the hook JSON on stdin, prints the agent-specific hook output. Never blocks a prompt. */
// Lexical floor calibrated 2026-10-23 on a 4,500-skill library (real matches raw 28-44, small talk ~13). Override with SKILLROUTER_MIN_RAW.
export async function hint(agent, input, minRaw = Number(process.env.SKILLROUTER_MIN_RAW ?? 20), k = 4) {
    const started = performance.now();
    const hint_id = randomUUID();
    let payload = {};
    let semStatus;
    const record = (reason, hits = []) => logUsage({
        client: `hook/${agent}`, agent, tool: "hint", hint_id, reason, session: sessionHash(payload.session_id), prompt: sessionHash(payload.prompt_id),
        sem: semStatus, duration_ms: Math.round(performance.now() - started), hits: hits.map((h) => [h.skill.id, h.score, h.raw, h.cos ?? null]),
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
    const session = sessionHash(payload.session_id);
    const prompt = payload.prompt.trim();
    if (prompt.startsWith("/")) {
        record("skipped_command");
        return formatHint(agent, "");
    }
    if (isSystemText(prompt)) {
        record("skipped_system");
        return formatHint(agent, "");
    }
    if (prompt.length < 20) {
        record("skipped_short_prompt");
        return formatHint(agent, "");
    }
    let hits = [];
    try {
        const query = prompt.slice(0, 1000);
        const { index } = getIndex();
        const sem = await semanticScores(query, 800, index.builtAt);
        semStatus = sem.status;
        const loaded = loadedSkills(session, undefined); // already in context this session: not hinted again
        hits = selectHints((await search(query, 12, { semantic: sem.scores })).filter((h) => !loaded.has(bareSkill(h.skill.id))), minRaw, k);
    }
    catch {
        record(fs.existsSync(INDEX_FILE) ? "index_error" : "missing_index");
        return formatHint(agent, "");
    }
    record(hits.length ? "shown" : "no_match", hits);
    if (!hits.length)
        return formatHint(agent, "");
    addShown(session, hits.map((h) => h.skill.id), sessionHash(payload.prompt_id));
    return formatHint(agent, hintText(hits, hint_id, new Set(readCore()), agent));
}
/**
 * Which candidates become a hint. With the semantic layer: a skill passes on strong meaning alone
 * (cosine >= 0.45) or on words and meaning together (cosine >= 0.20 and cosine + raw/100 >= 0.52);
 * calibrated 2026-10-23 on 16 labeled prompts, it drops every labeled junk hit but one name collision.
 * Without it: the lexical gate. Either way only described skills, near the best one, at most k.
 */
export function selectHints(hits, minRaw, k) {
    const described = hits.filter((h) => h.skill.description.trim().length >= 20);
    const semantic = described.some((h) => h.cos !== undefined);
    // A hit without a vector (new since the last embedding run) is judged by the lexical gate, on a comparable scale.
    const strength = (h) => (!semantic ? h.raw : h.cos !== undefined ? h.cos + h.raw / 100 : h.raw / 100 + 0.25);
    const passes = (h) => h.cos === undefined
        ? h.matched >= 2 && h.raw >= minRaw
        : h.cos >= 0.45 || (h.cos >= 0.2 && h.matched >= 1 && strength(h) >= 0.52);
    const passing = described.filter(passes).sort((a, b) => strength(b) - strength(a));
    const top = passing[0] ? strength(passing[0]) : 0;
    return passing.filter((h) => strength(h) >= (semantic ? 0.8 : 0.85) * top).slice(0, k);
}
/** The hint the model reads: a required decision, each candidate's trigger, and the exact way to load it. */
export function hintText(hits, hint_id, core, agent = "claude", lead) {
    const lines = hits.map((h) => {
        const id = h.skill.id;
        const how = core.has(id) || core.has(h.skill.name)
            ? (agent === "claude" ? "preloaded: invoke it with the Skill tool" : `preloaded: use the skill named ${id} from your skill list`)
            : `not preloaded: read_skill("${id}", hint_id="${hint_id}")`;
        return `- ${id} — ${how}\n  when: ${(h.skill.description || "(no description)").split(/\s+/).join(" ").slice(0, 220)}`;
    }).join("\n");
    return lead
        ? `${lead} Load the ones whose "when" fits what you are doing before continuing, and include them in your \`Skills:\` line.\n${lines}`
        : "Skill check (skillrouter). Load every skill below whose \"when\" fits this task (often 1-3) before starting the work, then say which in one line: `Skills: <ids>` or `Skills: none (<why>)`.\n" + lines;
}
/** Run work in a killable process: synchronous index work cannot defeat the deadline. */
export function runHint(agent, input, cli, timeout = 1500, mode) {
    const started = performance.now();
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [cli, "hint-worker", agent, ...(mode ? [mode] : [])], {
            timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
        }, (error, stdout) => {
            // A worker killed after it already wrote a complete answer (e.g. a slow model load still pending) keeps that answer.
            const answer = stdout.trim();
            if (error && answer) {
                try {
                    JSON.parse(answer);
                    resolve(answer);
                    return;
                }
                catch { /* partial: fall through */ }
            }
            if (error) {
                logUsage({ client: `hook/${agent}`, agent, tool: mode === "tool" ? "trigger" : "hint", reason: error.killed ? "timeout" : "execution_error",
                    duration_ms: Math.round(performance.now() - started), hits: [] });
                resolve(mode ? "" : formatHint(agent, ""));
            }
            else
                resolve(stdout.trim());
        });
        child.stdin?.on("error", () => { });
        child.stdin?.end(input);
    });
}
/** Bound stdin too: a host that never closes its pipe must not hang prompt submission. Tool events carry tool output, so their cap is higher. */
export function readHintInput(agent, timeout = 1500, cap = 256 * 1024) {
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
            if (input.length > cap)
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
