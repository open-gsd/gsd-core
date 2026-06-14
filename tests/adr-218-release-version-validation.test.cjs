'use strict';

/**
 * ADR-218 regression guard: release-workflow version validation.
 *
 * (A) Behavioral regex coverage — extracts the actual leading-zero-rejection
 *     regex strings from .github/workflows/release.yml at test time, compiles
 *     them as RegExp, and asserts boundary behavior. If someone weakens the
 *     regex (e.g. back to [0-9]+), these assertions go RED.
 *
 * (B) Structural wiring assertions — confirms the validate-version job exists,
 *     the npm duplicate-version pre-check step is present, and that all
 *     downstream publish/create jobs declare `needs: validate-version`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = process.env.ADR218_WORKFLOW_PATH
  || path.join(__dirname, '..', '.github', 'workflows', 'release.yml');

function loadWorkflow() {
  assert.ok(
    fs.existsSync(WORKFLOW_PATH),
    `release.yml not found at ${WORKFLOW_PATH} — file moved or deleted?`
  );
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

/**
 * Extract all grep -qE '...' or grep -qE "..." patterns from a bash block.
 * Returns an array of raw regex strings (the content inside the quotes).
 */
function extractGrepPatterns(text) {
  // Match: grep -qE '...' or grep -qE "..."
  const re = /grep\s+-qE\s+(?:'([^']+)'|"([^"]+)")/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// (A) Behavioral regex tests
// ---------------------------------------------------------------------------

describe('ADR-218 — leading-zero rejection regex (behavioral)', () => {

  test('release.yml contains at least two leading-zero-aware grep patterns', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);
    assert.ok(
      patterns.length >= 2,
      `Expected at least 2 grep -qE patterns in release.yml, found ${patterns.length}: ${JSON.stringify(patterns)}`
    );
  });

  test('minor/major pattern (X.Y.0) rejects leading zeros and accepts valid versions', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);

    // The minor/major pattern must match X.Y.0 (not hotfix) and must be the
    // one that guards the release branch decision. We identify it as the first
    // pattern that matches `1.0.0` AND `0.1.0` AND `10.20.0`.
    const minorMajorPatterns = patterns.filter(p => {
      const re = new RegExp(p);
      return re.test('1.0.0') && re.test('0.1.0') && re.test('10.20.0');
    });

    assert.ok(
      minorMajorPatterns.length >= 1,
      `Could not locate the minor/major (X.Y.0) grep pattern in release.yml.\n` +
      `Extracted patterns: ${JSON.stringify(patterns)}\n` +
      `If the pattern was relocated or renamed, update this test to match.`
    );

    const re = new RegExp(minorMajorPatterns[0]);

    // Boundary table: REJECTED (leading zeros or malformed)
    const shouldReject = [
      '1.01.0',   // leading zero in minor
      '01.0.0',   // leading zero in major
      '1.1.01',   // leading zero in patch (also not X.Y.0 form)
      '00.0.0',   // double leading zero in major
      '1.00.0',   // double leading zero in minor
    ];
    for (const v of shouldReject) {
      assert.equal(
        re.test(v), false,
        `Version "${v}" should be REJECTED by the minor/major pattern but was accepted.\n` +
        `Pattern: ${minorMajorPatterns[0]}\n` +
        `This is the ADR-218 leading-zero regression. Restore (0|[1-9][0-9]*) grouping.`
      );
    }

    // Boundary table: ACCEPTED (valid semver, no leading zeros)
    const shouldAccept = [
      '1.0.0',
      '0.1.0',
      '10.20.0',
      '1.2.0',
      '0.0.0',
    ];
    for (const v of shouldAccept) {
      assert.equal(
        re.test(v), true,
        `Version "${v}" should be ACCEPTED by the minor/major pattern but was rejected.\n` +
        `Pattern: ${minorMajorPatterns[0]}`
      );
    }
  });

  test('major-only sub-check (X.0.0) correctly classifies major releases', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);

    // The major-only pattern matches X.0.0 exactly (not X.Y.0 with Y>0).
    // We identify it as the pattern that matches `1.0.0` but NOT `1.1.0`.
    const majorOnlyPatterns = patterns.filter(p => {
      const re = new RegExp(p);
      return re.test('1.0.0') && !re.test('1.1.0');
    });

    assert.ok(
      majorOnlyPatterns.length >= 1,
      `Could not locate the major-only (X.0.0) grep pattern in release.yml.\n` +
      `Extracted patterns: ${JSON.stringify(patterns)}\n` +
      `ADR-218 requires IS_MAJOR detection to also forbid leading zeros.`
    );

    const re = new RegExp(majorOnlyPatterns[0]);

    // REJECTED: leading zeros in the major segment
    const shouldReject = [
      '01.0.0',   // leading zero in major
      '00.0.0',   // double leading zero
    ];
    for (const v of shouldReject) {
      assert.equal(
        re.test(v), false,
        `Version "${v}" should be REJECTED by the major-only pattern but was accepted.\n` +
        `Pattern: ${majorOnlyPatterns[0]}\n` +
        `ADR-218: IS_MAJOR check must also use (0|[1-9][0-9]*) grouping.`
      );
    }

    // ACCEPTED: valid major versions
    const shouldAccept = [
      '1.0.0',
      '10.0.0',
      '0.0.0',
    ];
    for (const v of shouldAccept) {
      assert.equal(
        re.test(v), true,
        `Version "${v}" should be ACCEPTED by the major-only pattern but was rejected.\n` +
        `Pattern: ${majorOnlyPatterns[0]}`
      );
    }
  });

  test('hotfix pattern (X.Y.Z, Z>0) is present and uses digit anchors', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);

    // The hotfix pattern matches X.Y.Z where Z > 0, e.g. `1.2.3`.
    // Identify it as the pattern matching `1.2.3` but NOT `1.2.0`.
    const hotfixPatterns = patterns.filter(p => {
      const re = new RegExp(p);
      return re.test('1.2.3') && !re.test('1.2.0');
    });

    assert.ok(
      hotfixPatterns.length >= 1,
      `Could not locate the hotfix (X.Y.Z, Z>0) grep pattern in release.yml.\n` +
      `Extracted patterns: ${JSON.stringify(patterns)}\n` +
      `Expected a pattern matching 1.2.3 but not 1.2.0.`
    );

    const re = new RegExp(hotfixPatterns[0]);

    // Sanity: valid hotfix versions accepted
    assert.equal(re.test('1.2.3'), true,  'Hotfix pattern must accept 1.2.3');
    assert.equal(re.test('1.0.1'), true,  'Hotfix pattern must accept 1.0.1');
    assert.equal(re.test('10.20.30'), true, 'Hotfix pattern must accept 10.20.30');

    // Patch = 0 must be rejected (that is the minor/major form)
    assert.equal(re.test('1.2.0'), false, 'Hotfix pattern must not match X.Y.0 (Z must be >0)');

    // NOTE: The hotfix regex in release.yml currently permits leading zeros on
    // the major and minor segments (e.g. `1.01.3` and `01.2.3` both pass).
    // This is a known gap tracked in issue #1186.  The assertions below are
    // intentionally absent for those cases: this test documents CURRENT
    // behavior, not ideal behavior.  Fix #1186 will harden the pattern and
    // add leading-zero rejection assertions here.
  });

  test('extracted patterns use strict leading-zero guard, not the old [0-9]+ form', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);

    // The old, vulnerable pattern used [0-9]+ which allows leading zeros.
    // Every version-validation pattern must NOT be the bare [0-9]+ form on
    // every segment. At least one pattern must contain the (0|[1-9][0-9]*)
    // grouping from ADR-218 Decision #1.
    const hasStrictGuard = patterns.some(p =>
      p.includes('(0|[1-9][0-9]*)') || p.includes('[1-9][0-9]*')
    );

    assert.ok(
      hasStrictGuard,
      `None of the grep -qE patterns in release.yml contain the (0|[1-9][0-9]*) ` +
      `guard required by ADR-218. Found patterns: ${JSON.stringify(patterns)}\n` +
      `This is the regression this ADR was written to prevent.`
    );
  });
});

// ---------------------------------------------------------------------------
// (B) Structural / wiring assertions
// ---------------------------------------------------------------------------

describe('ADR-218 — structural wiring of release.yml', () => {

  test('validate-version job exists in release.yml', () => {
    const src = loadWorkflow();
    assert.ok(
      src.includes('validate-version:'),
      'release.yml must define a `validate-version:` job (ADR-218 requires it as the gate)'
    );
  });

  test('npm duplicate-version pre-check step is present', () => {
    const src = loadWorkflow();
    // Assert both the "Reject already-published versions" step name and
    // the npm view command exist in the file.
    assert.ok(
      src.includes('Reject already-published versions'),
      'release.yml must contain a step named "Reject already-published versions" (ADR-218 Decision #2)'
    );
    assert.ok(
      src.includes('npm view'),
      'release.yml must contain an `npm view` call for duplicate-version pre-check (ADR-218 Decision #2)'
    );
  });

  test('npm duplicate-check step appears AFTER format validation step within validate-version job', () => {
    const src = loadWorkflow();

    const formatIdx = src.indexOf('Validate version format');
    const dupCheckIdx = src.indexOf('Reject already-published versions');

    assert.ok(
      formatIdx !== -1,
      'Could not find "Validate version format" step in release.yml'
    );
    assert.ok(
      dupCheckIdx !== -1,
      'Could not find "Reject already-published versions" step in release.yml'
    );
    assert.ok(
      dupCheckIdx > formatIdx,
      `"Reject already-published versions" (offset ${dupCheckIdx}) must appear AFTER ` +
      `"Validate version format" (offset ${formatIdx}) in release.yml.\n` +
      `Format validation must gate before the npm pre-check.`
    );
  });

  test('create job declares needs: validate-version', () => {
    const src = loadWorkflow();
    // Check that between "create:" and the next top-level job, "needs: validate-version" appears.
    const createJobIdx = src.indexOf('\n  create:\n');
    assert.ok(createJobIdx !== -1, 'release.yml must have a `create:` job');

    // Find the segment from create: to the next job header
    const afterCreate = src.slice(createJobIdx);
    const nextJobMatch = afterCreate.match(/\n {2}[a-z][a-z-]+:\n/g);
    const createSegment = nextJobMatch && nextJobMatch.length > 1
      ? afterCreate.slice(0, afterCreate.indexOf(nextJobMatch[1]))
      : afterCreate;

    assert.ok(
      createSegment.includes('needs: validate-version') || createSegment.includes('needs: [validate-version'),
      'The `create` job must declare `needs: validate-version` to ensure validation runs first (ADR-218)'
    );
  });

  test('rc job declares needs including validate-version', () => {
    const src = loadWorkflow();
    const rcJobIdx = src.indexOf('\n  rc:\n');
    assert.ok(rcJobIdx !== -1, 'release.yml must have an `rc:` job');

    const afterRc = src.slice(rcJobIdx, rcJobIdx + 500);
    assert.ok(
      afterRc.includes('validate-version'),
      'The `rc` job must declare validate-version in its `needs:` (ADR-218 gate must run before rc)'
    );
  });

  test('finalize job declares needs including validate-version', () => {
    const src = loadWorkflow();
    const finalizeIdx = src.indexOf('\n  finalize:\n');
    assert.ok(finalizeIdx !== -1, 'release.yml must have a `finalize:` job');

    const afterFinalize = src.slice(finalizeIdx, finalizeIdx + 500);
    assert.ok(
      afterFinalize.includes('validate-version'),
      'The `finalize` job must declare validate-version in its `needs:` (ADR-218 gate must run before finalize)'
    );
  });

  test('validate-version job appears before create/rc/finalize jobs in file', () => {
    const src = loadWorkflow();

    const validateIdx  = src.indexOf('\n  validate-version:\n');
    const createIdx    = src.indexOf('\n  create:\n');
    const rcIdx        = src.indexOf('\n  rc:\n');
    const finalizeIdx  = src.indexOf('\n  finalize:\n');

    assert.ok(validateIdx !== -1, 'validate-version job must be defined');

    if (createIdx !== -1) {
      assert.ok(
        validateIdx < createIdx,
        'validate-version must be declared before the create job in release.yml'
      );
    }
    if (rcIdx !== -1) {
      assert.ok(
        validateIdx < rcIdx,
        'validate-version must be declared before the rc job in release.yml'
      );
    }
    if (finalizeIdx !== -1) {
      assert.ok(
        validateIdx < finalizeIdx,
        'validate-version must be declared before the finalize job in release.yml'
      );
    }
  });
});
