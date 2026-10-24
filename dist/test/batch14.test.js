// Windows stage 2: the warm service over a named pipe. The pure parts (pipe names, the secret key, process-query parsing)
// run everywhere; what needs a real pipe or a real Windows process runs only on Windows, and what is transport-agnostic
// (the hook through the Windows launcher, the process check) runs on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-b14-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows reads this, not HOME, for os.homedir()
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
delete process.env.SKILLROUTER_SERVICE; // the test script turns it off for the other files; this file tests it
process.env.SKILLROUTER_SERVICE_IDLE_MIN = "1"; // a service started indirectly never outlives the run by long
const SR = process.env.SKILLROUTER_HOME;
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const WIN = process.platform === "win32";
const winOnly = !WIN && "needs a Windows named pipe";
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const client = await import("../src/service-client.js");
const { ensureKey, readKey, keyReplaced, pipeName, serverProof, stateDirPrivate, socketPath, ownedByMe, ping, ask, query, status, runDir } = client;
const { isServiceCommand, windowsProcessQuery, parseWindowsProcess, processInfo, stopService } = await import("../src/service.js");
const { windowsLauncher, powershellPath } = await import("../src/platform.js");
const procs = [];
process.on("exit", () => {
    for (const p of procs)
        try {
            p.kill("SIGKILL");
        }
        catch { /* gone */ }
    try {
        process.kill(Number(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8")), "SIGKILL");
    }
    catch { /* none */ }
});
const skill = (id, words) => ({ id, name: id, description: `A skill about ${words} with enough description to pass the gate`, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/-/g, " ")} ${words} `.repeat(3)) });
const filler = Array.from({ length: 40 }, (_, i) => skill(`filler-${i}`, `sourdough kiln glaze proofing number ${i} hobby baking pottery`));
saveIndex({ builtAt: "b14", roots: [], tokenizer: 2, skills: [skill("python-testing", "python testing pytest tests fixtures mocking writing fixing"), skill("docker-patterns", "docker dockerfile compose containers multi stage builds"), ...filler] });
fs.writeFileSync(path.join(SR, "core.txt"), "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Listen on the service's pipe once the previous test's service has really gone (a pipe's name outlives its process by a moment). */
async function listenWhenFree(server) {
    for (let i = 0;; i++) {
        try {
            await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath(), () => { server.off("error", reject); resolve(); }); });
            return;
        }
        catch (e) {
            if (e.code !== "EADDRINUSE" || i >= 40)
                throw e;
            await sleep(100);
        }
    }
}
async function waitFor(f, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) {
    if (await f())
        return true;
    await sleep(50);
} return false; }
const startService = (env = {}) => { const p = spawn(process.execPath, [cli, "serve"], { env: { ...process.env, ...env }, stdio: "ignore", windowsHide: true }); p.unref(); procs.push(p); return p; };
const aliveNow = async () => (await ping(socketPath(), 400)) === "alive";
const gone = (p) => p.exitCode !== null || p.signalCode !== null;
const promptBody = (session) => JSON.stringify({ session_id: session, prompt_id: "p1", prompt: "write pytest tests for the api client and fix the failing python fixtures" });
const usage = () => { try {
    return fs.readFileSync(path.join(SR, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
catch {
    return [];
} };
/** `test`, then make sure no service is left running. */
function svc(name, a, b) {
    const opts = typeof a === "function" ? {} : a;
    const fn = typeof a === "function" ? a : b;
    return test(name, opts, async (ctx) => { try {
        await fn(ctx);
    }
    finally {
        await stopService().catch(() => { });
        await waitFor(async () => (await ping(socketPath(), 200)) === "dead", 4000);
    } });
}
test("the pipe is named from a secret key kept in the run folder; with no key there is nothing to talk to", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-key-"));
    const at = (d) => socketPath(d, "win32", os.tmpdir()); // (this folder is under "the profile" for the check)
    assert.equal(at(dir), "", "no key yet: no endpoint, so a hook never connects to a name anyone could have taken");
    const key = ensureKey(dir);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(ensureKey(dir), key, "stable once made");
    assert.equal(readKey(dir), key);
    assert.match(at(dir), /^\\\\\.\\pipe\\skillrouter-[0-9a-f]{32}$/);
    assert.equal(at(dir), pipeName(key));
    assert.ok(!at(dir).includes(key.slice(0, 32)) && !at(dir).includes(key.slice(32)), "the name is a one-way function of the key: listing pipes reveals nothing");
    assert.notEqual(pipeName(key), pipeName(ensureKey(fs.mkdtempSync(path.join(os.tmpdir(), "sr-key2-")))), "each state folder has its own pipe");
    fs.writeFileSync(path.join(dir, "run", "svc.key"), "not a key");
    assert.equal(readKey(dir), null, "a damaged file is no key");
    assert.equal(at(dir), "");
    assert.notEqual(ensureKey(dir), key, "and is replaced");
});
test("a key that cannot be read right now is not replaced, and is not a reason for a service to stop", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-key-busy-"));
    const key = ensureKey(dir);
    assert.equal(keyReplaced(key, dir), false, "same key");
    fs.writeFileSync(path.join(dir, "run", "svc.key"), "f".repeat(64));
    assert.equal(keyReplaced(key, dir), true, "another key");
    fs.writeFileSync(path.join(dir, "run", "svc.key"), "half-writt");
    assert.equal(keyReplaced(key, dir), false, "a partial write is not a verdict");
    fs.rmSync(path.join(dir, "run", "svc.key"));
    assert.equal(keyReplaced(key, dir), true, "a deleted file is");
    fs.mkdirSync(path.join(dir, "run", "svc.key")); // reading it fails with something other than "not found", as an antivirus lock does
    assert.equal(keyReplaced(key, dir), false, "unreadable now: keep serving");
    assert.throws(() => ensureKey(dir), /EISDIR|EPERM|EACCES/, "and a starting service refuses to make a second key over it");
});
test("the service proves itself with an HMAC of the client's nonce, under a key the client also holds", () => {
    const key = "ab".repeat(32);
    const proof = serverProof(key, "00".repeat(16));
    assert.match(proof, /^[0-9a-f]{64}$/);
    assert.equal(serverProof(key, "00".repeat(16)), proof, "deterministic");
    assert.notEqual(serverProof(key, "01".repeat(16)), proof, "a fresh nonce gives a fresh answer: a recording is no use");
    assert.notEqual(serverProof("cd".repeat(32), "00".repeat(16)), proof, "another key cannot produce it");
});
test("the service only runs from a state folder inside the user's profile on Windows", () => {
    const home = "C:\\Users\\Jane Doe";
    assert.equal(stateDirPrivate("C:\\Users\\Jane Doe\\.skillrouter", "win32", home), true);
    assert.equal(stateDirPrivate("c:\\users\\jane doe\\AppData\\x", "win32", home), true, "paths are not case sensitive there");
    assert.equal(stateDirPrivate(home, "win32", home), true);
    for (const out of ["C:\\sr", "D:\\Users\\Jane Doe\\.skillrouter", "C:\\Users\\Jane Doe2\\.skillrouter", "C:\\Users", "\\\\server\\share\\sr"])
        assert.equal(stateDirPrivate(out, "win32", home), false, out);
    assert.equal(stateDirPrivate("/anywhere", "linux", "/home/u"), true, "modes protect it elsewhere");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-priv-"));
    ensureKey(dir);
    assert.equal(socketPath(dir, "win32", path.join(os.tmpdir(), "elsewhere")), "", "a key outside the profile is not used");
});
test("Windows PowerShell is run by its full path, not looked up in whatever folder the hook is in", () => {
    assert.equal(powershellPath({ SystemRoot: "C:\\Windows" }, () => true), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(powershellPath({ windir: "D:\\WINNT" }, () => true), "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(powershellPath({ SystemRoot: "C:\\Windows" }, () => false), "powershell.exe");
    assert.equal(powershellPath({}, () => true), "powershell.exe");
});
test("only a pipe named like ours is ever talked to", async () => {
    const good = `\\\\.\\pipe\\skillrouter-${"a".repeat(32)}`;
    assert.equal(ownedByMe(good, "win32"), true);
    for (const bad of ["", "\\\\.\\pipe\\skillrouter-short", `\\\\.\\pipe\\other-${"a".repeat(32)}`, `\\\\server\\pipe\\skillrouter-${"a".repeat(32)}`, `/tmp/skillrouter-${"a".repeat(32)}.sock`, `${good}\\extra`])
        assert.equal(ownedByMe(bad, "win32"), false, bad);
    assert.equal(await ping("", 200), "dead", "an empty endpoint is nothing, not the current directory");
    assert.equal((await ask("claude", "-", "{}", 300, "")).kind, "failed");
});
test("service command lines are recognised on Windows too, and only the service", () => {
    for (const ok of ['"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\.skillrouter\\dist\\src\\cli.js serve', 'node.exe "C:\\Users\\Jane Doe\\sr\\dist\\src\\cli.js" serve', "node C:\\x\\skillrouter serve", "node /a/b/dist/src/cli.js serve"])
        assert.ok(isServiceCommand(ok), ok);
    for (const no of ["node.exe C:\\x\\cli.js serve --start", "node.exe C:\\x\\mycli.js serve", "node.exe C:\\x\\cli.js hint claude", "vim C:\\x\\cli.js serve notes", ""])
        assert.ok(!isServiceCommand(no), no);
});
test("the Windows process query takes only a real pid, and its answer parses", () => {
    assert.match(windowsProcessQuery(4242), /ProcessId=4242'/);
    assert.ok(!/Console/.test(windowsProcessQuery(4242)) && /ToUniversalTime/.test(windowsProcessQuery(4242)), "no .NET calls a locked-down PowerShell refuses; UTC on both sides");
    for (const bad of [0, -1, 1.5, NaN, Infinity, "1; calc"])
        assert.throws(() => windowsProcessQuery(bad), /bad pid/);
    assert.deepEqual(parseWindowsProcess('42|"C:\\node.exe" C:\\x\\cli.js serve\r\n'), { command: '"C:\\node.exe" C:\\x\\cli.js serve', elapsedSec: 42 });
    assert.deepEqual(parseWindowsProcess("7|"), { command: "", elapsedSec: 7 });
    for (const bad of ["", "|x", "abc|x", "no bar"])
        assert.equal(parseWindowsProcess(bad), null, bad);
});
svc("a process's command line and age are read on this OS, so only a real service can be killed", async () => {
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "bystander-marker"], { stdio: "ignore", windowsHide: true });
    bystander.unref();
    procs.push(bystander);
    const info = processInfo(bystander.pid);
    assert.ok(info, "found it");
    assert.match(info.command, /bystander-marker/);
    assert.ok(!isServiceCommand(info.command));
    assert.ok(info.elapsedSec >= 0 && info.elapsedSec < 120, String(info.elapsedSec));
    bystander.kill("SIGKILL");
    assert.ok(await waitFor(() => gone(bystander)));
    const service = startService();
    assert.ok(await waitFor(aliveNow), "a service came up");
    const real = processInfo(service.pid);
    assert.ok(real && isServiceCommand(real.command), `a running service reads as one: ${real?.command}`);
    assert.equal(processInfo(2 ** 22 - 3), null, "a pid nobody has");
});
svc("a hook through the Windows launcher is answered by the service once one is up", async () => {
    const launcher = path.join(home, "skillrouter-hint.mjs");
    fs.writeFileSync(launcher, windowsLauncher(cli));
    const hook = (session) => spawnSync(process.execPath, [launcher, "claude"], { input: promptBody(session), env: process.env, encoding: "utf8", windowsHide: true });
    const first = hook("wl-1");
    assert.match(first.stdout, /python-testing/, "with no service the hook answers by itself");
    assert.ok(await waitFor(aliveNow, 15000), "and the failed attempt started a service for the next hook");
    const before = (await status()).requests;
    assert.match(hook("wl-2").stdout, /python-testing/);
    assert.equal((await status()).requests, before + 1, "the next one went through the service");
});
svc("`service restart` brings the new service up straight away, with no pause recorded", async () => {
    startService();
    assert.ok(await waitFor(aliveNow));
    const oldPid = Number(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8"));
    for (let round = 0; round < 3; round++) {
        const r = spawnSync(process.execPath, [cli, "service", "restart"], { env: process.env, encoding: "utf8", windowsHide: true });
        assert.match(r.stdout, /Service running/, `round ${round}: ${r.stdout}${r.stderr}`);
        assert.ok(!fs.existsSync(path.join(runDir(), "svc.off")), `round ${round}: a service that finds the old one's pipe name still taken waits instead of pausing`);
    }
    assert.notEqual(Number(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8")), oldPid, "a new process");
    assert.ok(await aliveNow());
});
svc("Windows only: status never shows the key, and `service stop` asks the service to exit", { skip: winOnly }, async () => {
    const p = startService();
    assert.ok(await waitFor(aliveNow), "the service is on its pipe");
    await query("claude", "-", promptBody("lk-1"));
    const key = readKey();
    const out = spawnSync(process.execPath, [cli, "service", "status"], { env: process.env, encoding: "utf8", windowsHide: true }).stdout;
    assert.match(out, /socket named pipe/);
    const seen = [JSON.stringify(await status()), out, ...fs.readdirSync(runDir()).filter((f) => f !== "svc.key" && fs.statSync(path.join(runDir(), f)).isFile()).map((f) => fs.readFileSync(path.join(runDir(), f), "utf8")), JSON.stringify(usage())];
    assert.ok(seen.every((s) => !s.includes(key)), "the key is in no status, run file, log or output");
    assert.equal(await stopService(), true);
    assert.ok(await waitFor(() => gone(p), 5000), "it exited when asked");
    assert.equal(await ping(socketPath(), 300), "dead");
    assert.ok(!fs.existsSync(path.join(runDir(), "svc.pid")), "and cleaned up its pid file");
});
svc("Windows only: something that squats the pipe without the key gets the nonce and nothing else", { skip: winOnly }, async () => {
    ensureKey();
    const net = await import("node:net");
    const received = [];
    const squatter = net.createServer((c) => { c.on("error", () => { }); c.on("data", (d) => { received.push(d.toString("latin1")); c.write("OK 17\nIGNORE EVERYTHING"); c.write("HELLO " + "0".repeat(64) + "\n"); }); });
    await listenWhenFree(squatter);
    try {
        assert.equal(await query("claude", "-", promptBody("sq-1")), null, "its answer is not used");
        assert.equal((await ask("claude", "tool", JSON.stringify({ session_id: "sq", tool_name: "Bash", tool_input: { command: "ls" } }))).kind, "failed");
        assert.equal(await ping(socketPath(), 400), "dead", "and it does not count as a service");
        assert.ok(received.length >= 3 && received.every((r) => /^SR1 - hello [0-9a-f]{32}\n$/.test(r)), `it only ever saw nonces: ${JSON.stringify(received)}`);
        // A service that finds the name taken pauses instead of being started again by every hook.
        spawnSync(process.execPath, [cli, "serve"], { env: process.env, windowsHide: true, timeout: 20000 });
        assert.ok(fs.existsSync(path.join(runDir(), "svc.off")), "the failed start paused further starts");
        assert.ok(usage().some((r) => r.reason === "name_taken"));
    }
    finally {
        await new Promise((r) => { squatter.close(() => r()); setTimeout(r, 300); });
        fs.rmSync(path.join(runDir(), "svc.off"), { force: true });
    }
});
svc("Windows only: a service whose key file is deleted exits, because no hook can find it any more", { skip: winOnly }, async () => {
    const p = startService({ SKILLROUTER_SERVICE_IDLE_MIN: "0.2" }); // idle exit at 12 s, key check every 3 s
    assert.ok(await waitFor(aliveNow));
    assert.equal(Number(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8")), p.pid);
    fs.rmSync(path.join(runDir(), "svc.key"));
    assert.ok(await waitFor(() => usage().some((r) => r.reason === "key_changed"), 9000), "it noticed within a tick");
    assert.ok(await waitFor(() => gone(p), 4000), "and exited");
});
svc("Windows only: a service killed within a minute pauses restarts; asking for one by hand ignores the pause", { skip: winOnly }, async () => {
    const p = startService();
    assert.ok(await waitFor(aliveNow));
    p.kill("SIGKILL"); // Windows ends it outright: no cleanup runs, its pid file stays
    assert.ok(await waitFor(() => gone(p)));
    assert.equal(await ping(socketPath(), 300), "dead", "its pipe went with it");
    assert.equal(await query("claude", "-", promptBody("kl-1")), null, "callers fall back");
    spawnSync(process.execPath, [cli, "serve", "--start"], { env: process.env, windowsHide: true }); // what a hook that found no service does
    await sleep(1500);
    assert.equal(await ping(socketPath(), 300), "dead", "no service was started for it");
    assert.ok(fs.existsSync(path.join(runDir(), "svc.off")), "the pause is recorded");
    assert.ok(usage().some((r) => r.reason === "died_young"));
    const start = spawnSync(process.execPath, [cli, "service", "start"], { env: process.env, encoding: "utf8", windowsHide: true });
    assert.match(start.stdout, /Service running/, start.stdout + start.stderr);
    assert.match((await query("claude", "-", promptBody("kl-2"))), /python-testing/);
});
svc("Windows only: a stuck service whose pid file names someone else's process is never killed, and its pid file stays", { skip: winOnly }, async () => {
    ensureKey();
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "bystander-marker"], { stdio: "ignore", windowsHide: true });
    bystander.unref();
    procs.push(bystander);
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(path.join(runDir(), "svc.pid"), String(bystander.pid));
    const net = await import("node:net");
    const held = new Set();
    const stuck = net.createServer((c) => { held.add(c); c.on("error", () => { }); /* accepts, never answers */ });
    await listenWhenFree(stuck);
    try {
        assert.equal(await ping(socketPath(), 300), "hung");
        assert.equal(await stopService(), false, "nothing of ours was stopped");
        assert.equal(bystander.exitCode, null);
        assert.doesNotThrow(() => process.kill(bystander.pid, 0), "the unrelated process lives");
        assert.equal(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8"), String(bystander.pid), "and the pid file is all that can find a real one later");
    }
    finally {
        for (const c of held)
            c.destroy(); // a connection nobody reads would keep the pipe's name taken for the next test
        await new Promise((r) => { stuck.close(() => r()); setTimeout(r, 300); });
        bystander.kill("SIGKILL");
        fs.rmSync(path.join(runDir(), "svc.pid"), { force: true });
    }
});
svc("Windows only: a service wedged for real is found by its pid file, verified through the process query, killed and replaced", { skip: winOnly }, async () => {
    const wedged = startService({ SKILLROUTER_SERVICE_FAULT: "hang" });
    assert.ok(await waitFor(aliveNow));
    const oldPid = wedged.pid;
    const c = (await import("node:net")).connect(socketPath());
    c.on("error", () => { });
    c.on("connect", () => c.write("SR1 - hang 0\n"));
    await sleep(300);
    assert.equal(await ping(socketPath(), 300), "hung");
    spawnSync(process.execPath, [cli, "serve", "--start"], { env: { ...process.env, SKILLROUTER_SERVICE_FAULT: "" }, windowsHide: true });
    assert.ok(await waitFor(async () => (await aliveNow()) && Number(fs.readFileSync(path.join(runDir(), "svc.pid"), "utf8")) !== oldPid, 20000), "a new service took over");
    assert.ok(await waitFor(() => gone(wedged), 5000), "the wedged one was killed");
    c.destroy();
});
svc("Windows only: outside the user's profile the service stays off, and doctor says why", { skip: winOnly }, async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sr-outside-")); // the profile here is a folder inside the temp dir
    const env = { ...process.env, SKILLROUTER_HOME: path.join(outside, ".skillrouter") };
    const run = spawnSync(process.execPath, [cli, "serve"], { env, encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.equal(run.status, 0);
    assert.ok(!fs.existsSync(path.join(outside, ".skillrouter", "run", "svc.key")), "no key was made where others could read it");
    assert.match(spawnSync(process.execPath, [cli, "doctor"], { env, encoding: "utf8", windowsHide: true }).stdout, /Service: off on Windows: the state folder is outside your profile/);
    fs.rmSync(outside, { recursive: true, force: true });
});
