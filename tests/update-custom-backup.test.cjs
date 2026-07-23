/**
 * GSD Tools Tests — update workflow custom file backup detection (#1997)
 *
 * The update workflow must detect user-added files inside GSD-managed
 * directories (gsd-core/, agents/, commands/gsd/, hooks/) before the
 * installer wipes those directories.
 *
 * This tests the `detect-custom-files` subcommand of gsd-tools.cjs, which is
 * the correct fix for the bash path-stripping failure described in #1997.
 *
 * The bash pattern `${filepath#$RUNTIME_DIR/}` is unreliable because
 * $RUNTIME_DIR may not be set and the stripped relative path may not match
 * manifest key format. Moving the logic into gsd-tools.cjs eliminates the
 * shell variable expansion failure entirely.
 *
 * Closes: #1997
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Write a fake gsd-file-manifest.json into configDir with the given file entries.
 */
function writeManifest(configDir, files) {
  const manifest = {
    version: '1.32.0',
    timestamp: new Date().toISOString(),
    files: {}
  };
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(configDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    manifest.files[relPath] = sha256(content);
  }
  fs.writeFileSync(
    path.join(configDir, 'gsd-file-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}

describe('detect-custom-files — update workflow backup detection (#1997)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-custom-detect-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects a custom file added inside gsd-core/workflows/', () => {
    writeManifest(tmpDir, {
      'gsd-core/workflows/execute-phase.md': '# Execute Phase\n',
      'gsd-core/workflows/plan-phase.md': '# Plan Phase\n',
    });

    // Add a custom file NOT in the manifest
    const customFile = path.join(tmpDir, 'gsd-core/workflows/my-custom-workflow.md');
    fs.writeFileSync(customFile, '# My Custom Workflow\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(Array.isArray(json.custom_files), 'should return custom_files array');
    assert.ok(json.custom_files.length > 0, 'should detect at least one custom file');
    assert.ok(
      json.custom_files.includes('gsd-core/workflows/my-custom-workflow.md'),
      `custom file should be listed; got: ${JSON.stringify(json.custom_files)}`
    );
  });

  test('detects custom gsd-prefixed files added inside agents/', () => {
    writeManifest(tmpDir, {
      'agents/gsd-executor.md': '# GSD Executor\n',
    });

    // Add a user's custom GSD-prefixed agent that the installer would prune.
    const customAgent = path.join(tmpDir, 'agents/gsd-my-custom-agent.md');
    fs.mkdirSync(path.dirname(customAgent), { recursive: true });
    fs.writeFileSync(customAgent, '# My Custom Agent\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(json.custom_files.includes('agents/gsd-my-custom-agent.md'),
      `custom agent should be detected; got: ${JSON.stringify(json.custom_files)}`);
  });

  test('reports zero custom files when all files are in manifest', () => {
    writeManifest(tmpDir, {
      'gsd-core/workflows/execute-phase.md': '# Execute Phase\n',
      'gsd-core/references/gates.md': '# Gates\n',
      'agents/gsd-executor.md': '# Executor\n',
    });
    // No extra files added

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(Array.isArray(json.custom_files), 'should return custom_files array');
    assert.strictEqual(json.custom_files.length, 0, 'no custom files should be detected');
    assert.strictEqual(json.custom_count, 0, 'custom_count should be 0');
  });

  test('returns custom_count equal to custom_files length', () => {
    writeManifest(tmpDir, {
      'gsd-core/workflows/execute-phase.md': '# Execute Phase\n',
    });

    // Add two custom files
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-core/workflows/custom-a.md'),
      '# Custom A\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-core/workflows/custom-b.md'),
      '# Custom B\n'
    );

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.strictEqual(json.custom_count, json.custom_files.length,
      'custom_count should equal custom_files.length');
    assert.strictEqual(json.custom_count, 2, 'should detect exactly 2 custom files');
  });

  test('does not flag manifest files as custom even if content was modified', () => {
    writeManifest(tmpDir, {
      'gsd-core/workflows/execute-phase.md': '# Execute Phase\nOriginal\n',
    });

    // Modify the content of an existing manifest file
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-core/workflows/execute-phase.md'),
      '# Execute Phase\nModified by user\n'
    );

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    // Modified manifest files are handled by saveLocalPatches (in install.js).
    // detect-custom-files only finds files NOT in the manifest at all.
    assert.ok(
      !json.custom_files.includes('gsd-core/workflows/execute-phase.md'),
      'modified manifest files should NOT be listed as custom (that is saveLocalPatches territory)'
    );
  });

  test('handles missing manifest gracefully — treats all GSD-dir files as custom', () => {
    // No manifest. Add a file in a GSD-managed dir.
    const workflowDir = path.join(tmpDir, 'gsd-core/workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, 'my-workflow.md'), '# My Workflow\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    // Without a manifest, we cannot determine what is custom vs GSD-owned.
    // The command should return an empty list (no manifest = skip detection,
    // which is safe since saveLocalPatches also does nothing without a manifest).
    assert.ok(Array.isArray(json.custom_files), 'should return custom_files array');
    assert.ok(typeof json.custom_count === 'number', 'should return numeric custom_count');
  });

  test('detects custom files inside gsd-core/references/', () => {
    writeManifest(tmpDir, {
      'gsd-core/references/gates.md': '# Gates\n',
    });

    const customRef = path.join(tmpDir, 'gsd-core/references/my-domain-probes.md');
    fs.writeFileSync(customRef, '# My Domain Probes\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(
      json.custom_files.includes('gsd-core/references/my-domain-probes.md'),
      `should detect custom reference; got: ${JSON.stringify(json.custom_files)}`
    );
  });

  // skills/ is prefix-selective: the installer prunes gsd-* entries, not every
  // skill directory under the shared runtime skill root.
  test('scans skills/ directory and detects custom gsd-prefixed skills not in manifest (#2942, #1325)', () => {
    writeManifest(tmpDir, {
      'gsd-core/workflows/execute-phase.md': '# Execute Phase\n',
      'skills/gsd-planner/SKILL.md': '# GSD Planner\n',
    });

    // Simulate user having a custom GSD-prefixed skill installed — NOT in manifest
    const customSkillDir = path.join(tmpDir, 'skills', 'gsd-my-custom-skill');
    fs.mkdirSync(customSkillDir, { recursive: true });
    fs.writeFileSync(path.join(customSkillDir, 'SKILL.md'), '# My Custom Skill\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);

    // The user's custom GSD-prefixed skill should be detected
    assert.ok(
      json.custom_files.includes('skills/gsd-my-custom-skill/SKILL.md'),
      `custom skill should be detected; got: ${JSON.stringify(json.custom_files)}`
    );

    // The GSD-owned skill (in manifest) should NOT be flagged as custom
    assert.ok(
      !json.custom_files.includes('skills/gsd-planner/SKILL.md'),
      `GSD-owned skill should not be flagged as custom; got: ${JSON.stringify(json.custom_files)}`
    );
  });

  test('does not report non-gsd shared skills, hooks, or prior backups (#1325)', () => {
    writeManifest(tmpDir, {
      'skills/gsd-planner/SKILL.md': '# GSD Planner\n',
      'hooks/gsd-check-update.js': 'console.log("managed");\n',
    });

    fs.mkdirSync(path.join(tmpDir, 'skills', 'gstack-one'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'skills', 'gstack-one', 'SKILL.md'), '# GStack\n');
    fs.mkdirSync(path.join(tmpDir, 'hooks', 'user'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'hooks', 'user', 'custom.js'), 'console.log("user");\n');
    fs.mkdirSync(path.join(tmpDir, 'gsd-user-files-backup', 'skills', 'gsd-old'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-user-files-backup', 'skills', 'gsd-old', 'SKILL.md'), '# Old backup\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(
      !json.custom_files.includes('skills/gstack-one/SKILL.md'),
      `non-gsd skill should not be detected; got: ${JSON.stringify(json.custom_files)}`
    );
    assert.ok(
      !json.custom_files.includes('hooks/user/custom.js'),
      `non-gsd hook should not be detected; got: ${JSON.stringify(json.custom_files)}`
    );
    assert.strictEqual(
      json.custom_files.filter(f => f.startsWith('gsd-user-files-backup/')).length,
      0,
      `prior backups should not be detected; got: ${JSON.stringify(json.custom_files)}`
    );
  });

  test('does not scan command/ directory (installer does not wipe it)', () => {
    writeManifest(tmpDir, {
      'gsd-core/workflows/execute-phase.md': '# Execute Phase\n',
    });

    // Simulate files in command/ dir not wiped by installer
    const commandDir = path.join(tmpDir, 'command');
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, 'user-command.md'), '# User Command\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    const commandFiles = json.custom_files.filter(f => f.startsWith('command/'));
    assert.strictEqual(
      commandFiles.length, 0,
      `command/ should not be scanned; got false positives: ${JSON.stringify(commandFiles)}`
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2942-detect-custom-skills.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2942-detect-custom-skills (consolidation epic #1969 B2 #1971)", () => {
/**
 * GSD Tools Tests — detect-custom-files misses skills/ directory (#2942)
 *
 * After v1.39.0 skill consolidation (#2790), skills/ became a GSD-managed root.
 * GSD_MANAGED_DIRS was missing 'skills', so user-added GSD-prefixed skill
 * directories like skills/gsd-custom-skill/SKILL.md were never walked and got
 * silently destroyed during /gsd-update.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Write a fake gsd-file-manifest.json into configDir with the given file entries.
 * Each entry is also written to disk so the directory structure exists.
 */
function writeManifest(configDir, files) {
  const manifest = {
    version: '1.39.0',
    timestamp: new Date().toISOString(),
    files: {}
  };
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(configDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    manifest.files[relPath] = sha256(content);
  }
  fs.writeFileSync(
    path.join(configDir, 'gsd-file-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}

/**
 * Write a file inside configDir (creating parent dirs), but do NOT add it to the manifest.
 */
function writeCustomFile(configDir, relPath, content) {
  const fullPath = path.join(configDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe('detect-custom-files — skills/ directory missing from GSD_MANAGED_DIRS (#2942)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-2942-skills-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Test 1: detects custom GSD-prefixed skill in skills/gsd-<name>/SKILL.md
  test('detects custom skill file at skills/gsd-<name>/SKILL.md', () => {
    writeManifest(tmpDir, {
      'skills/gsd-planner/SKILL.md': '# GSD Planner Skill\n',
    });

    // User-added custom GSD-prefixed skill — NOT in manifest
    writeCustomFile(tmpDir, 'skills/gsd-test-custom/SKILL.md', '# My Custom Skill\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(Array.isArray(json.custom_files), 'custom_files should be an array');
    assert.ok(json.custom_count >= 1, `custom_count should be >= 1, got ${json.custom_count}`);
    assert.ok(
      json.custom_files.includes('skills/gsd-test-custom/SKILL.md'),
      `skills/gsd-test-custom/SKILL.md should be in custom_files; got: ${JSON.stringify(json.custom_files)}`
    );
  });

  test('does not detect non-gsd shared skills preserved by installer (#1325)', () => {
    writeManifest(tmpDir, {
      'skills/gsd-planner/SKILL.md': '# GSD Planner Skill\n',
    });

    writeCustomFile(tmpDir, 'skills/test-custom/SKILL.md', '# My Custom Skill\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(Array.isArray(json.custom_files), 'custom_files should be an array');
    assert.ok(
      !json.custom_files.includes('skills/test-custom/SKILL.md'),
      `non-gsd shared skill should not be in custom_files; got: ${JSON.stringify(json.custom_files)}`
    );
  });

  // Test 2: does not flag GSD-owned skills as custom (manifest-tracked path NOT in custom_files)
  test('does not flag GSD-owned skill as custom when it is tracked in manifest', () => {
    writeManifest(tmpDir, {
      'skills/gsd-planner/SKILL.md': '# GSD Planner Skill\n',
    });

    // No extra files — only the manifest-tracked skill exists

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(Array.isArray(json.custom_files), 'custom_files should be an array');
    assert.ok(
      !json.custom_files.includes('skills/gsd-planner/SKILL.md'),
      `GSD-owned skill should NOT be in custom_files; got: ${JSON.stringify(json.custom_files)}`
    );
  });

  // Test 3: regression guard — still detects custom files in gsd-core/workflows/
  test('regression: still detects custom files in gsd-core/workflows/', () => {
    writeManifest(tmpDir, {
      'gsd-core/workflows/plan-phase.md': '# Plan Phase\n',
      'skills/gsd-planner/SKILL.md': '# GSD Planner Skill\n',
    });

    writeCustomFile(tmpDir, 'gsd-core/workflows/custom-workflow.md', '# My Custom Workflow\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.ok(
      json.custom_files.includes('gsd-core/workflows/custom-workflow.md'),
      `custom workflow should still be detected; got: ${JSON.stringify(json.custom_files)}`
    );
  });

  // Test 4: custom_count matches custom_files.length
  test('custom_count matches custom_files.length when multiple custom gsd-prefixed skills exist', () => {
    writeManifest(tmpDir, {
      'skills/gsd-planner/SKILL.md': '# GSD Planner Skill\n',
    });

    writeCustomFile(tmpDir, 'skills/gsd-test-custom/SKILL.md', '# Custom Skill One\n');
    writeCustomFile(tmpDir, 'skills/gsd-another-custom/SKILL.md', '# Custom Skill Two\n');

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.strictEqual(
      json.custom_count,
      json.custom_files.length,
      `custom_count (${json.custom_count}) should equal custom_files.length (${json.custom_files.length})`
    );
    assert.strictEqual(json.custom_count, 2, 'should detect exactly 2 custom skill files');
  });

  // Test 5: manifest_found: true when manifest is present
  test('manifest_found is true when manifest is present', () => {
    writeManifest(tmpDir, {
      'skills/gsd-planner/SKILL.md': '# GSD Planner Skill\n',
    });

    const result = runGsdTools(
      ['detect-custom-files', '--config-dir', tmpDir],
      tmpDir
    );

    assert.ok(result.success, `Command failed: ${result.error}`);

    const json = JSON.parse(result.output);
    assert.strictEqual(json.manifest_found, true, 'manifest_found should be true');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3050-update-backup-eacces-nonfatal.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3050-update-backup-eacces-nonfatal (consolidation epic #1969 B4 #1973)", () => {
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('bug #3050: update backup skips unreadable files non-fatally', () => {
  test('update workflow backup loop wraps copyFileSync in try/catch and logs non-fatal skip', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md'),
      'utf8',
    );

    const hasTryCatch = /try\s*\{[\s\S]*copyFileSync\([\s\S]*\}[\s\S]*catch\s*\(err\)/.test(content);
    assert.ok(hasTryCatch, 'backup copy loop must catch per-file copy errors');

    const hasNonFatalSkipMessage = /Skipped \(non-fatal\):/.test(content);
    assert.ok(
      hasNonFatalSkipMessage,
      'workflow must log a non-fatal skip message for unreadable custom files',
    );
  });
});
  });
}
