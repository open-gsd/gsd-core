'use strict';

/**
 * #4619 — execute-phase's `$((10#{phase_number}))` shell arithmetic is a hard
 * syntax error when `{phase_number}` is decimal (inserted phase, e.g. `01.1`) or
 * N-segment (e.g. `23.1.2`): `$((10#01.1))` aborts the whole script in a
 * non-interactive shell, both in bash and zsh. The fix zero-strips only the
 * LEADING integer segment via parameter expansion and keeps the remainder as an
 * escaped-dot string for the downstream anchored ERE — never touching real
 * shell arithmetic on a non-integer value.
 *
 * These tests are BEHAVIORAL: they execute the actual fixed snippet (and, for
 * the regression control, the actual OLD broken snippet) via a real bash
 * subprocess, asserting on literal stdout/exit-code — not just string-matching
 * the source. A companion sourcetext check (mirroring the established pattern
 * in tests/safe-resume-gate-anchoring.test.cjs) proves each of the 4 real
 * production sites still carries a byte-identical copy of the fixed logic
 * (under each site's own variable-name spelling), so a future accidental
 * revert of any ONE site is caught.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXECUTE_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const COMPLETION_RECONCILIATION = path.join(__dirname, '..', 'gsd-core', 'workflows',
  'execute-phase', 'steps', 'completion-reconciliation.md');
const TDD_REF = path.join(__dirname, '..', 'gsd-core', 'references', 'tdd.md');

const TIMEOUT = 5000;

// The fixed transformation, parameterized by (source variable, target prefix) — this
// is a byte-for-byte copy of what ships at all 4 sites:
//   site 1/2 (execute-phase.md):              source PHASE_NUMBER, prefix PHASE
//   site 3   (completion-reconciliation.md):   source SPOT_PHASE_NUMBER, prefix SPOT_PHASE
//   site 4   (tdd.md):                         source PHASE, prefix PHASE
function fixedSnippet(sourceVar, prefix, indent = '') {
  return `${indent}${prefix}_INT=\${${sourceVar}%%.*}; ${prefix}_FRAC=\${${sourceVar}#"$${prefix}_INT"}\n` +
    `${indent}${prefix}_N="$((10#$${prefix}_INT))\${${prefix}_FRAC//./\\\\.}"`;
}

function runFixed(phaseNumberValue) {
  const script = `PHASE_NUMBER="${phaseNumberValue}"\n${fixedSnippet('PHASE_NUMBER', 'PHASE')}\necho "$PHASE_N"`;
  return execFileSync('bash', [], { input: script, encoding: 'utf8', timeout: TIMEOUT }).trim();
}

describe('#4619 — execute-phase decimal/N-segment phase-number arithmetic', () => {
  test('fixed snippet zero-strips the leading integer segment for a decimal phase (01.1 -> 1\\.1)', () => {
    assert.equal(runFixed('01.1'), '1\\.1');
  });

  test('fixed snippet zero-strips the leading integer segment for an N-segment phase (23.1.2 -> 23\\.1\\.2)', () => {
    assert.equal(runFixed('23.1.2'), '23\\.1\\.2');
  });

  test('regression control: a plain unpadded phase number is unchanged (12 -> 12)', () => {
    assert.equal(runFixed('12'), '12');
  });

  test('regression control: a padded plain phase number is still zero-stripped (01 -> 1)', () => {
    assert.equal(runFixed('01'), '1');
  });

  test('failing-first: the OLD $((10#...)) form is a hard shell syntax error on a decimal phase number', () => {
    assert.throws(() => {
      execFileSync('bash', ['-c', 'echo $((10#01.1))'], { encoding: 'utf8', timeout: TIMEOUT });
    }, /syntax error|status/);
  });

  test('the NEW form succeeds on the exact same input that hard-errors the OLD form', () => {
    assert.doesNotThrow(() => runFixed('01.1'));
  });

  test('the resulting anchored ERE matches decimal commit scopes and rejects near-miss scopes', () => {
    const phaseN = runFixed('01.1'); // '1\.1'
    const planN = '3';
    const re = `^[a-z]+\\((0*${phaseN})-(0*${planN})\\):`;
    const cases = [
      ['feat(01.1-03):', true],
      ['test(1.1-3):', true],
      ['feat(01-03):', false],
      ['feat(01.2-03):', false],
      ['feat(011-03):', false],
      ['feat(12-03):', false],
    ];
    for (const [subject, expected] of cases) {
      const script = `echo ${JSON.stringify(subject)} | grep -qE ${JSON.stringify(re)}`;
      let matched;
      try {
        execFileSync('bash', [], { input: script, encoding: 'utf8', timeout: TIMEOUT });
        matched = true;
      } catch {
        matched = false;
      }
      assert.equal(matched, expected, `expected ${subject} match=${expected} against ${re}`);
    }
  });

  test('the resulting anchored ERE matches a plain padded-integer phase and rejects near-miss scopes', () => {
    const phaseN = runFixed('01'); // '1'
    const planN = '3';
    const re = `^[a-z]+\\((0*${phaseN})-(0*${planN})\\):`;
    const cases = [
      ['feat(01-03):', true],
      ['feat(01.1-03):', false],
      ['feat(011-03):', false],
      ['feat(12-03):', false],
    ];
    for (const [subject, expected] of cases) {
      const script = `echo ${JSON.stringify(subject)} | grep -qE ${JSON.stringify(re)}`;
      let matched;
      try {
        execFileSync('bash', [], { input: script, encoding: 'utf8', timeout: TIMEOUT });
        matched = true;
      } catch {
        matched = false;
      }
      assert.equal(matched, expected, `expected ${subject} match=${expected} against ${re}`);
    }
  });

  describe('source parity — each of the 4 production sites carries the fixed logic', () => {
    test('execute-phase.md safe_resume_gate carries the fixed PHASE_NUMBER/PHASE_INT/PHASE_FRAC/PHASE_N logic', () => {
      const w = fs.readFileSync(EXECUTE_PHASE, 'utf8');
      assert.ok(w.includes(fixedSnippet('PHASE_NUMBER', 'PHASE')),
        'safe_resume_gate must carry the byte-identical fixed decimal-tolerant snippet');
    });

    test('execute-phase.md TDD gate carries the fixed PHASE_NUMBER/PHASE_INT/PHASE_FRAC/PHASE_N logic', () => {
      const w = fs.readFileSync(EXECUTE_PHASE, 'utf8');
      // The TDD gate block is nested one level deeper (4-space indent) than
      // safe_resume_gate's top-level snippet.
      assert.ok(w.includes(fixedSnippet('PHASE_NUMBER', 'PHASE', '    ')),
        'the TDD gate must carry the byte-identical fixed decimal-tolerant snippet (indented)');
    });

    test('completion-reconciliation.md carries the fixed SPOT_-prefixed logic', () => {
      const frag = fs.readFileSync(COMPLETION_RECONCILIATION, 'utf8');
      assert.ok(frag.includes(fixedSnippet('SPOT_PHASE_NUMBER', 'SPOT_PHASE')),
        'completion-reconciliation spot-check must carry the byte-identical fixed SPOT_-prefixed snippet');
    });

    test('tdd.md carries the fixed bare PHASE/PLAN logic', () => {
      const ref = fs.readFileSync(TDD_REF, 'utf8');
      assert.ok(ref.includes(fixedSnippet('PHASE', 'PHASE')),
        'tdd.md gate-enforcement example must carry the byte-identical fixed bare-PHASE snippet');
    });

    test('none of the 4 sites still contains the old unconditional $((10#...)) form on a template/variable phase number', () => {
      const w = fs.readFileSync(EXECUTE_PHASE, 'utf8');
      const frag = fs.readFileSync(COMPLETION_RECONCILIATION, 'utf8');
      const ref = fs.readFileSync(TDD_REF, 'utf8');
      assert.ok(!w.includes('PHASE_N=$((10#{phase_number}))'), 'old broken form must not remain in execute-phase.md (site 1)');
      assert.ok(!w.includes('PHASE_N=$((10#${PHASE_NUMBER}))'), 'old broken form must not remain in execute-phase.md (site 2)');
      assert.ok(!frag.includes('SPOT_PHASE_N=$((10#{phase_number}))'), 'old broken form must not remain in completion-reconciliation.md (site 3)');
      assert.ok(!ref.includes('PHASE_N=$((10#${PHASE}))'), 'old broken form must not remain in tdd.md (site 4)');
    });
  });
});
