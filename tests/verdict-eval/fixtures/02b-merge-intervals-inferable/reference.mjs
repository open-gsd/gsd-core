// Reference: merges correctly AND returns output sorted by start (satisfies stated must_have #2).
export function mergeIntervals(intervals) {
  const xs = intervals.map((p) => [...p]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
