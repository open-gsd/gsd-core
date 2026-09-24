'use strict';

/**
 * Tests for src/undo-commit-selection.cts (compiled to
 * gsd-core/bin/lib/undo-commit-selection.cjs) and the
 * `gsd-tools.cjs query select-revert-commits` CLI subcommand it backs.
 *
 * Issue #4661 (absorbed into epic #4906, Phase 5) — regression coverage for
 * the four documented bug classes in the retired
 * `git log --oneline | grep -E ...` selection pipelines that used to live in
 * `gsd-core/workflows/undo.md`:
 *   1. id interpolated raw into a live ERE (`.`/`+` as metacharacters)
 *   2. unanchored match (a MENTION of a scope selected as a DECLARATION)
 *   3. phase-mode vs plan-mode disagreement on a breaking-change subject
 *   4. the anchored-`git log --oneline` "fix" trap (drops fixup!/Revert
 *      wrappers, blind under `color.ui=always`)
 *
 * Structure:
 *   1. UNIT        — selectCommitsByDeclaredScope, direct
 *   2. PROPERTY     — generative parity between the selector and an
 *                     independently-derived expectation (seeded fast-check)
 *   3. CLI BOUNDARY — gsd-tools.cjs query select-revert-commits, spawned,
 *                     against a real temp git repo (validation + selection)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');

const {
  selectCommitsByDeclaredScope,
} = require('../gsd-core/bin/lib/undo-commit-selection.cjs');

// ─── 1. UNIT — selectCommitsByDeclaredScope ────────────────────────────────

describe('selectCommitsByDeclaredScope: declared-scope matching', () => {
  test('exact-scope commit selects for its own plan id (plan mode) and phase id (phase mode)', () => {
    const commits = [{ sha: 'a', subject: 'feat(03-01): the real work' }];

    const plan = selectCommitsByDeclaredScope(commits, '03-01', 'plan');
    assert.equal(plan.selected.length, 1);
    assert.equal(plan.classified[0].parsedScope, '03-01');
    assert.equal(plan.classified[0].matched, true);

    const phase = selectCommitsByDeclaredScope(commits, '03', 'phase');
    assert.equal(phase.selected.length, 1);
    assert.equal(phase.classified[0].matched, true);
  });

  test('regression evidence: the pure function is already padding-agnostic — zero-pad tolerance is a CLI-boundary concern, not this function\'s', () => {
    // The retired grep's `0*` prefix tolerated an unpadded user phase number
    // (`--phase 3` matching `feat(03-01):`). That tolerance is restored at
    // the gsd-tools.cjs CLI boundary (normalizePhaseName, src/phase-id.cts)
    // BEFORE targetId ever reaches this function — selectCommitsByDeclaredScope
    // itself needs no change, because it is pure string-equality and already
    // works correctly once given an already-zero-padded targetId, as here.
    const commits = [{ sha: 'a', subject: 'feat(03-01): the real work' }];
    const phase = selectCommitsByDeclaredScope(commits, '03', 'phase');
    assert.equal(phase.selected.length, 1);
    // An UNPADDED targetId, by contrast, correctly does NOT match here — this
    // function never zero-pads on its own, confirming the fix belongs at the
    // caller (CLI) boundary, not inside this pure comparison.
    const unpadded = selectCommitsByDeclaredScope(commits, '3', 'phase');
    assert.equal(unpadded.selected.length, 0);
  });

  test('fixup! wrapper is unwrapped one level and still selects', () => {
    const commits = [{ sha: 'a', subject: 'fixup! feat(03-01): the real work' }];
    const phase = selectCommitsByDeclaredScope(commits, '03', 'phase');
    const plan = selectCommitsByDeclaredScope(commits, '03-01', 'plan');
    assert.equal(phase.classified[0].parsedScope, '03-01');
    assert.equal(phase.selected.length, 1);
    assert.equal(plan.selected.length, 1);
  });

  test('squash! wrapper is unwrapped one level and still selects', () => {
    const commits = [{ sha: 'a', subject: 'squash! feat(03-01): the real work' }];
    const result = selectCommitsByDeclaredScope(commits, '03-01', 'plan');
    assert.equal(result.classified[0].parsedScope, '03-01');
    assert.equal(result.selected.length, 1);
  });

  test('Revert "..." wrapper is unwrapped one level and still selects', () => {
    const commits = [{ sha: 'a', subject: 'Revert "feat(03-01): the real work"' }];
    const result = selectCommitsByDeclaredScope(commits, '03-01', 'plan');
    assert.equal(result.classified[0].parsedScope, '03-01');
    assert.equal(result.selected.length, 1);
  });

  test('bug class 3 regression: breaking-change marker selects identically in phase and plan mode', () => {
    const commits = [{ sha: 'a', subject: 'feat(03-01)!: breaking change' }];
    const phase = selectCommitsByDeclaredScope(commits, '03', 'phase');
    const plan = selectCommitsByDeclaredScope(commits, '03-01', 'plan');
    assert.equal(phase.classified[0].parsedScope, '03-01');
    assert.equal(plan.classified[0].parsedScope, '03-01');
    assert.equal(phase.selected.length, 1, 'phase mode must select the breaking-change commit');
    assert.equal(plan.selected.length, 1, 'plan mode must select the breaking-change commit');
  });

  test('bug class 2 regression: a MENTION of a scope is not a DECLARATION of it', () => {
    const commits = [{
      sha: 'a',
      subject: 'docs(99-01): explain feat(03-01): commit convention',
    }];
    const result = selectCommitsByDeclaredScope(commits, '03', 'phase');
    assert.equal(result.classified[0].parsedScope, '99-01');
    assert.equal(result.selected.length, 0);
  });

  test('a header with no scope group is excluded, never crashes', () => {
    const commits = [{ sha: 'a', subject: 'chore: bump (03-01) ref in the lockfile' }];
    const result = selectCommitsByDeclaredScope(commits, '03-01', 'plan');
    assert.equal(result.classified[0].parsedScope, null);
    assert.equal(result.selected.length, 0);
  });

  test('a freeform subject with no conventional header parses to null scope, no crash', () => {
    const commits = [{ sha: 'a', subject: 'wip: fiddling around, not a real commit' }];
    assert.doesNotThrow(() => {
      const result = selectCommitsByDeclaredScope(commits, '03', 'phase');
      assert.equal(result.classified[0].parsedScope, null);
      assert.equal(result.selected.length, 0);
    });
  });

  test('bug class 1 regression: string equality, never a live regex — "." is not a wildcard', () => {
    // The retired grep interpolated the id into an ERE, so a target of
    // "23.1.2" wrongly matched "23.112-01" (the "." wildcarding across
    // digits). Exact string comparison must NOT match here.
    const commits = [{ sha: 'a', subject: 'feat(23.112-01): unrelated phase' }];
    const phase = selectCommitsByDeclaredScope(commits, '23.1.2', 'phase');
    assert.equal(phase.classified[0].parsedScope, '23.112-01');
    assert.equal(phase.selected.length, 0, '"23.1.2" must not match "23.112-01" via string prefix');
  });

  test('doubly-wrapped subject (Revert "Revert "...") is unparseable after one unwrap — null, no crash', () => {
    const commits = [{
      sha: 'a',
      subject: 'Revert "Revert "feat(03-01): work""',
    }];
    assert.doesNotThrow(() => {
      const result = selectCommitsByDeclaredScope(commits, '03-01', 'plan');
      assert.equal(result.classified[0].parsedScope, null);
      assert.equal(result.selected.length, 0);
    });
  });

  test('phase mode also selects a plan-scoped commit within the phase', () => {
    const commits = [{ sha: 'a', subject: 'feat(03-99): plan-scoped work' }];
    const result = selectCommitsByDeclaredScope(commits, '03', 'phase');
    assert.equal(result.selected.length, 1);
  });

  test('phase mode does not select an unrelated phase that merely shares a prefix digit', () => {
    const commits = [{ sha: 'a', subject: 'feat(031-01): a different phase entirely' }];
    const result = selectCommitsByDeclaredScope(commits, '03', 'phase');
    assert.equal(result.selected.length, 0);
  });

  test('empty commit list returns empty selection and classification', () => {
    const result = selectCommitsByDeclaredScope([], '03', 'phase');
    assert.deepEqual(result.selected, []);
    assert.deepEqual(result.classified, []);
  });
});

// ─── 2. PROPERTY — generative parity with an independent expectation ──────

describe('selectCommitsByDeclaredScope: property', () => {
  // fast-check v4 (pinned `^4.8.0`): `fc.stringOf` does not exist — use
  // `fc.string({ unit: fc.constantFrom(...) })` instead (see
  // tests/emitted-attribution.test.cjs for the same convention).
  const idSegmentArb = fc.string({ unit: fc.constantFrom(..."0123456789".split('')), minLength: 1, maxLength: 3 });
  const unrelatedScopeArb = fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split('')),
    minLength: 1,
    maxLength: 8,
  });
  const typeArb = fc.constantFrom('feat', 'fix', 'docs', 'chore', 'enhance', 'perf', 'refactor');
  const wrapperArb = fc.constantFrom('none', 'fixup!', 'squash!', 'revert');
  const messageArb = fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz ,.".split('')),
    minLength: 0,
    maxLength: 20,
  });
  const modeArb = fc.constantFrom('phase', 'plan');

  // Scope shape: absent, exact match, phase-prefixed match, or an unrelated string.
  const scopeCaseArb = fc.constantFrom('absent', 'exact', 'phase-prefixed', 'unrelated');

  function buildHeader(type, scope, breaking, message) {
    const scopePart = scope === null ? '' : `(${scope})`;
    return `${type}${scopePart}${breaking ? '!' : ''}: ${message}`;
  }

  function applyWrapper(wrapper, header) {
    if (wrapper === 'fixup!') return `fixup! ${header}`;
    if (wrapper === 'squash!') return `squash! ${header}`;
    if (wrapper === 'revert') return `Revert "${header}"`;
    return header;
  }

  // Independent expectation — NOT derived by calling the code under test.
  // A single wrapper level always unwraps back to exactly `header`, so the
  // expected parsed scope is `scope` regardless of which wrapper was chosen.
  function expectedMatch(mode, scope, targetId) {
    if (scope === null) return false;
    if (mode === 'phase') return scope === targetId || scope.startsWith(`${targetId}-`);
    return scope === targetId;
  }

  test('matched iff the independently-derived expectation says so (seed 42, numRuns 200 — tests/helpers/fast-check-setup.cjs)', () => {
    fc.assert(
      fc.property(
        idSegmentArb, // targetId
        idSegmentArb, // phase-prefixed suffix
        typeArb,
        scopeCaseArb,
        fc.boolean(), // breaking
        wrapperArb,
        messageArb,
        modeArb,
        unrelatedScopeArb,
        (targetId, suffix, type, scopeCase, breaking, wrapper, message, mode, unrelated) => {
          let scope;
          if (scopeCase === 'absent') scope = null;
          else if (scopeCase === 'exact') scope = targetId;
          else if (scopeCase === 'phase-prefixed') scope = `${targetId}-${suffix}`;
          else scope = unrelated;

          const header = buildHeader(type, scope, breaking, message);
          const subject = applyWrapper(wrapper, header);

          const result = selectCommitsByDeclaredScope([{ sha: 'x', subject }], targetId, mode);
          const expected = expectedMatch(mode, scope, targetId);

          assert.equal(result.classified[0].parsedScope, scope);
          assert.equal(result.classified[0].matched, expected);
        },
      ),
    );
  });
});

// ─── 3. CLI BOUNDARY — gsd-tools.cjs query select-revert-commits ──────────

describe('gsd-tools.cjs query select-revert-commits: CLI boundary', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir('undo-commit-selection-');
    // #4906/local/no-unbounded-spawn: every git fixture call below is bounded
    // (DEFECT.UNBOUNDED-SUBPROCESS) — a hung fixture setup must fail loudly,
    // not hang the run silently.
    const GIT_TIMEOUT_MS = 15_000;
    execFileSync('git', ['init', '-q'], { cwd: tmpDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, timeout: GIT_TIMEOUT_MS });

    const filePath = path.join(tmpDir, 'f.txt');
    const subjects = [
      'feat(03-01): the real work',
      'fixup! feat(03-01): the real work',
      'docs(99-01): explain feat(03-01): commit convention',
      'feat(03-01)!: breaking change',
      'feat(PROJ-42): bracket-style scope',
      'feat(42-01): unrelated plain-numeric phase 42',
    ];
    subjects.forEach((subject, i) => {
      fs.appendFileSync(filePath, `line ${i}\n`);
      execFileSync('git', ['add', 'f.txt'], { cwd: tmpDir, timeout: GIT_TIMEOUT_MS });
      // -F reads the message from a temp file: avoids shell/argv quoting of
      // subjects that themselves contain parentheses and colons.
      const msgFile = path.join(tmpDir, `.msg-${i}`);
      fs.writeFileSync(msgFile, subject);
      execFileSync('git', ['commit', '-q', '-F', msgFile], { cwd: tmpDir, timeout: GIT_TIMEOUT_MS });
      fs.unlinkSync(msgFile);
    });
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('refuses an invalid --phase before running any git command (validatePhaseNumber at the boundary)', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--phase', '03+', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid --phase/);
  });

  test('refuses a malformed trailing-dot --phase', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--phase', '03.', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid --phase/);
  });

  test('refuses a 3-segment plan id today — split-on-first-dash is a deliberate two-segment assumption, not a silent mis-parse', () => {
    // docs/reference/plan-md.md and every --plan usage in gsd-core/workflows/*.md
    // document only the plain two-segment `NN-MM` plan-id shape; no function in
    // src/phase-id.cts (parsePhaseId, getPhaseDirFromPhaseId) validates a
    // phase-PLAN grammar end-to-end (see the comment at the call site in
    // gsd-tools.cjs), so a 3-segment id is refused rather than guessed. This
    // pins TODAY's actual behavior: splitting "03-01-02" on the first `-`
    // leaves "01-02" as the plan segment, which validatePhaseNumber rejects
    // (no dash support in either of its branches) — a false refusal for a
    // hypothetical 3-segment plan id, but a safe (fail-closed) one, and this
    // shape does not occur in practice today.
    const result = runGsdTools(['query', 'select-revert-commits', '--plan', '03-01-02', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid --plan/);
    assert.match(result.error, /plan segment/);
  });

  test('bracket-style phase segment in --plan is refused', () => {
    // A bracket-style phase id (`PROJ-42`) needs its OWN internal dash to
    // pass validatePhaseNumber's bracket branch. Splitting `PROJ-42-01` on
    // the FIRST `-` gives phase segment `PROJ` (no internal dash — fails)
    // and plan segment `42-01` (never checked, since the phase segment
    // already fails first). Bracket-style ids are supported for `--phase`
    // only (see "bracket-style --phase PROJ-42 selects..." above), never as
    // a `--plan` segment — pinning today's actual refusal deliberately, per
    // the same "no real usage found" standard the 3-segment numeric case
    // above documents.
    const result = runGsdTools(['query', 'select-revert-commits', '--plan', 'PROJ-42-01', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid --plan/);
    assert.match(result.error, /phase segment/);
  });

  test('refuses when neither --phase nor --plan is given', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, false);
    assert.match(result.error, /exactly one of --phase/);
  });

  test('refuses when both --phase and --plan are given', () => {
    const result = runGsdTools(
      ['query', 'select-revert-commits', '--phase', '03', '--plan', '03-01', '--range', 'HEAD', '--raw'],
      tmpDir,
    );
    assert.equal(result.success, false);
    assert.match(result.error, /exactly one of --phase/);
  });

  test('phase mode selects the phase-scoped, fixup!-wrapped, and breaking-change commits, not the mention-only docs commit', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--phase', '03', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, true, result.error);
    const lines = result.output.split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `expected 3 selected commits, got:\n${result.output}`);
    assert.ok(lines.every((l) => !l.includes('docs(99-01)')), 'the mention-only docs commit must not be selected');
  });

  test('plan mode selects the exact-scope commits and the breaking-change commit (bug class 3 parity)', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--plan', '03-01', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, true, result.error);
    const lines = result.output.split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `expected 3 selected commits, got:\n${result.output}`);
  });

  test('non-raw output is structured JSON with selected + classified', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--phase', '03', '--range', 'HEAD'], tmpDir);
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.ok(Array.isArray(parsed.selected));
    assert.ok(Array.isArray(parsed.classified));
    assert.equal(parsed.classified.length, 6);
  });

  test('regression: unpadded --phase 3 still selects a commit scoped feat(03-01) — the retired grep\'s 0* tolerance, restored via normalizePhaseName', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--phase', '3', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, true, result.error);
    const lines = result.output.split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `expected 3 selected commits (same as padded --phase 03), got:\n${result.output}`);
    assert.ok(lines.every((l) => l.includes('(03-01)') || l.includes('(03-01)!')), `expected only phase-03 commits, got:\n${result.output}`);
  });

  test('regression: unpadded --plan 3-1 still selects a commit scoped feat(03-01)', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--plan', '3-1', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, true, result.error);
    const lines = result.output.split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `expected 3 selected commits (same as padded --plan 03-01), got:\n${result.output}`);
  });

  test('bracket-style --phase PROJ-42 selects its own commit and does NOT get stripped to plain phase 42', () => {
    const result = runGsdTools(['query', 'select-revert-commits', '--phase', 'PROJ-42', '--range', 'HEAD', '--raw'], tmpDir);
    assert.equal(result.success, true, result.error);
    const lines = result.output.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `expected exactly the PROJ-42 commit, got:\n${result.output}`);
    assert.ok(lines[0].includes('(PROJ-42)'), `expected the PROJ-42 commit, got:\n${result.output}`);
    assert.ok(
      !lines.some((l) => l.includes('unrelated plain-numeric phase 42')),
      'PROJ-42 must not be normalized/stripped down to a bare "42" match',
    );
  });
});
