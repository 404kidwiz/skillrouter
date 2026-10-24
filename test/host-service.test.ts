import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sr-host-service-"));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.SKILLROUTER_HOME = path.join(scratch, ".skillrouter");
const { antigravityConfigPaths } = await import("../src/paths.js");
const { install, NODE } = await import("../src/install.js");
const { mcpSpec } = await import("../src/live.js");
const { mcpOnlyConfiguration } = await import("../src/health.js");
const { ping, ensureKey, pipeName, serverProof } = await import("../src/service-client.js");
const nativePlatform = process.platform;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const home = () => fs.mkdtempSync(path.join(scratch, "home-"));
function write(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("fresh Antigravity install and both doctors use its current config path", () => {
  const h = home();
  const paths = antigravityConfigPaths(h);
  assert.equal(paths.current, path.join(h, ".gemini", "config", "mcp_config.json"));
  assert.equal(mcpSpec("antigravity", h), null);
  assert.equal(mcpOnlyConfiguration("antigravity", h), "missing");
  install("antigravity", h);
  const entry = read(paths.current).mcpServers.skillrouter;
  assert.equal(entry.command, NODE);
  assert.equal(entry.env.SKILLROUTER_AGENT, "antigravity");
  assert.deepEqual(mcpSpec("antigravity", h)?.args, entry.args);
  assert.equal(mcpOnlyConfiguration("antigravity", h), "configured (connection unverified)");
  assert.ok(paths.legacy.every((file) => !fs.existsSync(file)), "fresh installs never create obsolete files");
});

test("Antigravity keeps current settings authoritative and preserves unrelated configuration", () => {
  const h = home();
  const paths = antigravityConfigPaths(h);
  const other = { command: "other-server", env: { PRIVATE_VALUE: "synthetic-test-value" } };
  write(paths.current, { theme: "dark", mcpServers: { other, skillrouter: { command: "stale-node", args: ["stale-cli"], env: { CURRENT: "yes" }, enabled: false, timeout: 42 } } });
  write(paths.legacy[0], { mcpServers: { skillrouter: { command: "legacy-node", env: { LEGACY: "no" } } } });
  assert.equal(mcpSpec("antigravity", h)?.command, "stale-node");
  assert.equal(mcpOnlyConfiguration("antigravity", h), "disabled");
  install("antigravity", h);
  const current = read(paths.current);
  assert.equal(current.theme, "dark");
  assert.deepEqual(current.mcpServers.other, other);
  assert.equal(current.mcpServers.skillrouter.command, NODE);
  assert.deepEqual(current.mcpServers.skillrouter.env, { CURRENT: "yes", SKILLROUTER_AGENT: "antigravity" });
  assert.equal(current.mcpServers.skillrouter.enabled, false);
  assert.equal(current.mcpServers.skillrouter.timeout, 42);
  assert.equal(mcpSpec("antigravity", h)?.disabled, true);
});

test("Antigravity migrates only its router entry from either former path and leaves legacy bytes intact", () => {
  for (let i = 0; i < 2; i++) {
    const h = home();
    const paths = antigravityConfigPaths(h);
    write(paths.current, { preferences: { keep: true }, mcpServers: { currentOther: { command: "keep-current" } } });
    write(paths.legacy[i], { legacyOnly: true, mcpServers: { credentialServer: { command: "do-not-copy", env: { TOKEN: "synthetic" } }, skillrouter: { command: "old-node", args: ["old-cli"], env: { CUSTOM: "keep" }, disabled: true } } });
    const original = fs.readFileSync(paths.legacy[i], "utf8");
    assert.equal(mcpSpec("antigravity", h), null, "doctor never launches from obsolete configuration");
    assert.equal(mcpOnlyConfiguration("antigravity", h), "missing");
    assert.match(install("antigravity", h).join("\n"), /migrated router settings/);
    const current = read(paths.current);
    assert.deepEqual(current.preferences, { keep: true });
    assert.deepEqual(Object.keys(current.mcpServers).sort(), ["currentOther", "skillrouter"]);
    assert.equal(current.mcpServers.skillrouter.command, NODE);
    assert.notDeepEqual(current.mcpServers.skillrouter.args, ["old-cli"]);
    assert.deepEqual(current.mcpServers.skillrouter.env, { CUSTOM: "keep", SKILLROUTER_AGENT: "antigravity" });
    assert.equal(current.mcpServers.skillrouter.disabled, true);
    assert.equal(fs.readFileSync(paths.legacy[i], "utf8"), original);
  }
});

test("Antigravity doctor reports a damaged current config instead of falling back to legacy", () => {
  const h = home();
  const paths = antigravityConfigPaths(h);
  write(paths.legacy[0], { mcpServers: { skillrouter: { command: "legacy-node" } } });
  write(paths.current, {});
  fs.writeFileSync(paths.current, "{broken");
  assert.equal(mcpSpec("antigravity", h), null);
  assert.equal(mcpOnlyConfiguration("antigravity", h), "invalid config");
  assert.throws(() => install("antigravity", h));
  assert.equal(fs.readFileSync(paths.current, "utf8"), "{broken");
});

test("Antigravity legacy-only install creates the current folder without copying other legacy servers", () => {
  const h = home();
  const paths = antigravityConfigPaths(h);
  write(paths.legacy[0], { mcpServers: { other: { command: "leave-here" }, skillrouter: { command: "old-node", env: { CUSTOM: "yes" } } } });
  install("antigravity", h);
  assert.deepEqual(Object.keys(read(paths.current).mcpServers), ["skillrouter"]);
  assert.equal(mcpSpec("antigravity", h)?.env.CUSTOM, "yes");
  assert.equal(mcpOnlyConfiguration("antigravity", h), "configured (connection unverified)");
});

type FakeSocket = EventEmitter & { destroyed: boolean; write: (data: string) => boolean; destroy: () => void };
/** Inject transport chunks, while running the actual platform-selected nonce and framing logic. */
async function fakePing(platform: NodeJS.Platform, reply: (socket: FakeSocket, request: string) => void, timeout = 80) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const marker = path.join(scratch, "socket-marker");
  fs.writeFileSync(marker, "");
  const key = ensureKey();
  const socket = new EventEmitter() as FakeSocket;
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = (request) => { queueMicrotask(() => reply(socket, request)); return true; };
  const connect = mock.method(net, "connect", () => { queueMicrotask(() => socket.emit("connect")); return socket; });
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try { return await ping(platform === "win32" ? pipeName(key) : marker, timeout); }
  finally { Object.defineProperty(process, "platform", descriptor); connect.mock.restore(); }
}
function proof(request: string): string {
  const nonce = /^SR1 - hello ([0-9a-f]{32})\n$/.exec(request)?.[1];
  assert.ok(nonce, "Windows sends a nonce before trusting the peer");
  return `HELLO ${serverProof(ensureKey(), nonce)}\n`;
}
function chunks(socket: FakeSocket, parts: string[]) {
  for (const part of parts) socket.emit("data", Buffer.from(part));
}

test("Windows ping accepts authenticated headers at every possible two-chunk split", async () => {
  for (let split = 1; split < 71; split++) {
    assert.equal(await fakePing("win32", (s, request) => {
      const line = proof(request);
      assert.equal(line.length, 71);
      chunks(s, [line.slice(0, split), line.slice(split)]);
    }), "alive", `split ${split}`);
  }
  assert.equal(await fakePing("win32", (s, request) => chunks(s, [...proof(request)])), "alive", "single-byte chunks");
});

test("POSIX ping buffers status headers and excludes the body from the header bound", async () => {
  const line = "OK 1000\n";
  for (let split = 1; split < line.length; split++) {
    assert.equal(await fakePing("linux", (s, request) => {
      assert.equal(request, "SR1 - status 0\n");
      chunks(s, [line.slice(0, split), line.slice(split) + "x".repeat(1000)]);
    }), "alive", `split ${split}`);
  }
});

test("ping rejects invalid, oversized and disconnected replies and bounds incomplete replies by deadline", async () => {
  for (const platform of ["linux", "win32"] as const) {
    for (const bad of ["BAD\n", "HELLO " + "0".repeat(64) + "\n", "x".repeat(129), "x".repeat(129) + "\n", "OK 9999999999\n"]) {
      assert.equal(await fakePing(platform, (s) => chunks(s, [bad.slice(0, 2), bad.slice(2)])), "dead", `${platform} invalid frame`);
    }
    assert.equal(await fakePing(platform, (s) => { chunks(s, ["O"]); s.emit("end"); }), "dead");
    assert.equal(await fakePing(platform, (s) => { chunks(s, ["O"]); s.emit("close"); }), "dead");
    assert.equal(await fakePing(platform, (s) => s.emit("error", new Error("disconnect"))), "dead");
    assert.equal(await fakePing(platform, (s) => chunks(s, ["O"]), 10), "hung");
  }
});

test("real Windows named pipe ping accepts a fragmented authentication reply", { skip: nativePlatform !== "win32" && "requires Windows named pipes" }, async () => {
  const key = ensureKey();
  const endpoint = pipeName(key);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (data) => {
      request += data.toString("utf8");
      if (!request.includes("\n")) return;
      const reply = proof(request);
      socket.write(reply.slice(0, 20));
      setTimeout(() => { if (!socket.destroyed) socket.write(reply.slice(20, 65)); }, 15);
      setTimeout(() => { if (!socket.destroyed) socket.write(reply.slice(65)); }, 30);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  try { assert.equal(await ping(endpoint, 1000), "alive"); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
