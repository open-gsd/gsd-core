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
const { planSubjectPattern } = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

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
// #4748: the split is at the first NON-DIGIT, not the first dot, so a letter
// suffix (`03A`, `23A.1.2`) rides through in the rest instead of aborting the
// base-10 arithmetic; the rest is `_REST`, no longer only a `_FRAC`.
function fixedSnippet(sourceVar, prefix, indent = '') {
  return `${indent}${prefix}_INT=\${${sourceVar}%%[!0-9]*}; ${prefix}_REST=\${${sourceVar}#"$${prefix}_INT"}\n` +
    `${indent}${prefix}_N="$((10#$${prefix}_INT))\${${prefix}_REST//./\\\\.}"`;
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

  test('#4748: a letter-suffixed phase number keeps its letter and zero-strips the digit run (03A -> 3A, 23A.1.2 -> 23A\\.1\\.2)', () => {
    assert.equal(runFixed('03A'), '3A');
    assert.equal(runFixed('23A.1.2'), '23A\\.1\\.2');
  });

  test('failing-first: the OLD $((10#...)) form is a hard shell syntax error on a decimal phase number', () => {
    assert.throws(() => {
      execFileSync('bash', ['-c', 'echo $((10#01.1))'], { encoding: 'utf8', timeout: TIMEOUT });
    }, /syntax error|status/);
  });

  test('the NEW form succeeds on the exact same input that hard-errors the OLD form', () => {
    assert.doesNotThrow(() => runFixed('01.1'));
  });

  // Run every (subject, expected) case for one regex in a SINGLE bash subprocess
  // instead of one execFileSync per case. This repo's own timeout-vs-cost rule
  // (never widen a timeout to paper over the real cost) applies here: the
  // real cost was N real process forks per test, which is what made this test
  // flaky under a loaded CI runner (each case's spawn+pipe competing for the
  // same fork/exec budget as every other subprocess-heavy test running
  // concurrently in the same chunk) -- observed as one case's execFileSync
  // landing almost exactly on TIMEOUT (5054ms vs the file's 5000ms constant)
  // while sibling cases ran in single-digit milliseconds, on a run where no
  // case's grep logic was actually wrong (verified independently against real
  // macOS bash 3.2 + BSD grep). One spawn evaluating all cases removes every
  // opportunity for cross-test contention to land on any ONE case's timeout,
  // without touching TIMEOUT itself.
  function matchAll(re, cases) {
    const script = cases
      .map(([subject], i) => `echo ${JSON.stringify(subject)} | grep -qE ${JSON.stringify(re)} && echo ${i}:1 || echo ${i}:0`)
      .join('\n');
    const output = execFileSync('bash', [], { input: script, encoding: 'utf8', timeout: TIMEOUT });
    const results = new Array(cases.length).fill(null);
    for (const line of output.trim().split('\n')) {
      const [idx, flag] = line.split(':');
      results[Number(idx)] = flag === '1';
    }
    return results;
  }

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
    const results = matchAll(re, cases);
    cases.forEach(([subject, expected], i) => {
      assert.equal(results[i], expected, `expected ${subject} match=${expected} against ${re}`);
});
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
    const results = matchAll(re, cases);
    cases.forEach(([subject, expected], i) => {
      assert.equal(results[i], expected, `expected ${subject} match=${expected} against ${re}`);
});
  });

  describe('source parity — the one remaining shell site carries the fixed logic; the workflow sites ask the resolver (#5164)', () => {
    // #5164 (epic #5056 Phase 7): the three workflow sites (execute-phase.md safe_resume_gate and
    // TDD gate, completion-reconciliation.md) no longer derive the scope regex in shell: they ask
    // `check evaluation-scope --plan`, whose pattern is `planSubjectPattern`. tdd.md keeps a shell
    // example for humans, so it is the one site whose snippet is still pinned byte-for-byte.
    test('tdd.md carries the fixed bare PHASE/PLAN logic', () => {
      const ref = fs.readFileSync(TDD_REF, 'utf8');
      assert.ok(ref.includes(fixedSnippet('PHASE', 'PHASE')),
        'tdd.md gate-enforcement example must carry the byte-identical fixed bare-PHASE snippet');
    });

    test('the workflow sites derive no phase arithmetic of their own — they ask the resolver', () => {
      const w = fs.readFileSync(EXECUTE_PHASE, 'utf8');
      const frag = fs.readFileSync(COMPLETION_RECONCILIATION, 'utf8');
      assert.ok(!w.includes('$((10#') && !frag.includes('$((10#'), 'no `$((10#…))` phase arithmetic remains in the execute-phase workflow files');
      assert.ok(w.includes('gsd_run check evaluation-scope --plan') && frag.includes('gsd_run check evaluation-scope --plan'),
        'both execute-phase files must ask the evaluation-scope resolver for a plan\'s commits');
    });

    test('none of the sites still contains the old unconditional $((10#...)) form on a template/variable phase number', () => {
      const ref = fs.readFileSync(TDD_REF, 'utf8');
      assert.ok(!ref.includes('PHASE_N=$((10#${PHASE}))'), 'old broken form must not remain in tdd.md');
    });

    // Generative-fix-divergence parity: the shell snippet that still ships in tdd.md and the
    // resolver's pattern must accept and reject the same commit scopes.
    test('the resolver\'s plan pattern agrees with the shell snippet\'s ERE on every case above', () => {
      const cases = [
        ['01.1-03', 'feat(01.1-03):', true],
        ['01.1-03', 'test(1.1-3):', true],
        ['01.1-03', 'feat(01-03):', false],
        ['01.1-03', 'feat(01.2-03):', false],
        ['01.1-03', 'feat(011-03):', false],
        ['01.1-03', 'feat(12-03):', false],
        ['01-03', 'feat(01-03):', true],
        ['01-03', 'feat(01.1-03):', false],
        ['01-03', 'feat(011-03):', false],
        ['03A-02', 'feat(3A-2):', true],
        ['03A-02', 'feat(3-2):', false],
        // #6120: the breaking-change marker `!` is part of the plan subject grammar
        ['01-03', 'feat(01-03)!:', true],
        ['01-03', 'test(1-3)!:', true],
        ['01-03', 'feat(01-04)!:', false],
        ['01-03', 'feat(01-03)!', false],
      ];
      for (const [planId, subject, expected] of cases) {
        const resolver = new RegExp(planSubjectPattern(planId)).test(subject);
        assert.equal(resolver, expected, `resolver: ${planId} vs ${subject}`);
        const [phase, plan] = planId.split('-');
        const phaseN = runFixed(phase);
        const planN = String(Number(plan.replace(/\D+$/, '')));
        const shellRe = `^[a-z]+\\((0*${phaseN})-(0*${planN})\\)!?:`;
        assert.equal(matchAll(shellRe, [[subject, expected]])[0], expected, `shell: ${planId} vs ${subject}`);
      }
    });

    // #6120: the lookups the executor actually runs, read from the shipped reference, must credit a
    // breaking-change subject exactly as the gate does, for every kind each lookup names.
    test('the executor\'s shipped RED/GREEN/REFACTOR lookups find a `!:` subject for every kind and still reject another plan', () => {
      const ref = fs.readFileSync(TDD_REF, 'utf8');
      const lookups = splitLines(ref).filter((line) => line.includes('--grep="^') && line.includes('${PHASE_N}'))
        .map((line) => line.slice(line.indexOf('--grep="^') + '--grep="'.length, line.indexOf('"', line.indexOf('--grep="^') + '--grep="'.length)));
      const kindGroup = (lookup) => lookup.slice(1, lookup.indexOf('\\'));
      assert.deepEqual(lookups.map(kindGroup), ['test', '(feat|fix)', 'refactor'], 'the three gate lookups ship in tdd.md');
      const phaseN = runFixed('01');
      for (const lookup of lookups) {
        const ere = new RegExp(lookup.replace('${PHASE_N}', phaseN).replace('${PLAN_N}', '3'));
        for (const kind of kindGroup(lookup).replace(/[()]/g, '').split('|')) {
          const cases = [
            [`${kind}(01-03):`, true], [`${kind}(01-03)!:`, true], [`${kind}(1-3)!:`, true],
            [`${kind}(01-04)!:`, false], [`${kind}(011-03)!:`, false], [`${kind}(01-30)!:`, false], [`${kind}(01-03)!!:`, false], [`${kind}(01-03)!`, false],
          ];
          for (const [subject, expected] of cases) assert.equal(ere.test(subject), expected, `${lookup} vs ${subject}`);
        }
      }
    });
  });
});
