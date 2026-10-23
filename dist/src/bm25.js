// Small BM25 over tokenized text. Enough for a few thousand short skill descriptions;
// no model download, loads in milliseconds, so prompt hooks can call it directly.
const STOP = new Set("a an the and or of to in for on with by is are be this that it as at from your you use when into".split(" "));
export function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9+#.\s_-]/g, " ")
        .split(/[\s_\-./]+/)
        .filter((t) => t.length > 1 && !STOP.has(t));
}
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
            this.docs.push({ id: d.id, tf, len: d.tokens.length });
        }
        this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
    }
    /** score = relative to the best hit (0..1); raw = BM25 sum; matched = distinct query terms found in the doc. */
    search(query, k = 5) {
        const q = [...new Set(tokenize(query))];
        const n = this.docs.length;
        const out = [];
        for (const d of this.docs) {
            let s = 0, matched = 0;
            for (const t of q) {
                const f = d.tf.get(t);
                if (!f)
                    continue;
                matched++;
                const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
                s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
            }
            if (s > 0)
                out.push({ id: d.id, score: s, matched });
        }
        out.sort((a, b) => b.score - a.score);
        // Normalize to 0..1 against the best hit so thresholds mean the same thing across queries.
        const top = out[0]?.score ?? 1;
        return out.slice(0, k).map((h) => ({ id: h.id, score: h.score / top, raw: h.score, matched: h.matched }));
    }
}
