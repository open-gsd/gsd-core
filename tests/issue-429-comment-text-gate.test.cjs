// allow-test-rule: source-text-is-the-product
// Issue #429: the gate logic is tested behaviorally via the exported pure
// function + runGsdTools; the discipline rule + allowlist escape hatch are
// asserted against the agent/reference .md whose text IS the deployed contract.

'use strict';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

// Build path to built verify.cjs
const VERIFY_CJS = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verify.cjs');

// fast-check: loaded at top level so skip flags evaluate correctly
let fc;
try { fc = require('fast-check'); } catch { fc = null; }
// Build path to agent/reference files
const PLANNER_MD = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
const ANTIPATTERNS_MD = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-antipatterns.md');

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makePlan({ negativeGrep, actionEcho, allowlistMarker, positiveGrep } = {}) {
  const lines = [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [src/animal-detail.tsx]',
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

  lines.push('<task>');
  lines.push('<name>Test task</name>');
  lines.push('<action>');
  if (actionEcho) {
    lines.push(actionEcho);
  } else {
    lines.push('Do the work.');
  }
  lines.push('</action>');

  if (positiveGrep) {
    lines.push(`<verify><automated>${positiveGrep}</automated></verify>`);
  } else if (negativeGrep) {
    lines.push(`<verify><automated>${negativeGrep}</automated></verify>`);
  } else {
    lines.push('<verify><automated>npm test</automated></verify>');
  }

  lines.push('<done>Task complete</done>');
  lines.push('</task>');

  return lines.join('\n');
}

// ─── Group 1: pure-function unit tests ────────────────────────────────────────

describe('scanNegativeGrepCommentEcho — pure unit tests', () => {
  let scanNegativeGrepCommentEcho;

  before(() => {
    const verify = require(VERIFY_CJS);
    scanNegativeGrepCommentEcho = verify.scanNegativeGrepCommentEcho;
  });

  test('case 1 — regression Plan 12-04: action echoes the forbidden literal', () => {
    const content = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `expected 1 error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('?from='), `error should mention ?from=, got: ${result.errors[0]}`);
  });

  test('case 2 — regression Plan 11-04: JSDoc head-comment echoes CardModalHost', () => {
    const content = makePlan({
      negativeGrep: "grep -c 'CardModalHost' file == 0",
      actionEcho: '* @see CardModalHost for the deprecated pattern.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `expected 1 error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('CardModalHost'), `error should mention CardModalHost, got: ${result.errors[0]}`);
  });

  test('case 3 — regression Plan 12-02: head-comment echoes .catch(() => null) (regex-special chars)', () => {
    const content = makePlan({
      negativeGrep: "grep -c '.catch(() => null)' file == 0",
      actionEcho: '// Old pattern: .catch(() => null)',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `expected 1 error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('.catch(() => null)'), `error should mention the literal, got: ${result.errors[0]}`);
  });

  test('case 4 — boundary: positive count gate (== 60) must NOT be flagged (AC#2)', () => {
    const content = makePlan({
      positiveGrep: "grep -c '= makeParallel(' file == 60",
      actionEcho: 'Use makeParallel() for concurrent processing.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, `positive count gate must not flag, errors: ${JSON.stringify(result.errors)}`);
  });

  test('case 5 — no echo: literal only in verify, not in action', () => {
    const content = makePlan({
      negativeGrep: "grep -c 'LEGACY_TOKEN' file == 0",
      actionEcho: 'Remove the old token handling.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, 'should be no errors');
    assert.strictEqual(result.warnings.length, 0, 'should be no warnings');
  });

  test('case 6 — allowlist marker suppresses the error', () => {
    const content = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
      allowlistMarker: '<!-- planner-discipline-allow: ?from= -->',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, `allowlist should suppress error, got: ${JSON.stringify(result.errors)}`);
  });

  test('case 7 — ambiguous unquoted bareword echo: warning not error', () => {
    const content = makePlan({
      negativeGrep: 'grep -c badToken file == 0',
      actionEcho: 'Remove badToken from codebase.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, `ambiguous token must not error, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.warnings.length, 1, `ambiguous token should warn once, got: ${JSON.stringify(result.warnings)}`);
    assert.ok(result.warnings[0].includes('badToken'), `warning should mention badToken, got: ${result.warnings[0]}`);
  });

  test('case 8 — negative-grep command inside an <action> does NOT self-flag', () => {
    // action tells executor to ADD the verify command — the grep itself is in the action
    // but there is no echo of selfToken outside the grep command
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Add verify command</name>',
      '<action>',
      "Add this to the CI script: grep -c 'selfToken' file == 0",
      '</action>',
      '<verify><automated>npm test</automated></verify>',
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const r = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(r.errors.length, 0, `grep command in action must not self-flag, errors: ${JSON.stringify(r.errors)}`);
  });

  test('case 9 — CRLF newlines are normalized', () => {
    const content = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
    });
    const crlfContent = content.split('\n').join('\r\n');
    const result = scanNegativeGrepCommentEcho(crlfContent);
    assert.strictEqual(result.errors.length, 1, `CRLF content should still find error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('?from='));
  });

  test('case 10 — multiple distinct echoed literals each produce their own error', () => {
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Multi literal task</name>',
      '<action>',
      "Remove tokA and tokB from the codebase.",
      '</action>',
      "<verify><automated>grep -c 'tokA' file == 0 && grep -c 'tokB' file == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 2, `expected 2 errors (one per literal), got: ${JSON.stringify(result.errors)}`);
  });

  test('case 11 — != 0 and >= 0 are NOT negative gates', () => {
    const verify = require(VERIFY_CJS);
    const content1 = makePlan({
      negativeGrep: "grep -c 'nz' file != 0",
      actionEcho: 'Ensure nz is present.',
    });
    const r1 = verify.scanNegativeGrepCommentEcho(content1);
    assert.strictEqual(r1.errors.length, 0, `!= 0 must not trigger, errors: ${JSON.stringify(r1.errors)}`);

    const content2 = makePlan({
      negativeGrep: "grep -c 'nz' file >= 0",
      actionEcho: 'Ensure nz is present.',
    });
    const r2 = verify.scanNegativeGrepCommentEcho(content2);
    assert.strictEqual(r2.errors.length, 0, `>= 0 must not trigger, errors: ${JSON.stringify(r2.errors)}`);
  });

  // ── Bug-fix regression tests (adversarial-review findings) ───────────────────

  test('case 12 — mixed positive+negative on one line: no false positive for positive gate token', () => {
    // Bug 1: mixed positive+negative greps on one physical line — presentTok is a
    // *positive* gate (== 1) and absentTok is a *negative* gate (== 0). Only absentTok
    // should be flagged; presentTok must not produce a spurious error.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Mixed gate task</name>',
      '<action>',
      'Use presentTok for the new pattern.',
      'Do not use absentTok any more.',
      '</action>',
      "<verify><automated>grep -c 'presentTok' f == 1 && grep -c 'absentTok' f == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `expected exactly 1 error (absentTok only), got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('absentTok'), `error must name absentTok, got: ${result.errors[0]}`);
    assert.ok(!result.errors[0].includes('presentTok'), `error must NOT name presentTok, got: ${result.errors[0]}`);
  });

  test('case 13 — grep -c -F (separate count+fixed flags) extracts literal', () => {
    // Bug 2: grep -c -F 'LIT' was not extracted by the old regex that required -c
    // immediately before the pattern without intervening flags.
    const verify = require(VERIFY_CJS);
    const content = makePlan({
      negativeGrep: "grep -c -F '.catch(() => null)' f == 0",
      actionEcho: '// Old pattern: .catch(() => null)',
    });
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `grep -c -F must extract literal, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('.catch(() => null)'), `error must name the literal, got: ${result.errors[0]}`);
  });

  test('case 14 — grep -F -c (reversed flag order) extracts literal', () => {
    // Bug 2: grep -F -c 'LIT' — count flag not in the first position after grep.
    const verify = require(VERIFY_CJS);
    const content = makePlan({
      negativeGrep: "grep -F -c 'CardModalHost' f == 0",
      actionEcho: '* @see CardModalHost for the deprecated pattern.',
    });
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `grep -F -c must extract literal, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('CardModalHost'), `error must name CardModalHost, got: ${result.errors[0]}`);
  });

  test('case 15 — grep --count (long option) extracts literal', () => {
    // Bug 2: grep --count 'LIT' was not matched by the old -c pattern.
    const verify = require(VERIFY_CJS);
    const content = makePlan({
      negativeGrep: "grep --count 'longCountTok' f == 0",
      actionEcho: 'Remove longCountTok from the codebase.',
    });
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `grep --count must extract literal, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('longCountTok'), `error must name longCountTok, got: ${result.errors[0]}`);
  });

  test('case 16 — same-line command span stripped but prose echo on same line is still caught', () => {
    // Bug 3: the old code filtered entire lines; a line with a pasted grep command AND
    // a prose echo would be dropped, silencing the error. Only the command SPAN should
    // be stripped; prose on the same line that echoes the token must still be detected.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Span strip task</name>',
      '<action>',
      // Single line: pasted command PLUS a prose mention of spanTok outside the command
      "Run grep -c 'spanTok' f == 0 to confirm; note spanTok must be gone.",
      '</action>',
      "<verify><automated>grep -c 'spanTok' f == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `prose echo outside command span must still be caught, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('spanTok'), `error must name spanTok, got: ${result.errors[0]}`);
  });

  test('case 17 — command-only action (no prose echo) still does NOT self-flag', () => {
    // Bug 3 regression guard: when the ONLY occurrence of the token in an action is
    // inside the grep command span itself, no error should fire.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Solo command task</name>',
      '<action>',
      "grep -c 'soloTok' file == 0",
      '</action>',
      "<verify><automated>grep -c 'soloTok' file == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 0, `command-only action must not self-flag, errors: ${JSON.stringify(result.errors)}`);
  });

  test('case 18 — multi-line backslash continuation in verify command is joined and detected', () => {
    // Bug 4: a verify command split with trailing backslash was not joined, so the
    // == 0 appeared on a continuation line without the grep prefix → missed.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Multi-line verify task</name>',
      '<action>',
      'Remove mlTok from all modules.',
      '</action>',
      '<verify><automated>grep -c \'mlTok\' file \\\n  == 0</automated></verify>',
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `backslash-continued verify must be detected, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('mlTok'), `error must name mlTok, got: ${result.errors[0]}`);
  });

  // ── (A) assignment is not a gate ──────────────────────────────────────────────

  test('case 19 — bare STATUS=0 assignment after semicolon is not a negative gate', () => {
    // grep -c '...' f > /dev/null; STATUS=0 is an assignment, not a == 0 gate.
    // deprecatedTok is echoed in the action but the verify line has no == 0 gate,
    // so no error should fire.
    const content = makePlan({
      negativeGrep: "grep -c 'deprecatedTok' src/m.ts > /dev/null; STATUS=0",
      actionEcho: 'Remove deprecatedTok from the module.',
    });
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, [
      'assignment after semicolon must not be treated as a negative gate,',
      `errors: ${JSON.stringify(result.errors)}`,
    ].join(' '));
  });

  test('case 19b — positive control: spaced == 0 IS a gate and fires when token is echoed', () => {
    // Same plan as case 19 but the verify line now uses the real == 0 gate form.
    // deprecatedTok is echoed in the action → expect exactly 1 error.
    const content = makePlan({
      negativeGrep: "grep -c 'deprecatedTok' src/m.ts == 0",
      actionEcho: 'Remove deprecatedTok from the module.',
    });
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, [
      'spaced == 0 gate with echoed token must produce exactly 1 error,',
      `errors: ${JSON.stringify(result.errors)}`,
    ].join(' '));
    assert.ok(result.errors[0].includes('deprecatedTok'), `error must name deprecatedTok, got: ${result.errors[0]}`);
  });

  // ── (B) inverted count is not a negative gate ─────────────────────────────────

  test('case 20 — grep -cv with == 0 is NOT a negative gate', () => {
    // -cv counts non-matching lines; "== 0" on a -cv result is a positive assertion
    // (all lines match), which is out of scope for the negative-grep gate rule.
    // invTok is echoed in the action but no error should fire.
    const content = makePlan({
      negativeGrep: "grep -cv 'invTok' file == 0",
      actionEcho: 'Ensure every line contains invTok.',
    });
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, [
      'grep -cv counts non-matching lines; == 0 is a positive assertion — must not flag,',
      `errors: ${JSON.stringify(result.errors)}`,
    ].join(' '));
  });
});

// ─── Group 2: end-to-end via runGsdTools ──────────────────────────────────────

describe('scanNegativeGrepCommentEcho — end-to-end via verify plan-structure', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('e2e case 1 — echoed literal causes valid:false', () => {
    const planContent = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
    });
    const planDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-01-PLAN.md'), planContent);

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, `expected valid:false, got: ${JSON.stringify(output)}`);
    assert.ok(
      output.errors.some(e => e.includes('?from=')),
      `expected an error mentioning ?from=, got: ${JSON.stringify(output.errors)}`,
    );
  });

  test('e2e case 2 — allowlist marker causes valid:true', () => {
    const planContent = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
      allowlistMarker: '<!-- planner-discipline-allow: ?from= -->',
    });
    const planDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-01-PLAN.md'), planContent);

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, `expected valid:true with allowlist, got: ${JSON.stringify(output)}`);
  });
});

// ─── Group 3: doc-contract (source-text-is-the-product) ───────────────────────

describe('doc-contract: agent/reference .md files carry the deployed contract text', () => {
  test('gsd-planner.md contains <comment_text_discipline> block', () => {
    const content = fs.readFileSync(PLANNER_MD, 'utf8');
    assert.ok(content.includes('<comment_text_discipline>'), 'gsd-planner.md must contain <comment_text_discipline>');
  });

  test('gsd-planner.md contains a usage example (<!-- planner-discipline-allow: ...)', () => {
    const content = fs.readFileSync(PLANNER_MD, 'utf8');
    assert.ok(
      content.includes('<!-- planner-discipline-allow:'),
      'gsd-planner.md must contain an HTML comment example of the allowlist syntax',
    );
  });

  test('planner-antipatterns.md contains Comment-Text Discipline section heading', () => {
    const content = fs.readFileSync(ANTIPATTERNS_MD, 'utf8');
    assert.ok(
      content.includes('Comment-Text Discipline'),
      'planner-antipatterns.md must contain a Comment-Text Discipline section',
    );
  });

  test('planner-antipatterns.md contains planner-discipline-allow: syntax', () => {
    const content = fs.readFileSync(ANTIPATTERNS_MD, 'utf8');
    assert.ok(
      content.includes('planner-discipline-allow:'),
      'planner-antipatterns.md must contain planner-discipline-allow: syntax',
    );
  });
});

// ─── Group 4: property-based (fast-check) ────────────────────────────────────

describe('property-based: scanNegativeGrepCommentEcho — fast-check', () => {
  let scanNegativeGrepCommentEcho;

  before(() => {
    const verify = require(VERIFY_CJS);
    scanNegativeGrepCommentEcho = verify.scanNegativeGrepCommentEcho;
  });

  // Two-arm property (alphanumeric literals — DEFECT.GENERATIVE-FIX parity guard):
  // both arms in one property so no stub can pass.
  // arm1: lit only in gate (no echo) → 0 errors
  // arm2: lit in gate AND echoed in action → exactly 1 error naming lit
  test('property (two-arm): gate-only → 0 errors; gate+echo → 1 error', { skip: !fc }, () => {
    if (!fc) return;
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{2,12}$/),
        (lit) => {
          const base = [
            '---',
            'phase: 01-test',
            'plan: 01',
            'type: execute',
            'wave: 1',
            'depends_on: []',
            'files_modified: [f.ts]',
            'autonomous: true',
            'must_haves:',
            '  - AC1',
            '---',
            '',
            '<task>',
            '<name>T</name>',
          ];
          const verifyLine = `<verify><automated>grep -c '${lit}' f.ts == 0</automated></verify>`;

          // arm1: no echo in action
          const arm1 = base.concat([
            '<action>Do work, not the forbidden thing.</action>',
            verifyLine,
            '<done>Done</done>',
            '</task>',
          ]).join('\n');
          const r1 = scanNegativeGrepCommentEcho(arm1);
          if (r1.errors.length !== 0) return false;

          // arm2: echo in action
          const arm2 = base.concat([
            `<action>Remove ${lit} from codebase.</action>`,
            verifyLine,
            '<done>Done</done>',
            '</task>',
          ]).join('\n');
          const r2 = scanNegativeGrepCommentEcho(arm2);
          return r2.errors.length === 1 && r2.errors[0].includes(lit);
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  // Two-arm property (regex-special literal alphabet): proves substring matching, not regex.
  // Generates literals from safe chars that include regex-special characters.
  // Same two-arm structure: gate-only → 0 errors; gate+echo → 1 error naming lit.
  test('property (two-arm, regex-special chars): gate-only → 0 errors; gate+echo → 1 error', { skip: !fc }, () => {
    if (!fc) return;
    const safeChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.()?=*+[]{}-.'.split('');
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...safeChars), { minLength: 3, maxLength: 15 }).map(a => a.join('')),
        (lit) => {
          // skip if lit contains single-quote (would break fixture shell quoting)
          if (lit.includes("'")) return true;
          const base = [
            '---',
            'phase: 01-test',
            'plan: 01',
            'type: execute',
            'wave: 1',
            'depends_on: []',
            'files_modified: [f.ts]',
            'autonomous: true',
            'must_haves:',
            '  - AC1',
            '---',
            '',
            '<task>',
            '<name>T</name>',
          ];
          const verifyLine = `<verify><automated>grep -c '${lit}' f.ts == 0</automated></verify>`;

          // arm1: no echo in action
          const arm1 = base.concat([
            '<action>Do work, not the forbidden thing.</action>',
            verifyLine,
            '<done>Done</done>',
            '</task>',
          ]).join('\n');
          const r1 = scanNegativeGrepCommentEcho(arm1);
          if (r1.errors.length !== 0) return false;

          // arm2: echo in action (wrap in prose so it is unambiguously a prose echo)
          const arm2 = base.concat([
            `<action>Remove the token ${lit} from codebase.</action>`,
            verifyLine,
            '<done>Done</done>',
            '</task>',
          ]).join('\n');
          const r2 = scanNegativeGrepCommentEcho(arm2);
          return r2.errors.length === 1 && r2.errors[0].includes(lit);
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });
});

// ─── Group 5: allowlist-syntax parity (DEFECT.GENERATIVE-FIX) ─────────────────
// Couples the documented marker syntax to runtime behaviour.
// If the marker prefix is renamed in code without updating docs (or vice versa), this
// test breaks — preventing silent drift between the two surfaces.

describe('allowlist-syntax parity: doc marker == runtime marker', () => {
  let scanNegativeGrepCommentEcho;

  before(() => {
    const verify = require(VERIFY_CJS);
    scanNegativeGrepCommentEcho = verify.scanNegativeGrepCommentEcho;
  });

  test('ALLOW_PREFIX appears in both gsd-planner.md and planner-antipatterns.md', () => {
    // allow-test-rule: source-text-is-the-product
    const ALLOW_PREFIX = '<!-- planner-discipline-allow:';
    const plannerContent = fs.readFileSync(PLANNER_MD, 'utf8');
    const antipatternContent = fs.readFileSync(ANTIPATTERNS_MD, 'utf8');
    assert.ok(
      plannerContent.includes(ALLOW_PREFIX),
      `gsd-planner.md must contain "${ALLOW_PREFIX}"`,
    );
    assert.ok(
      antipatternContent.includes(ALLOW_PREFIX),
      `planner-antipatterns.md must contain "${ALLOW_PREFIX}"`,
    );
  });

  test('ALLOW_PREFIX gates runtime: without marker → error; with marker → 0 errors', () => {
    const ALLOW_PREFIX = '<!-- planner-discipline-allow:';

    // Without marker: parityTok is echoed in action and gated in verify → must error
    const withoutMarker = makePlan({
      negativeGrep: "grep -c 'parityTok' src/m.ts == 0",
      actionEcho: 'Remove parityTok from the module.',
    });
    const r1 = scanNegativeGrepCommentEcho(withoutMarker);
    assert.ok(r1.errors.length >= 1, [
      'expected at least 1 error without allowlist marker,',
      `got: ${JSON.stringify(r1.errors)}`,
    ].join(' '));

    // With marker: same plan but allowlist marker suppresses the error
    const withMarker = makePlan({
      negativeGrep: "grep -c 'parityTok' src/m.ts == 0",
      actionEcho: 'Remove parityTok from the module.',
      allowlistMarker: `${ALLOW_PREFIX} parityTok -->`,
    });
    const r2 = scanNegativeGrepCommentEcho(withMarker);
    assert.strictEqual(r2.errors.length, 0, [
      `allowlist marker "${ALLOW_PREFIX} parityTok -->" must suppress error,`,
      `got: ${JSON.stringify(r2.errors)}`,
    ].join(' '));
  });
});
