'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const projection = require(path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'lib',
  'shell-command-projection.cjs',
));
const install = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { withIsolatedProcessState, cleanup } = require('./helpers.cjs');

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-home-3441-'));
}


describe('bug #3441: PATH guidance is projected from typed shell action IR', () => {
  test('projection module exports PATH action projection helper', () => {
    assert.equal(typeof projection.projectPathActionProjection, 'function');
  });

  // (formatSdkPathDiagnostic removed with the gsd-sdk shim, #191 — the PATH
  // action projection it wrapped is still covered by the tests below.)

  test('persistent PATH export guidance is projected via the same seam', () => {
    const posix = projection.projectPathActionProjection({
      mode: 'persist',
      targetDir: '/tmp/with quote',
      platform: 'linux',
    });
    assert.ok(Array.isArray(posix.shellActions));
    assert.equal(posix.shellActions.length, 3);
    assert.equal(posix.shellActions[0].label, 'zsh');
    assert.equal(posix.shellActions[1].label, 'bash');
    assert.equal(posix.shellActions[2].label, 'fish');
    assert.ok(posix.shellActions[0].command.includes('~/.zshrc'));
    assert.ok(posix.shellActions[1].command.includes('~/.bashrc'));
    // #323: fish gets a fish-native fish_add_path suggestion, not `export`.
    assert.ok(posix.shellActions[2].command.startsWith('fish_add_path '));
    assert.ok(!posix.shellActions[2].command.includes('export'));
  });

  test('POSIX repair mode escapes double-quoted shell metacharacters', () => {
    const projected = projection.projectPathActionProjection({
      mode: 'repair',
      targetDir: '/tmp/qa\\"$HOME`tick',
      platform: 'linux',
    });
    assert.equal(projected.shellActions.length, 1);
    assert.equal(
      projected.shellActions[0].command,
      'export PATH="/tmp/qa\\\\\\"\\$HOME\\`tick:$PATH"',
    );
  });

  test('POSIX persist mode escapes single quotes for rc-file echo commands', () => {
    const projected = projection.projectPathActionProjection({
      mode: 'persist',
      targetDir: "/tmp/O'Neil/bin",
      platform: 'linux',
    });
    assert.equal(projected.shellActions[0].command.includes("/tmp/O'\\''Neil/bin"), true);
    assert.equal(projected.shellActions[1].command.includes("/tmp/O'\\''Neil/bin"), true);
    // #323: fish entry single-quotes the dir with the same POSIX literal
    // escaping (`'\''` is also a valid escaped quote in fish unquoted context).
    assert.equal(projected.shellActions[2].command, "fish_add_path '/tmp/O'\\''Neil/bin'");
  });

  test('maybeSuggestPathExport renders commands projected by path-action seam', () => {
    const home = createTempHome();
    try {
      withIsolatedProcessState(() => {
        const globalBin = path.join(home, '.npm-global', 'bin');
        fs.mkdirSync(globalBin, { recursive: true });
        fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH="$HOME/.cargo/bin:$PATH"\n');
        process.env.PATH = '';

        const expected = projection.projectPathActionProjection({
          mode: 'persist',
          targetDir: globalBin,
          platform: process.platform,
        });

        const logs = [];
        const originalLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        try {
          install.maybeSuggestPathExport(globalBin, home);
        } finally {
          console.log = originalLog;
        }

        const joined = logs.join('\n');
        for (const action of expected.shellActions) {
          assert.ok(
            joined.includes(action.command),
            `expected installer output to include projected command: ${action.command}\nOutput:\n${joined}`,
          );
        }
      });
    } finally {
      cleanup(home);
    }
  });
});
