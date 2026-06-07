'use strict';
// Regression guard for bug #783.
//
// getGlobalSkillsBase('kilo') was returning ~/.config/kilo/skills (the XDG
// config dir) instead of ~/.kilo/skills — where Kilo Code actually discovers
// global skills per its docs:
//   https://kilo.ai/docs/customize/skills
//   "Global skills are located in the `.kilo` directory within your Home
//    directory: ~/.kilo/skills/"
//
// The fix adds a special case in getGlobalSkillsBase() that resolves kilo's
// skills dir from HOME (not from the XDG config dir). The config dir at
// ~/.config/kilo is still CORRECT for commands (command/) and must stay
// unchanged — this test verifies both roles are separate.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const {
  getGlobalConfigDir,
  getGlobalSkillsBase,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));

// Helper: temporarily override env vars for a test, restoring them afterwards.
function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key] of Object.entries(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// Clear all kilo-relevant env vars so tests are hermetic.
const kiloEnvClears = {
  KILO_CONFIG_DIR: undefined,
  XDG_CONFIG_HOME: undefined,
};

describe('bug #783: kilo global skills dir is ~/.kilo/skills, not ~/.config/kilo/skills', () => {
  test('getGlobalSkillsBase("kilo") resolves to ~/.kilo/skills', () => {
    withEnv(kiloEnvClears, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });

  test('getGlobalConfigDir("kilo") still resolves to ~/.config/kilo (config dir unchanged)', () => {
    withEnv(kiloEnvClears, () => {
      assert.strictEqual(
        getGlobalConfigDir('kilo'),
        path.join(os.homedir(), '.config', 'kilo'),
      );
    });
  });

  test('kilo skills dir and config dir are decoupled (not equal, not nested)', () => {
    withEnv(kiloEnvClears, () => {
      const skillsBase = getGlobalSkillsBase('kilo');
      const configDir = getGlobalConfigDir('kilo');

      assert.notStrictEqual(skillsBase, configDir, 'skills dir must differ from config dir');
      assert.ok(
        !skillsBase.startsWith(configDir + path.sep),
        `skills dir (${skillsBase}) must not be nested under config dir (${configDir})`,
      );
      assert.ok(
        !configDir.startsWith(skillsBase + path.sep),
        `config dir (${configDir}) must not be nested under skills dir (${skillsBase})`,
      );
    });
  });

  test('getGlobalSkillsBase("kilo") is NOT affected by KILO_CONFIG_DIR override', () => {
    // Skills always live in ~/.kilo/skills regardless of XDG/config-dir overrides.
    withEnv({ KILO_CONFIG_DIR: '/tmp/custom-kilo-config', XDG_CONFIG_HOME: undefined }, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });

  test('getGlobalSkillsBase("kilo") is NOT affected by XDG_CONFIG_HOME override', () => {
    withEnv({ KILO_CONFIG_DIR: undefined, XDG_CONFIG_HOME: '/tmp/custom-xdg' }, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });
});
