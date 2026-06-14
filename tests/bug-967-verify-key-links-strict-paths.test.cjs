/**
 * Regression test for bug #967: verify key-links reads from:/to: as literal
 * relative file paths; the reference docs wrongly implied component/endpoint
 * values were valid. Fix direction: author-strict — docs corrected to match code.
 *
 * Contract pinned here:
 * 1. from: must be a relative file path; pattern: is evaluated against its content.
 * 2. from: pointing to a non-existent file → verified:false, detail "Source file not found".
 * 3. docs/reference/plan-md.md reference example uses a file path for to: (NOT /api/feed).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function writePlanWithKeyLinks(tmpDir, keyLinksYaml, opts) {
  // parseMustHavesBlock expects 4-space indent for block name, 6-space for items
  const wave = (opts && opts.wave != null) ? opts.wave : 1;
  const filesModified = (opts && opts.filesModified) ? opts.filesModified : ['src/a.js'];
  const filesModifiedYaml = filesModified.length === 1
    ? `[${filesModified[0]}]`
    : `[${filesModified.join(', ')}]`;
  const content = [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    `wave: ${wave}`,
    'depends_on: []',
    `files_modified: ${filesModifiedYaml}`,
    'autonomous: true',
    'must_haves:',
    '    key_links:',
    ...keyLinksYaml.map(line => `      ${line}`),
    '---',
    '',
    '<tasks>',
    '<task type="auto">',
    '  <name>Task 1: Do thing</name>',
    '  <files>src/a.js</files>',
    '  <action>Do it</action>',
    '  <verify><automated>echo ok</automated></verify>',
    '  <done>Done</done>',
    '</task>',
    '</tasks>',
  ].join('\n');
  const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, content);
}

/**
 * Write an additional plan file in the same phase directory with specific
 * wave + files_modified (no key_links, just declaring future artifacts).
 */
function writeCompanionPlan(tmpDir, planFileName, wave, filesModified) {
  const filesModifiedYaml = `[${filesModified.join(', ')}]`;
  const content = [
    '---',
    'phase: 01-test',
    'plan: 02',
    'type: execute',
    `wave: ${wave}`,
    'depends_on: []',
    `files_modified: ${filesModifiedYaml}`,
    'autonomous: true',
    'must_haves:',
    '    key_links: []',
    '---',
    '',
    '<tasks>',
    '<task type="auto">',
    '  <name>Task 2: Create file</name>',
    '  <files>src/b.js</files>',
    '  <action>Create it</action>',
    '  <verify><automated>echo ok</automated></verify>',
    '  <done>Done</done>',
    '</task>',
    '</tasks>',
  ].join('\n');
  const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', planFileName);
  fs.writeFileSync(planPath, content);
}

describe('bug-967 verify key-links strict file-path contract', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── 1. Happy path: from: is a real file path and pattern: matches ──────────
  test('verified:true when from: is a relative file path and pattern: matches', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/component.js"',
      '  to: "src/api/feed.js"',
      '  via: "fetch in useEffect"',
      '  pattern: "fetch.*api/feed"',
    ]);
    // Create the source file containing the pattern
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'component.js'),
      "fetch('/api/feed').then(r => r.json());\n",
    );
    // Create the target file too (not strictly needed for this path, but realistic)
    fs.mkdirSync(path.join(tmpDir, 'src', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api', 'feed.js'), 'module.exports = {};\n');

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.all_verified,
      true,
      `Expected all_verified:true (file-path from: + matching pattern:). Got: ${JSON.stringify(output)}`,
    );
    assert.strictEqual(output.links[0].verified, true);
  });

  // ── 2. Contract: missing source file → verified:false, explicit detail ─────
  test('verified:false with "Source file not found" detail when from: file does not exist', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/missing-file.js"',
      '  to: "src/api/feed.js"',
      '  via: "fetch in useEffect"',
      '  pattern: "fetch.*api/feed"',
    ]);
    // Deliberately do NOT create src/missing-file.js

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.links[0].verified,
      false,
      `Expected verified:false for absent source file. Got: ${JSON.stringify(output.links[0])}`,
    );
    assert.ok(
      output.links[0].detail.includes('Source file not found'),
      `Expected detail to include "Source file not found". Got: "${output.links[0].detail}"`,
    );
  });

  // ── 3. Regression #1202: missing from: file promised by a same-wave plan → pending:true ──
  //
  // A from: file absent on disk but listed in files_modified of another plan at
  // the same wave must be reported pending:true (not verified:false) and must NOT
  // count against the all_verified gate.
  //
  // This test MUST FAIL before the fix is applied (the gate hard-fails today).
  test('pending:true and all_verified:true when from: file is promised by a same-wave plan', () => {
    // Plan under test is wave 2; it references src/future-artifact.js which does not
    // exist on disk yet.
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/future-artifact.js"',
      '  to: "src/consumer.js"',
      '  via: "requires future-artifact"',
      '  pattern: "future-artifact"',
    ], { wave: 2, filesModified: ['src/consumer.js'] });

    // A companion plan also at wave 2 declares src/future-artifact.js in files_modified
    writeCompanionPlan(tmpDir, '01-02-PLAN.md', 2, ['src/future-artifact.js']);

    // Do NOT create src/future-artifact.js on disk — it is a planned future file

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(
      out.links[0].pending,
      true,
      `Expected pending:true for a from: file promised by a same-wave plan. Got: ${JSON.stringify(out.links[0])}`,
    );
    assert.strictEqual(
      out.all_verified,
      true,
      `Expected all_verified:true (pending links should not fail the gate). Got: ${JSON.stringify(out)}`,
    );
    assert.strictEqual(
      out.links[0].verified,
      false,
      `Expected verified:false (file is not yet verified — just pending). Got: ${JSON.stringify(out.links[0])}`,
    );
  });

  // ── 4. Regression #1202: missing from: file promised by a LATER-wave plan → pending:true ──
  test('pending:true and all_verified:true when from: file is promised by a later-wave plan', () => {
    // Plan under test is wave 1; companion plan is wave 3 (later wave promises the file)
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/later-artifact.js"',
      '  to: "src/consumer.js"',
      '  via: "later wave dependency"',
    ], { wave: 1, filesModified: ['src/consumer.js'] });

    writeCompanionPlan(tmpDir, '01-02-PLAN.md', 3, ['src/later-artifact.js']);

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(
      out.links[0].pending,
      true,
      `Expected pending:true for from: file promised by a later-wave plan. Got: ${JSON.stringify(out.links[0])}`,
    );
    assert.strictEqual(
      out.all_verified,
      true,
      `Expected all_verified:true (pending links not counted against gate). Got: ${JSON.stringify(out)}`,
    );
  });

  // ── 5. Regression #1202: missing from: file NOT promised by any plan → hard failure ──
  //
  // Absence of from: file with no plan promising it must remain a genuine verified:false failure.
  test('verified:false and all_verified:false when from: file is absent and not promised by any plan', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/truly-missing.js"',
      '  to: "src/consumer.js"',
      '  via: "no plan promises this"',
    ], { wave: 1, filesModified: ['src/consumer.js'] });

    // No companion plan that promises src/truly-missing.js

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(
      out.links[0].verified,
      false,
      `Expected verified:false for absent+unpromised from: file. Got: ${JSON.stringify(out.links[0])}`,
    );
    assert.strictEqual(
      out.all_verified,
      false,
      `Expected all_verified:false (hard failure). Got: ${JSON.stringify(out)}`,
    );
    // pending must not be true
    assert.notStrictEqual(
      out.links[0].pending,
      true,
      `Expected pending not to be true for an absent+unpromised file. Got: ${JSON.stringify(out.links[0])}`,
    );
  });

  // ── 6. Doc-contract guard: reference example must use a file path for to: ──
  //
  // The old reference example had  to: "/api/feed"  (an HTTP endpoint).
  // After fix #967, to: must be a relative file path like "app/api/feed/route.ts".
  // This test reads the canonical docs file and asserts the example is consistent
  // with the strict-path contract.
  //
  // allow-test-rule: <runtime-contract-is-the-product> the plan-md.md reference
  // example IS the documented authoring surface for key_links; asserting it uses
  // a file path (not an endpoint) directly tests the documented contract.
  test('docs/reference/plan-md.md key_links example uses a relative file path for to:, not an HTTP endpoint', () => {
    // Locate plan-md.md relative to this test file's repo root
    const docPath = path.join(__dirname, '..', 'docs', 'reference', 'plan-md.md');
    assert.ok(fs.existsSync(docPath), `plan-md.md not found at ${docPath}`);
    const content = fs.readFileSync(docPath, 'utf-8'); // allow-test-rule: <runtime-contract-is-the-product> the plan-md.md reference example IS the documented authoring surface for key_links; asserting it uses a file path (not an endpoint) directly tests the documented contract.

    // Find the key_links block in the annotated example (the first YAML frontmatter fence)
    // The bad old value was:  to: "/api/feed"
    assert.ok(
      !content.includes('to: "/api/feed"'),
      'docs/reference/plan-md.md still contains the endpoint-style to: "/api/feed" — ' +
      'the reference example must use a relative file path (e.g. "app/api/feed/route.ts") ' +
      'to match the strict file-path contract.',
    );

    // Also assert the corrected example actually uses a path-like value
    // (must contain at least one '/' and not start with 'http')
    const toMatch = content.match(/key_links:[\s\S]*?to:\s*"([^"]+)"/);
    assert.ok(
      toMatch,
      'Could not find a to: field in the key_links example in plan-md.md',
    );
    const toValue = toMatch[1];
    assert.ok(
      !toValue.startsWith('/api') && !toValue.startsWith('http'),
      `to: value in the docs example looks like an HTTP endpoint: "${toValue}". ` +
      'It must be a relative file path.',
    );
  });
});
