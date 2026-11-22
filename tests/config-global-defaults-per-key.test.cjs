'use strict';

/**
 * #4071 (epic #4633, C3 #6030): ~/.gsd/defaults.json merges per key under a project config.
 * Every cell runs the real gsd-tools entry through a hermetic GSD_HOME/HOME, never a mocked CLI.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');

let home;
let proj;

beforeEach(() => {
  home = fs.realpathSync(createTempDir('gsd-4071-home-'));
  proj = fs.realpathSync(createTempDir('gsd-4071-proj-'));
  fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
});

afterEach(() => {
  cleanup(home);
  cleanup(proj);
});

function writeGlobal(obj) {
  fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify(obj));
}

function writeProject(obj) {
  fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify(obj));
}

function hermeticEnv() {
  return { GSD_HOME: home, HOME: home, USERPROFILE: home };
}

function resolveModel(agent = 'gsd-planner') {
  const result = runGsdTools(['resolve-model', agent], proj, hermeticEnv());
  assert.equal(result.success, true, result.error || result.output);
  return JSON.parse(result.output);
}

describe('#4071: global defaults merge per key inside a project', () => {
  test('a global model_profile is honored when the project config does not mention it', () => {
    writeGlobal({ model_profile: 'budget' });
    writeProject({ granularity: 'standard' });
    assert.equal(resolveModel().profile, 'budget');
  });

  test('a project model_profile wins over the global one on collision', () => {
    writeGlobal({ model_profile: 'budget' });
    writeProject({ model_profile: 'quality' });
    assert.equal(resolveModel().profile, 'quality');
  });

  test('a global effort.agent_overrides entry reaches resolve-model when the project is silent on effort', () => {
    writeGlobal({ effort: { agent_overrides: { 'gsd-planner': 'max' } } });
    writeProject({ granularity: 'standard' });
    assert.equal(resolveModel().effort, 'max');
  });

  test('the control: the same value set in the project config is honored today', () => {
    writeGlobal({});
    writeProject({ granularity: 'standard', model_profile: 'budget' });
    assert.equal(resolveModel().profile, 'budget');
  });

  test('a project-present null section still blocks the global fill', () => {
    writeGlobal({ workflow: { research: false } });
    writeProject({ workflow: null });
    const result = runGsdTools(['config-get', 'workflow.research', '--raw'], proj, hermeticEnv());
    assert.notEqual(result.output.trim(), 'false', 'a null project section keeps the barrier over global defaults');
  });
});
