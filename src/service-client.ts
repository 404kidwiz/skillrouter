import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SR_DIR } from "./paths.js";

/**
 * The warm service's client side: everything a hook needs to ask it a question. Kept free of the router's own
 * modules (index, search, model) so importing it costs a few milliseconds, not the work the service exists to avoid.
 *
 * Protocol (one request per connection, an owner-only Unix socket, or a named pipe on Windows):
 *   request   SR1 <agent|-> <mode|-> <bytes>\n<body>        mode: - (prompt check) tool stop decision status shutdown
 *   response  OK <bytes>\n<output>   the hook's output ("" when it has none)   |   FALLBACK\n   run the hook yourself
 * The reply carries its length so a client stops reading when it has it: waiting for the server's close is not
 * reliable (macOS sometimes never delivers it to a Perl reader).
 */
export const PROTOCOL = "SR1";
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;

export const runDir = (dir = SR_DIR) => path.join(dir, "run");
/**
 * Windows has no Unix sockets, so the service listens on a named pipe. Two things make that safe:
 *
 * - Anyone can list pipe names, so a name proves nothing, and a local user could claim the pipe while no service is running
 *   (after an idle exit, a crash, a reboot) and have our hooks hand them prompts and print their answers into the agent's
 *   context. So the service proves who it is: before a client sends any request it sends a nonce, and the service answers
 *   with an HMAC of it under a key that only lives in run/svc.key. An impostor cannot, and gets nothing but the nonce.
 * - Who may connect at all is the pipe's default access list: the owner, SYSTEM and administrators can write to it, and
 *   everyone else can only read, which lets them hold connection slots but never send a request.
 *
 * The key is only private if its folder is, and Windows ignores file modes: inside the user's profile the folder's access
 * list keeps other users out, anywhere else (a SKILLROUTER_HOME on C:\) it may not, so there the service stays off.
 * The pipe's name is derived from the key (one way), so listing pipes reveals nothing about it.
 */
const KEY = /^[0-9a-f]{64}$/;
const PIPE = /^\\\\\.\\pipe\\skillrouter-[0-9a-f]{32}$/;
const keyFile = (dir: string) => path.join(runDir(dir), "svc.key");
const hmac = (key: string, msg: string) => createHmac("sha256", Buffer.from(key, "hex")).update(msg).digest("hex");
export const pipeName = (key: string) => `\\\\.\\pipe\\skillrouter-${hmac(key, "pipe").slice(0, 32)}`;
/** What the service answers to a client's nonce. */
export const serverProof = (key: string, nonce: string) => hmac(key, `server:${nonce}`);
export const HELLO = /^SR1 - hello ([0-9a-f]{32})$/;

/** Whether this state folder is one only this user can read. Only Windows needs to ask (see above); elsewhere modes do it. */
export function stateDirPrivate(dir = SR_DIR, platform: NodeJS.Platform = process.platform, home = os.homedir()): boolean {
  if (platform !== "win32") return true;
  const rel = path.win32.relative(home, dir);
  return rel === "" || (!rel.startsWith("..") && !path.win32.isAbsolute(rel));
}
export const serviceEnabled = () => process.env.SKILLROUTER_SERVICE !== "0" && stateDirPrivate();

export function readKey(dir = SR_DIR): string | null {
  try { const k = fs.readFileSync(keyFile(dir), "utf8").trim(); return KEY.test(k) ? k : null; } catch { return null; }
}
/**
 * The service calls this (while it holds the start lock): its key, made on first use. A key that cannot be read right
 * now (an antivirus scan has the file) throws instead of being replaced, since a new key would strand a running service.
 */
export function ensureKey(dir = SR_DIR): string {
  try { const k = fs.readFileSync(keyFile(dir), "utf8").trim(); if (KEY.test(k)) return k; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  fs.mkdirSync(runDir(dir), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  fs.writeFileSync(keyFile(dir), key, { mode: 0o600 });
  return key;
}
/** Whether the key file is gone or holds another key. A file that is merely unreadable at the moment is not a change. */
export function keyReplaced(expected: string, dir = SR_DIR): boolean {
  try { const k = fs.readFileSync(keyFile(dir), "utf8").trim(); return KEY.test(k) && k !== expected; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
}

/**
 * Where the service listens. On POSIX a Unix socket: its paths are limited to about 104 bytes, so a long state directory
 * (a temp folder, a deep home) gets a short per-user path under /tmp keyed by the directory; the owner is checked on use.
 * On Windows the named pipe, or "" while there is no key (no service has ever started here) or the folder is not private:
 * nothing safe to talk to.
 */
export function socketPath(dir = SR_DIR, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === "win32") { const k = stateDirPrivate(dir, platform, home) ? readKey(dir) : null; return k ? pipeName(k) : ""; }
  const p = path.join(runDir(dir), "svc.sock");
  if (Buffer.byteLength(p) <= 100) return p;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/tmp/skillrouter-${uid}-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}.sock`;
}

/**
 * Only talk to a socket this user owns: a path in a shared folder could be squatted by someone else. A pipe has no owner
 * to look up (and a stat would connect to it), so its secret name is the proof: it must be one we derived from the token.
 */
export function ownedByMe(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return PIPE.test(file);
  try { return typeof process.getuid !== "function" || fs.statSync(file).uid === process.getuid(); } catch { return false; }
}

export type Answer = { kind: "ok"; out: string } | { kind: "declined" } | { kind: "failed" };

/** `declined`: the service is there and said FALLBACK (or the request isn't one it serves); `failed`: it could not be reached or didn't answer. */
function exchange(header: string, body: string, timeoutMs: number, sock: string): Promise<Answer> {
  return new Promise((resolve) => {
    if (!ownedByMe(sock)) return resolve({ kind: "failed" });
    // On Windows nothing is sent until the server has proved it holds the key: the nonce goes first and is all an impostor sees.
    const key = process.platform === "win32" ? readKey() : null;
    if (process.platform === "win32" && !key) return resolve({ kind: "failed" });
    const nonce = randomBytes(16).toString("hex");
    let proven = !key;
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (v: Answer) => { if (done) return; done = true; clearTimeout(timer); c.destroy(); resolve(v); };
    const c = net.connect(sock);
    const timer = setTimeout(() => finish({ kind: "failed" }), timeoutMs);
    c.on("error", () => finish({ kind: "failed" }));
    c.on("connect", () => c.write(key ? `${PROTOCOL} - hello ${nonce}\n` : header + body));
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!proven) {
        const at = buf.indexOf(10);
        if (at < 0) { if (buf.length > 128) finish({ kind: "failed" }); return; }
        const m = /^HELLO ([0-9a-f]{64})$/.exec(buf.subarray(0, at).toString("latin1"));
        if (!m || !timingSafeEqual(Buffer.from(m[1]), Buffer.from(serverProof(key!, nonce)))) return finish({ kind: "failed" });
        proven = true;
        buf = buf.subarray(at + 1);
        c.write(header + body);
        if (!buf.length) return;
      }
      const nl = buf.indexOf(10);
      if (nl < 0) { if (buf.length > 64) finish({ kind: "failed" }); return; }
      const line = buf.subarray(0, nl).toString("latin1");
      if (line === "FALLBACK") return finish({ kind: "declined" });
      const m = /^OK (\d{1,9})$/.exec(line);
      if (!m) return finish({ kind: "failed" });
      const len = Number(m[1]);
      if (buf.length - nl - 1 >= len) finish({ kind: "ok", out: buf.subarray(nl + 1, nl + 1 + len).toString("utf8") });
    });
    c.on("end", () => finish({ kind: "failed" }));
  });
}

/** Bodies this large are handled faster by the hook itself than by shipping them over the socket. */
export const MAX_SERVICE_BYTES = 1_000_000;

/** Ask the service to run a hook. Only a known mode and a body that is worth shipping are sent at all. */
export function ask(agent: string, mode: string, body: string, timeoutMs = 700, sock = socketPath()): Promise<Answer> {
  const bytes = Buffer.byteLength(body);
  const m = mode || "-";
  if (!/^(?:-|tool|stop|decision)$/.test(m) || bytes > MAX_SERVICE_BYTES || (m === "-" && bytes > MAX_PROMPT_BYTES)) return Promise.resolve({ kind: "declined" });
  return exchange(`${PROTOCOL} ${agent} ${m} ${bytes}\n`, body, timeoutMs, sock);
}

/** The hook's output ("" when it has none), or null when the service can't answer: not running, busy, or declining. */
export async function query(agent: string, mode: string, body: string, timeoutMs = 700, sock = socketPath()): Promise<string | null> {
  const a = await ask(agent, mode, body, timeoutMs, sock);
  return a.kind === "ok" ? a.out : null;
}

/**
 * After a hook found no healthy service: start one in the background, unless a start is already under way
 * (a fresh run/svc.lock) or starting keeps failing (a recent run/svc.off). The starter itself checks again.
 */
export function startServiceSoon(dir = SR_DIR): void {
  try {
    // Recent means 0 to N ms old: a file from the future (the clock was stepped back) does not count.
    const recent = (f: string, ms: number) => { try { const age = Date.now() - fs.statSync(f).mtimeMs; return age >= 0 && age < ms; } catch { return false; } };
    if (recent(path.join(runDir(dir), "svc.lock"), 15000) || recent(path.join(runDir(dir), "svc.off"), 5 * 60e3)) return;
    // One starter at a time: whoever makes this stamp starts the service, the rest of a burst of hooks do not.
    const stamp = path.join(runDir(dir), "svc.starting");
    fs.mkdirSync(runDir(dir), { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(stamp, { mode: 0o700 }); }
    catch { if (!recent(stamp, 15000)) try { fs.rmdirSync(stamp); } catch { /* gone */ } return; }
    spawn(process.execPath, [process.argv[1], "serve", "--start"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch { /* hooks never fail on this */ }
}

export interface ServiceStatus {
  pid: number; startedAt: string; lastRequestAt: string | null; requests: number; fallbacks: number;
  byMode: Record<string, { count: number; avgMs: number }>; rssMB: number; skills: number; vectors: string;
  idleMin: number; socket: string; version: string;
}

export async function status(timeoutMs = 1000, sock = socketPath()): Promise<ServiceStatus | null> {
  const r = await exchange(`${PROTOCOL} - status 0\n`, "", timeoutMs, sock);
  try { return r.kind === "ok" ? (JSON.parse(r.out) as ServiceStatus) : null; } catch { return null; }
}

/** `dead`: nothing listening. `hung`: accepted the connection but never answered. `alive`: answered. */
export function ping(sock = socketPath(), timeoutMs = 400): Promise<"alive" | "dead" | "hung"> {
  return new Promise((resolve) => {
    if (process.platform === "win32" ? !ownedByMe(sock) : !fs.existsSync(sock)) return resolve("dead"); // (a pipe is found by connecting)
    let done = false;
    const finish = (v: "alive" | "dead" | "hung") => { if (done) return; done = true; clearTimeout(timer); c.destroy(); resolve(v); };
    // On Windows "alive" means the server proved it holds the key; a squatter's answer counts as nothing being there.
    const key = process.platform === "win32" ? readKey() : null;
    if (process.platform === "win32" && !key) return resolve("dead");
    const nonce = randomBytes(16).toString("hex");
    const c = net.connect(sock);
    const timer = setTimeout(() => finish("hung"), timeoutMs);
    c.on("error", () => finish("dead"));
    c.on("connect", () => c.write(key ? `${PROTOCOL} - hello ${nonce}\n` : `${PROTOCOL} - status 0\n`));
    c.on("data", (d) => {
      const line = d.toString("latin1").split("\n")[0];
      if (!key) return finish(line.startsWith("OK ") ? "alive" : "dead");
      const m = /^HELLO ([0-9a-f]{64})$/.exec(line);
      finish(m && timingSafeEqual(Buffer.from(m[1]), Buffer.from(serverProof(key, nonce))) ? "alive" : "dead");
    });
    c.on("end", () => finish("dead"));
  });
}

/** What `doctor` can say without a round trip: the pid and snapshot the service keeps under run/. */
export function serviceSnapshot(dir = SR_DIR): { running: boolean; pid?: number; startedAt?: string; requests?: number; rssMB?: number } {
  try {
    const pid = Number(fs.readFileSync(path.join(runDir(dir), "svc.pid"), "utf8"));
    process.kill(pid, 0);
    let snap: any = {};
    try { snap = JSON.parse(fs.readFileSync(path.join(runDir(dir), "svc.json"), "utf8")); } catch { /* not written yet */ }
    return { running: true, pid, startedAt: snap.startedAt, requests: snap.requests, rssMB: snap.rssMB };
  } catch { return { running: false }; }
}

/**
 * The hook client, in Perl because Perl starts in about 10 ms with its modules where Node needs 30 (and macOS `nc`
 * drops a reply that arrives after stdin closes). It owns the whole hook so the shell never buffers stdin:
 *   1. reads the hook's stdin, bounded to 1.5 s like the standalone path (a host that never closes its pipe can't hang a hook);
 *   2. asks the warm service (one 0.8 s budget, 0.35 s for OpenCode, for connect, write and read, all select-based on a non-blocking socket;
 *      skipped for huge payloads, unknown modes, and when the hook's state folder is not the one the service serves);
 *   3. starts a service in the background when there is none or it failed (throttled by run/svc.lock and svc.off);
 *   4. otherwise runs the hook with Node, handing it the same stdin, so output and exit code are exactly the old ones.
 * Exit codes are 0 or 1 only; 2 or 255 mean Perl itself could not run this script, and the launcher then uses Node.
 */
export const PERL_CLIENT = String.raw`# skillrouter hook client. Rewritten by skillrouter install; the launcher calls it with:
#   STATE_DIR SOCKET NODE CLI AGENT [MODE]
use Socket;
use Fcntl;
use Time::HiRes qw(alarm time);
my ($dir, $sock, $node, $cli, @hook) = @ARGV;
my $mode = defined $hook[1] ? $hook[1] : "-";
my $budget = (defined $hook[0] && $hook[0] eq "opencode") ? 0.35 : 0.8;   # OpenCode's plugin kills a hook at 2 s
$SIG{PIPE} = "IGNORE";

# 1. stdin, bounded
my $body = "";
binmode STDIN;
eval {
  my $deadline = time + 1.5;
  my ($rin, $buf) = ("");
  vec($rin, 0, 1) = 1;
  while (length($body) < 9_000_000) {
    my $left = $deadline - time;
    last if $left <= 0;
    my $n = select(my $rout = $rin, undef, undef, $left);
    if (!defined $n || $n < 0) { next if $!{EINTR}; last }
    last unless $n;
    my $got = sysread(STDIN, $buf, 65536);
    if (!defined $got) { next if $!{EINTR}; last }
    last unless $got;
    $body .= $buf;
  }
};

# A file counts as recent when it is 0 to N seconds old: one from the future (the clock was stepped back) does not.
sub recent {
  my ($f, $secs) = @_;
  my @s = stat($f);
  return @s && time - $s[9] >= 0 && time - $s[9] < $secs;
}

sub starter {
  return if recent("$dir/run/svc.lock", 15) || recent("$dir/run/svc.off", 300);
  mkdir("$dir/run", 0700) unless -d "$dir/run";
  # One starter at a time: whoever makes this stamp starts the service, the rest of a burst of hooks do not.
  unless (mkdir("$dir/run/svc.starting", 0700)) {
    rmdir("$dir/run/svc.starting") unless recent("$dir/run/svc.starting", 15);
    return;
  }
  my $pid = fork();
  return unless defined $pid;
  if ($pid == 0) {
    open(STDIN, "<", "/dev/null");
    open(STDOUT, ">", "/dev/null");
    open(STDERR, ">", "/dev/null");
    exec($node, $cli, "serve", "--start");
    exit 0;
  }
}

# One deadline covers connecting, writing and reading, all with select on a non-blocking socket: a signal can
# never leave this stuck inside a blocking write to a service that has stopped reading.
# 0 answered (output printed), 10 the service said FALLBACK, 11 anything else
sub ask {
  my @st = stat($sock);
  return 11 unless @st && $st[4] == $<;
  socket(my $s, PF_UNIX, SOCK_STREAM, 0) or return 11;
  my $deadline = time + $budget;
  my $rc = 11;
  eval {
    local $SIG{ALRM} = sub { die "timeout\n" };
    alarm $budget;
    connect($s, sockaddr_un($sock)) or die "connect\n";
    alarm 0;
    fcntl($s, F_SETFL, fcntl($s, F_GETFL, 0) | O_NONBLOCK) or die "nonblock\n";
    my $req = "SR1 $hook[0] $mode " . length($body) . "\n" . $body;
    my $off = 0;
    while ($off < length $req) {
      my $left = $deadline - time;
      die "timeout\n" if $left <= 0;
      my $win = "";
      vec($win, fileno($s), 1) = 1;
      my $n = select(undef, $win, undef, $left);
      if (!defined $n || $n < 0) { next if $!{EINTR}; die "select\n" }
      die "timeout\n" unless $n;
      my $put = syswrite($s, $req, 65536, $off);
      if (!defined $put) { next if $!{EAGAIN} || $!{EWOULDBLOCK} || $!{EINTR}; die "write\n" }
      $off += $put;
    }
    my ($r, $buf) = ("");
    while (1) {
      my $left = $deadline - time;
      die "timeout\n" if $left <= 0;
      my $rin = "";
      vec($rin, fileno($s), 1) = 1;
      my $n = select($rin, undef, undef, $left);
      if (!defined $n || $n < 0) { next if $!{EINTR}; die "select\n" }
      die "timeout\n" unless $n;
      my $got = sysread($s, $buf, 65536);
      if (!defined $got) { next if $!{EAGAIN} || $!{EWOULDBLOCK} || $!{EINTR}; die "read\n" }
      die "closed\n" unless $got;
      $r .= $buf;
      next unless $r =~ /\n/;
      if ($r =~ /\AFALLBACK\n/) { $rc = 10; last }
      die "protocol\n" unless $r =~ /\AOK (\d+)\n/;
      my ($len, $head) = ($1, length($&));
      next if length($r) < $head + $len;
      my $out = substr($r, $head, $len);
      if (length $out) { binmode STDOUT; print STDOUT $out, "\n" }
      $rc = 0;
      last;
    }
  };
  alarm 0;
  return $rc;
}

# 2. the service, when it is worth asking: a known mode, a payload that is not huge, and the same state folder the
# hook itself would use (SKILLROUTER_HOME, else HOME/.skillrouter). Anything unexpected falls through to Node.
my $answered = 0;
eval {
  my $want = (defined $ENV{SKILLROUTER_HOME} && length $ENV{SKILLROUTER_HOME}) ? $ENV{SKILLROUTER_HOME}
           : (defined $ENV{HOME} && length $ENV{HOME}) ? "$ENV{HOME}/.skillrouter" : $dir;
  my $same = $want eq $dir;
  my $small = length($body) <= 1_000_000 && ($mode ne "-" || length($body) <= 262144);
  my $known = $mode =~ /\A(?:-|tool|stop|decision)\z/ && defined $hook[0] && $hook[0] =~ /\A[a-z]+\z/;
  if ($same && $small && $known) {
    if (-S $sock) {
      my $rc = ask();
      $answered = 1 if $rc == 0;
      starter() if $rc == 11 && !$answered;
    } else {
      starter();
    }
  }
};
exit 0 if $answered;

# 4. the hook itself, exactly as before
$ENV{SKILLROUTER_SERVICE_TRIED} = "1";
open(my $n, "|-", $node, $cli, "hint", @hook) or exit 1;
binmode $n;
print $n $body;
close $n;
exit(($? & 127) ? 1 : ($? >> 8) > 1 ? 1 : $? >> 8);
`;
