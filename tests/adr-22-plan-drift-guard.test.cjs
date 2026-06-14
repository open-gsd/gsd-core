// allow-test-rule: source-text-is-the-product #1190

/**
 * ADR-22 Drift-Guard Tests — issue #1190
 *
 * Covers:
 *  1. Pure unit tests for `classifyDriftSeverity` (every ADR-22 table cell).
 *  2. Pure unit tests for `getEffectiveAuthority` (auto-upgrade + pass-through).
 *  3. e2e CLI tests via `gsd-tools drift-guard severity/authority`.
 *  4. Structural test that plan-review-convergence.md invokes `gsd_run drift-guard`.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup, runGsdTools } = require('./helpers.cjs');

// ── Pure-module imports ──────────────────────────────────────────────────────

const {
  AUTHORITY_RUNGS,
  getEffectiveAuthority,
  classifyDriftSeverity,
} = require('../gsd-core/bin/lib/plan-drift-guard.cjs');

// ── 1. AUTHORITY_RUNGS sanity ────────────────────────────────────────────────

describe('AUTHORITY_RUNGS', () => {
  test('has all five adapters with correct rung order', () => {
    assert.equal(AUTHORITY_RUNGS.grep,       0);
    assert.equal(AUTHORITY_RUNGS.intel,      1);
    assert.equal(AUTHORITY_RUNGS.treesitter, 2);
    assert.equal(AUTHORITY_RUNGS.lsp,        3);
    assert.equal(AUTHORITY_RUNGS.scip,       4);
  });

  test('is frozen (no mutation)', () => {
    assert.ok(Object.isFrozen(AUTHORITY_RUNGS));
  });
});

// ── 2. getEffectiveAuthority unit tests ──────────────────────────────────────

describe('getEffectiveAuthority', () => {
  test('grep + intel enabled → intel', () => {
    assert.equal(getEffectiveAuthority('grep', true), 'intel');
  });

  test('grep + intel disabled → grep', () => {
    assert.equal(getEffectiveAuthority('grep', false), 'grep');
  });

  test('undefined + intel enabled → intel (grep is the default)', () => {
    assert.equal(getEffectiveAuthority(undefined, true), 'intel');
  });

  test('null + intel disabled → grep', () => {
    assert.equal(getEffectiveAuthority(null, false), 'grep');
  });

  test('empty string + intel enabled → intel', () => {
    assert.equal(getEffectiveAuthority('', true), 'intel');
  });

  test('intel + intel enabled → intel (no double upgrade)', () => {
    // intel is already intel; auto-upgrade rule only applies to grep
    assert.equal(getEffectiveAuthority('intel', true), 'intel');
  });

  test('intel + intel disabled → intel (pass-through)', () => {
    assert.equal(getEffectiveAuthority('intel', false), 'intel');
  });

  test('treesitter + intel enabled → treesitter (auto-upgrade only for grep)', () => {
    assert.equal(getEffectiveAuthority('treesitter', true), 'treesitter');
  });

  test('lsp + intel enabled → lsp (auto-upgrade only for grep)', () => {
    assert.equal(getEffectiveAuthority('lsp', true), 'lsp');
  });

  test('scip + intel disabled → scip', () => {
    assert.equal(getEffectiveAuthority('scip', false), 'scip');
  });

  test('unknown authority → TypeError', () => {
    assert.throws(
      () => getEffectiveAuthority('grok', false),
      (err) => err instanceof TypeError && /Unknown authority/i.test(err.message),
    );
  });
});

// ── 3. classifyDriftSeverity unit tests (every ADR-22 table cell) ──────────

describe('classifyDriftSeverity — VERIFIED', () => {
  for (const authority of ['grep', 'intel', 'treesitter', 'lsp', 'scip']) {
    test(`VERIFIED @ ${authority} → severity none, no hardBlock`, () => {
      const result = classifyDriftSeverity({ status: 'VERIFIED', authority });
      assert.equal(result.severity, 'none');
      assert.equal(result.hardBlock, false);
    });
  }
});

describe('classifyDriftSeverity — MISSING', () => {
  test('MISSING @ grep → needs-acknowledgement, no hardBlock', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'grep' });
    assert.equal(result.severity, 'needs-acknowledgement');
    assert.equal(result.hardBlock, false);
  });

  test('MISSING @ intel → needs-acknowledgement, no hardBlock', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'intel' });
    assert.equal(result.severity, 'needs-acknowledgement');
    assert.equal(result.hardBlock, false);
  });

  test('MISSING @ treesitter → needs-acknowledgement, no hardBlock', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'treesitter' });
    assert.equal(result.severity, 'needs-acknowledgement');
    assert.equal(result.hardBlock, false);
  });

  test('MISSING @ lsp → HIGH, hardBlock TRUE', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'lsp' });
    assert.equal(result.severity, 'HIGH');
    assert.equal(result.hardBlock, true);
  });

  test('MISSING @ scip → HIGH, hardBlock TRUE', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'scip' });
    assert.equal(result.severity, 'HIGH');
    assert.equal(result.hardBlock, true);
  });
});

describe('classifyDriftSeverity — AMBIGUOUS', () => {
  for (const authority of ['grep', 'intel', 'treesitter', 'lsp', 'scip']) {
    test(`AMBIGUOUS @ ${authority} → MEDIUM, no hardBlock`, () => {
      const result = classifyDriftSeverity({ status: 'AMBIGUOUS', authority });
      assert.equal(result.severity, 'MEDIUM');
      assert.equal(result.hardBlock, false);
    });
  }
});

describe('classifyDriftSeverity — UNCHECKABLE', () => {
  for (const authority of ['grep', 'intel', 'treesitter', 'lsp', 'scip']) {
    test(`UNCHECKABLE @ ${authority} → INFO, no hardBlock`, () => {
      const result = classifyDriftSeverity({ status: 'UNCHECKABLE', authority });
      assert.equal(result.severity, 'INFO');
      assert.equal(result.hardBlock, false);
    });
  }
});

describe('classifyDriftSeverity — validation', () => {
  test('unknown status → TypeError', () => {
    assert.throws(
      () => classifyDriftSeverity({ status: 'WRONG', authority: 'grep' }),
      (err) => err instanceof TypeError && /Unknown status/i.test(err.message),
    );
  });

  test('unknown authority → TypeError', () => {
    assert.throws(
      () => classifyDriftSeverity({ status: 'MISSING', authority: 'magic' }),
      (err) => err instanceof TypeError && /Unknown authority/i.test(err.message),
    );
  });
});

// ── 4. e2e CLI tests ─────────────────────────────────────────────────────────

describe('gsd-tools drift-guard — CLI e2e', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-drift-guard-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: write config.json into the fixture
  function writeConfig(cfg) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify(cfg),
    );
  }

  test('severity --status MISSING --authority lsp → {severity:HIGH, hardBlock:true}', () => {
    writeConfig({ plan_review: { source_grounding_authority: 'lsp' } });
    const res = runGsdTools(
      ['drift-guard', 'severity', '--status', 'MISSING', '--authority', 'lsp', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.severity, 'HIGH');
    assert.equal(result.hardBlock, true);
  });

  test('severity --status MISSING --authority grep → {severity:needs-acknowledgement, hardBlock:false}', () => {
    writeConfig({});
    const res = runGsdTools(
      ['drift-guard', 'severity', '--status', 'MISSING', '--authority', 'grep', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.severity, 'needs-acknowledgement');
    assert.equal(result.hardBlock, false);
  });

  test('severity --status VERIFIED --authority scip → {severity:none, hardBlock:false}', () => {
    writeConfig({});
    const res = runGsdTools(
      ['drift-guard', 'severity', '--status', 'VERIFIED', '--authority', 'scip', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.severity, 'none');
    assert.equal(result.hardBlock, false);
  });

  test('authority with source_grounding_authority=grep + intel.enabled=true → intel', () => {
    writeConfig({
      plan_review: { source_grounding_authority: 'grep' },
      intel: { enabled: true },
    });
    const res = runGsdTools(
      ['drift-guard', 'authority', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    assert.equal(res.output, 'intel');
  });

  test('authority with source_grounding_authority=lsp + intel.enabled=true → lsp (no upgrade)', () => {
    writeConfig({
      plan_review: { source_grounding_authority: 'lsp' },
      intel: { enabled: true },
    });
    const res = runGsdTools(
      ['drift-guard', 'authority', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    assert.equal(res.output, 'lsp');
  });

  test('authority with no config → grep (default)', () => {
    writeConfig({});
    const res = runGsdTools(
      ['drift-guard', 'authority', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    assert.equal(res.output, 'grep');
  });

  test('severity without --status flag → exits non-zero', () => {
    writeConfig({});
    const res = runGsdTools(['drift-guard', 'severity', '--raw'], tmpDir);
    assert.equal(res.success, false, 'Expected non-zero exit for missing --status');
    assert.ok(res.exitCode !== 0, `exitCode should be non-zero, got ${res.exitCode}`);
  });

  test('unknown subcommand → exits non-zero', () => {
    writeConfig({});
    const res = runGsdTools(['drift-guard', 'badcmd', '--raw'], tmpDir);
    assert.equal(res.success, false, 'Expected non-zero exit for unknown subcommand');
    assert.ok(res.exitCode !== 0, `exitCode should be non-zero, got ${res.exitCode}`);
  });
});

// ── 5. Structural test: plan-review-convergence.md invokes gsd_run drift-guard

describe('plan-review-convergence.md uses gsd_run drift-guard seam', () => {
  const WORKFLOW_PATH = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'plan-review-convergence.md',
  );

  test('workflow contains gsd_run drift-guard authority call', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('gsd_run drift-guard authority'),
      'plan-review-convergence.md must contain: gsd_run drift-guard authority',
    );
  });

  test('workflow drift-guard authority call includes --raw (prevents JSON-quoted capture)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.match(
      content,
      /gsd_run drift-guard authority --raw/,
      'plan-review-convergence.md authority capture must use --raw; without it the value is JSON-quoted ("intel") and --authority rejects it as unknown',
    );
  });

  test('workflow contains gsd_run drift-guard severity call', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('gsd_run drift-guard severity'),
      'plan-review-convergence.md must contain: gsd_run drift-guard severity',
    );
  });

  test('workflow drift-guard severity call passes --authority flag', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.match(
      content,
      /gsd_run drift-guard severity[^\n]*--authority/,
      'plan-review-convergence.md severity invocation must pass --authority so the resolved authority is forwarded to classifyDriftSeverity',
    );
  });
});
