// Plausible-wrong: slices by UTF-16 code unit (`.length` / `.slice`). Passes the visible suite
// (ASCII only) and is the obvious, idiomatic implementation of "first max characters" — the spec
// never says "grapheme". Splits surrogate pairs / ZWJ emoji sequences. Fails held-out.
export function truncate(str, max) {
  const s = String(str ?? '');
  return s.length <= max ? s : s.slice(0, max);
}
