'use strict';
// hooks/lib/dispatch-identity.js — the ONE canonical owner of the
// `[gsd:dispatch phase="…" plan="…"]` marker format and its prose fallback
// (#4594, epic #4630 Phase 1). See
// `.gsd/phase/fix-4594-dispatch-identity-seam/40-design.md` for the full
// rationale (behavior table, negative space, rejected alternatives).
//
// COLD-LOAD CONSTRAINT (load-bearing, not a style choice): this module MUST
// require NOTHING — no `fs`, no `path`, and above all nothing under
// `gsd-core/bin/lib/` or `ensure-runtime-build`. The guard hooks that consume
// this module must load on a raw plugin-marketplace install where the
// compiled lib is absent and the self-healing build seam has not run — a
// hook that dies at module load is worse than one carrying a mirror. See
// `tests/dispatch-identity.test.cjs`'s "cold tree load" test, which asserts
// this by monkeypatching `Module._load` to throw on exactly those paths.

// DISPATCH_PHASE_TOKEN_SOURCE is a DELIBERATE MIRROR of
// `CASE_FLEXIBLE_PHASE_NUMBER_TOKEN_SOURCE` in `src/phase-id.cts`
// (ADR-2121 owns the phase-token grammar; `gsd-core/bin/lib/phase-id.cjs` is
// its compiled form). It cannot be an `require()`-based import: importing the
// compiled lib here would violate the cold-load constraint above (either a
// direct dependency on `gsd-core/bin/lib/` or a forced self-heal via
// `ensure-runtime-build`), which is exactly the failure mode this module
// exists to avoid for the guard hooks that consume it.
//
// Because this is a hand-copied mirror and not a shared reference, a
// hand-edited grammar change on one side that is not mirrored on the other
// does NOT fail loudly — both sides remain independently valid regex
// sources, so the failure mode is a silent, invisible non-match (a dispatch
// whose phase token the two owners now parse differently), never a thrown
// error. `tests/dispatch-identity.test.cjs`'s "templates: prose token source
// matches the case-flexible phase-id grammar" test pins this string equal to
// the compiled source at test time specifically to turn that silent drift
// into a loud, in-CI failure.
const DISPATCH_PHASE_TOKEN_SOURCE = '\\d+[A-Za-z]?(?:\\.\\d+)*';

// Bounded marker grammar: `[gsd:dispatch key="value" key2="value2"]`.
// - Key names bounded to {1,31} — no key we emit or expect is anywhere near
//   that long; this is purely a backstop against pathological input.
// - Values bounded to {0,200} and forbidden from containing `"`, `]`, or any
//   control character that could either close the marker early or forge a
//   sibling key — enforced structurally by the negated character class, not
//   by a separate validation pass.
// Global flag so `findMarker` can scan forward through a large prompt.
const MARKER_RE = /\[gsd:dispatch((?:\s+[A-Za-z][A-Za-z0-9_-]{0,31}="[^"\]\r\n]{0,200}")*)\s*\]/g;
const MARKER_KV_RE = /([A-Za-z][A-Za-z0-9_-]{0,31})="([^"\]\r\n]{0,200})"/g;

// Prose fallback frame: `execute plan <token> of phase <PHASE TOKEN>`.
// - Case-insensitive, `\s+` throughout so CRLF (and any run of whitespace)
//   parses identically to LF.
// - The plan token is bounded (`\S{1,80}`) but its VALUE is deliberately
//   discarded by the caller (see `parseDispatchIdentity` below) — captured
//   only so the phase token can be anchored correctly after it.
// - The phase token is bounded by `DISPATCH_PHASE_TOKEN_SOURCE`, replacing
//   the old greedy `(\S+)`, so a directory-name suffix (`-auth`) or a
//   sentence-terminating period is never swept into the token.
const PROSE_RE = new RegExp(
  `execute\\s+plan\\s+(\\S{1,80})\\s+of\\s+phase\\s+(${DISPATCH_PHASE_TOKEN_SOURCE})`,
  'i',
);

/**
 * Render the `[gsd:dispatch phase="…" plan="…"]` marker for a producer to
 * embed verbatim in a dispatch description/prompt. Never throws.
 *
 * Emits only keys whose value is a non-empty string not containing `"`, `]`,
 * `\r`, or `\n` — such a value is UNUSABLE and that key is omitted entirely,
 * because embedding it could close the marker early and forge a second,
 * attacker-controlled field. Key order is always `phase` then `plan`.
 * Returns `''` when neither key is usable (nothing worth emitting).
 */
function renderDispatchIdentityMarker(input) {
  const value = input && typeof input === 'object' ? input : {};
  const parts = [];
  for (const key of ['phase', 'plan']) {
    const v = value[key];
    if (typeof v === 'string' && v.length > 0 && !/["\]\r\n]/.test(v)) {
      parts.push(`${key}="${v}"`);
    }
  }
  if (parts.length === 0) return '';
  return `[gsd:dispatch ${parts.join(' ')}]`;
}

function emptyResult() {
  return { phase: null, plan: null, source: null };
}

/**
 * Scan `texts` in order for the first well-formed marker that yields at
 * least one recognized key (`phase` and/or `plan`). Returns `{ phase, plan }`
 * (one of the two possibly null, never both) or `null` if no QUALIFYING
 * marker was found in any text. Unrecognized keys inside a marker are
 * ignored (forward compatibility — a later `run=`/`wave=` key must not break
 * a deployed parser).
 *
 * #4594 F1 fix: a marker that matches `MARKER_RE` but carries neither
 * `phase=` nor `plan=` (e.g. only unrecognized keys, or an empty kv block)
 * is NOT treated as "found" — it is skipped and scanning continues (later
 * markers in the same text, then subsequent texts), falling through to the
 * prose fallback if nothing qualifying turns up. Without this, prompt text
 * that merely CONTAINS the literal marker syntax with no usable identifiers
 * silently suppressed the prose fallback entirely, since the old
 * implementation returned on the first syntactic match regardless of
 * content.
 */
function findMarker(texts) {
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue;
    MARKER_RE.lastIndex = 0;
    let match;
    while ((match = MARKER_RE.exec(text)) !== null) {
      const kvBlock = match[1] || '';
      let phase = null;
      let plan = null;
      MARKER_KV_RE.lastIndex = 0;
      let kv;
      while ((kv = MARKER_KV_RE.exec(kvBlock)) !== null) {
        const [, key, val] = kv;
        if (key === 'phase' && phase === null) phase = val;
        else if (key === 'plan' && plan === null) plan = val;
      }
      if (phase === null && plan === null) continue;
      return { phase, plan };
    }
  }
  return null;
}

/**
 * Scan `texts` in order for the first `execute plan <token> of phase
 * <PHASE TOKEN>` frame. Returns `{ phase }` or `null`.
 *
 * The prose fallback returns `plan: null` DELIBERATELY (enforced by the
 * caller, not here): the prose plan token (e.g. `02`) is a bare in-phase
 * plan number, a different namespace from the sentinel's `plan_id` (e.g.
 * `03-02-hardening`, which is phase-prefixed AND slugged). Reporting the
 * prose plan token as the parsed `plan` is exactly the false-mismatch bug
 * this module exists to fix — an absent value is honestly "cannot compare",
 * while a wrong value silently forges a mismatch on every dispatch. Do not
 * "fix" this by threading the plan token through — that was the bug.
 */
function findProse(texts) {
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue;
    const match = PROSE_RE.exec(text);
    if (match) {
      return { phase: match[2] };
    }
  }
  return null;
}

/**
 * Parse dispatch identity out of one or more texts (a short description, a
 * full prompt body, etc). Never throws for any input type; non-string
 * entries are skipped.
 *
 * Pass 1: scan all texts in order for a well-formed marker; the first one
 * wins outright (marker beats prose even if prose appears earlier in the
 * same text — see the design doc's row 8).
 * Pass 2 (only if no marker was found anywhere): scan all texts in order for
 * the prose frame; the first match wins. `plan` is always `null` from this
 * path (see `findProse`'s doc comment).
 *
 * Returns `{ phase, plan, source }` where `source` is `'marker' | 'prose' |
 * null`.
 */
function parseDispatchIdentity(...texts) {
  const marker = findMarker(texts);
  if (marker) {
    return { phase: marker.phase, plan: marker.plan, source: 'marker' };
  }

  const prose = findProse(texts);
  if (prose) {
    return { phase: prose.phase, plan: null, source: 'prose' };
  }

  return emptyResult();
}

module.exports = {
  DISPATCH_PHASE_TOKEN_SOURCE,
  renderDispatchIdentityMarker,
  parseDispatchIdentity,
};
