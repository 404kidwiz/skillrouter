import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skillrouter-quality-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, '.skillrouter');
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const { buildIndexFrom, saveIndex } = await import('../src/index.js');
const { resetIndexCache } = await import('../src/search.js');
const root = path.join(home, 'skills');
function fixture(name, description, body = '') {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
}
fixture('skill-router', 'Choose the best skill from the installed library. Use when unsure which skill to use.', '## Use this skill when\n- Choosing a skill for a task\n## Do not use this skill when\n- Improving the skill router implementation');
fixture('python-testing', 'Write Python pytest tests with fixtures and mocks for regression coverage.');
fixture('python-copy', 'Write Python pytest tests with fixtures and mocks for regression coverage.');
fixture('deploy-release', 'Deploy production releases and run deployment checks.', '## Do not use this skill when\n- Reviewing deployment architecture');
for (let i = 0; i < 80; i++)
    fixture(`filler-${i}`, `Pottery kiln glaze clay wheel hobby ${i}`);
saveIndex(buildIndexFrom([root]));
resetIndexCache();
const { routeSearch, formatExplanation } = await import('../src/routing.js');
test('explicit search abstains on weak matches and exploratory mode labels them', async () => {
    const result = await routeSearch('library', { lexicalOnly: true });
    assert.equal(result.hits.length, 0);
    const exploratory = await routeSearch('library', { lexicalOnly: true, exploratory: true });
    assert.ok(exploratory.hits.length > 0);
    assert.ok(exploratory.decisions.every(d => !d.accepted));
});
test('router implementation request does not recommend the choosing-skills workflow', async () => {
    const result = await routeSearch('improve the skill router implementation', { lexicalOnly: true });
    assert.ok(!result.hits.some(h => h.skill.name === 'skill-router'));
    assert.ok(result.trace.some(t => t.reason.includes('applicability')));
    const choosing = await routeSearch('choose the best skill for a task', { lexicalOnly: true });
    assert.ok(choosing.hits.some(h => h.skill.name === 'skill-router'));
});
test('explicit negative applicability excludes a matching topic', async () => {
    const result = await routeSearch('reviewing deployment architecture', { lexicalOnly: true });
    assert.ok(!result.hits.some(h => h.skill.name === 'deploy-release'));
});
test('explain exposes real semantic mode, ranking units and duplicate decisions', async () => {
    const result = await routeSearch('write python pytest regression tests', { lexicalOnly: true });
    assert.ok(result.hits.some(h => h.skill.name === 'python-testing' || h.skill.name === 'python-copy'));
    const output = formatExplanation(result);
    assert.match(output, /Semantic: off/);
    assert.match(output, /ranking score.*not a probability/i);
    assert.match(output, /duplicate/);
});
test('equivalent copies get consistent evaluation precision and recall', async () => {
    const { evaluate } = await import('../src/eval.js');
    const result = await evaluate([{ prompt: 'write python pytest regression tests with fixtures', expect: ['python-testing'] }], { lexicalOnly: true });
    assert.equal(result.summary.hintRecall, 1);
    assert.equal(result.summary.hintPrecision, 1);
});
test('stale vectors fall back honestly and keep relevant lexical results', async () => {
    const { saveVectors, resetVectors } = await import('../src/embed.js');
    const { getIndex } = await import('../src/search.js');
    const index = getIndex().index;
    saveVectors(index.skills.map(s => s.id), index.skills.map(() => [1, 0]), 'outdated-index');
    resetVectors();
    const result = await routeSearch('write python pytest regression tests');
    assert.equal(result.semantic, 'stale');
    assert.ok(result.hits.length > 0);
});
test('canonical references load the same skill and core selection survives reindex', async () => {
    const { findSkill, getIndex } = await import('../src/search.js');
    const { coreIds } = await import('../src/core.js');
    const skill = getIndex().index.skills.find(s => s.name === 'python-testing');
    assert.equal(findSkill(skill.stableId)[0].path, skill.path);
    assert.ok(coreIds([skill.stableId]).has(skill.id));
    const { evaluate } = await import('../src/eval.js');
    const result = await evaluate([{ prompt: 'write python pytest regression tests', expect: [skill.stableId] }], { lexicalOnly: true });
    assert.deepEqual(result.unknownIds, []);
    assert.equal(result.summary.hintPrecision, 1);
});
test('explicit maintenance priority chooses the maintained copy', async () => {
    const file = path.join(root, 'python-testing', 'SKILL.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('description:', 'maintained_priority: 10\ndescription:'));
    saveIndex(buildIndexFrom([root]));
    resetIndexCache();
    const result = await routeSearch('write python pytest regression tests', { lexicalOnly: true });
    assert.equal(result.hits[0].skill.name, 'python-testing');
    assert.ok(!result.trace.some(t => t.id === 'python-testing' && t.reason.includes('duplicate')));
    assert.ok(result.trace.some(t => t.id === 'python-copy' && t.kept === 'python-testing'));
});
test('MCP search abstention, exploratory labels and canonical loading work over stdio', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { fileURLToPath } = await import('node:url');
    const client = new Client({ name: 'routing-quality-smoke', version: '1' });
    const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] !== undefined));
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'mcp'], env });
    try {
        await client.connect(transport);
        const text = (r) => r.content.map((c) => c.text ?? '').join('\n');
        assert.match(text(await client.callTool({ name: 'search_skills', arguments: { query: 'library' } })), /No strong matching skills/);
        assert.match(text(await client.callTool({ name: 'search_skills', arguments: { query: 'library', exploratory: true } })), /weak\/exploratory/);
        const found = text(await client.callTool({ name: 'search_skills', arguments: { query: 'write python pytest regression tests' } }));
        assert.match(found, /ranking score/);
        const id = found.match(/^- (\S+)/m)[1];
        assert.match(id, /@[a-f0-9]{24}$/);
        const body = text(await client.callTool({ name: 'read_skill', arguments: { id } }));
        assert.match(body, /Write Python pytest tests/);
    }
    finally {
        await client.close();
        await transport.close();
    }
});
test('an exact canonical reference selects the requested copy even when another is preferred', async () => {
    const { getIndex } = await import('../src/search.js');
    const skill = getIndex().index.skills.find(s => s.name === 'python-copy');
    const result = await routeSearch(skill.stableId, { lexicalOnly: true, k: 5 });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].skill.id, skill.id);
    assert.match(result.decisions.find(d => d.hit.skill.id === skill.id).reason, /exact skill reference/);
});
test('sentence-form exclusions strip directive negation but preserve predicate negation', async () => {
    const { applicabilityReason } = await import('../src/applicability.js');
    const skill = buildIndexFrom([root]).skills[0];
    assert.match(applicabilityReason({ ...skill, doNotUseWhen: ['Do not use when writing prose.'] }, 'writing prose') ?? '', /excluded/);
    assert.equal(applicabilityReason({ ...skill, doNotUseWhen: ['Do not use this skill when not using Python.'] }, 'using Python'), undefined);
});
test('explanation acceptance matches returned results and default hints ignore search limit', async () => {
    const query = 'write python pytest regression tests';
    const one = await routeSearch(query, { lexicalOnly: true, k: 1 });
    const five = await routeSearch(query, { lexicalOnly: true, k: 5 });
    assert.deepEqual(one.decisions.filter(d => d.accepted).map(d => d.hit.skill.id), one.hits.map(h => h.skill.id));
    assert.deepEqual(one.decisions.filter(d => d.hintAccepted).map(d => d.hit.skill.id), five.decisions.filter(d => d.hintAccepted).map(d => d.hit.skill.id));
    assert.ok(five.decisions.filter(d => d.hintAccepted).length <= 3);
});
test('getIndex, loadVectors, embedSkills, tombstoned eval aliases, and conversational filters', async () => {
    const { getIndex } = await import('../src/search.js');
    const { embedSkills, loadVectors, saveVectors, skillText, textHash } = await import('../src/embed.js');
    const { evaluate } = await import('../src/eval.js');
    const { isConversational } = await import('../src/hint.js');
    // 1. Auto-reload index & vectors on disk write without manual resetIndexCache/resetVectors
    const before = getIndex().index;
    const updated = { ...before, builtAt: new Date(Date.now() + 5000).toISOString() };
    saveIndex(updated);
    assert.equal(getIndex().index.builtAt, updated.builtAt);
    const hashes = updated.skills.map(s => textHash(skillText(s)));
    saveVectors(updated.skills.map(s => s.id), updated.skills.map(() => [1, 0]), updated.builtAt, hashes);
    assert.equal(loadVectors()?.indexBuiltAt, updated.builtAt);
    // 2. embedSkills reuses 100% of vectors when skill text hashes match (never invokes local model)
    const cachedEmb = await embedSkills(updated.skills, undefined, false);
    assert.equal(cachedEmb.reused, updated.skills.length);
    assert.deepEqual(cachedEmb.rows[0], [1, 0]);
    // 3. evaluate resolves bare expected id when canonical alias is a tombstone and ~N variant is active
    const withTombstone = {
        ...updated,
        identityAliases: { ...(updated.identityAliases ?? {}), 'python-testing': 'python-testing@retired000000000000000000' },
        skills: updated.skills.map(s => s.id === 'python-testing' ? { ...s, id: 'python-testing~2', aliases: ['python-testing~2'] } : s),
    };
    saveIndex(withTombstone);
    const evalRes = await evaluate([{ prompt: 'write python pytest regression tests with fixtures', expect: ['python-testing'] }], { lexicalOnly: true });
    assert.deepEqual(evalRes.unknownIds, []);
    assert.equal(evalRes.summary.top1, 1);
    saveIndex(before);
    // 4. Conversational/handoff/meta filter catches non-task turns and leaves concrete tasks false
    assert.equal(isConversational('Give me a short iMessage for TJ with the acceptance matrix link'), true);
    assert.equal(isConversational('Coordination update: the parent has assigned independent reviewer 682'), true);
    assert.equal(isConversational('Can we make sure that we use the skill router from now on'), true);
    assert.equal(isConversational('write python pytest regression tests with fixtures'), false);
});
