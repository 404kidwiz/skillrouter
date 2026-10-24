// The warm service: protocol, parity with the standalone hooks, reload, idle exit, self-update, crash and hang
// recovery, hostile clients, and the launcher end to end. Every test starts and stops its own service.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-b12-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows reads this, not HOME, for os.homedir()
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
delete process.env.SKILLROUTER_SERVICE; // the test script turns it off for the other files; this file tests it
process.env.SKILLROUTER_SERVICE_IDLE_MIN = "1"; // a service started indirectly (launcher, Node client) never outlives the run by long
const SR = process.env.SKILLROUTER_HOME;
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const { socketPath, runDir, query, ping, status, ownedByMe, serviceEnabled, serviceSnapshot, ensureKey, serverProof, readKey, PERL_CLIENT } = await import("../src/service-client.js");
const { stopService, takeLock } = await import("../src/service.js");
const { hint, sessionHash } = await import("../src/hint.js");
const { toolEvent, stopEvent } = await import("../src/events.js");
const { writeLauncher } = await import("../src/install.js");
const { health } = await import("../src/health.js");
const { addShown, markTurn } = await import("../src/state.js");

// Windows runs the transport-agnostic half of this file (named pipe instead of a Unix socket). What needs sh, Perl, signals,
// file modes or a socket file to delete is skipped there; batch14 covers the Windows-only parts.
const WIN = process.platform === "win32";
const winSkip = (why: string) => WIN && `POSIX only: ${why}`;
const sockExists = async () => WIN ? (await ping(socketPath(), 200)) !== "dead" : fs.existsSync(socketPath()); // a pipe is found by connecting

const procs: ChildProcess[] = [];
process.on("exit", () => {
  // Any service still running on this test's state folder (one a launcher or the Node client started in the background) goes too.
  try { for (const line of spawnSync("ps", ["-axeww", "-o", "pid=,command="], { encoding: "utf8" }).stdout.split("\n")) { const m = /^\s*(\d+)\s.*cli\.js serve\b/.exec(line); if (m && line.includes(`SKILLROUTER_HOME=${SR}`)) try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* gone */ } } } catch { /* no ps */ }
  for (const p of procs) try { p.kill("SIGKILL"); } catch { /* gone */ } try { const pid = Number(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8")); process.kill(pid, "SIGKILL"); } catch { /* none */ } try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* a Windows process still dying holds its folder */ }; try { fs.unlinkSync(socketPath()); } catch { /* none */ } });

const skill = (id: string, words: string) => ({ id, name: id, description: `A skill about ${words} with enough description to pass the gate`, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/-/g, " ")} ${words} `.repeat(3)) });
const filler = Array.from({ length: 80 }, (_, i) => skill(`filler-${i}`, `sourdough kiln glaze proofing number ${i} hobby baking pottery`));
const writeIndex = (extra: ReturnType<typeof skill>[] = [], builtAt = "svc1") => saveIndex({ builtAt, roots: [], tokenizer: 2, skills: [
  skill("python-testing", "python testing pytest tests fixtures mocking writing fixing"), skill("docker-patterns", "docker dockerfile compose containers multi stage builds"), ...extra, ...filler] } as any);
writeIndex();
fs.writeFileSync(path.join(SR, "core.txt"), "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(40); } return false; }
function startService(env: Record<string, string> = {}): ChildProcess {
  const p = spawn(process.execPath, [cli, "serve"], { env: { ...process.env, ...env }, stdio: "ignore" });
  p.unref(); // a lingering service must never keep the test process alive
  procs.push(p);
  return p;
}
const aliveNow = async () => (await ping(socketPath(), 300)) === "alive";
async function up(env?: Record<string, string>) { const p = startService(env); assert.ok(await waitFor(aliveNow), "the service came up"); return p; }
async function down() { await stopService(); await waitFor(async () => !(await sockExists()), 4000); }
const settle = async () => {
  await sleep(300);
  const end = Date.now() + 2000;
  while (Date.now() < end && fs.existsSync(path.join(runDir(), "svc.lock"))) await sleep(50);
  await stopService().catch(() => {});
  for (const s of [...fakes]) { fakes.delete(s); for (const c of (s as any).conns ?? []) c.destroy(); await new Promise<void>((r) => { s.close(() => r()); setTimeout(r, 200); }); }
};
/** `test`, then clean up any service the test (or a launcher it ran) left running. */
function svc(name: string, a: any, b?: any) {
  const opts = typeof a === "function" ? {} : a;
  const fn = typeof a === "function" ? a : b;
  return test(name, opts, async (ctx) => { try { await fn(ctx); } finally { await settle(); } });
}
const pidOf = () => Number(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8"));
const mask = (s: string) => s.replace(/hint_id=\\?"[0-9a-f-]{36}\\?"/g, "hint_id=X");
const promptBody = (session: string, text = "write pytest tests for the api client and fix the failing python fixtures") => JSON.stringify({ session_id: session, prompt_id: "p1", prompt: text });

test("socket path: inside the state dir when short, a short per-user path under /tmp when long", { skip: winSkip("Unix socket paths") }, () => {
  assert.equal(socketPath("/home/u/.skillrouter"), "/home/u/.skillrouter/run/svc.sock");
  const long = "/var/folders/ld/wrzpdvw10j9fy9hts8t3z39w0000gn/T/skillrouter-some-long-test-directory/.skillrouter";
  const p = socketPath(long);
  assert.match(p, /^\/tmp\/skillrouter-\d+-[0-9a-f]{12}\.sock$/);
  assert.ok(Buffer.byteLength(p) < 104);
  assert.equal(socketPath(long), p, "deterministic");
  assert.notEqual(socketPath(long + "x"), p);
  assert.equal(ownedByMe("/nonexistent/sock"), false);
  assert.equal(serviceEnabled(), true);
});

svc("a running service answers prompt checks, tool events and stop events exactly like the standalone hooks", async () => {
  await up();
  const a = await query("claude", "-", promptBody("par-1"));
  assert.ok(a && a.includes("python-testing"), String(a));
  assert.equal(mask(a!), mask(await hint("claude", promptBody("par-2"))), "prompt check parity");
  assert.equal(await query("claude", "-", promptBody("par-3", "what time is it in Paris right now")), await hint("claude", promptBody("par-4", "what time is it in Paris right now")), "no-match parity (empty)");
  const edit = (s: string) => JSON.stringify({ session_id: s, prompt_id: "p1", cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/tests/test_api.py" } });
  const viaService = await query("claude", "tool", edit("par-t1"));
  const first = await toolEvent("claude", edit("par-t2"), false) as { spawn: string };
  assert.equal(mask(viaService!), mask(await toolEvent("claude", first.spawn, true) as string), "trigger parity");
  assert.match(viaService!, /you worked on tests/);
  assert.equal(await query("claude", "tool", JSON.stringify({ session_id: "par-t3", tool_name: "Bash", tool_input: { command: "ls" } })), "", "no trigger: empty output, not a failure");
  const S = sessionHash("par-s")!; markTurn(S, sessionHash("p1")); addShown(S, ["python-testing"], sessionHash("p1"));
  const stop = JSON.stringify({ session_id: "par-s", prompt_id: "p1", transcript_path: "/nonexistent" });
  assert.equal(await query("claude", "stop", stop), stopEvent("claude", stop));
  const s = await status();
  assert.ok(s && s.requests === 5 && s.skills === 82 && s.pid === pidOf());
  await down();
});

svc("it reloads when the index changes on disk, without restarting", async () => {
  await up();
  const pid = pidOf();
  assert.ok(!(await query("claude", "-", promptBody("rl-1", "knit a cable sweater with merino yarn and blocking")))?.includes("knitting-skill"));
  writeIndex([skill("knitting-skill", "knit cable sweater merino yarn blocking swatch gauge")], "svc2");
  const after = await query("claude", "-", promptBody("rl-2", "knit a cable sweater with merino yarn and blocking"));
  assert.match(after!, /knitting-skill/, "the new skill is found on the next request");
  assert.equal(pidOf(), pid, "same process");
  assert.equal((await status())!.skills, 83);
  writeIndex();
  await down();
});

svc("it exits when idle and cleans up after itself", async () => {
  const p = await up({ SKILLROUTER_SERVICE_IDLE_MIN: "0.01" });
  assert.ok(await waitFor(() => p.exitCode !== null, 6000), "exited on its own");
  assert.ok(!(await sockExists()) && !fs.existsSync(path.join(runDir(), "svc.pid")), "socket and pid file removed");
});

svc("it restarts itself when its own code changes", async () => {
  const code = path.join(home, "code"); fs.mkdirSync(code, { recursive: true }); fs.writeFileSync(path.join(code, "a.js"), "1");
  const p = await up({ SKILLROUTER_SERVICE_CODE_DIR: code });
  assert.equal(await query("claude", "tool", JSON.stringify({ session_id: "cc", tool_name: "Bash", tool_input: { command: "ls" } })), "");
  await sleep(2100);
  fs.writeFileSync(path.join(code, "a.js"), "22");
  assert.notEqual(await query("claude", "-", promptBody("cc-2")), null, "the request that notices the change is still answered");
  assert.ok(await waitFor(() => p.exitCode !== null, 4000), "then it exits, so the next hook starts the new code");
});

svc("SIGTERM cleans up; SIGKILL leaves a stale socket that the next start replaces", { skip: winSkip("signals and a socket file") }, async () => {
  const p = await up();
  p.kill("SIGTERM");
  assert.ok(await waitFor(() => p.exitCode !== null || p.signalCode !== null));
  assert.ok(!fs.existsSync(socketPath()), "no socket left after SIGTERM");
  const q = await up();
  assert.equal(fs.statSync(socketPath()).mode & 0o777, 0o600, "owner-only socket");
  assert.equal(fs.statSync(runDir()).mode & 0o777, 0o700, "owner-only run dir");
  q.kill("SIGKILL");
  assert.ok(await waitFor(() => q.signalCode !== null));
  assert.ok(fs.existsSync(socketPath()), "SIGKILL leaves the socket file behind");
  assert.equal(await ping(socketPath(), 300), "dead", "nothing is listening on it");
  assert.equal(await query("claude", "-", promptBody("st-1")), null, "callers get null, and fall back");
  spawnSync(process.execPath, [cli, "serve", "--start"], { env: process.env });
  assert.ok(await waitFor(aliveNow), "serve --start replaced the stale socket");
  assert.match((await query("claude", "-", promptBody("st-2")))!, /python-testing/);
  await down();
});

svc("a wedged service is killed and replaced", async () => {
  const wedged = await up({ SKILLROUTER_SERVICE_FAULT: "hang" });
  const oldPid = pidOf();
  net.connect(socketPath()).on("error", () => {}).on("connect", function (this: net.Socket) { this.write("SR1 - hang 0\n"); });
  await sleep(300);
  assert.equal(await ping(socketPath(), 300), "hung");
  spawnSync(process.execPath, [cli, "serve", "--start"], { env: { ...process.env, SKILLROUTER_SERVICE_FAULT: "" } });
  assert.ok(await waitFor(async () => (await aliveNow()) && pidOf() !== oldPid, 10000), "a new service took over");
  assert.ok(await waitFor(() => wedged.exitCode !== null || wedged.signalCode !== null), "the wedged one was killed");
  assert.match((await query("claude", "-", promptBody("wd-1")))!, /python-testing/);
  await down();
});

svc("two services started at once leave exactly one", async () => {
  const a = startService(), b = startService();
  assert.ok(await waitFor(aliveNow));
  await sleep(600);
  const live = [a, b].filter((p) => p.exitCode === null && p.signalCode === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].pid, pidOf());
  await down();
});

svc("hostile or broken clients can't hurt it: garbage, oversize, stalls, floods", async () => {
  await up({ SKILLROUTER_SERVICE_RECEIVE_MS: "400" });
  const raw = (data: string | Buffer, wait = 200) => new Promise<string>((resolve) => {
    const c = net.connect(socketPath()); let out = "";
    c.on("data", (d) => (out += d)); c.on("error", () => resolve(out)); c.on("close", () => resolve(out));
    c.on("connect", () => c.write(data)); setTimeout(() => { c.destroy(); resolve(out); }, wait);
  });
  assert.equal(await raw("hello there\n"), "FALLBACK\n", "not our protocol");
  assert.equal(await raw("SR1 claude - 99999999\n"), "FALLBACK\n", "length beyond any limit");
  assert.equal(await raw("SR1 claude - 300000\n"), "FALLBACK\n", "a prompt larger than the prompt limit");
  assert.equal(await raw("SR1 nobody tool 3\nabc"), "FALLBACK\n", "unknown agent");
  assert.equal(await raw("SR1 claude hang 0\n"), "FALLBACK\n", "fault injection is off unless the env says so");
  assert.equal(await raw("x".repeat(500)), "", "a header that never ends is dropped without a reply");
  assert.equal(await raw("SR1 claude - 50\nonly-ten", 1200), "", "a body that stalls is dropped after the receive timeout");
  assert.equal(await raw(Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0x80])), "FALLBACK\n", "binary junk");
  await Promise.all(Array.from({ length: WIN ? 80 : 150 }, () => raw("SR1 claude - 5000\nshort", 100))); // (a Windows client that finds every pipe instance busy waits for one: fewer, still past the cap of 64)
  const during = await Promise.all(Array.from({ length: 10 }, () => raw("SR1 claude - 5000\nshort", 1500)));
  assert.ok(during.every((r) => r === "" || r === "FALLBACK\n"), "past the connection cap the extras are told to fall back, never left hanging");
  await sleep(600); // the stalled ones time out (400 ms here) and free their slots
  assert.match((await query("claude", "-", promptBody("ho-1")))!, /python-testing/, "still answering after all of it");
  assert.equal(await query("claude", "tool", JSON.stringify({ session_id: "ho-2", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "x".repeat(900_000) })), "", "a 900 KB tool payload is fine");
  assert.equal(await query("claude", "tool", JSON.stringify({ session_id: "ho-2b", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "x".repeat(1_500_000) })), null, "beyond 1 MB clients keep the work (the hook is faster than shipping it)");
  assert.equal(await raw(`SR1 claude tool ${Buffer.byteLength(JSON.stringify({ session_id: "ho-2c", tool_name: "Bash", tool_input: { command: "ls" }, pad: "x".repeat(1_500_000) }))}\n${JSON.stringify({ session_id: "ho-2c", tool_name: "Bash", tool_input: { command: "ls" }, pad: "x".repeat(1_500_000) })}`, 1500), "OK 0\n", "the service itself still accepts such a payload, up to its own 8 MB limit");
  const big = await Promise.all(Array.from({ length: 8 }, (_, i) => query("claude", "tool", JSON.stringify({ session_id: `ho-big${i}`, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "y".repeat(900_000) }), 3000)));
  assert.ok(big.every((r) => r === ""), "8 concurrent 900 KB payloads");
  const parallel = await Promise.all(Array.from({ length: 40 }, (_, i) => query("claude", "-", promptBody(`ho-p${i}`), 5000))); // correctness, not latency: a loaded CI runner needs more than the default 700 ms for 40 at once
  assert.ok(parallel.every((r) => r !== null && r.includes("python-testing")), "40 at once");
  await down();
});

svc("the Node client is a full transport on its own (hosts without perl)", async () => {
  await up();
  const run = (extra: Record<string, string> = {}) => spawnSync(process.execPath, [cli, "hint", "claude"], { input: promptBody("nc-" + Math.random()), env: { ...process.env, ...extra }, encoding: "utf8" });
  const before = (await status())!.requests;
  const r = run();
  assert.match(r.stdout, /python-testing/);
  assert.equal((await status())!.requests, before + 1, "the request went through the service");
  run({ SKILLROUTER_SERVICE_TRIED: "1" });
  assert.equal((await status())!.requests, before + 1, "a launcher that already asked doesn't make Node ask again");
  run({ SKILLROUTER_SERVICE: "0" });
  assert.equal((await status())!.requests, before + 1, "SKILLROUTER_SERVICE=0 never touches it");
  await down();
});

svc("doctor and the service commands report its state", async () => {
  assert.match(health().join("\n"), /Service: not running/);
  await up();
  await query("claude", "-", promptBody("dr-1"));
  assert.ok(await waitFor(() => serviceSnapshot().running && serviceSnapshot().requests !== undefined, 4000));
  assert.match(health().join("\n"), /Service: running \(pid \d+/);
  const out = spawnSync(process.execPath, [cli, "service", "status"], { env: process.env, encoding: "utf8" }).stdout;
  assert.match(out, /Service: running, pid \d+/);
  assert.match(out, /index 82 skills/);
  assert.match(spawnSync(process.execPath, [cli, "service", "stop"], { env: process.env, encoding: "utf8" }).stdout, /Service stopped/);
  assert.ok(await waitFor(async () => (await ping(socketPath(), 200)) === "dead"));
  assert.match(spawnSync(process.execPath, [cli, "service", "status"], { env: process.env, encoding: "utf8" }).stdout, /not running/);
  process.env.SKILLROUTER_SERVICE = "0"; assert.match(health().join("\n"), /Service: off/); delete process.env.SKILLROUTER_SERVICE;
});

const hasPerl = !WIN && spawnSync("perl", ["-e", "1"]).status === 0; // the launcher is sh + Perl: POSIX only
svc("the launcher: falls back and starts the service when there is none, then uses it", { skip: !hasPerl && "needs sh and perl" }, async () => {
  const launcher = path.join(SR, "bin", "skillrouter-hint");
  writeLauncher(process.execPath, cli, launcher);
  assert.ok(fs.existsSync(path.join(SR, "bin", "skillrouter-client.pl")));
  assert.equal(fs.readFileSync(path.join(SR, "bin", "skillrouter-client.pl"), "utf8"), PERL_CLIENT);
  const call = (session: string, args: string[] = ["claude"], env: Record<string, string> = {}, body = promptBody(session)) =>
    spawnSync("sh", [launcher, ...args], { input: body, env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(await ping(socketPath(), 200), "dead");
  const cold = call("ln-1");
  assert.match(cold.stdout, /python-testing/, "no service: the hook still answers");
  assert.ok(await waitFor(aliveNow, 10000), "the first call started the service in the background");
  const requests = (await status())!.requests;
  const warm = call("ln-2");
  assert.equal(mask(warm.stdout), mask(cold.stdout.replace(/ln-1/g, "ln-2")));
  assert.equal((await status())!.requests, requests + 1, "the warm call went through the service");
  const t0 = Date.now(); for (let i = 0; i < 5; i++) call(`ln-t${i}`, ["claude", "tool"], {}, JSON.stringify({ session_id: "ln-tool", tool_name: "Bash", tool_input: { command: "ls" } }));
  assert.ok((Date.now() - t0) / 5 < 250, `tool hooks through the service take ${(Date.now() - t0) / 5} ms each`);
  const off = call("ln-3", ["claude"], { SKILLROUTER_SERVICE: "0" });
  assert.match(off.stdout, /python-testing/);
  assert.equal((await status())!.requests, requests + 6, "SKILLROUTER_SERVICE=0 bypasses it");
  fs.unlinkSync(path.join(SR, "bin", "skillrouter-client.pl"));
  assert.match(call("ln-4").stdout, /python-testing/, "no perl client file: Node answers (through the service or itself)");
  await down();
});

svc("the launcher: a wedged service costs one slow call, then it is replaced", { skip: !hasPerl && "needs sh and perl" }, async () => {
  const launcher = path.join(SR, "bin", "skillrouter-hint");
  writeLauncher(process.execPath, cli, launcher);
  const wedged = await up({ SKILLROUTER_SERVICE_FAULT: "hang" });
  const oldPid = pidOf();
  net.connect(socketPath()).on("error", () => {}).on("connect", function (this: net.Socket) { this.write("SR1 - hang 0\n"); });
  await sleep(300);
  const t0 = Date.now();
  const r = spawnSync("sh", [launcher, "claude"], { input: promptBody("lw-1"), env: { ...process.env, SKILLROUTER_SERVICE_FAULT: "" }, encoding: "utf8" });
  assert.match(r.stdout, /python-testing/, "the hook still answered, by itself");
  assert.ok(Date.now() - t0 < 4500, `took ${Date.now() - t0} ms`);
  assert.ok(await waitFor(async () => (await aliveNow()) && pidOf() !== oldPid, 10000), "a healthy service replaced it");
  assert.ok(wedged.signalCode !== null || wedged.exitCode !== null);
  const requests = (await status())!.requests;
  assert.match(spawnSync("sh", [launcher, "claude"], { input: promptBody("lw-2"), env: process.env, encoding: "utf8" }).stdout, /python-testing/);
  assert.equal((await status())!.requests, requests + 1);
  await down();
});

// ---- findings from the QA review ---------------------------------------------------------------------------------
const { isServiceCommand, parseEtime } = await import("../src/service.js");
const launcherPath = path.join(SR, "bin", "skillrouter-hint");
const sh = (args: string[], opts: { input?: string; env?: Record<string, string> } = {}) => spawnSync("sh", [launcherPath, ...args], { input: opts.input, env: { ...process.env, ...opts.env }, encoding: "utf8" });
// Servers standing in for a service. One left listening by a test that failed halfway would keep this process alive forever.
const fakes = new Set<net.Server>();
const fake = async (onConn: (c: net.Socket) => void): Promise<net.Server> => {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  if (WIN) ensureKey(); // the pipe's name comes from the key
  try { fs.unlinkSync(socketPath()); } catch { /* none */ }
  const conns = new Set<net.Socket>();
  const s = net.createServer((c) => {
    conns.add(c); c.on("error", () => {}); c.on("close", () => conns.delete(c));
    if (!WIN) return onConn(c);
    // On Windows a real service first proves itself to the client with an HMAC of its nonce; a fake that stands in for one does the same.
    c.once("data", (first) => {
      const m = /^SR1 - hello ([0-9a-f]{32})\n/.exec(first.toString("latin1"));
      if (m) { c.write(`HELLO ${serverProof(readKey()!, m[1])}\n`); first = first.subarray(m[0].length); }
      onConn(c);
      if (first.length) c.emit("data", first);
    });
  });
  (s as any).conns = conns;
  await new Promise<void>((r) => s.listen(socketPath(), r));
  fakes.add(s);
  return s;
};
// A launcher that found the fake hung may have replaced it with a real service at the same path, so stop that first:
// closing the fake would otherwise unlink the real service's socket and orphan it.
const closeFake = async (s: net.Server) => {
  fakes.delete(s);
  await sleep(700);
  await stopService().catch(() => {});
  for (const c of (s as any).conns ?? []) c.destroy(); // a fake that never answers leaves its clients' connections open
  await new Promise<void>((r) => { s.close(() => r()); setTimeout(r, 200); });
  try { fs.unlinkSync(socketPath()); } catch { /* gone */ }
};

svc("the launcher never hangs on stdin: a pipe that stays open, or no stdin at all", { skip: !hasPerl && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  for (const env of [{}, { SKILLROUTER_SERVICE: "0" }]) {
    const t0 = Date.now();
    const p = spawn("sh", [launcherPath, "claude"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    procs.push(p);
    p.stdin!.write("{"); // a start of JSON, and then the host just never closes the pipe
    const code = await new Promise<number | null>((resolve) => { p.on("exit", resolve); setTimeout(() => { p.kill("SIGKILL"); resolve(-1); }, 6000); });
    assert.equal(code, 0, `exit ${code} with ${JSON.stringify(env)}`);
    assert.ok(Date.now() - t0 < 4000, `an open stdin took ${Date.now() - t0} ms with ${JSON.stringify(env)}`);
  }
  const t1 = Date.now();
  const closed = spawnSync("sh", ["-c", `"${launcherPath}" claude <&-`], { env: process.env, encoding: "utf8", timeout: 6000 });
  assert.equal(closed.status, 0);
  assert.ok(Date.now() - t1 < 3000, "a closed stdin is not a hang either");
});

svc("the launcher survives a Perl client that cannot run, and a Perl that is not there", { skip: !hasPerl && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  const client = path.join(SR, "bin", "skillrouter-client.pl");
  fs.writeFileSync(client, "this is not perl (\n");
  assert.match(sh(["claude"], { input: promptBody("pb-1") }).stdout, /python-testing/, "a client that fails to compile: Node answers, with stdin intact");
  fs.writeFileSync(client, "use Not::A::Real::Module;\n");
  assert.match(sh(["claude"], { input: promptBody("pb-2") }).stdout, /python-testing/, "a missing module");
  fs.writeFileSync(client, PERL_CLIENT);
  assert.match(sh(["claude"], { input: promptBody("pb-3"), env: { PATH: "/usr/bin/nonexistent" } }).stdout || "", /^$|python-testing/, "no perl on PATH");
});

svc("a misbehaving server costs bounded time and the hook still answers (hung, partial, garbage, FALLBACK)", { skip: !hasPerl && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  const cases: [string, (c: net.Socket) => void, number][] = [
    ["never replies", () => {}, 3200],
    ["partial reply, then silence", (c) => { c.write("OK 500\nshort"); }, 3200],
    ["garbage with a newline", (c) => { c.write("what is this\nmore garbage"); }, 1800],
    ["FALLBACK", (c) => { c.end("FALLBACK\n"); }, 1800],
    ["closes immediately", (c) => { c.destroy(); }, 1800],
  ];
  for (const [name, onConn, budget] of cases) {
    const srv = await fake((c) => { c.on("data", () => onConn(c)); });
    const t0 = Date.now();
    const r = sh(["claude"], { input: promptBody("ms-" + name.length), env: { SKILLROUTER_SERVICE_TRIED: "" } });
    const took = Date.now() - t0;
    assert.match(r.stdout, /python-testing/, `${name}: the hook answered`);
    assert.ok(took < budget, `${name}: took ${took} ms (budget ${budget})`);
    await closeFake(srv);
    await sleep(200);
    if (await aliveNow()) await down(); // a starter may have replaced the fake with a real service
  }
});

svc("through the launcher every host's output equals the standalone output, for prompt, tool and stop events", { skip: !hasPerl && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  await up();
  const agents = ["claude", "codex", "cursor", "gemini", "opencode"];
  const sessions = new Set<string>();
  const sid = (tag: string) => { const s = `par-${tag}-${Math.random().toString(36).slice(2, 8)}`; sessions.add(s); return s; };
  for (const agent of agents) {
    const run = (mode: string[], mk: (s: string) => string, env: Record<string, string>) => sh([agent, ...mode], { input: mk(sid(agent + mode.join("")) ), env }).stdout;
    const cases: [string[], (s: string) => string][] = [
      [[], (s) => promptBody(s)],
      [[], (s) => promptBody(s, "hi")],
      [[], () => "not json at all"],
      [["tool"], (s) => JSON.stringify({ session_id: s, prompt_id: "p1", cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/tests/test_api.py" } })],
      [["tool"], (s) => JSON.stringify({ session_id: s, tool_name: "Bash", tool_input: { command: "ls" } })],
      [["stop"], (s) => JSON.stringify({ session_id: s, prompt_id: "p1", transcript_path: "/nonexistent" })],
      [["decision"], (s) => JSON.stringify({ session_id: s, prompt_id: "p1", text: "Skills: none (x)" })],
    ];
    for (const [mode, mk] of cases) {
      const viaService = run(mode, mk, {});
      const standalone = run(mode, mk, { SKILLROUTER_SERVICE: "0" });
      assert.equal(mask(viaService).replace(/par-[a-z]+[a-z0-9]*-[a-z0-9]{6}/g, "S"), mask(standalone).replace(/par-[a-z]+[a-z0-9]*-[a-z0-9]{6}/g, "S"), `${agent} ${mode.join(" ") || "prompt"}`);
    }
  }
  assert.ok((await status())!.requests >= agents.length * 5, "most of these went through the service");
  await down();
});

svc("big payloads and another state dir bypass the service; the launcher answers itself", { skip: !hasPerl && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  await up();
  const before = (await status())!.requests;
  const big = sh(["claude", "tool"], { input: JSON.stringify({ session_id: "bp-1", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "z".repeat(2_000_000) }) });
  assert.equal(big.status, 0);
  assert.equal((await status())!.requests, before, "2 MB never went over the socket");
  const other = path.join(home, "other-state"); fs.mkdirSync(other, { recursive: true });
  const r = sh(["claude"], { input: promptBody("bp-2"), env: { SKILLROUTER_HOME: other } });
  assert.equal(r.status, 0);
  assert.equal((await status())!.requests, before, "SKILLROUTER_HOME pointing elsewhere: the hook runs on its own, in that dir");
  assert.ok(fs.existsSync(path.join(other, "usage.jsonl")), "and logged there, not in the service's dir");
  await down();
});

svc("a stale lock and several starters at once never orphan a healthy service", async () => {
  for (let round = 0; round < 4; round++) {
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
    const lock = path.join(runDir(), "svc.lock");
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "pid"), "999999");
    const old = new Date(Date.now() - 60_000); fs.utimesSync(lock, old, old);
    const children = Array.from({ length: 6 }, () => startService());
    assert.ok(await waitFor(aliveNow, 10000), `round ${round}: a service came up`);
    await sleep(500);
    const live = children.filter((p) => p.exitCode === null && p.signalCode === null);
    assert.equal(live.length, 1, `round ${round}: exactly one survives`);
    assert.equal(live[0].pid, pidOf(), `round ${round}: and it is the one named in the pid file`);
    assert.ok((await sockExists()) && !fs.existsSync(path.join(runDir(), "svc.off")), `round ${round}: socket present, no failure pause`);
    assert.match((await query("claude", "-", promptBody("sl-" + round)))!, /python-testing/);
    await down();
  }
});

svc("a service that loses the race for the socket leaves the winner's socket and pid file alone", async () => {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(runDir(), "svc.off"), { force: true });
  const winner = await fake((c) => { c.on("data", () => c.end("OK 0\n")); });
  fs.writeFileSync(path.join(runDir(), "svc.pid"), String(process.pid));
  const loser = startService({ SKILLROUTER_SERVICE_FAULT: "skip-recovery" });
  assert.ok(await waitFor(() => loser.exitCode !== null, 6000), "it gave up");
  assert.ok(await sockExists(), "the socket is still there");
  assert.equal(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8"), String(process.pid), "the pid file is untouched");
  assert.ok(!fs.existsSync(path.join(runDir(), "svc.off")), "losing a race is not a failure to pause for");
  assert.equal(await query("claude", "-", "{}"), "", "the winner still answers");
  await closeFake(winner);
  fs.rmSync(path.join(runDir(), "svc.pid"), { force: true });
});

svc("only a real skillrouter service is ever killed: pid checks", { skip: winSkip("sleep and a hung socket file; batch14 checks the Windows process query") }, async () => {
  assert.ok(isServiceCommand("node /a/b/dist/src/cli.js serve"));
  assert.ok(isServiceCommand("/usr/bin/node /usr/local/bin/skillrouter serve"));
  assert.ok(!isServiceCommand("node /a/b/dist/src/cli.js serve --start"));
  assert.ok(!isServiceCommand("sleep 30"));
  assert.ok(!isServiceCommand("node /a/b/dist/src/cli.js hint claude"));
  assert.ok(!isServiceCommand("vim cli.js serve notes"));
  assert.equal(parseEtime("00:05"), 5); assert.equal(parseEtime("01:02:03"), 3723); assert.equal(parseEtime("2-03:04:05"), 183845); assert.ok(Number.isNaN(parseEtime("junk")));
  // A hung socket whose pid file names an unrelated process: that process lives, the socket is replaced.
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" }); bystander.unref(); procs.push(bystander);
  const hung = await fake(() => {});
  fs.writeFileSync(path.join(runDir(), "svc.pid"), String(bystander.pid));
  const starter = startService();
  assert.ok(await waitFor(async () => (await status(500)) !== null, 10000), "a real service replaced the hung socket");
  assert.equal(bystander.exitCode, null);
  assert.equal(bystander.signalCode, null);
  assert.doesNotThrow(() => process.kill(bystander.pid!, 0), "the unrelated process was not killed");
  bystander.kill("SIGKILL"); void starter; await closeFake(hung).catch(() => {}); await down();
});

svc("without Perl the Node client restarts a dead service by itself", { skip: winSkip("on Windows a service killed within a minute pauses restarts; batch14 covers it") }, async () => {
  const p = await up();
  p.kill("SIGKILL");
  assert.ok(await waitFor(() => p.exitCode !== null || p.signalCode !== null));
  assert.equal(await ping(socketPath(), 300), "dead", "stale socket left behind");
  const r = spawnSync(process.execPath, [cli, "hint", "claude"], { input: promptBody("nh-1"), env: process.env, encoding: "utf8" });
  assert.match(r.stdout, /python-testing/, "the hook still answered");
  assert.ok(await waitFor(aliveNow, 10000), "and a new service is coming up for the next one");
  await down();
});

svc("an unwritable state dir makes starting quietly give up, never a stack trace", { skip: (process.getuid?.() === 0 && "running as root") || winSkip("file modes") }, () => {
  const ro = path.join(home, "ro-home"); fs.mkdirSync(path.join(ro, ".skillrouter"), { recursive: true }); fs.chmodSync(path.join(ro, ".skillrouter"), 0o555);
  const env = { ...process.env, HOME: ro, SKILLROUTER_HOME: path.join(ro, ".skillrouter") };
  const start = spawnSync(process.execPath, [cli, "serve", "--start"], { env, encoding: "utf8" });
  assert.equal(start.status, 0);
  assert.equal(start.stderr, "", "no stack trace");
  const svc = spawnSync(process.execPath, [cli, "service", "start"], { env, encoding: "utf8" });
  assert.match(svc.stdout, /not writable/);
  assert.equal(svc.status, 1);
  fs.chmodSync(path.join(ro, ".skillrouter"), 0o755);
});

svc("a client that already left gets no work done for it", { skip: winSkip("SIGSTOP") }, async () => {
  const p = await up();
  process.kill(p.pid!, "SIGSTOP"); // the service can't read while the clients come and go
  for (let i = 0; i < 4; i++) {
    const body = promptBody(`ab-${i}`);
    await new Promise<void>((resolve) => { const c = net.connect(socketPath()); c.on("error", () => {}); c.on("connect", () => { c.write(`SR1 claude - ${Buffer.byteLength(body)}\n${body}`); setTimeout(() => { c.destroy(); resolve(); }, 20); }); });
  }
  process.kill(p.pid!, "SIGCONT");
  await sleep(500);
  for (let i = 0; i < 4; i++) assert.ok(!fs.existsSync(path.join(SR, "state", sessionHash(`ab-${i}`)!, "shown.jsonl")), `request ${i}: no prompt check ran for a client that was gone`);
  assert.match((await query("claude", "-", promptBody("ab-next"), 3000))!, /python-testing/, "and the next client is served normally");
}); 

svc("installing stops a running service so the next hook starts the new code", async () => {
  await up();
  const out = spawnSync(process.execPath, [cli, "install", "claude"], { env: process.env, encoding: "utf8" }).stdout;
  assert.match(out, /Stopped the running warm service/);
  assert.ok(await waitFor(async () => (await ping(socketPath(), 200)) === "dead", 4000));
});

// Whatever a launcher or the Node client started in the background goes away after the tests that use them (svc()),
// and at exit (below). File-level after/afterEach hooks would also fire while a name-filtered test is still running.

// ---- second QA review --------------------------------------------------------------------------------------------
const hasPerl2 = !WIN && spawnSync("perl", ["-e", "1"]).status === 0;

svc("a service that stopped reading can't hang a hook, whatever the body size", { skip: !hasPerl2 && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  const srv = await fake(() => { /* accepts, never reads or answers */ });
  for (const kb of [20, 100, 400, 900]) {
    const t0 = Date.now();
    const r = sh(["claude", "tool"], { input: JSON.stringify({ session_id: "nr-" + kb, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "x".repeat(kb * 1024) }) });
    assert.equal(r.status, 0, `${kb} KB: exit ${r.status}`);
    assert.ok(Date.now() - t0 < 3000, `${kb} KB took ${Date.now() - t0} ms against a service that stopped reading`);
  }
  await closeFake(srv);
});

svc("breaking a stale lock is mutually exclusive, however many starters race", async () => {
  const racer = `import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/service.js", import.meta.url))).href)}).then((m) => { const wait = Number(process.argv[1]) - Date.now(); setTimeout(() => { console.log(m.takeLock() ? "HELD" : "NO"); setTimeout(() => process.exit(0), 600); }, Math.max(0, wait)); });`;
  for (let round = 0; round < 12; round++) {
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
    const lock = path.join(runDir(), "svc.lock");
    fs.rmSync(lock, { recursive: true, force: true }); fs.rmSync(lock + ".break", { recursive: true, force: true });
    fs.mkdirSync(lock);
    if (round % 3 === 0) { fs.writeFileSync(path.join(lock, "pid"), "999999"); } // a dead owner
    const old = new Date(Date.now() - (round % 3 === 1 ? 60_000 : 5_000)); fs.utimesSync(lock, old, old);  // too old / owner dead after 1 s
    if (round % 3 === 2) fs.writeFileSync(path.join(lock, "pid"), "999999");
    const start = Date.now() + 500;
    const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ["-e", racer, String(start)], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
      let out = ""; c.stdout!.on("data", (d) => (out += d)); c.on("close", () => resolve(out.trim()));
    })));
    assert.ok(outs.filter((o) => o === "HELD").length <= 1, `round ${round}: ${outs.filter((o) => o === "HELD").length} starters hold the lock`);
  }
  fs.rmSync(path.join(runDir(), "svc.lock"), { recursive: true, force: true });
});

svc("a request the service had to abandon gives its trigger back, so the hook run again still shows it", async () => {
  await up({ SKILLROUTER_SERVICE_FAULT: "slow-tool" });
  const ev = JSON.stringify({ session_id: "ab-claim", prompt_id: "p1", cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/tests/test_api.py" } });
  assert.equal(await query("claude", "tool", ev, 3000), null, "the service answered FALLBACK: its worker overran the deadline");
  const first = await toolEvent("claude", ev, false) as { spawn: string };
  assert.equal(typeof first, "object", "the rule is claimable again");
  assert.match((await toolEvent("claude", first.spawn, true)) as string, /you worked on tests/, "and the hook run again shows its hint");
});

svc("a replaced service's files survive the old one exiting", { skip: winSkip("deletes the socket file and uses SIGTERM") }, async () => {
  const a = await up();
  for (const f of ["svc.sock", "svc.pid", "svc.json"]) fs.rmSync(path.join(runDir(), f), { force: true });
  try { fs.unlinkSync(socketPath()); } catch { /* may live elsewhere */ }
  const b = startService();
  assert.ok(await waitFor(async () => (await status(500)) !== null, 8000), "a second service came up while the first still ran");
  assert.notEqual(pidOf(), a.pid);
  a.kill("SIGTERM");
  assert.ok(await waitFor(() => a.exitCode !== null || a.signalCode !== null));
  await sleep(300);
  assert.ok(fs.existsSync(socketPath()), "the second service's socket is still there");
  assert.equal(pidOf(), b.pid, "and so is its pid file");
  assert.equal((await status())!.pid, b.pid);
});

svc("a client that reads its reply and never closes can't hold a slot or block idle exit", async () => {
  const p = await up({ SKILLROUTER_SERVICE_IDLE_MIN: "0.05" });
  const lingerer = net.connect(socketPath()); lingerer.on("error", () => {});
  const body = promptBody("li-1");
  lingerer.on("connect", () => lingerer.write(`SR1 claude - ${Buffer.byteLength(body)}\n${body}`));
  lingerer.on("data", () => {}); // reads the reply; never closes
  assert.ok(await waitFor(() => p.exitCode !== null, 9000), "the service still exits when idle");
  lingerer.destroy();
});

svc("only a known mode is ever sent to the service; declines don't count as failures", async () => {
  const { ask } = await import("../src/service-client.js");
  assert.equal((await ask("claude", "status", "{}")).kind, "declined");
  assert.equal((await ask("claude", "shutdown", "{}")).kind, "declined");
  assert.equal((await ask("claude", "tool", "x".repeat(1_200_000))).kind, "declined");
  assert.equal((await ask("claude", "-", "x".repeat(300_000))).kind, "declined");
  assert.equal((await ask("claude", "-", "{}", 500, "/nonexistent/svc.sock")).kind, "failed", "nothing there: a failure, worth starting a service for");
  await up();
  assert.equal((await ask("claude", "-", "{}")).kind, "ok");
});

svc("the launcher's exit codes: Node's become 0 or 1, and a service request in a status mode never reaches the service", { skip: !hasPerl2 && "needs sh and perl" }, async () => {
  const fakeNode = path.join(home, "fake-node.sh");
  for (const [code, want] of [[0, 0], [1, 1], [3, 1], [255, 1]] as const) {
    fs.writeFileSync(fakeNode, `#!/bin/sh\ncat >/dev/null\necho out\nexit ${code}\n`, { mode: 0o755 });
    writeLauncher(fakeNode, cli, launcherPath);
    const r = sh(["claude"], { input: promptBody("ec-" + code), env: { SKILLROUTER_SERVICE: "1" } });
    assert.equal(r.status, want, `node exit ${code}`);
    assert.equal(r.stdout, "out\n");
  }
  writeLauncher(process.execPath, cli, launcherPath);
  await up();
  const before = (await status())!.requests;
  const r = sh(["claude", "status"], { input: promptBody("ec-status") });
  assert.doesNotMatch(r.stdout, /"pid"/, "the service's status JSON is not a hook answer");
  assert.equal((await status())!.requests, before, "unknown modes are run by the hook itself");
});

svc("a hook run under another HOME (no SKILLROUTER_HOME) is not answered from this service's state", { skip: !hasPerl2 && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  await up();
  const before = (await status())!.requests;
  const env = { ...process.env, HOME: path.join(home, "elsewhere") } as Record<string, string | undefined>;
  delete env.SKILLROUTER_HOME;
  const r = spawnSync("sh", [launcherPath, "claude"], { input: promptBody("hm-1"), env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal((await status())!.requests, before);
});

// ---- third QA review ---------------------------------------------------------------------------------------------
const { firstUse } = await import("../src/state.js");
const countLines = (f: string) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
const usageRows = (pred: (r: any) => boolean) => countLines(path.join(SR, "usage.jsonl")) === 0 ? [] : fs.readFileSync(path.join(SR, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter(pred);

svc("a worker the service gave up on writes nothing, and the call is counted once", async () => {
  await up({ SKILLROUTER_SERVICE_FAULT: "slow-tool" });
  const ev = JSON.stringify({ session_id: "gw-1", prompt_id: "p1", cwd: "/repo", tool_use_id: "tu-gw1", tool_name: "Bash", tool_input: { command: "docker build ." } });
  assert.equal(await query("claude", "tool", ev, 3000), null, "its worker overran the deadline: FALLBACK");
  const first = await toolEvent("claude", ev, false) as { spawn: string };            // the hook run again by the client
  assert.equal(typeof first, "object", "the rule is claimable again");
  assert.match((await toolEvent("claude", first.spawn, true)) as string, /Docker/, "and its hint is shown");
  await sleep(1500);                                                                    // the ghost worker finishes meanwhile
  const dir = path.join(SR, "state", sessionHash("gw-1")!);
  assert.equal(countLines(path.join(dir, "tools.jsonl")), 1, "the Bash call was counted once, not by both runs");
  assert.equal(countLines(path.join(dir, "shown.jsonl")), 1, "one shown row: the ghost wrote none");
  assert.equal(usageRows((r) => r.tool === "trigger" && r.session === sessionHash("gw-1")).length, 1, "one trigger row");
});

svc("shutting down gives back the rules of requests still in flight", async () => {
  const p = await up({ SKILLROUTER_SERVICE_FAULT: "slow-tool" });
  const ev = JSON.stringify({ session_id: "gw-2", prompt_id: "p1", cwd: "/repo", tool_use_id: "tu-gw2", tool_name: "Bash", tool_input: { command: "docker build ." } });
  const pending = query("claude", "tool", ev, 3000);
  await sleep(250);
  if (WIN) void stopService(); else p.kill("SIGTERM"); // Windows ends a process outright, so only the request can ask for a clean exit
  assert.equal(await pending, null);
  assert.ok(await waitFor(() => p.exitCode !== null || p.signalCode !== null));
  const first = await toolEvent("claude", ev, false) as { spawn: string };
  assert.equal(typeof first, "object", "the trigger was not lost with the service");
});

svc("`service stop` finds a service whose socket file is gone", { skip: winSkip("deletes the socket file") }, async () => {
  const p = await up();
  fs.unlinkSync(socketPath());
  assert.equal(await ping(socketPath(), 200), "dead");
  assert.equal(await stopService(), true, "stopped by its pid file");
  assert.ok(await waitFor(() => p.exitCode !== null || p.signalCode !== null, 4000), "the process is really gone");
});

svc("a lock or failure marker stamped in the future doesn't block starting", async () => {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const future = new Date(Date.now() + 3600_000);
  const lock = path.join(runDir(), "svc.lock");
  fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "pid"), "999999"); fs.utimesSync(lock, future, future);
  assert.equal(takeLock(), true, "a lock from the future is stale");
  fs.rmSync(lock, { recursive: true, force: true });
  fs.writeFileSync(path.join(runDir(), "svc.off"), "x"); fs.utimesSync(path.join(runDir(), "svc.off"), future, future);
  spawnSync(process.execPath, [cli, "serve", "--start"], { env: process.env });
  assert.ok(await waitFor(aliveNow, 10000), "serve --start went ahead despite a future-dated failure marker");
  fs.rmSync(path.join(runDir(), "svc.off"), { force: true });
});

svc("the launcher serves the search gate through the service, and a search through the same service opens it", { skip: !hasPerl2 && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  await up();
  const sid = "gate-svc-1";
  assert.match((await query("claude", "-", promptBody(sid)))!, /python-testing/);
  const work = JSON.stringify({ session_id: sid, prompt_id: "p1", tool_name: "Bash", tool_input: { command: "pytest -q" } });
  const before = (await status())!.byMode.gate?.count ?? 0;
  const denied = sh(["claude", "gate"], { input: work });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await status())!.byMode.gate?.count, before + 1, "the gate request went through the service");
  assert.equal(sh(["claude", "gate"], { input: JSON.stringify({ session_id: sid, prompt_id: "p1", tool_name: "mcp__skillrouter__search_skills", tool_input: { query: "pytest" } }) }).stdout, "", "the search itself is let through");
  assert.equal(sh(["claude", "gate"], { input: work }).stdout, "", "after a search the same call goes through");
  // The kill switch is the hook's own environment: the running service never sees it, and the launcher must still honour it.
  const sid2 = "gate-svc-2";
  await query("claude", "-", promptBody(sid2));
  const work2 = JSON.stringify({ session_id: sid2, prompt_id: "p1", tool_name: "Bash", tool_input: { command: "pytest -q" } });
  const countBefore = (await status())!.byMode.gate?.count ?? 0;
  assert.equal(sh(["claude", "gate"], { input: work2, env: { SKILLROUTER_GATE: "0" } }).stdout, "", "SKILLROUTER_GATE=0 reaches past the service");
  assert.equal((await status())!.byMode.gate?.count ?? 0, countBefore, "and the service was not even asked");
  assert.match(sh(["claude", "gate"], { input: work2 }).stdout, /deny/, "without it the same call is refused");
  await down();
});

svc("OpenCode's hook gives up on a hung service sooner than the others", { skip: !hasPerl2 && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  const time = (agent: string) => { const t0 = Date.now(); const r = sh([agent], { input: promptBody("oc-" + agent), env: { SKILLROUTER_SERVICE_TRIED: "" } }); return { ms: Date.now() - t0, ok: /python-testing|^$/.test(r.stdout) }; };
  // Wall-clock timing on a shared CI machine: the shorter budget has to show up in one of three tries, not in all of them.
  // Each try starts from a fresh hung fake: the first launcher that finds it hung starts a real service in its place,
  // and against a live service both hooks answer in 30 ms, so a retry on the same fake could never pass.
  let ok = false, seen = "";
  for (let i = 0; i < 3 && !ok; i++) {
    const srv = await fake(() => { /* never answers */ });
    const oc = time("opencode");
    await sleep(300); fs.rmSync(path.join(runDir(), "svc.starting"), { recursive: true, force: true });
    const cl = time("claude");
    await sleep(300); fs.rmSync(path.join(runDir(), "svc.starting"), { recursive: true, force: true });
    ok = oc.ms < cl.ms - 200 && oc.ms < 1500;
    seen += `[opencode ${oc.ms} ms vs claude ${cl.ms} ms] `;
    await closeFake(srv); // also stops the real service a launcher started meanwhile
  }
  assert.ok(ok, seen);
});

svc("a cold burst of hooks starts one service, and tool calls are counted once", { skip: !hasPerl2 && "needs sh and perl" }, async () => {
  writeLauncher(process.execPath, cli, launcherPath);
  assert.equal(await ping(socketPath(), 200), "dead");
  fs.rmSync(path.join(runDir(), "svc.starting"), { recursive: true, force: true });
  const startedBefore = usageRows((r) => r.tool === "service" && r.reason === "started").length;
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise<string>((resolve) => {
    const c = spawn("sh", [launcherPath, "claude"], { stdio: ["pipe", "pipe", "ignore"], env: process.env }); let out = "";
    c.stdout!.on("data", (d) => (out += d)); c.on("close", () => resolve(out)); c.stdin!.end(promptBody("cb-" + i));
  })));
  assert.ok(outs.every((o) => /python-testing/.test(o)), "every hook still answered");
  assert.ok(await waitFor(aliveNow, 10000), "and a service came up");
  await sleep(500);
  assert.equal(usageRows((r) => r.tool === "service" && r.reason === "started").length - startedBefore, 1, "exactly one service was started by the burst");
});

svc("a tool call id is counted once however many times the hook runs", () => {
  const S = sessionHash("fu-1");
  assert.equal(firstUse(S, "call-1"), true);
  assert.equal(firstUse(S, "call-1"), false);
  assert.equal(firstUse(S, "call-2"), true);
  assert.equal(firstUse(S, undefined), true, "hosts that send no id always count");
  assert.equal(firstUse(undefined, "call-1"), true);
});
