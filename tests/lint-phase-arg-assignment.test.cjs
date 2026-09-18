'use strict';

// #4777: unit tests for the PHASE_ARG assignment lint.
//
// Every arm drives the rule against a synthetic workflows directory rather
// than the live corpus. A test that only asserted "the real tree is clean"
// would pass just as happily against a rule that can detect nothing — which
// is the exact failure this lint exists to close, since the defect it guards
// (a read with no assignment anywhere in the file) was invisible to every
// existing gate for six months.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CANONICAL_FORMS,
  EXEMPT,
  DEFAULT_ROOT,
  inspect,
  scan,
} = require('../scripts/lint-phase-arg-assignment.cjs');
const { cleanup } = require('./helpers.cjs');

/** Write a synthetic workflows dir from `{ 'name.md': contents }`; returns its path. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4777-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return dir;
}

const bash = (...lines) => ['```bash', ...lines, '```', ''].join('\n');

describe('#4777 inspect', () => {
  test('a bash-block read with no assignment is unassigned', () => {
    const report = inspect(bash('INIT=$(gsd_run query init.phase-op "${PHASE_ARG}")'));
    assert.equal(report.reads, true);
    assert.deepEqual(report.assignments, []);
    assert.equal(report.hasProse, false);
  });

  test('a prose mention outside a bash block is not a read', () => {
    // "Phase ${PHASE_ARG} not found" in an error-message example is
    // documentation. Treating it as a consumption would make the rule fire on
    // files that never run the variable.
    const report = inspect('The workflow prints `Phase ${PHASE_ARG} not found.`\n');
    assert.equal(report.reads, false);
  });

  test('each canonical form is recognised and none is flagged as drift', () => {
    for (const form of Object.values(CANONICAL_FORMS)) {
      const report = inspect(bash(form, 'INIT=$(q "${PHASE_ARG}")'));
      assert.deepEqual(report.nonCanonical, [], `flagged as drift: ${form}`);
      assert.equal(report.assignsBeforeRead, true);
    }
  });

  test('a hand-rolled pipeline is drift even though it assigns', () => {
    const report = inspect(bash('PHASE_ARG=$(echo "$ARGUMENTS" | cut -d" " -f1)', 'INIT=$(q "${PHASE_ARG}")'));
    assert.equal(report.nonCanonical.length, 1);
  });

  test('indentation does not decide the verdict', () => {
    const report = inspect(bash(`  ${CANONICAL_FORMS.firstPositional}`, 'INIT=$(q "${PHASE_ARG}")'));
    assert.deepEqual(report.nonCanonical, []);
  });

  test('a prose derivation step counts as saying where the value comes from', () => {
    const arrow = inspect(`- First positional token → \`PHASE_ARG\`\n\n${bash('INIT=$(q "${PHASE_ARG}")')}`);
    assert.equal(arrow.hasProse, true);
    const store = inspect(`- Phase number → store as \`$PHASE_ARG\`\n\n${bash('INIT=$(q "${PHASE_ARG}")')}`);
    assert.equal(store.hasProse, true);
  });

  test('an assignment after the first read does not count as assigned before it', () => {
    const report = inspect(bash('INIT=$(q "${PHASE_ARG}")', CANONICAL_FORMS.firstPositional));
    assert.equal(report.assignsBeforeRead, false);
  });
});

describe('#4777 scan', () => {
  let dir = null;
  const t = (files) => { dir = fixture(files); return scan(dir, new Map()); };

  test('reports the shipped defect: a read with no assignment', () => {
    // The literal shape of secure-phase.md / validate-phase.md before the fix.
    const result = t({ 'secure-phase.md': bash('INIT=$(gsd_run query init.phase-op "${PHASE_ARG}")') });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].kind, 'unassigned');
    assert.equal(result.violations[0].file, 'secure-phase.md');
  });

  test('accepts a file carrying a canonical assignment before the read', () => {
    const result = t({ 'ok.md': bash(CANONICAL_FORMS.positional, 'INIT=$(q "${PHASE_ARG}")') });
    assert.deepEqual(result.violations, []);
    assert.equal(result.scanned, 1);
  });

  test('flags a late assignment separately from a missing one', () => {
    const result = t({ 'late.md': bash('INIT=$(q "${PHASE_ARG}")', CANONICAL_FORMS.positional) });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].kind, 'late-assignment');
  });

  test('walks nested step directories', () => {
    const result = t({ 'steps/dispatch.md': bash('FIX_ARGS="${PHASE_ARG}"') });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'steps/dispatch.md');
  });

  test('a file that neither reads nor assigns is not scanned', () => {
    const result = t({ 'unrelated.md': bash('echo hello') });
    assert.equal(result.scanned, 0);
    assert.deepEqual(result.violations, []);
  });

  test('an exemption suppresses the violation and is reported as used', () => {
    dir = fixture({ 'child.md': bash('INIT=$(q "${PHASE_ARG}")') });
    const result = scan(dir, new Map([['child.md', 'assigned by its parent']]));
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.staleExemptions, []);
  });

  test('an exemption for a file that no longer needs one is stale', () => {
    dir = fixture({ 'child.md': bash(CANONICAL_FORMS.firstPositional, 'INIT=$(q "${PHASE_ARG}")') });
    const result = scan(dir, new Map([['child.md', 'assigned by its parent']]));
    assert.deepEqual(result.violations, []);
    assert.equal(result.staleExemptions.length, 1);
  });

  test.afterEach(() => { if (dir) cleanup(dir); dir = null; });
});

describe('#4777 the shipped tree', () => {
  test('every workflow that reads PHASE_ARG says where it comes from', () => {
    // The corpus assertion is deliberately LAST: it is meaningful only
    // because the arms above prove the rule can fail.
    const result = scan(DEFAULT_ROOT, EXEMPT);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.staleExemptions, []);
  });

  test('the seven regressed workflows now derive the phase before using it', () => {
    // Named individually so a future edit that drops one assignment fails on
    // that file rather than on an aggregate count.
    const regressed = [
      'secure-phase.md', 'validate-phase.md', 'ui-review.md',
      'eval-review.md', 'ship.md', 'extract-learnings.md', 'review.md',
    ];
    for (const rel of regressed) {
      const report = inspect(fs.readFileSync(path.join(DEFAULT_ROOT, rel), 'utf8'));
      assert.equal(report.reads, true, `${rel}: expected a PHASE_ARG read`);
      assert.equal(report.assignments.length > 0, true, `${rel}: no PHASE_ARG assignment`);
      assert.deepEqual(report.nonCanonical, [], `${rel}: non-canonical assignment`);
      assert.equal(report.assignsBeforeRead, true, `${rel}: assigned after first use`);
    }
  });
});
