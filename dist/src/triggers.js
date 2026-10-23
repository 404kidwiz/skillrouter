import fs from "node:fs";
import path from "node:path";
import { SR_DIR } from "./paths.js";
const LANG = {
    py: "python pytest", ts: "typescript javascript", tsx: "typescript react", js: "javascript", jsx: "javascript react",
    go: "golang", rb: "ruby", rs: "rust", java: "java", kt: "kotlin", swift: "swift", cs: "csharp dotnet", php: "php",
};
export const DEFAULT_TRIGGERS = [
    { id: "tests", label: "worked on tests",
        path: /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/i,
        command: /(pytest|vitest|jest|mocha)\b|(go|cargo) test\b|rspec\b|(npm|pnpm|yarn|bun)(\s+-{1,2}[\w-]+(=\S+|\s+(?!run\b|test\b)[^\s-]\S*)?)*(\s+run)?\s+test\b|make (test|check)\b/, query: "writing and fixing tests testing" },
    { id: "docker", label: "worked on Docker", path: /(^|\/)(Dockerfile(\.(?!md$|txt$)[\w-]+)?|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|\.dockerignore)$/i,
        command: /docker(\s+(build|buildx|run)|(-compose|\s+compose)\s+(up|build|run))\b/, query: "docker containers dockerfile images" },
    { id: "migration", label: "worked on a database migration", path: /(^|\/)(migrations?|migrate|alembic)\/|(^|\/)schema\.(prisma|sql)$/i,
        command: /(prisma migrate|alembic|knex migrate|rails db:migrate|rake db:migrate|sequelize db:migrate|drizzle-kit)\b/, query: "database migration schema change" },
    { id: "ci", label: "worked on CI", path: /(^|\/)\.github\/workflows\/|\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\//i, query: "ci pipeline github actions workflow" },
    { id: "k8s", label: "worked on Kubernetes", path: /(^|\/)(k8s|kubernetes|helm|charts)\/|kustomization\.ya?ml$/i,
        command: /(kubectl|helm)\s/, query: "kubernetes deployment manifests" },
    { id: "terraform", label: "worked on Terraform", path: /\.tf(vars)?$/, command: /(terraform|tofu)\s/, query: "terraform infrastructure as code" },
    { id: "frontend", label: "worked on frontend UI", path: /\.(tsx|jsx|vue|svelte|astro|css|scss)$/i, query: "frontend ui components design" },
    // Whole path segments only: auth/, login.ts, test_auth.py — never author.ts or sessionStore.ts.
    { id: "auth", label: "worked on authentication", path: /(^|[\/_.-])(auth|authn|authz|authentication|authorization|login|oauth2?|sso|permissions?)([\/_.-]|$)/i, query: "authentication authorization security" },
    { id: "api", label: "worked on an API", path: /(^|\/)(routes?|api|controllers?|handlers?|endpoints?)\//i, query: "api design endpoints" },
    { id: "git-history", label: "rewrote git history", command: /git(\s+-C\s+\S+)?\s+(rebase|cherry-pick|bisect|reset\s+--hard|merge)(?![-\w])/, query: "git advanced workflow history" },
    { id: "pull-request", label: "worked on a pull request", command: /gh\s+pr\s+(create|review|merge|checkout)\b/, query: "pull request review" },
    { id: "release", label: "published a release", command: /(npm|pnpm|yarn) publish\b|cargo publish\b|gh release\b/, query: "release publishing versioning changelog" },
];
export function loadTriggers(file = path.join(SR_DIR, "triggers.json")) {
    let user = [];
    try {
        user = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Array.isArray(user))
            user = [];
    }
    catch { /* defaults */ }
    const byId = new Map(DEFAULT_TRIGGERS.map((t) => [t.id, t]));
    for (const u of user) {
        if (!u || typeof u.id !== "string")
            continue;
        if (u.enabled === false) {
            byId.delete(u.id);
            continue;
        }
        const base = byId.get(u.id);
        const re = (s, fallback) => { try {
            return typeof s === "string" ? new RegExp(s, "i") : fallback;
        }
        catch {
            return fallback;
        } };
        const t = { id: u.id, label: u.label ?? base?.label ?? u.id, path: re(u.path, base?.path), command: re(u.command, base?.command), query: u.query ?? base?.query ?? u.id };
        if (t.path || t.command)
            byId.set(t.id, t);
    }
    return [...byId.values()];
}
/** Files a Codex/Cursor-style patch touches (`*** Update File: path`). Bounded: hook input is untrusted. */
export function patchFiles(patch) {
    const out = new Set();
    for (const m of patch.slice(0, 256 * 1024).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm))
        out.add(m[1].trim());
    return [...out];
}
/** The script a shell tool runs: `bash -lc "<script>"` (string or argv form) is the script, not `bash`. */
export function shellCommand(input) {
    const c = input?.command ?? input?.cmd;
    if (Array.isArray(c)) {
        const flag = c.findIndex((x) => /^-[a-z]{0,4}c[a-z]{0,4}$/.test(String(x)));
        return String(flag > 0 && /(^|\/)(ba|z|da)?sh$/.test(String(c[0])) ? c[c.length - 1] : c.join(" "));
    }
    if (typeof c !== "string")
        return "";
    // Only a whole `sh -c '<script>'` is unwrapped (`bash -c "a" && pytest` is a compound command); bounded flags keep it linear.
    const m = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-[a-z]{1,4}\s+){0,3}-[a-z]{0,4}c[a-z]{0,4}\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*$/.exec(c);
    return m ? m[1] ?? m[2] : c;
}
/** Some hosts send tool input as a JSON string (Cursor MCP calls); a patch string stays a string. */
export function parsedInput(input) {
    if (typeof input !== "string" || !/^\s*[{[]/.test(input))
        return input;
    try {
        return JSON.parse(input);
    }
    catch {
        return input;
    }
}
/** What a tool call did, from the host's tool name and input: Claude, Codex, Cursor, Gemini CLI and OpenCode names. */
export function actionOf(tool, raw) {
    const input = parsedInput(raw);
    if (/^(apply_patch|ApplyPatch|patch)$/i.test(tool)) {
        const text = typeof input === "string" ? input : input?.command ?? input?.patch ?? input?.patchText ?? input?.input;
        const files = typeof text === "string" ? patchFiles(text) : [];
        return files.length ? { files } : null;
    }
    if (!input || typeof input !== "object")
        return null;
    if (/^(Edit|Write|MultiEdit|NotebookEdit|StrReplace|write_file|replace|edit_file)$/i.test(tool)) {
        const file = input.file_path ?? input.notebook_path ?? input.path ?? input.filePath ?? input.target_file;
        return typeof file === "string" ? { file } : null;
    }
    if (/^(Bash|Shell|shell|run_shell_command|exec_command)$/i.test(tool)) {
        const command = shellCommand(input);
        return command ? { command } : null;
    }
    return null;
}
/**
 * The commands a shell line actually runs: heredoc bodies and quoted strings removed, split on
 * ; && || | newlines and $( ), leading VAR=x / sudo / time / env dropped. `echo "docker build"` runs echo.
 */
export function commandsOf(line) {
    const text = line.slice(0, 64 * 1024); // bound the work: hook input is untrusted
    // Quoted strings become one token (multi-line too, as in shell), so `VAR="a b" cmd` still reads as an assignment.
    const noQuotes = stripHeredocs(text).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "Q");
    // Whole words followed by whitespace only (`bun` never eats `bundle`, `env` never `envsubst`). Package managers
    // are wrappers only with exec/dlx: `pnpm test` is the command `pnpm test`, not `test`.
    const WRAPPERS = /^(?:(?:\w+=\S*|sudo(?:\s+-\S+)*|time|env|nohup|exec|command|do|then|else|!|\{|nice(?:\s+-n\s+\S+)?|timeout\s+\S+|npx(?:\s+-y)?|pnpm\s+(?:exec|dlx)|yarn\s+dlx|bunx|uv\s+run|poetry\s+run|pipenv\s+run|bundle\s+exec|python3?\s+-m)\s+|(?:\.\/)?node_modules\/\.bin\/)+/;
    return noQuotes.split(/\|\||&&|;|\||\n|\$\(|`|\)/)
        .map((s) => s.trim().replace(WRAPPERS, ""))
        .filter(Boolean);
}
// Commands that only look around. A turn of these is exploration, not work worth a decision nudge.
const READ_ONLY = /^(?:ls|ll|cat|bat|less|more|head|tail|nl|wc|rg|grep|egrep|fgrep|ag|ack|find|fd|tree|pwd|cd|echo|printf|which|type|file|stat|du|df|jq|sort|uniq|cut|tr|diff|true|date|env|whoami|uname|sed\s+-n|git\s+(?:status|log|diff|show|branch|rev-parse|blame|remote|ls-files|grep))\b/;
/** Whether an action is work: any edit, or a shell line with at least one command that does more than read. */
export function isWork(action) {
    if (!action)
        return false;
    if (action.file || action.files?.length)
        return true;
    const commands = action.command ? commandsOf(action.command) : [];
    return commands.some((c) => !READ_ONLY.test(c.replace(/^\(+/, "")) || /(?<![2&])>(?!&)/.test(c) || /^find\b.*\s-(?:delete|exec)\b/.test(c));
}
/** A command names its ecosystem the way a file extension does: `pnpm test` is JavaScript, `pytest` is Python. */
function commandLang(command) {
    const head = command.split(/\s+/)[0];
    if (/^(npm|pnpm|yarn|bun|jest|vitest|mocha|prisma|knex|sequelize|drizzle-kit)$/.test(head))
        return "javascript typescript";
    if (/^(pytest|alembic)$/.test(head))
        return "python pytest";
    if (/^(rspec|rails|rake)$/.test(head))
        return "ruby";
    if (head === "go")
        return "golang";
    if (head === "cargo")
        return "rust";
    return "";
}
/** Drop heredoc bodies line by line (linear for any input); the opener line itself stays (`cat <<EOF | docker build -`). `<<<` is a here-string, not a heredoc. */
function stripHeredocs(text) {
    const out = [];
    let terminator = null;
    for (const line of text.split("\n")) {
        if (terminator !== null) {
            if (line.trim() === terminator)
                terminator = null;
            continue;
        }
        out.push(line);
        const m = /(?<!<)<<-?[ \t]*(['"]?)(\w+)\1(?!\w)/.exec(line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "Q"));
        if (m)
            terminator = m[2];
    }
    return out.join("\n");
}
export function matchTriggers(action, triggers = loadTriggers()) {
    const out = [];
    const files = [...(action.files ?? []), ...(action.file ? [action.file] : [])];
    const commands = action.command ? commandsOf(action.command) : [];
    for (const t of triggers) {
        const file = t.path && files.find((f) => t.path.test(f));
        if (file) {
            const ext = file.split(".").pop()?.toLowerCase() ?? "";
            out.push({ trigger: t, query: `${t.query} ${LANG[ext] ?? ""}`.trim(), subject: path.basename(file) });
            continue;
        }
        // Anchored to a command's start: `docker build …` triggers, `ls docker-build/` does not.
        const hit = t.command && commands.find((c) => new RegExp(`^(?:${t.command.source})`, t.command.flags).test(c));
        if (hit)
            out.push({ trigger: t, query: `${t.query} ${commandLang(hit)}`.trim(), subject: hit.split(/\s+/).slice(0, 3).join(" ") });
    }
    return out;
}
