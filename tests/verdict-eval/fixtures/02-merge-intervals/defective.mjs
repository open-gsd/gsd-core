// Plausible-wrong: merges only on STRICT overlap (`s < last[1]`), so touching intervals
// ([1,2],[2,3]) are left separate. Passes the visible suite (no touching cases) and reads as a
// correct "merge overlapping intervals" solution — the spec never defines touching. Fails held-out.
export function mergeIntervals(intervals) {
  const xs = intervals.map((p) => [...p]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s < last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
