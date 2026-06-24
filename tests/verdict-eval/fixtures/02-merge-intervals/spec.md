# Task 02 — `mergeIntervals(intervals)`

Merge a list of numeric intervals.

## must_haves
1. Export a named function `mergeIntervals(intervals)` taking an array of `[start, end]` pairs.
2. Return a new array of merged `[start, end]` pairs, **sorted by start**.
3. **Overlapping intervals are merged** into one spanning pair.
4. Non-overlapping intervals are returned separately.
5. Do not mutate the input.

> NON-INFERABLE EDGE (corpus documentation — STRIP before showing a critic): the spec
> intentionally does NOT say whether intervals that merely *touch* at an endpoint (`[1,2]` and
> `[2,3]`) count as overlapping. Slice: truly-spec-silent (a free definitional choice — closed vs
> half-open intervals — with no right answer absent the spec; only an external hint resolves it).

## visible test cases (the executor ran these)
- `mergeIntervals([[1,3],[2,6]])` → `[[1,6]]`
- `mergeIntervals([[1,2],[5,6]])` → `[[1,2],[5,6]]`
- `mergeIntervals([[1,4],[2,3]])` → `[[1,4]]`
