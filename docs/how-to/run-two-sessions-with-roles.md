# Run two sessions with roles

Pause one session and resume its work in another, without a second session picking up the wrong handoff.

## Before you start

- `.planning/` exists and a runtime session key is set (the runtime sets one; see [session identity](../CLI-TOOLS.md)).
- Each session you run is a separate runtime session, such as two terminal tabs.

## Pause a session under a role

1. In the first session, run:

   ```bash
   /gsd-pause-work --role Coordinator
   ```

   The role is free text and must be the last argument.

2. The session writes `.planning/HANDOFF.latest.coordinator.json` and `.continue-here.latest.coordinator.md`. It records where it stopped in `STATE.md` and commits the handoff. It never writes `paused_at` or `status: paused`.

3. The statusline of the first session shows `paused`. The statusline of the second session shows `⏸1`, and `/gsd-next` there does not route to resume.

## Resume the role in another session

1. In the second session, run:

   ```bash
   /gsd-resume-work --role Coordinator
   ```

2. The session renames `HANDOFF.latest.coordinator.json` to `HANDOFF.claimed.coordinator.<session_id>.json` before it reads it. A rename succeeds for exactly one session.

3. Choose how to proceed. The workflow removes the claimed handoff and the Coordinator's continue-here files, records "Session resumed", and commits the removal.

## When a second session resumes the same role

The session finds no unclaimed `HANDOFF.latest.coordinator.json` and is told that another session holds or has consumed it. It does not read the claimed file.

## Pause without a role

`/gsd-pause-work` with no `--role` writes `.planning/HANDOFF.<session_id>.json`; `/gsd-resume-work` in that same session reads it. A session with no id writes the legacy `.planning/HANDOFF.json`, which any session can read with `/gsd-resume-work` unless its `role_id` names another role.

## Clean up a handoff left claimed

A session that stopped between claiming and consuming leaves `HANDOFF.claimed.<role_id>.<session_id>.json`. Run `state sessions` to list it; the owning session id removes it with `state session-resume --handoff <file name>`.

## See also

- [`/gsd-pause-work`](../COMMANDS.md#gsd-pause-work)
- [Planning artifacts: `HANDOFF*.json`](../reference/planning-artifacts.md)
- [ADR-4962: per-session pause and handoff claim](../adr/4962-per-session-pause-and-handoff-claim.md)
