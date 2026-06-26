'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #130: finishInstall calls configureOpencodePermissions unconditionally,
 * violating the GSD_TEST_MODE side-effect-free contract.
 *
 * configureOpencodePermissions does fs.mkdirSync + fs.writeFileSync, which
 * must NOT run under GSD_TEST_MODE='1'. This test asserts that the opencode
 * config file (opencode.json) is NOT created when GSD_TEST_MODE is set.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// Point HOME at a temp dir so configureOpencodePermissions can't write to
// the real ~/.config/opencode/ even if the guard is missing.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-130-test-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

// The opencode config dir that configureOpencodePermissions would use for a
// global install when configDir=null: <HOME>/.config/opencode/
// The file it writes is opencode.json (or opencode.jsonc if pre-existing).
const OPENCODE_CONFIG_DIR = path.join(FAKE_HOME, '.config', 'opencode');
const OPENCODE_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');

// configDir is passed explicitly so the function targets our FAKE_HOME dir
// regardless of how getGlobalDir resolves.
const installModule = require(path.join(ROOT, 'bin', 'install.js'));

const SETTINGS_PATH = path.join(FAKE_HOME, `gsd-test-settings-${process.pid}.json`);

function callFinishInstall() {
  const original = console.log;
  console.log = () => {};
  try {
    installModule.finishInstall(
      SETTINGS_PATH,
      {},
      null,
      false,
      'opencode',
      true,
      OPENCODE_CONFIG_DIR, // pass explicit configDir pointing at our temp dir
    );
  } finally {
    console.log = original;
  }
}

describe('Bug #130: finishInstall opencode + GSD_TEST_MODE side-effect guard', () => {
  test('configureOpencodePermissions does NOT write opencode.json under GSD_TEST_MODE', () => {
    // Confirm the file does not exist before the call
    assert.equal(
      fs.existsSync(OPENCODE_CONFIG_FILE),
      false,
      'opencode.json should not exist before finishInstall call',
    );

    callFinishInstall();

    // Assert the file was NOT created — the side-effect must be suppressed
    assert.equal(
      fs.existsSync(OPENCODE_CONFIG_FILE),
      false,
      `opencode.json must NOT be created under GSD_TEST_MODE; found at ${OPENCODE_CONFIG_FILE}`,
    );
  });
});
