// Reference: counts/slices by GRAPHEME (user-perceived character), so emoji and combining
// sequences are never split mid-character.
export function truncate(str, max) {
  const s = String(str ?? '');
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const graphemes = [...seg.segment(s)].map((x) => x.segment);
  if (graphemes.length <= max) return s;
  return graphemes.slice(0, max).join('');
}
