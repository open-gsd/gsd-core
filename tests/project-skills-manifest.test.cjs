'use strict';

/**
 * project-skills-manifest.test.cjs (#6719)
 *
 * The shared project-skills discovery reference tells an agent to run
 * `gsd_run skill-manifest --skills-dir <dir>` once per project skills directory and to open a
 * SKILL.md body only for an entry whose description fits the task. These tests pin what that
 * listing step depends on: the output carries name, description and path and never a body, a
 * skill with no usable description is reported with an empty one, and every skill directory is
 * listed, symlinked ones included. Each case builds its own skills directory.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempDir, cleanup, homeSandboxEnv } = require('./helpers.cjs');

const BODY_MARKER = 'BODY-MARKER-4f1c9e';

describe('#6719: skill-manifest --skills-dir lists project skills without their bodies', () => {
  let root;
  let skillsDir;

  beforeEach(() => {
    root = fs.realpathSync(createTempDir('gsd-6719-'));
    skillsDir = path.join(root, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => cleanup(root));

  function writeSkill(name, content, dir = skillsDir) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), content);
  }

  function manifest() {
    const result = runGsdTools(['skill-manifest', '--skills-dir', skillsDir], root, homeSandboxEnv(root));
    assert.equal(result.success, true, result.error || result.output);
    return { text: result.output, json: JSON.parse(result.output) };
  }

  const frontmatter = (description) => `---\nname: demo\ndescription: ${description}\n---\n`;

  test('lists name and description and never the body', () => {
    writeSkill('demo', `${frontmatter('Demo skill for tests')}${BODY_MARKER}\n${'x'.repeat(200 * 1024)}\n`);
    const { text, json } = manifest();
    assert.equal(json.skills.length, 1);
    assert.equal(json.skills[0].name, 'demo');
    assert.equal(json.skills[0].description, 'Demo skill for tests');
    assert.equal(json.skills[0].file_path, 'demo/SKILL.md');
    assert.equal(text.includes(BODY_MARKER), false, 'the body is in the output');
  });

  test('output size does not depend on body size', () => {
    writeSkill('demo', `${frontmatter('Same description')}tiny\n`);
    const small = manifest().text.length;
    writeSkill('demo', `${frontmatter('Same description')}${'y'.repeat(200 * 1024)}\n`);
    assert.equal(manifest().text.length, small);
  });

  test('reports an empty description when the key is missing', () => {
    writeSkill('nodesc', `---\nname: nodesc\n---\n${BODY_MARKER}\n`);
    const { json } = manifest();
    assert.equal(json.skills[0].name, 'nodesc');
    assert.equal(json.skills[0].description, '');
  });

  test('lists a skill whose frontmatter is unparseable with an empty description', () => {
    writeSkill('broken', `---\nname: [unclosed\ndescription: "also: broken\n---\n${BODY_MARKER}\n`);
    const { text, json } = manifest();
    assert.equal(json.skills[0].name, 'broken');
    assert.equal(json.skills[0].description, '');
    assert.equal(text.includes(BODY_MARKER), false);
  });

  test('lists a skill with an unterminated frontmatter fence', () => {
    writeSkill('open', `---\nname: open\ndescription: never closed\n${BODY_MARKER}\n`);
    const { json } = manifest();
    assert.equal(json.skills[0].name, 'open');
    assert.equal(json.skills[0].description, '');
  });

  test('lists a skill with no frontmatter', () => {
    writeSkill('plain', `# Plain skill\n${BODY_MARKER}\n`);
    const { text, json } = manifest();
    assert.equal(json.skills[0].name, 'plain');
    assert.equal(json.skills[0].description, '');
    assert.equal(text.includes(BODY_MARKER), false);
  });

  test('follows a symlinked skill directory', () => {
    const real = path.join(root, 'shared-skills');
    writeSkill('linked', `---\nname: linked\ndescription: Installed through a symlink\n---\nbody\n`, real);
    fs.symlinkSync(path.join(real, 'linked'), path.join(skillsDir, 'linked'), 'junction');
    const { json } = manifest();
    assert.deepEqual(json.skills.map((s) => [s.name, s.description]), [['linked', 'Installed through a symlink']]);
    assert.equal(json.roots[0].skill_count, 1);
  });

  test('skips dangling and file symlinks without failing', (t) => {
    fs.writeFileSync(path.join(root, 'a-file'), 'not a skill dir');
    try {
      fs.symlinkSync(path.join(root, 'missing-dir'), path.join(skillsDir, 'dangling'), 'junction');
      fs.symlinkSync(path.join(root, 'a-file'), path.join(skillsDir, 'to-file'), 'file');
    } catch (err) {
      // Windows without symlink privilege cannot create the file link; the guard below is POSIX behavior.
      t.skip(`cannot create symlinks here: ${err.code}`);
      return;
    }
    writeSkill('real', frontmatter('A real skill'));
    const { json } = manifest();
    assert.deepEqual(json.skills.map((s) => s.name), ['demo']);
    assert.equal(json.roots[0].skill_count, 1);
  });

  test('reports an empty skills dir', () => {
    const { json } = manifest();
    assert.deepEqual(json.skills, []);
    assert.equal(json.roots[0].present, true);
    assert.equal(json.roots[0].skill_count, 0);
  });

  test('reports a missing skills dir', () => {
    fs.rmSync(skillsDir, { recursive: true });
    const { json } = manifest();
    assert.deepEqual(json.skills, []);
    assert.equal(json.roots[0].present, false);
  });

  test('ignores a subdirectory with no SKILL.md', () => {
    fs.mkdirSync(path.join(skillsDir, 'notes'));
    fs.writeFileSync(path.join(skillsDir, 'notes', 'README.md'), 'not a skill');
    const { json } = manifest();
    assert.deepEqual(json.skills, []);
  });
});
