# API Coverage Decision Checkpoint

> Full API Coverage by Default — Opt Out, Never Opt In. Fires when a phase
> integrates an external API / SDK / service. Most non-API phases will not fire
> it — that is the point.

## Why this exists

"We integrated the API" too often silently means "we integrated whatever the
first use case exercised." Every un-built capability is then an invisible hole,
discovered later by a user who reasonably expected it to work. The phase sealed
green because its tasks completed; nobody decided the gaps were acceptable,
because nobody enumerated them. This checkpoint makes the surface **visible and
decided** before the phase can seal.

## Detect whether this phase integrates an external API

The detector is a deterministic scan over the phase scope. It strips fenced
code blocks first, so a trigger term inside a code snippet does not fire. It
returns a typed result: `{ detected, signals[], terms }`. Run it on the phase
scope (the concatenation of this phase's ROADMAP section + the PLAN body). The
path is resolved through the shipped `gsd_run` launcher — `$GSD_TOOLS` when the
workflow preamble ran in this shell, otherwise the PATH entry a later shell
inherits — so it works from a local checkout, a config-dir install and a
global install alike:

```bash
SCOPE="$(cat "${PHASE_DIR}"/*-PLAN.md 2>/dev/null) $(gsd_run query roadmap.get-phase "${PHASE}" 2>/dev/null || true)"
# Resolve the shipped gsd-core/bin the way the gsd_run launcher itself does:
# $GSD_TOOLS when the workflow preamble ran in this shell, else the PATH entry
# a later shell inherits. Symlinks are followed so an npm-style global install
# lands in the real gsd-core/bin — the directory that holds lib/.
API_COVERAGE_BIN=""
_GSD_SEED="${GSD_TOOLS:-$(command -v gsd_run 2>/dev/null || true)}"
if [ -n "$_GSD_SEED" ]; then
  _GSD_SRC="$_GSD_SEED"
  while [ -h "$_GSD_SRC" ]; do
    _GSD_DIR="$(cd -P "$(dirname "$_GSD_SRC")" && pwd)" || break
    _GSD_SRC="$(readlink "$_GSD_SRC")"
    case "$_GSD_SRC" in /*) ;; *) _GSD_SRC="$_GSD_DIR/$_GSD_SRC" ;; esac
  done
  _GSD_BINDIR="$(cd -P "$(dirname "$_GSD_SRC")" 2>/dev/null && pwd || true)"
  API_COVERAGE_BIN="${_GSD_BINDIR:+$_GSD_BINDIR/lib/api-coverage.cjs}"
fi
API_COVERAGE_JSON=$(printf '%s' "$SCOPE" | node "$API_COVERAGE_BIN" --json 2>/dev/null) || true
if [ -z "$API_COVERAGE_JSON" ]; then
  if [ -n "$API_COVERAGE_BIN" ]; then
    _GSD_WHY="$API_COVERAGE_BIN not found or failed to start"
  else
    _GSD_WHY="no gsd-tools.cjs reachable in this shell"
  fi
  printf 'ERROR: api-coverage detector did not run (%s) — report this to the user before planning; it is not a "no API integration" verdict.\n' "$_GSD_WHY" >&2
  API_COVERAGE_JSON='{"skipped":true,"reason":"probe_unavailable"}'
fi
```

The `|| true` neutralizes the assignment's status without discarding the
detector's own payload: the detector exits **1** for a real "no integration"
verdict, so treating any non-zero exit as failure would throw away a correct
answer. Emptiness — not exit status — is what proves the probe never ran, and
the fallback branch is the only place the fragment manufactures a payload of
its own — one that records the *absence* of a verdict rather than asserting
one. When the probe never ran it also says so out loud: the
`ERROR: api-coverage detector did not run` line on stderr is the visible error
for the user.

The detector's exit code and `--json` payload now distinguish a real negative
from an unexamined input (ADR-3889 Phase 3, #3907): empty/whitespace-only
`$SCOPE` or a stdin read failure emit `{"skipped":true,"reason":"no_input"|
"stdin_error"}` — no `detected` key at all. **Check for `skipped` before
reading `detected`**: a `skipped` payload is not a confirmed "no API
integration" verdict, it means the detector never examined real input. Do not
treat it as `detected:false`. Read `API_COVERAGE_JSON.detected` only when
`skipped` is absent — act on it only, do **not** pattern-match the prose
yourself.

**If `skipped` is `true`:** two causes, two duties. `probe_unavailable` means
the detector could not be located or started at all — **report this to the
user** (the `ERROR:` line was already printed for them) and fix the install
before planning this phase; a checkpoint that never ran must not be skipped
silently. `no_input` / `stdin_error` mean the scope could not be established —
skip the checkpoint for this run rather than asserting a verdict about input
that was never examined; do not raise those with the user.

**If `detected` is `false`:** this phase does not integrate an external API. Skip
the checkpoint entirely and continue planning. Do not raise it with the user.

**If `detected` is `true`:** an external-API integration is in scope. You MUST
produce a **coverage matrix** before the plan is finalized.

**If `detected` is `true` but the phase genuinely integrates no external API**
(the detector is deterministic, not infallible — confirm by re-reading the phase
scope, not by preference): do NOT fabricate a matrix row for a capability that
does not exist. Write a reasoned declaration to `${PHASE_DIR}/COVERAGE.md`
instead:

```markdown
No external API integration: <one-line reason — what the phase touches instead>.
```

The reason is required, exactly like an `OPT-OUT` reason, and at most 200
characters (the seal gate rejects longer reasons). The seal-time gate accepts
this declaration in place of a matrix.

## Produce the coverage matrix

Enumerate the external API's full **capability surface** — the verb/endpoint/method
list (e.g. for a music service: `search`, `play`, `pause`, `skip`, `set_volume`,
`get_playlist`, `create_playlist`, `add_to_playlist`, …). For each capability
record a decision, starting from **full coverage** as the default:

| capability | decision | reason |
|---|---|---|
| `<capability-id>` | `INTEGRATE` \| `OPT-OUT` | `<one-line reason if OPT-OUT>` |

Rules:

- **`INTEGRATE` is the default.** Every capability starts as INTEGRATE; the
  matrix is the *subtraction record*.
- **Every `OPT-OUT` MUST carry a one-line reason of at most 200 characters**
  (`not needed`, `not needed yet`, `explicitly out of scope`, …) — the seal
  gate rejects reasons over 200 characters (the cap covers every reason it
  reads, `INTEGRATE` rows included). An opt-out without a reason is an
  un-decided hole — the exact failure mode this gate exists to close.
- **A second integration against the same need** (e.g. a second platform for the
  same capability) starts from the **same full-coverage baseline** as the first.
  Do not carry over the first integration's opt-outs silently — re-decide each
  capability for the new surface, so a first-class/fallback asymmetry cannot
  accumulate.

Write the matrix to `${PHASE_DIR}/COVERAGE.md` (canonical markdown-table form):

```markdown
# API Coverage — <service>

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

| capability | decision | reason |
|---|---|---|
| search | INTEGRATE | |
| playlists | INTEGRATE | |
| skip | OPT-OUT | not needed yet — tracked for follow-up phase |
```

A fenced ` ```coverage ` JSON block is also accepted for machine-generated
matrices; the markdown table is preferred (human-editable, diff-friendly).

Before finishing planning, validate what you wrote:
`gsd_run check api-coverage.verify-pre "${PHASE_DIR}"` — fix every reported
violation now, while it is still a plan edit, not at seal time.

## The seal-time gate

This checkpoint is enforced. At `verify:pre` the `api-coverage.verify-pre` gate
runs `check api-coverage.verify-pre <phase-dir>`:

- If `COVERAGE.md` exists, it is validated — every row needs a valid decision and
  every `OPT-OUT` a reason. A malformed/partial matrix **blocks the seal**. A
  reasoned `No external API integration: …` declaration (and no rows) passes.
- If `COVERAGE.md` is absent, the detector runs again over the phase scope. If a
  strong external-API-integration signal is found, the seal is **blocked** until a
  matrix is produced. If no signal is found, the phase is treated as a non-API
  phase and the seal proceeds.

So: an API-integrating phase cannot seal without a decided matrix. Produce it at
plan time; do not leave it for seal time.

## Tuning the vocabulary (optional)

The trigger vocabulary is a curated, additive-only set in
`gsd-core/bin/lib/api-coverage.cjs` (`DEFAULT_API_COVERAGE_TERMS`). To widen it
for a project, override at the call site:

```bash
printf '%s' "$SCOPE" | node "$API_COVERAGE_BIN" --json \
  --verbs integrate,wrap,connect,embed --nouns api,sdk,rest,grpc,webhook,plugin
```

The whole checkpoint is toggleable via `workflow.api_coverage_gate` in
`.planning/config.json`.
