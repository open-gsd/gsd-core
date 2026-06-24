# Task 02b — `mergeIntervals(intervals)` (INFERABLE control)

Same contract as task 02. This is the INFERABLE control used to measure OVER-abstention.

## must_haves
(identical to task 02 — including must_have #2: output is **sorted by start**)

> INFERABLE defect (corpus documentation): the planted defect violates the STATED must_have #2
> (sorted by start). It is fully determined by the spec — a competent critic should CATCH it
> (gaps_found), and abstaining (insufficient_spec) here is an OVER-abstention error. This fixture
> is the precision guard: a flag-everything / always-abstain critic fails on it.
