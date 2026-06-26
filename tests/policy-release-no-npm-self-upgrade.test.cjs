'use strict';

// allow-test-rule: source-text-is-the-product
// Workflow YAML is a runtime contract; these assertions verify that the
// anti-pattern of runtime global npm self-upgrade never re-enters release lanes.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// Matches: npm install -g npm@..., npm i -g npm, npm install --global npm@11, etc.
// Does NOT match: npm ci, npm install (no -g / --global followed by npm)
const NPM_SELF_UPGRADE_RE = /\bnpm\s+(install|i)\s+(-g|--global)\b[^\r\n]*\bnpm(@|\b)/;

describe('policy: no runtime npm self-upgrade in release lanes (#318)', () => {
  const releaseFile = path.join(WORKFLOWS_DIR, 'release.yml');

  test('release.yml must not contain a runtime global npm self-upgrade step', () => {
    const content = fs.readFileSync(releaseFile, 'utf8');
    const lines = content.split(/\r?\n/);
    const violations = lines
      .map((line, idx) => ({ line, lineNo: idx + 1 }))
      .filter(({ line }) => NPM_SELF_UPGRADE_RE.test(line));

    assert.strictEqual(
      violations.length,
      0,
      `release.yml contains ${violations.length} runtime npm self-upgrade line(s) — ` +
        `remove them and rely on Node 24 bundled npm (pinned via setup-node). ` +
        `Violations: ${violations.map(({ lineNo, line }) => `line ${lineNo}: ${line.trim()}`).join('; ')}`
    );
  });

  test('NPM_SELF_UPGRADE_RE correctly matches the antipattern', () => {
    // Positive cases — must match
    assert.ok(NPM_SELF_UPGRADE_RE.test('npm install -g npm@latest'), 'should match npm install -g npm@latest');
    assert.ok(NPM_SELF_UPGRADE_RE.test('npm i -g npm'), 'should match npm i -g npm');
    assert.ok(NPM_SELF_UPGRADE_RE.test('npm install --global npm@11'), 'should match npm install --global npm@11');
    assert.ok(NPM_SELF_UPGRADE_RE.test('  run: npm install -g npm@latest'), 'should match indented run step');

    // Negative cases — must NOT match
    assert.ok(!NPM_SELF_UPGRADE_RE.test('npm ci'), 'should not match npm ci');
    assert.ok(!NPM_SELF_UPGRADE_RE.test('npm install'), 'should not match plain npm install');
    assert.ok(!NPM_SELF_UPGRADE_RE.test('npm install -g some-other-tool'), 'should not match -g some-other-tool');
    assert.ok(!NPM_SELF_UPGRADE_RE.test('npm run build'), 'should not match npm run');
  });
});
