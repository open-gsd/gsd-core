# How to guide external reviewers with a capability

Use this when a capability you maintain has constraints that planning and execution already honor, and you want the external reviewers behind `/gsd-review` (and every `/gsd-plan-review-convergence` cycle) to judge plans under the same constraints.

This is the capability-author side. If you are a user deciding whether to install such a capability, read [the trust model](../explanation/capability-trust-model.md#reviewer-contributions-cross-the-external-review-boundary) first: the text is sent to every external reviewer lane you have consented to.

## Before you start

- GSD **1.23.0 or later** (the release that adds the `review:pre` point). Older cores reject the point.
- A feature capability (`role: "feature"`) whose `capability.json` you can edit.

## Steps

1. **Declare a contribution at `review:pre`, addressed to `reviewer`.** Use an inline fragment; a `path`-only fragment is not delivered here.

   ```json
   {
     "point": "review:pre",
     "into": "reviewer",
     "fragment": { "inline": "Reviewers: this project forbids new runtime dependencies. Flag any plan that adds one." },
     "produces": [],
     "consumes": [],
     "onError": "skip"
   }
   ```

2. **Declare an engine range that excludes older cores.** The registry build rejects a capability with a `review:pre` hook and no range, or one an older core satisfies.

   ```json
   "engines": { "gsd": ">=1.23.0" }
   ```

3. **Rebuild or reinstall the capability** so the registry picks it up (`node scripts/gen-capability-registry.cjs --write` in this repo, or reinstall a third-party capability). A `step` or `gate` at `review:pre` fails the build; only `contribution` hooks are wired there.

4. **Enable the capability** (its `activationKey`, if it has one) and run `/gsd-review`.

## Check that it worked

The fragment appears once, inside a `<capability_reviewer_rules>` block at the end of the run directory's `gsd-review-prompt.md` — the one file every prompt-bearing lane reads. A lane that takes no prompt (`promptChannel: none`) is unchanged.

## When nothing shows up

| You see | Cause |
|---|---|
| No `<capability_reviewer_rules>` block | The capability is disabled or inactive, its `when` key is false, or no contribution has `into: "reviewer"` at `review:pre`. With nothing to add the prompt is byte-identical to a core-only run and the step prints nothing. |
| The fragment is missing but others appear | It is `path`-only or its `inline` text is empty. |
| The registry build fails on the capability | `into` is not `reviewer`, the hook is a `step` or `gate`, or `engines.gsd` is absent or admits a core older than 1.23.0. |
| A lane reports `review did not run: prompt exceeds` | The block pushed the prompt over that lane's cap. The prompt is refused, never shortened; shorten the fragment or raise the lane's cap as the refusal message says. |
| The block is silently absent although everything above is right | The render is advisory: if `loop render-hooks review:pre` fails, the review runs without the block and is never blocked. Run `gsd-tools loop render-hooks review:pre --raw` to see the error. |

## See also

- [Capability manifest reference — `review:pre`](../reference/capability-manifest.md#review-pre--reviewer-contributions-3997)
- [ADR-3997](../adr/3997-review-prompt-capability-contributions.md)
