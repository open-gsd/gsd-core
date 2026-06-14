// allow-test-rule: source-text-is-the-product
// Structural guard: reads gsd-core/workflows/verify-phase.md and asserts that
// the audit_test_quality step contains the skip-pattern marker, circular-detection
// marker, and assertion-strength table markers. Goes red if that workflow guidance
// is removed or the step is renamed/deleted.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'verify-phase.md'
);

// Read once at module load so every test sees the same snapshot.
const workflowSrc = fs.readFileSync(WORKFLOW_PATH, 'utf8');

// Locate the audit_test_quality step boundaries so sub-assertions are scoped
// to that step only, not the full file.
const STEP_OPEN = '<step name="audit_test_quality">';
const STEP_CLOSE = '</step>';

function extractAuditStep(src) {
  const start = src.indexOf(STEP_OPEN);
  if (start === -1) return null;
  const end = src.indexOf(STEP_CLOSE, start + STEP_OPEN.length);
  if (end === -1) return null;
  return src.slice(start, end + STEP_CLOSE.length);
}

const auditStepSrc = extractAuditStep(workflowSrc);

describe('verify-phase.md audit_test_quality structural guard', () => {
  test('verify-phase.md exists at gsd-core/workflows/verify-phase.md', () => {
    assert.ok(
      fs.existsSync(WORKFLOW_PATH),
      `missing workflow file: ${WORKFLOW_PATH}`
    );
  });

  test('audit_test_quality step is present in verify-phase.md', () => {
    assert.ok(
      auditStepSrc !== null,
      `<step name="audit_test_quality"> not found in ${WORKFLOW_PATH} — the step ` +
        'may have been renamed or removed'
    );
  });

  describe('skip-pattern marker', () => {
    test('audit_test_quality step contains the disabled-test grep pattern', () => {
      // The step must instruct the verifier to search for skip patterns such as
      // it\.skip / describe\.skip / test\.skip (regex-escaped, as used in the bash grep).
      // Removing this guidance would mean skipped requirement tests are no longer flagged.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check skip-pattern marker: audit_test_quality step not found'
      );
      // The markdown shows a bash grep -E pattern, so dots are backslash-escaped:
      // 'it\\.skip' in JS is the string  it\.skip  (backslash + dot).
      const hasSkipPattern =
        auditStepSrc.includes('it\\.skip') &&
        auditStepSrc.includes('describe\\.skip') &&
        auditStepSrc.includes('test\\.skip');
      assert.ok(
        hasSkipPattern,
        'audit_test_quality step must reference it\\.skip, describe\\.skip, and test\\.skip ' +
          'as the disabled-test grep pattern — one or more are missing'
      );
    });

    test('audit_test_quality step references todo variants alongside skip variants', () => {
      // it\.todo / test\.todo are also considered disabled patterns by the step.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check todo marker: audit_test_quality step not found'
      );
      const hasTodo =
        auditStepSrc.includes('it\\.todo') || auditStepSrc.includes('test\\.todo');
      assert.ok(
        hasTodo,
        'audit_test_quality step must reference it\\.todo or test\\.todo as a disabled pattern'
      );
    });
  });

  describe('circular-detection marker', () => {
    test('audit_test_quality step contains the circular file-write grep pattern', () => {
      // The step must tell the verifier to grep for writeFileSync / writeFile / fs\.write
      // to locate scripts that might be generating expected values from the SUT.
      // The markdown shows a bash grep -E pattern, so the dot in fs.write is escaped:
      // 'fs\\.write' in JS is the string  fs\.write  (backslash + dot).
      assert.ok(
        auditStepSrc !== null,
        'Cannot check circular-detection marker: audit_test_quality step not found'
      );
      const hasWritePattern =
        auditStepSrc.includes('writeFileSync') &&
        auditStepSrc.includes('writeFile') &&
        auditStepSrc.includes('fs\\.write');
      assert.ok(
        hasWritePattern,
        'audit_test_quality step must include writeFileSync, writeFile, and fs\\.write ' +
          'in the circular-detection grep pattern — one or more are missing'
      );
    });

    test('audit_test_quality step defines CIRCULAR as a blocker verdict', () => {
      // The step must explicitly name CIRCULAR as an outcome and mark it as a blocker.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check CIRCULAR verdict: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('CIRCULAR'),
        'audit_test_quality step must define CIRCULAR as a verdict for circular tests'
      );
    });
  });

  describe('assertion-strength table markers', () => {
    test('audit_test_quality step contains the assertion-strength section header', () => {
      // The "5. Assertion strength" section heading anchors the classification table.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check assertion-strength header: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('Assertion strength'),
        'audit_test_quality step must contain the "Assertion strength" section header'
      );
    });

    test('audit_test_quality step lists existence-only examples in the assertion table', () => {
      // The table must include toBeDefined as an example of an existence-level assertion.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check assertion table: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('toBeDefined'),
        'audit_test_quality step must include toBeDefined as an existence-level assertion example'
      );
    });

    test('audit_test_quality step lists value-level examples in the assertion table', () => {
      // The table must include toBeCloseTo as an example of a value-level assertion.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check value assertion example: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('toBeCloseTo'),
        'audit_test_quality step must include toBeCloseTo as a value-level assertion example'
      );
    });

    test('audit_test_quality step defines INSUFFICIENT verdict for weak assertions', () => {
      // The step must explicitly name INSUFFICIENT as the verdict when assertion strength
      // is below what the requirement demands.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check INSUFFICIENT verdict: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('INSUFFICIENT'),
        'audit_test_quality step must define INSUFFICIENT as a verdict for weak assertions'
      );
    });
  });
});
