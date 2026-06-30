// #69 regression: applySurface must NOT re-flatten the nested skill layout
//
// Bug: stageSkillsForRuntimeAsSkills gated nesting on `resolvedProfile.skills === '*'`
// (the sentinel). applySurface → resolveSurface materializes the full profile into a
// concrete Set<string>, so the sentinel check was never true on the surface path.
// Result: applySurface called kind.stage(resolved) → stageSkillsForRuntimeAsSkills with
// a concrete Set → doNest = false → flat layout, overwriting the nested install.
//
// Fix (install-profiles.cts): gate nesting on full OR full-equivalent (all routerStems
// present in the concrete Set) so that the surface path preserves nesting.
//
// NOTE: As of #924 Claude has been REVERTED to FLAT. This test now uses Cline as the
// representative nested runtime. The original claude-global test below is updated to
// assert the flat layout (>= 60 top-level gsd-* entries, concrete skills discoverable).

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const COMMANDS_GSD = path.join(ROOT, 'commands', 'gsd');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const { applySurface } = require('../gsd-core/bin/lib/surface.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { cleanup } = require('./helpers.cjs');

describe('issue-69: applySurface preserves nested skill layout (no re-flatten)', () => {
  // #924: Claude is now flat; use Cline as the representative nested runtime.
  test('cline global full: applySurface keeps 6 router dirs and nested gsd-ns-manage/skills/help/SKILL.md', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-69-surface-'));
    t.after(() => { try { cleanup(tmpDir); } catch { /* best-effort */ } });

    // Step 1: full install
    const manifest = loadSkillsManifest(COMMANDS_GSD);
    const resolved = resolveProfile({ modes: ['full'], manifest });
    installRuntimeArtifacts('cline', tmpDir, 'global', resolved);

    const skillsDir = path.join(tmpDir, 'skills');

    // Sanity: install must produce nested layout (6 top-level router dirs)
    const topLevelAfterInstall = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.strictEqual(
      topLevelAfterInstall.length,
      6,
      `Install must produce exactly 6 gsd-* top-level dirs (routers). Got ${topLevelAfterInstall.length}: [${topLevelAfterInstall.join(', ')}]`,
    );
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-ns-workflow', 'skills', 'plan-phase', 'SKILL.md')),
      'After install: gsd-ns-workflow/skills/plan-phase/SKILL.md must exist',
    );

    // Step 2: applySurface (full surface, no surface state file → resolves to full)
    const layout = resolveRuntimeArtifactLayout('cline', tmpDir, 'global');
    applySurface(tmpDir, layout, manifest);

    // Step 3: assert nested layout is preserved after applySurface
    const topLevelAfterSurface = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.strictEqual(
      topLevelAfterSurface.length,
      6,
      `After applySurface: expected exactly 6 gsd-* top-level dirs (routers only). Got ${topLevelAfterSurface.length}: [${topLevelAfterSurface.join(', ')}]. ` +
      'Re-flattening detected: applySurface must preserve nested layout (#69 regression).',
    );

    // The nested SKILL.md must still exist (not re-flattened to top-level concrete dir)
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-ns-workflow', 'skills', 'plan-phase', 'SKILL.md')),
      'After applySurface: gsd-ns-workflow/skills/plan-phase/SKILL.md must still exist (nested layout preserved)',
    );

    // The concrete skill must NOT have been promoted to a top-level flat dir
    assert.ok(
      !fs.existsSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md')),
      'After applySurface: gsd-plan-phase/ must NOT exist at top level (#69 re-flatten regression guard)',
    );
  });

  // #924 companion: Claude must use FLAT layout and applySurface must NOT re-nest it.
  test('claude global full: install produces flat layout and applySurface preserves it (#924)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-924-69-'));
    t.after(() => { try { cleanup(tmpDir); } catch { /* best-effort */ } });

    const manifest = loadSkillsManifest(COMMANDS_GSD);
    const resolved = resolveProfile({ modes: ['full'], manifest });
    installRuntimeArtifacts('claude', tmpDir, 'global', resolved);

    const skillsDir = path.join(tmpDir, 'skills');

    // Install must produce FLAT layout (>= 60 gsd-* dirs)
    const topLevelAfterInstall = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevelAfterInstall.length >= 60,
      `Claude install must produce >= 60 gsd-* top-level dirs (flat, #924). Got ${topLevelAfterInstall.length}.`,
    );

    // gsd-plan-phase must be directly at top level
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md')),
      'After claude install: gsd-plan-phase/SKILL.md must be at top level (flat layout, #924)',
    );

    // No nested skills/ subdirs under gsd-ns-* in Claude
    assert.ok(
      !fs.existsSync(path.join(skillsDir, 'gsd-ns-workflow', 'skills')),
      'After claude install: gsd-ns-workflow/skills/ must NOT exist (flat layout, no nesting, #924)',
    );

    // applySurface must preserve flat layout
    const layout = resolveRuntimeArtifactLayout('claude', tmpDir, 'global');
    applySurface(tmpDir, layout, manifest);

    const topLevelAfterSurface = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevelAfterSurface.length >= 60,
      `After applySurface: claude must still have >= 60 gsd-* dirs (flat preserved). Got ${topLevelAfterSurface.length}.`,
    );

    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md')),
      'After applySurface: gsd-plan-phase/SKILL.md must remain at top level (#924)',
    );
  });
});
