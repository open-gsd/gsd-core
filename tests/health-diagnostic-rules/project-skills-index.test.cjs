'use strict';

/**
 * Tests for `src/health-diagnostic-rules/project-skills-index.cts` (#4649) —
 * the W030 rule: a project skill whose SKILL.md has no frontmatter
 * `description` (the project-skills discovery reads such a SKILL.md in full on
 * every spawn of a discovery agent, because its relevance filter needs the
 * description) or exceeds the Agent Skills specification's 500-line guideline
 * for SKILL.md.
 *
 * Uses the REAL `buildPlanningSnapshot(cwd)` against temp projects with real
 * skill directories under the discovery contract's project roots
 * (`docs/skills/discovery-contract.md`). HOME is sandboxed per test so the
 * global skill roots `buildSkillManifest` also scans never leak in.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, createTempProject, cleanup, sandboxHome } = require('../helpers.cjs');
const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { SEVERITY } = require('../../gsd-core/bin/lib/health-diagnostic-types.cjs');
const { RULES } = require('../../gsd-core/bin/lib/health-diagnostic-rules/project-skills-index.cjs');

const rule = RULES.find((r) => r.code === 'W030');

function writeSkill(projectDir, root, name, content) {
  const dir = path.join(projectDir, root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

function skillMd({ name, description, bodyLines = 3 }) {
  const frontmatter = description === undefined
    ? `---\nname: ${name}\n---\n`
    : `---\nname: ${name}\ndescription: ${description}\n---\n`;
  const body = Array.from({ length: bodyLines }, (_, i) => `Line ${i + 1}.`).join('\n');
  return `${frontmatter}\n${body}\n`;
}

function lineCount(content) {
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

function withProject(t) {
  const project = createTempProject();
  const home = createTempDir('gsd-w030-home-');
  t.after(() => { cleanup(project); cleanup(home); });
  sandboxHome(t, home);
  return project;
}

describe('W030: project skill index (#4649)', () => {
  test('the rule is a non-repairable warning', () => {
    assert.ok(rule, 'W030 is registered in this module');
    assert.strictEqual(rule.severity, SEVERITY.WARNING);
    assert.strictEqual(rule.repairable, false);
  });

  test('no project skills: no diagnostic', (t) => {
    const project = withProject(t);
    assert.deepStrictEqual(rule.check(buildPlanningSnapshot(project)), []);
  });

  test('a skill with a description within the line guideline: no diagnostic', (t) => {
    const project = withProject(t);
    writeSkill(project, '.claude/skills', 'api-conventions',
      skillMd({ name: 'api-conventions', description: 'REST conventions. Use when adding endpoints.' }));
    assert.deepStrictEqual(rule.check(buildPlanningSnapshot(project)), []);
  });

  test('a SKILL.md without a description is reported as read in full on every spawn', (t) => {
    const project = withProject(t);
    writeSkill(project, '.claude/skills', 'legacy-notes', skillMd({ name: 'legacy-notes' }));
    const diagnostics = rule.check(buildPlanningSnapshot(project));
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'W030');
    assert.strictEqual(diagnostics[0].severity, SEVERITY.WARNING);
    assert.match(diagnostics[0].message, /\.claude\/skills\/legacy-notes\/SKILL\.md/);
    assert.match(diagnostics[0].message, /no frontmatter `description`/);
    assert.match(diagnostics[0].message, /in full on every spawn/);
  });

  test('a SKILL.md over 500 lines is reported with its line count', (t) => {
    const project = withProject(t);
    const content = skillMd({ name: 'big-pack', description: 'A large skill.', bodyLines: 600 });
    writeSkill(project, '.agents/skills', 'big-pack', content);
    const diagnostics = rule.check(buildPlanningSnapshot(project));
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /\.agents\/skills\/big-pack\/SKILL\.md/);
    assert.match(diagnostics[0].message, new RegExp(`has ${lineCount(content)} lines`));
    assert.match(diagnostics[0].message, /500-line/);
  });

  test('499 lines is within the guideline', (t) => {
    const project = withProject(t);
    const content = skillMd({ name: 'edge-minus', description: 'Edge case.', bodyLines: 494 });
    assert.strictEqual(lineCount(content), 499);
    writeSkill(project, '.claude/skills', 'edge-minus', content);
    assert.deepStrictEqual(rule.check(buildPlanningSnapshot(project)), []);
  });

  test('exactly 500 lines is within the guideline', (t) => {
    const project = withProject(t);
    // 5 frontmatter/blank lines + 495 body lines = 500 lines.
    const content = skillMd({ name: 'edge', description: 'Edge case.', bodyLines: 495 });
    assert.strictEqual(lineCount(content), 500);
    writeSkill(project, '.claude/skills', 'edge', content);
    assert.deepStrictEqual(rule.check(buildPlanningSnapshot(project)), []);
  });

  test('501 lines is one over the guideline and is reported', (t) => {
    const project = withProject(t);
    const content = skillMd({ name: 'edge-plus', description: 'Edge case.', bodyLines: 496 });
    assert.strictEqual(lineCount(content), 501);
    writeSkill(project, '.claude/skills', 'edge-plus', content);
    const diagnostics = rule.check(buildPlanningSnapshot(project));
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /has 501 lines/);
  });

  test('a skill missing a description and over 500 lines yields one diagnostic per finding', (t) => {
    const project = withProject(t);
    writeSkill(project, '.claude/skills', 'both', skillMd({ name: 'both', bodyLines: 700 }));
    const messages = rule.check(buildPlanningSnapshot(project)).map((d) => d.message);
    assert.strictEqual(messages.length, 2);
    assert.ok(messages.some((m) => /no frontmatter `description`/.test(m)));
    assert.ok(messages.some((m) => /500-line/.test(m)));
  });

  test('GSD-owned gsd-* skills (local installs) are not reported', (t) => {
    const project = withProject(t);
    writeSkill(project, '.claude/skills', 'gsd-plan-phase', skillMd({ name: 'gsd-plan-phase', bodyLines: 700 }));
    assert.deepStrictEqual(rule.check(buildPlanningSnapshot(project)), []);
  });

  test('skills in the user home are not project skills and are not reported', (t) => {
    const project = createTempProject();
    const home = createTempDir('gsd-w030-home-');
    t.after(() => { cleanup(project); cleanup(home); });
    sandboxHome(t, home);
    writeSkill(home, '.claude/skills', 'personal', skillMd({ name: 'personal' }));
    assert.deepStrictEqual(rule.check(buildPlanningSnapshot(project)), []);
  });
});
