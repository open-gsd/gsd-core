// allow-test-rule: source-text-is-the-product #1367
// Installed command `.md` files — their on-disk path determines the slash-command
// namespace registered by Claude Code. Asserting the layout (flat vs. subdirectory)
// IS a behavioral test of the deploy contract, not source-grep theater.

/**
 * Regression for #1367 — project-local Claude Code install writes command files to
 * `.claude/commands/gsd/<cmd>.md` (subdirectory, bare names), causing Claude Code
 * to register them as `/gsd:<cmd>` (colon namespace). The fix changes the layout to
 * write flat `gsd-<cmd>.md` files at `.claude/commands/` level so Claude Code
 * registers `/gsd-<cmd>` (hyphen form, matching hooks, statusline, and cross-command
 * references everywhere in the framework).
 *
 * Root cause: `bin/install.js` (the `else` branch for claude local) wrote to a
 * `commands/gsd/` subdirectory using `copyWithPathReplacement`. Claude Code treats
 * the directory name as a namespace, so `commands/gsd/update.md` became `/gsd:update`.
 *
 * Fix: write each command as `gsd-<stem>.md` directly in `commands/` (flat layout).
 * This is the same approach used for OpenCode/Kilo (see `copyFlattenedCommands`).
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_PATH = path.join(REPO_ROOT, 'bin', 'install.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `node install.js --claude --local --no-sdk` in cwd.
 * GSD_TEST_MODE must be cleared so the install() main block executes.
 */
function runClaudeLocalInstall(cwd) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  execFileSync(process.execPath, [INSTALL_PATH, '--claude', '--local', '--no-sdk'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
}

// ---------------------------------------------------------------------------
// Suite — #1367 regression: flat gsd-<cmd>.md layout for claude local install
// ---------------------------------------------------------------------------

describe('bug #1367 — Claude local install uses flat gsd-<cmd>.md command layout', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1367-'));
    runClaudeLocalInstall(tmpDir);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('L0: commands/ directory exists after local claude install', () => {
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(
      fs.existsSync(commandsDir),
      `commands/ must be created by local claude install at ${commandsDir}`,
    );
  });

  test('L1: command files use flat gsd-<cmd>.md names (not bare names in a subdirectory)', () => {
    // The fix: commands land as .claude/commands/gsd-<cmd>.md (flat, hyphen-prefixed).
    // Claude Code reads the stem of each file in commands/ as the command name,
    // so gsd-update.md → /gsd-update (hyphen). The old layout (commands/gsd/update.md)
    // made Claude Code use the directory as a namespace → /gsd:update (colon).
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ must exist for this check to be meaningful');

    const flatGsdFiles = fs.readdirSync(commandsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.startsWith('gsd-') && e.name.endsWith('.md'));

    assert.ok(
      flatGsdFiles.length > 0,
      `commands/ must contain flat gsd-*.md files (e.g. gsd-help.md, gsd-update.md). ` +
      `Found none. Install may still be writing to commands/gsd/<cmd>.md subdirectory ` +
      `which causes /gsd:<cmd> colon namespace in Claude Code.`,
    );
  });

  test('L2: known commands land as flat gsd-<cmd>.md files', () => {
    // Spot-check: the three commands mentioned in the issue must be present
    // as flat hyphen-prefixed files.
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    const knownCommands = ['gsd-update.md', 'gsd-plan-phase.md', 'gsd-help.md'];
    for (const name of knownCommands) {
      const filePath = path.join(commandsDir, name);
      assert.ok(
        fs.existsSync(filePath),
        `${name} must exist as a flat file at commands/${name}. ` +
        `If missing, the flat layout is not being written correctly.`,
      );
    }
  });

  test('L3: commands/gsd/ subdirectory does NOT exist (old colon-namespace layout)', () => {
    // The old layout wrote to commands/gsd/<cmd>.md. That directory must not
    // exist after a fresh install with the fix applied.
    const oldSubdir = path.join(tmpDir, '.claude', 'commands', 'gsd');
    assert.ok(
      !fs.existsSync(oldSubdir),
      `commands/gsd/ subdir must NOT exist after install. ` +
      `Its presence means the old layout is still being used — Claude Code would ` +
      `register commands as /gsd:<cmd> (colon) instead of /gsd-<cmd> (hyphen).`,
    );
  });

  test('L4: total flat command file count matches the staged source', () => {
    // There should be a substantial number of commands (not 0, not 1).
    // The exact count varies with profile but must be >= 20 for a full install.
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    const count = fs.readdirSync(commandsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.startsWith('gsd-') && e.name.endsWith('.md'))
      .length;
    assert.ok(
      count >= 20,
      `commands/ must have >= 20 flat gsd-*.md files for a full install. ` +
      `Got ${count}. Install may be silently dropping commands.`,
    );
  });

  test('L5: legacy migration — re-install on a pre-#1367 tree removes old commands/gsd/ subdir', () => {
    // Simulate a pre-#1367 install: create a commands/gsd/ subdirectory with a bare-name file.
    // Then re-run the installer and verify the old subdir is cleaned up.
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    const legacyDir = path.join(commandsDir, 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'update.md'), '# legacy update');

    // Re-run install — should remove commands/gsd/ and write flat gsd-*.md
    runClaudeLocalInstall(tmpDir);

    assert.ok(
      !fs.existsSync(legacyDir),
      `commands/gsd/ legacy subdir must be removed by re-install. ` +
      `The installer's legacy cleanup must remove old commands/gsd/ on upgrade.`,
    );
    // Flat form must still be present
    assert.ok(
      fs.existsSync(path.join(commandsDir, 'gsd-update.md')),
      `gsd-update.md must exist as flat file after re-install.`,
    );
  });
});
