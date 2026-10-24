// Small BM25 over tokenized text. Enough for a few thousand short skill descriptions;
// no model download, loads in milliseconds, so prompt hooks can call it directly.
const STOP = new Set("a an the and or of to in for on with by is are be this that it as at from your you use when into".split(" "));
export function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9+#.\s_-]/g, " ")
        .split(/[\s_\-./]+/)
        .filter((t) => t.length > 1 && !STOP.has(t))
        .map(stem);
}
/** Folds the common plural so "builds" meets "build" and "tests" meets "test"; nothing cleverer. */
export function stem(t) {
    if (t.length > 4 && t.endsWith("ies"))
        return t.slice(0, -3) + "y";
    if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us") && !t.endsWith("is"))
        return t.slice(0, -1);
    return t;
}
// Query-side synonyms: a prompt's word reaches skills described with its neighbours. Small on purpose.
export const SYNONYMS = {
    docker: ["container", "containers", "dockerfile"], container: ["docker"], k8s: ["kubernetes"], kubernetes: ["k8s"],
    pytest: ["python", "test", "testing"], jest: ["javascript", "test", "testing"], vitest: ["test", "testing"],
    test: ["testing", "tests"], tests: ["testing", "test"], testing: ["test", "tests"],
    postgres: ["postgresql", "sql", "database"], postgresql: ["postgres", "sql"], pg: ["postgres", "postgresql"], db: ["database"], database: ["db"],
    js: ["javascript"], javascript: ["js"], ts: ["typescript"], typescript: ["ts"], py: ["python"],
    migration: ["migrate", "migrations"], migrate: ["migration"], auth: ["authentication", "login"], login: ["auth", "authentication"],
    perf: ["performance"], slow: ["performance", "optimize"], fast: ["performance"], a11y: ["accessibility"], accessibility: ["a11y"],
    cro: ["conversion"], conversion: ["cro"], m1: ["apple", "silicon", "arm"], mac: ["macos"], macos: ["mac"],
    ui: ["frontend", "interface"], frontend: ["ui"], api: ["endpoint", "rest"], bug: ["debug", "fix"], fix: ["debug"], debug: ["debugging"],
    deploy: ["deployment"], deployment: ["deploy"], ci: ["pipeline"], repo: ["repository", "git"], pr: ["pull", "request", "review"],
};
// Both sides stemmed once, so the table meets stemmed query and doc tokens ("kubernetes" is "kubernete" in both).
const STEMMED_SYNONYMS = new Map(Object.entries(SYNONYMS).map(([k, v]) => [stem(k), v.map(stem)]));
/** Query tokens plus their synonyms (synonyms never add a token the query already has). */
export function expand(tokens) {
    const out = new Set(tokens);
    for (const t of tokens)
        for (const s of STEMMED_SYNONYMS.get(t) ?? [])
            out.add(s);
    return [...out];
}
/** Bump when `tokenize` changes; an index built by an older one is re-stemmed at load. */
export const TOKENIZER_VERSION = 2;
/** Document-frequency share under which a term counts as specific (calibrated on a 4,500-skill library, 2026-10-24). */
export const SPECIFIC_DF = 0.02;
export class BM25 {
    k1;
    b;
    df = new Map();
    avgLen = 0;
    docs = [];
    constructor(docs, k1 = 1.2, b = 0.75) {
        this.k1 = k1;
        this.b = b;
        for (const d of docs) {
            const tf = new Map();
            for (const t of d.tokens)
                tf.set(t, (tf.get(t) ?? 0) + 1);
            for (const t of tf.keys())
                this.df.set(t, (this.df.get(t) ?? 0) + 1);
            this.docs.push({ id: d.id, tf, len: d.tokens.length, name: new Set(d.name ?? []) });
        }
        this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
    }
    /**
     * A term in under 2% of the library names a topic; "test", "fix", "skill" or "review" are in far more and name nothing.
     * In a small library a term in one or two skills (a skill and its copy) is specific whatever share that is.
     */
    isSpecific(term) { const df = this.df.get(term) ?? 0; return df <= 2 || df / Math.max(1, this.docs.length) < SPECIFIC_DF; }
    /**
     * score = relative to the best hit (0..1); raw = BM25 sum; matched = distinct query terms found in the doc;
     * specific = how many of those are rare in the library (see isSpecific): the words that make a match mean something.
     */
    search(query, k = 5) {
        const original = [...new Set(tokenize(query))];
        const q = expand(original);
        const n = this.docs.length;
        const out = [];
        for (const d of this.docs) {
            let s = 0, matched = 0, inName = 0, specific = 0;
            for (const t of q) {
                const f = d.tf.get(t);
                if (!f)
                    continue;
                if (original.includes(t)) {
                    matched++;
                    if (this.isSpecific(t))
                        specific++;
                } // synonyms score but don't count as a match the prompt made itself
                const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
                // A synonym is a weaker signal than the prompt's own word.
                s += (original.includes(t) ? 1 : 0.6) * idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
                if (original.includes(t) && d.name.has(t))
                    inName++; // the prompt's own words only
            }
            // A skill whose name carries the prompt's words is what the prompt is asking for: +25% per word, up to +75%.
            if (inName)
                s *= 1 + 0.25 * Math.min(inName, 3);
            if (s > 0)
                out.push({ id: d.id, score: s, matched, specific });
        }
        out.sort((a, b) => b.score - a.score);
        // Normalize to 0..1 against the best hit so thresholds mean the same thing across queries.
        const top = out[0]?.score ?? 1;
        return out.slice(0, k).map((h) => ({ id: h.id, score: h.score / top, raw: h.score, matched: h.matched, specific: h.specific }));
    }
}
