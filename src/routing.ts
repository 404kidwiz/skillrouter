import { search, getIndex, findSkill, type Hit, type SearchTrace } from './search.js';
import { semanticScores } from './embed.js';
import { applicabilityReason } from './applicability.js';
import { coreIds } from './core.js';
import { minRawFor, selectHints, isConversational } from './hint.js';

export interface RouteOptions { k?: number; lexicalOnly?: boolean; exploratory?: boolean }
export interface RouteResult {
  hits: Hit[];
  decisions: { hit: Hit; accepted: boolean; hintAccepted: boolean; reason: string }[];
  trace: SearchTrace[];
  semantic: string;
  semanticError?: string;
  minRaw: number;
  exploratory: boolean;
}
/** Explicit search uses the same evidence floor as hints, without forcing users to accept weak candidates. */
export async function routeSearch(query: string, options: RouteOptions = {}): Promise<RouteResult> {
  const k = Math.max(1, Math.min(20, options.k ?? 5));
  const { index } = getIndex();
  const sem = options.lexicalOnly ? { scores: null, status: 'off', error: undefined } : await semanticScores(query, 800, index.builtAt);
  const trace: SearchTrace[] = [];
  const candidates = await search(query, Math.max(12, k * 3), { semantic: sem.scores, prefer: coreIds(), trace });
  const minRaw = minRawFor(index.skills.length);
  const requested = findSkill(query);
  // Resolve explicit source-qualified IDs before duplicate collapse can hide that source.
  const exact: Hit[] = requested.length === 1 && !applicabilityReason(requested[0], query)
    ? [candidates.find(h => h.skill.id === requested[0].id) ?? { skill: requested[0], score: 0, raw: 0, matched: 0 }]
    : [];
  for (const h of exact) if (!candidates.some(c => c.skill.id === h.skill.id)) candidates.unshift(h);
  const selected = exact.length ? [] : selectHints(candidates, minRaw, k, { conversational: isConversational(query) });
  const relevant = [...exact, ...selected.filter(h => !exact.some(e => e.skill.id === h.skill.id))].slice(0, k);
  const accepted = new Set(relevant.map(h => h.skill.id));
  const defaultHints = selectHints(candidates, minRaw, 3, { conversational: isConversational(query) });
  const gateOptions = { conversational: isConversational(query) };
  const withinMargin = new Set(selectHints(candidates, minRaw, candidates.length, gateOptions).map(h => h.skill.id));
  const decisions = candidates.map(hit => {
    const passesFloor = selectHints([hit], minRaw, 1, gateOptions).length > 0;
    const acceptedHit = accepted.has(hit.skill.id);
    const reason = exact.includes(hit) ? 'exact skill reference' : exact.length ? 'exact reference takes precedence' : !passesFloor ? 'below relevance floor'
      : !withinMargin.has(hit.skill.id) ? 'outside ranking margin' : !acceptedHit ? 'outside result limit'
      : 'passes relevance floor and ranking margin';
    return { hit, accepted: acceptedHit, hintAccepted: defaultHints.includes(hit), reason };
  });
  return { hits: options.exploratory && !exact.length ? [...exact, ...candidates.filter(h => !exact.some(e => e.skill.id === h.skill.id))].slice(0, k) : relevant,
    decisions, trace: trace.filter(t => !exact.some(h => h.skill.id === t.id)), semantic: sem.status, ...(sem.error ? { semanticError: sem.error } : {}), minRaw, exploratory: !!options.exploratory };
}
export function formatSearch(result: RouteResult): string {
  if (!result.hits.length) return 'No strong matching skills. Try a more specific task or exploratory mode for weaker candidates.';
  const lines = result.hits.map(h => {
    const accepted = result.decisions.find(d => d.hit.skill.id === h.skill.id)?.accepted;
    return `- ${h.skill.stableId ?? h.skill.id} (ranking score ${h.score.toFixed(2)}; ${accepted ? 'relevant' : 'weak/exploratory'}): ${h.skill.description || '(no description)'}\n  alias: ${h.skill.id}\n  path: ${h.skill.path}${h.similar?.length ? `\n  [similar: ${h.similar.join(', ')}]` : ''}`;
  });
  return 'Ranking scores are relative, not probabilities.\n' + lines.join('\n') + '\n\nLoad applicable results with read_skill(id).';
}
export function formatExplanation(result: RouteResult): string {
  return [
    `Semantic: ${result.semantic}${result.semanticError ? ` (${result.semanticError})` : ''}; lexical floor: ${result.minRaw}`,
    'Ranking score is relative, not a probability. Search and hint decisions below use default thresholds (no session history or host endorsements).',
    ...result.decisions.map(d => `${d.accepted ? 'PASS' : 'SKIP'} ${d.hit.skill.id}: ${d.reason}; default hint ${d.hintAccepted ? 'pass' : 'skip'}; ranking score ${d.hit.score}, raw ${d.hit.raw}, cosine ${d.hit.cos ?? 'unavailable'}, matched ${d.hit.matched}, specific ${d.hit.specific ?? d.hit.matched}`),
    ...result.trace.map(t => `SKIP ${t.id}: ${t.reason}${t.kept ? ` -> ${t.kept}` : ''}`),
    result.hits.length ? `Returned: ${result.hits.map(h => h.skill.id).join(', ')}` : 'No strong matching skills.',
  ].join('\n');
}
