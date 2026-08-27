// Payee name similarity for merge suggestions. Pure, no I/O.

export interface PayeeLike {
  id: string;
  name: string;
  transferAccountId?: string | null;
}

export interface SimilarPair {
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  distance: number;
  similarity: number; // 0..1, higher = closer
}

// Classic Levenshtein over code points (Unicode-safe).
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1).fill(0);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Normalized key for comparison: trim, lowercase, collapse whitespace,
// strip trailing merchant ids and city-ish suffixes. Deliberately conservative
// — a missed pair is better than a wrong merge suggestion.
export function normalizePayeeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\d+\s*$/g, '')
    .replace(/(^|\s)(gmbh|s\.r\.l\.?|srl|inc\.?|ltd\.?|e\.v\.?|ag|spa|snc|sas|s\.c\.|sc)$/i, '')
    .trim();
}

// Suggest merge pairs: same length-ish names within a distance threshold, or
// one name fully contained in the other when both are long enough. Excludes
// transfer payees and identical names. Each payee appears at most once as a
// source (best target wins).
export function findSimilarPayees(payees: PayeeLike[], maxResults = 20): SimilarPair[] {
  const rows = payees
    .filter((p) => !p.transferAccountId)
    .map((p) => ({ ...p, key: normalizePayeeName(p.name) }))
    .filter((p) => p.key.length > 0);

  const scored: SimilarPair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const maxLen = Math.max(a.key.length, b.key.length);
      const dist = levenshtein(a.key, b.key);
      let similarity = 1 - dist / maxLen;
      // containment: "LIDL" vs "LIDL SAGT DANKE" is a strong merge signal —
      // it may exceed the plain distance budget, so check it first
      if (a.key.length >= 6 && a.key.includes(b.key)) similarity = Math.max(similarity, 0.85);
      if (b.key.length >= 6 && b.key.includes(a.key)) similarity = Math.max(similarity, 0.85);
      if (similarity < 0.65 || (dist > 3 && similarity < 0.85)) continue;
      scored.push({
        fromId: a.id,
        toId: b.id,
        fromName: a.name,
        toName: b.name,
        distance: dist,
        similarity,
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity || a.fromName.localeCompare(b.fromName));

  // each payee can be a source only once (best target wins)
  const used = new Set<string>();
  const out: SimilarPair[] = [];
  for (const s of scored) {
    if (used.has(s.fromId)) continue;
    used.add(s.fromId);
    out.push(s);
    if (out.length >= maxResults) break;
  }
  return out;
}
