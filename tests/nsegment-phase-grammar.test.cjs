'use strict';

/**
 * #4568 (epic #4634) — six shell snippets embedded in workflow/agent markdown
 * validate or extract phase numbers with the regex shape `[0-9]+(\.[0-9]+)?`
 * (or its `\d` near-variant) — an optional SINGLE dotted segment. Any
 * three-or-more-segment phase id (e.g. `23.1.2`, produced by a nested `phase
 * insert`) is either hard-rejected or silently truncated to the wrong value.
 * The canonical grammar in src/phase-id.cts already uses the unbounded form
 * (`\d+(?:\.\d+)*`) — shell cannot import that module, so the fix is textual
 * parity: widen `?` to `*` at each site.
 *
 * These tests are BEHAVIORAL: for each site, the actual regex/extraction
 * line is read live off disk (via a narrow, anchored string search) and
 * executed in a real bash subprocess — never hand-retyped — so the test
 * breaks loudly if a future edit changes a site's shape instead of silently
 * drifting from the real file.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TIMEOUT = 5000;

const CODE_REVIEW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'code-review.md');
const CODE_REVIEW_FIX = path.join(__dirname, '..', 'gsd-core', 'workflows', 'code-review-fix.md');
const CODE_FIXER = path.join(__dirname, '..', 'agents', 'gsd-code-fixer.md');
const CODE_FIXER_COMPACT = path.join(__dirname, '..', 'agents', 'gsd-code-fixer.compact.md');
const EXECUTE_PLAN = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');
const PLAN_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');

/**
 * Pure: find the line containing `anchor` and pull the regex substring
 * between `=~ ` and ` ]]` on it. Throws loudly if either the anchor or the
 * pattern shape is not found, so a future rewrite of the site's surrounding
 * code breaks this test instead of silently testing stale text.
 */
function extractAnchoredRegex(fileText, anchor) {
  const lines = fileText.split('\n');
  const line = lines.find((l) => l.includes(anchor));
  assert.ok(line, `anchor not found: ${anchor}`);
  const m = line.match(/=~\s+(\S+)\s+\]\]/);
  assert.ok(m, `no "=~ <pattern> ]]" shape found on anchor line: ${line}`);
  return m[1];
}

/**
 * Pure: find the line containing `anchor` and pull the single-quoted
 * `grep -oE '...'` pattern off it.
 */
function extractGrepPattern(fileText, anchor) {
  const lines = fileText.split('\n');
  const line = lines.find((l) => l.includes(anchor));
  assert.ok(line, `anchor not found: ${anchor}`);
  const m = line.match(/grep -oE '([^']+)'/);
  assert.ok(m, `no grep -oE '...' shape found on anchor line: ${line}`);
  return m[1];
}

/** Run a validating-site regex (bash `[[ =~ ]]`) against `value`, returning true/false. */
function matchesValidatingRegex(pattern, value) {
  const script = `if [[ "$TEST_INPUT" =~ ${pattern} ]]; then echo MATCH; else echo NOMATCH; fi`;
  const out = execFileSync('bash', [], {
    input: script,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: { ...process.env, TEST_INPUT: value },
  }).trim();
  return out === 'MATCH';
}

describe('#4568 — validating sites accept N-segment phase ids and still reject injection', () => {
  const sites = [
    { name: 'code-review.md', file: CODE_REVIEW, anchor: 'if ! [[ "$PADDED_PHASE" =~ ' },
    { name: 'code-review-fix.md', file: CODE_REVIEW_FIX, anchor: 'if ! [[ "$PADDED_PHASE" =~ ' },
    { name: 'gsd-code-fixer.md', file: CODE_FIXER, anchor: 'if ! [[ "$padded_phase" =~ ' },
    { name: 'gsd-code-fixer.compact.md', file: CODE_FIXER_COMPACT, anchor: 'if ! [[ "$padded_phase" =~ ' },
  ];

  for (const site of sites) {
    describe(site.name, () => {
      const text = fs.readFileSync(site.file, 'utf8');
      const pattern = extractAnchoredRegex(text, site.anchor);

      test('regression control: 1-segment id (6) matches', () => {
        assert.equal(matchesValidatingRegex(pattern, '6'), true);
      });

      test('regression control: 2-segment id (36.14) matches', () => {
        assert.equal(matchesValidatingRegex(pattern, '36.14'), true);
      });

      test('N-segment id (23.1.2) matches (fails before the fix)', () => {
        assert.equal(matchesValidatingRegex(pattern, '23.1.2'), true);
      });

      test('path-traversal injection (../1) is rejected', () => {
        assert.equal(matchesValidatingRegex(pattern, '../1'), false);
      });

      test('shell-metacharacter injection (1; rm -rf /) is rejected', () => {
        assert.equal(matchesValidatingRegex(pattern, '1; rm -rf /'), false);
      });

      test('empty string is rejected', () => {
        assert.equal(matchesValidatingRegex(pattern, ''), false);
      });
    });
  }
});

describe('#4568 — execute-plan.md extracts the full N-segment phase from a plan filename', () => {
  const text = fs.readFileSync(EXECUTE_PLAN, 'utf8');
  const pattern = extractGrepPattern(text, 'grep -oE');

  function extractPhase(planPath) {
    const script = `echo "$PLAN_PATH" | grep -oE '${pattern}'`;
    let out;
    try {
      out = execFileSync('bash', [], {
        input: script,
        encoding: 'utf8',
        timeout: TIMEOUT,
        env: { ...process.env, PLAN_PATH: planPath },
      }).trim();
    } catch {
      out = '';
    }
    return out;
  }

  test('regression control: 1-segment plan filename extracts correctly', () => {
    assert.equal(extractPhase('/x/06-01-PLAN.md'), '06-01');
  });

  test('regression control: 2-segment plan filename extracts correctly', () => {
    assert.equal(extractPhase('/x/36.14-01-PLAN.md'), '36.14-01');
  });

  test('N-segment plan filename extracts the FULL phase, not a truncated one (fails before the fix)', () => {
    assert.equal(extractPhase('/x/23.1.2-01-PLAN.md'), '23.1.2-01');
  });
});

describe('#4568 — plan-phase.md captures the full N-segment --research-phase value', () => {
  const text = fs.readFileSync(PLAN_PHASE, 'utf8');
  const pattern = extractAnchoredRegex(text, '=~ --research-phase[[:space:]]+(');

  function captureResearchPhase(args) {
    const script = [
      'if [[ "$ARGUMENTS" =~ ' + pattern + ' ]]; then',
      '  echo "${BASH_REMATCH[1]}"',
      'else',
      '  echo NOMATCH',
      'fi',
    ].join('\n');
    return execFileSync('bash', [], {
      input: script,
      encoding: 'utf8',
      timeout: TIMEOUT,
      env: { ...process.env, ARGUMENTS: args },
    }).trim();
  }

  test('regression control: 1-segment --research-phase captures correctly', () => {
    assert.equal(captureResearchPhase('--research-phase 6'), '6');
  });

  test('regression control: 2-segment --research-phase captures correctly', () => {
    assert.equal(captureResearchPhase('--research-phase 36.14'), '36.14');
  });

  test('N-segment --research-phase captures the FULL value, not a truncated one (fails before the fix)', () => {
    assert.equal(captureResearchPhase('--research-phase 23.1.2'), '23.1.2');
  });
});

// ---------------------------------------------------------------------------
// #4660 — the LETTER axis. #4568 widened the six sites on the segment-count
// axis only; the canonical grammar also admits an optional single uppercase
// letter after the leading digits (`12A`, `3A`, `23A.1.2` — a documented
// phase-number shape in CONFIGURATION.md, relied on by renameIntegerPhases in
// src/phase.cts). These tests prove each site's live pattern and the canonical
// source AGREE on that axis, in both directions, rather than each merely
// "looking right" in isolation.
// ---------------------------------------------------------------------------

// The canonical grammar is read from the committed bin/lib mirror the other
// grammar tests use (shell cannot import it; the test can).
const { PHASE_NUMBER_TOKEN_SOURCE } = require('../gsd-core/bin/lib/phase-id.cjs');
const CANONICAL_ANCHORED = new RegExp('^(?:' + PHASE_NUMBER_TOKEN_SOURCE + ')$');

// Inputs the canonical grammar ACCEPTS. `03A` is what `normalizePhaseName('3A')`
// emits, i.e. the real `padded_phase` the four validating sites receive from
// `init`; the bare forms are what a user types or names a directory with.
const LETTER_ACCEPT = ['12A', '3A', '03A', '23A.1.2'];
// Inputs the canonical grammar REJECTS on the same axis — a parity test that
// only checks accepts would pass against `.*`. Lowercase is refused because
// the canonical source is case-sensitive `[A-Z]` (the case-flexible variant
// is a separate, deliberately distinct axis — see phase-id.cts).
const LETTER_REJECT = ['3a', '3AB', 'A3', '3A.', '3.A', '3A-1'];

describe('#4660 — canonical grammar fixture agrees with the inputs this file uses', () => {
  for (const v of LETTER_ACCEPT) {
    test(`canonical accepts ${v}`, () => {
      assert.equal(CANONICAL_ANCHORED.test(v), true);
    });
  }
  for (const v of LETTER_REJECT) {
    test(`canonical rejects ${v}`, () => {
      assert.equal(CANONICAL_ANCHORED.test(v), false);
    });
  }
});

describe('#4660 — validating sites agree with the canonical grammar on the letter axis', () => {
  const sites = [
    { name: 'code-review.md', file: CODE_REVIEW, anchor: 'if ! [[ "$PADDED_PHASE" =~ ' },
    { name: 'code-review-fix.md', file: CODE_REVIEW_FIX, anchor: 'if ! [[ "$PADDED_PHASE" =~ ' },
    { name: 'gsd-code-fixer.md', file: CODE_FIXER, anchor: 'if ! [[ "$padded_phase" =~ ' },
    { name: 'gsd-code-fixer.compact.md', file: CODE_FIXER_COMPACT, anchor: 'if ! [[ "$padded_phase" =~ ' },
  ];

  for (const site of sites) {
    describe(site.name, () => {
      const text = fs.readFileSync(site.file, 'utf8');
      const pattern = extractAnchoredRegex(text, site.anchor);

      for (const v of LETTER_ACCEPT) {
        test(`letter-suffixed id ${v} matches (fails before the fix)`, () => {
          assert.equal(matchesValidatingRegex(pattern, v), true);
          assert.equal(matchesValidatingRegex(pattern, v), CANONICAL_ANCHORED.test(v));
        });
      }

      for (const v of LETTER_REJECT) {
        test(`canonical-invalid ${v} is still rejected (parity, not a blanket widening)`, () => {
          assert.equal(matchesValidatingRegex(pattern, v), false);
          assert.equal(matchesValidatingRegex(pattern, v), CANONICAL_ANCHORED.test(v));
        });
      }
    });
  }
});

describe('#4660 — execute-plan.md extracts the full letter-suffixed phase from a plan filename', () => {
  const text = fs.readFileSync(EXECUTE_PLAN, 'utf8');
  const pattern = extractGrepPattern(text, 'grep -oE');

  function extractPhase(planPath) {
    const script = `echo "$PLAN_PATH" | grep -oE '${pattern}'`;
    let out;
    try {
      out = execFileSync('bash', [], {
        input: script,
        encoding: 'utf8',
        timeout: TIMEOUT,
        env: { ...process.env, PLAN_PATH: planPath },
      }).trim();
    } catch {
      out = '';
    }
    return out;
  }

  // Before the fix a letter-suffixed filename either extracts NOTHING (the
  // digit run is followed by the letter, so `-[0-9]+` never attaches) or the
  // wrong tail (`23A.1.2-01` → `1.2-01`). Both are silent mis-extractions.
  for (const [planPath, expected] of [
    ['/x/12A-01-PLAN.md', '12A-01'],
    ['/x/03A-02-PLAN.md', '03A-02'],
    ['/x/23A.1.2-01-PLAN.md', '23A.1.2-01'],
  ]) {
    test(`${planPath} extracts ${expected} (fails before the fix)`, () => {
      const got = extractPhase(planPath);
      assert.equal(got, expected);
      // The phase half of the extraction is canonical-valid — parity with src/phase-id.cts.
      assert.equal(CANONICAL_ANCHORED.test(got.replace(/-\d+$/, '')), true);
    });
  }

  test('regression control: the letter class is admitted at the PHASE position only (plan numbers stay digit-only)', () => {
    // `12A-B1`: the plan half must start with a digit, so nothing attaches to
    // `12A-` and the digit-only tail `1` has no `-[0-9]+` after it either.
    assert.equal(extractPhase('/x/12A-B1-PLAN.md'), '');
  });
});

describe('#4660 — plan-phase.md captures the full letter-suffixed --research-phase value', () => {
  const text = fs.readFileSync(PLAN_PHASE, 'utf8');
  const pattern = extractAnchoredRegex(text, '=~ --research-phase[[:space:]]+(');

  function captureResearchPhase(args) {
    const script = [
      'if [[ "$ARGUMENTS" =~ ' + pattern + ' ]]; then',
      '  echo "${BASH_REMATCH[1]}"',
      'else',
      '  echo NOMATCH',
      'fi',
    ].join('\n');
    return execFileSync('bash', [], {
      input: script,
      encoding: 'utf8',
      timeout: TIMEOUT,
      env: { ...process.env, ARGUMENTS: args },
    }).trim();
  }

  // Before the fix the capture stops at the digit boundary: `12A` → `12`.
  for (const v of ['12A', '3A', '23A.1.2']) {
    test(`--research-phase ${v} captures ${v}, not its digit prefix (fails before the fix)`, () => {
      const got = captureResearchPhase(`--research-phase ${v}`);
      assert.equal(got, v);
      assert.equal(CANONICAL_ANCHORED.test(got), true);
    });
  }
});
