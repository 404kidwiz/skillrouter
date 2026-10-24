import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENTS, INDEX_FILE, SR_DIR, type AgentId } from "./paths.js";
import { getIndex, logUsage, resetIndexCache } from "./search.js";
import { VECTOR_FILES, embed, loadVectors, resetVectors } from "./embed.js";
import { hint } from "./hint.js";
import { decisionEvent, releaseTriggerClaims, stopEvent, toolEvent } from "./events.js";
import { gateEvent } from "./gate.js";
import { HELLO, MAX_EVENT_BYTES, MAX_PROMPT_BYTES, PROTOCOL, ensureKey, keyReplaced, ping, pipeName, runDir, serverProof, socketPath, stateDirPrivate, status, type ServiceStatus } from "./service-client.js";
import { IS_WIN, NO_WINDOW, powershellPath, renameSyncRetry } from "./platform.js";

/**
 * The warm service: one background process per user that keeps the index, the BM25 tables and the embedding model
 * loaded and answers hook requests over a Unix socket (a named pipe on Windows), so a prompt check costs about 15 ms instead of 450.
 * Every hook still works without it: any failure, refusal or timeout makes the caller run the hook itself.
 *
 * - Starts itself (the launcher spawns `serve --start` when it finds no service) and exits after SKILLROUTER_SERVICE_IDLE_MIN
 *   minutes (default 30) without a request.
 * - Reloads when index.json or the embedding files change, and restarts itself when its own code changes.
 * - Recovers from a crashed or hung predecessor (stale socket, wedged process) before listening.
 * - One request per connection, owner-only socket, bounded sizes, a per-request deadline well inside the hooks' own.
 */
const DEADLINE_MS = 600; // inside the clients' 0.8 s, so a request we answer FALLBACK to is one they have not given up on yet
const OPENCODE_DEADLINE_MS = 250; // its plugin kills a hook at 2 s, so its clients wait only 0.35 s
const MAX_CONNECTIONS = 64;
const RECEIVE_MS = Number(process.env.SKILLROUTER_SERVICE_RECEIVE_MS ?? 3000);
const LOCK_FRESH_MS = 15000;
const OFF_MS = 5 * 60e3;

const files = () => ({
  pid: path.join(runDir(), "svc.pid"), lock: path.join(runDir(), "svc.lock"), snapshot: path.join(runDir(), "svc.json"),
  err: path.join(runDir(), "svc.err"), off: path.join(runDir(), "svc.off"),
});

const alive = (pid: number) => { try { process.kill(pid, 0); return Number.isInteger(pid) && pid > 0; } catch { return false; } };

/** A skillrouter service command line: `… cli.js serve` or the npm bin `… skillrouter serve` (not the `serve --start` starter). */
export function isServiceCommand(cmd: string): boolean {
  return /(?:^|[\\/\s"])(?:cli\.js|skillrouter)"?\s+serve\s*$/.test(cmd.trim()); // (Windows: backslashes, and a quoted path when it has spaces)
}

/**
 * Windows has no `ps`. The command line and age of a process come from WMI through PowerShell (about half a second, and
 * only asked on the recovery path: a wedged service, or `service stop` finding the pipe gone). The pid is a checked integer.
 */
export function windowsProcessQuery(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("bad pid");
  // Plain pipeline output (no .NET calls a locked-down PowerShell would refuse) and UTC on both sides (a DST change must not skew the age).
  return `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { '{0}|{1}' -f [int]((Get-Date).ToUniversalTime() - $p.CreationDate.ToUniversalTime()).TotalSeconds, $p.CommandLine }`;
}
/** `<seconds>|<command line>` from windowsProcessQuery. */
export function parseWindowsProcess(out: string): { command: string; elapsedSec: number } | null {
  const bar = out.indexOf("|");
  const sec = Number(out.slice(0, bar));
  return bar > 0 && Number.isFinite(sec) ? { command: out.slice(bar + 1).trim(), elapsedSec: sec } : null;
}

/** `ps` elapsed time `[[dd-]hh:]mm:ss` in seconds. */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : NaN;
}

/** A process's command line and age: from `ps` (macOS, procps), else /proc (Linux without a usable ps). */
export function processInfo(pid: number): { command: string; elapsedSec: number } | null {
  if (IS_WIN) {
    try { return parseWindowsProcess(execFileSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", windowsProcessQuery(pid)], { encoding: "utf8", timeout: 10000, ...NO_WINDOW })); }
    catch { return null; }
  }
  try {
    const out = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "etime=", "-o", "command="], { encoding: "utf8", timeout: 2000 }).trim();
    const m = /^(\S+)\s+(.*)$/.exec(out);
    if (m) return { command: m[2], elapsedSec: parseEtime(m[1]) };
  } catch { /* try /proc */ }
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    // The inode appears when the process does or later, so the age can only be under-estimated: that errs towards not killing.
    return { command, elapsedSec: (Date.now() - fs.statSync(`/proc/${pid}`).ctimeMs) / 1000 };
  } catch { return null; }
}

/**
 * Whether a pid is a skillrouter service and not a recycled number: its command line is one, and the process
 * started before the pidfile was written (a process that began later can't be the one that wrote it).
 */
function isOurService(pid: number): boolean {
  try {
    const info = processInfo(pid);
    if (!info || !isServiceCommand(info.command)) return false;
    const age = (Date.now() - fs.statSync(files().pid).mtimeMs) / 1000;
    return Number.isFinite(info.elapsedSec) && info.elapsedSec >= age - 2;
  } catch { return false; }
}

/**
 * The start lock is a directory: mkdir is atomic, so only one starter creates it. A stale lock (older than 15 s, or
 * its owner died) is broken under a second mkdir mutex, with staleness re-checked inside it, so two starters can
 * never both break it and both end up holding a lock.
 */
export function takeLock(): boolean {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const lock = files().lock;
  const brk = `${lock}.break`;
  const create = (): boolean => {
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { return false; }
    try { fs.writeFileSync(path.join(lock, "pid"), String(process.pid)); } catch { /* the lock still stands */ }
    return true;
  };
  if (create()) return true;
  if (!lockStale()) return false;
  try { fs.mkdirSync(brk, { mode: 0o700 }); }
  catch {
    // Someone else is breaking it. A breaker that crashed leaves its mutex behind: clear it once it is old.
    try { if (Date.now() - fs.statSync(brk).mtimeMs > 5000) fs.rmdirSync(brk); } catch { /* gone */ }
    return false;
  }
  try {
    if (lockStale()) fs.rmSync(lock, { recursive: true, force: true }); // re-checked while we alone hold the mutex
    return create();                                                    // false if a faster starter slipped in: that one holds it
  } finally { try { fs.rmdirSync(brk); } catch { /* gone */ } }
}

function lockOwner(): number { try { return Number(fs.readFileSync(path.join(files().lock, "pid"), "utf8")); } catch { return NaN; } }
function lockAge(): number { try { return Date.now() - fs.statSync(files().lock).mtimeMs; } catch { return Infinity; } }
function lockStale(): boolean {
  const age = lockAge();
  if (age > LOCK_FRESH_MS || age < -1000) return true; // (a lock from the future: the clock was stepped back)
  const owner = lockOwner();
  return age > 1000 && !alive(owner); // a lock whose owner died (the pid file is written right after mkdir, hence the 1 s grace)
}
/** Release the lock, but only our own. */
export const dropLock = () => { if (lockOwner() === process.pid) try { fs.rmSync(files().lock, { recursive: true, force: true }); } catch { /* gone */ } };
const lockFresh = () => lockAge() >= -1000 && lockAge() < LOCK_FRESH_MS && !lockStale();

/** A wedged service holds the socket and answers nothing: kill it by its pidfile, if the pid is really ours. Returns the pid it killed. */
function killStale(): number | null {
  try {
    const pid = Number(fs.readFileSync(files().pid, "utf8"));
    if (pid !== process.pid && alive(pid) && isOurService(pid)) { process.kill(pid, "SIGKILL"); return pid; }
  } catch { /* nothing to kill */ }
  return null;
}

/** `serve --start`: make sure one is running. Cheap and safe to call from every failing hook; the real work is detached. */
export async function ensureStarted(deliberate = false): Promise<boolean> {
  // The stamp that let this starter run is spent whatever it decides next (a stamp left behind would block the next start).
  try { fs.rmdirSync(path.join(runDir(), "svc.starting")); } catch { /* none */ }
  try {
    try { const off = Date.now() - fs.statSync(files().off).mtimeMs; if (off >= 0 && off < OFF_MS) return false; } catch { /* not disabled */ }
    if (lockFresh()) return true;
    if ((await ping(socketPath(), 300)) === "alive") return true;
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
    // A service that came up and was gone within a minute without cleaning up (the pid file is still there) was killed, perhaps
    // by a host that ends everything a hook started: pause instead of starting one, loading the index, for every hook.
    if (IS_WIN && !deliberate) { // (`service start` is someone asking for one: always)
      try {
        const young = Date.now() - fs.statSync(files().pid).mtimeMs;
        if (young >= 0 && young < 60_000 && !alive(Number(fs.readFileSync(files().pid, "utf8")))) { fs.writeFileSync(files().off, String(Date.now())); logUsage({ client: "skillrouter-service", tool: "service", reason: "died_young" }); return false; }
      } catch { /* no pid file: it stopped cleanly or never ran */ }
    }
    try { if (fs.statSync(files().err).size > 100 * 1024) fs.truncateSync(files().err, 0); } catch { /* none yet */ }
    const err = fs.openSync(files().err, "a");
    const child = spawn(process.execPath, [process.argv[1], "serve"], { detached: true, stdio: ["ignore", "ignore", err], cwd: os.homedir(), env: process.env, ...NO_WINDOW });
    child.unref();
    fs.closeSync(err);
    return true;
  } catch { return false; } // an unwritable state dir: hooks run on their own
}

const fileStamp = (f: string) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } };
const dataStamp = () => [INDEX_FILE, ...VECTOR_FILES].map(fileStamp).join("|");
const CODE_DIR = () => process.env.SKILLROUTER_SERVICE_CODE_DIR ?? path.dirname(fileURLToPath(import.meta.url));
function codeStamp(): string {
  try { return fs.readdirSync(CODE_DIR()).filter((f) => f.endsWith(".js")).map((f) => fileStamp(path.join(CODE_DIR(), f))).join("|"); } catch { return "-"; }
}

const HEADER = new RegExp(`^${PROTOCOL} (${AGENTS.join("|")}|-) (-|tool|stop|decision|gate|status|shutdown|hang) (\\d{1,8})$`);

export async function serve(): Promise<void> {
  if (!stateDirPrivate()) { logUsage({ client: "skillrouter-service", tool: "service", reason: "state_dir_not_private" }); return; } // (Windows) see service-client.ts
  if (!takeLock()) return; // another process is already starting one
  let key: string | null = null; // (Windows) proves to clients that this is the service, and names the pipe
  if (IS_WIN) {
    try { key = ensureKey(); }
    catch (e) { dropLock(); try { fs.writeFileSync(files().off, String(Date.now())); } catch { /* best effort */ } logUsage({ client: "skillrouter-service", tool: "service", reason: "key_unreadable", error: String((e as Error)?.message ?? e).slice(0, 200) }); return; }
  }
  const sock = key ? pipeName(key) : socketPath();
  if (process.env.SKILLROUTER_SERVICE_FAULT !== "skip-recovery") { // (test fault: go straight to listening)
    const found = await ping(sock, 400);
    if (found === "alive") { dropLock(); return; }
    if (found === "hung") killStale();
    if (!IS_WIN) try { fs.unlinkSync(sock); } catch { /* none */ } // a pipe has no file: it goes with its process
  }

  const startedAt = new Date();
  const idleMs = Math.max(200, Number(process.env.SKILLROUTER_SERVICE_IDLE_MIN ?? 30) * 60e3);
  const stats = { requests: 0, fallbacks: 0, lastAt: null as Date | null, byMode: new Map<string, { count: number; ms: number }>() };
  let dataSeen = dataStamp();
  let codeSeen = codeStamp();
  let codeCheckedAt = 0;
  let closing = false;
  let active = 0;
  const inflight = new Set<{ spawn?: string; cancelled?: boolean }>(); // requests being served: their claimed rules are given back if we die
  let owned = false; // we created the socket and the pid file: only then are they ours to remove
  let sockIno = -1;  // and only while they are still the ones we created: a successor may have replaced them
  let lastTouch = Date.now();

  // Load before listening: a hook that arrives during startup finds no socket and runs itself, instead of waiting here.
  const load = () => { try { getIndex(); } catch { /* no index yet: hooks answer with their own error rows */ } try { loadVectors(); } catch { /* lexical only */ } };
  load();

  const cleanup = () => {
    for (const p of inflight) { p.cancelled = true; if (p.spawn) releaseTriggerClaims(p.spawn); }
    if (owned) {
      // The pid file is the proof that these are still ours (inode numbers are reused the moment a file is deleted, so
      // the inode is only a second check): a successor that took over writes its own pid there.
      let mine = false;
      try { mine = fs.readFileSync(files().pid, "utf8") === String(process.pid); } catch { /* none */ }
      if (mine) {
        if (!IS_WIN) try { if (fs.statSync(sock).ino === sockIno) fs.unlinkSync(sock); } catch { /* gone or not ours */ }
        for (const f of [files().pid, files().snapshot]) try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
      }
    }
    dropLock();
  };
  const shutdown = (why: string, code = 0) => {
    if (closing) return;
    closing = true;
    logUsage({ client: "skillrouter-service", tool: "service", reason: why, requests: stats.requests, up_s: Math.round((Date.now() - startedAt.getTime()) / 1000) });
    // No server.close(): closing a listening Unix socket makes Node unlink whatever is at its path, which may by now be
    // a successor's socket. New connections get FALLBACK while `closing`, and cleanup() removes our own files, guarded.
    cleanup();
    setTimeout(() => process.exit(code), 20).unref();
  };

  /** Re-read what changed on disk since the last request; restart soon when the router's own code was rebuilt. */
  const refresh = (): boolean => {
    const now = Date.now();
    const data = dataStamp();
    if (data !== dataSeen) { dataSeen = data; resetIndexCache(); resetVectors(); load(); logUsage({ client: "skillrouter-service", tool: "service", reason: "reloaded" }); }
    if (now - codeCheckedAt > 2000) { codeCheckedAt = now; if (codeStamp() !== codeSeen) return true; }
    return false;
  };

  const run = async (agent: AgentId, mode: string, body: string, pending: { spawn?: string; cancelled?: boolean }): Promise<string | null> => {
    if (mode === "-") return body.length > MAX_PROMPT_BYTES ? null : hint(agent, body);
    if (mode === "tool") {
      const first = await toolEvent(agent, body, false);
      if (typeof first === "string") return first;
      pending.spawn = first.spawn; // its rules are claimed now: if we never finish, they are given back
      if (process.env.SKILLROUTER_SERVICE_FAULT === "slow-tool") await new Promise((r) => setTimeout(r, 1000)); // test fault: a worker that overruns the deadline
      const out = (await toolEvent(agent, first.spawn, true, pending)) as string;
      pending.spawn = undefined;
      return out;
    }
    if (mode === "gate") return gateEvent(agent, body, true); // the hook checked its own SKILLROUTER_GATE before asking
    if (mode === "stop") return stopEvent(agent, body);
    if (mode === "decision") return decisionEvent(agent, body);
    return null;
  };

  const snapshot = (): ServiceStatus => {
    const modes: ServiceStatus["byMode"] = {};
    for (const [m, s] of stats.byMode) modes[m] = { count: s.count, avgMs: Math.round((s.ms / s.count) * 10) / 10 };
    let skills = 0, vectors = "off";
    try { skills = getIndex().index.skills.length; const v = loadVectors(); vectors = v ? `${v.ids.length}` : "off"; } catch { /* no index */ }
    return { pid: process.pid, startedAt: startedAt.toISOString(), lastRequestAt: stats.lastAt?.toISOString() ?? null, requests: stats.requests, fallbacks: stats.fallbacks,
      byMode: modes, rssMB: Math.round(process.memoryUsage().rss / 1048576), skills, vectors, idleMin: Math.round(idleMs / 6000) / 10, socket: IS_WIN ? "named pipe" : sock, version: pkgVersion() };
  };
  const writeSnapshot = () => { if (closing) return; try { fs.writeFileSync(files().snapshot + ".tmp", JSON.stringify(snapshot())); renameSyncRetry(files().snapshot + ".tmp", files().snapshot); } catch { /* best effort */ } };

  /** Send a reply and close; a client that lingers without closing is dropped shortly, so it can't hold a slot or block idle exit. */
  const reply = (c: net.Socket, data: string) => { try { c.end(data); } catch { /* gone */ } setTimeout(() => c.destroy(), 1000).unref(); };

  const answer = async (c: net.Socket, agent: string, mode: string, body: Buffer, peer: { gone: boolean }): Promise<void> => {
    const t0 = performance.now();
    lastTouch = Date.now();
    // Let the event loop run first: a client that sent its request and left has its end-of-stream delivered meanwhile.
    // Such a client (or a service that is closing) gets no work done on its behalf; the caller runs the hook itself.
    // (Twice: the end-of-stream is read in the poll after the data, so one turn of the loop is not enough.)
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    if (closing || peer.gone || c.destroyed || !c.writable || c.readableEnded) { reply(c, "FALLBACK\n"); return; }
    const pending: { spawn?: string; cancelled?: boolean } = {};
    inflight.add(pending);
    let out: string | null = null;
    let restart = false;
    try {
      restart = refresh();
      if (mode === "status") out = JSON.stringify(snapshot());
      else if (mode === "shutdown") { out = ""; setTimeout(() => shutdown("requested"), 30).unref(); }
      else if (mode === "hang" && process.env.SKILLROUTER_SERVICE_FAULT === "hang") { for (;;) { /* test fault: wedge the event loop */ } }
      else {
        let timer: NodeJS.Timeout | undefined;
        out = await Promise.race([run(agent as AgentId, mode, body.toString("utf8"), pending), new Promise<null>((r) => { timer = setTimeout(() => r(null), agent === "opencode" ? OPENCODE_DEADLINE_MS : DEADLINE_MS); })]);
        clearTimeout(timer);
        if (out === null) logUsage({ client: "skillrouter-service", tool: "service", reason: "fallback", mode });
      }
    } catch (e) {
      out = null;
      pending.cancelled = true;
      if (pending.spawn) releaseTriggerClaims(pending.spawn);
      logUsage({ client: "skillrouter-service", tool: "service", reason: "error", mode, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    if (out === null) pending.cancelled = true; // a worker still running must write nothing more
    if (out === null && pending.spawn) releaseTriggerClaims(pending.spawn); // the hook run again must find its rules unclaimed
    inflight.delete(pending);
    reply(c, out === null ? "FALLBACK\n" : `OK ${Buffer.byteLength(out)}\n${out}`);
    if (mode !== "status" && mode !== "shutdown") {
      stats.requests++; stats.lastAt = new Date();
      if (out === null) stats.fallbacks++;
      const m = stats.byMode.get(mode) ?? { count: 0, ms: 0 };
      m.count++; m.ms += performance.now() - t0; stats.byMode.set(mode, m);
    }
    lastTouch = Date.now();
    if (restart) shutdown("code_changed"); // the next hook starts the rebuilt code
  };

  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    if (active >= MAX_CONNECTIONS || closing) { c.on("error", () => {}); reply(c, "FALLBACK\n"); return; }
    active++;
    lastTouch = Date.now();
    c.on("close", () => { active--; clearTimeout(timer); });
    c.on("error", () => {});
    const timer = setTimeout(() => c.destroy(), RECEIVE_MS); // a client that stalls mid-request is dropped
    // Our clients wait for the reply with their side open, so a client that ends its side has left (or been killed).
    const peer = { gone: false };
    c.on("end", () => { peer.gone = true; });
    let head = Buffer.alloc(0);
    let header: { agent: string; mode: string; len: number } | null = null;
    let chunks: Buffer[] = [];
    let got = 0;
    let started = false;
    c.on("data", (d) => {
      if (started) return;
      if (!header) {
        head = Buffer.concat([head, d]);
        let nl = head.indexOf(10);
        // (Windows) a client that wants proof of who it is talking to opens with a nonce; the request follows once it has it.
        const hello = key && nl >= 0 ? HELLO.exec(head.subarray(0, nl).toString("latin1")) : null;
        if (hello) { c.write(`HELLO ${serverProof(key!, hello[1])}\n`); head = head.subarray(nl + 1); nl = head.indexOf(10); }
        if (nl < 0) { if (head.length > 128) c.destroy(); return; }
        const m = HEADER.exec(head.subarray(0, nl).toString("latin1"));
        const len = m ? Number(m[3]) : -1;
        const limit = m && m[2] === "-" ? MAX_PROMPT_BYTES : MAX_EVENT_BYTES;
        if (!m || len > limit || (m[2] === "hang" && process.env.SKILLROUTER_SERVICE_FAULT !== "hang")) { started = true; clearTimeout(timer); reply(c, "FALLBACK\n"); return; }
        header = { agent: m[1], mode: m[2], len };
        const rest = head.subarray(nl + 1);
        if (rest.length) { chunks.push(rest); got = rest.length; }
      } else { chunks.push(d); got += d.length; }
      // The pieces are joined once, when the whole body is here (joining on every 8 KB piece is quadratic).
      if (got >= header.len) { started = true; clearTimeout(timer); const body = Buffer.concat(chunks).subarray(0, header.len); chunks = []; void answer(c, header.agent, header.mode, body, peer); }
    });
  });

  server.on("error", (e) => {
    // Another service won the race to this socket: it is fine, and its socket and pid file are not ours to touch.
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // (Windows) A pipe's name lingers for a moment after the service that held it is stopped (`service restart`, an install,
      // an idle exit just before): wait for it instead of taking it for someone else's. Nothing to unlink there, so it is only a wait.
      if (IS_WIN && ++listenTries < 15) { setTimeout(() => server.listen(sock), 100); return; }
      // Another service won the race: fine. But if what holds the name does not answer as a service (a stuck one we could
      // not kill, or someone else), every hook would start another of us: pause starting instead.
      void ping(sock, 400).then((state) => {
        if (state !== "alive") { try { fs.writeFileSync(files().off, String(Date.now())); } catch { /* best effort */ } logUsage({ client: "skillrouter-service", tool: "service", reason: "name_taken" }); }
        dropLock(); process.exit(0);
      });
      return;
    }
    try { fs.writeFileSync(files().off, String(Date.now())); } catch { /* best effort */ }
    logUsage({ client: "skillrouter-service", tool: "service", reason: "listen_failed", error: String((e as Error)?.message ?? e).slice(0, 200) });
    cleanup();
    process.exit(1);
  });

  let listenTries = 0;
  const oldMask = IS_WIN ? 0 : process.umask(0o177); // the socket is created owner-only, never briefly wider
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  if (!IS_WIN) process.umask(oldMask);
  owned = true;
  if (!IS_WIN) {
    try { sockIno = fs.statSync(sock).ino; } catch { /* checked again at cleanup */ }
    try { fs.chmodSync(sock, 0o600); } catch { /* already 0600 */ }
  }
  fs.writeFileSync(files().pid, String(process.pid), { mode: 0o600 });
  try { fs.rmSync(files().off, { force: true }); } catch { /* none */ }
  dropLock();
  logUsage({ client: "skillrouter-service", tool: "service", reason: "started", pid: process.pid });

  // Idle exit, the periodic snapshot `doctor` reads, and signals.
  const tick = setInterval(() => {
    // Hooks find a Windows service through its key file: if that is gone or replaced, nobody can reach this one any more.
    if (key && keyReplaced(key)) shutdown("key_changed");
    else if (active === 0 && Date.now() - lastTouch > idleMs) shutdown("idle");
    else writeSnapshot();
  }, Math.min(30000, Math.max(100, idleMs / 4)));
  tick.unref();
  writeSnapshot();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", ...(IS_WIN ? ["SIGBREAK" as const] : [])]) process.on(sig, () => shutdown(sig)); // (Windows delivers only SIGINT and SIGBREAK; `service stop` uses a request)
  process.on("uncaughtException", (e) => {
    logUsage({ client: "skillrouter-service", tool: "service", reason: "crashed", error: String(e?.message ?? e).slice(0, 200) });
    // A service that dies soon after starting would be restarted by every hook: pause starting it for a few minutes.
    if (Date.now() - startedAt.getTime() < 60_000) try { fs.writeFileSync(files().off, String(Date.now())); } catch { /* best effort */ }
    closing = true; cleanup(); process.exit(1);
  });
  process.on("unhandledRejection", (e) => { logUsage({ client: "skillrouter-service", tool: "service", reason: "rejected", error: String((e as Error)?.message ?? e).slice(0, 200) }); });

  // Warm the model last: requests are already being answered (lexically) while it loads.
  const v = loadVectors();
  if (v) embed(["warm up"]).catch(() => { /* lexical only */ });
}

function pkgVersion(): string {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version; } catch { return "?"; }
}

/** `service stop`: ask it to exit; falls back to its pidfile when it doesn't answer. True when something was stopped. */
export async function stopService(): Promise<boolean> {
  const sock = socketPath();
  const state = await ping(sock, 400);
  if (state === "alive") {
    await new Promise<void>((resolve) => { const c = net.connect(sock); c.resume(); /* an unread socket never reports its close */ c.on("connect", () => c.write(`${PROTOCOL} - shutdown 0\n`)); c.on("close", () => resolve()); c.on("error", () => resolve()); setTimeout(resolve, 1500).unref(); });
    // A pipe has no file to wait for: it is gone when nothing answers on it.
    for (let i = 0; i < 20 && !(IS_WIN ? (await ping(sock, 200)) === "dead" : !fs.existsSync(sock)); i++) await new Promise((r) => setTimeout(r, 50));
    return true;
  }
  if (state === "hung") {
    const killed = killStale();
    if (!IS_WIN) { try { fs.unlinkSync(sock); } catch { /* gone */ } return true; }
    if (killed !== null) forgetFiles(killed); // (not when the kill was refused: the pid file is all that can find it later)
    return killed !== null;
  }
  if (!IS_WIN) try { fs.unlinkSync(sock); } catch { /* none */ }
  // The socket file is gone but the process may live on (deleted by hand, a wiped run dir): stop it by its pid file.
  try {
    const pid = Number(fs.readFileSync(files().pid, "utf8"));
    if (pid !== process.pid && alive(pid) && isOurService(pid)) { process.kill(pid, "SIGTERM"); if (IS_WIN) forgetFiles(pid); return true; }
  } catch { /* no pid file */ }
  return false;
}

/** Windows ends a process outright, so its own cleanup never runs: remove the pid file and snapshot it leaves (only if they are its). */
function forgetFiles(pid?: number): void {
  try {
    const recorded = fs.readFileSync(files().pid, "utf8");
    if (pid !== undefined && recorded !== String(pid)) return;
    for (const f of [files().pid, files().snapshot]) fs.rmSync(f, { force: true });
  } catch { /* none */ }
}

export { status };
