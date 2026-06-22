# Verdict Self-Check (disconfirmation of your OWN conclusion)

You assume the *producer* is wrong (adversarial stance). Now turn that scrutiny on **your own verdict** before you finalize it — a false verdict from a gating critic has no second reviewer.

Run this once, immediately before emitting the status/classification:

1. **If you are leaning PASS / clean / VERIFIED:** state the single most likely reason this is a false PASS — the one check you ran shallowly, the one requirement you took on trust, the one behavior you confirmed by presence rather than execution. If that reason is plausible, downgrade or mark it for human verification rather than passing.
2. **If you are leaning FAIL / BLOCKER / BLOCK:** state the strongest argument (good-faith) that the work is actually acceptable. If that argument holds, soften the finding to a warning or withdraw it — do not manufacture blockers.
3. **Record** the self-check outcome in one line ("Self-check: considered X; verdict unchanged/adjusted because Y"). Uncertainty is a valid result — prefer an explicit "needs human verification" over a confident wrong verdict.

This is a disconfirmation pass on the verdict itself, distinct from the producer-directed disconfirmation in the thinking-models reference.
