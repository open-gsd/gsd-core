---
type: Fixed
pr: 4950
---
**Windows conformance CI no longer times out on newly-added test files** — a chunk holding several files not yet in the timing table could blow the 600s per-chunk budget even though each looked individually affordable; unmeasured files are now capped at 2 per chunk on Windows so a batch of new conformance-tier tests can no longer compound into a red `next`. (#4949)
