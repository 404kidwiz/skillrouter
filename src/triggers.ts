import fs from "node:fs";
import path from "node:path";
import { SR_DIR } from "./paths.js";
import { SHELL_TOOLS, fwd, parseJson } from "./platform.js";

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
  // Not `git merge`: a merge or fast-forward adds history instead of rewriting it.
  { id: "git-history", label: "rewrote git history", command: /git(\s+-C\s+\S+)?\s+(rebase|cherry-pick|bisect|reset\s+--hard)(?![-\w])/, query: "git advanced workflow history" },
  { id: "pull-request", label: "worked on a pull request", command: /gh\s+pr\s+(create|review|merge|checkout)\b/, query: "pull request review" },
  { id: "release", label: "published a release", command: /(npm|pnpm|yarn) publish\b|cargo publish\b|gh release\b/, query: "release publishing versioning changelog" },
];

export function loadTriggers(file = path.join(SR_DIR, "triggers.json")): Trigger[] {
  let user: any[] = [];
  try { user = parseJson(fs.readFileSync(file, "utf8")); if (!Array.isArray(user)) user = []; } catch { /* defaults */ }
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

export interface Action { file?: string; files?: string[]; command?: string }

/** Files a Codex/Cursor-style patch touches (`*** Update File: path`). Bounded: hook input is untrusted. */
export function patchFiles(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.slice(0, 256 * 1024).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) out.add(m[1].trim());
  return [...out];
}

/** The script a shell tool runs: `bash -lc "<script>"` (string or argv form) is the script, not `bash`. */
export function shellCommand(input: any): string {
  const c = input?.command ?? input?.cmd;
  if (Array.isArray(c)) {
    const flag = c.findIndex((x) => /^-[a-z]{0,4}c[a-z]{0,4}$/.test(String(x)));
    if (flag > 0 && /(^|\/)(ba|z|da)?sh$/.test(String(c[0]))) return String(c[c.length - 1]);
    // Codex on Windows: ["powershell.exe", "-NoProfile", "-Command", "<script>"] or ["cmd.exe", "/c", "<script>"]; the script is the rest.
    const win = /^(powershell|pwsh)$|^cmd$/i.exec(String(c[0]).split(/[\\/]/).pop()!.replace(/\.exe$/i, ""));
    const at = win ? c.findIndex((x, i) => i > 0 && (win[1] ? /^-(c|command)$/i : /^\/[ck]$/i).test(String(x))) : -1;
    return String(at > 0 ? c.slice(at + 1).join(" ") : c.join(" "));
  }
  if (typeof c !== "string") return "";
  // Only a whole `sh -c '<script>'` is unwrapped (`bash -c "a" && pytest` is a compound command); bounded flags keep it linear.
  const m = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-[a-z]{1,4}\s+){0,3}-[a-z]{0,4}c[a-z]{0,4}\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*$/.exec(c);
  if (m) return m[1] ?? m[2];
  const w = WIN_SHELL.exec(c);
  return w ? (/^"([^"]*)"$/.exec(w[1]) ?? /^'([^']*)'$/.exec(w[1]))?.[1] ?? w[1] : c;
}
// `powershell -NoProfile -Command <script>` and `cmd /c <script>`: the script is everything after the flag (bounded flags keep it linear).
const WIN_SHELL = /^\s*(?:\S*[\\/])?(?:(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+){0,6}-(?:c|command)|cmd(?:\.exe)?\s+(?:\/\w\s+){0,2}\/[ck])\s+(.+?)\s*$/is;

/** Some hosts send tool input as a JSON string (Cursor MCP calls); a patch string stays a string. */
export function parsedInput(input: unknown): any {
  if (typeof input !== "string" || !/^\s*[{[]/.test(input)) return input;
  try { return JSON.parse(input); } catch { return input; }
}

/** What a tool call did, from the host's tool name and input: Claude, Codex, Cursor, Gemini CLI and OpenCode names. */
export function actionOf(tool: string, raw: any): Action | null {
  const input = parsedInput(raw);
  if (/^(apply_patch|ApplyPatch|patch)$/i.test(tool)) {
    const text = typeof input === "string" ? input : input?.command ?? input?.patch ?? input?.patchText ?? input?.input;
    const files = typeof text === "string" ? patchFiles(text) : [];
    return files.length ? { files } : null;
  }
  if (!input || typeof input !== "object") return null;
  if (/^(Edit|Write|MultiEdit|NotebookEdit|StrReplace|write_file|replace|edit_file)$/i.test(tool)) {
    const file = input.file_path ?? input.notebook_path ?? input.path ?? input.filePath ?? input.target_file;
    return typeof file === "string" ? { file } : null;
  }
  if (SHELL_TOOLS.test(tool)) {
    const command = shellCommand(input);
    return command ? { command } : null;
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

// Commands that only look around. A turn of these is exploration, not work worth a decision nudge or a search first.
const READ_ONLY = /^(?:ls|ll|cat|bat|less|more|head|tail|nl|wc|rg|grep|egrep|fgrep|ag|ack|find|fd|tree|pwd|cd|echo|printf|which|type|file|stat|du|df|jq|uniq|cut|tr|diff|true|date|env|whoami|uname|ps|top|htop|lsof|netstat|ss|uptime|hostname|id|groups|nproc|vm_stat|history|printenv|sw_vers|dig|nslookup|host)\b/;
// Commands that read unless a flag or subcommand says otherwise; each pattern is the read-only form. Git first loses its global options.
const GIT_GLOBAL = /^git(?:\s+(?:-C\s+\S+|-c\s+\S+|--no-pager|--git-dir=\S+|--work-tree=\S+|-P))+\s+/;
const READ_ONLY_FORMS: RegExp[] = [
  /^sed\s+-n\b(?!.*(?:\s-[A-Za-z]*i|--in-place))/, /^sort\b(?!.*(?:\s-[A-Za-z]*o\b|--output))/,
  /^git\s+(?:status|log|diff|show|rev-parse|blame|ls-files|grep|describe|shortlog|rev-list|merge-base|cat-file|for-each-ref|ls-remote|ls-tree|name-rev|count-objects|whatchanged|check-ignore|var)\b(?!.*--output)/,
  /^git\s+branch(?:\s+(?:-a|-r|-v|-vv|-l|--all|--remotes|--verbose|--list|--show-current|--contains\s+\S+|--merged|--no-merged|--sort=\S+))*\s*$/,
  /^git\s+remote(?:\s+(?:-v|--verbose))?\s*$/, /^git\s+remote\s+(?:show|get-url)\b/, /^git\s+(?:stash\s+(?:list|show)|worktree\s+list|config\s+(?:--get\S*|--list|-l))\b/, /^git\s+tag(?:\s*$|\s+(?:-l|--list)\b)/,
  /^\S+\s+(?:-v|-V|--version|version|--help|-h)\s*$/, /^(?:\[\[?|test)\s/,
  /^curl\b(?!.*(?:\s-[A-Za-z]*[dFToOX]|--(?:request|data|data-\w+|form|upload-file|output|remote-name|json)\b))/,
  /^docker\s+(?:ps|images|logs|inspect|info|stats|top|port|history|diff|search)\b/, /^docker\s+(?:network|volume|container|image|compose)\s+(?:ls|ps|logs|inspect|config|list)\b/,
  /^kubectl\s+(?:get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\s+(?:view|get-contexts|current-context))\b/,
  /^gh\s+(?:(?:pr|issue|run|repo|release|workflow|gist|label|project|ruleset|cache|secret|variable|codespace)\s+(?:view|list|status|checks|diff|watch)|auth\s+status|api\s+[^-\s]\S*\s*$)/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:ls|list|view|info|outdated|why|explain|root|bin|prefix|audit)\b(?!.*\sfix)/, /^npm\s+config\s+(?:get|list)\b/,
  /^pip3?\s+(?:list|show|freeze|check)\b/, /^uv\s+(?:pip\s+(?:list|show|freeze|tree|check)|tree)\b/, /^cargo\s+(?:tree|metadata|search|locate-project)\b/,
  /^go\s+(?:list|env|doc)\b/, /^brew\s+(?:list|info|search|outdated|deps|leaves|--prefix)\b/, /^(?:systemctl\s+(?:status|list-\S+|is-\S+|show)|launchctl\s+list|journalctl)\b/,
];
const isReadOnly = (command: string): boolean => {
  const c = command.replace(/^\(+/, "").replace(GIT_GLOBAL, "git ");
  return READ_ONLY.test(c) || READ_ONLY_FORMS.some((re) => re.test(c));
};
// The same for PowerShell (any case): a whole word, so `gc.sh` or `dir/build.sh` are not it.
const PS_READ_ONLY = /^(?:get-(?:content|childitem|item|location|command|date)|gci|gc|dir|select-string|sls|set-location|write-(?:output|host)|test-path|resolve-path|measure-object|where-object|select-object|sort-object|format-(?:table|list))(?=\s|$)/i;

/** Whether an action is work: any edit, or a shell line with at least one command that does more than read. */
export function isWork(action: Action | null): boolean {
  if (!action) return false;
  if (action.file || action.files?.length) return true;
  const commands = action.command ? commandsOf(action.command) : [];
  return commands.some((c) => !(isReadOnly(c) || PS_READ_ONLY.test(c.replace(/^\(+/, ""))) || /(?<![2&])>(?!&)/.test(c) || /^find\b.*\s-(?:delete|exec)\b/.test(c));
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
  const files = [...(action.files ?? []), ...(action.file ? [action.file] : [])].map(fwd); // Windows paths arrive with backslashes
  const commands = action.command ? commandsOf(action.command) : [];
  for (const t of triggers) {
    const file = t.path && files.find((f) => t.path!.test(f));
    if (file) {
      const ext = file.split(".").pop()?.toLowerCase() ?? "";
      out.push({ trigger: t, query: `${t.query} ${LANG[ext] ?? ""}`.trim(), subject: path.basename(file) });
      continue;
    }
    // Anchored to a command's start: `docker build …` triggers, `ls docker-build/` does not.
    const hit = t.command && commands.find((c) => new RegExp(`^(?:${t.command!.source})`, t.command!.flags).test(c));
    if (hit) out.push({ trigger: t, query: `${t.query} ${commandLang(hit)}`.trim(), subject: hit.split(/\s+/).slice(0, 3).join(" ") });
  }
  return out;
}
