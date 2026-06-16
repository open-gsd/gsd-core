// allow-test-rule: source-text-is-the-product #968
// Enhancement #968: region-scoped negative gate detector + guidance docs.
// Tests the pure function scanFileWideNegativeGateConflict exported from
// verify.cjs, plus CLI integration and doc-contract assertions.

'use strict';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

// Build path to built verify.cjs
const VERIFY_CJS = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verify.cjs');

// Build paths to doc files
const PLANNER_MD = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
const ANTIPATTERNS_MD = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-antipatterns.md');
// PLAN_MD_REF removed — was unused (doc-contract cases test PLANNER_MD and ANTIPATTERNS_MD only)

// ─── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Build a minimal two-task plan fixture.
 * taskA: file=app/page.py, gateText=the verify/acceptance_criteria block, actionText=action block
 * taskB: file=app/page.py (default) or otherFile, action text
 * allowlistMarker: optional HTML comment to insert at the top
 */
function makeTwoTaskPlan({
  taskAFile = 'app/page.py',
  taskAGate = '! grep -Eq \'await .*refresh\' app/page.py',
  taskAAction = 'Refactor the factory to be synchronous.',
  taskBFile = 'app/page.py',
  taskBAction = 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
  allowlistMarker = '',
} = {}) {
  const lines = [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    `files_modified: [${taskAFile}, ${taskBFile}]`,
    'autonomous: true',
    'must_haves:',
    '  - AC1',
    '---',
    '',
    '# Test Plan',
    '',
  ];

  if (allowlistMarker) {
    lines.push(allowlistMarker, '');
  }

  // Task A: the one with the negative gate
  lines.push('<task>');
  lines.push('<name>Task A: factory refactor</name>');
  lines.push(`<files>${taskAFile}</files>`);
  lines.push(`<action>${taskAAction}</action>`);
  lines.push(`<verify><automated>${taskAGate}</automated></verify>`);
  lines.push('<done>Factory is synchronous.</done>');
  lines.push('</task>');
  lines.push('');

  // Task B: the sibling that requires the construct
  lines.push('<task>');
  lines.push('<name>Task B: reindex handler</name>');
  lines.push(`<files>${taskBFile}</files>`);
  lines.push(`<action>${taskBAction}</action>`);
  lines.push('<verify><automated>npm test</automated></verify>');
  lines.push('<done>Handler is in place.</done>');
  lines.push('</task>');

  return lines.join('\n');
}

/**
 * Build a single-task plan (no sibling).
 */
function makeSingleTaskPlan({
  taskFile = 'app/page.py',
  taskGate = '! grep -Eq \'await .*refresh\' app/page.py',
  taskAction = 'Refactor the factory to be synchronous.',
} = {}) {
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    `files_modified: [${taskFile}]`,
    'autonomous: true',
    'must_haves:',
    '  - AC1',
    '---',
    '',
    '# Test Plan',
    '',
    '<task>',
    '<name>Task A: factory refactor</name>',
    `<files>${taskFile}</files>`,
    `<action>${taskAction}</action>`,
    `<verify><automated>${taskGate}</automated></verify>`,
    '<done>Factory is synchronous.</done>',
    '</task>',
  ].join('\n');
}

// ─── Group 1: pure-function unit tests ────────────────────────────────────────

describe('scanFileWideNegativeGateConflict — pure unit tests', () => {
  let scan;

  before(() => {
    const verify = require(VERIFY_CJS);
    scan = verify.scanFileWideNegativeGateConflict;
    assert.ok(typeof scan === 'function', 'scanFileWideNegativeGateConflict must be exported');
  });

  // Case 1: basic WARN path — Task A bans PAT file-wide, Task B requires it in same file
  test('case 1 — file-wide ban + sibling requires → WARN', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(Array.isArray(result.warnings), 'must return { warnings: [] }');
    assert.ok(
      result.warnings.length >= 1,
      `expected at least 1 warning, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings[0].includes('Region-scope conflict (#968)'),
      `warning must mention Region-scope conflict (#968), got: ${result.warnings[0]}`,
    );
    assert.ok(
      result.warnings[0].includes('await .*refresh'),
      `warning must mention the PAT, got: ${result.warnings[0]}`,
    );
    assert.ok(
      result.warnings[0].includes('app/page.py'),
      `warning must mention the file, got: ${result.warnings[0]}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 2: region-scoped via sed → NO warn
  test('case 2 — region-scoped via sed pipe → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! sed -n '12,40p' app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `sed-piped grep is region-scoped — must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 2b: region-scoped via awk → NO warn
  test('case 2b — region-scoped via awk pipe → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! awk '/^def make_page/,/^def /' app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `awk-piped grep is region-scoped — must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 3: single task file-wide ban, no sibling → NO warn
  test('case 3 — single task, no sibling → NO warn', () => {
    const content = makeSingleTaskPlan({
      taskGate: "! grep -Eq 'await .*refresh' app/page.py",
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `single task (no sibling) must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 4: sibling requires PAT but lists a different file → NO warn
  test('case 4 — sibling lists different file → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAFile: 'app/page.py',
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBFile: 'app/other.py',
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `sibling with different file must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 5: sibling lists same file but action lacks PAT → NO warn
  test('case 5 — sibling lists same file but action lacks PAT → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls bridge.sync() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `sibling with no PAT in action must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 6: positive grep (no !) + sibling → NO warn (positive requirement, not a ban)
  test('case 6 — positive grep (no !) + sibling → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "grep -q 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `positive grep must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 7: inverted grep -v with ! + sibling → NO warn
  test('case 7 — inverted grep -vq with ! + sibling → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -vq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `inverted grep (-v) must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 8: allowlist marker present → NO warn
  test('case 8 — allowlist marker suppresses warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
      allowlistMarker: '<!-- planner-region-allow: await .*refresh -->',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `allowlist marker must suppress warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 9: one task both bans and requires same PAT in same file (no second task) → NO warn
  test('case 9 — one task bans and requires PAT (no sibling) → NO warn', () => {
    const content = makeSingleTaskPlan({
      taskGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskAction: 'Refactor to avoid await refresh, but note that bridge.refresh() is used later.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `single task (no sibling B) must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 10: count form `grep -c 'PAT' FILE == 0` + sibling → WARN
  test('case 10 — count form (grep -c PAT FILE == 0) + sibling → WARN', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "grep -c 'await .*refresh' app/page.py == 0",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `count form (grep -c ... == 0) must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 11: bracket form `[ $(grep -c PAT FILE) -eq 0 ]` + sibling → WARN
  test('case 11 — bracket form ([ $(grep -c PAT FILE) -eq 0 ]) + sibling → WARN', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "[ $(grep -c 'await .*refresh' app/page.py) -eq 0 ]",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `bracket form must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 12: CRLF variant of case 1 → WARN
  test('case 12 — CRLF line endings → WARN', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const crlfContent = content.split('\n').join('\r\n');
    const result = scan(crlfContent);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `CRLF content must still warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 13: backslash line-continuation variant → WARN
  test('case 13 — backslash line continuation → WARN', () => {
    // Build manually to control exact line continuation
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [app/page.py]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Task A: factory refactor</name>',
      '<files>app/page.py</files>',
      '<action>Refactor the factory to be synchronous.</action>',
      // Gate split across lines with backslash continuation
      "<verify><automated>! grep -Eq 'await .*refresh' \\\napp/page.py</automated></verify>",
      '<done>Factory is synchronous.</done>',
      '</task>',
      '',
      '<task>',
      '<name>Task B: reindex handler</name>',
      '<files>app/page.py</files>',
      '<action>Add a post-reindex handler that calls await bridge.refresh() to repopulate state.</action>',
      '<verify><automated>npm test</automated></verify>',
      '<done>Handler is in place.</done>',
      '</task>',
    ].join('\n');
    const result = scan(lines);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `backslash continuation must still warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 14: mixed line with positive gate AND a negative gate, sibling → WARN (on the negative only)
  test('case 14 — mixed positive+negative on one segment + sibling → WARN for negative', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "grep -c 'X' app/page.py == 1 && ! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `mixed line with negative gate + sibling must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 15: glob file arg `app/*.py` → NO warn (unresolvable path)
  test('case 15 — glob file arg → NO warn (unresolvable)', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/*.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `glob file arg must not warn (unresolvable), got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 16: invalid-regex PAT literal fallback → WARN, no exception
  test('case 16 — invalid-regex PAT → literal fallback, WARN, no exception', () => {
    // "await (refresh" — unbalanced paren, invalid regex
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await (refresh' app/page.py",
      taskBAction: 'The handler calls await (refresh on bridge to repopulate state.',
    });
    let result;
    assert.doesNotThrow(() => {
      result = scan(content);
    }, 'scan must not throw on invalid regex PAT');
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `invalid-regex PAT with literal match must warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 17: ReDoS-ish PAT (catastrophic backtracking) → no hang, no false warn.
  // The sibling action is 5000 'a's — classic ReDoS trigger if we call new RegExp('(a+)+$').
  // Proof-of-no-hang: the test runner's own timeout catches it; a hanging test fails here.
  // No timing assertion (flaky) — the linear patternRequiredIn implementation is microsecond-fast.
  test('case 17 — catastrophic ReDoS pattern is instant, no hang, no false warn', () => {
    const longAs = 'a'.repeat(5000);
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq '(a+)+$' app/page.py",
      taskBAction: `Reindex handler that processes ${longAs} records and calls bridge.refresh().`,
    });
    let result;
    assert.doesNotThrow(() => {
      result = scan(content);
    }, 'scan must not throw on ReDoS-ish PAT');
    // The literal '(a+)+$' is not present in the action text as a substring → no warn.
    // (If new RegExp were used, this test would hang before reaching this assertion.)
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `catastrophic PAT '(a+)+$' not literally in action — must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(Array.isArray(result.warnings), 'valid result shape');
  });

  // Case 23 (mutation-catching): cat producer = file-wide → WARN; sed producer = region-scoped → NO warn
  test('case 23a — cat pipe: ! cat app/page.py | grep -Eq PAT + sibling → WARN (file-wide via cat)', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! cat app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `cat-piped grep is file-wide — must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.valid !== false, 'valid must remain true even when #968 warns');
  });

  test('case 23b — sed pipe: ! sed -n "12,40p" app/page.py | grep -Eq PAT + sibling → NO warn (region-scoped)', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! sed -n '12,40p' app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `sed-piped grep is region-scoped — must NOT warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 24: awk region → NO warn
  test('case 24 — awk region pipe: ! awk \'/^def make_page/,/^def /\' app/page.py | grep -Eq PAT + sibling → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! awk '/^def make_page/,/^def /' app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `awk-piped grep is region-scoped — must NOT warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 25: basename non-over-match — different dirs, same basename → NO warn
  test('case 25 — basename non-over-match: different dirs same filename → NO warn', () => {
    // Task A bans on apps/web/config.py; Task B lists apps/admin/config.py
    // Same basename "config.py" but different dirs → must NOT warn
    const content = makeTwoTaskPlan({
      taskAFile: 'apps/web/config.py',
      taskAGate: "! grep -Eq 'await .*refresh' apps/web/config.py",
      taskBFile: 'apps/admin/config.py',
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `different dirs (apps/web/config.py vs apps/admin/config.py) — same basename but must NOT warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 26: extensionless known file (Dockerfile) recognized via knownFiles → WARN
  test('case 26 — extensionless known file (Dockerfile) via knownFiles → WARN', () => {
    // Task A has ! grep -Eq 'FROM scratch' Dockerfile
    // Dockerfile has no extension, so looksLikePath would miss it — but knownFiles should catch it
    // Task B lists Dockerfile in <files> and action requires 'FROM scratch'
    const content = makeTwoTaskPlan({
      taskAFile: 'Dockerfile',
      taskAGate: "! grep -Eq 'FROM scratch' Dockerfile",
      taskBFile: 'Dockerfile',
      taskBAction: 'Update the image base: FROM scratch ensures minimal surface area.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `Dockerfile (extensionless, known via <files>) should be recognized — must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.valid !== false, 'valid must remain true');
  });

  // Case 27: wildcard semantic match — patternRequiredIn handles .* correctly
  test('case 27 — wildcard semantic match: "await .*refresh" (gate) warns when action has "await bridge.refresh()"', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `patternRequiredIn must match "await .*refresh" against "await bridge.refresh()" — must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 4b: same-file positive control — sibling lists the SAME banned file + requires PAT → WARN
  // Paired with case 4: proves the no-warn in case 4 is due to the file mismatch, not a dead detector.
  test('case 4b — same-file positive control: sibling lists same file → WARN (proves case 4 no-warn is file-mismatch)', () => {
    const content = makeTwoTaskPlan({
      taskAFile: 'app/page.py',
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBFile: 'app/page.py',
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `same-file sibling must warn — proves case 4's no-warn is due to file mismatch, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 7b: non-inverted positive control — without -v the ban IS detected → WARN
  // Paired with case 7: proves the -v skip is what suppresses case 7.
  test('case 7b — non-inverted positive control: ! grep -q (no -v) + sibling → WARN (proves case 7 no-warn is -v skip)', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -q 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `non-inverted ! grep -q must warn — proves the -v flag is what suppresses case 7, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 25b: basename-fallback positive — bare unqualified filename matches sibling's qualified path → WARN
  // Paired with case 25: proves the bare-name basename fallback at src ~line 525 actually fires.
  // Case 25 only proves qualified paths don't over-match; this proves the bare fallback does fire.
  test('case 25b — basename-fallback positive: bare gate file matches sibling qualified path → WARN (proves basename fallback fires)', () => {
    // Task A gate uses bare "config.py" (no directory prefix — unqualified).
    // Task B lists "apps/admin/config.py" (qualified). basename("apps/admin/config.py") === "config.py".
    // The basename fallback (line 525) should match → WARN.
    const content = makeTwoTaskPlan({
      taskAFile: 'config.py',
      taskAGate: "! grep -Eq 'await .*refresh' config.py",
      taskBFile: 'apps/admin/config.py',
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `bare gate file "config.py" must match sibling "apps/admin/config.py" via basename fallback — must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 28: anchored pattern warns after ^ strip — proves anchor stripping works
  // Gate: ! grep -Eq '^FROM scratch' Dockerfile
  // Sibling B lists Dockerfile, action requires 'FROM scratch' (no anchor in prose).
  // Without anchor stripping, "^FROM scratch" would be treated as containing metacharacters
  // and fall back to literal-substring: "^FROM scratch" not in B's prose → no warn.
  // With anchor stripping, "FROM scratch" is the effective literal → found in B's prose → WARN.
  test('case 28 — anchored pattern warns: ! grep -Eq \'^FROM scratch\' Dockerfile + sibling → WARN (proves ^ strip)', () => {
    const content = makeTwoTaskPlan({
      taskAFile: 'Dockerfile',
      taskAGate: "! grep -Eq '^FROM scratch' Dockerfile",
      taskBFile: 'Dockerfile',
      taskBAction: 'Update the image base: FROM scratch ensures minimal surface area.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `anchored pattern "^FROM scratch" must warn after ^ is stripped — "FROM scratch" is in sibling action, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 29: alternation falls back conservatively — documents the known limitation.
  // Gate: ! grep -Eq 'debug|trace' src/logger.ts
  // Sibling B lists src/logger.ts, action says "remove debug calls" (contains "debug" but NOT "debug|trace").
  // patternRequiredIn sees unhandled `|` in joined frags → literal-substring fallback on raw pattern.
  // "debug|trace" is NOT literally in B's prose → conservative NO warn.
  // This is intentional: false-negative is the safe direction for a warn-only advisory.
  test('case 29 — alternation conservative fallback: "debug|trace" → NO warn (documents alternation limitation)', () => {
    // NOTE: This is intended conservative behavior, not a bug.
    // patternRequiredIn falls back to literal-substring for patterns containing `|` (alternation),
    // because safely expanding alternation without new RegExp would require a mini-parser.
    // The literal "debug|trace" is not present verbatim in the action, so no warn fires.
    // A planner who writes `debug|trace` gets no advisory — acceptable, since a false-negative
    // is always safer than a false-positive for a warn-only gate.
    const content = makeTwoTaskPlan({
      taskAFile: 'src/logger.ts',
      taskAGate: "! grep -Eq 'debug|trace' src/logger.ts",
      taskBFile: 'src/logger.ts',
      taskBAction: 'Remove debug calls from the logger module to reduce noise.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `alternation pattern "debug|trace" must conservatively NOT warn — literal "debug|trace" not in action, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 18: empty content → no crash, no #968 warn
  test('case 18 — empty content → no crash', () => {
    let result;
    assert.doesNotThrow(() => {
      result = scan('');
    });
    assert.ok(Array.isArray(result.warnings), 'must return { warnings: [] }');
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      'empty content must produce no #968 warn',
    );
  });

  // Case 18b: no-task plan → no crash
  test('case 18b — no-task plan → no crash', () => {
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: []',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '# No tasks here',
    ].join('\n');
    let result;
    assert.doesNotThrow(() => {
      result = scan(content);
    });
    assert.strictEqual(result.warnings.filter(w => w.includes('#968')).length, 0);
  });
});

// ─── Group 2: end-to-end via runGsdTools ──────────────────────────────────────

describe('scanFileWideNegativeGateConflict — end-to-end via verify plan-structure', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Case 19: integration — valid stays true despite warning (warn-only)
  test('case 19 — integration: valid===true despite #968 warning', () => {
    const planContent = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const planDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-01-PLAN.md'), planContent);

    const result = runGsdTools(
      'verify plan-structure .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.valid,
      true,
      `#968 is warn-only: valid must be true, got: ${JSON.stringify(parsed)}`,
    );
    assert.ok(
      parsed.warnings.some(w => w.includes('#968')),
      `must have a #968 warning, got: ${JSON.stringify(parsed.warnings)}`,
    );
  });
});

// ─── Group 3: doc-contract ────────────────────────────────────────────────────

describe('doc-contract: guidance prose is in place', () => {
  // Case 20: gsd-planner.md has the new guidance
  test('case 20 — gsd-planner.md contains Region-scoped negative gates + reference', () => {
    const content = fs.readFileSync(PLANNER_MD, 'utf8');
    assert.ok(
      content.includes('Region-scoped negative gates'),
      'gsd-planner.md must include "Region-scoped negative gates"',
    );
    assert.ok(
      content.includes('planner-antipatterns.md'),
      'gsd-planner.md must reference planner-antipatterns.md',
    );
  });

  // Case 21: planner-antipatterns.md has the new section
  test('case 21 — planner-antipatterns.md has ## Region-Scoped Negative Gates + examples', () => {
    const content = fs.readFileSync(ANTIPATTERNS_MD, 'utf8');
    assert.ok(
      content.includes('## Region-Scoped Negative Gates'),
      'planner-antipatterns.md must include "## Region-Scoped Negative Gates"',
    );
    assert.ok(
      content.includes('await .*refresh'),
      'planner-antipatterns.md must include the worked example pattern "await .*refresh"',
    );
    // Verify sed or awk region example is present
    const hasSedOrAwk = content.includes('sed -n') || content.includes('awk ');
    assert.ok(
      hasSedOrAwk,
      'planner-antipatterns.md must include sed-n or awk region example',
    );
  });
});

// ─── Group 4: AC3 executable proof ───────────────────────────────────────────

describe('AC3: executable proof — file-wide ban vs region-scoped simultaneously satisfiable', () => {
  test('case 22 — grep/sed proof: both gates simultaneously satisfiable', () => {
    // Check if grep and sed are available
    const grepAvail = spawnSync('grep', ['--version']).status === 0;
    const sedAvail = spawnSync('sed', ['--version']).status === 0 ||
                    spawnSync('sed', ['-n', '1p', '/dev/null']).status === 0;

    if (!grepAvail || !sedAvail) {
      // Skip gracefully if tools are unavailable
      return;
    }

    // Write a temp Python file with:
    //   def make_page(): — no await refresh
    //   async def reindex_handler(): — awaits bridge.refresh()
    const tmpFile = path.join(os.tmpdir(), `gsd-968-proof-${process.pid}.py`);
    const pyContent = [
      'def make_page():',
      '    """Synchronous factory — must not block on a refresh."""',
      '    return {"title": "My Page"}',
      '',
      '',
      'async def reindex_handler():',
      '    """Post-reindex callback — must await bridge.refresh() to repopulate state."""',
      '    await bridge.refresh()',
      '    return True',
    ].join('\n');
    fs.writeFileSync(tmpFile, pyContent);

    try {
      // (a) File-wide: grep -Eq 'await .*refresh' <file> — should EXIT 0 (pattern found)
      //     This means a file-wide ban (! grep -Eq ...) WOULD FAIL
      const fileWide = spawnSync('grep', ['-Eq', 'await .*refresh', tmpFile]);
      assert.strictEqual(
        fileWide.status,
        0,
        'grep file-wide should find the pattern (exits 0) — proving the file-wide ban would fail',
      );

      // (b) Region-scoped (make_page only): sed extracts lines 1-3, piped to grep → pattern NOT found
      //     The factory region is clean: ban PASSES
      const makePageLines = spawnSync('sed', ['-n', '1,3p', tmpFile]);
      assert.strictEqual(makePageLines.status, 0, 'sed should succeed');
      const makePageRegion = makePageLines.stdout.toString();

      // Write to a temp file and grep it
      const regionFile = path.join(os.tmpdir(), `gsd-968-region-${process.pid}.py`);
      fs.writeFileSync(regionFile, makePageRegion);
      try {
        const regionBan = spawnSync('grep', ['-Eq', 'await .*refresh', regionFile]);
        assert.strictEqual(
          regionBan.status,
          1,
          'grep in make_page region should NOT find pattern (exits 1) — ban PASSES in factory region',
        );

        // (c) Region-scoped (reindex_handler): grep should FIND the pattern → requirement met
        const reindexLines = spawnSync('sed', ['-n', '6,9p', tmpFile]);
        const reindexRegion = reindexLines.stdout.toString();
        const reindexFile = path.join(os.tmpdir(), `gsd-968-reindex-${process.pid}.py`);
        fs.writeFileSync(reindexFile, reindexRegion);
        try {
          const reindexCheck = spawnSync('grep', ['-Eq', 'await .*refresh', reindexFile]);
          assert.strictEqual(
            reindexCheck.status,
            0,
            'grep in reindex_handler region MUST find pattern (exits 0) — requirement met',
          );
        } finally {
          try { fs.unlinkSync(reindexFile); } catch { /* ignore */ }
        }
      } finally {
        try { fs.unlinkSync(regionFile); } catch { /* ignore */ }
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});
