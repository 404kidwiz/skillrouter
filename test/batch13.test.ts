import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch13-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
const platform = await import("../src/platform.js");
const { install, isRouterHook, writeLauncher, CLAUDE_TOOL_MATCHER } = await import("../src/install.js");
const { actionOf, isWork, matchTriggers } = await import("../src/triggers.js");
const { skillLoadOf, skillReadIn } = await import("../src/events.js");
const { serviceEnabled } = await import("../src/service-client.js");
const { fwd, hookPrefix, launcherFile, linkDir, parseJson, renameSyncRetry, tarCommand, windowsLauncher, SHELL_TOOLS } = platform;

// Windows branches take the platform as a parameter, so they run (and are checked) on every OS.

test("hook commands: bare node plus a quoted forward-slash path on Windows, a quoted launcher elsewhere", () => {
  assert.equal(hookPrefix("C:\\Users\\me\\.skillrouter\\bin\\skillrouter-hint.mjs", "win32"), 'node "C:/Users/me/.skillrouter/bin/skillrouter-hint.mjs"');
  assert.equal(hookPrefix('C:/a"b/x.mjs', "win32"), 'node "C:/ab/x.mjs"'); // a quote can never end the argument early
  assert.equal(hookPrefix("/Users/me/.skillrouter/bin/skillrouter-hint", "darwin"), "'/Users/me/.skillrouter/bin/skillrouter-hint'");
  assert.equal(hookPrefix("/o'brien/bin/x", "linux"), "'/o'\\''brien/bin/x'");
  assert.equal(launcherFile("/x/skillrouter-hint", "win32"), "/x/skillrouter-hint.mjs");
  assert.equal(launcherFile("/x/skillrouter-hint", "darwin"), "/x/skillrouter-hint");
  assert.equal(fwd("a\\b\\c"), "a/b/c");
});

test("the Windows launcher hands argv and stdin to the CLI in one process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-launch-"));
  const cli = path.join(dir, "fake-cli.mjs");
  fs.writeFileSync(cli, 'import fs from "node:fs"; console.log(JSON.stringify({ argv: process.argv.slice(1), stdin: fs.readFileSync(0, "utf8") }));\n');
  const launcher = path.join(dir, "skillrouter-hint.mjs");
  fs.writeFileSync(launcher, windowsLauncher(cli));
  const run = spawnSync(process.execPath, [launcher, "claude", "tool"], { input: "payload", encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.argv, [fwd(cli), "hint", "claude", "tool"]);
  assert.equal(out.stdin, "payload");
});

test("install on Windows writes the module launcher, no Perl or shell script, and node-prefixed hook commands", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-win-"));
  const lines = install("claude", h, "win32");
  const bin = path.join(h, ".skillrouter", "bin");
  assert.ok(fs.existsSync(path.join(bin, "skillrouter-hint.mjs")));
  assert.deepEqual(fs.readdirSync(bin), ["skillrouter-hint.mjs"]);
  assert.match(lines[0], /skillrouter-hint\.mjs: runs .*warm service over a named pipe/);
  const settings = JSON.parse(fs.readFileSync(path.join(h, ".claude", "settings.json"), "utf8"));
  const prefix = `node "${fwd(path.join(bin, "skillrouter-hint.mjs"))}"`;
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, `${prefix} claude`);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, `${prefix} claude tool`);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, `${prefix} claude stop`);
  assert.ok(isRouterHook(settings.hooks.Stop[0]), "the Windows command is still recognised as the router's");
});

test("every host's hook file gets the same Windows command shape", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-win-all-"));
  for (const agent of ["codex", "cursor", "gemini"] as const) install(agent, h, "win32");
  const prefix = `node "${fwd(path.join(h, ".skillrouter", "bin", "skillrouter-hint.mjs"))}"`;
  const codex = JSON.parse(fs.readFileSync(path.join(h, ".codex", "hooks.json"), "utf8"));
  const cursor = JSON.parse(fs.readFileSync(path.join(h, ".cursor", "hooks.json"), "utf8"));
  const gemini = JSON.parse(fs.readFileSync(path.join(h, ".gemini", "settings.json"), "utf8"));
  assert.equal(codex.hooks.UserPromptSubmit[0].hooks[0].command, `${prefix} codex`);
  assert.equal(cursor.hooks.beforeSubmitPrompt[0].command, `${prefix} cursor`);
  assert.equal(gemini.hooks.BeforeAgent[0].hooks[0].command, `${prefix} gemini`);
  assert.equal(gemini.hooks.AfterTool[0].hooks[0].command, `${prefix} gemini tool`);
});

test("reinstalling for the other platform replaces the router's hooks instead of adding second ones", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-swap-"));
  const file = path.join(h, ".claude", "settings.json");
  install("claude", h, "win32");
  install("claude", h, "darwin");
  let s = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /^'.*skillrouter-hint' claude$/);
  install("claude", h, "win32");
  s = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /^node ".*skillrouter-hint\.mjs" claude$/);
});

test("the OpenCode plugin spawns node with the launcher module on Windows, and never shows a console window", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-oc-"));
  const plugin = path.join(h, ".config", "opencode", "plugins", "skillrouter-hints.js");
  install("opencode", h, "win32");
  const win = fs.readFileSync(plugin, "utf8");
  assert.match(win, /spawn\(".*node(\.exe)?", \[\.\.\.\[".*skillrouter-hint\.mjs","opencode"\]/);
  assert.match(win, /windowsHide: true/);
  install("opencode", h, "darwin");
  const posix = fs.readFileSync(plugin, "utf8");
  assert.match(posix, /spawn\(".*skillrouter-hint", \[\.\.\.\["opencode"\]/);
  assert.match(posix, /windowsHide: true/);
});

test("the POSIX launcher is unchanged when the platform is not Windows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-posix-"));
  const launcher = path.join(dir, "bin", "skillrouter-hint");
  writeLauncher("/usr/bin/node", "/x/cli.js", launcher, "linux");
  assert.match(fs.readFileSync(launcher, "utf8"), /^#!\/bin\/sh\n/);
  assert.ok(fs.existsSync(path.join(dir, "bin", "skillrouter-client.pl")));
});

test("renameSyncRetry retries Windows lock errors a few times and gives up on the rest", () => {
  const code = (c: string) => Object.assign(new Error(c), { code: c });
  let calls = 0, slept = 0;
  const flaky = { renameSync: () => { if (++calls < 4) throw code("EPERM"); } };
  renameSyncRetry("a", "b", flaky, "win32", () => { slept++; });
  assert.equal(calls, 4);
  assert.equal(slept, 3);

  calls = 0;
  assert.throws(() => renameSyncRetry("a", "b", { renameSync: () => { calls++; throw code("EPERM"); } }, "linux", () => {}), /EPERM/);
  assert.equal(calls, 1, "elsewhere the first failure is final");

  calls = 0;
  assert.throws(() => renameSyncRetry("a", "b", { renameSync: () => { calls++; throw code("ENOENT"); } }, "win32", () => {}), /ENOENT/);
  assert.equal(calls, 1, "a missing file is not a lock");

  calls = 0;
  assert.throws(() => renameSyncRetry("a", "b", { renameSync: () => { calls++; throw code("EBUSY"); } }, "win32", () => {}), /EBUSY/);
  assert.equal(calls, 13, "a file that stays locked fails after the last retry, with its own error");
});

test("renameSyncRetry replaces a real file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-rename-"));
  fs.writeFileSync(path.join(dir, "a"), "new");
  fs.writeFileSync(path.join(dir, "b"), "old");
  renameSyncRetry(path.join(dir, "a"), path.join(dir, "b"));
  assert.equal(fs.readFileSync(path.join(dir, "b"), "utf8"), "new");
});

test("directory links are junctions on Windows and symlinks elsewhere", () => {
  const seen: unknown[][] = [];
  const spy = { symlinkSync: (...a: unknown[]) => { seen.push(a); } } as unknown as Pick<typeof fs, "symlinkSync">;
  linkDir("/t", "/l", spy, "win32");
  linkDir("/t", "/l", spy, "darwin");
  assert.deepEqual(seen, [["/t", "/l", "junction"], ["/t", "/l", undefined]]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-link-"));
  fs.mkdirSync(path.join(dir, "real"));
  fs.writeFileSync(path.join(dir, "real", "SKILL.md"), "hello");
  linkDir(path.join(dir, "real"), path.join(dir, "link")); // the real thing on this OS: no admin rights needed anywhere
  assert.equal(fs.readFileSync(path.join(dir, "link", "SKILL.md"), "utf8"), "hello");
  assert.ok(fs.lstatSync(path.join(dir, "link")).isSymbolicLink(), "Node reports a junction as a link, so the trim code treats it as one");
  assert.equal(fs.realpathSync(path.join(dir, "link")), fs.realpathSync(path.join(dir, "real")));
});

test("Windows's own tar is used when it exists, so Git Bash's GNU tar never sees C:", () => {
  const env = { SystemRoot: "C:\\Windows" };
  assert.equal(tarCommand("win32", env, () => true), "C:\\Windows\\System32\\tar.exe");
  assert.equal(tarCommand("win32", env, () => false), "tar");
  assert.equal(tarCommand("win32", {}, () => true), "tar");
  assert.equal(tarCommand("darwin", env, () => true), "tar");
});

test("PowerShell is a shell tool on every path that looks at shell commands", () => {
  for (const t of ["Bash", "Shell", "run_shell_command", "exec_command", "PowerShell", "powershell", "pwsh"]) assert.ok(SHELL_TOOLS.test(t), t);
  for (const t of ["Read", "Edit", "bashful", "PowerShellScript"]) assert.ok(!SHELL_TOOLS.test(t), t);
  assert.deepEqual(actionOf("PowerShell", { command: "docker build ." }), { command: "docker build ." });
  assert.ok(isWork(actionOf("PowerShell", { command: "docker build ." })));
});

test("PowerShell commands that only look around are not work", () => {
  for (const c of ["Get-Content README.md", "get-childitem -Recurse src", "Get-ChildItem | Select-String foo", "dir", "Test-Path .\\x", "Set-Location src", "Write-Host hi"])
    assert.ok(!isWork({ command: c }), c);
  for (const c of ["Set-Content a.txt hi", "Remove-Item -Recurse build", "npm test", "Get-Content a.txt > b.txt"])
    assert.ok(isWork({ command: c }), c);
});

test("trigger paths written with Windows backslashes match the same rules", () => {
  const ids = (file: string) => matchTriggers({ file }).map((m) => m.trigger.id);
  assert.ok(ids("C:\\work\\app\\Dockerfile").includes("docker"));
  assert.ok(ids("src\\db\\migrations\\0001_init.sql").includes("migration"));
  assert.ok(ids(".github\\workflows\\ci.yml").includes("ci"));
  assert.equal(matchTriggers({ file: "src\\k8s\\a.yaml" })[0]?.subject, "a.yaml", "the subject is the file name, not the whole path");
});

test("loads of a SKILL.md are recognised through Windows paths and PowerShell readers", () => {
  assert.equal(skillLoadOf("Read", { file_path: "C:\\Users\\me\\.skills\\pdf-tools\\SKILL.md" })?.skill, "pdf-tools");
  assert.equal(skillLoadOf("Read", { file_path: "C:/Users/me/.skills/pdf-tools/SKILL.md" })?.skill, "pdf-tools");
  assert.equal(skillLoadOf("PowerShell", { command: "Get-Content C:\\Users\\me\\.skills\\docker-best\\SKILL.md" })?.skill, "docker-best");
  assert.equal(skillLoadOf("PowerShell", { command: 'gc "C:\\Users\\me\\.skills\\docker-best\\SKILL.md" | select -First 40' })?.skill, "docker-best");
  assert.equal(skillReadIn("type C:\\s\\a-b\\SKILL.md"), "a-b");
  assert.equal(skillReadIn("C:\\Git\\usr\\bin\\cat.exe C:\\s\\a-b\\SKILL.md"), "a-b");
  assert.equal(skillReadIn("Get-Content C:\\s\\a-b\\SKILL.md > out.txt"), null, "writing the file is not loading it");
  assert.equal(skillReadIn("Select-String x C:\\s\\a-b\\SKILL.md"), null, "searching a file is not loading it");
  assert.equal(skillLoadOf("Read", { file_path: "C:\\s\\..\\SKILL.md" }), null);
});

test("the warm service is on everywhere unless SKILLROUTER_SERVICE=0", () => {
  const before = process.env.SKILLROUTER_SERVICE;
  try {
    delete process.env.SKILLROUTER_SERVICE;
    assert.equal(serviceEnabled(), true);
    process.env.SKILLROUTER_SERVICE = "0";
    assert.equal(serviceEnabled(), false);
  } finally {
    if (before === undefined) delete process.env.SKILLROUTER_SERVICE; else process.env.SKILLROUTER_SERVICE = before;
  }
});

test("launcherFile on this machine matches what install writes here", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-native-"));
  install("claude", h);
  assert.ok(fs.existsSync(launcherFile(path.join(h, ".skillrouter", "bin", "skillrouter-hint"))));
});

test("Codex's Windows shell wrappers are unwrapped to the script they run", () => {
  const cmd = (command: unknown) => (actionOf("shell", { command }) as { command: string } | null)?.command;
  assert.equal(cmd(["powershell.exe", "-NoProfile", "-Command", "docker build ."]), "docker build .");
  assert.equal(cmd(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "Get-Content x"]), "Get-Content x");
  assert.equal(cmd(["pwsh", "-c", "npm", "test"]), "npm test");
  assert.equal(cmd(["cmd.exe", "/c", "docker build ."]), "docker build .");
  assert.equal(cmd('powershell.exe -NoProfile -Command "docker build ."'), "docker build .");
  assert.equal(cmd("pwsh -c 'npm test'"), "npm test");
  assert.equal(cmd("cmd /c docker build ."), "docker build .");
  assert.equal(cmd("powershell.exe -File build.ps1"), "powershell.exe -File build.ps1", "not a -Command call: left alone");
  assert.equal(cmd(["bash", "-lc", "pytest -q"]), "pytest -q", "POSIX unwrapping is unchanged");
  assert.ok(matchTriggers(actionOf("shell", { command: ["powershell.exe", "-Command", "docker build ."] })!).some((m) => m.trigger.id === "docker"));
  assert.equal(skillLoadOf("shell", { command: ["powershell.exe", "-Command", "Get-Content C:\\s\\a-b\\SKILL.md"] })?.skill, "a-b");
});

test("Claude's PowerShell tool reaches the hook, in the installer and in the plugin alike", () => {
  assert.match("PowerShell", new RegExp(`^(?:${CLAUDE_TOOL_MATCHER})$`));
  const plugin = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url)), "utf8"));
  assert.equal(plugin.hooks.PostToolUse[0].matcher, CLAUDE_TOOL_MATCHER, "plugin and install watch the same tools");
});

test("the Windows launcher imports the CLI by its native path, so UNC installs work on Node 20", () => {
  const text = windowsLauncher("\\\\server\\share\\sr\\cli.js");
  assert.match(text, /const cli = "\/\/server\/share\/sr\/cli\.js";/);
  assert.match(text, /pathToFileURL\("\\\\\\\\server\\\\share\\\\sr\\\\cli\.js"\)/);
});

test("a path the hook shells would expand ($, backtick, %) is refused on Windows instead of installed broken", () => {
  for (const p of ["C:/Users/a$b/x.mjs", "C:/Users/a`b/x.mjs", "C:/Users/%USERNAME%/x.mjs"]) assert.throws(() => hookPrefix(p, "win32"), /would expand/);
  assert.equal(hookPrefix("/Users/a$b/x", "linux"), "'/Users/a$b/x'", "single quotes make them literal on POSIX");
  assert.equal(hookPrefix("C:/Users/Jane Doe (Work) & Co/x.mjs", "win32"), 'node "C:/Users/Jane Doe (Work) & Co/x.mjs"');
});

test("the generated Windows hook command runs through a real shell from a folder full of shell characters", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sr-shell-")), "o'brien (work) & co é");
  fs.mkdirSync(dir, { recursive: true });
  const cli = path.join(dir, "fake-cli.mjs");
  fs.writeFileSync(cli, 'import fs from "node:fs"; console.log(JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));\n');
  const launcher = path.join(dir, "skillrouter-hint.mjs");
  fs.writeFileSync(launcher, windowsLauncher(cli));
  // sh on POSIX, cmd.exe on Windows: both must read `node "<path>" claude tool` the way it is meant.
  const run = spawnSync(`${hookPrefix(launcher, "win32")} claude tool`, { shell: true, input: "body", encoding: "utf8", windowsHide: true, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { argv: ["hint", "claude", "tool"], stdin: "body" });
});

test("a SKILL.md read counts even when its quoted path has spaces", () => {
  assert.equal(skillReadIn('Get-Content "C:\\Users\\Jane Doe\\.skills\\x\\SKILL.md"'), "x");
  assert.equal(skillReadIn('cat "/Users/Jane Doe/.skills/x/SKILL.md"'), "x");
  assert.equal(skillReadIn("cat '/a b/.skills/y-z/SKILL.md' | head -20"), "y-z");
  assert.equal(skillReadIn("cat '/a b/my skill/SKILL.md'"), null, "a folder name with a space is no skill");
  assert.equal(skillReadIn('cat "a b/README.md"'), null);
});

test("config files saved with a UTF-8 BOM (Notepad, PowerShell 5.1) still install", () => {
  assert.deepEqual(parseJson("\uFEFF{\"a\":1}"), { a: 1 });
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-bom-"));
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude", "settings.json"), '\uFEFF{"theme":"dark"}');
  install("claude", h, "win32");
  const s = JSON.parse(fs.readFileSync(path.join(h, ".claude", "settings.json"), "utf8"));
  assert.equal(s.theme, "dark");
  assert.equal(s.hooks.Stop.length, 1);
});

test("the read-only check for POSIX commands is not widened by the PowerShell names", () => {
  for (const c of ["sl commit -m x", "gc.sh", "dir/build.sh", "dir-tool run", "ft build", "fl out.txt", "LS"]) assert.ok(isWork({ command: c }), c);
  for (const c of ["ls -la", "Get-ChildItem", "GET-CONTENT x", "dir"]) assert.ok(!isWork({ command: c }), c);
});
