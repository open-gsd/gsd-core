# Issue-driven orchestration explained

**Status:** stable
**Audience:** developers who track work in GitHub Issues, Linear, Jira, or
similar issue trackers and want to understand how GSD's existing primitives
fit an issue-driven loop, and why that loop is safe.

## What this page is

An explanation of how commands GSD already ships combine into an
issue-tracker → workspace → plan/execute → verify/review → PR loop, and why
the loop is built the way it is. It is documentation only. No new commands,
no daemon, no tracker integration — every command referenced below already
exists in GSD today. To run the loop, follow
[How to drive GSD Core from a tracker issue](how-to/drive-gsd-from-a-tracker-issue.md);
this page is the background to those steps.

The shape is inspired by OpenAI's open-source [Symphony orchestration
reference](https://openai.com/index/open-source-codex-orchestration-symphony/)
([repository](https://github.com/openai/symphony)). GSD does not vendor or
wrap Symphony. The orchestration *concepts* map cleanly onto primitives
GSD already exposes; this guide just spells the mapping out so you can
adopt the pattern without writing glue code or bypassing GSD's safety
gates.

## Why this exists

GSD has the building blocks for issue-driven AI development —
`/gsd-workspace --new`, `/gsd-manager`, `/gsd-autonomous`, `/gsd-verify-work`,
`/gsd-review`, `/gsd-ship`, plus `STATE.md` and the phase artifact suite
— but no guide that walks through how to drive them from a single tracker
issue without writing custom orchestration scripts. Without that guide
the failure modes are:

- Underuse: developers run discuss/plan/execute manually and never reach
  for `/gsd-manager` or `/gsd-autonomous` even when their work pattern
  fits.
- Workaround scripts: developers wire ad-hoc shell loops between their
  tracker and `claude` invocations, bypassing `STATE.md`, the phase
  manifest, and the verification gates.

This guide makes the canonical loop discoverable.

## Concept mapping

Each row maps a Symphony-style orchestration concept to the GSD primitive
that already serves it. Use this table as a translation key when reading
Symphony docs, blog posts, or third-party orchestration write-ups.

| Symphony concept | GSD primitive |
|---|---|
| `WORKFLOW.md` (top-level intent) | `ROADMAP.md` (project intent), `STATE.md` (live status), phase `CONTEXT.md` (per-phase scope), phase `PLAN.md` (executable steps) |
| One isolated agent workspace per task | `/gsd-workspace --new --strategy worktree` |
| Agent dispatch and concurrency | `/gsd-manager` (interactive dashboard), `/gsd-autonomous` (unattended) |
| Per-phase plan and discuss steps | `/gsd-discuss-phase` → `/gsd-plan-phase` → `/gsd-execute-phase` |
| Proof-of-work / test evidence | `/gsd-verify-work` (UAT.md persisted across `/clear`) |
| Adversarial review | `/gsd-review` (cross-AI peer review of plans) |
| Human merge gate | `/gsd-ship` (creates PR, optional code review, prepares merge) |
| Follow-up capture | `/gsd-capture`, `/gsd-capture --seed`, `/gsd-new-milestone`, or a manually opened tracker issue |
| Concurrency control | Manager / background-agent semantics (no always-on poller) |

The mapping is one-way: GSD owns the safety gates (verification, human
review, explicit confirmation for follow-up creation). Symphony's
"continuous orchestration" framing is intentionally not adopted — see
[Non-goals](#non-goals).

## The loop in one paragraph

A tracker issue becomes a phase; the phase gets an isolated workspace; GSD's
discuss → plan → execute steps do the work inside it; `/gsd-verify-work`
records proof; `/gsd-review` and `/gsd-ship` put a human decision in front of
every push; follow-up work is captured locally, and the tracker is only
touched when a person says so. The numbered procedure, with the exact
commands and what to expect at each step, is in
[How to drive GSD Core from a tracker issue](how-to/drive-gsd-from-a-tracker-issue.md).
Auto-close keywords in the PR body (`Closes #NNN` / `Fixes #NNN`) close the
tracker issue at merge time.

## Safety boundaries

The loop is safe because four invariants hold by construction:

- **Isolated worktrees.** Every issue runs in a `/gsd-workspace --new`
  worktree, so partial work, aborted plans, and exploratory commits
  never touch `main`. `gsd-local-patches/` is the recovery surface if a
  worktree's hand-edits need to come back across an update.
- **Explicit human review.** `/gsd-review` and `/gsd-ship` both stop for
  human approval. There is no auto-merge and no auto-PR-from-execution
  path. If you want to remove the human gate for a specific repository,
  that is your branch-protection / merge-queue policy decision, not
  something GSD opts into for you.
- **No automatic public posting.** GSD never opens, comments on, or
  closes a tracker issue without an explicit user-initiated command.
  Follow-up capture defaults to local artifacts (notes, seeds,
  milestones); pushing back to the tracker is a separate manual step.
- **Verification before ship.** `/gsd-verify-work`'s UAT.md must record
  evidence before `/gsd-ship` is run. The recommended discipline is to
  treat `verification_failed` as a blocker even when the implementation
  looks correct — the failure usually surfaces a missed acceptance
  criterion, not a flaky test.

If any of these invariants is bypassed (e.g. running `claude` directly
against the worktree, skipping `/gsd-verify-work`, or scripting issue
creation through the tracker API without user confirmation), the
guarantees of this guide do not apply.

## Non-goals

This guide deliberately does **not** propose any of the following. They
are listed here so future contributors don't re-litigate them in code
review:

- **No vendoring or copying Symphony code.** GSD reuses its own
  primitives. The mapping above is conceptual; no Symphony-derived
  source ships in this repo.
- **No long-running daemon.** GSD does not poll GitHub or Linear. The
  manager and autonomous workflows handle concurrency through
  background-agent semantics, not a daemon.
- **No mandatory tracker dependency.** The loop works without any
  tracker integration. The "tracker issue" step is a *human input* —
  the URL goes into `CONTEXT.md`. GSD has no opinion about which
  tracker you use, or whether you use one at all.
- **No bypass of verification, review, or human decision gates.** Even
  when running `/gsd-autonomous`, the verification and review gates
  still fire. The "autonomous" label refers to phase-to-phase
  progression, not to skipping human approval.
- **No expansion of the default skill / command surface.** Every
  command referenced in this guide already exists. This guide is a
  documentation surface, not a feature surface.

## Possible future follow-up

If maintainer experience with this loop justifies it, a separate
approved-enhancement could later add a *minimal* tracker bridge:

- Importing one GitHub or Linear issue into a GSD workspace / phase.
- Exporting `UAT.md` evidence as a comment on the source issue.
- Generating follow-up tracker issues from `/gsd-capture --seed` output.

Each of those would be its own enhancement proposal because each adds
integration surface and ongoing maintenance burden. They are out of
scope for this guide.

## Related

- [The phase loop](explanation/the-phase-loop.md) — how discuss → plan → execute → verify → ship fits together as a repeating cycle.
- [How to drive GSD Core from a tracker issue](how-to/drive-gsd-from-a-tracker-issue.md) — the step-by-step procedure this page explains.
- [Workspaces how-to](how-to/work-in-parallel-with-workstreams.md) — step-by-step guide to creating and managing parallel worktrees.
- [docs index](README.md) — full table of contents for GSD Core documentation.
- [docs/USER-GUIDE.md](./USER-GUIDE.md) — task-oriented walkthroughs of individual commands referenced above.
- [docs/COMMANDS.md](COMMANDS.md) — full reference for `/gsd-*` commands.
- [docs/FEATURES.md](FEATURES.md) — feature-level capability matrix (workspaces, manager, autonomous, verify, review, ship).
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — phase-artifact lifecycle and `STATE.md` mechanics.
