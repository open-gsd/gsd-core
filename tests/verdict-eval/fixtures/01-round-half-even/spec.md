# Task 01 — `roundTo(value, dp = 0)`

Round a number to a fixed number of decimal places.

## must_haves
1. Export a named function `roundTo(value, dp = 0)` returning a `number`.
2. Round `value` to `dp` decimal places (e.g. `dp = 2` keeps cents).
3. For a value strictly closer to one side, round to the nearer representable value
   (`1.234 → 1.23`, `1.236 → 1.24`).
4. `dp` defaults to `0` (round to an integer).

> NON-INFERABLE EDGE (corpus documentation — STRIP before showing a critic): the spec
> intentionally does NOT state how exact halves (`x.5`) resolve. That tie-breaking rule is the
> omitted edge. Slice: domain-knowledge (banker's/half-even is a known convention a capable model
> can surface when prompted to disconfirm).

## visible test cases (the executor ran these)
- `roundTo(1.234, 2) === 1.23`
- `roundTo(1.236, 2) === 1.24`
- `roundTo(2.4) === 2`
- `roundTo(2.6) === 3`
