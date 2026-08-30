/* Turning numbers into words. No DOM and no state, so tests import it and
   call it directly rather than asserting about its source text. */

// Never print 0% or 100%: the model is a guess, not an oracle.
export const pct = (x) => `${Math.min(99, Math.max(1, Math.round(x * 100)))}%`;
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const ago = (ts) => {
  const h = (Date.now() / 1000 - ts) / 3600;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
export const scoreColor = (s) =>
  s == null ? 'var(--faint)' : s >= 0.5
    ? `color-mix(in srgb, var(--up) ${Math.round((s - 0.5) * 200)}%, var(--faint))`
    : `color-mix(in srgb, var(--down) ${Math.round((0.5 - s) * 200)}%, var(--faint))`;
