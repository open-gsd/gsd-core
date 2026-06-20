/**
 * Regression test for #1736: local Claude install missing commands/gsd/
 *
 * After a fresh local install (`--claude --local`), all /gsd-* commands
 * except /gsd-help return "Unknown skill: gsd-quick" because
 * .claude/commands/gsd/ was not populated. Claude Code reads local project
 * commands from .claude/commands/ (one level up) using the file stem as the
 * command name.
 *
 * #1367 follow-up: the fix changed the layout from the old commands/gsd/<cmd>.md
 * (which caused /gsd:<cmd> colon namespace) to flat commands/gsd-<cmd>.md
 * (which produces /gsd-<cmd> hyphen form). This test has been updated to assert
 * the new flat layout while preserving the core invariant from #1736: commands
 * must be present and usable after a local install.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────
// With --test-concurrency=4, other install tests (bug-1834, bug-1924) run
// build-hooks.js concurrently. That script creates hooks/dist/ empty first,
// then copies files — creating a window where this test sees an empty dir and
// install() fails with "directory is empty" → process.exit(1).

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── #1736 + #1367: local install deploys commands in flat gsd-<cmd>.md layout ───

describe('#1736: local Claude install deploys slash commands (flat gsd-<cmd>.md layout, #1367)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-local-install-1736-'));
  });

  afterEach(() => {
    // Use the shared helper which has a 5s Windows-EBUSY retry budget
    // (20×250ms). The inline 1s budget here was insufficient on cold runners.
    cleanup(tmpDir);
  });

  test('local install creates .claude/commands/ directory with flat gsd-*.md files (#1367)', (t) => {
    // #1736 invariant: commands must be deployed.
    // #1367 fix: commands land as flat gsd-<cmd>.md at commands/ (not commands/gsd/<cmd>.md).
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(
      fs.existsSync(commandsDir),
      '.claude/commands/ directory must exist after local install'
    );
    const flatFiles = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(
      flatFiles.length > 0,
      `.claude/commands/ must have flat gsd-*.md files (e.g. gsd-help.md). Found: ${JSON.stringify(flatFiles)}`
    );
    // The old commands/gsd/ subdirectory must NOT exist (#1367)
    const oldSubdir = path.join(commandsDir, 'gsd');
    assert.ok(
      !fs.existsSync(oldSubdir),
      '.claude/commands/gsd/ subdir must NOT exist — flat gsd-<cmd>.md layout required (#1367)'
    );
  });

  test('local install deploys at least one .md command file to .claude/commands/ (#1736 invariant)', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(
      fs.existsSync(commandsDir),
      '.claude/commands/ must exist'
    );

    const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(
      files.length > 0,
      `.claude/commands/ must contain at least one gsd-*.md file, found: ${JSON.stringify(files)}`
    );
  });

  test('local install deploys gsd-quick.md to .claude/commands/ (#1367: flat hyphen form)', (t) => {
    // Was: .claude/commands/gsd/quick.md (caused /gsd:quick colon form).
    // Now: .claude/commands/gsd-quick.md (produces /gsd-quick hyphen form).
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const quickCmd = path.join(tmpDir, '.claude', 'commands', 'gsd-quick.md');
    assert.ok(
      fs.existsSync(quickCmd),
      '.claude/commands/gsd-quick.md must exist after local install (#1367 flat layout)'
    );
  });
});
