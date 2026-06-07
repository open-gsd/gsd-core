// allow-test-rule: structural-regression-guard
// Reads hook .js or bin/install.js source to assert structural invariants
// (search array order, function wiring, path constants) that cannot be
// verified by observing runtime outputs alone. Per CONTRIBUTING.md exception matrix.

/**
 * Regression guard for #1767: gsd-workflow-guard.js must be registered in settings.json
 *
 * The hook file is built, copied, and installed — but was never registered as a
 * PreToolUse hook entry in install.js. This test ensures the registration block
 * exists with the correct structure.
 *
 * Also tests the broader anti-pattern: every hook in gsdHooks that is a JS
 * PreToolUse/PostToolUse hook should have a corresponding registration block.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');

describe('workflow-guard hook registration (#1767)', () => {
  test('install.js constructs a command path variable for gsd-workflow-guard.js', () => {
    const content = fs.readFileSync(INSTALL_JS, 'utf-8');
    const lines = content.split('\n');
    // Every registered JS hook has a command variable constructed via
    // buildHookCommand() or string concatenation. Filter out references
    // that are only in the cleanup/uninstall arrays.
    const commandConstructionLines = lines.filter(line =>
      line.includes('gsd-workflow-guard.js') &&
      (line.includes('buildHookCommand') || line.includes("'node '"))
    );
    assert.ok(
      commandConstructionLines.length > 0,
      [
        'install.js must construct a command path for gsd-workflow-guard.js',
        '(e.g. buildHookCommand or node + dirName pattern).',
        'Currently only referenced in gsdHooks cleanup array.',
      ].join(' ')
    );
  });

  test('install.js has a hasWorkflowGuardHook dedup check', () => {
    const content = fs.readFileSync(INSTALL_JS, 'utf-8');
    // Every registered hook has a dedup check: hasXxxHook = settings.hooks[...].some(...)
    const hasDedup = content.includes('hasWorkflowGuardHook') ||
      content.includes('hasWorkflowGuard');
    assert.ok(
      hasDedup,
      'install.js must have a dedup check variable for workflow-guard (like hasPromptGuardHook)'
    );
  });

  test('install.js pushes workflow-guard entry with correct matcher', () => {
    const content = fs.readFileSync(INSTALL_JS, 'utf-8');
    // Extract the workflow-guard registration section. It should install the
    // Bash-aware matcher and upgrade old edit-only entries on reinstall.
    const workflowGuardSection = content.match(
      /workflowGuardCommand[\s\S]*?Configure commit validation hook/i
    );
    assert.ok(
      workflowGuardSection,
      'install.js must have a push block for workflow-guard with a console.log confirmation'
    );
    assert.ok(
      workflowGuardSection[0].includes("const workflowGuardMatcher = 'Bash|Edit|Write|MultiEdit'") &&
        workflowGuardSection[0].includes('matcher: workflowGuardMatcher'),
      'workflow guard must be registered for Bash so worktree-agent git safety checks can run'
    );
    assert.ok(
      workflowGuardSection[0].includes('workflowGuardHookEntry.matcher = workflowGuardMatcher'),
      'installer must upgrade existing workflow guard hook entries to the Bash-aware matcher'
    );
  });
});

describe('hook registration completeness anti-pattern guard', () => {
  test('every JS hook in gsdHooks has a command construction in install.js', () => {
    const content = fs.readFileSync(INSTALL_JS, 'utf-8');
    // Use the typed export instead of source-grep regex (branch #455: retire source-grep)
    const { GSD_UNINSTALL_HOOKS } = require('../bin/install.js');
    assert.ok(Array.isArray(GSD_UNINSTALL_HOOKS), 'GSD_UNINSTALL_HOOKS must be exported from install.js');

    const jsHooks = GSD_UNINSTALL_HOOKS.filter(h => h.endsWith('.js'));

    const missing = [];
    for (const hook of jsHooks) {
      // Each JS hook should have a buildHookCommand or 'node ' command construction
      // that references the hook filename (not just the gsdHooks array or uninstall filter)
      const lines = content.split('\n').filter(line =>
        line.includes(hook) &&
        (line.includes('buildHookCommand') || line.includes("'node '"))
      );
      if (lines.length === 0) {
        missing.push(hook);
      }
    }

    assert.strictEqual(
      missing.length, 0,
      [
        'Every JS hook in gsdHooks must have a command construction in install.js.',
        'Missing registration for:',
        ...missing.map(h => `  - ${h}`),
      ].join('\n')
    );
  });
});
