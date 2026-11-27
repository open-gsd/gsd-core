'use strict';

/**
 * ADR-218 regression guard: release-workflow version validation, the behaviour of the leading-zero-rejection regexes.
 *
 * Extracts the actual leading-zero-rejection regex strings from .github/workflows/release.yml at test time, compiles them
 * as RegExp and asserts boundary behaviour. If someone weakens a regex (e.g. back to [0-9]+), these assertions go RED.
 *
 * The structural wiring of release.yml (the validate-version job, the npm duplicate-version pre-check step and its order,
 * `needs: validate-version` on the create, rc and finalize jobs, the job order, and the count of grep patterns) is the
 * adr-218-release-version-validation text contract (scripts/static-checks/text-contracts/).
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

    // Pattern extracted verbatim from release.yml at test time — the shipped
    // grep pattern IS the product under test; escaping it would assert a
    // different string than what actually ships (#3951).
    const re = new RegExp(minorMajorPatterns[0]); // allow-adhoc-regex-escape: runtime-contract-is-the-product

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

    // Pattern extracted verbatim from release.yml — the shipped grep pattern
    // IS the product under test (#3951).
    const re = new RegExp(majorOnlyPatterns[0]); // allow-adhoc-regex-escape: runtime-contract-is-the-product

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

    // Pattern extracted verbatim from release.yml — the shipped grep pattern
    // IS the product under test (#3951).
    const re = new RegExp(hotfixPatterns[0]); // allow-adhoc-regex-escape: runtime-contract-is-the-product

    // Sanity: valid hotfix versions accepted
    assert.equal(re.test('1.2.3'), true,  'Hotfix pattern must accept 1.2.3');
    assert.equal(re.test('1.0.1'), true,  'Hotfix pattern must accept 1.0.1');
    assert.equal(re.test('10.20.30'), true, 'Hotfix pattern must accept 10.20.30');

    // Patch = 0 must be rejected (that is the minor/major form)
    assert.equal(re.test('1.2.0'), false, 'Hotfix pattern must not match X.Y.0 (Z must be >0)');

    // ADR-218 / #1186: hotfix pattern must also reject leading zeros on major
    // and minor segments.  The old `[0-9]+` form allowed e.g. `01.2.3` and
    // `1.02.3`.  The corrected pattern uses `(0|[1-9][0-9]*)` for both.
    const shouldRejectLeadingZero = [
      '01.2.3',   // leading zero in major
      '1.02.3',   // leading zero in minor
    ];
    for (const v of shouldRejectLeadingZero) {
      assert.equal(
        re.test(v), false,
        `Hotfix version "${v}" should be REJECTED (leading zero) but was accepted.\n` +
        `Pattern: ${hotfixPatterns[0]}\n` +
        `ADR-218 / #1186: restore (0|[1-9][0-9]*) on major and minor segments.`
      );
    }
  });
});
