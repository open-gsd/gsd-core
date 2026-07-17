'use strict';

/**
 * Representative-corpus gate tests (#2371).
 *
 * Every fixture under tests/fixtures/representative/ is verbatim (or a
 * minimal faithful subset) of a real reported artifact — never invented to
 * match a gate's own grammar. See tests/fixtures/representative/README.md
 * for the full rationale and CONTRIBUTING.md's "Fixture provenance" rule.
 *
 * Each gate is driven through its real CLI entrypoint (gate-verdict
 * altitude), matching the established pattern in
 * tests/api-coverage-gate-e2e.test.cjs and tests/decisions.test.cjs — never
 * the parser function called in isolation.
 *
 * Two fixtures encode correct behavior that today's code does not deliver
 * (#2365, #2347 — both open). Those assertions are marked `{ todo: '#NNNN' }`:
 * per Node's documented test() todo option, the test still executes and
 * still reports its failure, but does not affect the process exit code
 * (https://nodejs.org/api/test.html#test-options). The fixes belong to
 * their own issues, not to this file. The audit-uat corpus (#2286, fixed by
 * #2317) is a normal, currently-passing assertion — proof the methodology
 * works, not just a record of gaps.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'representative');

const TEST_ENV_BASE = {
  GSD_SESSION_KEY: '',
  CODEX_THREAD_ID: '',
  CLAUDE_SESSION_ID: '',
  CLAUDE_CODE_SSE_PORT: '',
  OPENCODE_SESSION_ID: '',
  GEMINI_SESSION_ID: '',
  CURSOR_SESSION_ID: '',
  WINDSURF_SESSION_ID: '',
  TERM_SESSION: '',
  WT_SESSION: '',
  TMUX_PANE: '',
  ZELLIJ_SESSION_NAME: '',
  TTY: '',
  SSH_TTY: '',
};

function runTools(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [TOOLS_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...TEST_ENV_BASE },
      timeout: 60000,
    });
    return { success: true, output: stdout.trim(), error: '' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message,
    };
  }
}

function readManifest(gateDir) {
  const raw = fs.readFileSync(path.join(FIXTURES_ROOT, gateDir, 'MANIFEST.json'), 'utf8');
  return JSON.parse(raw);
}

function readFixture(gateDir, file) {
  return fs.readFileSync(path.join(FIXTURES_ROOT, gateDir, file), 'utf8');
}

function makeProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-repcorpus-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}', 'utf8');
  return tmpDir;
}

function makePhaseDir(projectDir, slug) {
  const dir = path.join(projectDir, '.planning', 'phases', slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── api-coverage-detector (#2365) ────────────────────────────────────────────

describe('representative corpus — api-coverage detector (#2365)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  const manifest = readManifest('api-coverage-detector');

  for (const fx of manifest.fixtures) {
    test(`${fx.file} → detected:false`, { todo: manifest.sourceIssue }, () => {
      tmpDir = makeProject();
      const phaseDir = makePhaseDir(tmpDir, '01-repcorpus');
      const body = readFixture('api-coverage-detector', fx.file);
      fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), `# Plan\n${body}\n`, 'utf8');

      const r = runTools(['check', 'api-coverage.verify-pre', phaseDir, '--raw'], tmpDir);
      assert.ok(r.success, `gate should succeed (JSON). stderr: ${r.error}`);
      const j = JSON.parse(r.output);
      assert.strictEqual(j.detected, fx.expectedDetected,
        `${fx.file}: expected detected:${fx.expectedDetected}, got ${JSON.stringify(j)}`);
    });
  }
});

// ─── api-coverage-matrix (#2366) ──────────────────────────────────────────────

describe('representative corpus — api-coverage matrix (#2366)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  const manifest = readManifest('api-coverage-matrix');

  for (const fx of manifest.fixtures) {
    test(`${fx.file} → exactly the canonical rows, 0 errors`, { todo: manifest.sourceIssue }, () => {
      tmpDir = makeProject();
      const phaseDir = makePhaseDir(tmpDir, '01-repcorpus');
      fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), `# Plan\n${fx.pairedPlan}\n`, 'utf8');
      fs.writeFileSync(path.join(phaseDir, 'COVERAGE.md'), readFixture('api-coverage-matrix', fx.file), 'utf8');

      const r = runTools(['check', 'api-coverage.verify-pre', phaseDir, '--raw'], tmpDir);
      assert.ok(r.success, `gate should succeed (JSON). stderr: ${r.error}`);
      const j = JSON.parse(r.output);
      assert.strictEqual(j.block, fx.expectedBlock, `${fx.file}: block. Got ${JSON.stringify(j)}`);
      assert.deepStrictEqual(j.counts, fx.expectedCounts, `${fx.file}: counts. Got ${JSON.stringify(j)}`);
      assert.strictEqual((j.errors || []).length, fx.expectedErrorCount,
        `${fx.file}: errors. Got ${JSON.stringify(j.errors)}`);
    });
  }
});

// ─── audit-uat (#2286, fixed by #2317 — NOT todo) ─────────────────────────────

describe('representative corpus — audit-uat (#2286, fixed by #2317)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  const manifest = readManifest('audit-uat');

  test('Gaps-section + human-verification-frontmatter fixtures both surface as real items', () => {
    tmpDir = makeProject();
    const phaseDir = makePhaseDir(tmpDir, '01-repcorpus');
    for (const fx of manifest.fixtures) {
      fs.writeFileSync(
        path.join(phaseDir, `01${fx.filenameSuffix}`),
        readFixture('audit-uat', fx.file),
        'utf8',
      );
    }

    const r = runTools(['audit-uat', '--raw'], tmpDir);
    assert.ok(r.success, `audit-uat should succeed. stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.ok(
      j.summary.total_items >= manifest.expectedTotalItems,
      `expected total_items >= ${manifest.expectedTotalItems}, got ${JSON.stringify(j.summary)}`,
    );
  });
});

// ─── decision-coverage-guard (#2347) ──────────────────────────────────────────

describe('representative corpus — decision-coverage guard (#2347)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  const manifest = readManifest('decision-coverage-guard');

  for (const fx of manifest.fixtures) {
    test(`${fx.file} → outcome could-not-parse, passed:false`, { todo: manifest.sourceIssue }, () => {
      tmpDir = makeProject();
      const phaseDir = makePhaseDir(tmpDir, '01-repcorpus');
      const contextPath = path.join(phaseDir, 'CONTEXT.md');
      fs.writeFileSync(contextPath, readFixture('decision-coverage-guard', fx.file), 'utf8');

      const r = runTools(['query', 'check.decision-coverage-plan', phaseDir, contextPath], tmpDir);
      assert.ok(r.success, `gate should succeed (JSON). stderr: ${r.error}`);
      const j = JSON.parse(r.output);
      assert.strictEqual(j.passed, fx.expectedPassed, `${fx.file}: passed. Got ${JSON.stringify(j)}`);
      assert.strictEqual(j.reason, fx.expectedOutcome, `${fx.file}: reason. Got ${JSON.stringify(j)}`);
    });
  }
});
