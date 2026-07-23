'use strict';

/**
 * trae capability UPGRADE — ADR-1239 Phase D / #2094 (EoS/trae).
 *
 * Drives the user-reachable surface (spawned `bin/install.js` via
 * `runMinimalInstall`) to prove the one real upgrade Trae contributes beyond
 * the base imperative migration (tests/trae-imperative-reference.test.cjs):
 *
 *   UPGRADE — SOLO stage/trigger metadata: every emitted `SKILL.md` carries a
 *   `stage: workflow` frontmatter line (`runtime.hostBehaviors.
 *   soloStageMetadata`), sourced from https://docs.trae.ai/ide/agent ("Agents
 *   in Trae can be called individually, or automatically called by SOLO Agent
 *   at the corresponding stage"). This is a single fixed GSD-side value —
 *   best-effort/inferred, since Trae's docs don't publish a formal
 *   stage-metadata schema — not per-skill differentiated. It lets Trae's SOLO
 *   Agent auto-invoke GSD skills at the corresponding stage instead of
 *   requiring the user to manually trigger them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runMinimalInstall, walk } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');

const TRAE_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'trae', 'capability.json'), 'utf8'),
);

/** Extract the YAML frontmatter block (between the first pair of `---` lines), or null. */
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// -- UPGRADE: SOLO stage/trigger metadata on every emitted SKILL.md ---------

for (const scope of ['global', 'local']) {
  test(`trae --${scope}: emitted SKILL.md frontmatter carries stage: workflow (UPGRADE)`, (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'trae', scope });
    t.after(() => cleanup(root));

    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), `${skillsDir} must exist`);

    // Trae uses NESTED skills (capabilities/trae/capability.json
    // artifactLayout.skills.nesting === "nested"): a router SKILL.md at
    // skills/gsd-ns-<namespace>/SKILL.md, and concrete skills nested under
    // skills/gsd-ns-<namespace>/skills/<stem>/SKILL.md. Discover ALL of them
    // by recursive walk rather than hand-listing paths, so the test doesn't
    // silently stop covering skills added/renamed later.
    const skillFiles = walk(skillsDir).filter((f) => f.endsWith('SKILL.md'));
    assert.ok(skillFiles.length > 0, `expected at least one SKILL.md under ${skillsDir}`);

    for (const filePath of skillFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content);
      assert.ok(fm, `${filePath} must have YAML frontmatter`);
      assert.match(fm, /^stage:\s*workflow\s*$/m,
        `${filePath} frontmatter must declare stage: workflow (UPGRADE — SOLO stage metadata)`);
    }

    // A couple of named skills, explicitly, spanning both the top-level
    // router shape and the nested concrete-skill shape — confirmed via
    // `node -e` against a real install before asserting these exact paths.
    const samples = [
      path.join(skillsDir, 'gsd-ns-manage', 'SKILL.md'),
      path.join(skillsDir, 'gsd-ns-manage', 'skills', 'cleanup', 'SKILL.md'),
      path.join(skillsDir, 'gsd-ns-ideate', 'skills', 'capture', 'SKILL.md'),
    ];
    for (const sample of samples) {
      assert.ok(fs.existsSync(sample), `${sample} must exist`);
      const fm = parseFrontmatter(fs.readFileSync(sample, 'utf8'));
      assert.ok(fm, `${sample} must have YAML frontmatter`);
      assert.match(fm, /^stage:\s*workflow\s*$/m, `${sample} frontmatter must declare stage: workflow`);
    }
  });
}

// -- boundary: capability.json is the single source of truth ----------------

test('capabilities/trae/capability.json runtime.hostBehaviors.soloStageMetadata === "workflow"', () => {
  assert.equal(TRAE_CAP.runtime.hostBehaviors.soloStageMetadata, 'workflow');
});

// -- descriptor-gated, not global: a runtime lacking soloStageMetadata gets
//    no stage: line at all -------------------------------------------------

test('qwen (no soloStageMetadata declared) does NOT get a stage: line — proves the field is descriptor-gated, not global', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'qwen', scope: 'global' });
  t.after(() => cleanup(root));

  const skillsDir = path.join(configDir, 'skills');
  assert.ok(fs.existsSync(skillsDir), `${skillsDir} must exist`);
  // Qwen also uses the nested skill layout (router SKILL.md +
  // skills/<stem>/SKILL.md) — confirmed via `node -e` against a real
  // install before writing this — so walk recursively, same as the trae
  // assertions above, rather than assuming flat gsd-*.md files.
  const skillFiles = walk(skillsDir).filter((f) => f.endsWith('SKILL.md'));
  assert.ok(skillFiles.length > 0, `expected at least one SKILL.md under ${skillsDir}`);

  for (const filePath of skillFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = parseFrontmatter(content);
    assert.ok(fm, `${filePath} must have YAML frontmatter`);
    assert.doesNotMatch(fm, /^stage:/m,
      `${filePath} must NOT declare stage: — qwen's descriptor has no hostBehaviors.soloStageMetadata`);
  }
});
