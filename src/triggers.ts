import fs from "node:fs";
import path from "node:path";
import { SR_DIR } from "./paths.js";

/**
 * Action triggers: what the agent is doing (the file it edited, the command it ran) says which
 * skills fit far more reliably than the words of a prompt. Each rule fires at most once per session.
 * Override or extend in ~/.skillrouter/triggers.json:
 *   [{ "id": "tests", "enabled": false }, { "id": "mine", "label": "...", "path": "regex", "command": "regex", "query": "..." }]
 */
export interface Trigger { id: string; label: string; path?: RegExp; command?: RegExp; query: string }

const LANG: Record<string, string> = {
  py: "python pytest", ts: "typescript javascript", tsx: "typescript react", js: "javascript", jsx: "javascript react",
  go: "golang", rb: "ruby", rs: "rust", java: "java", kt: "kotlin", swift: "swift", cs: "csharp dotnet", php: "php",
};

export const DEFAULT_TRIGGERS: Trigger[] = [
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

export function loadTriggers(file = path.join(SR_DIR, "triggers.json")): Trigger[] {
  let user: any[] = [];
  try { user = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(user)) user = []; } catch { /* defaults */ }
  const byId = new Map(DEFAULT_TRIGGERS.map((t) => [t.id, t]));
  for (const u of user) {
    if (!u || typeof u.id !== "string") continue;
    if (u.enabled === false) { byId.delete(u.id); continue; }
    const base = byId.get(u.id);
    const re = (s: unknown, fallback?: RegExp) => { try { return typeof s === "string" ? new RegExp(s, "i") : fallback; } catch { return fallback; } };
    const t: Trigger = { id: u.id, label: u.label ?? base?.label ?? u.id, path: re(u.path, base?.path), command: re(u.command, base?.command), query: u.query ?? base?.query ?? u.id };
    if (t.path || t.command) byId.set(t.id, t);
  }
  return [...byId.values()];
}

export interface Action { file?: string; command?: string }

/** What a tool call did, from the host's tool name and input (Claude/Codex/Gemini names). */
export function actionOf(tool: string, input: any): Action | null {
  if (!input || typeof input !== "object") return null;
  if (/^(Edit|Write|MultiEdit|NotebookEdit|write_file|replace|edit_file|apply_patch)$/i.test(tool)) {
    const file = input.file_path ?? input.notebook_path ?? input.path ?? input.filePath;
    return typeof file === "string" ? { file } : null;
  }
  if (/^(Bash|shell|run_shell_command|exec_command)$/i.test(tool)) {
    const command = Array.isArray(input.command) ? input.command.join(" ") : input.command;
    return typeof command === "string" ? { command } : null;
  }
  return null;
}

/**
 * The commands a shell line actually runs: heredoc bodies and quoted strings removed, split on
 * ; && || | newlines and $( ), leading VAR=x / sudo / time / env dropped. `echo "docker build"` runs echo.
 */
export function commandsOf(line: string): string[] {
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

/** A command names its ecosystem the way a file extension does: `pnpm test` is JavaScript, `pytest` is Python. */
function commandLang(command: string): string {
  const head = command.split(/\s+/)[0];
  if (/^(npm|pnpm|yarn|bun|jest|vitest|mocha|prisma|knex|sequelize|drizzle-kit)$/.test(head)) return "javascript typescript";
  if (/^(pytest|alembic)$/.test(head)) return "python pytest";
  if (/^(rspec|rails|rake)$/.test(head)) return "ruby";
  if (head === "go") return "golang";
  if (head === "cargo") return "rust";
  return "";
}

/** Drop heredoc bodies line by line (linear for any input); the opener line itself stays (`cat <<EOF | docker build -`). `<<<` is a here-string, not a heredoc. */
function stripHeredocs(text: string): string {
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of text.split("\n")) {
    if (terminator !== null) { if (line.trim() === terminator) terminator = null; continue; }
    out.push(line);
    const m = /(?<!<)<<-?[ \t]*(['"]?)(\w+)\1(?!\w)/.exec(line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "Q"));
    if (m) terminator = m[2];
  }
  return out.join("\n");
}

export function matchTriggers(action: Action, triggers = loadTriggers()): { trigger: Trigger; query: string; subject: string }[] {
  const out: { trigger: Trigger; query: string; subject: string }[] = [];
  const commands = action.command ? commandsOf(action.command) : [];
  for (const t of triggers) {
    if (action.file && t.path?.test(action.file)) {
      const ext = action.file.split(".").pop()?.toLowerCase() ?? "";
      out.push({ trigger: t, query: `${t.query} ${LANG[ext] ?? ""}`.trim(), subject: path.basename(action.file) });
      continue;
    }
    // Anchored to a command's start: `docker build …` triggers, `ls docker-build/` does not.
    const hit = t.command && commands.find((c) => new RegExp(`^(?:${t.command!.source})`, t.command!.flags).test(c));
    if (hit) out.push({ trigger: t, query: `${t.query} ${commandLang(hit)}`.trim(), subject: hit.split(/\s+/).slice(0, 3).join(" ") });
  }
  return out;
}
