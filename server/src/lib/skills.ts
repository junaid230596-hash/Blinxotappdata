// Trims, drops blanks, and de-duplicates case-insensitively, keeping the FIRST spelling the user typed.
export function cleanSkills(list?: string[], max = 30): string[] {
  const seen = new Map<string, string>();
  for (const raw of list ?? []) {
    const s = raw.trim();
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  }
  return [...seen.values()].slice(0, max);
}
