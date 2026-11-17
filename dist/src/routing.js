import { search, getIndex, findSkill } from './search.js';
import { semanticScores } from './embed.js';
import { applicabilityReason } from './applicability.js';
import { coreIds } from './core.js';
import { minRawFor, selectHints, isConversational } from './hint.js';
/**
 * The weak tier of an explicit search. A hint is unsolicited and costs context on every prompt, so it needs a confident
 * match; a search is the agent asking, and "nothing" there ends the lookup (measured 2026-11-15 on this machine's log:
 * 62% of Codex searches came back empty once the hint bar was applied to them, and 3% were retried in exploratory mode).
 * So when nothing clears the hint bar, the best candidates that still show real evidence are returned, labeled weak:
 * meaning 0.42 with a matched word, or meaning 0.33 with two matched words at 75% of the lexical floor; without the
 * semantic layer, two matched words at 75% of the floor. At most 3, within 75% of the best one's ranking score.
 * Replayed on 319 distinct real queries that had returned nothing: 75% now get candidates. SKILLROUTER_WEAK=0 turns it off.
 */
export function selectWeak(hits, minRaw, k = 3) {
    if (process.env.SKILLROUTER_WEAK === "0")
        return [];
    const floor = 0.75 * minRaw;
    const passing = hits.filter((h) => (h.skill.description ?? "").trim().length >= 20 && (h.cos !== undefined
        ? (h.cos >= 0.42 && h.matched >= 1) || (h.cos >= 0.33 && h.matched >= 2 && h.raw >= floor)
        : h.matched >= 2 && h.raw >= floor)).sort((a, b) => b.score - a.score);
    const top = passing[0]?.score ?? 0;
    return passing.filter((h) => h.score >= 0.75 * top).slice(0, Math.max(1, Math.min(3, k)));
}
/**
 * The one skill a query names. The whole query as an id or name, as before; or else a hyphenated name inside a longer
 * query ("skill-library-ops upstream provenance comparison" asks for skill-library-ops). Only hyphenated names count
 * there: a plain word that happens to be a skill's name ("invoice", "github") is a topic, not a request for that skill.
 * Labeled on 240 real searches, 2026-11-17: a query naming a skill this way got three other skills back.
 */
export function namedSkill(query) {
    const whole = findSkill(query);
    if (whole.length === 1)
        return whole;
    const named = new Map();
    for (const token of query.toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)+(?:~\d+)?/g) ?? []) {
        const found = findSkill(token);
        if (found.length === 1)
            named.set(found[0].id, found[0]);
    }
    return named.size === 1 ? [...named.values()] : whole;
}
/** Explicit search uses the same evidence floor as hints, without forcing users to accept weak candidates. */
export async function routeSearch(query, options = {}) {
    const k = Math.max(1, Math.min(20, options.k ?? 5));
    const { index } = getIndex();
    const sem = options.lexicalOnly ? { scores: null, status: 'off', error: undefined } : await semanticScores(query, 800, index.builtAt);
    const trace = [];
    const candidates = await search(query, Math.max(12, k * 3), { semantic: sem.scores, prefer: coreIds(), trace });
    const minRaw = minRawFor(index.skills.length);
    const requested = namedSkill(query);
    // Resolve explicit source-qualified IDs before duplicate collapse can hide that source.
    const exact = requested.length === 1 && !applicabilityReason(requested[0], query)
        ? [candidates.find(h => h.skill.id === requested[0].id) ?? { skill: requested[0], score: 0, raw: 0, matched: 0 }]
        : [];
    for (const h of exact)
        if (!candidates.some(c => c.skill.id === h.skill.id))
            candidates.unshift(h);
    const selected = exact.length ? [] : selectHints(candidates, minRaw, k, { conversational: isConversational(query) });
    const relevant = [...exact, ...selected.filter(h => !exact.some(e => e.skill.id === h.skill.id))].slice(0, k);
    const accepted = new Set(relevant.map(h => h.skill.id));
    const weakHits = relevant.length || options.exploratory ? [] : selectWeak(candidates, minRaw, k);
    const defaultHints = selectHints(candidates, minRaw, 3, { conversational: isConversational(query) });
    const gateOptions = { conversational: isConversational(query) };
    const withinMargin = new Set(selectHints(candidates, minRaw, candidates.length, gateOptions).map(h => h.skill.id));
    const decisions = candidates.map(hit => {
        const passesFloor = selectHints([hit], minRaw, 1, gateOptions).length > 0;
        const acceptedHit = accepted.has(hit.skill.id);
        const weakHit = weakHits.some(w => w.skill.id === hit.skill.id);
        const reason = weakHit ? 'no strong match; returned as a weak candidate' : exact.includes(hit) ? 'exact skill reference' : exact.length ? 'exact reference takes precedence' : !passesFloor ? 'below relevance floor'
            : !withinMargin.has(hit.skill.id) ? 'outside ranking margin' : !acceptedHit ? 'outside result limit'
                : 'passes relevance floor and ranking margin';
        return { hit, accepted: acceptedHit, hintAccepted: defaultHints.includes(hit), reason };
    });
    return { hits: options.exploratory && !exact.length ? [...exact, ...candidates.filter(h => !exact.some(e => e.skill.id === h.skill.id))].slice(0, k) : relevant.length ? relevant : weakHits,
        decisions, trace: trace.filter(t => !exact.some(h => h.skill.id === t.id)), semantic: sem.status, ...(sem.error ? { semanticError: sem.error } : {}), minRaw, exploratory: !!options.exploratory, weak: weakHits.length > 0 };
}
export function formatSearch(result) {
    if (!result.hits.length)
        return 'No matching skills for this query. Rephrase with the concrete tool, framework or deliverable, or continue without a skill.';
    const lines = result.hits.map(h => {
        const accepted = result.decisions.find(d => d.hit.skill.id === h.skill.id)?.accepted;
        return `- ${h.skill.stableId ?? h.skill.id} (ranking score ${h.score.toFixed(2)}; ${accepted ? 'relevant' : result.weak ? 'weak' : 'weak/exploratory'}): ${h.skill.description || '(no description)'}\n  alias: ${h.skill.id}\n  path: ${h.skill.path}${h.similar?.length ? `\n  [similar: ${h.similar.join(', ')}]` : ''}`;
    });
    if (result.weak)
        return 'No strong match. Weak candidates follow: load one with read_skill(id) only if its description fits this task; otherwise continue without a skill.\n' + lines.join('\n');
    return 'Ranking scores are relative, not probabilities.\n' + lines.join('\n') + '\n\nLoad applicable results with read_skill(id).';
}
export function formatExplanation(result) {
    return [
        `Semantic: ${result.semantic}${result.semanticError ? ` (${result.semanticError})` : ''}; lexical floor: ${result.minRaw}`,
        'Ranking score is relative, not a probability. Search and hint decisions below use default thresholds (no session history or host endorsements).',
        ...result.decisions.map(d => `${d.accepted ? 'PASS' : result.weak && result.hits.some(h => h.skill.id === d.hit.skill.id) ? 'WEAK' : 'SKIP'} ${d.hit.skill.id}: ${d.reason}; default hint ${d.hintAccepted ? 'pass' : 'skip'}; ranking score ${d.hit.score}, raw ${d.hit.raw}, cosine ${d.hit.cos ?? 'unavailable'}, matched ${d.hit.matched}, specific ${d.hit.specific ?? d.hit.matched}`),
        ...result.trace.map(t => `SKIP ${t.id}: ${t.reason}${t.kept ? ` -> ${t.kept}` : ''}`),
        result.hits.length ? `Returned${result.weak ? ' (weak tier, no strong match)' : ''}: ${result.hits.map(h => h.skill.id).join(', ')}` : 'No matching skills.',
    ].join('\n');
}
