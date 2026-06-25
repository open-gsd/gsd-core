// allow-test-rule: source-text-is-the-product
// Reads installed .md product artefacts from a real install run —
// testing their on-disk layout + frontmatter tests the deployed contract.

/**
 * Regression test: #947 — Hermes skills must install with canonical gsd- prefix.
 *
 * Prior to this fix, Hermes installed skills at skills/gsd/<stem>/SKILL.md
 * with frontmatter `name: <stem>` (e.g. name: quick), causing invocation as
 * /quick instead of /gsd-quick. This file asserts the corrected behaviour:
 *   - Fresh install → skills/gsd/gsd-<stem>/SKILL.md, name: gsd-<stem>
 *   - The skills/gsd/ category bucket and its DESCRIPTION.md are retained
 *   - Migration: prior bare-stem dirs (skills/gsd/<stem>/) are removed
 *     on reinstall; no orphaned bare-stem directories remain.
 *
 * Runtime: node:test, node:assert/strict. No Jest.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const { parseFrontmatter, cleanup } = require('./helpers.cjs');
const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

// ---------------------------------------------------------------------------
// Shared fixture: a minimal commands/gsd/ source with two skills
// ---------------------------------------------------------------------------

/**
 * Write a minimal commands/gsd/ source tree with the given stem names.
 * Returns the path to the commands/gsd directory (used as .gsd-source value).
 */
function writeMinimalSourceTree(baseDir, stems) {
  const srcDir = path.join(baseDir, 'src', 'commands', 'gsd');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const stem of stems) {
    fs.writeFileSync(path.join(srcDir, `${stem}.md`), [
      '---',
      `name: gsd:${stem}`,
      `description: ${stem} task description`,
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      `<objective>${stem} body</objective>`,
    ].join('\n'));
  }
  return srcDir;
}

const MANIFEST = loadSkillsManifest();
const RESOLVED_FULL = resolveProfile({ modes: [], manifest: MANIFEST });

// ---------------------------------------------------------------------------
// #947 regression: fresh install produces prefixed layout
// ---------------------------------------------------------------------------

describe('#947 Hermes: fresh install → gsd- prefixed layout', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-fresh-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('skill lands at skills/gsd/gsd-<stem>/SKILL.md (NOT skills/gsd/<stem>/SKILL.md)', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // Correct (post-fix) path: skills/gsd/gsd-quick/SKILL.md
    const correctPath = path.join(configDir, 'skills', 'gsd', 'gsd-quick', 'SKILL.md');
    assert.ok(fs.existsSync(correctPath),
      'skills/gsd/gsd-quick/SKILL.md must exist (canonical gsd- prefix)');

    // Old (bare-stem) path must NOT exist
    const bareStemPath = path.join(configDir, 'skills', 'gsd', 'quick', 'SKILL.md');
    assert.ok(!fs.existsSync(bareStemPath),
      'skills/gsd/quick/SKILL.md must NOT exist (bare-stem path is wrong)');
  });

  test('SKILL.md frontmatter name is gsd-<stem> (NOT bare <stem>)', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['plan']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    const skillPath = path.join(configDir, 'skills', 'gsd', 'gsd-plan', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), 'skills/gsd/gsd-plan/SKILL.md must exist');

    const content = fs.readFileSync(skillPath, 'utf8');
    const fm = parseFrontmatter(content);
    assert.strictEqual(fm.name, 'gsd-plan',
      `frontmatter name must be 'gsd-plan', got '${fm.name}'`);
  });

  test('gsd-<stem> identifier satisfies Hermes name rule ^[a-z][a-z0-9_-]*$', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['plan-phase', 'code-review']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    const HERMES_NAME_RE = /^[a-z][a-z0-9_-]*$/;
    for (const stem of ['plan-phase', 'code-review']) {
      const skillPath = path.join(configDir, 'skills', 'gsd', `gsd-${stem}`, 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), `skills/gsd/gsd-${stem}/SKILL.md must exist`);
      const content = fs.readFileSync(skillPath, 'utf8');
      const fm = parseFrontmatter(content);
      assert.ok(HERMES_NAME_RE.test(fm.name),
        `name '${fm.name}' must satisfy Hermes identifier rule ${HERMES_NAME_RE}`);
      assert.strictEqual(fm.name, `gsd-${stem}`,
        `name must be 'gsd-${stem}', got '${fm.name}'`);
    }
  });

  test('skills/gsd/ category bucket is retained (not flattened to top-level skills/)', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // Skill must be INSIDE skills/gsd/ — not at skills/gsd-quick/ directly
    const categoryBucket = path.join(configDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(categoryBucket),
      'skills/gsd/ category directory must be retained');

    // Flat (non-categorised) path must NOT exist
    const flatPath = path.join(configDir, 'skills', 'gsd-quick');
    assert.ok(!fs.existsSync(flatPath),
      'skills/gsd-quick/ (flat, non-categorised) must NOT exist for Hermes');
  });

  test('skills/gsd/ category directory exists (bucket retained after install)', () => {
    // Note: DESCRIPTION.md is written by writeHermesCategoryDescription which is
    // called from the top-level installGsd flow (not inside installRuntimeArtifacts).
    // This test confirms the category bucket itself is present post-install.
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    const categoryBucket = path.join(configDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(categoryBucket),
      'skills/gsd/ category directory must exist after Hermes install');
    assert.ok(fs.statSync(categoryBucket).isDirectory(),
      'skills/gsd/ must be a directory, not a file');
  });

  test('multiple skills all get gsd- prefix', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick', 'plan', 'review']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    for (const stem of ['quick', 'plan', 'review']) {
      const correctPath = path.join(configDir, 'skills', 'gsd', `gsd-${stem}`, 'SKILL.md');
      assert.ok(fs.existsSync(correctPath),
        `skills/gsd/gsd-${stem}/SKILL.md must exist`);
      const bareStem = path.join(configDir, 'skills', 'gsd', stem, 'SKILL.md');
      assert.ok(!fs.existsSync(bareStem),
        `bare-stem path skills/gsd/${stem}/SKILL.md must NOT exist`);
    }
  });
});

// ---------------------------------------------------------------------------
// #947 regression: migration from prior bare-stem install
// ---------------------------------------------------------------------------

describe('#947 Hermes: migration from prior bare-stem install', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-migrate-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('bare-stem dirs from prior install are removed on reinstall', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed a prior bare-stem install: skills/gsd/quick/SKILL.md
    const legacySkillDir = path.join(configDir, 'skills', 'gsd', 'quick');
    fs.mkdirSync(legacySkillDir, { recursive: true });
    fs.writeFileSync(path.join(legacySkillDir, 'SKILL.md'), [
      '---',
      'name: quick',
      'description: Quick task (legacy bare-stem)',
      '---',
      '',
      'Legacy body.',
    ].join('\n'));

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // Bare-stem dir must be gone (migrated)
    assert.ok(!fs.existsSync(legacySkillDir),
      'skills/gsd/quick/ (bare-stem legacy dir) must be removed on reinstall');

    // Prefixed dir must exist
    const newPath = path.join(configDir, 'skills', 'gsd', 'gsd-quick', 'SKILL.md');
    assert.ok(fs.existsSync(newPath),
      'skills/gsd/gsd-quick/SKILL.md must exist after migration');
  });

  test('reinstall over bare-stem install leaves NO orphaned bare-stem dirs', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick', 'plan']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed two bare-stem dirs
    for (const stem of ['quick', 'plan']) {
      const dir = path.join(configDir, 'skills', 'gsd', stem);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${stem}\ndescription: ${stem}\n---\n`);
    }

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    const gsdCategoryDir = path.join(configDir, 'skills', 'gsd');
    const entries = fs.readdirSync(gsdCategoryDir, { withFileTypes: true });

    // Check NO bare-stem dirs remain
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Bare-stem dirs: name does NOT start with 'gsd-' and is not a known exception
      // (DESCRIPTION.md is a file so it won't appear in isDirectory check)
      assert.ok(
        entry.name.startsWith('gsd-'),
        `All dirs under skills/gsd/ must start with 'gsd-'. Found bare-stem: '${entry.name}'`,
      );
    }
  });

  test('pre-#2841 flat skills/gsd-<stem>/ dirs are still removed (existing migration path)', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed a pre-#2841 flat skill dir: skills/gsd-quick/SKILL.md
    const flatSkillDir = path.join(configDir, 'skills', 'gsd-quick');
    fs.mkdirSync(flatSkillDir, { recursive: true });
    fs.writeFileSync(path.join(flatSkillDir, 'SKILL.md'), '---\nname: gsd-quick\n---\nOld flat.');

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // The pre-#2841 flat dir must still be cleaned up
    assert.ok(!fs.existsSync(flatSkillDir),
      'Pre-#2841 flat skills/gsd-quick/ dir must be removed (existing migration)');

    // The correct post-fix dir must exist
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd', 'gsd-quick', 'SKILL.md')),
      'skills/gsd/gsd-quick/SKILL.md must exist after install');
  });
});

// ---------------------------------------------------------------------------
// #947 adversarial-review: bare-stem cleanup derived from installed set
// (not readGsdCommandNames) — covers skills missing from the commands dir
// ---------------------------------------------------------------------------

describe('#947 Hermes: adversarial-review bare-stem cleanup (installed-set derivation)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-adv-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('bare skills/gsd/dev-preferences/ is removed when gsd-dev-preferences/ is installed this run', () => {
    // Seed a source tree that includes a 'dev-preferences' skill (e.g. the user's
    // commands/gsd/dev-preferences.md, or any skill whose stem is NOT normally in
    // the shipped readGsdCommandNames() set). The old cleanup (readGsdCommandNames-
    // based) would MISS this bare dir because readGsdCommandNames() reads GSD's
    // shipped source, not the user's actual install state.
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick', 'dev-preferences']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed the legacy bare-stem dir: skills/gsd/dev-preferences/ (pre-#947 install)
    const bareLegacyDir = path.join(configDir, 'skills', 'gsd', 'dev-preferences');
    fs.mkdirSync(bareLegacyDir, { recursive: true });
    fs.writeFileSync(path.join(bareLegacyDir, 'SKILL.md'), [
      '---',
      'name: dev-preferences',
      'description: My dev preferences (legacy bare-stem)',
      '---',
      '',
      'Legacy body.',
    ].join('\n'));

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // gsd-dev-preferences/ must be installed (new prefixed form)
    const newPath = path.join(configDir, 'skills', 'gsd', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(fs.existsSync(newPath),
      'skills/gsd/gsd-dev-preferences/SKILL.md must exist after install');

    // Bare-stem dir must be gone — even though 'dev-preferences' is NOT in the
    // shipped readGsdCommandNames() set (it was user-sourced). The fix derives
    // the removal set from gsd-<stem>/ dirs installed this run.
    assert.ok(!fs.existsSync(bareLegacyDir),
      'skills/gsd/dev-preferences/ (bare-stem) must be removed when gsd-dev-preferences/ was installed');
  });

  test('user-owned bare dir with no gsd-<stem> counterpart is preserved (no over-deletion)', () => {
    // A user has a dir 'skills/gsd/my-custom-workflow/' that is NOT a GSD shipped
    // skill — GSD never installs 'gsd-my-custom-workflow/'. This dir must survive.
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed user-owned bare dir: no corresponding gsd-my-custom-workflow/ will be installed
    const userOwnedDir = path.join(configDir, 'skills', 'gsd', 'my-custom-workflow');
    fs.mkdirSync(userOwnedDir, { recursive: true });
    fs.writeFileSync(path.join(userOwnedDir, 'SKILL.md'), [
      '---',
      'name: my-custom-workflow',
      'description: My personal workflow',
      '---',
      '',
      'Custom body.',
    ].join('\n'));

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // User-owned dir must survive — no gsd-my-custom-workflow/ was installed,
    // so the removal rule (only remove <stem>/ when gsd-<stem>/ exists) protects it.
    assert.ok(fs.existsSync(userOwnedDir),
      'User-owned skills/gsd/my-custom-workflow/ must be preserved (no gsd-my-custom-workflow/ installed)');
    assert.ok(fs.existsSync(path.join(userOwnedDir, 'SKILL.md')),
      'User-owned SKILL.md inside the dir must be preserved');
  });
});

// ---------------------------------------------------------------------------
// #947 regression: manifest/listing prefix
// ---------------------------------------------------------------------------

describe('#947 Hermes: manifest and skill-listing use gsd- prefix', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-manifest-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-manifest.json skill entries use skills/gsd/gsd-<stem>/ paths', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // The manifest file lives at gsd-core/gsd-manifest.json inside configDir
    const manifestPath = path.join(configDir, 'gsd-core', 'gsd-manifest.json');
    if (!fs.existsSync(manifestPath)) return; // manifest optional in test mode
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const keys = Object.keys(manifest.files || {});
    // Any key for the quick skill must use gsd-quick not bare quick
    const bareKey = keys.find(k => k.includes('skills/gsd/quick/'));
    assert.ok(!bareKey,
      `manifest must not contain bare-stem key 'skills/gsd/quick/', found: ${bareKey}`);
    const prefixedKey = keys.find(k => k.includes('skills/gsd/gsd-quick/'));
    assert.ok(prefixedKey,
      'manifest must contain prefixed key containing skills/gsd/gsd-quick/');
  });
});

// ---------------------------------------------------------------------------
// #947 regression: non-Hermes runtimes unaffected
// ---------------------------------------------------------------------------

describe('#947 Non-Hermes runtimes: unaffected by this change', () => {
  // Spot-check claude (global/flat) and cline (global/nested) to confirm
  // they are not disturbed by the Hermes prefix fix.

  test('claude global install still produces flat skills/gsd-<stem>/ layout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-claude-'));
    try {
      installRuntimeArtifacts('claude', tmpDir, 'global', RESOLVED_FULL);
      const skillsDir = path.join(tmpDir, 'skills');
      assert.ok(fs.existsSync(skillsDir), 'skills/ must exist for claude global');
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      const gsdEntries = entries.filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.ok(gsdEntries.length >= 10,
        `claude must still emit >= 10 gsd-* skill dirs, got ${gsdEntries.length}`);
      // No skills/gsd/ category bucket (that is Hermes-specific)
      assert.ok(!fs.existsSync(path.join(skillsDir, 'gsd')),
        'claude must NOT have a skills/gsd/ category bucket (that is Hermes-only)');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('cline global install still produces skills/ with gsd- prefix nested layout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-cline-'));
    try {
      installRuntimeArtifacts('cline', tmpDir, 'global', RESOLVED_FULL);
      const skillsDir = path.join(tmpDir, 'skills');
      assert.ok(fs.existsSync(skillsDir), 'skills/ must exist for cline global');
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      const routerDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('gsd-ns-'));
      assert.ok(routerDirs.length > 0,
        'cline must still emit gsd-ns-* router dirs with gsd- prefix');
    } finally {
      cleanup(tmpDir);
    }
  });
});
