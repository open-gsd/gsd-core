// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - State
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');

describe('state-snapshot command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing STATE.md returns error', () => {
    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'STATE.md not found', 'should report missing file');
  });

  test('extracts basic fields from STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03
**Current Phase Name:** API Layer
**Total Phases:** 6
**Current Plan:** 03-02
**Total Plans in Phase:** 3
**Status:** In progress
**Progress:** 45%
**Last Activity:** 2024-01-15
**Last Activity Description:** Completed 03-01-PLAN.md
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '03', 'current phase extracted');
    assert.strictEqual(output.current_phase_name, 'API Layer', 'phase name extracted');
    assert.strictEqual(output.total_phases, 6, 'total phases extracted');
    assert.strictEqual(output.current_plan, '03-02', 'current plan extracted');
    assert.strictEqual(output.total_plans_in_phase, 3, 'total plans extracted');
    assert.strictEqual(output.status, 'In progress', 'status extracted');
    assert.strictEqual(output.progress_percent, 45, 'progress extracted');
    assert.strictEqual(output.last_activity, '2024-01-15', 'last activity date extracted');
  });

  test('extracts decisions table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 01

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
| 01 | Use Prisma | Better DX than raw SQL |
| 02 | JWT auth | Stateless authentication |
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.decisions.length, 2, 'should have 2 decisions');
    assert.strictEqual(output.decisions[0].phase, '01', 'first decision phase');
    assert.strictEqual(output.decisions[0].summary, 'Use Prisma', 'first decision summary');
    assert.strictEqual(output.decisions[0].rationale, 'Better DX than raw SQL', 'first decision rationale');
  });

  test('extracts blockers list', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03

## Blockers

- Waiting for API credentials
- Need design review for dashboard
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.blockers, [
      'Waiting for API credentials',
      'Need design review for dashboard',
    ], 'blockers extracted');
  });

  test('extracts session continuity info', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03

## Session

**Last Date:** 2024-01-15
**Stopped At:** Phase 3, Plan 2, Task 1
**Resume File:** .planning/phases/03-api/03-02-PLAN.md
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.session.last_date, '2024-01-15', 'session date extracted');
    assert.strictEqual(output.session.stopped_at, 'Phase 3, Plan 2, Task 1', 'stopped at extracted');
    assert.strictEqual(output.session.resume_file, '.planning/phases/03-api/03-02-PLAN.md', 'resume file extracted');
  });

  test('handles paused_at field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03
**Paused At:** Phase 3, Plan 1, Task 2 - mid-implementation
`
    );

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.paused_at, 'Phase 3, Plan 1, Task 2 - mid-implementation', 'paused_at extracted');
  });

  describe('--cwd override', () => {
    let outsideDir;

    beforeEach(() => {
      outsideDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-test-outside-'));
    });

    afterEach(() => {
      cleanup(outsideDir);
    });

    test('supports --cwd override when command runs outside project root', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        `# Session State

**Current Phase:** 03
**Status:** Ready to plan
`
      );

      const result = runGsdTools(`state-snapshot --cwd "${tmpDir}"`, outsideDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.current_phase, '03', 'should read STATE.md from overridden cwd');
      assert.strictEqual(output.status, 'Ready to plan', 'should parse status from overridden cwd');
    });
  });

  test('returns error for invalid --cwd path', () => {
    const invalid = path.join(tmpDir, 'does-not-exist');
    const result = runGsdTools(`state-snapshot --cwd "${invalid}"`, tmpDir);
    assert.ok(!result.success, 'should fail for invalid --cwd');
    assert.ok(result.error.includes('Invalid --cwd'), 'error should mention invalid --cwd');
  });
});

// ─── Regression: #3265 — frontmatter wins over bold-body cell ─────────────

describe('state-snapshot — bug #3265 frontmatter precedence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns frontmatter status, not **Status:** value embedded in a body table cell', () => {
    // Reproduce the collision: frontmatter says "executing", but the body
    // contains a Markdown table cell with "**Status:** to ✅ COMPLETE ..."
    // which stateExtractField (bold pattern) would match before the YAML line.
    const stateContent = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_plan: 19.5-05',
      '---',
      '',
      '# Project State',
      '',
      '## Recent Quick Tasks',
      '',
      '| Date | Task | Notes |',
      '|------|------|-------|',
      '| 2026-05-01 | Reopened Plan 19.5-05. **Status:** to ✅ COMPLETE | done |',
      '',
      '**Current Phase:** 19',
      '**Current Plan:** archived-lane',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Frontmatter status must win over the table cell's **Status:** match
    assert.strictEqual(output.status, 'executing', 'frontmatter status beats body table cell');
  });

  test('returns frontmatter current_plan, not bold body value when both present', () => {
    const stateContent = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_plan: 19.5-05',
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 19',
      '**Current Plan:** archived-lane',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_plan, '19.5-05', 'frontmatter current_plan beats body bold value');
  });

  test('falls back to body extraction when no frontmatter block is present', () => {
    const stateContent = [
      '# Project State',
      '',
      '**Current Phase:** 07',
      '**Status:** paused',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // No frontmatter — body extraction must still work
    assert.strictEqual(output.status, 'paused', 'body extraction works without frontmatter');
    assert.strictEqual(output.current_phase, '07', 'body extraction works without frontmatter');
  });
});

describe('state mutation commands', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('add-decision preserves dollar amounts without corrupting Decisions section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
No decisions yet.

## Blockers
None
`
    );

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '11-01', '--summary', 'Benchmark prices moved from $0.50 to $2.00 to $5.00', '--rationale', 'track cost growth'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(
      state,
      /- \[Phase 11-01\]: Benchmark prices moved from \$0\.50 to \$2\.00 to \$5\.00 — track cost growth/,
      'decision entry should preserve literal dollar values'
    );
    assert.strictEqual((state.match(/^## Decisions$/gm) || []).length, 1, 'Decisions heading should not be duplicated');
    assert.ok(!state.includes('No decisions yet.'), 'placeholder should be removed');
  });

  test('add-blocker preserves dollar strings without corrupting Blockers section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
None

## Blockers
None
`
    );

    const result = runGsdTools(['state', 'add-blocker', '--text', 'Waiting on vendor quote $1.00 before approval'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(state, /- Waiting on vendor quote \$1\.00 before approval/, 'blocker entry should preserve literal dollar values');
    assert.strictEqual((state.match(/^## Blockers$/gm) || []).length, 1, 'Blockers heading should not be duplicated');
  });

  test('add-decision supports file inputs to preserve shell-sensitive dollar text', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
No decisions yet.

## Blockers
None
`
    );

    const summaryPath = path.join(tmpDir, 'decision-summary.txt');
    const rationalePath = path.join(tmpDir, 'decision-rationale.txt');
    fs.writeFileSync(summaryPath, 'Price tiers: $0.50, $2.00, else $5.00\n');
    fs.writeFileSync(rationalePath, 'Keep exact currency literals for budgeting\n');

    const result = runGsdTools(
      `state add-decision --phase 11-02 --summary-file "${summaryPath}" --rationale-file "${rationalePath}"`,
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(
      state,
      /- \[Phase 11-02\]: Price tiers: \$0\.50, \$2\.00, else \$5\.00 — Keep exact currency literals for budgeting/,
      'file-based decision input should preserve literal dollar values'
    );
  });

  test('add-blocker supports --text-file for shell-sensitive text', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

## Decisions
None

## Blockers
None
`
    );

    const blockerPath = path.join(tmpDir, 'blocker.txt');
    fs.writeFileSync(blockerPath, 'Vendor quote updated from $1.00 to $2.00 pending approval\n');

    const result = runGsdTools(`state add-blocker --text-file "${blockerPath}"`, tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(state, /- Vendor quote updated from \$1\.00 to \$2\.00 pending approval/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state json command (machine-readable STATE.md frontmatter)
// ─────────────────────────────────────────────────────────────────────────────

describe('state json command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing STATE.md returns error', () => {
    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'STATE.md not found', 'should report missing file');
  });

  test('builds frontmatter on-the-fly from body when no frontmatter exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 05
**Current Phase Name:** Deployment
**Total Phases:** 8
**Current Plan:** 05-03
**Total Plans in Phase:** 4
**Status:** In progress
**Progress:** 60%
**Last Activity:** 2026-01-20
`
    );

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.gsd_state_version, '1.0', 'should have version 1.0');
    assert.strictEqual(output.current_phase, '05', 'current phase extracted');
    assert.strictEqual(output.current_phase_name, 'Deployment', 'phase name extracted');
    assert.strictEqual(output.current_plan, '05-03', 'current plan extracted');
    assert.strictEqual(output.status, 'executing', 'status normalized to executing');
    assert.ok(output.last_updated, 'should have last_updated timestamp');
    assert.strictEqual(output.last_activity, '2026-01-20', 'last activity extracted');
    assert.ok(output.progress, 'should have progress object');
    assert.strictEqual(output.progress.percent, 60, 'progress percent extracted');
  });

  test('reads existing frontmatter when present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: 1.0
current_phase: 03
status: paused
stopped_at: Plan 2 of Phase 3
---

# Project State

**Current Phase:** 03
**Status:** Paused
`
    );

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.gsd_state_version, '1.0', 'version from frontmatter');
    assert.strictEqual(output.current_phase, '03', 'phase from frontmatter');
    assert.strictEqual(output.status, 'paused', 'status from frontmatter');
    assert.strictEqual(output.stopped_at, 'Plan 2 of Phase 3', 'stopped_at from frontmatter');
  });

  test('normalizes various status values', () => {
    const statusTests = [
      { input: 'In progress', expected: 'executing' },
      { input: 'Ready to execute', expected: 'executing' },
      { input: 'Paused at Plan 3', expected: 'paused' },
      { input: 'Ready to plan', expected: 'planning' },
      { input: 'Phase complete — ready for verification', expected: 'verifying' },
      { input: 'Milestone complete', expected: 'completed' },
    ];

    for (const { input, expected } of statusTests) {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'STATE.md'),
        `# State\n\n**Current Phase:** 01\n**Status:** ${input}\n`
      );

      const result = runGsdTools('state json', tmpDir);
      assert.ok(result.success, `Command failed for status "${input}": ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.status, expected, `"${input}" should normalize to "${expected}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATE.md frontmatter sync (write operations add frontmatter)
// ─────────────────────────────────────────────────────────────────────────────

describe('STATE.md frontmatter sync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state update adds frontmatter to STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 02
**Status:** Ready to execute
`
    );

    const result = runGsdTools('state update Status "Executing Plan 1"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.startsWith('---\n'), 'should start with frontmatter delimiter');
    assert.ok(content.includes('gsd_state_version: 1.0'), 'should have version field');
    assert.ok(content.includes('current_phase: 02'), 'frontmatter should have current phase');
    assert.ok(content.includes('**Current Phase:** 02'), 'body field should be preserved');
    assert.ok(content.includes('**Status:** Executing Plan 1'), 'updated field in body');
  });

  test('state patch adds frontmatter', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 04
**Status:** Planning
**Current Plan:** 04-01
`
    );

    const result = runGsdTools('state patch --Status "In progress" --"Current Plan" 04-02', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.startsWith('---\n'), 'should have frontmatter after patch');
  });

  test('frontmatter is idempotent on multiple writes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 01
**Status:** Ready to execute
`
    );

    runGsdTools('state update Status "In progress"', tmpDir);
    runGsdTools('state update Status "Paused"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const delimiterCount = (content.match(/^---$/gm) || []).length;
    assert.strictEqual(delimiterCount, 2, 'should have exactly one frontmatter block (2 delimiters)');
    assert.ok(content.includes('status: paused'), 'frontmatter should reflect latest status');
  });

  test('preserves frontmatter status when body Status field is missing', () => {
    // Simulate: frontmatter has status: executing, but body lost Status: field
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
status: executing
milestone: v1.0
---

# Project State

**Current Phase:** 03
**Current Plan:** 03-02
`
    );

    // Any writeStateMd triggers syncStateFrontmatter — use state update on a field that exists
    runGsdTools('state update "Current Plan" "03-03"', tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(content.includes('status: executing'), 'should preserve existing status, not overwrite with unknown');
    assert.ok(!content.includes('status: unknown'), 'should not contain unknown status');
  });

  test('round-trip: write then read via state json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 07
**Current Phase Name:** Production
**Total Phases:** 10
**Status:** In progress
**Current Plan:** 07-05
**Progress:** 70%
`
    );

    runGsdTools('state update Status "Executing Plan 5"', tmpDir);

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '07', 'round-trip: phase preserved');
    assert.strictEqual(output.current_phase_name, 'Production', 'round-trip: phase name preserved');
    assert.strictEqual(output.status, 'executing', 'round-trip: status normalized');
    assert.ok(output.last_updated, 'round-trip: timestamp present');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stateExtractField and stateReplaceField helpers
// ─────────────────────────────────────────────────────────────────────────────

const { stateExtractField, stateReplaceField, stateReplaceFieldWithFallback } = require('../gsd-core/bin/lib/state.cjs');

describe('stateExtractField and stateReplaceField helpers', () => {
  // stateExtractField tests

  test('extracts simple field value', () => {
    const content = '# State\n\n**Status:** In progress\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, 'In progress', 'should extract simple field value');
  });

  test('extracts field with colon in value', () => {
    const content = '# State\n\n**Last Activity:** 2024-01-15 — Completed plan\n';
    const result = stateExtractField(content, 'Last Activity');
    assert.strictEqual(result, '2024-01-15 — Completed plan', 'should return full value after field pattern');
  });

  test('returns null for missing field', () => {
    const content = '# State\n\n**Phase:** 03\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, null, 'should return null when field not present');
  });

  test('is case-insensitive on field name', () => {
    const content = '# State\n\n**status:** Active\n';
    const result = stateExtractField(content, 'Status');
    assert.strictEqual(result, 'Active', 'should match field name case-insensitively');
  });

  // stateReplaceField tests

  test('replaces field value', () => {
    const content = '# State\n\n**Status:** Old\n';
    const result = stateReplaceField(content, 'Status', 'New');
    assert.ok(result !== null, 'should return updated content, not null');
    assert.ok(result.includes('**Status:** New'), 'output should contain updated field value');
    assert.ok(!result.includes('**Status:** Old'), 'output should not contain old field value');
  });

  test('returns null when field not found', () => {
    const content = '# State\n\n**Phase:** 03\n';
    const result = stateReplaceField(content, 'Status', 'New');
    assert.strictEqual(result, null, 'should return null when field not present');
  });

  test('preserves surrounding content', () => {
    const content = [
      '# Project State',
      '',
      '**Phase:** 03',
      '**Status:** Old',
      '**Last Activity:** 2024-01-15',
      '',
      '## Notes',
      'Some notes here.',
    ].join('\n');

    const result = stateReplaceField(content, 'Status', 'New');
    assert.ok(result !== null, 'should return updated content');
    assert.ok(result.includes('**Phase:** 03'), 'Phase line should be unchanged');
    assert.ok(result.includes('**Status:** New'), 'Status should be updated');
    assert.ok(result.includes('**Last Activity:** 2024-01-15'), 'Last Activity line should be unchanged');
    assert.ok(result.includes('## Notes'), 'Notes heading should be unchanged');
    assert.ok(result.includes('Some notes here.'), 'Notes content should be unchanged');
  });

  test('round-trip: extract then replace then extract', () => {
    const content = '# State\n\n**Phase:** 3\n';
    const extracted = stateExtractField(content, 'Phase');
    assert.strictEqual(extracted, '3', 'initial extract should return "3"');

    const updated = stateReplaceField(content, 'Phase', '4');
    assert.ok(updated !== null, 'replace should succeed');

    const reExtracted = stateExtractField(updated, 'Phase');
    assert.strictEqual(reExtracted, '4', 'extract after replace should return "4"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stateReplaceFieldWithFallback — consolidated fallback helper
// ─────────────────────────────────────────────────────────────────────────────

describe('stateReplaceFieldWithFallback', () => {
  test('replaces primary field when present', () => {
    const content = '# State\n\n**Status:** Old\n';
    const result = stateReplaceFieldWithFallback(content, 'Status', null, 'New');
    assert.ok(result.includes('**Status:** New'));
  });

  test('falls back to secondary field when primary not found', () => {
    const content = '# State\n\nLast activity: 2024-01-01\n';
    const result = stateReplaceFieldWithFallback(content, 'Last Activity', 'Last activity', '2025-03-19');
    assert.ok(result.includes('Last activity: 2025-03-19'), 'should update fallback field');
  });

  test('returns content unchanged when neither field matches', () => {
    const content = '# State\n\n**Phase:** 3\n';
    let warning = '';
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      warning += String(chunk);
      return true;
    };
    let result;
    try {
      result = stateReplaceFieldWithFallback(content, 'Status', 'state', 'New');
    } finally {
      process.stderr.write = origErrWrite;
    }
    assert.strictEqual(result, content, 'content should be unchanged');
    assert.match(warning, /STATE\.md field "Status"/, 'missing field warning should be emitted');
  });

  test('prefers primary over fallback when both exist', () => {
    const content = '# State\n\n**Status:** Old\nStatus: Also old\n';
    const result = stateReplaceFieldWithFallback(content, 'Status', 'Status', 'New');
    // Bold format is tried first by stateReplaceField
    assert.ok(result.includes('**Status:** New'), 'should replace bold (primary) format');
  });

  test('works with plain format fields', () => {
    const content = '# State\n\nPhase: 1 of 3 (Foundation)\nStatus: In progress\nPlan: 01-01\n';
    let updated = stateReplaceFieldWithFallback(content, 'Status', null, 'Complete');
    assert.ok(updated.includes('Status: Complete'), 'should update plain Status');
    updated = stateReplaceFieldWithFallback(updated, 'Current Plan', 'Plan', 'Not started');
    assert.ok(updated.includes('Plan: Not started'), 'should fall back to Plan field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateLoad, cmdStateGet, cmdStatePatch, cmdStateUpdate CLI tests
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateLoad (state load)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns config and state when STATE.md exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ mode: 'yolo' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n'
    );

    const result = runGsdTools('state load', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_exists, true, 'state_exists should be true');
    assert.strictEqual(output.config_exists, true, 'config_exists should be true');
    assert.strictEqual(output.roadmap_exists, true, 'roadmap_exists should be true');
    assert.ok(output.state_raw.includes('**Status:** Active'), 'state_raw should contain STATE.md content');
  });

  test('returns state_exists false when STATE.md missing', () => {
    const result = runGsdTools('state load', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_exists, false, 'state_exists should be false');
    assert.strictEqual(output.state_raw, '', 'state_raw should be empty string');
  });

  test('returns raw key=value format with --raw flag', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ mode: 'yolo' })
    );

    const result = runGsdTools('state load --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(result.output.includes('state_exists=true'), 'raw output should include state_exists=true');
    assert.ok(result.output.includes('config_exists=true'), 'raw output should include config_exists=true');
  });
});

describe('cmdStateGet (state get)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns full content when no section specified', () => {
    const stateContent = '# Project State\n\n**Status:** Active\n**Phase:** 03\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    const result = runGsdTools('state get', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.content !== undefined, 'output should have content field');
    assert.ok(output.content.includes('**Status:** Active'), 'content should include full STATE.md text');
  });

  test('extracts bold field value', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state get Status', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output['Status'], 'Active', 'should extract Status field value');
  });

  test('extracts markdown section content', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n\n## Blockers\n\n- item1\n- item2\n'
    );

    const result = runGsdTools('state get Blockers', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output['Blockers'] !== undefined, 'should have Blockers key in output');
    assert.ok(output['Blockers'].includes('item1'), 'section content should include item1');
    assert.ok(output['Blockers'].includes('item2'), 'section content should include item2');
  });

  test('returns error for nonexistent field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state get Missing', tmpDir);
    assert.ok(result.success, `Command should exit 0 even for missing field: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.toLowerCase().includes('not found'), 'error should mention "not found"');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state get Status', tmpDir);
    assert.ok(!result.success, 'command should fail when STATE.md is missing');
    assert.ok(
      result.error.includes('STATE.md') || result.output.includes('STATE.md'),
      'error message should mention STATE.md'
    );
  });
});

describe('cmdStatePatch and cmdStateUpdate (state patch, state update)', () => {
  let tmpDir;
  const stateMd = [
    '# Project State',
    '',
    '**Current Phase:** 03',
    '**Status:** In progress',
    '**Last Activity:** 2024-01-15',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state patch updates multiple fields at once', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state patch --Status Complete --"Current Phase" 04', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Complete'), 'Status should be updated to Complete');
    assert.ok(updated.includes('**Last Activity:** 2024-01-15'), 'Last Activity should be unchanged');
  });

  test('state patch accepts JSON object input from workflows', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools([
      'query',
      'state.patch',
      JSON.stringify({
        Status: 'Complete',
        'Current Phase': '04',
      }),
    ], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepEqual(output.updated.sort(), ['Current Phase', 'Status'].sort());

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Complete'), 'Status should be updated to Complete');
    assert.ok(updated.includes('**Current Phase:** 04'), 'Current Phase should be updated to 04');
  });

  test('state patch reports failed fields that do not exist', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state patch --Status Done --Missing value', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.updated), 'updated should be an array');
    assert.ok(output.updated.includes('Status'), 'Status should be in updated list');
    assert.ok(Array.isArray(output.failed), 'failed should be an array');
    assert.ok(output.failed.includes('Missing'), 'Missing should be in failed list');
  });

  test('state update changes a single field', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state update Status "Phase complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'updated should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Status:** Phase complete'), 'Status should be updated');
    assert.ok(updated.includes('**Current Phase:** 03'), 'Current Phase should be unchanged');
    assert.ok(updated.includes('**Last Activity:** 2024-01-15'), 'Last Activity should be unchanged');
  });

  test('state update reports field not found', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state update Missing value', tmpDir);
    assert.ok(result.success, `Command should exit 0 for not-found field: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.ok(output.reason !== undefined, 'should include a reason');
  });

  test('state update returns error when STATE.md missing', () => {
    const result = runGsdTools('state update Status value', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.ok(
      output.reason.includes('STATE.md'),
      'reason should mention STATE.md'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateAdvancePlan, cmdStateRecordMetric, cmdStateUpdateProgress
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateAdvancePlan (state advance-plan)', () => {
  let tmpDir;

  const advanceFixture = [
    '# Project State',
    '',
    '**Current Plan:** 1',
    '**Total Plans in Phase:** 3',
    '**Status:** Executing',
    '**Last Activity:** 2024-01-10',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('advances plan counter when not on last plan', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), advanceFixture);

    const PINNED_MS = Date.parse('2020-06-15T12:00:00.000Z');
    const PINNED_DATE = '2020-06-15';
    const result = runGsdTools('state advance-plan', tmpDir, {
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(PINNED_MS),
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, 'advanced should be true');
    assert.strictEqual(output.previous_plan, 1, 'previous_plan should be 1');
    assert.strictEqual(output.current_plan, 2, 'current_plan should be 2');
    assert.strictEqual(output.total_plans, 3, 'total_plans should be 3');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('**Current Plan:** 2'), 'Current Plan should be updated to 2');
    assert.ok(updated.includes('**Status:** Ready to execute'), 'Status should be Ready to execute');
    assert.ok(
      updated.includes(`**Last Activity:** ${PINNED_DATE}`),
      `Last Activity should be the pinned date ${PINNED_DATE}`,
    );
  });

  test('marks phase complete on last plan', () => {
    const lastPlanFixture = advanceFixture.replace('**Current Plan:** 1', '**Current Plan:** 3');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), lastPlanFixture);

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, false, 'advanced should be false');
    assert.strictEqual(output.reason, 'last_plan', 'reason should be last_plan');
    assert.strictEqual(output.status, 'ready_for_verification', 'status should be ready_for_verification');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase complete'), 'Status should contain Phase complete');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  test('returns error when plan fields not parseable', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.toLowerCase().includes('cannot parse'), 'error should mention Cannot parse');
  });

  test('advances plan in compound "Plan: X of Y" format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\nPlan: 2 of 5 in current phase\nStatus: In progress\nLast activity: 2025-01-01\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, true, 'advanced should be true');
    assert.strictEqual(output.previous_plan, 2);
    assert.strictEqual(output.current_plan, 3);
    assert.strictEqual(output.total_plans, 5);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Plan: 3 of 5 in current phase'),
      'should preserve compound format with updated plan number');
    assert.ok(updated.includes('Status: Ready to execute'),
      'Status should be updated');
  });

  test('marks phase complete on last plan in compound format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\nPlan: 3 of 3 in current phase\nStatus: In progress\nLast activity: 2025-01-01\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.advanced, false);
    assert.strictEqual(output.reason, 'last_plan');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase complete'), 'Status should contain Phase complete');
  });
});

describe('cmdStateRecordMetric (state record-metric)', () => {
  let tmpDir;

  const metricsFixture = [
    '# Project State',
    '',
    '## Performance Metrics',
    '',
    '| Plan | Duration | Tasks | Files |',
    '|------|----------|-------|-------|',
    '| Phase 1 P1 | 3min | 2 tasks | 3 files |',
    '',
    '## Session Continuity',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('appends metric row to existing table', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), metricsFixture);

    const result = runGsdTools('state record-metric --phase 2 --plan 1 --duration 5min --tasks 3 --files 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('| Phase 2 P1 | 5min | 3 tasks | 4 files |'), 'new row should be present');
    assert.ok(updated.includes('| Phase 1 P1 | 3min | 2 tasks | 3 files |'), 'existing row should still be present');
  });

  test('replaces None yet placeholder with first metric', () => {
    const noneYetFixture = [
      '# Project State',
      '',
      '## Performance Metrics',
      '',
      '| Plan | Duration | Tasks | Files |',
      '|------|----------|-------|-------|',
      'None yet',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), noneYetFixture);

    const result = runGsdTools('state record-metric --phase 1 --plan 1 --duration 2min --tasks 1 --files 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('None yet'), 'None yet placeholder should be removed');
    assert.ok(updated.includes('| Phase 1 P1 | 2min | 1 tasks | 2 files |'), 'new row should be present');
  });

  test('returns error when required fields missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), metricsFixture);

    const result = runGsdTools('state record-metric --phase 1', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(
      output.error.includes('phase') || output.error.includes('plan') || output.error.includes('duration'),
      'error should mention missing required fields'
    );
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state record-metric --phase 1 --plan 1 --duration 2min', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });
});

describe('cmdStateUpdateProgress (state update-progress)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('calculates progress from plan/summary counts', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    // Phase 01: 1 PLAN + 1 SUMMARY = completed
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');

    // Phase 02: 1 PLAN only = not completed
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02');
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'updated should be true');
    assert.strictEqual(output.percent, 50, 'percent should be 50');
    assert.strictEqual(output.completed, 1, 'completed should be 1');
    assert.strictEqual(output.total, 2, 'total should be 2');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('50%'), 'STATE.md Progress should contain 50%');
  });

  test('handles zero plans gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.percent, 0, 'percent should be 0 when no plans found');
  });

  test('returns error when Progress field missing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n'
    );

    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'updated should be false');
    assert.ok(output.reason !== undefined, 'should have a reason');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state update-progress', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdStateResolveBlocker, cmdStateRecordSession
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdStateResolveBlocker (state resolve-blocker)', () => {
  let tmpDir;

  const blockerFixture = [
    '# Project State',
    '',
    '## Blockers',
    '',
    '- Waiting for API credentials',
    '- Need design review for dashboard',
    '- Pending vendor approval',
    '',
    '## Session Continuity',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removes matching blocker line (case-insensitive substring match)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker --text "api credentials"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.resolved, true, 'resolved should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('Waiting for API credentials'), 'matched blocker should be removed');
    assert.ok(updated.includes('Need design review for dashboard'), 'other blocker should still be present');
    assert.ok(updated.includes('Pending vendor approval'), 'other blocker should still be present');
  });

  test('adds None placeholder when last blocker resolved', () => {
    const singleBlockerFixture = [
      '# Project State',
      '',
      '## Blockers',
      '',
      '- Single blocker',
      '',
      '## Session Continuity',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), singleBlockerFixture);

    const result = runGsdTools('state resolve-blocker --text "single blocker"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!updated.includes('- Single blocker'), 'resolved blocker should be removed');

    // Section should contain "None" placeholder, not be empty
    const sectionMatch = updated.match(/## Blockers\n([\s\S]*?)(?=\n##|$)/i);
    assert.ok(sectionMatch, 'Blockers section should still exist');
    assert.ok(sectionMatch[1].includes('None'), 'Blockers section should contain None placeholder');
  });

  test('returns error when text not provided', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(
      output.error.toLowerCase().includes('text'),
      'error should mention text required'
    );
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state resolve-blocker --text "anything"', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  test('returns resolved true even if no line matches', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), blockerFixture);

    const result = runGsdTools('state resolve-blocker --text "nonexistent blocker text"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.resolved, true, 'resolved should be true even when no line matches');
  });
});

describe('cmdStateRecordSession (state record-session)', () => {
  let tmpDir;

  const sessionFixture = [
    '# Project State',
    '',
    '## Session Continuity',
    '',
    '**Last session:** 2024-01-10',
    '**Stopped at:** Phase 2, Plan 1',
    '**Resume file:** None',
  ].join('\n') + '\n';

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('updates session fields with stopped-at and resume-file', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const PINNED_MS = Date.parse('2020-07-20T10:00:00.000Z');
    const PINNED_ISO = '2020-07-20T10:00:00.000Z';
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 3, Plan 2" --resume-file ".planning/phases/03/03-02-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');
    assert.ok(Array.isArray(output.updated), 'updated should be an array');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase 3, Plan 2'), 'Stopped at should be updated');
    assert.ok(updated.includes('.planning/phases/03/03-02-PLAN.md'), 'Resume file should be updated');
    assert.ok(updated.includes(PINNED_ISO), `Last session should be the pinned ISO timestamp ${PINNED_ISO}`);
  });

  test('updates Last session timestamp even with no other options', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const PINNED_MS = Date.parse('2020-08-01T08:30:00.000Z');
    const PINNED_ISO = '2020-08-01T08:30:00.000Z';
    const result = runGsdTools('state record-session', tmpDir, {
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(PINNED_MS),
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes(PINNED_ISO), `Last session should contain the pinned ISO timestamp ${PINNED_ISO}`);
  });

  test('sets Resume file to None when not specified', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionFixture);

    const result = runGsdTools('state record-session --stopped-at "Phase 1 complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(updated.includes('Phase 1 complete'), 'Stopped at should be updated');
    // Resume file should be set to None (default)
    const resumeMatch = updated.match(/\*\*Resume file:\*\*\s*(.*)/i);
    assert.ok(resumeMatch, 'Resume file field should exist');
    assert.ok(resumeMatch[1].trim() === 'None', 'Resume file should be None when not specified');
  });

  test('returns error when STATE.md missing', () => {
    const result = runGsdTools('state record-session', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error !== undefined, 'output should have error field');
    assert.ok(output.error.includes('STATE.md'), 'error should mention STATE.md');
  });

  test('returns recorded false when no session fields found', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Status:** Active\n**Phase:** 03\n'
    );

    const result = runGsdTools('state record-session', tmpDir);
    assert.ok(result.success, `Command should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, false, 'recorded should be false when no session fields found');
    assert.ok(output.reason !== undefined, 'should have a reason');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Milestone-scoped phase counting in frontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone-scoped phase counting in frontmatter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('total_phases counts only current milestone phases', () => {
    // ROADMAP lists only phases 5-6 (current milestone)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Next Release',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '',
        '### Phase 6: Dashboard',
        '**Goal:** Build dashboard',
      ].join('\n')
    );

    // Disk has dirs 01-06 (01-04 are leftover from previous milestone)
    for (let i = 1; i <= 6; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      // Add a plan to each
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary');
    }

    // Write a STATE.md and trigger a write that will sync frontmatter
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 05\n**Status:** In progress\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read the state json to check frontmatter
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 2, 'should count only milestone phases (5 and 6), not all 6');
    assert.strictEqual(Number(output.progress.completed_phases), 2, 'both milestone phases have summaries');
  });

  test('total_phases includes ROADMAP phases without directories', () => {
    // ROADMAP lists 6 phases (5-10), but only 4 have directories on disk
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v3.0',
        '',
        '### Phase 5: Auth',
        '### Phase 6: Dashboard',
        '### Phase 7: API',
        '### Phase 8: Notifications',
        '### Phase 9: Analytics',
        '### Phase 10: Polish',
      ].join('\n')
    );

    // Only phases 5-8 have directories (9 and 10 not yet planned)
    for (let i = 5; i <= 8; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary');
    }

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 08\n**Status:** In progress\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 6, 'should count all 6 ROADMAP phases, not just 4 with directories');
    assert.strictEqual(Number(output.progress.completed_phases), 4, 'only 4 phases have summaries');
  });

  test('without ROADMAP counts all phases (pass-all filter)', () => {
    // No ROADMAP.md — all phases should be counted
    for (let i = 1; i <= 4; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
    }

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 01\n**Status:** Planning\n'
    );

    const result = runGsdTools('state update Status "In progress"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const output = JSON.parse(jsonResult.output);
    assert.strictEqual(Number(output.progress.total_phases), 4, 'without ROADMAP should count all 4 phases');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// begin-phase — field preservation (#1365)
// ─────────────────────────────────────────────────────────────────────────────

describe('state begin-phase preserves Current Position fields (#1365)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('begin-phase preserves Status, Last activity, and Progress in Current Position', () => {
    const stateMd = `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** Ready to plan
**Last Activity:** 2026-03-20
**Last Activity Description:** Roadmap created

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-03-20 -- Roadmap created
Progress: [..........] 0%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'
    );

    // Extract the Current Position section
    const posMatch = content.match(/## Current Position\s*\n([\s\S]*?)(?=\n##|$)/i);
    assert.ok(posMatch, 'Current Position section should exist');
    const posSection = posMatch[1];

    // Phase and Plan lines should be updated
    assert.ok(/^Phase:.*EXECUTING/m.test(posSection), 'Phase line should say EXECUTING');
    assert.ok(/^Plan:.*1 of 4/m.test(posSection), 'Plan line should show 1 of 4');

    // Status, Last activity, and Progress must still be present (the bug destroys these)
    assert.ok(/^Status:/m.test(posSection),
      'Status field must be preserved in Current Position');
    assert.ok(/^Last activity:/m.test(posSection),
      'Last activity field must be preserved in Current Position');
    assert.ok(/^Progress:/m.test(posSection),
      'Progress field must be preserved in Current Position');
  });

  test('advance-plan can update Status after begin-phase', () => {
    // Simulates the full workflow: begin-phase then advance through all plans
    const stateMd = `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** Ready to plan
**Last Activity:** 2026-03-20
**Last Activity Description:** Roadmap created

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-03-20 -- Roadmap created
Progress: [..........] 0%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    // Step 1: begin-phase
    const beginResult = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '2'],
      tmpDir
    );
    assert.ok(beginResult.success, `begin-phase failed: ${beginResult.error}`);

    // Step 2: advance-plan to go from plan 1 to plan 2
    const adv1 = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(adv1.success, `advance-plan 1 failed: ${adv1.error}`);

    // Step 3: advance-plan again — plan 2 of 2 is the last, should set "Phase complete"
    const adv2 = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(adv2.success, `advance-plan 2 failed: ${adv2.error}`);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'
    );
    const posMatch = content.match(/## Current Position\s*\n([\s\S]*?)(?=\n##|$)/i);
    assert.ok(posMatch, 'Current Position section should exist after advance-plan');
    const posSection = posMatch[1];

    // After advancing past all plans, Status should say "Phase complete"
    assert.ok(/Status:.*Phase complete/i.test(posSection),
      'Status should be updated to "Phase complete" after last advance-plan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1589 — progress counters not updated during plan execution
// ─────────────────────────────────────────────────────────────────────────────

describe('progress counters correct after plan execution (#1589)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('percent in frontmatter is derived from disk counts, not stale Progress body field', () => {
    // STATE.md body still says 0% (update-progress was never called or was skipped),
    // but all 4 plans across 2 phases have SUMMARY.md files on disk.
    // After any STATE.md write, the frontmatter percent must reflect disk reality.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.mkdirSync(phase02Dir, { recursive: true });

    // Phase 01: 2 plans, 2 summaries (complete)
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-02-SUMMARY.md'), '# Summary\n');

    // Phase 02: 2 plans, 2 summaries (complete)
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-SUMMARY.md'), '# Summary\n');

    // Body Progress: still says 0% (stale — never updated by update-progress)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 02\n**Status:** Phase complete — ready for verification\n**Progress:** [░░░░░░░░░░] 0%\n'
    );

    // Trigger a STATE.md write (e.g. state update Status)
    const result = runGsdTools('state update Status "Milestone complete"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Read the frontmatter — percent must be derived from disk (4/4 = 100%), not from body "0%"
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 4, 'total_plans must be 4 from disk');
    assert.strictEqual(Number(output.progress.completed_plans), 4, 'completed_plans must be 4 from disk');
    assert.strictEqual(Number(output.progress.total_phases), 2, 'total_phases must be 2 from disk');
    assert.strictEqual(Number(output.progress.completed_phases), 2, 'completed_phases must be 2 from disk');
    assert.strictEqual(Number(output.progress.percent), 100, 'percent must be 100 (derived from disk counts, not stale body 0%)');
  });

  test('percent is 0 when no summaries exist even if Progress body says 100%', () => {
    // Inverse: body says 100% but disk has no summaries.
    // Frontmatter percent must come from disk, not body.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    // No summary files

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Current Phase:** 01\n**Status:** In progress\n**Progress:** [██████████] 100%\n'
    );

    const result = runGsdTools('state update Status "Executing"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 1, 'total_plans must be 1 from disk');
    assert.strictEqual(Number(output.progress.completed_plans), 0, 'completed_plans must be 0 (no summaries)');
    assert.strictEqual(Number(output.progress.percent), 0, 'percent must be 0 (derived from disk, not stale body 100%)');
  });

  test('state json rebuilds stale frontmatter progress from disk after all plans complete', () => {
    // Reproduces the exact scenario from #1589:
    // Frontmatter was written early with stale counters.
    // All summaries now exist on disk.
    // state json must return fresh disk-derived progress.
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-phase');
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-phase');
    const phase03Dir = path.join(tmpDir, '.planning', 'phases', '03-phase');
    const phase04Dir = path.join(tmpDir, '.planning', 'phases', '04-phase');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.mkdirSync(phase03Dir, { recursive: true });
    fs.mkdirSync(phase04Dir, { recursive: true });

    // 4 phases, 6 total plans (as in the bug report)
    fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase02Dir, '02-02-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase03Dir, '03-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase03Dir, '03-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase04Dir, '04-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase04Dir, '04-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phase04Dir, '04-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase04Dir, '04-02-SUMMARY.md'), '# Summary\n');

    // Write STATE.md with stale frontmatter matching the bug report exactly
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ngsd_state_version: '1.0'\nstatus: executing\nprogress:\n  total_phases: 4\n  completed_phases: 0\n  total_plans: 0\n  completed_plans: 4\n  percent: 0\n---\n\n# Project State\n\n**Current Phase:** 04\n**Status:** Ready to execute\n**Progress:** [░░░░░░░░░░] 0%\n`
    );

    // state json must return fresh progress derived from disk (all 6 plans complete across 4 phases)
    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.ok(output.progress, 'frontmatter must have progress object');
    assert.strictEqual(Number(output.progress.total_plans), 6, 'total_plans must be 6 (not stale 0)');
    assert.strictEqual(Number(output.progress.completed_plans), 6, 'completed_plans must be 6 (not stale 4)');
    assert.strictEqual(Number(output.progress.total_phases), 4, 'total_phases must be 4');
    assert.strictEqual(Number(output.progress.completed_phases), 4, 'completed_phases must be 4 (not stale 0)');
    assert.strictEqual(Number(output.progress.percent), 100, 'percent must be 100 (not stale 0)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updatePerformanceMetricsSection (Step 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('updatePerformanceMetricsSection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty Performance Metrics section rebuilds with zeros', () => {
    const content = `# Project State

**Status:** Executing Phase 3

## Performance Metrics

**Velocity:**
- Total plans completed: [N]
- Average duration: [X] min
- Total execution time: [X.X] hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

## Accumulated Context
`;

    // We test via the CLI: phase complete triggers updatePerformanceMetricsSection
    // But first let's test the helper directly via state planned-phase + phase complete flow
    // For a unit-style test, write STATE.md and call state validate to check metrics
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    // Create a phase with 2 plans, 2 summaries
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), '# Summary 1\n');
    fs.writeFileSync(path.join(phaseDir, '03-02-SUMMARY.md'), '# Summary 2\n');

    // Also need ROADMAP.md for phase complete
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 3: API\n\n- [ ] Phase 3: API Layer\n`
    );

    const result = runGsdTools('phase complete 3', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    assert.ok(stateAfter.includes('Total plans completed:'), 'Velocity section should have total plans');
    assert.ok(stateAfter.match(/Total plans completed:\s*2/), 'Total plans should be 2');
    assert.ok(stateAfter.includes('| 3'), 'By Phase table should have row for phase 3');
  });

  test('existing Plan Execution Times rows aggregated into Velocity/By Phase', () => {
    const content = `# Project State

**Current Phase:** 04
**Status:** Executing Phase 4

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 3 P1 | 12 min | 5 tasks | 3 files |
| Phase 3 P2 | 8 min | 3 tasks | 2 files |

**Velocity:**
- Total plans completed: 2
- Average duration: 10 min
- Total execution time: 0.3 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 3 | 2 | 20 min | 10 min |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    // Create phase 4 with 1 plan, 1 summary
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '04-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '04-01-SUMMARY.md'), '# Summary 1\n');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 4: UI\n\n- [ ] Phase 4: UI Layer\n`
    );

    const result = runGsdTools('phase complete 4', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');
    assert.ok(stateAfter.match(/Total plans completed:\s*3/), 'Total plans should be 3 (2 previous + 1 new)');
    assert.ok(stateAfter.includes('| 4'), 'By Phase table should have row for phase 4');
  });

  test('idempotent — running twice produces same result', () => {
    const content = `# Project State

**Current Phase:** 05
**Status:** Executing Phase 5

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: N/A
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-final');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '05-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '05-01-SUMMARY.md'), '# Summary\n');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 5: Final\n\n- [ ] Phase 5: Final\n`
    );

    runGsdTools('phase complete 5', tmpDir);
    const afterFirst = fs.readFileSync(statePath, 'utf-8');

    // Reset state so we can complete again
    let resetContent = afterFirst.replace(/Milestone complete|Ready to plan/, 'Executing Phase 5');
    resetContent = resetContent.replace(/Not started/, '1');
    fs.writeFileSync(statePath, resetContent);

    // Re-create plan files (they still exist)
    runGsdTools('phase complete 5', tmpDir);
    const afterSecond = fs.readFileSync(statePath, 'utf-8');

    // Both should have same total plans count (idempotent update for same phase)
    const firstCount = afterFirst.match(/Total plans completed:\s*(\d+)/);
    const secondCount = afterSecond.match(/Total plans completed:\s*(\d+)/);
    assert.ok(firstCount, 'First run should have total plans');
    assert.ok(secondCount, 'Second run should have total plans');
    // Second run adds another completion for phase 5, so count increments
    // The key is the By Phase row for phase 5 should be updated, not duplicated
    const phase5Rows = (afterSecond.match(/\|\s*5\s*\|/g) || []).length;
    assert.ok(phase5Rows <= 1, 'Phase 5 should appear at most once in By Phase table (no duplicates)');
  });

  test('byPhaseTablePattern behavior-lock (#320): By Phase table header preserved and phase row upserted after hoist to module scope', () => {
    // Exercises the byPhaseTablePattern match path directly: header must be preserved,
    // an existing phase row must be replaced (not duplicated), and a new phase row inserted.
    const content = `# Project State

**Current Phase:** 06
**Status:** Executing Phase 6

## Performance Metrics

**Velocity:**
- Total plans completed: 1
- Average duration: 5 min
- Total execution time: 0.1 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 6 | 1 | 5 min | 5 min |

## Accumulated Context
`;
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '06-lock');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '06-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '06-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(phaseDir, '06-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '06-02-SUMMARY.md'), '# Summary 2\n');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 6: Lock\n\n- [ ] Phase 6: Lock\n`
    );

    const result = runGsdTools('phase complete 6', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(statePath, 'utf-8');

    // Header must be preserved
    assert.ok(stateAfter.includes('| Phase | Plans | Total | Avg/Plan |'), 'By Phase table header must be preserved');

    // Phase 6 row must appear exactly once (upserted, not duplicated)
    const phase6Rows = (stateAfter.match(/\|\s*6\s*\|/g) || []).length;
    assert.strictEqual(phase6Rows, 1, 'Phase 6 row must appear exactly once in By Phase table (upsert, not append)');

    // Total plans count updated correctly (1 pre-existing + 2 new summaries)
    assert.ok(stateAfter.match(/Total plans completed:\s*3/), 'Total plans completed should be 3 after upsert');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state planned-phase (Step 3 — Gate 3a)
// ─────────────────────────────────────────────────────────────────────────────

describe('state planned-phase command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('after call: Status is "Ready to execute"', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning Phase 3\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 3\n`
    );

    const result = runGsdTools(['state', 'planned-phase', '--phase', '3', '--name', 'API', '--plans', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(stateContent.includes('Ready to execute'), 'Status should be "Ready to execute"');
  });

  test('after call: Total Plans matches argument', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 2\n`
    );

    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '7'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(stateContent.match(/Total Plans in Phase.*7/), 'Total Plans should be 7');
  });

  test('after call: Last Activity is the pinned date (deterministic via GSD_NOW_MS)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 1\n`
    );

    const PINNED_MS = Date.parse('2020-09-10T15:00:00.000Z');
    const PINNED_DATE = '2020-09-10';
    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '1', '--name', 'Setup', '--plans', '3'],
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      stateContent.includes(PINNED_DATE),
      `Last Activity should contain the pinned date ${PINNED_DATE}`,
    );
  });

  test('missing STATE.md returns graceful error', () => {
    // No STATE.md written
    const result = runGsdTools(['state', 'planned-phase', '--phase', '1', '--name', 'Test', '--plans', '3'], tmpDir);
    assert.ok(result.success, 'Should not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'Should return error field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #1070 regression: "Complete ✓" terminal status must yield to planned-phase
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #1070: "Complete ✓" terminal status yields to Ready to execute on planned-phase', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Full STATE.md shape that matches the canonical fixture used across state tests.
  // Both **Status:** frontmatter and Current Position `Status:` are set to the given value.
  function makeStateMd(statusValue) {
    return `# Project State

**Current Phase:** 1
**Current Phase Name:** setup
**Total Phases:** 5
**Current Plan:** 0
**Total Plans in Phase:** 0
**Status:** ${statusValue}
**Last Activity:** 2026-03-20
**Last Activity Description:** Phase 1 complete

## Current Position
Phase: 1 of 5 (setup)
Plan: 0 of 5 in current phase
Status: ${statusValue}
Last activity: 2026-03-20 -- Phase 1 complete
Progress: [##########] 20%

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
`;
  }

  // Case 1: the bug — Complete ✓ blocks the state machine
  test('case 1: Complete ✓ in both frontmatter and Current Position is overwritten by planned-phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Complete ✓')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);

    // The updated array must include Status (both paths ran the replacement)
    assert.ok(
      Array.isArray(output.updated) && output.updated.includes('Status'),
      `Expected output.updated to include "Status", got: ${JSON.stringify(output.updated)}`
    );

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // The checkmark form must be gone
    assert.ok(
      !stateContent.includes('Complete ✓'),
      'STATE.md must not contain "Complete ✓" after planned-phase'
    );

    // Frontmatter **Status:** line must now be "Ready to execute"
    const fmStatusMatch = stateContent.match(/\*\*Status:\*\*\s*(.+)/);
    assert.ok(fmStatusMatch, '**Status:** frontmatter line not found');
    assert.strictEqual(
      fmStatusMatch[1].trim(),
      'Ready to execute',
      `Frontmatter **Status:** should be "Ready to execute", got: "${fmStatusMatch[1].trim()}"`
    );

    // Current Position Status: line must also be "Ready to execute"
    const posMatch = stateContent.match(/## Current Position\s*\n([\s\S]*?)(?=\n##|$)/i);
    assert.ok(posMatch, 'Current Position section not found');
    const posStatusMatch = posMatch[1].match(/^Status:\s*(.+)/m);
    assert.ok(posStatusMatch, 'Status field not found in Current Position section');
    assert.strictEqual(
      posStatusMatch[1].trim(),
      'Ready to execute',
      `Current Position Status should be "Ready to execute", got: "${posStatusMatch[1].trim()}"`
    );
  });

  // Case 2: a genuinely executor-authored non-terminal status must NOT be overwritten
  // (frontmatter **Status:** path via stateReplaceFieldIfTemplate)
  test('case 2: executor-authored non-terminal status is preserved by planned-phase (#397 narrowness check)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Blocked on infra review')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // The executor-authored Status must survive in the frontmatter
    const fmStatusMatch = stateContent.match(/\*\*Status:\*\*\s*(.+)/);
    assert.ok(fmStatusMatch, '**Status:** frontmatter line not found');
    assert.strictEqual(
      fmStatusMatch[1].trim(),
      'Blocked on infra review',
      `Frontmatter **Status:** should be preserved as "Blocked on infra review", got: "${fmStatusMatch[1].trim()}"`
    );
  });

  // Case 3: executor-authored non-terminal status in the Current Position section
  // must NOT be overwritten (exercises updateCurrentPositionFields in src/state.cts,
  // a separate code path from the frontmatter matcher).
  test('case 3: executor-authored non-terminal status in Current Position is preserved by planned-phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      makeStateMd('Blocked on infra review')
    );

    const result = runGsdTools(
      ['state', 'planned-phase', '--phase', '2', '--name', 'Core', '--plans', '5'],
      tmpDir
    );
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // Locate the Current Position section and verify the Status line there.
    const posMatch = stateContent.match(/## Current Position\s*\n([\s\S]*?)(?=\n##|$)/i);
    assert.ok(posMatch, 'Current Position section not found');
    const posStatusMatch = posMatch[1].match(/^Status:\s*(.+)/m);
    assert.ok(posStatusMatch, 'Status field not found in Current Position section');
    assert.strictEqual(
      posStatusMatch[1].trim(),
      'Blocked on infra review',
      `Current Position Status should be preserved as "Blocked on infra review", got: "${posStatusMatch[1].trim()}"`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state validate (Step 4 — Gate 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('state validate command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE says executing + VERIFICATION.md shows passed emits warning', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 2\n**Current Phase:** 2\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '02-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.warnings.length > 0, 'Should have warnings when executing but verification passed');
    assert.ok(output.warnings.some(w => /verif/i.test(w)), 'Warning should mention verification');
  });

  test('STATE plan count 3 but 12 SUMMARY.md on disk emits mismatch warning', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 3\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    // Write 12 plans and summaries
    for (let i = 1; i <= 12; i++) {
      const padded = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `01-${padded}-PLAN.md`), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, `01-${padded}-SUMMARY.md`), '# Summary\n');
    }

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.warnings.length > 0, 'Should have warnings for plan count mismatch');
    assert.ok(output.warnings.some(w => /plan.*count|count.*mismatch/i.test(w)), 'Warning should mention plan count mismatch');
  });

  test('perfect state returns valid: true, no warnings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, 'Should be valid');
    assert.strictEqual(output.warnings.length, 0, 'Should have no warnings');
  });

  test('missing STATE.md returns graceful error', () => {
    const result = runGsdTools('state validate', tmpDir);
    assert.ok(result.success, 'Should not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'Should return error field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state sync (Step 5 — Gate 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('state sync command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('drifted STATE.md + correct filesystem: after sync, fields match disk', () => {
    // STATE says phase 1 with 0 plans, but disk has phase 2 with 3 plans
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Current Phase:** 1\n**Total Plans in Phase:** 0\n**Current Plan:** 0\n**Progress:** 0%\n`
    );

    const phase1Dir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1Dir, { recursive: true });
    fs.writeFileSync(path.join(phase1Dir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase1Dir, '01-01-SUMMARY.md'), '# Summary\n');

    const phase2Dir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phase2Dir, { recursive: true });
    fs.writeFileSync(path.join(phase2Dir, '02-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-03-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phase2Dir, '02-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.synced, 'Should report synced');

    const stateAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // Total plans in current phase (phase 2 since it's highest with incomplete plans) should be 3
    assert.ok(stateAfter.match(/Total Plans in Phase.*3/), 'Total Plans should match disk (3)');
  });

  test('run sync twice is idempotent', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Executing Phase 1\n**Current Phase:** 1\n**Total Plans in Phase:** 2\n**Current Plan:** 1\n**Progress:** 0%\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    runGsdTools('state sync', tmpDir);
    const afterFirst = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    runGsdTools('state sync', tmpDir);
    const afterSecond = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // Strip frontmatter timestamps which will differ
    const stripTimestamps = (s) => s.replace(/last_updated:.*\n/g, '').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'TS');
    assert.strictEqual(stripTimestamps(afterFirst), stripTimestamps(afterSecond), 'Two syncs should produce same result');
  });

  test('--verify flag reports changes without writing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Status:** Planning\n**Current Phase:** 1\n**Total Plans in Phase:** 0\n**Current Plan:** 0\n**Progress:** 0%\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');

    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('state sync --verify', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.changes && output.changes.length > 0, 'Should report changes');
    assert.strictEqual(output.dry_run, true, 'Should indicate dry run');

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(before, after, 'File should not be modified in verify mode');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2444: stopped_at frontmatter must not be overwritten by historical body prose
// ─────────────────────────────────────────────────────────────────────────────

describe('stopped_at frontmatter not overwritten by historical prose (bug #2444)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves correct stopped_at frontmatter when historical plain-text match appears before Session section', () => {
    // The bug: body has plain "Stopped at:" in old notes (no bold) — stateExtractField
    // uses a plain ^Stopped at:\s*(.+) pattern with /im which matches the first line,
    // returning the stale historical value. syncStateFrontmatter has no preservation
    // step for stopped_at like cmdStateJson does, so it overwrites the correct value.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: '1.0'
status: executing
stopped_at: Phase 3, Plan 2 — current correct value
---

# Project State

**Current Phase:** 03
**Status:** In progress

## Previous Session Notes

Stopped at: Phase 5 complete — v1.0 shipped (OLD stale historical note)

## Session

Last Date: 2026-04-19
Stopped At: Phase 3, Plan 2 — current correct value
`
    );

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // The correct frontmatter value must survive the sync
    assert.ok(
      stateContent.includes('Phase 3, Plan 2 — current correct value'),
      'stopped_at must retain the correct value from the ## Session section'
    );
    assert.ok(
      !stateContent.includes('stopped_at: Phase 5 complete'),
      'stopped_at must NOT be overwritten with the old historical note'
    );
  });

  test('state sync does not promote stale body prose to stopped_at frontmatter when frontmatter has no stopped_at', () => {
    // No existing stopped_at in frontmatter, body has plain Stopped at: in
    // a historical notes section appearing BEFORE the real ## Session entry.
    // buildStateFrontmatter should scope extraction to ## Session section, not
    // match the first occurrence anywhere in the body.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---
gsd_state_version: '1.0'
status: executing
---

# Project State

**Current Phase:** 03
**Status:** In progress

## Old Notes

Stopped at: Phase 5 complete — v1.0 STALE (should never land in frontmatter)

## Session

Last Date: 2026-04-19
Stopped At: Phase 3, Plan 1 — real current value
`
    );

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const output = JSON.parse(jsonResult.output);

    assert.strictEqual(output.stopped_at, 'Phase 3, Plan 1 — real current value',
      'stopped_at must be extracted from ## Session section, not the first plain-text match in the body');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2445: stale phase dirs from closed milestone inflate phase counts
// ─────────────────────────────────────────────────────────────────────────────

describe('stale phase dirs do not corrupt phase counts (bug #2445)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json excludes stale prior-milestone phase dirs from phase count when ROADMAP scopes current milestone', () => {
    // Old milestone had phases 1-5; new milestone starts fresh with phases 1-2.
    // Stale dirs for old phases 3, 4, 5 remain in .planning/phases/ and must be
    // excluded by getMilestonePhaseFilter (new ROADMAP only lists phases 1 and 2).
    // Old phases 1 and 2 dirs are ambiguous (same number reused) but phase 3-5 dirs
    // must not inflate total_phases beyond the ROADMAP's phaseCount of 2.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details>',
        '<summary>v1.0 — Old Milestone (Shipped)</summary>',
        '',
        '## Roadmap v1.0: Old Milestone',
        '### Phase 1: Old Foundation',
        '### Phase 2: Old API',
        '### Phase 3: Old Deploy',
        '### Phase 4: Old Polish',
        '### Phase 5: Old Wrap',
        '',
        '</details>',
        '',
        '## Roadmap v2.0: New Milestone',
        '### Phase 1: New Foundation',
        '### Phase 2: New API',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v2.0\n---\n\n# State\n\n**Current Phase:** 01\n**Status:** Planning\n'
    );

    // Create stale v1.0 phase dirs 3, 4, 5 — these are NOT in the new ROADMAP
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (const dir of ['03-old-deploy', '04-old-polish', '05-old-wrap']) {
      const d = path.join(phasesDir, dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${dir.slice(0, 2)}-01-PLAN.md`), '# stale plan\n');
    }

    // New milestone has only Phase 1 started so far
    const newPhaseDir = path.join(phasesDir, '01-new-foundation');
    fs.mkdirSync(newPhaseDir, { recursive: true });
    fs.writeFileSync(path.join(newPhaseDir, '01-01-PLAN.md'), '# new plan\n');

    const result = runGsdTools('state json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // total_phases must be bounded by the ROADMAP's 2 phases, not 4 total dirs
    // (the 3 stale dirs for phases 3-5 must be excluded by the milestone filter)
    assert.ok(
      output.progress && output.progress.total_phases <= 2,
      `total_phases should be ≤ 2 (new milestone phases 1-2 only), got ${output.progress?.total_phases}`
    );
    // total_plans must only count plans from current-milestone phase dirs
    assert.ok(
      output.progress && output.progress.total_plans <= 1,
      `total_plans should be 1 (only new phase 1 dir), got ${output.progress?.total_plans}`
    );
  });

  test('init new-milestone phase_dir_count excludes stale prior-milestone dirs', () => {
    // ROADMAP scoped to v2.0 with 2 phases
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details>',
        '<summary>v1.0 — Shipped</summary>',
        '',
        '## Roadmap v1.0: Old',
        '### Phase 1: Old One',
        '### Phase 2: Old Two',
        '### Phase 3: Old Three',
        '',
        '</details>',
        '',
        '## Roadmap v2.0: New',
        '### Phase 1: New One',
        '### Phase 2: New Two',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nmilestone: v2.0\n---\n\n# State\n\n**Status:** Planning\n'
    );

    // Three stale phase dirs from the old milestone
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (const dir of ['01-old-one', '02-old-two', '03-old-three']) {
      fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
    }

    const result = runGsdTools('init new-milestone', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // phase_dir_count should not include stale dirs from the old milestone
    assert.ok(
      output.phase_dir_count <= 2,
      `phase_dir_count should be ≤ 2 (only new-milestone dirs), got ${output.phase_dir_count}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state complete-phase: Phase-fallback decoration handling (PR #2761 nitpick)
// ─────────────────────────────────────────────────────────────────────────────
//
// When STATE.md is missing the canonical `**Current Phase:**` field but
// includes a decorated `## Current Position` body line, the fallback path used
// to leak the decoration into downstream Status/Phase strings — producing
// `**Status:** Phase 01 (Foo) — EXECUTING complete` instead of the expected
// `**Status:** Phase 01 complete`. CodeRabbit flagged this on PR #2761 and the
// Phase fallback now strips everything past the leading numeric/decimal token.
describe('state complete-phase: decorated Phase fallback (#2761 nitpick)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('writes clean Phase identifier when only Current Position decoration is present', () => {
    // STATE.md without the canonical `**Current Phase:**` field — the only
    // phase signal lives inside the `## Current Position` block as a decorated
    // line. This is the regression fixture.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: 01 (Foo) — EXECUTING',
      'Plan: bootstrap',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );

    // Status should reference the bare phase identifier (`01`), not the
    // decorated string. The negative assertion catches the regression
    // shape directly.
    assert.ok(
      updated.includes('**Status:** Phase 01 complete'),
      `Status should be "Phase 01 complete", got STATE.md:\n${updated}`,
    );
    assert.ok(
      !updated.includes('Phase 01 (Foo) — EXECUTING complete'),
      `Status must not embed Current Position decoration: ${updated}`,
    );
  });

  test('canonical Current Phase field is preferred over Current Position decoration', () => {
    // When both are present, Current Phase wins — same outcome as before, but
    // pinned here so a future refactor that flips precedence is caught.
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Current Phase:** 03',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: 01 (Foo) — EXECUTING',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'utf-8',
    );
    assert.ok(
      updated.includes('**Status:** Phase 03 complete'),
      `Status should reference canonical Current Phase (03), got: ${updated}`,
    );
  });

  test('rejects unresolved literal Phase token and does not corrupt STATE.md (#3063)', () => {
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: narrative only',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd);

    const result = runGsdTools('state complete-phase', tmpDir);
    assert.ok(result.success, 'command should return JSON error payload, not crash');
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'expected clear resolution error');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!after.includes('Phase: Phase — COMPLETE'));
    assert.ok(!after.includes('Status: Phase Phase complete'));
  });

  test('supports explicit phase override for complete-phase disambiguation (#3063)', () => {
    const stateMd = [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '# State',
      '',
      '**Status:** Executing',
      '**Last Activity:** 2024-01-15',
      '',
      '## Current Position',
      '',
      'Phase: narrative only',
      '',
    ].join('\n');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, stateMd);

    const result = runGsdTools('state complete-phase --phase 3.3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('**Status:** Phase 3.3 complete'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// summary-extract command
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// state add-roadmap-evolution (regression: bug #1140)
//
// `query state.add-roadmap-evolution` was unreachable: the CJS state router
// listed it in its `unsupported` map with a message pointing back at the exact
// command that just failed ("...is SDK-only. Use: gsd-tools query
// state.add-roadmap-evolution ..."), and no CJS handler existed after the SDK
// retirement (ADR-0174). Every `/gsd:phase insert` and `/gsd:phase --edit` run
// hit a circular dead end. The fix re-implements `cmdStateAddRoadmapEvolution`
// in CJS and wires it into the state router. These cases follow the CLI/parser
// QA matrix in CONTRIBUTING.md (all invocations use argv arrays, no shell).
// ─────────────────────────────────────────────────────────────────────────────
describe('state add-roadmap-evolution (bug #1140)', () => {
  let tmpDir;

  const STATE_WITH_ACC_CONTEXT = `# Project State

## Current Status

**Current Phase:** 103.1

## Accumulated Context

### Decisions

- Some earlier decision
`;

  const writeState = (dir, body) => fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), body);
  const readState = (dir) => fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf-8');
  // Body of `## Accumulated Context` bounded by the next h2 (or EOF), so
  // placement assertions prove a subsection sits INSIDE that section.
  const accumulatedContextBody = (state) => {
    const m = state.match(/##\s*Accumulated Context\s*\n([\s\S]*?)(?=\n##[^#]|$)/);
    return m ? m[1] : null;
  };

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // The literal issue repro: negative proof the circular dead end is gone.
  test('query state.add-roadmap-evolution no longer routes to the circular SDK-only rejection', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['query', 'state.add-roadmap-evolution',
        '--phase', '103.2', '--action', 'inserted', '--after', '103.1',
        '--note', 'test', '--urgent'],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(
      !/SDK-only/i.test(result.output) && !/SDK-only/i.test(result.error || ''),
      `must not emit the circular "SDK-only" rejection; got output=${result.output} error=${result.error}`
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.added, true);
    assert.match(parsed.entry, /\(URGENT\)$/);
  });

  test('appends an entry, creating the ### Roadmap Evolution subsection under ## Accumulated Context', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution',
        '--phase', '103.2', '--action', 'inserted', '--after', '103.1',
        '--note', 'Add OAuth login', '--urgent'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(
      state.includes('- Phase 103.2 inserted after Phase 103.1: Add OAuth login (URGENT)'),
      `entry not found in:\n${state}`
    );
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 1, 'subsection must not be duplicated');
    const accBody = accumulatedContextBody(state);
    assert.ok(accBody && accBody.includes('### Roadmap Evolution'), 'subsection must be inside Accumulated Context');
    assert.ok(accBody.includes('- Phase 103.2 inserted after Phase 103.1: Add OAuth login (URGENT)'), 'entry must be inside Accumulated Context');
    assert.ok(state.includes('- Some earlier decision'), 'existing content preserved');
  });

  test('omitting --urgent and --after produces a plain entry', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '103.2', '--action', 'edited',
        '--note', 'edited fields: goal, depends_on'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 103.2 edited: edited fields: goal, depends_on'), `missing entry:\n${state}`);
    assert.ok(!/\(URGENT\)/.test(state), 'no URGENT suffix when --urgent absent');
  });

  test('creates ### Roadmap Evolution when ## Accumulated Context exists without it', () => {
    writeState(tmpDir, `# Project State

## Accumulated Context

### Decisions

- prior decision

## Next Steps

- do the thing
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '4', '--action', 'added', '--note', 'caching layer'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('### Roadmap Evolution'), 'subsection created');
    assert.ok(state.includes('- Phase 4 added: caching layer'), 'entry appended');
    const subIdx = state.indexOf('### Roadmap Evolution');
    const nextIdx = state.indexOf('## Next Steps');
    assert.ok(subIdx !== -1 && nextIdx !== -1 && subIdx < nextIdx, 'subsection must be inside Accumulated Context');
    assert.ok(state.includes('- do the thing'), 'sibling section preserved');
  });

  test('creates both ## Accumulated Context and ### Roadmap Evolution when neither exists', () => {
    writeState(tmpDir, `# Project State

## Current Status

**Current Phase:** 1
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '2', '--action', 'inserted', '--after', '1', '--note', 'bootstrap'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).added, true);

    const state = readState(tmpDir);
    assert.strictEqual((state.match(/^## Accumulated Context$/gm) || []).length, 1, 'Accumulated Context created once');
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 1, 'subsection created once');
    assert.ok(state.includes('- Phase 2 inserted after Phase 1: bootstrap'), 'entry appended');
  });

  test('targets the subsection under Accumulated Context, never a decoy heading elsewhere', () => {
    writeState(tmpDir, `# Project State

## Accumulated Context

### Decisions

- prior decision

## Reference Notes

### Roadmap Evolution

- DECOY entry that must never be touched
`);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '8', '--action', 'inserted', '--note', 'real entry'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    const accBody = accumulatedContextBody(state);
    assert.ok(accBody && accBody.includes('- Phase 8 inserted: real entry'), 'entry must be inside Accumulated Context');
    assert.ok(state.includes('- DECOY entry that must never be touched'), 'decoy preserved');
    assert.ok(!accBody.includes('DECOY'), 'decoy must not be pulled into Accumulated Context');
    assert.strictEqual((state.match(/^### Roadmap Evolution$/gm) || []).length, 2, 'a new subsection is created under Accumulated Context; decoy heading remains');
  });

  test('flattens a multiline note into a single bullet so dedupe and rendering hold', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const notePath = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(notePath, 'line one\nline two\nline three\n');

    const first = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '9', '--action', 'edited', '--note-file', notePath],
      tmpDir
    );
    assert.ok(first.success, `Command failed: ${first.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 9 edited: line one line two line three'), `note not flattened:\n${state}`);
    assert.ok(!/\n\s*line two/.test(state), 'continuation lines must not spill outside the bullet');

    const second = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '9', '--action', 'edited', '--note-file', notePath],
      tmpDir
    );
    assert.strictEqual(JSON.parse(second.output).reason, 'duplicate', 'flattened entry must dedupe on replay');
  });

  test('deduplicates an identical entry on replay', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const args = ['state', 'add-roadmap-evolution', '--phase', '103.2', '--action', 'inserted',
      '--after', '103.1', '--note', 'Add OAuth login', '--urgent'];

    const first = runGsdTools(args, tmpDir);
    assert.ok(first.success, `first call failed: ${first.error}`);
    assert.strictEqual(JSON.parse(first.output).added, true);

    const second = runGsdTools(args, tmpDir);
    assert.ok(second.success, `second call failed: ${second.error}`);
    const parsed = JSON.parse(second.output);
    assert.strictEqual(parsed.added, false, 'replay must not add');
    assert.strictEqual(parsed.reason, 'duplicate');

    const state = readState(tmpDir);
    const occurrences = (state.match(/- Phase 103\.2 inserted after Phase 103\.1: Add OAuth login \(URGENT\)/g) || []).length;
    assert.strictEqual(occurrences, 1, 'entry must appear exactly once after replay');
  });

  test('CRLF STATE.md: appends under Accumulated Context while preserving later sections', () => {
    const crlf = [
      '# Project State', '',
      '## Accumulated Context', '',
      '### Decisions', '',
      '- prior decision', '',
      '## Blockers', '',
      '- keep me', '',
      '## History', '',
      '- also keep me', '',
    ].join('\r\n');
    writeState(tmpDir, crlf);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '4', '--action', 'inserted', '--note', 'crlf safe'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = readState(tmpDir);
    assert.ok(state.includes('## Blockers'), '## Blockers must be preserved');
    assert.strictEqual((state.match(/^## Blockers/gm) || []).length, 1, '## Blockers not duplicated/corrupted');
    assert.ok(state.includes('- keep me'), 'Blockers content must be preserved');
    assert.ok(state.includes('## History'), '## History must be preserved');
    assert.ok(state.includes('- also keep me'), 'History content must be preserved');
    assert.ok(/### Roadmap Evolution/.test(state), 'subsection created');
    assert.ok(/- Phase 4 inserted: crlf safe/.test(state), 'entry appended');
  });

  test('missing --note is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted'],
      tmpDir
    );
    const combined = `${result.output}\n${result.error || ''}`;
    assert.match(combined, /note required/, 'should report the missing-note error');
    assert.ok(!/"added"\s*:\s*true/.test(result.output), 'must not report added:true');
    assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(result.error || ''), 'no stack trace in failure output');
    assert.strictEqual(readState(tmpDir), before, 'STATE.md not mutated on missing note');
  });

  test('empty --note "" is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', ''], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'STATE.md must be untouched for empty note');
  });

  test('whitespace-only --note is rejected without mutating STATE.md', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', '   '], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'STATE.md must be untouched for whitespace-only note');
  });

  test('--note followed by a flag-shaped token is treated as missing note', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);
    const before = readState(tmpDir);

    runGsdTools(['state', 'add-roadmap-evolution', '--phase', '5', '--note', '--weird'], tmpDir);
    assert.strictEqual(readState(tmpDir), before, 'flag-shaped value must not be consumed as the note');
  });

  test('duplicate --phase flags do not crash; first value wins', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '7', '--phase', '9', '--action', 'inserted', '--note', 'dup flags'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const state = readState(tmpDir);
    assert.ok(state.includes('- Phase 7 inserted: dup flags'), `expected phase 7 entry:\n${state}`);
    assert.ok(!state.includes('Phase 9'), 'second --phase value must not be used');
  });

  test('shell metacharacters in --note are stored literally, never executed', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    // Probe path lives under the test's tmpDir (no hardcoded /tmp literal, which
    // the Windows-parity guard forbids). If command substitution executed, this
    // file would exist afterward.
    const probe = path.join(tmpDir, 'gsd-pwn-1140');
    const hostile = `pwn $(touch ${probe}) \`id\` ; rm -rf / && echo done`;
    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', hostile],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const state = readState(tmpDir);
    assert.ok(state.includes(hostile), 'hostile note must be stored verbatim');
    assert.ok(!fs.existsSync(probe), 'command substitution must not have executed');
  });

  test('Unicode note content is preserved', () => {
    writeState(tmpDir, STATE_WITH_ACC_CONTEXT);

    const note = 'café — 日本語 — 🚀 reroute';
    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'edited', '--note', note],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(readState(tmpDir).includes(note), 'Unicode preserved');
  });

  test('missing STATE.md returns a structured error, not a crash', () => {
    // Guarantee STATE.md is absent (force: no-op if the fixture didn't create one).
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- deleting a single fixture file to simulate the missing-STATE.md case, not a temp-dir teardown
    fs.rmSync(path.join(tmpDir, '.planning', 'STATE.md'), { force: true });

    const result = runGsdTools(
      ['state', 'add-roadmap-evolution', '--phase', '5', '--action', 'inserted', '--note', 'x'],
      tmpDir
    );
    const combined = `${result.output}\n${result.error || ''}`;
    assert.match(combined, /STATE\.md not found/, 'should report STATE.md not found');
    assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(result.error || ''), 'no stack trace');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regressions: table-format STATE.md (#1162)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal STATE.md that uses a pipe-table for the Current Position section.
 * This is the format that triggered the "Field not found" silent failure.
 */
function buildTableFormatState(opts) {
  const {
    status = 'Ready to plan',
    phase = '3',
    planCount = '4',
    lastActivity = '2026-01-01',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: planning',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | ${status} |`,
    `| Phase | ${phase} |`,
    `| Total Plans in Phase | ${planCount} |`,
    `| Last Activity | ${lastActivity} |`,
    '',
    '## Accumulated Context',
    '',
    'Some context here.',
    '',
  ].join('\n');
}

/**
 * STATE.md that uses bold inline format (the existing working format).
 * Included as a control case to confirm we did not break bold-field support.
 */
function buildBoldFormatState(opts) {
  const {
    status = 'Ready to plan',
    phase = '3',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: planning',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    `**Status:** ${status}`,
    `**Phase:** ${phase}`,
    '',
  ].join('\n');
}

describe('regressions: table-format STATE.md (#1162)', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1162-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Happy path: table-format field replacement ──────────────────────────

  test('state update rewrites table-cell Status value', () => {
    fs.writeFileSync(statePath, buildTableFormatState({ status: 'Ready to plan' }));

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    // Command must report success
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true but got: ' + JSON.stringify(parsed));

    // The table cell must be rewritten on disk
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'Table cell not rewritten. STATE.md content:\n' + written,
    );
    // Original value must be gone
    assert.ok(
      !written.includes('| Status | Ready to plan |'),
      'Old table cell value still present in STATE.md',
    );
  });

  test('state update rewrites table-cell value for arbitrary field', () => {
    fs.writeFileSync(statePath, buildTableFormatState({ lastActivity: '2026-01-01' }));

    const result = runGsdTools(['state', 'update', 'Last Activity', '2026-06-13'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true');

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Last Activity | 2026-06-13 |'),
      'Last Activity table cell not rewritten. Content:\n' + written,
    );
  });

  test('state update is case-insensitive for table field names', () => {
    // Table may have lowercase "status" in the first cell
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| status | Ready to plan |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'case-insensitive table match failed');
  });

  // ── Negative: separator row must NOT be treated as a field ───────────────

  test('separator row | --- | --- | is not matched as a field', () => {
    // The field name "---" is rejected by the field-name validator before
    // stateReplaceField is even called.  The command exits with a non-zero
    // status and a plain-text error, NOT a JSON { updated: false } result.
    // The key invariant is that the file is never corrupted.
    const originalContent = buildTableFormatState();
    fs.writeFileSync(statePath, originalContent);

    const result = runGsdTools(['state', 'update', '---', 'injected'], tmpDir);

    // The validator rejects '---' as an invalid field name — command must fail
    // OR, if somehow the command succeeds, updated must be false.
    if (result.success) {
      // Unlikely path — if the validator is relaxed in future, still must not update.
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { parsed = null; }
      if (parsed) {
        assert.equal(parsed.updated, false, 'separator row incorrectly matched as a field');
      }
    }
    // Either way: the file must be untouched (no 'injected' value written)
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!written.includes('injected'), 'separator row replacement leaked into file');
  });

  // ── Regression: bold-format still works after the fix ────────────────────

  test('state update bold-format still works after table support added', () => {
    fs.writeFileSync(statePath, buildBoldFormatState({ status: 'Ready to plan' }));

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'bold-format update broken after fix');

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('**Status:** Ready to execute'),
      'Bold-format field not rewritten. Content:\n' + written,
    );
  });

  // ── updateCurrentPositionFields table support ─────────────────────────────

  test('state planned-phase updates table-cell Status via updateCurrentPositionFields', () => {
    // cmdStatePlannedPhase uses updateCurrentPositionFields internally;
    // verify it also handles the table format.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** Ready to plan',
      '**Total Plans in Phase:** 0',
      '**Last Activity:** 2026-01-01',
      '**Last Activity Description:** initial',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| Status | Ready to plan |',
      '| Last Activity | 2026-01-01 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // Create a minimal phase dir so planned-phase can count plans
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '1-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '1-01-PLAN.md'), '# Plan 1');

    const result = runGsdTools(['state', 'planned-phase', '1', '--plan-count', '1'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    // The Current Position table cell should now be "Ready to execute"
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'planned-phase did not update table-cell Status. Content:\n' + written,
    );
  });

  // ── Adversarial / edge cases ──────────────────────────────────────────────

  test('table field with extra whitespace in cells is handled', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '|  Status  |  Ready to plan  |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'extra-whitespace table cell not matched');
  });

  test('updating one row in a multi-row table does not corrupt adjacent rows', () => {
    // Regression: updating `Status` must leave the `Phase` row untouched.
    // NOTE: values containing literal '|' (e.g., "blocked | waiting") are NOT
    // supported — the current value regex [^|\n]*? stops at the first pipe.
    // Escaped-pipe values are out of scope for single-token status fields.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '| Status | Ready to plan |',
      '| Phase | 3 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // Normal replacement — verify Phase row is untouched
    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(written.includes('| Phase | 3 |'), 'Phase row was corrupted during Status update');
  });

  test('CRLF line endings in table format are handled', () => {
    const content = buildTableFormatState({ status: 'Ready to plan' }).replace(/\n/g, '\r\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'CRLF table format not handled');
  });

  test('missing STATE.md returns updated:false gracefully', () => {
    // No STATE.md written — verify the command does not throw
    const missingDir = createTempProject('gsd-1162-missing-');
    try {
      const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], missingDir);
      const parsed = JSON.parse(result.output);
      assert.equal(parsed.updated, false, 'missing STATE.md should return updated:false');
    } finally {
      cleanup(missingDir);
    }
  });
});

describe('regressions: table-format STATE.md (#1162) — updateCurrentPositionFields preserve-authored invariants', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1162-f2-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: a STATE.md with table-format Current Position section.
  // We use planned-phase to exercise updateCurrentPositionFields indirectly,
  // because that is the call-site that writes Status/Last Activity.
  function buildMixedFormatState(opts) {
    const {
      status = 'Ready to plan',
      lastActivity = '2026-01-01',
    } = opts || {};
    return [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** Ready to plan',
      '**Total Plans in Phase:** 0',
      `**Last Activity:** ${lastActivity}`,
      '**Last Activity Description:** initial',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Status | ${status} |`,
      `| Last Activity | ${lastActivity} |`,
      '',
    ].join('\n');
  }

  // (a) Custom Status in table format must NOT be overwritten by planned-phase.
  test('(Finding 2a) custom Status in table format is preserved by updateCurrentPositionFields', () => {
    // "Blocked: waiting on infra" is executor-authored — not in KNOWN_TEMPLATE_DEFAULTS.
    // planned-phase calls updateCurrentPositionFields with status="Ready to execute".
    // The table-format branch must honour the same guard as the inline branch:
    // only overwrite when the existing value is a known template default.
    const content = buildMixedFormatState({ status: 'Blocked: waiting on infra', lastActivity: '2026-01-01' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools(['state', 'planned-phase', '2', '--plan-count', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Blocked: waiting on infra |'),
      'Custom Status was overwritten by updateCurrentPositionFields table branch.\nContent:\n' + written,
    );
    assert.ok(
      !written.includes('| Status | Ready to execute |'),
      'Custom Status replaced with Ready to execute in table branch.\nContent:\n' + written,
    );
  });

  // (b) Narrative Last Activity in table format must NOT be overwritten.
  test('(Finding 2b) narrative Last Activity in table format is preserved', () => {
    // "2026-02-15 -- blocked" has trailing prose — executor-authored.
    // planned-phase calls updateCurrentPositionFields with today's ISO date.
    // Must be preserved.
    const content = buildMixedFormatState({ status: 'Ready to plan', lastActivity: '2026-02-15 -- blocked' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools(['state', 'planned-phase', '2', '--plan-count', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Last Activity | 2026-02-15 -- blocked |'),
      'Narrative Last Activity was overwritten in table branch.\nContent:\n' + written,
    );
  });

  // (c) Known-default Status and bare-date Last Activity ARE updated.
  test('(Finding 2c) known-default Status and bare-date Last Activity ARE updated in table format', () => {
    // "Ready to plan" is a known default; "2026-01-01" is a bare ISO date.
    // Both should be replaced by planned-phase.
    const content = buildMixedFormatState({ status: 'Ready to plan', lastActivity: '2026-01-01' });
    fs.writeFileSync(statePath, content);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '2-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '2-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools(['state', 'planned-phase', '2', '--plan-count', '1'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'Known-default Status not updated in table branch.\nContent:\n' + written,
    );
    // Last Activity should be today's date (not 2026-01-01)
    assert.ok(
      !written.includes('| Last Activity | 2026-01-01 |'),
      'Bare-date Last Activity was NOT updated in table branch.\nContent:\n' + written,
    );
  });
});
