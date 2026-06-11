/**
 * Regression tests for bug #1817
 *
 * The installer must NOT register .sh hook entries in settings.json when the
 * corresponding .sh file does not exist at the target path. The original bug:
 * v1.32.0's npm package omitted the .sh files from hooks/dist/, so the copy
 * step produced no files, yet the registration step ran unconditionally —
 * leaving users with hook errors on every tool invocation.
 *
 * Defensive guard: before registering each .sh hook in settings.json,
 * install.js must verify the target file exists. If it doesn't, skip
 * registration and emit a warning.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
// ADR-857 phase 5f-1b: settings-json hook registration moved to runtime-hooks-surface.cts.
const HOOKS_SURFACE_SRC = path.join(__dirname, '..', 'src', 'runtime-hooks-surface.cts');

const SH_HOOKS = [
  { name: 'gsd-validate-commit.sh', settingsVar: 'validateCommitCommand' },
  { name: 'gsd-session-state.sh',   settingsVar: 'sessionStateCommand' },
  { name: 'gsd-phase-boundary.sh',  settingsVar: 'phaseBoundaryCommand' },
];

describe('bug #1817: .sh hook registration guards', () => {
  let src;

  // Read once — all tests in this suite share the same source snapshot.
  // ADR-857 phase 5f-1b: hook registration moved to runtime-hooks-surface.cts.
  // Concatenate both sources so structural assertions find patterns in either file.
  try {
    const installSrc = fs.readFileSync(INSTALL_SRC, 'utf-8');
    let hooksSurfaceSrc = '';
    try { hooksSurfaceSrc = fs.readFileSync(HOOKS_SURFACE_SRC, 'utf-8'); } catch { /* ok */ }
    src = installSrc + '\n' + hooksSurfaceSrc;
  } catch {
    src = '';
  }

  for (const { name, settingsVar } of SH_HOOKS) {
    describe(`${name} registration`, () => {
      test(`install.js checks file existence before registering ${name}`, () => {
        // Find the block where this .sh hook is registered.
        // Each registration block is preceded by the command variable declaration
        // and followed by the next hook or end of registration section.
        const varIdx = src.indexOf(settingsVar);
        assert.ok(varIdx !== -1, `${settingsVar} variable not found in install.js`);

        // Extract ~900 chars around the variable to find the registration block
        const blockStart = Math.max(0, varIdx - 50);
        const blockEnd = Math.min(src.length, varIdx + 900);
        const block = src.slice(blockStart, blockEnd);

        assert.ok(
          block.includes('fs.existsSync') || block.includes('existsSync'),
          `install.js must call fs.existsSync on the target path before registering ${name} in settings.json. ` +
          `Without this guard, hooks are registered even when the .sh file was never copied ` +
          `(the root cause of #1817).`
        );
      });
    });
  }
});
