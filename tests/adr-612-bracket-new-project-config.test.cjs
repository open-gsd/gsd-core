'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const projects = new Set();
afterEach(() => {
  for (const dir of projects) cleanup(dir);
  projects.clear();
});

function project() {
  const dir = createTempProject('adr-612-new-project-');
  projects.add(dir);
  return dir;
}

describe('#4304 / ADR-612 Decision 2: new-project default remains unchanged', () => {
  test('empty choices materialize sequential phase naming without a bracket convention or project code', () => {
    const dir = project();
    const result = runGsdTools(
      ['config-new-project', '{}'],
      dir,
      { HOME: dir, USERPROFILE: dir },
    );
    assert.equal(result.success, true, result.error || result.output);

    const config = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
    assert.equal(config.phase_naming, 'sequential');
    assert.equal(config.project_code, null);
    assert.equal(Object.hasOwn(config, 'phase_id_convention'), false);
  });

  test('an explicit bracket choice is preserved without deriving a project code', () => {
    const dir = project();
    const choices = JSON.stringify({ phase_id_convention: 'bracket' });
    const result = runGsdTools(
      ['config-new-project', choices],
      dir,
      { HOME: dir, USERPROFILE: dir },
    );
    assert.equal(result.success, true, result.error || result.output);

    const config = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
    assert.equal(config.phase_id_convention, 'bracket');
    assert.equal(config.project_code, null);
  });
});
