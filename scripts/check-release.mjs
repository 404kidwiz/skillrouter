// Keep the npm artifact and Claude marketplace release on the same version and dependency contract.
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const lock = read("npm-shrinkwrap.json");
assert.equal(read(".claude-plugin/plugin.json").version, pkg.version, "plugin version differs from package");
assert.equal(read(".claude-plugin/marketplace.json").plugins.find((p) => p.name === pkg.name)?.version, pkg.version, "marketplace version differs from package");
assert.equal(lock.version, pkg.version, "shrinkwrap version differs from package");
assert.equal(lock.packages[""].version, pkg.version, "shrinkwrap root version differs from package");
assert.ok([2, 3].includes(lock.lockfileVersion), "Claude requires npm lockfile version 2 or 3");
for (const key of ["dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta"]) {
  assert.deepEqual(lock.packages[""][key] ?? {}, pkg[key] ?? {}, `shrinkwrap ${key} differs; regenerate in an isolated directory`);
}
for (const [name, entry] of Object.entries(lock.packages)) {
  if (!name) continue;
  assert.ok(!entry.link, `linked dependency cannot ship: ${name}`);
  assert.ok(entry.version && entry.integrity && entry.resolved?.startsWith("https://"), `dependency must have a pinned HTTPS archive and integrity: ${name}`);
}
for (const file of ["eval/prompts.jsonl", "eval/skills/python-testing/SKILL.md", "LICENSE"]) {
  assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), `release input missing: ${file}`);
}
console.log(`Release metadata and dependency lock: PASS (${pkg.version})`);
