'use strict';

// #6211: the executor policy (workflow.agent_hint_routing) is asked at
// new-project and in /gsd-settings, and config-new-project writes it.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const REPO = path.join(__dirname, '..');
const projects = new Set();
afterEach(() => {
  for (const dir of projects) cleanup(dir);
  projects.clear();
});

function project() {
  const dir = createTempProject('executor-policy-6211-');
  projects.add(dir);
  return dir;
}

function isolatedEnv(dir) {
  return { HOME: dir, USERPROFILE: dir, GSD_HOME: dir };
}

function configPath(dir) {
  return path.join(dir, '.planning', 'config.json');
}

function newProject(dir, choices) {
  return runGsdTools(['config-new-project', JSON.stringify(choices)], dir, isolatedEnv(dir));
}

function writtenRouting(dir) {
  const config = JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
  return config.workflow.agent_hint_routing;
}

function writeUserDefaults(dir, defaults) {
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'defaults.json'), JSON.stringify(defaults));
}

describe('#6211: config-new-project writes workflow.agent_hint_routing', () => {
  test('no choice writes the default true', () => {
    const dir = project();
    const result = newProject(dir, {});
    assert.equal(result.success, true, result.error || result.output);
    assert.equal(writtenRouting(dir), true);
  });

  test('the written default equals the canonical defaults manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(REPO, 'gsd-core', 'bin', 'shared', 'config-defaults.manifest.json'), 'utf8'));
    const dir = project();
    const result = newProject(dir, {});
    assert.equal(result.success, true, result.error || result.output);
    assert.equal(writtenRouting(dir), manifest.workflow.agent_hint_routing);
  });

  test('a false choice writes false', () => {
    const dir = project();
    const result = newProject(dir, { workflow: { agent_hint_routing: false } });
    assert.equal(result.success, true, result.error || result.output);
    assert.equal(writtenRouting(dir), false);
  });

  test('a true choice writes true', () => {
    const dir = project();
    const result = newProject(dir, { workflow: { agent_hint_routing: true } });
    assert.equal(result.success, true, result.error || result.output);
    assert.equal(writtenRouting(dir), true);
  });

  test('a null choice is left unchosen and the default true is written', () => {
    const dir = project();
    const result = newProject(dir, { workflow: { agent_hint_routing: null } });
    assert.equal(result.success, true, result.error || result.output);
    assert.equal(writtenRouting(dir), true);
  });

  for (const bad of ['false', 1]) {
    test(`a non-boolean choice (${JSON.stringify(bad)}) is refused and nothing is written`, () => {
      const dir = project();
      const result = newProject(dir, { workflow: { agent_hint_routing: bad } });
      assert.equal(result.success, false, result.output);
      assert.equal(fs.existsSync(configPath(dir)), false);
    });
  }

  test('a saved default of false is used when there is no choice', () => {
    const dir = project();
    writeUserDefaults(dir, { workflow: { agent_hint_routing: false } });
    const result = newProject(dir, {});
    assert.equal(result.success, true, result.error || result.output);
    assert.equal(writtenRouting(dir), false);
  });

  test('a choice overrides a saved default', () => {
    const dir = project();
    writeUserDefaults(dir, { workflow: { agent_hint_routing: false } });
    const result = newProject(dir, { workflow: { agent_hint_routing: true } });
    assert.equal(result.success, true, result.error || result.output);
    assert.equal(writtenRouting(dir), true);
  });
});

// Workflow text is the runtime contract the orchestrating model follows: the
// question and the payload key are the product here, not an implementation.
function readWorkflow(name) {
  return fs.readFileSync(path.join(REPO, 'gsd-core', 'workflows', name), 'utf8');
}

/** Every AskUserQuestion entry whose header is `header`, as the text up to its options' closing `]`. */
function questionBlocks(text, header) {
  const blocks = [];
  const marker = `header: "${header}"`;
  let at = text.indexOf(marker);
  while (at !== -1) {
    const start = text.lastIndexOf('{', at);
    const end = text.indexOf('\n    ]', at); // the options array's own closing line
    blocks.push(text.slice(start, end + 6));
    at = text.indexOf(marker, at + marker.length);
  }
  return blocks;
}

/** The `workflow` object of the interactive config-new-project payload. */
function payloadWorkflow(text) {
  const start = text.indexOf("gsd_run query config-new-project '");
  assert.notEqual(start, -1, 'new-project.md must carry a config-new-project payload');
  const line = text.slice(start, text.indexOf('\n', start));
  const wf = line.indexOf('"workflow":{');
  assert.notEqual(wf, -1, 'payload must carry a workflow object');
  return line.slice(wf, line.indexOf('}', wf) + 1);
}

const ALLOW = 'Allow installed executors (Recommended)';
const ONLY = 'gsd-executor only';

describe('#6211: new-project asks the executor policy', () => {
  const text = readWorkflow('new-project.md');

  test('the fresh path asks an Executor question with both policies', () => {
    const blocks = questionBlocks(text, 'Executor').filter((b) => b.includes(ALLOW));
    assert.equal(blocks.length, 1, 'exactly one Executor policy question');
    assert.ok(blocks[0].includes(ONLY), blocks[0]);
  });

  test('the saved-defaults Modify path offers the Executor setting', () => {
    const offers = questionBlocks(text, 'Executor').filter((b) => !b.includes(ALLOW));
    assert.equal(offers.length, 1, 'one Yes/No Executor question in the Modify path');
    assert.ok(offers[0].includes('label: "Yes"') && offers[0].includes('label: "No"'), offers[0]);
    assert.ok(text.includes('Executor — Currently:'), 'TEXT_MODE list names the Executor setting');
    assert.ok(text.includes('`workflow.agent_hint_routing` → "Executor"'), 'defaults display maps the key');
  });

  test('the config-new-project payload carries workflow.agent_hint_routing', () => {
    const workflow = payloadWorkflow(text);
    assert.ok(workflow.includes('"agent_hint_routing":true|false'), workflow);
  });
});

describe('#6211: /gsd-settings asks the executor policy', () => {
  const text = readWorkflow('settings.md');

  test('settings asks an Executor question with both policies', () => {
    const blocks = questionBlocks(text, 'Executor');
    assert.equal(blocks.length, 1, 'exactly one Executor question');
    assert.ok(blocks[0].includes(ALLOW) && blocks[0].includes(ONLY), blocks[0]);
  });

  test('settings writes the answer through config-set as a non-capability key', () => {
    const line = text.split('\n').find((l) => l.startsWith('- **Non-capability keys**'));
    assert.ok(line, 'settings.md must list its non-capability keys');
    assert.ok(line.includes('`workflow.agent_hint_routing`'), line);
  });
});

describe('#6211: new-project auto mode asks the executor policy', () => {
  const text = fs.readFileSync(
    path.join(REPO, 'gsd-core', 'workflows', 'new-project', 'steps', 'auto-mode-config.md'), 'utf8');

  test('auto mode asks one Executor question with both policies', () => {
    const blocks = questionBlocks(text, 'Executor');
    assert.equal(blocks.length, 1, 'exactly one Executor question');
    assert.ok(blocks[0].includes(ALLOW) && blocks[0].includes(ONLY), blocks[0]);
  });

  test('the auto-mode config-new-project payload carries workflow.agent_hint_routing', () => {
    const workflow = payloadWorkflow(text);
    assert.ok(workflow.includes('"agent_hint_routing":true|false'), workflow);
  });
});
