import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndexFrom, resolveSkillReference } from "../src/index.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const add = (dir: string, extra = "", body = "body") => {
    const location = path.join(root, dir);
    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(path.join(location, "SKILL.md"), `---\nname: shared\ndescription: Example\n${extra}---\n${body}`);
    return fs.realpathSync(location);
  };
  return { root, add };
}

test("canonical identity survives root reorder and same-name insertion", t => {
  const { add } = fixture(t);
  const a = add("a"), b = add("b");
  const first = buildIndexFrom([a, b]);
  const reordered = buildIndexFrom([b, a]);
  for (const skill of first.skills) assert.equal(reordered.skills.find(s => s.path === skill.path)?.stableId, skill.stableId);
  const c = add("c");
  const rebuilt = buildIndexFrom([c, b, a], first);
  for (const skill of first.skills) assert.equal(resolveSkillReference(rebuilt, skill.id)?.path, skill.path);
  assert.equal(rebuilt.skills.find(s => s.path === c)?.id, "shared~3");
});

test("removed aliases remain tombstones rather than resolving to a new skill", t => {
  const { add } = fixture(t);
  const a = add("a"), b = add("b");
  const first = buildIndexFrom([a, b]);
  const rebuilt = buildIndexFrom([b], first);
  assert.equal(resolveSkillReference(rebuilt, "shared"), undefined);
  assert.equal(resolveSkillReference(rebuilt, "shared~2")?.path, b);
  const c = add("c");
  const next = buildIndexFrom([c, b], rebuilt);
  assert.equal(next.skills.find(s => s.path === c)?.id, "shared~3");
  assert.equal(resolveSkillReference(next, "shared"), undefined);
});

test("legacy indexes acquire stable identities and keep old aliases", t => {
  const { add } = fixture(t);
  const a = add("a"), b = add("b");
  const previous = buildIndexFrom([b, a]);
  delete previous.identityAliases;
  previous.skills.forEach(s => { delete s.stableId; delete s.aliases; delete s.provenance; });
  const rebuilt = buildIndexFrom([a, b], previous);
  assert.equal(resolveSkillReference(rebuilt, "shared")?.path, b);
  assert.equal(resolveSkillReference(rebuilt, "shared~2")?.path, a);
});

test("complete content hash changes while identity and version provenance remain usable", t => {
  const { add } = fixture(t);
  const a = add("a", "source: publisher/repo\nversion: 1.0\nmaintained_priority: 10\n", "x".repeat(7000));
  const first = buildIndexFrom([a]);
  const file = path.join(a, "SKILL.md");
  fs.appendFileSync(file, "changed beyond the old truncation boundary");
  const next = buildIndexFrom([a], first);
  assert.equal(next.skills[0].stableId, first.skills[0].stableId);
  assert.notEqual(next.skills[0].provenance?.contentHash, first.skills[0].provenance?.contentHash);
  assert.equal(next.skills[0].provenance?.version, "1.0");
  assert.equal(next.skills[0].provenance?.source, "publisher/repo");
  assert.equal(next.skills[0].provenance?.maintainedPriority, 10);
});

test("applicability supports structured metadata, sections and explicit sentences", t => {
  const { add } = fixture(t);
  const a = add("a", 'use_when:\n  - Building an index\n  - Updating a router\ndoNotUseWhen: ["Selecting a skill"]\n', '# Use when\n- Improving retrieval\n# Do not use when\n- Browsing skills\n# Notes\nUse this skill when comparing routes. Do not use when writing prose.');
  const skill = buildIndexFrom([a]).skills[0];
  assert.ok(skill.useWhen?.includes("Building an index"));
  assert.ok(skill.useWhen?.includes("Updating a router"));
  assert.ok(skill.useWhen?.includes("Improving retrieval"));
  assert.ok(skill.doNotUseWhen?.includes("Selecting a skill"));
  assert.ok(skill.doNotUseWhen?.includes("Browsing skills"));
  assert.ok(skill.doNotUseWhen?.includes("Do not use when writing prose."));
  assert.ok(!skill.useWhen?.some(value => value.includes("writing prose")));
});

test("case-insensitive aliases retain owners through removal and legacy migration", t => {
  const { add } = fixture(t);
  const a = add("a"), b = add("b");
  fs.writeFileSync(path.join(a, "SKILL.md"), "---\nname: Skill\n---\nbody");
  fs.writeFileSync(path.join(b, "SKILL.md"), "---\nname: skill\n---\nbody");
  const first = buildIndexFrom([a, b]);
  assert.equal(first.skills[1].id, "skill~2");
  assert.equal(resolveSkillReference(first, "SKILL")?.path, a);
  const removed = buildIndexFrom([b], first);
  assert.equal(resolveSkillReference(removed, "skill"), undefined);
  assert.equal(resolveSkillReference(removed, "SKILL~2")?.path, b);
  first.skills[1].id = "skill";
  first.identityAliases = { Skill: first.skills[0].stableId!, skill: first.skills[1].stableId! };
  const migrated = buildIndexFrom([b, a], first);
  assert.equal(resolveSkillReference(migrated, "skill")?.path, a);
  assert.equal(resolveSkillReference(migrated, "skill~2")?.path, b);
});
