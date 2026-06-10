// allow-test-rule: source-text-is-the-product
// Reads installed SKILL.md files from a real install run —
// testing their on-disk layout tests the deployed contract.

/**
 * Regression test for bug #924.
 *
 * PR #883 accidentally nested concrete gsd-* skills 3 levels deep for the
 * Claude global install:
 *
 *   ~/.claude/skills/gsd-ns-<router>/skills/<stem>/SKILL.md
 *
 * Claude Code's skills discovery scans only ONE level under ~/.claude/skills/,
 * so nested concretes were never listed in the Skill-tool available-skills list.
 * Direct `Skill(skill="gsd-plan-phase")` calls stopped working.
 *
 * Fix: revert Claude to the FLAT layout — concrete skills at the top level:
 *
 *   ~/.claude/skills/gsd-<name>/SKILL.md
 *
 * The 6 ns-* routers are also top-level entries in the flat layout (they are
 * concrete skills themselves). No nested skills/ subdirs for Claude.
 *
 * Other 6 runtimes (cline, qwen, hermes, augment, trae, antigravity) stay nested.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const COMMANDS_GSD = path.join(ROOT, 'commands', 'gsd');

const { installRuntimeArtifacts } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');
const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');
const { applySurface } = require('../gsd-core/bin/lib/surface.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const MANIFEST = loadSkillsManifest(COMMANDS_GSD);
const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });

// ---------------------------------------------------------------------------
// #924 regression: Claude global install must use FLAT layout
// ---------------------------------------------------------------------------

describe('bug-924: claude global install uses flat skill layout (concrete skills discoverable)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-924-claude-flat-'));
    installRuntimeArtifacts('claude', tmpDir, 'global', RESOLVED_FULL);
  });

  after(() => {
    if (tmpDir) {
      try { cleanup(tmpDir); } catch { /* best-effort */ }
    }
  });

  test('claude global: concrete skills are at the TOP LEVEL of skills/ (flat, directly discoverable)', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), `skills/ dir must exist under ${tmpDir}`);

    const topLevel = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));

    // Flat layout must have MANY more than 6 top-level gsd-* entries (concrete skills).
    // Pre-#924-fix nested layout had exactly 6 (only routers). Flat must have >= 60.
    assert.ok(
      topLevel.length >= 60,
      `Claude global must have >= 60 gsd-* top-level skill dirs (concrete flat layout). ` +
      `Got ${topLevel.length}: [${topLevel.slice(0, 10).join(', ')}${topLevel.length > 10 ? ', …' : ''}]. ` +
      'Nested layout detected — #924 regression: Claude must be flat.',
    );
  });

  test('claude global: gsd-plan-phase is directly at the top level of skills/', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    const planPhaseDir = path.join(skillsDir, 'gsd-plan-phase');
    assert.ok(
      fs.existsSync(path.join(planPhaseDir, 'SKILL.md')),
      `skills/gsd-plan-phase/SKILL.md must exist at top level for Claude global install. ` +
      'Concrete skill buried in nested layout — #924 regression.',
    );
  });

  test('claude global: gsd-execute-phase is directly at the top level of skills/', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-execute-phase', 'SKILL.md')),
      `skills/gsd-execute-phase/SKILL.md must exist at top level for Claude global install.`,
    );
  });

  test('claude global: gsd-code-review is directly at the top level of skills/', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-code-review', 'SKILL.md')),
      `skills/gsd-code-review/SKILL.md must exist at top level for Claude global install.`,
    );
  });

  test('claude global: gsd-ns-workflow is at the top level as a concrete skill (no nested skills/ subdir)', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    const nsWorkflowDir = path.join(skillsDir, 'gsd-ns-workflow');
    assert.ok(
      fs.existsSync(path.join(nsWorkflowDir, 'SKILL.md')),
      `skills/gsd-ns-workflow/SKILL.md must exist at top level (router as concrete skill).`,
    );

    // In the FLAT layout, gsd-ns-workflow/ must NOT have a skills/ subdir.
    // A skills/ subdir means nested layout was applied (the #924 regression).
    assert.ok(
      !fs.existsSync(path.join(nsWorkflowDir, 'skills')),
      `skills/gsd-ns-workflow/skills/ must NOT exist in flat layout (nested layout detected — #924 regression).`,
    );
  });

  test('claude global: no concrete skill is nested under gsd-ns-*/skills/<stem>/SKILL.md', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    const topLevel = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-ns-'));

    for (const nsDir of topLevel) {
      const nestedSkillsDir = path.join(skillsDir, nsDir, 'skills');
      assert.ok(
        !fs.existsSync(nestedSkillsDir),
        `${nsDir}/skills/ must NOT exist in Claude flat layout (#924 regression: nested layout detected).`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// #924 regression: applySurface on Claude must also preserve flat layout
// (no re-nesting after surface update)
// ---------------------------------------------------------------------------

describe('bug-924: applySurface on claude preserves flat layout (no re-nesting)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-924-surface-'));
    installRuntimeArtifacts('claude', tmpDir, 'global', RESOLVED_FULL);
  });

  after(() => {
    if (tmpDir) {
      try { cleanup(tmpDir); } catch { /* best-effort */ }
    }
  });

  test('claude: applySurface keeps concrete skills at the top level (flat, no re-nesting)', () => {
    const skillsDir = path.join(tmpDir, 'skills');

    // Sanity: install must produce flat layout (>= 60 top-level gsd-* dirs)
    const topLevelAfterInstall = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevelAfterInstall.length >= 60,
      `Install must produce flat layout with >= 60 gsd-* dirs. Got ${topLevelAfterInstall.length}.`,
    );

    // Run applySurface (full surface → full profile)
    const layout = resolveRuntimeArtifactLayout('claude', tmpDir, 'global');
    applySurface(tmpDir, layout, MANIFEST);

    // After applySurface: still flat
    const topLevelAfterSurface = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevelAfterSurface.length >= 60,
      `After applySurface: must still have >= 60 gsd-* top-level dirs (flat). ` +
      `Got ${topLevelAfterSurface.length}. Re-nesting detected.`,
    );

    // gsd-plan-phase must remain directly accessible
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md')),
      'After applySurface: gsd-plan-phase/SKILL.md must remain at top level.',
    );
  });
});
