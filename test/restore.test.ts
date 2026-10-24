import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { powershellPath, tarCommand } from "../src/platform.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(suffix = "") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter restore ü " + suffix));
  homes.push(home);
  const sr = path.join(home, ".skillrouter"), source = path.join(home, ".claude", "skills");
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(sr);
  const env = { ...process.env, HOME: home, USERPROFILE: home, SKILLROUTER_HOME: sr, SKILLROUTER_SERVICE: "0" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", windowsHide: true });
  const skill = (name: string, text = name) => { const dir = path.join(source, name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "SKILL.md"), text); return dir; };
  const manifest = () => path.join(sr, "backups", fs.readdirSync(path.join(sr, "backups")).find((n) => n.endsWith(".json"))!);
  const applyTrim = (...agents: string[]) => { const r = run("trim", ...(agents.length ? agents : ["claude"]), "--apply"); assert.equal(r.status, 0, r.stderr); return manifest(); };
  return { home, sr, source, env, run, skill, manifest, applyTrim };
}

test("trim -> restore preserves bytes, original agent folders, retained core, links and paths with spaces", () => {
  const f = fixture();
  const moved = f.skill("moved", "original skill\n");
  fs.mkdirSync(path.join(moved, "nested"));
  const bytes = Buffer.from([0, 1, 255, 128, 10]);
  fs.writeFileSync(path.join(moved, "nested", "data file.bin"), bytes, { mode: 0o755 });
  f.skill("core", "retained core"); fs.writeFileSync(path.join(f.sr, "core.txt"), "core\n");
  const target = path.join(f.home, "external library"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "SKILL.md"), "external");
  fs.symlinkSync(target, path.join(f.source, "linked"), process.platform === "win32" ? "junction" : "dir");
  const manifest = f.applyTrim();
  assert.ok(!fs.existsSync(moved));
  assert.equal(fs.readFileSync(path.join(f.source, "core", "SKILL.md"), "utf8"), "retained core");
  const metadata = JSON.parse(fs.readFileSync(manifest, "utf8"));
  assert.equal(metadata.backups[0].source, f.source);
  assert.equal(metadata.backups[0].sha256, sha(path.join(path.dirname(manifest), metadata.backups[0].archive)));
  const preview = f.run("restore", manifest);
  assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /Dry run/); assert.ok(!fs.existsSync(moved));
  const restored = f.run("restore", manifest, "--apply");
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(path.join(moved, "SKILL.md"), "utf8"), "original skill\n");
  assert.deepEqual(fs.readFileSync(path.join(moved, "nested", "data file.bin")), bytes);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(moved, "nested", "data file.bin")).mode & 0o777, 0o755);
  assert.ok(fs.lstatSync(path.join(f.source, "linked")).isSymbolicLink());
  assert.equal(fs.realpathSync(path.join(f.source, "linked")), fs.realpathSync(target));
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "external");
  assert.ok(!fs.existsSync(path.join(f.sr, "skills")), "does not extract into the state directory");
  const again = f.run("restore", manifest, "--apply");
  assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /0 missing entries/);
});

test("a skill changed since the trim is skipped and listed with every other changed skill; the rest is restored", () => {
  const f = fixture(); f.skill("alpha"); f.skill("omega"); f.skill("gamma");
  const manifest = f.applyTrim();
  f.skill("omega", "user changed this");
  const elsewhere = path.join(f.home, "core copy of gamma"); fs.mkdirSync(elsewhere); fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "re-added");
  fs.symlinkSync(elsewhere, path.join(f.source, "gamma"), process.platform === "win32" ? "junction" : "dir"); // what `core add` + `core sync` leaves
  const preview = f.run("restore", manifest);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Will skip 2 skills that changed since the trim/);
  assert.match(preview.stdout, /omega {2}\(differs: omega\/SKILL\.md\)/);
  assert.match(preview.stdout, /gamma {2}\(differs: gamma\)/);
  assert.ok(!fs.existsSync(path.join(f.source, "alpha")), "a preview changes nothing");
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Skipped 2 skills/);
  assert.equal(fs.readFileSync(path.join(f.source, "alpha", "SKILL.md"), "utf8"), "alpha");
  assert.equal(fs.readFileSync(path.join(f.source, "omega", "SKILL.md"), "utf8"), "user changed this");
  assert.ok(fs.lstatSync(path.join(f.source, "gamma")).isSymbolicLink(), "the re-added skill is left as it is");
  assert.equal(fs.readFileSync(path.join(elsewhere, "SKILL.md"), "utf8"), "re-added", "and nothing was written through it");
});

test("skills trim kept are never restored or checked: later edits and deliberate deletions stand", () => {
  const f = fixture(); f.skill("moved"); f.skill("edited-core", "v1"); f.skill("deleted-core", "v1");
  fs.writeFileSync(path.join(f.sr, "core.txt"), "edited-core\ndeleted-core\n");
  const manifest = f.applyTrim();
  const record = JSON.parse(fs.readFileSync(manifest, "utf8")).backups[0];
  assert.deepEqual(record.removed, ["moved"], "the manifest names only what trim took out");
  f.skill("edited-core", "v2 from a skills update");
  fs.rmSync(path.join(f.source, "deleted-core"), { recursive: true });
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Left alone: 2 entries trim kept/);
  assert.doesNotMatch(r.stdout, /skip/i);
  assert.equal(fs.readFileSync(path.join(f.source, "moved", "SKILL.md"), "utf8"), "moved");
  assert.equal(fs.readFileSync(path.join(f.source, "edited-core", "SKILL.md"), "utf8"), "v2 from a skills update");
  assert.ok(!fs.existsSync(path.join(f.source, "deleted-core")), "a kept skill deleted on purpose is not brought back");
});

test("a skill is restored whole or not at all: missing files fill in, but one changed file skips its skill", () => {
  const f = fixture();
  for (const name of ["partial", "mixed"]) { const dir = f.skill(name, "same"); fs.writeFileSync(path.join(dir, "ref.md"), `${name} ref`); }
  const manifest = f.applyTrim();
  for (const name of ["partial", "mixed"]) { fs.mkdirSync(path.join(f.source, name)); fs.writeFileSync(path.join(f.source, name, "SKILL.md"), "same"); }
  fs.writeFileSync(path.join(f.source, "mixed", "SKILL.md"), "edited");
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.source, "partial", "ref.md"), "utf8"), "partial ref", "an identical skill gets its missing files back");
  assert.ok(!fs.existsSync(path.join(f.source, "mixed", "ref.md")), "a changed skill gets nothing, so it never ends up half old, half new");
  assert.match(r.stdout, /mixed {2}\(differs: mixed\/SKILL\.md\)/);
});

test("version 1 manifests (no removed list) still restore every missing entry", () => {
  const f = fixture(); f.skill("alpha"); f.skill("kept"); fs.writeFileSync(path.join(f.sr, "core.txt"), "kept\n");
  const manifest = f.applyTrim();
  const m = JSON.parse(fs.readFileSync(manifest, "utf8")); m.version = 1; delete m.backups[0].removed; fs.writeFileSync(manifest, JSON.stringify(m));
  fs.rmSync(path.join(f.source, "kept"), { recursive: true });
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(f.source, "alpha", "SKILL.md")) && fs.existsSync(path.join(f.source, "kept", "SKILL.md")));
});

test("a removed list that names anything but the record's own top-level entries is rejected", () => {
  for (const bad of [["../escape"], ["alpha/SKILL.md"], ["not-in-backup"], ["alpha", "alpha"], "alpha"]) {
    const f = fixture(); f.skill("alpha"); const manifest = f.applyTrim();
    const m = JSON.parse(fs.readFileSync(manifest, "utf8")); m.backups[0].removed = bad; fs.writeFileSync(manifest, JSON.stringify(m));
    const r = f.run("restore", manifest, "--apply");
    assert.equal(r.status, 1, JSON.stringify(bad)); assert.match(r.stderr, /Invalid list of removed entries/);
    assert.ok(!fs.existsSync(path.join(f.source, "alpha")));
  }
});

test("restore extracts each archive once, however many files it brings back", { skip: process.platform === "win32" && "counts calls through a POSIX tar shim" }, () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) { const dir = f.skill(`skill-${i}`); for (let j = 0; j < 5; j++) fs.writeFileSync(path.join(dir, `ref-${j}.md`), `${i}/${j}`); }
  const manifest = f.applyTrim();
  const bin = path.join(f.home, "bin"); fs.mkdirSync(bin);
  const realTar = execFileSync("/bin/sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
  const log = path.join(f.home, "tar calls.log");
  fs.writeFileSync(path.join(bin, "tar"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TAR_LOG"\nexec '${realTar}' "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [cli, "restore", manifest, "--apply"], { env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TAR_LOG: log }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /280 restored/); // 40 skills x (folder + SKILL.md + 5 references)
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 1, `one extraction for 240 files, not one per file: ${calls.length}`);
  assert.match(calls[0], /^-xf /);
});

test("names tar would read as patterns, read-only folders and staging cleanup", () => {
  const f = fixture(); const dir = f.skill("odd names");
  const names = ["notes [draft].md", ...(process.platform === "win32" ? [] : ["star*and?.md"])];
  for (const n of names) fs.writeFileSync(path.join(dir, n), `bytes of ${n}`);
  fs.mkdirSync(path.join(dir, "locked")); fs.writeFileSync(path.join(dir, "locked", "inside.md"), "inside");
  if (process.platform !== "win32") fs.chmodSync(path.join(dir, "locked"), 0o555);
  const manifest = f.applyTrim();
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 0, r.stderr);
  for (const n of names) assert.equal(fs.readFileSync(path.join(dir, n), "utf8"), `bytes of ${n}`);
  assert.equal(fs.readFileSync(path.join(dir, "locked", "inside.md"), "utf8"), "inside");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "locked")).mode & 0o777, 0o555, "the folder's mode comes back too");
  assert.deepEqual(fs.readdirSync(path.dirname(manifest)).filter((n) => n.startsWith(".restore-")), [], "staging is removed, read-only folders and all");
  if (process.platform !== "win32") for (const copy of [dir, path.join(f.sr, "library", "odd names")]) fs.chmodSync(path.join(copy, "locked"), 0o755); // let the fixture cleanup remove both copies
});

test("restore rejects a changed archive before touching an agent folder", () => {
  const f = fixture(); f.skill("alpha"); const manifest = f.applyTrim();
  const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
  fs.appendFileSync(path.join(path.dirname(manifest), m.backups[0].archive), "tampered");
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 1); assert.match(r.stderr, /archive missing or changed/);
  assert.ok(!fs.existsSync(path.join(f.source, "alpha")));
});

test("restore verifies streamed contents before adding anything, even if archive checksum was updated", () => {
  const f = fixture(); f.skill("alpha", "before"); const manifest = f.applyTrim();
  const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const fake = path.join(f.home, "replacement"); fs.mkdirSync(path.join(fake, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(fake, "skills", "alpha", "SKILL.md"), "different");
  const archive = path.join(path.dirname(manifest), m.backups[0].archive);
  execFileSync(tarCommand(), ["-cf", archive, "-C", fake, "skills"], { windowsHide: true });
  m.backups[0].sha256 = sha(archive); fs.writeFileSync(manifest, JSON.stringify(m));
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 1); assert.match(r.stderr, /content does not match/);
  assert.ok(!fs.existsSync(path.join(f.source, "alpha")));
});

test("restore rejects traversal, non-agent destinations and children below links in a manifest", () => {
  for (const kind of ["traversal", "source", "link-parent"] as const) {
    const f = fixture(); f.skill("alpha"); const manifest = f.applyTrim();
    const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (kind === "source") m.backups[0].source = path.join(f.home, "unrelated");
    else if (kind === "traversal") m.backups[0].entries.push({ path: "../escape", type: "directory", mode: 0o700 });
    else Object.assign(m.backups[0].entries.find((e: any) => e.path === "alpha"), { type: "symlink", target: f.home, directory: true });
    fs.writeFileSync(manifest, JSON.stringify(m));
    const r = f.run("restore", manifest, "--apply"); assert.equal(r.status, 1, kind);
    assert.ok(!fs.existsSync(path.join(f.source, "alpha")));
  }
});

test("restore never writes through a replacement symlink or junction ancestor", () => {
  const f = fixture(); f.skill("alpha"); const manifest = f.applyTrim();
  fs.rmSync(f.source, { recursive: true });
  const outside = path.join(f.home, "elsewhere"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.source, process.platform === "win32" ? "junction" : "dir");
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 1); assert.match(r.stderr, /collision|not a real directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a partial trim failure leaves a usable manifest before any move", () => {
  const f = fixture(); f.skill("alpha"); f.skill("omega");
  const library = path.join(f.sr, "library");
  fs.mkdirSync(path.join(library, "omega"), { recursive: true });
  fs.mkdirSync(path.join(library, ".conflicts", ".claude", "omega"), { recursive: true });
  fs.writeFileSync(path.join(library, ".conflicts", ".claude", "omega", "occupied"), "keep");
  const r = f.run("trim", "claude", "--apply");
  assert.equal(r.status, 1); assert.ok(!fs.existsSync(path.join(f.source, "alpha")));
  const manifest = f.manifest();
  const restore = f.run("restore", manifest, "--apply");
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(fs.readFileSync(path.join(f.source, "alpha", "SKILL.md"), "utf8"), "alpha");
  assert.equal(fs.readFileSync(path.join(f.source, "omega", "SKILL.md"), "utf8"), "omega");
});

test("multiple original agent folders restore separately without mixing their archives", () => {
  const f = fixture(); f.skill("same", "claude");
  const other = path.join(f.home, ".cursor", "skills");
  fs.mkdirSync(path.join(other, "same"), { recursive: true }); fs.writeFileSync(path.join(other, "same", "SKILL.md"), "cursor");
  const manifest = f.applyTrim("claude", "cursor");
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.source, "same", "SKILL.md"), "utf8"), "claude");
  assert.equal(fs.readFileSync(path.join(other, "same", "SKILL.md"), "utf8"), "cursor");
});

test("restore recovers hardlinked file bytes and recreates missing agent parents", () => {
  const f = fixture(); const skill = f.skill("linked", "hardlink bytes");
  fs.linkSync(path.join(skill, "SKILL.md"), path.join(skill, "copy.md"));
  const manifest = f.applyTrim();
  fs.rmSync(path.dirname(f.source), { recursive: true });
  const r = f.run("restore", manifest, "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.source, "linked", "SKILL.md"), "utf8"), "hardlink bytes");
  assert.equal(fs.readFileSync(path.join(f.source, "linked", "copy.md"), "utf8"), "hardlink bytes");
});

test("trim preflights linked agent ancestors across every source before any move or manifest", () => {
  for (const multiAgent of [false, true]) {
    const f = fixture(); f.skill("keep-unmoved");
    const agent = multiAgent ? ".cursor" : ".claude";
    if (!multiAgent) fs.rmSync(path.join(f.home, agent), { recursive: true });
    const target = path.join(f.home, "redirected agent");
    fs.mkdirSync(path.join(target, "skills", "example"), { recursive: true });
    fs.writeFileSync(path.join(target, "skills", "example", "SKILL.md"), "must remain");
    fs.symlinkSync(target, path.join(f.home, agent), process.platform === "win32" ? "junction" : "dir");
    const r = f.run("trim", "claude", ...(multiAgent ? ["cursor"] : []), "--apply");
    assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, /parent is not a real directory/);
    assert.equal(fs.readFileSync(path.join(target, "skills", "example", "SKILL.md"), "utf8"), "must remain");
    if (multiAgent) assert.equal(fs.readFileSync(path.join(f.source, "keep-unmoved", "SKILL.md"), "utf8"), "keep-unmoved");
    assert.ok(!fs.existsSync(path.join(f.sr, "backups")), "preflight runs before recovery artifacts");
    assert.ok(!fs.existsSync(path.join(f.sr, "library")), "preflight runs before destination mutation");
  }
});

test("trim rejects non-directory agent ancestors before changing an earlier valid source", () => {
  const f = fixture(); f.skill("keep-unmoved"); fs.writeFileSync(path.join(f.home, ".cursor"), "not a directory");
  const r = f.run("trim", "claude", "cursor", "--apply");
  assert.equal(r.status, 1); assert.match(r.stderr, /parent is not a real directory/);
  assert.equal(fs.readFileSync(path.join(f.source, "keep-unmoved", "SKILL.md"), "utf8"), "keep-unmoved");
  assert.ok(!fs.existsSync(path.join(f.sr, "backups")));
});

test("trim retains its safe skip behavior for a linked skill-folder root", () => {
  const f = fixture(); fs.rmSync(f.source, { recursive: true });
  const target = path.join(f.home, "shared skills"); fs.mkdirSync(path.join(target, "example"), { recursive: true });
  fs.writeFileSync(path.join(target, "example", "SKILL.md"), "keep shared skill");
  fs.symlinkSync(target, f.source, process.platform === "win32" ? "junction" : "dir");
  const manifest = f.applyTrim();
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, "utf8")).backups, []);
  assert.equal(fs.readFileSync(path.join(target, "example", "SKILL.md"), "utf8"), "keep shared skill");
});

test("recovery instructions safely quote literal shell syntax, apostrophes, Unicode and spaces", () => {
  const f = fixture("$SR_QA_UNSET `printf expanded` O'Brien "); f.skill("example");
  const manifest = f.applyTrim();
  const instructions = fs.readFileSync(manifest.replace(/\.json$/, ".md"), "utf8");
  assert.match(instructions, /POSIX shells/); assert.match(instructions, /PowerShell/); assert.match(instructions, /not for cmd.exe/);
  const commands = instructions.split("\n").filter((line) => line.startsWith("skillrouter restore "));
  assert.equal(commands.length, 4);
  const posix = "'" + manifest.replace(/'/g, "'\\''") + "'";
  const powershell = "'" + manifest.replace(/'/g, "''") + "'";
  assert.deepEqual(commands, [`skillrouter restore ${posix}`, `skillrouter restore ${posix} --apply`, `skillrouter restore ${powershell}`, `skillrouter restore ${powershell} --apply`]);
  for (const apply of [false, true]) {
    const command = commands[(process.platform === "win32" ? 2 : 0) + Number(apply)];
    const expected = ["restore", manifest, ...(apply ? ["--apply"] : [])];
    // A harmless native-shell stub records argv; it never invokes the restore CLI or path contents.
    const r = process.platform === "win32"
      ? spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); function skillrouter { $args | ConvertTo-Json -Compress }; ${command}`], { env: { ...f.env, SR_QA_UNSET: "expanded" }, encoding: "utf8", windowsHide: true })
      : spawnSync("/bin/sh", ["-c", `skillrouter() { printf '%s\\n' "$@"; }\n${command}`], { env: { ...f.env, SR_QA_UNSET: "expanded" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const argv = process.platform === "win32" ? JSON.parse(r.stdout.trim()) : r.stdout.trimEnd().split("\n");
    assert.deepEqual(argv, expected);
  }
});
