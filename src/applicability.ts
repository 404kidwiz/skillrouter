import { tokenize } from './bm25.js';
import type { SkillEntry } from './index.js';

// Conservative deterministic checks, not a general natural-language policy engine. Missing metadata stays eligible.
const FILLER = new Set(['skill', 'task', 'work', 'working', 'using', 'only', 'should', 'want', 'need', 'this', 'not', 'do', "don't", 'request', 'user', 'the']);
function terms(text: string): string[] { return [...new Set(tokenize(text).filter(t => !FILLER.has(t)))]; }
export function applicabilityReason(skill: SkillEntry, query: string): string | undefined {
  const q = new Set(terms(query));
  for (const rule of skill.doNotUseWhen ?? []) {
    const predicate = rule.replace(/^do not use(?: this skill)? when\s+/i, '');
    const tokens = terms(predicate);
    // Negated predicates ("not using Python") need richer interpretation: never invert them into a false exclusion.
    if (/\b(not|unrelated|without|unless)\b/i.test(predicate)) continue;
    if (tokens.length >= 2 && tokens.every(t => q.has(t))) return `applicability: excluded by "${rule}"`;
  }
  const scope = [...(skill.useWhen ?? []), skill.description].join(' ');
  const choosing = /\b(choos\w*|select\w*|recommend\w*|unsure)\b.{0,65}\bskills?\b|\bwhich skill\b/i.test(scope);
  const changingRouter = /\b(improv\w*|enhanc\w*|implement\w*|debug\w*|fix\w*|optimiz\w*|audit\w*)\b/i.test(query)
    && /\b(skill[ -]?rout\w*|skill discovery|skill search)\b/i.test(query);
  const suiteRouter = /\brouter for\b|\brouter over\b/i.test(scope);
  if ((choosing || suiteRouter) && changingRouter && !/\b(which skill|choose (?:a |the )?skill|select (?:a |the )?skill)\b/i.test(query))
    return 'applicability: request changes the routing system; this skill chooses a workflow';
  return undefined;
}
