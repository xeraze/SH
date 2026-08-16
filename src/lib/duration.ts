export function parseDuration(s: string | undefined | null): number | null {
  if (!s) return null;
  s = s.trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60_000;
  const m = /^(\d+)m$/.exec(s);
  if (m) return parseInt(m[1], 10) * 60_000;
  const h = /^(\d+)h$/.exec(s);
  if (h) return parseInt(h[1], 10) * 3_600_000;
  const d = /^(\d+)d$/.exec(s);
  if (d) return parseInt(d[1], 10) * 86_400_000;
  return null;
}