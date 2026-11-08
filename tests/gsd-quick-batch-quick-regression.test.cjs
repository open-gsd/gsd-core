'use strict';

/**
 * gsd-quick-batch-quick-regression.test.cjs — row 48 of the #3676 test
 * matrix: ordinary `/gsd:quick` (non-batch) stays byte-identical after
 * Phase 4 lands.
 *
 * Named `gsd-quick-batch-*` (not `quick-batch-*`) so `scripts/
 * lint-test-file-count.cjs`'s longest-prefix bucketing does not fold this
 * markdown-only test into the already-capped `quick-batch` production-module
 * bucket (2/2 test files from the CORE-layer pass).
 *
 * `commands/gsd/quick.md` / `gsd-core/workflows/quick.md` are never touched
 * by this phase (design doc row 38/48) — quick-batch adds new call sites
 * onto shared primitives, never edits the ordinary quick command/workflow.
 * Asserted via the same base-ref resolution helper `tests/
 * emitted-attribution.test.cjs` already uses (`resolveBase`/`resolveChangedPaths`,
 * `tests/helpers/emitted-runtime.cjs`) — a three-dot diff against the merge
 * base, never a hand-rolled git call.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  git,
  resolveBase,
  resolveChangedPaths,
  baseRefCandidates,
} = require('./helpers/emitted-runtime.cjs');
const {
  INLINE_RESPONSE_LANGUAGE_DIRECTIVE,
  importsDirectiveReference,
} = require('../scripts/lint-response-language-coverage.cjs');

// The canonical launcher preamble, read from its single source of truth. A
// `sync-runtime-launcher.cjs` propagation rewrites this one line inside every
// gsd_run-calling workflow — quick.md included — without touching a word of
// ordinary quick content.
const CANONICAL_LAUNCHER_PREAMBLE = require('node:fs')
  .readFileSync(require('node:path').join(__dirname, '..', 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh'), 'utf8')
  .replace(/\r?\n$/, '');

// A diff line that swaps the launcher preamble removes the OLD canonical line
// as well as adding the new one, so equality with today's snippet is not
// enough. Recognize a launcher-preamble line structurally instead: the shim
// name assignment plus the resolver's PATH probe and function definition —
// the same definition-shape discriminator
// tests/no-bare-gsd-tools-command-position.test.cjs uses for its EXCLUSION_RE.
const looksLikeLauncherPreambleLine = (body) =>
  body.startsWith('_GSD_SHIM_NAME=')
  && body.includes('command -v gsd_run')
  && body.includes('gsd_run()');

// #4772: the workstream-forwarding sweep gives every agent-skills / init.* call in a
// workflow the same single-token `--ws` flag plus one canonical `GSD_WS=` parse line per
// fence. Like the launcher sync above, that is a mechanical propagation, not quick-batch
// phase work: a parse line is recognized structurally, and a call line counts only when
// the diff pairs it with its flag-free twin (strip the token from the added side and it
// equals a removed line, or the reverse), so any OTHER edit still trips this row.
const WS_FORWARD_FLAG = ' ${GSD_WS:+--ws=${GSD_WS##* }}';
const WS_PARSE_PREFIX = 'GSD_WS=$(echo " $ARGUMENTS"';
function isWorkstreamForwardingSweepLine(sign, body, addedBodies, removedBodies) {
  if (sign === '+' && body.startsWith(WS_PARSE_PREFIX)) return true;
  if (sign === '+' && body.includes(WS_FORWARD_FLAG)) {
    return removedBodies.has(body.split(WS_FORWARD_FLAG).join(''));
  }
  if (sign === '-') {
    for (const added of addedBodies) {
      if (added.includes(WS_FORWARD_FLAG) && added.split(WS_FORWARD_FLAG).join('') === body) return true;
    }
  }
  return false;
}

// #5190 (fixes #5178), a named single-purpose carve-out kept on the maintainer's ruling:
// `frontmatter.get` takes its field only as `--field <name>`, and quick.md's positional
// calls are the drift #5178 repairs. Row 48 would otherwise refuse the repair, while
// reverting it fails the frontmatter contract in planner-wave.md's step 8 ("Persist parsed
// frontmatter and recompute waves in ONE call"). Scope: exactly this flag insertion, on
// FIELD_FLAG_MIGRATION_PATHS only. A line counts only beside its positional twin, so paths,
// fields and every other divergence on a shared line stay guarded; the row-48 test below
// proves it.
// isFrontmatterFieldFlagMigration judges the pair's shape by Set membership;
// fieldFlagMigrationBudget then admits one added line per removed twin, so a
// surplus copy of a migrated line, or a lone half of a pair, is still phase work.
const positionalTwin = (line) => line.replace(
  /(\b(?:gsd_run|gsd-tools)\s+query\s+frontmatter\.get\s+(?:"[^"]*"|'[^']*'|[^\s]+))\s+--field\s+([\w.-]+)(`?)$/,
  '$1 $2$3',
);

function isFrontmatterFieldFlagMigration(sign, body, addedBodies, removedBodies) {
  if (sign === '+') {
    const twin = positionalTwin(body);
    return twin !== body && removedBodies.has(twin);
  }
  return [...addedBodies].some((added) => positionalTwin(added) !== added && positionalTwin(added) === body);
}

/** The row-48 paths #5190 migrates to `--field`; the carve-out applies on these paths only. */
const FIELD_FLAG_MIGRATION_PATHS = new Set([
  'commands/gsd/quick.md',
  'gsd-core/workflows/quick-batch/steps/planner-wave.md',
]);

/** How many copies of each `+`/`-` line the #5190 migration may exempt: one per matched pair. */
function fieldFlagMigrationBudget(added, removed) {
  const count = (list) => list.reduce((m, b) => m.set(b, (m.get(b) || 0) + 1), new Map());
  const addedCounts = count(added);
  const removedCounts = count(removed);
  const budget = new Map();
  for (const [body, n] of addedCounts) {
    const twin = positionalTwin(body);
    if (twin === body || !removedCounts.has(twin)) continue;
    const pairs = Math.min(n, removedCounts.get(twin) - (budget.get(`-${twin}`) || 0));
    if (pairs <= 0) continue;
    budget.set(`+${body}`, pairs);
    budget.set(`-${twin}`, (budget.get(`-${twin}`) || 0) + pairs);
  }
  return budget;
}

/**
 * Does this path's diff say anything beyond the shared response-language
 * directive (#2529)?
 *
 * The two accepted forms are read from `scripts/lint-response-language-coverage.cjs`
 * rather than restated here, so a reworded contract cannot leave this carve-out
 * matching prose the lint itself no longer recognizes as coverage. A file the
 * branch ADDED answers true, every line being new — which is what a real
 * #3676-phase branch looks like.
 *
 * #4834 adds the third mechanical-sweep carve-out, in the same family as the
 * #3730 and #2529-round-40 scopings below: a line that IS the canonical
 * launcher preamble is a `sync-runtime-launcher.cjs` propagation, not
 * quick-batch phase work. The snippet's byte changes reach every workflow in
 * one mechanical pass; treating them as ordinary-quick edits would freeze the
 * launcher out of quick.md forever, while the preamble's own content stays
 * policed by tests/runtime-launcher-parity.test.cjs and the emitted-attribution
 * gate. Any OTHER line — ordinary quick prose, steps, contracts — still trips
 * this row exactly as before.
 */
function editsBeyondSharedDirective(base, file) {
  return diffEditsBeyondSharedDirective(git(['diff', '--unified=0', `${base}...HEAD`, '--', file]), file);
}

/** The pure half of editsBeyondSharedDirective: reads one path's `--unified=0` diff text. */
function diffEditsBeyondSharedDirective(diff, file) {
  const diffLines = diff.split('\n');
  const bodiesOf = (sign) => diffLines
    .filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3)))
    .map((l) => l.slice(1).trim());
  const addedBodies = new Set(bodiesOf('+'));
  const removedBodies = new Set(bodiesOf('-'));
  const migrationBudget = FIELD_FLAG_MIGRATION_PATHS.has(file)
    ? fieldFlagMigrationBudget(bodiesOf('+'), bodiesOf('-'))
    : new Map();
  return diffLines.some((line) => {
    if (!/^[+-]/.test(line) || line.startsWith('+++') || line.startsWith('---')) return false;
    const body = line.slice(1).trim();
    if (isWorkstreamForwardingSweepLine(line[0], body, addedBodies, removedBodies)) return false;
    if (isFrontmatterFieldFlagMigration(line[0], body, addedBodies, removedBodies)) {
      const key = `${line[0]}${body}`;
      if ((migrationBudget.get(key) || 0) > 0) { migrationBudget.set(key, migrationBudget.get(key) - 1); return false; }
    }
    if (body === '' || body === INLINE_RESPONSE_LANGUAGE_DIRECTIVE) return false;
    if (body === CANONICAL_LAUNCHER_PREAMBLE.trim()) return false;
    if (looksLikeLauncherPreambleLine(body)) return false;
    // #4780 fourth mechanical-sweep carve-out: the labeled-arguments sweep adds
    // the standing <arguments> block (plus its note) to EVERY argument-taking
    // command and rewords each bare $ARGUMENTS splice to name that block. A
    // line that adds or removes the placeholder, or names the block, is that
    // sweep -- not quick-batch phase work. Any OTHER line still trips this row.
    if (body.includes('$ARGUMENTS') || body.includes('`<arguments>` block')) return false;
    if (body === '<arguments>$ARGUMENTS</arguments>' || body.startsWith('The text inside `<arguments>` is exactly what the user typed')) return false;
    // #5143 fifth mechanical-sweep carve-out: the argument-capture sweep gives every
    // shell fence that reads the typed text the same four-line quoted-heredoc capture
    // and renames each use to the captured variable. Those lines are that sweep -- not
    // quick-batch phase work. The exact capture lines and the renamed uses only.
    if (body === "IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true" || body === 'GSD_ARGS_END' || body === "GSD_ARGS=${GSD_ARGS%$'\\n'}") return false;
    if (/\$\{?GSD_ARGS\b/.test(body)) return false;
    return !importsDirectiveReference(body);
  });
}

describe('quick-batch: /gsd:quick command + workflow stay byte-identical (row 48)', () => {
  test('commands/gsd/quick.md and gsd-core/workflows/quick.md are not in this branch\'s changed-path set', (t) => {
    // Environmental skip (ADR-2719 §6 idiom) — same as tests/emitted-attribution.test.cjs:
    // a base ref is not universally resolvable (gsd-test's shallow-merged container
    // carries no origin/* remote-tracking refs). t.skip is REPORTED as skipped, unlike
    // a bare `return`, which node:test scores as a silent pass.
    const resolved = resolveBase();
    if (!resolved) {
      t.skip(
        'no base ref resolvable — tried ' + baseRefCandidates().join(', ') +
        '. Set GSD_EMITTED_BASE=<ref|sha> to run this regression check elsewhere.',
      );
      return;
    }

    const changed = resolveChangedPaths(resolved.ref);
    // #3730 review: row 48 is the #3676 PHASE's invariant — quick-batch adds new
    // call sites onto shared primitives without editing ordinary quick. Judging
    // every FUTURE branch by it would freeze quick.md forever (observed: the
    // #3730 migration note tripped this row on an unrelated branch). Scope the
    // row to branches that actually touch the quick-batch surface; an unrelated
    // branch's quick.md edit is none of this guard's business.
    // tests/ excluded: this guard file's own name matches, which would make
    // the scope check self-satisfying on every branch that edits it.
    // #2529 review round 40: a branch can touch the whole quick-batch surface
    // without being #3676 phase work. The response-language coverage sweep adds
    // one shared directive line to EVERY workflow, quick-batch.md and its
    // fragments included, which made this scope check true — and the row then
    // read that branch's ordinary-quick edit, the same one directive line, as a
    // phase violation. That is the false positive the #3730 note already scoped
    // this row away from, arriving by the other door: not a branch that misses
    // the surface, but one that touches all of it. So a path counts only when
    // its diff says something other than the coverage contract.
    const isPhaseWork = (p) => editsBeyondSharedDirective(resolved.ref, p);
    const touchesQuickBatch = changed.some((p) =>
      /quick-batch/.test(p) && !p.startsWith('tests/') && isPhaseWork(p));
    if (!touchesQuickBatch) {
      t.skip(
        `branch does no quick-batch phase work (${changed.length} changed paths; any ` +
        'quick-batch path it touches carries only the shared response-language directive) — ' +
        'row 48 governs #3676-phase branches only',
      );
      return;
    }
    // Same reading on both sides of the row: a directive-only edit is the
    // coverage contract every workflow carries, not a quick-batch edit.
    assert.ok(
      !quickWholeFileViolation(changed, isPhaseWork, 'commands/gsd/quick.md'),
      'commands/gsd/quick.md must stay untouched by the #3676 quick-batch phase',
    );
    assert.ok(
      !quickWholeFileViolation(changed, isPhaseWork, 'gsd-core/workflows/quick.md'),
      'gsd-core/workflows/quick.md must stay untouched by the #3676 quick-batch phase',
    );
    // The step fragments under quick/steps/ are likewise untouched — quick-batch
    // has its own, separate quick-batch/steps/ tree.
    //
    // plan-checker-loop.md is excluded (#3916 round 4): 2f64e6230 (#3676's own landing commit)
    // CREATED quick-batch/steps/plan-checker-loop.md as a new, independent 119-line file, not a
    // call-site into quick/'s copy — the "shared primitives" invariant this row protects was
    // never about this file, which was always meant to carry its own per-flow copy of whatever
    // revision-loop contract applies (same pattern as ui-phase.md/verify-work.md). A branch
    // fixing that contract in both independent copies is not the regression row 48 exists to
    // catch; same false-positive class already scoped away twice above (#3730, #2529 round 40).
    const touchedQuickSteps = unexpectedQuickStepChanges(changed, isPhaseWork);
    assert.deepEqual(touchedQuickSteps, [], `unexpected changes under gsd-core/workflows/quick/steps/: ${touchedQuickSteps.join(', ')}`);
  });

  test('the #5178 field-flag migration requires exact paired lines and preserves other quick edits', () => {
    const before = 'gsd-tools query frontmatter.get .planning/quick/{dir}/SUMMARY.md status';
    const after = 'gsd-tools query frontmatter.get .planning/quick/{dir}/SUMMARY.md --field status';
    const added = new Set([after]);
    const removed = new Set([before]);
    assert.equal(isFrontmatterFieldFlagMigration('+', after, added, removed), true);
    assert.equal(isFrontmatterFieldFlagMigration('-', before, added, removed), true);
    assert.equal(isFrontmatterFieldFlagMigration('+', after, added, new Set()), false);
    assert.equal(isFrontmatterFieldFlagMigration('-', before, new Set(), removed), false);
    for (const [positional, named] of [
      ['`gsd_run query frontmatter.get "${item_dir}/${quick_id}-PLAN.md" depends_on`',
        '`gsd_run query frontmatter.get "${item_dir}/${quick_id}-PLAN.md" --field depends_on`'],
      ['gsd_run query frontmatter.get "plans with spaces/PLAN.md" depends_on',
        'gsd_run query frontmatter.get "plans with spaces/PLAN.md" --field depends_on'],
    ]) {
      assert.equal(isFrontmatterFieldFlagMigration('+', named, new Set([named]), new Set([positional])), true);
      assert.equal(isFrontmatterFieldFlagMigration('-', positional, new Set([named]), new Set([positional])), true);
      assert.equal(isFrontmatterFieldFlagMigration('+', named, new Set([named]), new Set()), false);
      assert.equal(isFrontmatterFieldFlagMigration('-', positional, new Set(), new Set([positional])), false);
    }
    for (const changed of [
      after.replace('status', 'other_field'),
      after.replace('SUMMARY.md', 'PLAN.md'),
      after + ' changed prose',
      'gsd-tools query other.command file --field status',
    ]) {
      assert.equal(isFrontmatterFieldFlagMigration('+', changed, new Set([changed]), removed), false, changed);
      assert.equal(isFrontmatterFieldFlagMigration('-', before, new Set([changed]), removed), false, changed);
    }
  });

  test('the #5190 field-flag carve-out exempts nothing else: a non-field divergence on a shared line still trips row 48', () => {
    const QUICK_COMMAND = 'commands/gsd/quick.md';
    const before = 'gsd-tools query frontmatter.get .planning/quick/{dir}/SUMMARY.md status';
    const after = 'gsd-tools query frontmatter.get .planning/quick/{dir}/SUMMARY.md --field status';
    const diffOf = (removed, added) => [
      'diff --git a/commands/gsd/quick.md b/commands/gsd/quick.md',
      '--- a/commands/gsd/quick.md',
      '+++ b/commands/gsd/quick.md',
      '@@ -10 +10 @@',
      `-${removed}`,
      `+${added}`,
    ].join('\n');
    // The migration alone is the only shape the carve-out admits.
    assert.equal(diffEditsBeyondSharedDirective(diffOf(before, after), QUICK_COMMAND), false);
    // The same shared line, diverging in any way other than inserting --field, is phase work.
    for (const diverged of [
      after.replace('status', 'other_field'),
      after.replace('SUMMARY.md', 'PLAN.md'),
      `${after} changed prose`,
      before.replace('SUMMARY.md', 'PLAN.md'),
      'gsd-tools query other.command .planning/quick/{dir}/SUMMARY.md --field status',
    ]) {
      assert.equal(diffEditsBeyondSharedDirective(diffOf(before, diverged), QUICK_COMMAND), true, diverged);
    }
    // Unpaired or surplus lines are not the migration: a lone added call, a lone removal,
    // and a second copy of the migrated line beside one removal each trip the row.
    const lines = (...body) => ['--- a/commands/gsd/quick.md', '+++ b/commands/gsd/quick.md', '@@ -10 +10 @@', ...body].join('\n');
    assert.equal(diffEditsBeyondSharedDirective(lines(`+${after}`), QUICK_COMMAND), true);
    assert.equal(diffEditsBeyondSharedDirective(lines(`-${before}`), QUICK_COMMAND), true);
    assert.equal(diffEditsBeyondSharedDirective(lines(`-${before}`, `+${after}`, `+${after}`), QUICK_COMMAND), true);
    assert.equal(diffEditsBeyondSharedDirective(lines(`-${before}`, `-${before}`, `+${after}`), QUICK_COMMAND), true);
    assert.equal(diffEditsBeyondSharedDirective(lines(`-${before}`, `-${before}`, `+${after}`, `+${after}`), QUICK_COMMAND), false);
    // Through the row's own whole-file predicate, as the live check wires it.
    for (const [diff, violates] of [[diffOf(before, after), false], [lines(`+${after}`), true]]) {
      assert.equal(quickWholeFileViolation(['commands/gsd/quick.md'], () => diffEditsBeyondSharedDirective(diff, QUICK_COMMAND), 'commands/gsd/quick.md'), violates);
    }
    // Scope: only the two row-48 paths this PR migrates. The same pair anywhere else is phase work.
    assert.equal(diffEditsBeyondSharedDirective(diffOf(before, after), 'gsd-core/workflows/quick-batch/steps/planner-wave.md'), false);
    for (const outside of ['gsd-core/workflows/quick.md', 'gsd-core/workflows/quick/steps/quick-execution.md', 'gsd-core/workflows/quick-batch.md']) {
      assert.equal(diffEditsBeyondSharedDirective(diffOf(before, after), outside), true, outside);
    }
    // A migration pair beside one unrelated edit still trips the row.
    const mixed = `${diffOf(before, after)}\n@@ -20 +20 @@\n-Ordinary quick prose.\n+Ordinary quick prose, reworded.`;
    assert.equal(diffEditsBeyondSharedDirective(mixed, QUICK_COMMAND), true);
  });

  test('positive control: the #5118 allowance exempts exactly one path; every other quick path in the same branch shape still trips row 48', () => {
    // The live check above can only prove the row passes on THIS branch. Run
    // the same predicates over a synthetic branch of the exact shape that
    // needed the allowance (a quick-batch edit beside the quick-verification
    // edit), plus sibling quick paths, and prove the check still fails for them.
    const everyPathIsPhaseWork = () => true;
    const changed = [
      'gsd-core/workflows/quick-batch/steps/verification-wave.md',
      QUICK_VERIFICATION_STEP_5118,
      'gsd-core/workflows/quick/steps/quick-execution.md',
      // Lookalikes of the allowed path are NOT the allowed path (exact match only).
      'gsd-core/workflows/quick/steps/quick-verification.md.orig',
      'gsd-core/workflows/quick/steps/sub/quick-verification.md',
    ];
    assert.deepEqual(
      unexpectedQuickStepChanges(changed, everyPathIsPhaseWork),
      [
        'gsd-core/workflows/quick/steps/quick-execution.md',
        'gsd-core/workflows/quick/steps/quick-verification.md.orig',
        'gsd-core/workflows/quick/steps/sub/quick-verification.md',
      ],
    );
    // The two whole-file rows are untouched by the allowance.
    for (const wholeFile of ['commands/gsd/quick.md', 'gsd-core/workflows/quick.md']) {
      assert.equal(quickWholeFileViolation([...changed, wholeFile], everyPathIsPhaseWork, wholeFile), true, wholeFile);
    }
  });
});

/**
 * #5118 (ADR-5057 Phase 4, §R3): the ONE allowed ordinary-quick step edit.
 * `quick-verification.md`'s status read stops discarding stderr and names
 * `phase_dir_not_found` in its terminal arm — the closed VerificationStatus
 * contract every verification.status reader follows, not #3676 quick-batch
 * phase work. Exact path only: every other quick path stays covered.
 */
const QUICK_VERIFICATION_STEP_5118 = 'gsd-core/workflows/quick/steps/quick-verification.md';

/** Row 48's step-fragment predicate, shared by the live check and its positive control. */
function unexpectedQuickStepChanges(changed, isPhaseWork) {
  return changed
    .filter((p) => p.startsWith('gsd-core/workflows/quick/steps/'))
    .filter((p) => !p.endsWith('/plan-checker-loop.md'))
    .filter((p) => p !== QUICK_VERIFICATION_STEP_5118)
    .filter(isPhaseWork);
}

/** Row 48's whole-file predicate (commands/gsd/quick.md, workflows/quick.md). */
function quickWholeFileViolation(changed, isPhaseWork, filePath) {
  return changed.includes(filePath) && isPhaseWork(filePath);
}
