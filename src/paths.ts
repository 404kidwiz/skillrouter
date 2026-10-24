import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const SR_DIR = process.env.SKILLROUTER_HOME ?? path.join(HOME, ".skillrouter");
export const INDEX_FILE = path.join(SR_DIR, "index.json");
export const CORE_FILE = path.join(SR_DIR, "core.txt");
export const USAGE_LOG = path.join(SR_DIR, "usage.jsonl");
export const LIBRARY_DIR = path.join(SR_DIR, "library");
export const CORE_DIR = path.join(SR_DIR, "core");
export const BACKUP_DIR = path.join(SR_DIR, "backups");

/** Current Antigravity CLI/IDE config, plus former locations used only to migrate this router's entry. */
export function antigravityConfigPaths(home = HOME): { current: string; legacy: string[] } {
  return {
    current: path.join(home, ".gemini", "config", "mcp_config.json"),
    legacy: ["antigravity", "antigravity-ide"].map((dir) => path.join(home, ".gemini", dir, "mcp_config.json")),
  };
}

export type AgentId = "claude" | "codex" | "cursor" | "gemini" | "opencode";
export const AGENTS: AgentId[] = ["claude", "codex", "cursor", "gemini", "opencode"];

/** Folders each agent auto-loads at startup (user scope). First entry is where core links go. */
export const AGENT_SKILL_DIRS: Record<AgentId, string[]> = {
  claude: [path.join(HOME, ".claude", "skills")],
  codex: [path.join(HOME, ".agents", "skills"), path.join(HOME, ".codex", "skills")],
  cursor: [path.join(HOME, ".agents", "skills"), path.join(HOME, ".cursor", "skills")],
  gemini: [path.join(HOME, ".agents", "skills"), path.join(HOME, ".gemini", "skills")],
  opencode: [path.join(HOME, ".agents", "skills"), path.join(HOME, ".config", "opencode", "skills"), path.join(HOME, ".claude", "skills")],
};

/** Everything worth indexing: every agent folder plus the shared skills.sh folder and the library. */
export function defaultRoots(extra: string[] = []): string[] {
  const all = new Set<string>([LIBRARY_DIR, path.join(HOME, ".agents", "skills"), path.join(HOME, ".skills")]);
  for (const dirs of Object.values(AGENT_SKILL_DIRS)) dirs.forEach((d) => all.add(d));
  extra.forEach((d) => all.add(path.resolve(d)));
  return [...all];
}
