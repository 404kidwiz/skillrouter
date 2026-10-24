import fs from "node:fs";

/**
 * Everything that differs between Windows and POSIX, in one place, with the platform as a parameter so the Windows
 * branches can be tested from any machine.
 */
export type Platform = NodeJS.Platform;
export const IS_WIN = process.platform === "win32";

/** Forward slashes: Windows accepts them everywhere Node, bash, cmd and PowerShell look at a path, and they never need escaping. */
export const fwd = (p: string): string => p.replace(/\\/g, "/");

/** Options that stop every spawned process from flashing a console window on Windows (ignored elsewhere). */
export const NO_WINDOW = { windowsHide: true } as const;

/**
 * Hook commands must parse in bash (Claude Code on Windows), cmd.exe and PowerShell (Cursor, Gemini, Codex), whichever
 * the host picks. The one shape all three accept is a bare `node` followed by quoted arguments with forward slashes:
 * a command that starts with a quoted string is a plain string to PowerShell, and backslashes are escapes to bash.
 * POSIX keeps the single-quoted launcher path.
 */
export function hookPrefix(launcher: string, platform: Platform = process.platform): string {
  if (platform === "win32") {
    // Inside double quotes bash and PowerShell still expand $ and `, and cmd.exe expands %VAR%; no quoting is safe in all three.
    if (/[$`%]/.test(launcher)) throw new Error(`Hooks cannot be installed under ${launcher}: the shells that run them would expand the $, \` or % in that path. Point SKILLROUTER_HOME at a folder without them.`);
    return `node "${fwd(launcher).replace(/"/g, "")}"`;
  }
  return "'" + launcher.replace(/'/g, "'\\''") + "'";
}

/** The launcher file for a platform: the shell script on POSIX, an ES module run by `node` on Windows. */
export const launcherFile = (base: string, platform: Platform = process.platform): string => (platform === "win32" ? `${base}.mjs` : base);

/**
 * The Windows launcher: a module `node` runs, which hands the hook to the CLI in the same process (no second Node
 * start). It replaces itself in argv so the CLI sees `hint <agent> [mode]`, exactly as the POSIX launcher passes it.
 */
export function windowsLauncher(cli: string): string {
  return `// skillrouter hook launcher (Windows). Rewritten by \`skillrouter install\`; hook configs point here so their text never changes.
import { pathToFileURL } from "node:url";
const cli = ${JSON.stringify(fwd(cli))};
process.argv.splice(1, 1, cli, "hint");
await import(pathToFileURL(${JSON.stringify(cli)}).href); // the native form: Node 20 turns a //server/share path written with slashes into a broken URL
`;
}

const BUSY = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * `fs.renameSync` that survives Windows: replacing a file another process has open (an antivirus scan, the search
 * indexer, a hook reading the index) fails with EPERM/EBUSY for a moment. Retries with a short backoff (about 0.8 s in
 * all) and then throws the last error. Elsewhere the first attempt is the only one that ever fails, and it fails at once.
 */
export function renameSyncRetry(from: string, to: string, impl: Pick<typeof fs, "renameSync"> = fs, platform: Platform = process.platform, sleep: (ms: number) => void = pause): void {
  for (let attempt = 0; ; attempt++) {
    try { impl.renameSync(from, to); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? "";
      if (platform !== "win32" || !BUSY.has(code) || attempt >= 12) throw e;
      sleep(Math.min(150, 10 * (attempt + 1)));
    }
  }
}

/** A directory link: a junction on Windows (a real symlink needs admin rights or Developer Mode), a symlink elsewhere. */
export function linkDir(target: string, link: string, impl: Pick<typeof fs, "symlinkSync"> = fs, platform: Platform = process.platform): void {
  impl.symlinkSync(target, link, platform === "win32" ? "junction" : undefined);
}

/** JSON from a file a person may have edited: Notepad and PowerShell 5.1 save UTF-8 with a BOM, which JSON.parse rejects. */
export const parseJson = (text: string): any => JSON.parse(text.replace(/^\uFEFF/, ""));

/** The shell tools of every host: Bash, Shell (Cursor), shell/exec_command (Codex), run_shell_command (Gemini), PowerShell (Windows). */
export const SHELL_TOOLS = /^(Bash|Shell|shell|run_shell_command|exec_command|PowerShell|powershell|pwsh)$/i;

/** Windows PowerShell by its full path: a bare name is looked up in the current folder first, and hooks and `service stop` run anywhere. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  const root = env.SystemRoot || env.windir;
  if (root) {
    const p = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (exists(p)) return p;
  }
  return "powershell.exe";
}

/** Windows's own tar (bsdtar) lives in System32; a GNU tar earlier on PATH (Git Bash) mistakes `C:` for a remote host. */
export function tarCommand(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  if (platform === "win32" && env.SystemRoot) {
    const p = `${env.SystemRoot}\\System32\\tar.exe`;
    if (exists(p)) return p;
  }
  return "tar";
}
