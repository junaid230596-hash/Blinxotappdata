// Total experience in whole months, merging overlapping roles so concurrent jobs are not double-counted.
export interface Span { start: string; end?: string | null }

const monthIndex = (iso: string) => { const [y, m] = iso.slice(0, 10).split("-").map(Number); return y * 12 + (m - 1); };

export function experienceMonths(spans: Span[], now: Date = new Date()): number {
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const iv = spans
    .map((s) => [monthIndex(s.start), monthIndex(s.end ?? today)] as [number, number])
    .filter(([a, b]) => b >= a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0; let curStart = -1, curEnd = -1;
  for (const [a, b] of iv) {
    if (curStart < 0) { curStart = a; curEnd = b; continue; }
    if (a <= curEnd) curEnd = Math.max(curEnd, b);
    else { total += curEnd - curStart; curStart = a; curEnd = b; }
  }
  if (curStart >= 0) total += curEnd - curStart;
  return total;
}
