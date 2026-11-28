# How to park an idea for later

Use this when an idea comes up that you are not ready to plan: pick the tool that fits it, park it, and bring it back. The flags are in the [`/gsd-capture` reference](../COMMANDS.md#gsd-capture) and the requirements in [Backlog and seeds](../FEATURES.md).

## Choose the tool

| The idea is... | Use | It comes back |
| --- | --- | --- |
| A piece of work you want to plan someday | The backlog (`--backlog`) | When you run `/gsd-review-backlog` |
| Forward-looking, tied to a condition ("when the WebSocket infra is in place") | A seed (`--seed`) | Automatically at `/gsd-new-milestone` |
| Work that spans several sessions but fits no phase | A thread (`/gsd-thread`) | When you resume it by name |

## Park an idea in the backlog

1. Capture it:

   ```bash
   /gsd-capture --backlog "GraphQL API layer"     # Creates 999.1-graphql-api-layer/
   /gsd-capture --backlog "Mobile responsive"     # Creates 999.2-mobile-responsive/
   ```

   Backlog items use 999.x numbering and get a full phase directory, so they stay outside the active phase sequence. Backlog directories, and the `0-*` pre-milestone directory some projects carry, are left out of `/gsd-progress`, `/gsd-stats` and the phase listings for the current milestone, for counting as well as planning.

2. Work on it without promoting it, if you want to: `/gsd-discuss-phase 999.1` explores the idea, and `/gsd-plan-phase 999.1` plans it when it is ready.

3. Review the backlog with `/gsd-review-backlog`. For each item choose **promote** (move it into the active sequence), **keep** (leave it) or **remove** (delete it).

## Plant a seed

1. Capture the idea with its trigger:

   ```bash
   /gsd-capture --seed "Add real-time collab when WebSocket infra is in place"
   ```

   The seed is stored at `.planning/seeds/SEED-YYMMDD-xxx-slug.md`. `/gsd-new-milestone` scans every open seed and presents the matches.

2. Audit what is parked, without waiting for the next milestone:

   ```bash
   /gsd-capture --list-seeds            # Every parked seed
   /gsd-capture --list-seeds dormant    # One status: dormant, active, triggered or closed
   ```

   This is read-only. It prints an audit table (ID, status, scope, trigger, title) and a per-status summary, and never changes a seed.

3. Close a seed once its idea has been acted on, so it stops coming back at every `/gsd-new-milestone` and in every milestone-close audit. A seed is open while its `status` is `dormant`, `active` or `triggered`. Give exactly one outcome flag:

   ```bash
   /gsd-capture --seed --close SEED-260315-k3x --promoted PLAT-17    # it became requirement PLAT-17
   /gsd-capture --seed --close SEED-260315-k3x --built 3             # it was built in phase 3
   /gsd-capture --seed --close SEED-260315-k3x --dropped "superseded by the sync engine"
   ```

   The seed keeps its file and its reasoning. Its frontmatter gains `status: closed` and three fields that say what it became: `outcome_kind` (`promoted`, `built` or `dropped`), `outcome_ref` (the requirement id or phase number; absent for a dropped seed) and `outcome` (one line of prose). `/gsd-capture --list-seeds closed` still lists it with those fields.

   No command reopens a seed. To reopen one, set its `status` back to `dormant` by hand.

## Keep a thread across sessions

```bash
/gsd-thread                              # List all threads
/gsd-thread fix-deploy-key-auth          # Resume an existing thread
/gsd-thread "Investigate TCP timeout"    # Create a new thread
```

A thread is a lightweight knowledge store at `.planning/threads/{slug}.md`. When it matures, promote it to a phase with `/gsd-phase` or to a backlog item with `/gsd-capture --backlog`.

## Related

- [`/gsd-capture` and `/gsd-review-backlog` reference](../COMMANDS.md#gsd-capture)
- [Planning artifacts](../reference/planning-artifacts.md): where seeds, threads and backlog directories live
- [User guide](../USER-GUIDE.md)
