/**
 * commit_docs bypass guard tests (#1783)
 *
 * When users set commit_docs: false during /gsd-new-project, .planning/
 * files should never be staged or committed. The gsd-tools.cjs commit
 * wrapper already checks this flag, but three locations in execute-phase.md
 * and quick.md used raw `git add .planning/` commands that bypassed it.
 *
 * These tests verify that every `git add .planning/` invocation (explicit
 * or via file_list) is preceded by a commit_docs config check.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXECUTE_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const QUICK_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

describe('commit_docs bypass guard (#1783)', () => {

  test('execute-phase.md: every git add .planning/ has a commit_docs guard', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (/git add\b.*\.planning\//.test(lines[i])) {
        // Search backwards from this line for a config-get commit_docs check
        const windowStart = Math.max(0, i - 10);
        const window = lines.slice(windowStart, i).join('\n');
        assert.ok(
          window.includes('config-get commit_docs'),
          `git add .planning/ at line ${i + 1} in execute-phase.md must be guarded by a commit_docs config check`
        );
      }
    }
  });

  test('quick.md: every git add .planning/ has a commit_docs guard', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (/git add\b.*\.planning\//.test(lines[i])) {
        const windowStart = Math.max(0, i - 10);
        const window = lines.slice(windowStart, i).join('\n');
        assert.ok(
          window.includes('config-get commit_docs'),
          `git add .planning/ at line ${i + 1} in quick.md must be guarded by a commit_docs config check`
        );
      }
    }
  });

  test('quick.md: git add ${file_list} has a commit_docs guard for .planning/ filtering', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);

    // Find the line(s) that do `git add ${file_list}` — this variable
    // includes .planning/STATE.md so it needs a commit_docs guard too
    for (let i = 0; i < lines.length; i++) {
      if (/git add\s+\$\{?file_list/.test(lines[i])) {
        const windowStart = Math.max(0, i - 10);
        const window = lines.slice(windowStart, i + 1).join('\n');
        assert.ok(
          window.includes('config-get commit_docs'),
          `git add \${file_list} at line ${i + 1} in quick.md must be guarded by a commit_docs check ` +
          `because file_list includes .planning/ files`
        );
      }
    }
  });

  test('no raw git add .planning/ without commit_docs guard in any workflow', () => {
    const workflows = [
      { name: 'execute-phase.md', path: EXECUTE_PHASE_PATH },
      { name: 'quick.md', path: QUICK_PATH },
    ];

    for (const wf of workflows) {
      const content = fs.readFileSync(wf.path, 'utf-8');

      // Find all occurrences of git add that reference .planning/
      const regex = /git add\b[^\r\n]*\.planning\//g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        // Get the 500-char window before this match
        const before = content.slice(Math.max(0, match.index - 500), match.index);
        assert.ok(
          before.includes('config-get commit_docs'),
          `${wf.name}: found unguarded git add .planning/ near offset ${match.index}. ` +
          `All raw git add .planning/ commands must check commit_docs config first.`
        );
      }
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2399-commit-docs-plan-phase.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2399-commit-docs-plan-phase (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2399)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #2399: commit_docs:true is ignored in plan-phase
 *
 * The plan-phase workflow generates plan artifacts but never commits them even
 * when commit_docs is true. A step between 13b and 14 must commit the PLAN.md
 * files and updated STATE.md when commit_docs is set.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');

describe('plan-phase commit_docs support (#2399)', () => {
  test('plan-phase.md exists', () => {
    assert.ok(fs.existsSync(PLAN_PHASE_PATH), 'gsd-core/workflows/plan-phase.md must exist');
  });

  test('plan-phase.md has a commit step for plan artifacts', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // Must contain a commit call that references PLAN.md files
    assert.ok(
      content.includes('PLAN.md') && content.includes('commit'),
      'plan-phase.md must include a commit step that references PLAN.md files'
    );
  });

  test('plan-phase.md commit step is gated on commit_docs', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // The commit step must be conditional on commit_docs
    assert.ok(
      content.includes('commit_docs'),
      'plan-phase.md must reference commit_docs to gate the plan commit step'
    );
  });

  test('plan-phase.md commit step references STATE.md', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // Should commit STATE.md alongside PLAN.md files
    assert.ok(
      content.includes('STATE.md'),
      'plan-phase.md commit step should include STATE.md to capture planning completion state'
    );
  });

  test('plan-phase.md has a step 13c that commits plan artifacts', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    const step13b = content.indexOf('## 13b.');
    const step14 = content.indexOf('## 14.');
    // Look for the step 13c section (or any commit step between 13b and 14)
    const step13c = content.indexOf('## 13c.');

    assert.ok(step13b !== -1, '## 13b. section must exist');
    assert.ok(step14 !== -1, '## 14. section must exist');
    assert.ok(step13c !== -1, '## 13c. step must exist (commit plans step)');
    assert.ok(
      step13c > step13b && step13c < step14,
      `Step 13c (at ${step13c}) must appear between step 13b (at ${step13b}) and step 14 (at ${step14})`
    );
  });

  test('plan-phase.md uses gsd-sdk query commit for the plan commit', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // Must use gsd-sdk query commit (not raw git) so commit_docs guard in gsd-tools is respected
    assert.ok(
      content.includes('gsd-sdk query commit') || content.includes('gsd-tools') || content.includes('gsd-sdk'),
      'plan-phase.md plan commit step must use gsd-sdk query commit (not raw git commit)'
    );
  });
});
  });
}
