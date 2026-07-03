// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression guard for #1759: the --no-input flag was removed from Claude Code
 * >= v2.1.81 and causes an immediate crash ("error: unknown option '--no-input'").
 *
 * The -p / --print flag already handles non-interactive output so --no-input
 * must never appear in workflow, command, or agent files.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Recursively collect all .md files under a directory. */
function collectMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

const SCAN_DIRS = [
  path.join(ROOT, 'gsd-core', 'workflows'),
  path.join(ROOT, 'gsd-core', 'references'),
  path.join(ROOT, 'commands', 'gsd'),
  path.join(ROOT, 'agents'),
];

describe('workflow CLI compatibility (#1759)', () => {
  test('no workflow/command/agent file uses the deprecated --no-input flag', () => {
    const violations = [];

    for (const dir of SCAN_DIRS) {
      for (const file of collectMdFiles(dir)) {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes('--no-input')) {
          const rel = path.relative(ROOT, file);
          violations.push(rel);
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      [
        '--no-input was removed in Claude Code >= v2.1.81 and must not appear in any workflow/command/agent file.',
        'Use -p / --print instead (already implies non-interactive output).',
        'Violations found:',
        ...violations.map(v => '  ' + v),
      ].join('\n')
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-41-ship-tdd-audit-gate-status.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-41-ship-tdd-audit-gate-status (consolidation epic #1969 B8 #1977)", () => {
'use strict';

// feat(#41): /gsd-ship generate_pr_body emits a TDD Audit table + an aggregate
// `gate_status:` trailer so the per-commit TDD gate trail survives squash-merge.
// These assertions pin the shipped workflow prose in gsd-core/workflows/ship.md.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('feat-41: ship.md TDD Audit gate_status extraction', () => {
  const workflow = readRepoFile('gsd-core/workflows/ship.md');

  test('adds a "## TDD Audit" section to the generated PR body', () => {
    assert.match(workflow, /## TDD Audit/);
  });

  test('extracts gate_status via Git native trailer machinery, not a raw body grep', () => {
    assert.match(workflow, /trailers:key=gate_status/);
  });

  test('scopes the scan to the merge-base..HEAD range', () => {
    assert.match(workflow, /merge-base/);
    assert.match(workflow, /\.\.HEAD/);
    assert.match(workflow, /BASE_BRANCH/);
  });

  test('excludes merge commits from the audit', () => {
    assert.match(workflow, /--no-merges/);
  });

  test('renders a Test commit / Impl commit / gate_status table', () => {
    assert.match(workflow, /Test commit[\s\S]*Impl commit[\s\S]*gate_status/);
  });

  test('pairs conventional-commit test: rows with their impl commit', () => {
    assert.match(workflow, /test:/);
    assert.match(workflow, /pair/i);
  });

  test('escapes pipe characters in commit subjects so the table is not broken', () => {
    assert.match(workflow, /[Ee]scape[\s\S]{0,60}\|/);
  });

  test('counts commits lacking a recognized gate_status trailer as missing', () => {
    assert.match(workflow, /missing/);
  });

  test('is informational and never blocks the ship', () => {
    assert.match(workflow, /informational|never block|non-blocking/i);
  });

  test('emits the aggregate trailer in the exact, stable key order', () => {
    assert.match(
      workflow,
      /gate_status:\s*skill=[^,]*,\s*fallback=[^,]*,\s*exempt=[^,]*,\s*missing=/,
    );
  });

  test('places the aggregate trailer on the final line so squash-merge carries it', () => {
    assert.match(workflow, /squash/i);
    assert.match(workflow, /final line|last line/i);
  });

  test('does not disturb the frozen #3167 core section order (Key Decisions precedes the new section)', () => {
    assert.match(workflow, /## Key Decisions[\s\S]*## TDD Audit/);
  });

  // Hardening assertions added after adversarial review.

  test('pairs test: rows only with feat:/fix: impl commits, skipping refactor/docs/chore', () => {
    assert.match(workflow, /feat:[\s\S]{0,20}fix:/);
    assert.match(workflow, /skipping[\s\S]{0,80}(refactor|docs|chore)/i);
  });

  test('normalizes the gate_status cell to a known token, never raw trailer text', () => {
    assert.match(workflow, /normaliz[a-z]*[\s\S]{0,120}missing/i);
    assert.match(workflow, /never the raw/i);
  });

  test('treats a commit with multiple gate_status trailers as missing', () => {
    assert.match(workflow, /more than one[\s\S]{0,40}gate_status/i);
  });

  test('hardens every table cell against pipe/newline injection', () => {
    assert.match(workflow, /strip[\s\S]{0,20}\\r/);
  });

  test('guards record/field delimiters against adversarial commit messages', () => {
    assert.match(workflow, /NUL|%x00|delimiter/i);
  });
});
  });
}
