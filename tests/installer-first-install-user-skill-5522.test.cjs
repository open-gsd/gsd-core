'use strict';

/**
 * #5522: a first install reported a user's skill as "preserved" while the same
 * install replaced it.
 *
 * The first-time baseline migration records a pre-existing file as
 * `baseline-preserve-user`, and the installer printed "preserved … user baseline
 * file". But a user skill that has the name of a shipped GSD skill
 * (`skills/gsd-help/SKILL.md`) is then overwritten by the install's own staging,
 * with no copy kept — the report and the disk disagreed, and the user's content
 * was gone. The install now backs the replaced file up to `gsd-local-patches/`
 * (the same place an update puts a locally modified file), records it in
 * `backup-meta.json`, and the report names the replacement instead of claiming
 * the file was preserved.
 *
 * These tests spawn the real installer against a sandboxed HOME/--config-dir.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const installScript = path.join(__dirname, '..', 'bin', 'install.js');

function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the leading byte of ANSI SGR sequences; stripping them is the purpose
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function runFirstInstall(targetDir) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  env.HOME = path.join(path.dirname(targetDir), 'home');
  env.USERPROFILE = env.HOME;
  env.GSD_HOME = env.HOME;
  return runNode(
    [installScript, '--claude', '--global', '--config-dir', targetDir, '--no-sdk'],
    { env, timeoutMs: INSTALL_TIMEOUT_MS }
  );
}

function seed(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

describe('#5522 first install does not silently replace a user skill that has a shipped name', () => {
  let root;
  let targetDir;
  const USER_SKILL = '---\nname: gsd-help\n---\nMY OWN HELP SKILL — written by the user\n';

  beforeEach(() => {
    root = createTempDir('gsd-5522-');
    targetDir = path.join(root, 'cfg');
    fs.mkdirSync(targetDir, { recursive: true });
  });
  afterEach(() => cleanup(root));

  test('the replaced user skill is backed up to gsd-local-patches and recorded', () => {
    seed(targetDir, 'skills/gsd-help/SKILL.md', USER_SKILL);
    const result = runFirstInstall(targetDir);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);

    const backup = path.join(targetDir, 'gsd-local-patches', 'skills', 'gsd-help', 'SKILL.md');
    assert.ok(fs.existsSync(backup), 'the user skill must be kept under gsd-local-patches/');
    assert.equal(fs.readFileSync(backup, 'utf8'), USER_SKILL);

    const meta = JSON.parse(
      fs.readFileSync(path.join(targetDir, 'gsd-local-patches', 'backup-meta.json'), 'utf8')
    );
    assert.ok(
      JSON.stringify(meta.files).includes('skills/gsd-help/SKILL.md'),
      'backup-meta.json must list the backed-up file'
    );

    // The shipped skill is what is installed now.
    const installed = fs.readFileSync(path.join(targetDir, 'skills', 'gsd-help', 'SKILL.md'), 'utf8');
    assert.notEqual(installed, USER_SKILL);
  });

  test('the report names the replacement and does not claim the file was preserved', () => {
    seed(targetDir, 'skills/gsd-help/SKILL.md', USER_SKILL);
    const result = runFirstInstall(targetDir);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const out = stripAnsi(`${result.stdout}\n${result.stderr}`);

    const claimsPreserved = out
      .split('\n')
      .filter((l) => /preserved/i.test(l) && l.includes('skills/gsd-help/SKILL.md'));
    assert.deepEqual(claimsPreserved, [], 'must not report the replaced file as preserved');
    assert.match(
      out,
      /skills\/gsd-help\/SKILL\.md[^\n]*replaced[^\n]*gsd-local-patches\/skills\/gsd-help\/SKILL\.md/,
      'must say the file was replaced and where the copy is'
    );
  });

  test('a user skill whose name is not shipped is left untouched and still reported preserved', () => {
    seed(targetDir, 'skills/my-own-skill/SKILL.md', 'mine\n');
    const result = runFirstInstall(targetDir);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(targetDir, 'skills', 'my-own-skill', 'SKILL.md'), 'utf8'),
      'mine\n'
    );
    assert.ok(
      !fs.existsSync(path.join(targetDir, 'gsd-local-patches', 'skills', 'my-own-skill')),
      'an untouched file needs no backup'
    );
  });

  test('a gsd-prefixed user skill the install does not replace leaves no backup behind', () => {
    seed(targetDir, 'skills/gsd-my-private-skill/SKILL.md', 'mine\n');
    const result = runFirstInstall(targetDir);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(targetDir, 'skills', 'gsd-my-private-skill', 'SKILL.md'), 'utf8'),
      'mine\n'
    );
    assert.ok(
      !fs.existsSync(path.join(targetDir, 'gsd-local-patches', 'skills', 'gsd-my-private-skill')),
      'the pre-install copy of a file that survived must be removed'
    );
  });

  test('an existing gsd-local-patches backup is never overwritten or deleted', () => {
    seed(targetDir, 'gsd-local-patches/skills/gsd-help/SKILL.md', 'OLDBACKUP\n');
    seed(targetDir, 'gsd-local-patches/skills/gsd-mine/SKILL.md', 'OLDMINE\n');
    seed(targetDir, 'gsd-local-patches/backup-meta.json', JSON.stringify({ from_version: '1.0.0', files: ['skills/gsd-mine/SKILL.md'], pristine_hashes: {} }));
    seed(targetDir, 'skills/gsd-help/SKILL.md', USER_SKILL);
    seed(targetDir, 'skills/gsd-mine/SKILL.md', 'survives\n');
    const result = runFirstInstall(targetDir);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const patches = path.join(targetDir, 'gsd-local-patches');
    assert.equal(fs.readFileSync(path.join(patches, 'skills', 'gsd-help', 'SKILL.md'), 'utf8'), 'OLDBACKUP\n');
    assert.equal(fs.readFileSync(path.join(patches, 'skills', 'gsd-mine', 'SKILL.md'), 'utf8'), 'OLDMINE\n');
    assert.equal(fs.readFileSync(path.join(patches, 'skills', 'gsd-help', 'SKILL.md.first-install'), 'utf8'), USER_SKILL);
    const meta = JSON.parse(fs.readFileSync(path.join(patches, 'backup-meta.json'), 'utf8'));
    assert.ok(meta.files.includes('skills/gsd-mine/SKILL.md'));
    assert.ok(meta.files.includes('skills/gsd-help/SKILL.md.first-install'));
  });

  test('a replaced file too large to copy aside is warned about, not silently lost', () => {
    seed(targetDir, 'skills/gsd-help/SKILL.md', 'x'.repeat(1024 * 1024 + 10));
    const result = runFirstInstall(targetDir);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(stripAnsi(`${result.stdout}\n${result.stderr}`), /skills\/gsd-help\/SKILL\.md is larger than/);
  });

  test('the installer-internal staging dir is gone after the install', () => {
    seed(targetDir, 'skills/gsd-help/SKILL.md', USER_SKILL);
    runFirstInstall(targetDir);
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-migration-backups', 'first-install-5522')));
  });
});
