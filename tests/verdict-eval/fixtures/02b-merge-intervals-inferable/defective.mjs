// INFERABLE defect: never sorts output by start, violating the STATED must_have #2. The rule is
// written in the spec, so this is inferable — correct verdict is gaps_found (catch), and abstaining
// is an OVER-abstention error. Passes the visible suite (those inputs are already start-ordered).
export function mergeIntervals(intervals) {
  const out = [];
  for (const [s, e] of intervals.map((p) => [...p])) {
    const hit = out.find((o) => s <= o[1] && e >= o[0]);
    if (hit) {
      hit[0] = Math.min(hit[0], s);
      hit[1] = Math.max(hit[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out; // BUG: not sorted by start — mergeIntervals([[5,6],[1,2]]) -> [[5,6],[1,2]]
}
