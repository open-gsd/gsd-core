/**
 * Regression tests for bugs #2045 and #2046
 *
 * #2046 (macOS/Linux): The three .sh hooks (gsd-validate-commit.sh,
 * gsd-session-state.sh, gsd-phase-boundary.sh) were registered in
 * settings.json with RELATIVE paths (bash .claude/hooks/...) for local
 * installs, causing "No such file or directory" when Claude Code's cwd
 * is not the project root.
 *
 * #2045 (Windows): The same three .sh hooks were registered WITHOUT quotes
 * around the path, so usernames with spaces (e.g. C:/Users/First Last/)
 * break bash invocation with a syntax error.
 *
 * Root cause: buildHookCommand() only handled .js files. The .sh hooks were
 * built via manual string concatenation without quoting, and local installs
 * used localPrefix (.claude/...) instead of the $CLAUDE_PROJECT_DIR-anchored
 * form that .js local hooks use.
 *
 * Fix: extend buildHookCommand() to handle .sh files (uses 'bash' instead of
 * 'node') so that all paths go through the same quoted-path construction.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');

// buildHookCommand was extracted to gsd-core/bin/lib/runtime-hooks-surface.cjs
// (ADR-857 phase 5f-1) and re-exported via install.js.  Import through install.js
// so the test exercises the same public surface that the rest of the codebase uses.
const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { buildHookCommand } = INSTALL;

const SH_HOOKS = [
  { name: 'gsd-validate-commit.sh', commandVar: 'validateCommitCommand' },
  { name: 'gsd-session-state.sh',   commandVar: 'sessionStateCommand' },
  { name: 'gsd-phase-boundary.sh',  commandVar: 'phaseBoundaryCommand' },
];

// Use a fixed configDir that is unambiguously absolute so the assertions below
// are not accidentally satisfied by a relative path in the output.
const TEST_CONFIG_DIR = '/test-home/.claude';
// Force a non-Windows platform so resolveBashRunner reliably returns 'bash'
// (Windows candidates need filesystem probing; platform:linux is hermetic).
const HOOK_OPTS = { platform: 'linux', runtime: 'claude' };

describe('bugs #2045 #2046: .sh hook paths must be absolute and quoted', () => {
  let src;

  try {
    src = fs.readFileSync(INSTALL_SRC, 'utf-8');
  } catch {
    src = '';
  }

  // ── Test 1: buildHookCommand supports .sh files (BEHAVIORAL) ─────────────
  describe('buildHookCommand', () => {
    test('returns a bash command for .sh hookName', () => {
      // Behavioral: call the exported function and assert on the returned string.
      // buildHookCommand was extracted to runtime-hooks-surface.cjs; source-grep
      // on install.js no longer works (the wrapper body just delegates).
      assert.equal(typeof buildHookCommand, 'function',
        'buildHookCommand must be exported from install.js');

      const cmd = buildHookCommand(TEST_CONFIG_DIR, 'gsd-validate-commit.sh', HOOK_OPTS);
      assert.ok(typeof cmd === 'string' && cmd.length > 0,
        'buildHookCommand must return a non-empty string for .sh hooks');

      assert.ok(
        cmd.includes('bash'),
        'buildHookCommand must use "bash" as the runner for .sh hooks. ' +
        `Got: ${cmd}`
      );
    });

    test('buildHookCommand produces bash runner for .sh and node runner for .js', () => {
      assert.equal(typeof buildHookCommand, 'function',
        'buildHookCommand must be exported from install.js');

      // .sh hook must contain "bash"
      const shCmd = buildHookCommand(TEST_CONFIG_DIR, 'gsd-validate-commit.sh', HOOK_OPTS);
      assert.ok(
        typeof shCmd === 'string' && shCmd.includes('bash'),
        'buildHookCommand must produce a "bash" command for .sh hooks. ' +
        `Got: ${shCmd}`
      );

      // .js hook must contain "node" (absolute path will include the word "node")
      const jsCmd = buildHookCommand(TEST_CONFIG_DIR, 'gsd-something.js', HOOK_OPTS);
      assert.ok(
        typeof jsCmd === 'string' && jsCmd.includes('node'),
        'buildHookCommand must produce a "node" command for .js hooks. ' +
        `Got: ${jsCmd}`
      );

      // Non-vacuousness guard: the two commands must be DIFFERENT so that if
      // buildHookCommand stops branching on .sh the test actually fails.
      assert.notEqual(
        shCmd.split('"')[0], // runner token before the first quoted path
        jsCmd.split('"')[0],
        'buildHookCommand must use different runners for .sh vs .js hooks'
      );
    });
  });

  // ── Test 2: each .sh command variable uses a quoted path ─────────────────
  for (const { name, commandVar } of SH_HOOKS) {
    describe(`${name} command`, () => {
      test(`${commandVar} uses double-quoted path (fixes #2045 Windows spaces)`, () => {
        const varIdx = src.indexOf(commandVar);
        assert.ok(varIdx !== -1, `${commandVar} not found in install.js`);

        // Extract the assignment block (~300 chars should cover a single declaration)
        const blockEnd = Math.min(src.length, varIdx + 400);
        const block = src.slice(varIdx, blockEnd);

        // The command string for the global branch must contain a quoted path:
        // bash "..." — the path must be wrapped in double quotes.
        assert.ok(
          block.includes('bash "') || block.includes("bash '") || block.includes('buildHookCommand'),
          `${commandVar} must use buildHookCommand() (which quotes the path) or manually ` +
          `quote the path. Found: ${block.slice(0, 200)}`
        );
      });

      test(`${commandVar} does not use bare localPrefix without quoting (fixes #2046 relative path)`, () => {
        const varIdx = src.indexOf(commandVar);
        assert.ok(varIdx !== -1, `${commandVar} not found in install.js`);

        const blockEnd = Math.min(src.length, varIdx + 400);
        const block = src.slice(varIdx, blockEnd);

        // The old bad pattern was: 'bash ' + localPrefix + '/hooks/...'
        // where localPrefix === '.claude' (relative, no quotes).
        // The fix routes through buildHookCommand which emits bash "absolutePath".
        // So the raw string '.claude/hooks' must NOT appear unquoted in this block.
        const hasBareRelativePath = /bash ['"]?\.claude\/hooks/.test(block);
        assert.ok(
          !hasBareRelativePath,
          `${commandVar} must not use a bare relative path ".claude/hooks". ` +
          `Use buildHookCommand() so the path is absolute and quoted.`
        );
      });
    });
  }

  // ── Test 3: global .sh hooks must not use unquoted manual concatenation ───
  test('global .sh hook commands use buildHookCommand, not unquoted string concat', () => {
    // Old bad pattern for global installs:
    //   'bash ' + targetDir.replace(/\\/g, '/') + '/hooks/gsd-*.sh'
    // This left the absolute path unquoted, breaking paths with spaces (#2045).
    // The fix routes all global .sh hooks through buildHookCommand() which
    // wraps the path in double quotes: bash "/absolute/path/hooks/gsd-*.sh"
    const oldGlobalPattern = /'bash ' \+ targetDir/g;
    const globalMatches = src.match(oldGlobalPattern) || [];

    assert.strictEqual(
      globalMatches.length, 0,
      `Found ${globalMatches.length} occurrence(s) of unquoted global .sh path construction ` +
      `('bash ' + targetDir). Use buildHookCommand(targetDir, 'gsd-*.sh') instead.`
    );
  });

  // ── Test 4: global .sh hook commands contain double-quoted absolute paths ─
  test('global .sh hook commands in source use bash with double-quoted path', () => {
    // After the fix, buildHookCommand produces: bash "/abs/path/hooks/gsd-*.sh"
    // Verify each hook's command variable is assigned via buildHookCommand for the global branch.
    for (const { commandVar } of SH_HOOKS) {
      const varIdx = src.indexOf(commandVar);
      assert.ok(varIdx !== -1, `${commandVar} not found in install.js`);

      // The ternary assignment: const xCommand = isGlobal ? buildHookCommand(...) : ...
      const blockEnd = Math.min(src.length, varIdx + 300);
      const block = src.slice(varIdx, blockEnd);

      assert.ok(
        block.includes('buildHookCommand'),
        `${commandVar} global branch must use buildHookCommand() to produce a quoted absolute path. ` +
        `Found: ${block.slice(0, 150)}`
      );
    }
  });
});
