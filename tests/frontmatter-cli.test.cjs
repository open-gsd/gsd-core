// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - frontmatter CLI integration
 *
 * Integration tests for the 4 frontmatter subcommands (get, set, merge, validate)
 * exercised through gsd-tools.cjs via execSync.
 *
 * Each test creates its own temp file, runs the CLI command, asserts output,
 * and cleans up in afterEach (per-test cleanup with individual temp files).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runGsdTools, parseFrontmatter, cleanup } = require('./helpers.cjs');

// Track temp files for cleanup
let tempFiles = [];

function writeTempFile(content) {
  const tmpFile = path.join(os.tmpdir(), `gsd-fm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmpFile, content, 'utf-8');
  tempFiles.push(tmpFile);
  return tmpFile;
}

afterEach(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* already cleaned */ }
  }
  tempFiles = [];
});

// ─── frontmatter get ────────────────────────────────────────────────────────

describe('frontmatter get', () => {
  test('returns all fields as JSON', () => {
    const file = writeTempFile('---\nphase: 01\nplan: 01\ntype: execute\n---\nbody text');
    const result = runGsdTools(['frontmatter', 'get', file]);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.phase, '01');
    assert.strictEqual(parsed.plan, '01');
    assert.strictEqual(parsed.type, 'execute');
  });

  test('returns specific field with --field', () => {
    const file = writeTempFile('---\nphase: 01\nplan: 02\ntype: tdd\n---\nbody');
    const result = runGsdTools(['frontmatter', 'get', file, '--field', 'phase']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.phase, '01');
  });

  test('returns error for missing field', () => {
    const file = writeTempFile('---\nphase: 01\n---\n');
    const result = runGsdTools(['frontmatter', 'get', file, '--field', 'nonexistent']);
    // The command succeeds (exit 0) but returns an error object in JSON
    assert.ok(result.success, 'Command should exit 0');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
    assert.ok(parsed.error.includes('Field not found'), 'Error should mention "Field not found"');
  });

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter get /nonexistent/path/file.md');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('handles file with no frontmatter', () => {
    const file = writeTempFile('Plain text with no frontmatter delimiters.');
    const result = runGsdTools(['frontmatter', 'get', file]);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.deepStrictEqual(parsed, {}, 'Should return empty object for no frontmatter');
  });
});

// ─── frontmatter set ────────────────────────────────────────────────────────

describe('frontmatter set', () => {
  test('updates existing field', () => {
    const file = writeTempFile('---\nphase: 01\ntype: execute\n---\nbody');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'phase', '--value', '02']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read back and verify
    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '02');
  });

  test('adds new field', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'status', '--value', 'active']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.status, 'active');
  });

  test('handles JSON array value', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'tags', '--value', '["a","b"]']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.ok(Array.isArray(fm.tags), 'tags should be an array');
    assert.deepStrictEqual(fm.tags, ['a', 'b']);
  });

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter set /nonexistent/file.md --field phase --value "01"');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('preserves body content after set', () => {
    const bodyText = '\n\n# My Heading\n\nSome paragraph with special chars: $, %, &.';
    const file = writeTempFile('---\nphase: 01\n---' + bodyText);
    runGsdTools(['frontmatter', 'set', file, '--field', 'phase', '--value', '02']);

    const content = fs.readFileSync(file, 'utf-8');
    assert.ok(content.includes('# My Heading'), 'heading should be preserved');
    assert.ok(content.includes('Some paragraph with special chars: $, %, &.'), 'body content should be preserved');
  });
});

// ─── frontmatter merge ──────────────────────────────────────────────────────

describe('frontmatter merge', () => {
  test('merges multiple fields into frontmatter', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', '{"plan":"02","type":"tdd"}']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '01', 'original field should be preserved');
    assert.strictEqual(fm.plan, '02', 'merged field should be present');
    assert.strictEqual(fm.type, 'tdd', 'merged field should be present');
  });

  test('overwrites existing fields on conflict', () => {
    const file = writeTempFile('---\nphase: 01\ntype: execute\n---\nbody');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', '{"phase":"02"}']);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(file, 'utf-8');
    const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
    const fm = extractFrontmatter(content);
    assert.strictEqual(fm.phase, '02', 'conflicting field should be overwritten');
    assert.strictEqual(fm.type, 'execute', 'non-conflicting field should be preserved');
  });

  test('returns error for missing file', () => {
    const result = runGsdTools(`frontmatter merge /nonexistent/file.md --data '{"phase":"01"}'`);
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });

  test('returns error for invalid JSON data', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', 'not json']);
    // cmdFrontmatterMerge calls error() which exits with code 1
    assert.ok(!result.success, 'Command should fail with non-zero exit code');
    assert.ok(result.error.includes('Invalid JSON'), 'Error should mention invalid JSON');
  });

  // Found while implementing #5105: `Object.assign` spread a JSON array or string into
  // index-named keys (`0: q`) and reported success.
  for (const data of ['["q"]', '"q"', '7', 'null']) {
    test(`rejects --data ${data} that is not a JSON object and writes nothing`, () => {
      const doc = '---\nphase: 01\n---\nbody';
      const file = writeTempFile(doc);
      const result = runGsdTools(['frontmatter', 'merge', file, '--data', data]);
      assert.ok(!result.success, `expected a rejection, got ${result.output}`);
      assert.match(result.error, /--data must be a JSON object/);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
    });
  }
});

// ─── frontmatter validate ───────────────────────────────────────────────────

describe('frontmatter validate', () => {
  test('reports valid for complete plan frontmatter', () => {
    const content = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid');
    assert.deepStrictEqual(parsed.missing, [], 'No fields should be missing');
    assert.strictEqual(parsed.schema, 'plan');
  });

  test('reports invalid with missing fields', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false, 'Should be invalid');
    assert.ok(parsed.missing.length > 0, 'Should have missing fields');
    // plan schema requires: phase, plan, type, wave, depends_on, files_modified, autonomous, must_haves
    // phase is present, so 7 should be missing
    assert.strictEqual(parsed.missing.length, 7, 'Should have 7 missing required fields');
    assert.ok(parsed.missing.includes('plan'), 'plan should be in missing');
    assert.ok(parsed.missing.includes('type'), 'type should be in missing');
    assert.ok(parsed.missing.includes('must_haves'), 'must_haves should be in missing');
  });

  test('validates against summary schema', () => {
    const content = `---
phase: 01
plan: 01
subsystem: testing
tags: [unit-tests, yaml]
duration: 5min
completed: 2026-02-25
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'summary']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid for summary schema');
    assert.strictEqual(parsed.schema, 'summary');
  });

  test('validates against verification schema', () => {
    const content = `---
phase: 01
verified: 2026-02-25
status: passed
score: 5/5
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'verification']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid for verification schema');
    assert.strictEqual(parsed.schema, 'verification');
  });

  test('returns error for unknown schema', () => {
    const file = writeTempFile('---\nphase: 01\n---\n');
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'unknown']);
    // cmdFrontmatterValidate calls error() which exits with code 1
    assert.ok(!result.success, 'Command should fail with non-zero exit code');
    assert.ok(result.error.includes('Unknown schema'), 'Error should mention unknown schema');
  });

  // #2847 review finding: a bare FRONTMATTER_SCHEMAS[schemaName] lookup resolves
  // prototype-chain keys to Object.prototype members instead of undefined, so the
  // `!schema` guard never fires and the command crashes with an uncaught TypeError
  // ("Cannot read properties of undefined (reading 'filter')") and a stack trace
  // instead of reporting "Unknown schema". Now that --schema is an agent-bound
  // variable ($SCHEMA in agents/gsd-planner.md's validate_plan step) rather than a
  // fixed literal, this is reachable from prompt state.
  for (const schemaName of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    test(`--schema ${schemaName} reports Unknown schema, not a crash`, () => {
      const file = writeTempFile('---\nphase: 01\n---\n');
      const result = runGsdTools(['frontmatter', 'validate', file, '--schema', schemaName]);
      assert.ok(!result.success, `--schema ${schemaName} should fail with a non-zero exit code, not crash`);
      assert.ok(
        result.error.includes('Unknown schema'),
        `--schema ${schemaName} error should be "Unknown schema...", not a TypeError stack trace; got: ${result.error}`
      );
      assert.ok(
        !result.error.includes('TypeError') && !result.error.includes('Cannot read properties'),
        `--schema ${schemaName} must not surface a raw TypeError; got: ${result.error}`
      );
    });
  }

  test('returns error for missing file', () => {
    const result = runGsdTools('frontmatter validate /nonexistent/file.md --schema plan');
    assert.ok(result.success, 'Command should exit 0 with error JSON');
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'Should have error field');
  });
});

// ─── frontmatter validate: plan-gap-closure schema (#2847) ───────────────────
//
// Regression coverage for #2847: "--gaps does not load planner-gap-closure.md,
// so generated gap plans may miss gap_closure metadata". A gap-closure plan
// with every other required field but no `gap_closure` used to report
// `valid: true` against the only schema the planner validated against
// (`plan`). Row 1 below is the failing-first regression test: it fails on
// pre-fix `FRONTMATTER_SCHEMAS` (no `plan-gap-closure` key exists — the CLI
// exits 1 with "Unknown schema: plan-gap-closure") and passes after the fix.

describe('frontmatter validate: plan-gap-closure schema (#2847)', () => {
  const PLAN_BODY_NO_GAP_CLOSURE = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
---
body`;

  // Row 1 — failing-first regression test.
  test('rejects plan-gap-closure frontmatter missing gap_closure (#2847)', () => {
    const file = writeTempFile(PLAN_BODY_NO_GAP_CLOSURE);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false, 'Should be invalid: gap_closure is missing');
    assert.ok(parsed.missing.includes('gap_closure'), 'gap_closure should be reported missing');
    assert.strictEqual(parsed.missing.length, 1, 'Only gap_closure should be missing; all other fields are present');
    assert.deepStrictEqual(parsed.invalidValue, [], 'gap_closure is ABSENT here, not wrong-valued — invalidValue must stay empty');
    assert.strictEqual(parsed.schema, 'plan-gap-closure');
  });

  // Row 2 — happy path.
  test('accepts complete plan-gap-closure frontmatter', () => {
    const content = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
gap_closure: true
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'Should be valid: gap_closure is present');
    assert.deepStrictEqual(parsed.missing, []);
    assert.ok(parsed.present.includes('gap_closure'));
    assert.deepStrictEqual(parsed.invalidValue, [], 'gap_closure has the correct value here — invalidValue must be empty');
    assert.strictEqual(parsed.schema, 'plan-gap-closure');
  });

  // Row 3 — empty/near-empty input boundary.
  test('reports all plan-gap-closure fields missing except phase for near-empty frontmatter', () => {
    const file = writeTempFile('---\nphase: 01\n---\nbody');
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false);
    // plan-gap-closure requires 9 fields; phase is present, so 8 should be missing.
    assert.strictEqual(parsed.missing.length, 8, 'Should have 8 missing required fields');
    assert.ok(parsed.missing.includes('gap_closure'), 'gap_closure should be among the missing fields');
  });

  // Row 4 — negative space: standard-mode ('plan' schema) plans are unaffected by #2847's fix.
  test('plan schema (standard/reviews mode) still reports valid without gap_closure — unaffected by #2847 fix', () => {
    const file = writeTempFile(PLAN_BODY_NO_GAP_CLOSURE);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'plan schema must not require gap_closure (AC(3): standard mode unaffected)');
    assert.deepStrictEqual(parsed.missing, []);
    assert.strictEqual(parsed.schema, 'plan');
  });

  // Row 5 — CRLF cross-platform newline handling.
  test('parses plan-gap-closure frontmatter with CRLF line endings', () => {
    const content = [
      '---',
      'phase: 01',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [src/auth.ts]',
      'autonomous: true',
      'must_haves:',
      '  truths:',
      '    - "All tests pass"',
      'gap_closure: true',
      '---',
      'body',
    ].join('\r\n');
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, true, 'CRLF frontmatter must parse identically to LF for plan-gap-closure');
    assert.ok(parsed.present.includes('gap_closure'));
  });

  // Row 6 — gap_closure: false must be REJECTED, not merely present.
  //
  // #2847 review finding: --gaps-only filters strictly on gap_closure === true
  // (execute-phase.md, partial-wave.md). A presence-only check (matching every
  // other required field) lets `gap_closure: false` validate as valid:true,
  // which is #2847's exact reported symptom — --gaps-only still spawns zero
  // executors — one value away. plan-gap-closure's requiredValues entry closes
  // this: gap_closure must be present AND equal "true" (extractFrontmatter
  // parses every scalar as a string; FrontmatterValue has no boolean member).
  test('gap_closure: false is rejected — plan-gap-closure requires the value true, not mere presence', () => {
    const content = `---
phase: 01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/auth.ts]
autonomous: true
must_haves:
  truths:
    - "All tests pass"
gap_closure: false
---
body`;
    const file = writeTempFile(content);
    const result = runGsdTools(['frontmatter', 'validate', file, '--schema', 'plan-gap-closure']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.valid, false, 'gap_closure: false must NOT satisfy plan-gap-closure');
    assert.ok(parsed.missing.includes('gap_closure'), 'gap_closure must be reported missing when its value is false');
    assert.ok(!parsed.present.includes('gap_closure'), 'gap_closure must not be reported present when its value is false');
    // #2847 review: presence alone is not the whole story here — the field IS in the
    // file, just wrong-valued. invalidValue distinguishes that from a genuinely absent
    // field (Row 1) so a caller (or a human) gets an actionable "the value is wrong",
    // not "this field is missing" for a field they can plainly see in the plan.
    assert.ok(
      parsed.invalidValue.includes('gap_closure'),
      'gap_closure must be reported in invalidValue — present but wrong-valued, distinct from genuinely absent'
    );
  });

  // Row 7 — invalidValue vs missing distinction, spelled out directly (not just
  // implied by Rows 1/2/6 individually).
  test('invalidValue distinguishes "present but wrong value" from "absent" for the same missing-reporting field', () => {
    const absentResult = JSON.parse(
      runGsdTools(['frontmatter', 'validate', writeTempFile(PLAN_BODY_NO_GAP_CLOSURE), '--schema', 'plan-gap-closure']).output
    );
    const wrongValueContent = PLAN_BODY_NO_GAP_CLOSURE.replace('---\nbody', 'gap_closure: TRUE\n---\nbody');
    const wrongValueResult = JSON.parse(
      runGsdTools(['frontmatter', 'validate', writeTempFile(wrongValueContent), '--schema', 'plan-gap-closure']).output
    );

    // Both report gap_closure as missing (the field does not satisfy the schema either way)...
    assert.ok(absentResult.missing.includes('gap_closure'));
    assert.ok(wrongValueResult.missing.includes('gap_closure'));
    // ...but only the wrong-VALUE case appears in invalidValue.
    assert.deepStrictEqual(absentResult.invalidValue, [], 'a genuinely absent field must not appear in invalidValue');
    assert.ok(
      wrongValueResult.invalidValue.includes('gap_closure'),
      'gap_closure: TRUE (capitalized YAML boolean, rejected — the validator requires the exact literal lowercase true) must appear in invalidValue'
    );
  });
});

// ─── frontmatter set/merge: must_haves object-list preservation (#1572) ──────
// `frontmatter set`/`merge` round-tripped the WHOLE frontmatter through the lossy
// extractFrontmatter → reconstructFrontmatter pair, which flattens must_haves
// object-list items ({path, provides} maps) to scalar strings and re-emits them as a
// malformed inline array — destroying `provides:` whenever an UNRELATED field changed.
// The fix preserves the original raw text for any structurally-unchanged top-level key.
const { parseMustHavesBlock } = require('../gsd-core/bin/lib/frontmatter.cjs');

describe('frontmatter set/merge preserves must_haves object-lists (#1572)', () => {
  const ARTIFACTS_PLAN = [
    '---',
    'phase: 1',
    'wave: 1',
    'plan: 01-01',
    'type: implementation',
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    'must_haves:',
    '  artifacts:',
    '    - path: src/foo.ts',
    '      provides: the foo',
    '    - path: src/bar.ts',
    '      provides: the bar',
    '---',
    '# body',
    '',
  ].join('\n');

  const PROHIBITIONS_PLAN = [
    '---',
    'phase: 1',
    'wave: 1',
    'must_haves:',
    '  prohibitions:',
    '    - statement: no direct DB calls',
    '      status: enforced',
    '    - statement: no print statements',
    '      status: pending',
    '---',
    '# body',
    '',
  ].join('\n');

  function runAndParse(plan, cmdArgsForFile) {
    const file = writeTempFile(plan);
    runGsdTools(cmdArgsForFile(file));
    const after = fs.readFileSync(file, 'utf-8');
    return after;
  }

  test('set on an unrelated scalar preserves every must_haves.artifacts entry (path + provides)', () => {
    const after = runAndParse(ARTIFACTS_PLAN, f => ['frontmatter', 'set', f, '--field', 'wave', '--value', '2']);
    assert.deepEqual(
      parseMustHavesBlock(after, 'artifacts'),
      [
        { path: 'src/foo.ts', provides: 'the foo' },
        { path: 'src/bar.ts', provides: 'the bar' },
      ],
      'must_haves.artifacts object-list must survive a set on an unrelated field (#1572)',
    );
  });

  test('merge of an unrelated field preserves every must_haves.artifacts entry', () => {
    const after = runAndParse(ARTIFACTS_PLAN, f => ['frontmatter', 'merge', f, '--data', JSON.stringify({ wave: 2 })]);
    assert.deepEqual(
      parseMustHavesBlock(after, 'artifacts'),
      [
        { path: 'src/foo.ts', provides: 'the foo' },
        { path: 'src/bar.ts', provides: 'the bar' },
      ],
      'must_haves.artifacts object-list must survive a merge of an unrelated field (#1572)',
    );
  });

  test('must_haves.prohibitions object-list is preserved on an unrelated set (same code path)', () => {
    const after = runAndParse(PROHIBITIONS_PLAN, f => ['frontmatter', 'set', f, '--field', 'wave', '--value', '2']);
    assert.deepEqual(
      parseMustHavesBlock(after, 'prohibitions'),
      [
        { statement: 'no direct DB calls', status: 'enforced' },
        { statement: 'no print statements', status: 'pending' },
      ],
      'must_haves.prohibitions object-list must survive a set on an unrelated field (#1572)',
    );
  });

  test('round-trip is stable: setting wave twice still preserves artifacts (per-key preservation is idempotent)', () => {
    const file = writeTempFile(ARTIFACTS_PLAN);
    runGsdTools(['frontmatter', 'set', file, '--field', 'wave', '--value', '2']);
    runGsdTools(['frontmatter', 'set', file, '--field', 'wave', '--value', '3']);
    const after = fs.readFileSync(file, 'utf-8');
    assert.deepEqual(
      parseMustHavesBlock(after, 'artifacts'),
      [
        { path: 'src/foo.ts', provides: 'the foo' },
        { path: 'src/bar.ts', provides: 'the bar' },
      ],
      'must_haves.artifacts must survive repeated sets on an unrelated field',
    );
  });

  test('directly setting must_haves to a new object-list fails closed instead of emitting [object Object] (#1572 codex review)', () => {
    // A CHANGED key whose value is an object-list cannot be faithfully serialized by the
    // lossy writer (it would emit "[object Object]"). Rather than silently destroy the
    // data, spliceFrontmatter throws — the command fails and the file is left unchanged.
    const file = writeTempFile(ARTIFACTS_PLAN);
    const result = runGsdTools([
      'frontmatter', 'set', file, '--field', 'must_haves',
      '--value', JSON.stringify({ artifacts: [{ path: 'src/new.ts', provides: 'new thing' }] }),
    ]);
    assert.ok(
      !result.success,
      'frontmatter set of a must_haves object-list must fail closed (refuse to emit "[object Object]")',
    );
    const after = fs.readFileSync(file, 'utf-8');
    assert.ok(!/\[object Object\]/.test(after), 'the file must not contain "[object Object]" after a refused set');
    assert.deepEqual(
      parseMustHavesBlock(after, 'artifacts'),
      [
        { path: 'src/foo.ts', provides: 'the foo' },
        { path: 'src/bar.ts', provides: 'the bar' },
      ],
      'the original must_haves.artifacts must be intact after the refused set',
    );
  });
});

// Bug #1660 — frontmatter set of an object-list field (e.g. must_haves) is a silent no-op
// when the new value's lossy parse projection equals the original's. Folded into the owning
// frontmatter-cli test (no new top-level bug-NNNN file).
describe('Bug #1660: frontmatter set of an object-list field fails closed instead of a silent no-op', () => {
  const PLAN_WITH_MUST_HAVES = [
    '---', 'phase: 1', 'wave: 1',
    'must_haves:', '  artifacts:', '    - path: src/foo.ts', '      provides: the foo',
    '---', '# body', '',
  ].join('\n');

  test('setting must_haves to a value that flattens to the original projection fails closed (no silent no-op)', () => {
    const file = writeTempFile(PLAN_WITH_MUST_HAVES);
    const before = fs.readFileSync(file, 'utf-8');
    // New value {artifacts:["path: src/foo.ts"]} — its extractFrontmatter projection equals
    // the original's flattened projection, so the set would otherwise be a silent no-op.
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'must_haves', '--value', JSON.stringify({ artifacts: ['path: src/foo.ts'] })]);
    const parsed = JSON.parse(result.output);
    assert.ok(parsed.error, 'a no-op set of an object-list field must surface an error, not silent {updated:true}');
    const after = fs.readFileSync(file, 'utf-8');
    assert.equal(after, before, 'the file must be unchanged when the set is refused (no silent partial write)');
  });

  test('an idempotent set of a scalar (wave, same value) still reports updated (no false positive)', () => {
    const file = writeTempFile('---\nphase: 1\nwave: 1\n---\n# body\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'wave', '--value', '1']);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'an idempotent SCALAR set must still report {updated:true} (not fail-closed)');
    assert.ok(!parsed.error, 'an idempotent scalar set must not produce an error');
  });

  test('an idempotent set of a scalar array (tags, same value) still reports updated (no false positive)', () => {
    const file = writeTempFile('---\nphase: 1\ntags: ["a","b"]\n---\n# body\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'tags', '--value', '["a","b"]']);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'an idempotent scalar-ARRAY set must still report {updated:true} (arrays round-trip; not fail-closed)');
    assert.ok(!parsed.error, 'an idempotent scalar-array set must not produce an error');
  });
});

// ─── #1778: thread workflow must use the 1.6 named-flag frontmatter.set form ─
//
// The thread workflow's CLOSE and RESUME branches previously invoked the
// pre-1.6 positional shape (frontmatter.set <file> <field> <value>). Since 1.6
// the dispatcher (gsd-tools.cjs) reads field/value from the named --field/
// --value flags via parseNamedArgs; the positional form leaves field/value
// undefined, cmdFrontmatterSet errors `file, field, and value required`, and
// the status/updated writes are silently skipped — so closing a thread never
// marked it status: resolved and resuming never marked it status: in_progress.
describe('#1778: thread workflow uses the 1.6 named-flag frontmatter.set form', () => {
  test('behavioral: named-flag form writes the field; positional form errors and does not mutate', () => {
    // 1.6 named-flag form — must succeed and write status: resolved.
    const goodFile = writeTempFile('---\nstatus: open\nupdated: "2025-01-01"\n---\n\n# thread body\n');
    const good = runGsdTools(['frontmatter', 'set', goodFile, '--field', 'status', '--value', 'resolved']);
    assert.ok(good.success, `named-flag form must succeed; stderr: ${good.error}`);
    assert.strictEqual(
      parseFrontmatter(fs.readFileSync(goodFile, 'utf-8')).status,
      'resolved',
      'named-flag form must write status: resolved into the file',
    );

    // Pre-1.6 positional form — must fail and NOT mutate.
    //
    // #3884 (ADR-3473 §8.4): the strict parser now rejects the stray
    // positional tokens ("status", "resolved") BEFORE cmdFrontmatterSet's own
    // "file, field, and value required" guard ever runs, so the error text
    // changed. The behavioral contract this test guards — fails, and does
    // NOT mutate the file — is unchanged and, if anything, strengthened (the
    // rejection now happens earlier, at argv-parsing time, not deep inside
    // the command).
    const badFile = writeTempFile('---\nstatus: open\nupdated: "2025-01-01"\n---\n\n# thread body\n');
    const bad = runGsdTools(['frontmatter', 'set', badFile, 'status', 'resolved']);
    assert.ok(!bad.success, 'positional form must fail (it is the bug being guarded against)');
    assert.ok(
      (bad.error + bad.output).includes('unexpected positional argument'),
      `positional form must error with the documented message; got:\n${bad.error}${bad.output}`,
    );
    assert.strictEqual(
      parseFrontmatter(fs.readFileSync(badFile, 'utf-8')).status,
      'open',
      'positional form must NOT mutate the file (the silent-failure bug)',
    );
  });

  test('workflow parity: no gsd-core/workflows/*.md emits the positional frontmatter.set form', () => {
    const workflowsDir = path.join(__dirname, '..', 'gsd-core', 'workflows');
    const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'expected at least one workflow under gsd-core/workflows/');

    const offenders = [];
    for (const name of files) {
      const full = path.join(workflowsDir, name);
      const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        // Match any frontmatter.set invocation (dot or space form, with or
        // without the `gsd_run query` prefix). The 1.6 contract requires
        // --field AND --value on every set call; a set line missing --field
        // is the pre-1.6 positional form (#1778).
        if (!/frontmatter[.\s]+set\b/.test(line)) return;
        if (!/--field\b/.test(line) || !/--value\b/.test(line)) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepStrictEqual(
      offenders,
      [],
      `These workflow frontmatter.set invocations are missing the 1.6 --field/--value named flags (the #1778 positional-form bug):\n  ${offenders.join('\n  ')}\n\nUse: gsd_run query frontmatter.set <file> --field <field> --value <value>`,
    );
  });

  test('thread workflow CLOSE writes status: resolved and RESUME writes status: in_progress via named flags', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'thread.md'), 'utf-8');

    // CLOSE mode: status resolved + updated, both via named flags.
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+status\s+--value\s+resolved\b/.test(src),
      'CLOSE mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field status --value resolved',
    );
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+updated\s+--value\s+YYYY-MM-DD\b/.test(src),
      'CLOSE mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field updated --value YYYY-MM-DD',
    );

    // RESUME mode: status in_progress + updated, both via named flags.
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+status\s+--value\s+in_progress\b/.test(src),
      'RESUME mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field status --value in_progress',
    );
  });
});

// ─── #1882: the user-reachable surface actually distinguishes the two cases ───

describe('frontmatter get — truncated vs absent frontmatter (#1882)', () => {
  const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  function runCapturingStderr(file) {
    const r = runNode([TOOLS, 'frontmatter', 'get', file, '--raw'], {
      env: { ...process.env, GSD_TEST_MODE: '1' },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const legacy = toLegacyResult(r);
    return { status: legacy.status, stdout: legacy.stdout.trim(), stderr: legacy.stderr.trim() };
  }

  // This is the wired keystone for #1882: the diagnostic is only "delivered" if it reaches
  // the surface a user actually invokes. The assertion is a DIFFERENTIAL between two runs —
  // whether stderr is empty — which is a behavioural claim, not a match against the message
  // wording, so it stays inside CONTRIBUTING.md's ban on raw text matching.
  test('a truncated file is reported while an absent-frontmatter file stays silent', () => {
    const truncated = writeTempFile('---\nphase: 01\nplan: half-written\n');
    const absent = writeTempFile('plain body with no frontmatter\n');

    const bad = runCapturingStderr(truncated);
    const good = runCapturingStderr(absent);

    // The contract every one of the ~50 callers depends on is unchanged for both.
    assert.strictEqual(bad.status, 0, 'truncated file must not change the exit code');
    assert.strictEqual(good.status, 0);
    assert.deepStrictEqual(JSON.parse(bad.stdout), {}, 'return value must be preserved');
    assert.deepStrictEqual(JSON.parse(good.stdout), {});

    // ...and the only difference is that corruption is no longer silent.
    assert.notStrictEqual(bad.stderr, '', 'a truncated frontmatter must be reported');
    assert.strictEqual(good.stderr, '', 'a file with no frontmatter is not corrupt');
  });

  test('a Markdown thematic break at byte 0 is not reported as corruption', () => {
    const thematicBreak = writeTempFile('---\nSome heading text\n\nA paragraph, no more dashes.\n');
    const r = runCapturingStderr(thematicBreak);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout), {});
    assert.strictEqual(r.stderr, '', 'a horizontal rule is valid Markdown, not a truncated file');
  });
});

// ─── #4806: unparseable frontmatter is a distinct error, not "Field not found" ──

describe('#4806 frontmatter get — unparseable frontmatter', () => {
  test('reports a parse error naming the field, not "Field not found"', () => {
    // An invalid backslash escape inside a double-quoted value is a YAML
    // SYNTAX error: the file HAS a status key but its frontmatter cannot be
    // read. Reporting "Field not found" tells the caller the key is absent —
    // indistinguishable from a file that genuinely lacks it.
    const file = writeTempFile('---\nstatus: "passed\n---\n\n# Verification Report\n');
    const result = runGsdTools(['frontmatter', 'get', file, '--field', 'status']);
    // The verb answers exit-0 JSON with an `error` FIELD (its documented
    // error shape) — the assertion is on the error text, not the exit code.
    assert.strictEqual(result.success, true, `command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(
      (parsed.error || '').includes('not parseable YAML'),
      `must report a parse error, got: ${JSON.stringify(parsed)}`,
    );
    assert.ok(!parsed.error.includes('Field not found'), 'parse failure must not read as Field not found');
  });

  test('a well-formed file still returns the field', () => {
    const file = writeTempFile('---\nstatus: passed\n---\n\n# V\n');
    const result = runGsdTools(['frontmatter', 'get', file, '--field', 'status']);
    assert.ok(result.success, `command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.status, 'passed');
  });
});

// ─── set/merge fail closed on a block the writer may not splice ──────────────
// Found while implementing #5105: an unparseable block was regenerated (losing a
// changed key's indented lines, or leaving the block unparseable so no reader saw the
// write). set/merge now report the writer's refusal and leave the file byte-identical.

describe('frontmatter set/merge — write refusal', () => {
  function fileIn(t, name, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fm-refusal-'));
    t.after(() => cleanup(dir));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  }

  const UNPARSEABLE_DOC = '---\nstatus:testing\nphase: 01\n---\n\n# UAT\n';

  test('set on an unparseable block reports FRONTMATTER_UNPARSEABLE and writes nothing', (t) => {
    const file = fileIn(t, 'uat.md', UNPARSEABLE_DOC);
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'status', '--value', 'complete']);
    assert.ok(result.success, `command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.code, 'FRONTMATTER_UNPARSEABLE');
    assert.ok(parsed.error.includes('not parseable YAML'), parsed.error);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), UNPARSEABLE_DOC);
  });

  test('merge on an unparseable block reports FRONTMATTER_UNPARSEABLE and writes nothing', (t) => {
    const file = fileIn(t, 'uat.md', UNPARSEABLE_DOC);
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', JSON.stringify({ status: 'complete' })]);
    assert.ok(result.success, `command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.code, 'FRONTMATTER_UNPARSEABLE');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), UNPARSEABLE_DOC);
  });

  test('set on a block with a duplicate key reports FRONTMATTER_KEYS_UNRECONCILABLE and writes nothing', (t) => {
    const doc = '---\nstatus: a\nstatus: b\nphase: 01\n---\n';
    const file = fileIn(t, 'dup.md', doc);
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'phase', '--value', '02']);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).code, 'FRONTMATTER_KEYS_UNRECONCILABLE');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
  });

  // M6: the lossy-object-list refusal compares VALUE lines, so any key spelling holding
  // object-list items is refused — not only the bare-ASCII one.
  for (const [label, keyLine, field] of [
    ['bare', 'must_haves:', 'must_haves'],
    ['double-quoted', '"must_haves":', 'must_haves'],
    ['Unicode', 'mușt:', 'mușt'],
  ]) {
    test(`set that would flatten a ${label}-key object-list is refused and writes nothing`, (t) => {
      const doc = `---\n${keyLine}\n  artifacts:\n    - path: a.md\n      provides: X\nstatus: t\n---\nbody\n`;
      const file = fileIn(t, 'plan.md', doc);
      const result = runGsdTools(['frontmatter', 'set', file, '--field', field, '--value', JSON.stringify({ artifacts: ['path: a.md'] })]);
      assert.ok(result.success, `command failed: ${result.error}`);
      const parsed = JSON.parse(result.output);
      assert.ok((parsed.error || '').includes('frontmatter set refused'), `expected a refusal, got ${result.output}`);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
    });
  }

  // The lossy object-list refusal locates the block through the one fence owner, so a
  // BOM document is refused exactly like an LF or CRLF one (found while implementing #5105).
  for (const [label, prefix, eol] of [['LF', '', '\n'], ['CRLF', '', '\r\n'], ['BOM', '\uFEFF', '\n']]) {
    test(`set that would flatten an object-list in a ${label} document is refused and writes nothing`, (t) => {
      const doc = prefix + ['---', 'must_haves:', '  artifacts:', '    - path: a.md', '      provides: X', 'status: t', '---', 'body', ''].join(eol);
      const file = fileIn(t, 'plan.md', doc);
      const result = runGsdTools(['frontmatter', 'set', file, '--field', 'must_haves', '--value', JSON.stringify({ artifacts: ['path: a.md'] })]);
      assert.ok(result.success, `command failed: ${result.error}`);
      const parsed = JSON.parse(result.output);
      assert.ok((parsed.error || '').includes('frontmatter set refused'), `expected a refusal, got ${result.output}`);
      assert.strictEqual(parsed.field, 'must_haves');
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
    });
  }

  test('merge that would flatten an object-list is refused with the same shape as set and writes nothing', (t) => {
    const doc = '---\nmust_haves:\n  artifacts:\n    - path: a.md\n      provides: X\nstatus: t\n---\nbody\n';
    const file = fileIn(t, 'plan.md', doc);
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', JSON.stringify({ status: 'done', must_haves: { artifacts: ['path: a.md'] } })]);
    assert.ok(result.success, `command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok((parsed.error || '').includes('frontmatter set refused'), `expected a refusal, got ${result.output}`);
    assert.strictEqual(parsed.field, 'must_haves');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
  });

  test('control: merge of an unrelated field beside an object-list still writes', (t) => {
    const doc = '---\nmust_haves:\n  artifacts:\n    - path: a.md\n      provides: X\nstatus: t\n---\nbody\n';
    const file = fileIn(t, 'plan.md', doc);
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', JSON.stringify({ status: 'done' })]);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).merged, true);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc.replace('status: t', 'status: done'));
  });

  // The lossy refusal protects only data the caller's parse could not see (a flattened
  // object-list item) — a field merely written in another style is not lossy. The trailing
  // comment stays on the key's line with the new value (the inline-comment guarantee).
  for (const [label, doc, field, value, expected] of [
    ['single-quoted scalar', "---\ntitle: 'x'\nstatus: t\n---\nbody\n", 'title', 'Y', '---\ntitle: Y\nstatus: t\n---\nbody\n'],
    ['scalar with a trailing comment', '---\ntitle: x # c\nstatus: t\n---\nbody\n', 'title', 'Y', '---\ntitle: Y # c\nstatus: t\n---\nbody\n'],
    ['block list', '---\ntags:\n  - a\n  - b\nstatus: t\n---\nbody\n', 'tags', '["c"]', '---\ntags: [c]\nstatus: t\n---\nbody\n'],
  ]) {
    for (const cmd of ['set', 'merge']) {
      test(`${cmd} over a ${label} is not refused as lossy`, (t) => {
        const file = fileIn(t, 'plan.md', doc);
        const args = cmd === 'set'
          ? ['frontmatter', 'set', file, '--field', field, '--value', value]
          : ['frontmatter', 'merge', file, '--data', JSON.stringify({ [field]: field === 'tags' ? JSON.parse(value) : value })];
        const result = runGsdTools(args);
        assert.ok(result.success, `command failed: ${result.error}`);
        assert.ok(!JSON.parse(result.output).error, result.output);
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), expected);
      });
    }
  }

  test('merge over a multi-line quoted scalar replaces the whole value and the file reads back', (t) => {
    const file = fileIn(t, 'plan.md', '---\ntitle: "foo\nbar baz"\nstatus: t\n---\nbody\n');
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', JSON.stringify({ title: 'X' })]);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).merged, true);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\ntitle: X\nstatus: t\n---\nbody\n');
  });

  for (const [label, field] of [['LF', 'a\nb'], ['CR', 'a\rb'], ['TAB', 'a\tb'], ['DEL', 'a\u007fb'], ['ESC', 'a\u001bb']]) {
    test(`set with a ${label} control character in the field name is rejected and writes nothing`, (t) => {
      const doc = '---\nstatus: t\n---\nbody\n';
      const file = fileIn(t, 'plan.md', doc);
      const result = runGsdTools(['frontmatter', 'set', file, '--field', field, '--value', 'v']);
      assert.ok(!result.success, `expected a rejection, got ${result.output}`);
      assert.match(result.error, /field name contains a control character/);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
    });
  }

  test('control: a field name with a space and a colon is still settable and reads back', (t) => {
    const file = fileIn(t, 'plan.md', '---\nstatus: t\n---\nbody\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'a: b', '--value', 'v']);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\nstatus: t\n"a: b": v\n---\nbody\n');
  });

  test('control: a quoted scalar key is still settable (value comparison, not key spelling)', (t) => {
    const file = fileIn(t, 'plan.md', '---\n"wave": 1\nstatus: t\n---\nbody\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'wave', '--value', '"2"']);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).updated, true);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\nwave: 2\nstatus: t\n---\nbody\n');
  });

  // Found while implementing #5105: a changed key is regenerated, and a full-line comment
  // nested inside its value is data the author wrote (#3257/#3742). It is re-emitted beside
  // the sub-key it leads; where it cannot be, the write is refused — never silently dropped.
  const NESTED_COMMENT_DOC = '---\nprogress:\n  # hand note: keep\n  done: 1\n  total: 2\nstatus: t\n---\nbody\n';

  // The same document as LF, as CRLF and behind a BOM: the comment guarantee holds for each.
  // `written` is what lands on disk — `platformWriteSync` publishes every file with LF endings.
  const LINE_ENDING_VARIANTS = [
    ['LF', (doc) => doc, (doc) => doc],
    ['CRLF', (doc) => doc.replace(/\n/g, '\r\n'), (doc) => doc],
    ['BOM', (doc) => `\uFEFF${doc}`, (doc) => `\uFEFF${doc}`],
  ];

  for (const [variant, shape, written] of LINE_ENDING_VARIANTS) {
    test(`set of a map keeps a full-line comment leading a surviving sub-key (${variant})`, (t) => {
      const file = fileIn(t, 'state.md', shape(NESTED_COMMENT_DOC));
      const result = runGsdTools(['frontmatter', 'set', file, '--field', 'progress', '--value', JSON.stringify({ done: 2, total: 2 })]);
      assert.ok(result.success, `command failed: ${result.error}`);
      assert.strictEqual(JSON.parse(result.output).updated, true);
      assert.strictEqual(
        fs.readFileSync(file, 'utf-8'),
        written('---\nprogress:\n  # hand note: keep\n  done: 2\n  total: 2\nstatus: t\n---\nbody\n'),
      );
    });

    test(`set that would drop the comment leading a removed sub-key is refused and writes nothing (${variant})`, (t) => {
      const doc = shape(NESTED_COMMENT_DOC);
      const file = fileIn(t, 'state.md', doc);
      const result = runGsdTools(['frontmatter', 'set', file, '--field', 'progress', '--value', JSON.stringify({ total: 3 })]);
      assert.ok(result.success, `command failed: ${result.error}`);
      assert.strictEqual(JSON.parse(result.output).code, 'FRONTMATTER_COMMENT_WOULD_BE_LOST', result.output);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
    });
  }

  // A comment belongs to the exact key path it leads: a top-level key literally named `a.b`
  // is not the sub-key `b` of map `a` (found while implementing #5105).
  test('set of map "a" leaves the comment of a top-level key named "a.b" where it is', (t) => {
    const file = fileIn(t, 'state.md', '---\na:\n  b: 1\n  c: 2\n# top-level a.b note\na.b: 3\nstatus: t\n---\nbody\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'a', '--value', JSON.stringify({ b: 1, c: 5 })]);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).updated, true, result.output);
    assert.strictEqual(
      fs.readFileSync(file, 'utf-8'),
      '---\na:\n  b: 1\n  c: 5\n# top-level a.b note\na.b: 3\nstatus: t\n---\nbody\n',
    );
  });

  test('set that removes a sub-key is refused even when a top-level "a.b" carries an identical comment', (t) => {
    const doc = '---\na:\n  # x\n  c: 2\n  b: 1\n# x\na.b: 3\nstatus: t\n---\nbody\n';
    const file = fileIn(t, 'state.md', doc);
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'a', '--value', JSON.stringify({ b: 1 })]);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).code, 'FRONTMATTER_COMMENT_WOULD_BE_LOST', result.output);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
  });

  // An inline comment (`a: 1  # note`) inside a changed value is kept on the line of the key it
  // sits beside when that key survives, and the write is refused when it does not.
  for (const [label, doc, value, expected] of [
    ['a surviving sub-key whose value is unchanged', '---\nm:\n  a: 1  # note a\n  b: 2\nstatus: t\n---\nbody\n', { a: 1, b: 3 },
      '---\nm:\n  a: 1  # note a\n  b: 3\nstatus: t\n---\nbody\n'],
    ['a surviving sub-key whose value changed', '---\nm:\n  a: 1  # note a\n  b: 2\nstatus: t\n---\nbody\n', { a: 5, b: 2 },
      '---\nm:\n  a: 5  # note a\n  b: 2\nstatus: t\n---\nbody\n'],
    ['the line opening the changed map', '---\nm:  # opener note\n  a: 1\nstatus: t\n---\nbody\n', { a: 2 },
      '---\nm:  # opener note\n  a: 2\nstatus: t\n---\nbody\n'],
    ['a surviving nested map opener two levels deep', '---\nm:\n  x:  # x note\n    y: 1\nstatus: t\n---\nbody\n', { x: { y: 2 } },
      '---\nm:\n  x:  # x note\n    y: 2\nstatus: t\n---\nbody\n'],
    ['a changed top-level scalar', '---\nm: draft  # one of draft|done\nstatus: t\n---\nbody\n', 'done',
      '---\nm: done  # one of draft|done\nstatus: t\n---\nbody\n'],
  ]) {
    test(`set keeps an inline comment on ${label}`, (t) => {
      const file = fileIn(t, 'state.md', doc);
      const result = runGsdTools(['frontmatter', 'set', file, '--field', 'm', '--value', JSON.stringify(value)]);
      assert.ok(result.success, `command failed: ${result.error}`);
      assert.strictEqual(JSON.parse(result.output).updated, true, result.output);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), expected);
    });
  }

  for (const [label, doc, value] of [
    ['a removed sub-key', '---\nm:\n  a: 1  # note a\n  b: 2\nstatus: t\n---\nbody\n', { b: 3 }],
    ['an item of a changed block list', '---\nm:\n  - a  # why a\n  - b\nstatus: t\n---\nbody\n', ['a', 'c']],
    ['a sub-key of a map replaced by a scalar', '---\nm:\n  a: 1  # note a\nstatus: t\n---\nbody\n', 'flat'],
  ]) {
    test(`set that would drop an inline comment on ${label} is refused and writes nothing`, (t) => {
      const file = fileIn(t, 'state.md', doc);
      const result = runGsdTools(['frontmatter', 'set', file, '--field', 'm', '--value', JSON.stringify(value)]);
      assert.ok(result.success, `command failed: ${result.error}`);
      assert.strictEqual(JSON.parse(result.output).code, 'FRONTMATTER_COMMENT_WOULD_BE_LOST', result.output);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
    });
  }

  test('control: a `#` inside a quoted sub-key value is value text, not an inline comment', (t) => {
    const file = fileIn(t, 'state.md', '---\nm:\n  a: "x # y"\n  b: 2\nstatus: t\n---\nbody\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'm', '--value', JSON.stringify({ a: 'x # y', b: 3 })]);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).updated, true, result.output);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\nm:\n  a: "x # y"\n  b: 3\nstatus: t\n---\nbody\n');
  });

  test('control: an inline comment on an unchanged top-level key stays byte-identical', (t) => {
    const file = fileIn(t, 'state.md', '---\nstatus: t   # keep  me\nm: 1\n---\nbody\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'm', '--value', '2']);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).updated, true, result.output);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\nstatus: t   # keep  me\nm: 2\n---\nbody\n');
  });

  test('merge of a map keeps a full-line comment leading a sub-key two levels deep', (t) => {
    const doc = '---\nm:\n  x:\n    # deep note\n    y: 1\n  # z note\n  z: 3\nstatus: t\n---\nbody\n';
    const file = fileIn(t, 'state.md', doc);
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', JSON.stringify({ m: { x: { y: '2' }, z: '3' } })]);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).merged, true);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\nm:\n  x:\n    # deep note\n    y: 2\n  # z note\n  z: 3\nstatus: t\n---\nbody\n');
  });

  for (const [label, doc, field, value] of [
    ['a sub-key removed together with the comment leading it', NESTED_COMMENT_DOC, 'progress', { total: 3 }],
    ['a map replaced by a scalar', NESTED_COMMENT_DOC, 'progress', 'done'],
    ['a comment between the items of a changed block list', '---\ntags:\n  - a\n  # why b\n  - b\nstatus: t\n---\nbody\n', 'tags', ['a', 'c']],
    ['a comment trailing inside a changed map', '---\np:\n  a: 1\n  # tail note\nstatus: t\n---\nbody\n', 'p', { a: '2' }],
  ]) {
    for (const cmd of ['set', 'merge']) {
      test(`${cmd} that would drop ${label} is refused with FRONTMATTER_COMMENT_WOULD_BE_LOST and writes nothing`, (t) => {
        const file = fileIn(t, 'state.md', doc);
        const args = cmd === 'set'
          ? ['frontmatter', 'set', file, '--field', field, '--value', JSON.stringify(value)]
          : ['frontmatter', 'merge', file, '--data', JSON.stringify({ [field]: value })];
        const result = runGsdTools(args);
        assert.ok(result.success, `command failed: ${result.error}`);
        const parsed = JSON.parse(result.output);
        assert.strictEqual(parsed.code, 'FRONTMATTER_COMMENT_WOULD_BE_LOST', result.output);
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
      });
    }
  }

  test('control: a `#` line inside a block scalar is value text, not a comment — replacing it writes', (t) => {
    const file = fileIn(t, 'plan.md', '---\nd: |\n  # heading\n  text\nstatus: t\n---\nbody\n');
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'd', '--value', 'new']);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).updated, true);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\nd: new\nstatus: t\n---\nbody\n');
  });

  test('control: deleting a whole key takes the comments inside its value with it (#3257 AC5)', (t) => {
    const file = fileIn(t, 'state.md', NESTED_COMMENT_DOC);
    const result = runGsdTools(['frontmatter', 'set', file, '--field', 'progress', '--value', 'null']);
    assert.ok(result.success, `command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).updated, true);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\nstatus: t\n---\nbody\n');
  });

  test('merge with a control character in a field name is rejected and writes nothing', (t) => {
    const doc = '---\nstatus: t\n---\nbody\n';
    const file = fileIn(t, 'plan.md', doc);
    const result = runGsdTools(['frontmatter', 'merge', file, '--data', JSON.stringify({ 'a\nb': 'v', 'c\u001bd': 'w' })]);
    assert.ok(!result.success, `expected a rejection, got ${result.output}`);
    assert.match(result.error, /field name contains a control character/);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), doc);
  });

  // `Object.assign` / `fm[field] =` treat `__proto__` as the prototype setter: the key was
  // never written while the command reported success (found while implementing #5105).
  for (const cmd of ['set', 'merge']) {
    test(`${cmd} of a field named __proto__ writes the key and it reads back`, (t) => {
      const file = fileIn(t, 'plan.md', '---\nstatus: t\n---\nbody\n');
      const args = cmd === 'set'
        ? ['frontmatter', 'set', file, '--field', '__proto__', '--value', '{"x":"1"}']
        : ['frontmatter', 'merge', file, '--data', '{"__proto__":{"x":"1"}}'];
      const result = runGsdTools(args);
      assert.ok(result.success, `command failed: ${result.error}`);
      assert.ok(!JSON.parse(result.output).error, result.output);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), '---\nstatus: t\n__proto__:\n  x: 1\n---\nbody\n');
      const got = runGsdTools(['frontmatter', 'get', file]);
      assert.ok(got.success, `get failed: ${got.error}`);
      const reread = JSON.parse(got.output);
      assert.ok(Object.prototype.hasOwnProperty.call(reread, '__proto__'), got.output);
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(reread, '__proto__').value, { x: '1' });
    });
  }
});
