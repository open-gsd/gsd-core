# How to enable deep verification

Let GSD derive an interaction-level behavior list from a finished phase, run every behavior it
can against your running app, and leave you only the checks that need a human, before UAT
starts.

> **Default-off, and additive.** Nothing changes until you set one key, and the step can never
> block UAT. A passed behavior is recorded for you to read but never becomes a checkpoint, so
> the human walkthrough shrinks instead of disappearing. See the
> [FEATURES entry](../FEATURES.md) for why it is built as a capability and not as an edit to
> `verify-work`.

**What you need:**

- GSD installed with the `full` profile (the capability is `tier: full`).
- A browser MCP server registered in your runtime. `mcp__playwright__*` is driven whenever it
  responds. `chrome-devtools-mcp` (`mcp__chrome-devtools__*`) and Claude-in-Chrome
  (`mcp__claude-in-chrome__*`) are driven only while `workflow.live_dom_uat` is also `true`: the
  agent reads that key from `{planning_root}/config.json` and is instructed to leave Chrome-family
  tools alone otherwise.
- Something serving your UI: a dev server, a preview deployment, any reachable URL named in the
  plan or UI-SPEC.
- A phase that has finished execution, with a `SUMMARY.md` listing "Files Changed".

---

## Step 1: Turn the key on

```bash
gsd-tools query config-set workflow.deep_verify true
```

Verify it took:

```bash
gsd-tools query config-get workflow.deep_verify
# → true
```

With the key on, `/gsd-verify-work` dispatches the `gsd-behavior-verifier` step at `verify:pre`
on UI phases (phases with a `{phase}-UI-SPEC.md`).

---

## Step 2: Decide which phases it covers

By default it runs only on UI phases. To run on every phase, including API-driven flows that
surface in the DOM, deep links and error states:

```bash
gsd-tools query config-set workflow.deep_verify_all_phases true
```

This key widens scope only. Set on its own it activates nothing; `workflow.deep_verify` must
also be `true`.

---

## Step 3: Decide whether Chrome-family servers are in play

If your browser MCP is `chrome-devtools-mcp` or Claude-in-Chrome, also enable the key that
opts those servers in for this project:

```bash
gsd-tools query config-set workflow.live_dom_uat true
```

Skip this if you use the Playwright MCP. `chrome-devtools-mcp` keeps an exclusive lock on its
browser profile, so a second concurrent instance needs `--isolated` on **your** MCP server
registration; GSD cannot pass that flag. See
[Enable live-DOM verification](enable-live-dom-verification.md) for the full lock handling.

---

## Step 4: Run verify-work and read what comes back

```bash
/gsd-verify-work 3
```

Two files appear in the phase directory:

| File | What it holds | Reaches your UAT list? |
|---|---|---|
| `{phase}-DEEP-VERIFY.md` | Every enumerated behavior with its source, verdict and observation | No |
| `DEEP-VERIFY-CHECKPOINTS.md` | Only behaviors a human must still confirm: judgment items, failed behaviors, anything it could not run. Rewritten on every run; it holds only `No checkpoints.` when nothing needs you | Yes, merged into the UAT checkpoint list |

Each checkpoint carries a `name` and an `expected` outcome, the two fields verify-work reads.
Failed behaviors enter the unchanged diagnose-issues and gap-closure pipeline once you record
them in UAT.

---

## When nothing seems to happen

The `outcome` and `reason` in the `{phase}-DEEP-VERIFY.md` frontmatter tell "nothing to report"
apart from "could not look". Read them before concluding anything:

| `outcome` | `reason` | What it means | What to change |
|---|---|---|---|
| `nothing_to_report` | `not_ui_phase` | The phase is not a UI phase and the widen key is off | Set `workflow.deep_verify_all_phases` to `true`, or accept the skip |
| `nothing_to_report` | `no_behaviors` | The plan, summary and changed files support no behavior | Nothing; the step never invents one |
| `could_not_look` | `no_browser_mcp` | No browser MCP answered. The enumerated list was printed and every item is in your checkpoints | Register a browser MCP, or walk the list by hand |
| `could_not_look` | `profile_locked` | Another instance holds the Chrome profile | Add `--isolated` to your MCP server registration |
| `could_not_look` | `target_unreachable` | Nothing is serving the URL the plan names | Start the dev server, then re-run verify-work |
| `verified` | `ok` | Behaviors were enumerated and observed; any that could not be observed are counted in `could_not_look` and listed in the checkpoint file | Read the checkpoint file for what is left |

No `{phase}-DEEP-VERIFY.md` at all means the step never ran: the key is off, the capability is
inactive, or the step errored and was skipped. UAT proceeds as it always has.

---

## What it does not do

- It reads the files named under "Files Changed" instead of running a VCS diff: the agent has
  no shell.
- Behavior enumeration is model-derived and best-effort; a clean run is not a coverage claim.
- It does no screenshot diffing, accessibility audit or performance tracing. A behavior needing
  one is routed to you as a judgment item.
- #1602 coverage metadata does not reach `{phase}-UAT.md` from this step.
