# Fix a reviewer lane that refused an oversized prompt

`/gsd-review` sends each reviewer lane one prompt: the instructions, the roadmap, every plan in
the phase, and the project, context, research and requirements files. Every prompt-fed lane has a
cap on that prompt. When the prompt is bigger than the cap, the lane refuses to run instead of
handing the model more than it can read. This page covers reading that refusal and getting the
review to run.

## What you saw

One or more of these:

- A lane's section in `REVIEWS.md` reads
  `<slug> review did not run: prompt exceeds this lane's context cap …`.
- The `REVIEWS.md` frontmatter has a `refused_reviewers` block naming the lane, with its
  `estimated_tokens`, `cap` and `cap_source`.
- The run wrote no `REVIEWS.md` at all and reported that every selected lane was skipped.
- `gsd-tools review-lane invoke --slug <slug> --json` returned `"ok": false` with
  `"reason": "prompt_exceeds_context"`.

A refused lane did not review anything. It is not a lane with no concerns.

## Why it refuses instead of trimming

Past its context window a model does not error. It compacts and answers confidently about the
part it never read, and the result reads exactly like a clean review. Trimming the prompt to fit
fails the same way, only quieter. A refusal is the one failure you can see and fix.

## Find out where the cap came from

```bash
gsd-tools review-lane plan --selected claude --json
```

Read two fields on the lane's row:

| `promptCapSource` | Where `promptBudget` came from | Key that sets it |
|---|---|---|
| `lane` | Your per-lane cap | `review.max_prompt_tokens_per_reviewer.<slug>` |
| `global` | Your global cap | `review.max_prompt_tokens` |
| `context-window` | 65% of the lane's context window (`contextWindowTokens` in the same row) | `review.context_window_tokens.<slug>`, or the lane's declared default |
| `none` | No cap, so this lane never refuses | — |

Out of the box, only `context-window` caps apply: `claude` 130000, `codex` 176800, `qwen` 85196
and `kimi-code` 170393 estimated tokens. These come from the smallest window each CLI's default
model can resolve to.

## Get the review to run

Pick the step that matches your situation.

1. **Your model has a bigger window than the declared one.** Common for Claude on a 1M-context
   plan. Tell GSD the real window:

   ```bash
   gsd config-set review.context_window_tokens.claude 1000000
   ```

   The cap becomes 65% of that, here 650000.

2. **You set a cap yourself and it is too low.** Raise it, or set `-1` so the lane falls back to
   its context-window default:

   ```bash
   gsd config-set review.max_prompt_tokens_per_reviewer.codex -1
   ```

3. **The prompt really is too big for the model.** Split the review. Review fewer plans at a time,
   or move long background material out of the phase's `CONTEXT.md` and `RESEARCH.md`. Or select a
   lane whose model has a larger window. Raising the cap past the real window only brings back the
   silent overflow the refusal exists to stop.

4. **You want no cap on this lane at all.** Set the lane's cap to `0`:

   ```bash
   gsd config-set review.max_prompt_tokens_per_reviewer.qwen 0
   ```

   The lane then never refuses, but nothing stops a prompt larger than the model's window.

Re-run `/gsd-review` after any of these changes.

## Lanes that never refuse

`opencode`, `cursor`, `antigravity`, `ollama`, `lm_studio` and `llama_cpp` run whatever model you
configured inside the CLI or loaded on the server, so GSD declares no window for them. They stay
uncapped until you give them one. Give them one, for example for a local server with an 8K-token
model:

```bash
gsd config-set review.context_window_tokens.ollama 8192
```

`coderabbit` reviews your working-tree diff and is sent no prompt, so it has no cap.

## Related

- [Prompt budgets for reviewer lanes](../CONFIGURATION.md#prompt-budgets-for-reviewer-lanes): the
  full resolution order and key reference.
- [Set up cross-AI review](set-up-cross-ai-review.md)
