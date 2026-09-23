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
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
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

// ---------------------------------------------------------------------------
// #4748 — the letter axis at the seven shell sites OUTSIDE #4660's six. These
// are not grammar mirrors but consumers of the id: the post-#4619
// `PHASE_INT=${PHASE_NUMBER%%.*}; $((10#$PHASE_INT))` split (four sites),
// the `printf "%02d"` re-pad before the REVIEW.md lookup (one site), the
// `[0-9]+\.?[0-9]*` argument extraction (two files, four lines) and the
// legacy manual normalizer. On a letter-suffixed id the first aborts bash,
// the second prints the wrong file, the last two silently truncate. Same
// discipline as above: each site's live lines are read off disk by anchor
// and executed in a real bash subprocess.
// ---------------------------------------------------------------------------

const EXECUTE_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const COMPLETION_RECONCILIATION = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'completion-reconciliation.md',
);
const CODE_REVIEW_DISPOSITION = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'code-review-disposition.md',
);
const TDD_REF = path.join(__dirname, '..', 'gsd-core', 'references', 'tdd.md');
const AUTONOMOUS = path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md');
const PLAN_REVIEW_CONVERGENCE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-review-convergence.md');
const PHASE_ARGUMENT_PARSING = path.join(__dirname, '..', 'gsd-core', 'references', 'phase-argument-parsing.md');

/**
 * Pure: the indexes of every line containing `anchor`. Asserts the count so a
 * site that is added, removed or renamed breaks this test loudly instead of
 * silently narrowing what it covers (execute-phase.md carries the split TWICE
 * — plan selection and the TDD gate — and both must stay under test).
 */
function findAnchoredLineIndexes(lines, anchor, expectedCount) {
  const idx = [];
  lines.forEach((l, i) => {
    if (l.includes(anchor)) idx.push(i);
  });
  assert.equal(
    idx.length,
    expectedCount,
    `expected ${expectedCount} line(s) containing ${JSON.stringify(anchor)}, found ${idx.length}`,
  );
  return idx;
}

/** Run `script` in bash with `env` merged in; never throws — returns { status, stdout, stderr }. */
function runBash(script, env) {
  try {
    const stdout = execFileSync('bash', [], {
      input: script,
      encoding: 'utf8',
      timeout: TIMEOUT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout.trim(), stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout || '').trim(), stderr: String(e.stderr || '').trim() };
  }
}

// What each Class 1 site must compute from the id it is handed: the integer
// half zero-stripped for the anchored `0*` commit-scope ERE, everything after
// it carried through with dots escaped. `03A` is the padded form `init` emits
// for a `03A-slug/` directory; `12A` / `3A` are the bare forms; `03A.1.2` is
// the letter-and-N-segment combination the canonical grammar admits.
const CLASS1_CASES = [
  // [PHASE_NUMBER, expected PHASE_N]
  ['03A', '3A'],
  ['12A', '12A'],
  ['3A', '3A'],
  ['03A.1.2', '3A\\.1\\.2'],
];
const CLASS1_CONTROLS = [
  ['06', '6'],
  ['7', '7'],
  ['08.5', '8\\.5'],
  ['23.1.2', '23\\.1\\.2'],
];

describe('#4748 — the $((10#$PHASE_INT)) split sites carry a letter suffix into PHASE_N instead of aborting', () => {
  const sites = [
    // execute-phase.md: plan selection (safe_resume_gate) and the TDD gate a
    // few lines below are the same two lines twice; both must be under test.
    { name: 'execute-phase.md', file: EXECUTE_PHASE, anchor: 'PHASE_INT=${PHASE_NUMBER%%', count: 2, input: 'PHASE_NUMBER', output: 'PHASE_N' },
    { name: 'completion-reconciliation.md', file: COMPLETION_RECONCILIATION, anchor: 'SPOT_PHASE_INT=${SPOT_PHASE_NUMBER%%', count: 1, input: 'SPOT_PHASE_NUMBER', output: 'SPOT_PHASE_N' },
    { name: 'tdd.md', file: TDD_REF, anchor: 'PHASE_INT=${PHASE%%', count: 1, input: 'PHASE', output: 'PHASE_N' },
  ];

  for (const site of sites) {
    describe(site.name, () => {
      const lines = splitLines(fs.readFileSync(site.file, 'utf8'));
      const indexes = findAnchoredLineIndexes(lines, site.anchor, site.count);

      indexes.forEach((i, n) => {
        // The split line and the PHASE_N line directly below it, verbatim.
        const splitLine = lines[i].trim();
        const nLine = lines[i + 1].trim();
        assert.ok(nLine.startsWith(`${site.output}=`), `line after the split must assign ${site.output}: ${nLine}`);
        const snippet = ['set -e', splitLine, nLine, `printf '%s' "$${site.output}"`].join('\n');
        const label = site.count > 1 ? ` (occurrence ${n + 1})` : '';

        for (const [id, expected] of CLASS1_CASES) {
          test(`${id} → ${site.output}=${expected} without a shell error${label} (fails before the fix)`, () => {
            const r = runBash(snippet, { [site.input]: id });
            assert.equal(r.status, 0, `bash exited ${r.status}: ${r.stderr}`);
            assert.equal(r.stdout, expected);
          });
        }

        for (const [id, expected] of CLASS1_CONTROLS) {
          test(`regression control: ${id} → ${site.output}=${expected}${label}`, () => {
            const r = runBash(snippet, { [site.input]: id });
            assert.equal(r.status, 0, `bash exited ${r.status}: ${r.stderr}`);
            assert.equal(r.stdout, expected);
          });
        }

        test(`the commit-scope ERE built from PHASE_N matches both the padded and the unpadded scope of a letter phase${label}`, () => {
          // Each site feeds PHASE_N into `^[a-z]+\((0*${PHASE_N})-(0*${PLAN_N})\):`
          // — the #4003 zero-pad-tolerant scope. Prove the value it now yields
          // for `03A` matches the two subjects an executor could have written,
          // and does NOT match the letter-less phase 3.
          const script = [
            'set -e',
            splitLine,
            nLine,
            `SCOPE_RE="^[a-z]+\\((0*\${${site.output}})-(0*1)\\):"`,
            'for s in "feat(3A-01): x" "feat(03A-1): x"; do printf \'%s\\n\' "$s" | grep -qE "$SCOPE_RE" || { echo "MISS $s"; exit 3; }; done',
            'printf \'%s\\n\' "feat(3-01): x" | grep -qE "$SCOPE_RE" && { echo "FALSE-MATCH"; exit 4; }',
            'echo OK',
          ].join('\n');
          const r = runBash(script, { [site.input]: '03A' });
          assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
          assert.equal(r.stdout, 'OK');
        });
      });
    });
  }
});

describe('#4748 — the code-review gate resolves the REVIEW.md path from a letter-safe padded phase, not a shell re-pad', () => {
  // #3829 moved this lookup out of `execute-phase.md` and into the lazily-read step file below.
  // The inline block did not fit under ADR-857's frozen pre-phase-6 ceiling (93600), which the
  // parent now clears by 139 bytes, so it cannot be restored in place. #4748's property is
  // unchanged and is asserted here against the site that now performs the lookup.
  //
  // ONE of this block's original four assertions was a property of the INLINE site rather than of
  // the lookup, and does not survive the move: the `PADDED="{padded_phase}"` literal binding. The
  // step derives PADDED itself — validating PHASE_NUMBER for shape and traversal, then padding the
  // digit run as a STRING and carrying the letter and dot segments verbatim — so there is no
  // literal binding left to pin, and agreement with the canonical normalizer is what replaces it.
  //
  // The composition run DID come back, below, and an earlier cut of this block was wrong to drop it
  // on the grounds that mirroring would duplicate the PR's own coverage. A STATIC assertion cannot
  // hold a BEHAVIOURAL property; at the original site it could, because the property was a literal
  // binding. So this block keeps deterministic ownership of #4748 by EXECUTING the step's own
  // derivation over a fixed id list. The PR's fast-check property in
  // `tests/code-review-pipeline-regression.test.cjs` is a different instrument over the same
  // contract — generated ids rather than a fixed list — and it reaches divergences this one does
  // not: a letter outside the fixed list leaves this block green.
  const stepLines = splitLines(fs.readFileSync(CODE_REVIEW_DISPOSITION, 'utf8'));
  const lookupIdx = findAnchoredLineIndexes(stepLines, 'REVIEW_FILE="${_pd}/${PADDED}-REVIEW.md"', 2);

  test('no fence pads the raw phase number with printf (fails before the fix)', () => {
    // `printf "%02d"` cannot pad `03A` (prints `03`, exits 1) — and cannot even re-pad an
    // already-padded `08` (bash reads it as octal, prints `00`). Every binding must pad the
    // DIGIT RUN, never PHASE_NUMBER itself.
    const offenders = stepLines
      .map((l, n) => [n + 1, l])
      .filter(([, l]) => !/^\s*#/.test(l) && /printf\s+"%0\d*d"\s+"?\$\{?PHASE_NUMBER/.test(l));
    assert.deepEqual(offenders, [], `no fence may printf-pad PHASE_NUMBER: ${JSON.stringify(offenders)}`);
  });

  test('no lookup pads the phase through arithmetic (fails before the fix)', () => {
    // THE DEFECT SHAPE, which is what a static gate can actually hold. The canonical normalizer
    // left-pads the digit run to a MINIMUM of two and otherwise PRESERVES it (`008` -> `008`), so an
    // arithmetic pad is wrong by construction -- `$((10#$_dig))` collapses every longer leading-zero
    // run. Deliberately NOT a pin on one spelling of the remedy: an equivalent multi-line string pad
    // must pass here, and correctness is asserted by execution below rather than by shape.
    for (const i of lookupIdx) {
      const bound = stepLines.slice(0, i).reverse()
        .find((l) => /PADDED=/.test(l) && !/PADDED=""/.test(l));
      assert.ok(bound, `the lookup at line ${i + 1} has no PADDED binding above it`);
      assert.doesNotMatch(bound, /printf|\$\(\(/,
        `the pad must not be arithmetic -- arithmetic collapses 008 to 08: ${bound.trim()}`);
    }
  });

  test('composition: each fence\'s live derivation resolves the id init would emit', () => {
    // #4748's property, asserted the way it has to be at THIS site. At the original site the gate
    // could be static because the property was a literal binding of init's own `{padded_phase}`;
    // here the step derives the value, so the property is behavioural and only execution can hold
    // it. Runs the SHIPPED derivation slice of BOTH fences against the canonical normalizer.
    const { normalizePhaseName } = require('../gsd-core/bin/lib/phase-id.cjs');
    const starts = [];
    stepLines.forEach((l, n) => { if (l.includes('_pd="${PHASE_DIR:-}"')) starts.push(n); });
    assert.equal(starts.length, lookupIdx.length, 'each lookup must have its own derivation slice');
    const derivations = starts.map((d, n) => stepLines.slice(d, lookupIdx[n] + 1).join('\n'));
    // `008` is the case the arithmetic pad got wrong and no prior fixture covered.
    for (const id of ['3A', '8', '9', '08', '008', '0008A', '23A.1.2']) {
      for (const deriv of derivations) {
        const out = execFileSync('bash', [], {
          input: `set -e\n${deriv}\nprintf '%s' "$PADDED"`,
          encoding: 'utf8',
          timeout: TIMEOUT,
          env: { ...process.env, PHASE_DIR: '/tmp', PHASE_NUMBER: id },
        });
        assert.equal(out, normalizePhaseName(id), `the step disagreed with the normalizer on ${id}`);
      }
    }
  });

  test('regression control: the lookup lines themselves are unchanged', () => {
    for (const i of lookupIdx) {
      assert.equal(stepLines[i].trim(), 'REVIEW_FILE="${_pd}/${PADDED}-REVIEW.md"');
    }
  });

  test('the workflow\'s init parse list still names padded_phase (fails before the fix)', () => {
    // A `{field}` token is substituted from the init JSON only for fields the workflow tells the
    // model to parse. This one is a property of `execute-phase.md` and the move does not touch it.
    const lines = splitLines(fs.readFileSync(EXECUTE_PHASE, 'utf8'));
    const [p] = findAnchoredLineIndexes(lines, 'Parse JSON for: `executor_model`', 1);
    assert.match(lines[p], /`phase_number`, `padded_phase`,/);
  });
});

describe('#4748 — autonomous.md --from/--to/--only and plan-review-convergence.md extract the full letter-suffixed phase', () => {
  const autonomousText = fs.readFileSync(AUTONOMOUS, 'utf8');
  const prcText = fs.readFileSync(PLAN_REVIEW_CONVERGENCE, 'utf8');

  const sites = [
    { name: 'autonomous.md --from', pattern: extractGrepPattern(autonomousText, 'FROM_PHASE=$(echo "$ARGUMENTS" | grep -oE'), args: (v) => `--from ${v}`, tail: "| awk '{print $2}'" },
    { name: 'autonomous.md --to', pattern: extractGrepPattern(autonomousText, 'TO_PHASE=$(echo "$ARGUMENTS" | grep -oE'), args: (v) => `--from 1 --to ${v}`, tail: "| awk '{print $2}'" },
    { name: 'autonomous.md --only', pattern: extractGrepPattern(autonomousText, 'ONLY_PHASE=$(echo "$ARGUMENTS" | grep -oE'), args: (v) => `--only ${v} --interactive`, tail: "| awk '{print $2}'" },
    { name: 'plan-review-convergence.md', pattern: extractGrepPattern(prcText, 'PHASE=$(echo "$ARGUMENTS" | grep -oE'), args: (v) => `${v} --codex --max-cycles 3`, tail: '| head -1' },
  ];

  function extract(site, v) {
    const script = `echo "$ARGUMENTS" | grep -oE '${site.pattern}' ${site.tail}`;
    return runBash(script, { ARGUMENTS: site.args(v) }).stdout;
  }

  for (const site of sites) {
    describe(site.name, () => {
      // Before the fix `[0-9]+\.?[0-9]*` stops at the letter: `12A` → `12`,
      // silently targeting a different phase. `23.1.2` → `23.1` is the same
      // truncation one axis over (#4568's class in a spelling neither lint saw).
      for (const v of ['12A', '3A', '23A.1.2', '23.1.2']) {
        test(`${v} extracts ${v}, not a truncated prefix (fails before the fix)`, () => {
          const got = extract(site, v);
          assert.equal(got, v);
          assert.equal(CANONICAL_ANCHORED.test(got), true);
        });
      }

      for (const v of ['6', '36.14']) {
        test(`regression control: ${v} extracts ${v}`, () => {
          assert.equal(extract(site, v), v);
        });
      }
    });
  }

  test('autonomous.md: the three flags extract independently from one argument string', () => {
    const script = [
      `FROM_PHASE=$(echo "$ARGUMENTS" | grep -oE '${sites[0].pattern}' | awk '{print $2}')`,
      `TO_PHASE=$(echo "$ARGUMENTS" | grep -oE '${sites[1].pattern}' | awk '{print $2}')`,
      'printf \'%s %s\' "$FROM_PHASE" "$TO_PHASE"',
    ].join('\n');
    assert.equal(runBash(script, { ARGUMENTS: '--from 3A --to 5B --max-cycles 2' }).stdout, '3A 5B');
  });
});

describe('#4748 — phase-argument-parsing.md\'s legacy normalizer pads a letter-suffixed id instead of leaving it alone', () => {
  const lines = splitLines(fs.readFileSync(PHASE_ARGUMENT_PARSING, 'utf8'));
  const [start] = findAnchoredLineIndexes(lines, '# Normalize phase number', 1);
  let end = start;
  while (end < lines.length && lines[end].trim() !== 'fi') end++;
  assert.ok(end < lines.length, 'normalizer block must close with `fi`');
  const block = lines.slice(start, end + 1).join('\n');

  function normalize(v) {
    return runBash(`set -e\n${block}\nprintf '%s' "$PHASE"`, { PHASE: v });
  }

  // Before the fix neither branch matches a letter id, so `12A` passes through
  // unpadded and `3A` is never zero-padded to the `03A` a directory carries.
  for (const [input, expected] of [['3A', '03A'], ['12A', '12A'], ['3A.1', '03A.1'], ['23A.1.2', '23A.1.2']]) {
    test(`${input} → ${expected} (fails before the fix)`, () => {
      const r = normalize(input);
      assert.equal(r.status, 0, `bash exited ${r.status}: ${r.stderr}`);
      assert.equal(r.stdout, expected);
      assert.equal(CANONICAL_ANCHORED.test(r.stdout), true);
    });
  }

  // `08` is the octal trap: `printf "%02d" 08` is an invalid octal number in
  // bash (exit 1, prints `00`), so the old integer branch mangled any
  // already-padded id it was handed. `23.1.2` matched neither old branch and
  // passed through unchanged — the N-segment axis was silently unpadded.
  for (const [input, expected] of [['08', '08'], ['23.1.2', '23.1.2']]) {
    test(`${input} → ${expected} without a shell error (fails before the fix)`, () => {
      const r = normalize(input);
      assert.equal(r.status, 0, `bash exited ${r.status}: ${r.stderr}`);
      assert.equal(r.stdout, expected);
    });
  }

  for (const [input, expected] of [['8', '08'], ['2.1', '02.1'], ['36.14', '36.14']]) {
    test(`regression control: ${input} → ${expected}`, () => {
      const r = normalize(input);
      assert.equal(r.status, 0, `bash exited ${r.status}: ${r.stderr}`);
      assert.equal(r.stdout, expected);
    });
  }

  test('a non-canonical value passes through untouched (the normalizer is not a validator)', () => {
    const r = normalize('AUTH-101');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'AUTH-101');
  });
});
