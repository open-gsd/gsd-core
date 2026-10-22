'use strict';

/**
 * #5630: `/skill:gsd-debug` runs `list` and `status <slug>` on Pi and refuses every other form.
 * Those two subcommands spawn no agent (gsd-core/workflows/debug.md sections 1a and 1b), so the
 * nested-dispatch limit that makes the rest unsupported does not apply to them.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const {
  convertClaudeCommandToPiSkill,
  PI_UNSUPPORTED_SKILLS,
  PI_PARTIAL_SKILLS,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const REPO = path.join(__dirname, '..');
const REASON = 'needs nested dispatch; Pi dispatch is flat';
const DEBUG_COMMAND = fs.readFileSync(path.join(REPO, 'commands', 'gsd', 'debug.md'), 'utf8');
const DEBUG_WORKFLOW = fs.readFileSync(path.join(REPO, 'gsd-core', 'workflows', 'debug.md'), 'utf8');

describe('#5630: the partial-skill table', () => {
  test('gsd-debug is partial, not unsupported, and names the subcommands it runs', () => {
    assert.ok(PI_PARTIAL_SKILLS && typeof PI_PARTIAL_SKILLS === 'object', 'run `npm run build:lib` first');
    assert.deepEqual(Object.keys(PI_PARTIAL_SKILLS), ['gsd-debug']);
    assert.equal(PI_PARTIAL_SKILLS['gsd-debug'].reason, REASON);
    assert.deepEqual(PI_PARTIAL_SKILLS['gsd-debug'].subcommands, ['list', 'status']);
    assert.equal(Object.prototype.hasOwnProperty.call(PI_UNSUPPORTED_SKILLS, 'gsd-debug'), false);
  });

  test('no skill is in both tables', () => {
    for (const name of Object.keys(PI_PARTIAL_SKILLS)) {
      assert.equal(Object.prototype.hasOwnProperty.call(PI_UNSUPPORTED_SKILLS, name), false, name);
    }
  });
});

describe('#5630: the generated gsd-debug skill', () => {
  const skill = convertClaudeCommandToPiSkill(DEBUG_COMMAND, 'gsd-debug');

  test('keeps the skill name and a quoted description in its frontmatter', () => {
    assert.match(skill, /^---\nname: gsd-debug\ndescription: ".+"\n---\n/);
  });

  test('says which forms run and prints the reason the others do not', () => {
    assert.ok(skill.includes('`list`'));
    assert.ok(skill.includes('`status <slug>`'));
    assert.ok(skill.includes(REASON));
  });

  test('is not the full stub: the parity matrix identifies stubs by this marker', () => {
    assert.equal(skill.includes('is unsupported on Pi:'), false);
  });

  test('lists the workflow under execution_context so Pi reads it', () => {
    assert.match(skill, /<execution_context>\n@[^\n]*gsd-core\/workflows\/debug\.md\n<\/execution_context>/);
  });

  test('restricts the run to sections 0, 1a and 1b of the workflow, and forbids dispatch and inline work', () => {
    assert.match(skill, /section 0/i);
    assert.match(skill, /section 1a/i);
    assert.match(skill, /section 1b/i);
    assert.match(skill, /do not dispatch/i);
    assert.match(skill, /inline/i);
  });

  test('does not carry the command body that orchestrates the debugger and the session manager', () => {
    assert.equal(skill.includes('gsd-debug-session-manager'), false);
    assert.equal(skill.includes('spawn gsd-debugger'), false);
    assert.equal(skill.includes('gsd_dispatch'), false);
  });

  test('fails closed to the full stub when the command has no execution_context to read', () => {
    const noContext = DEBUG_COMMAND.replace(/<execution_context>[\s\S]*?<\/execution_context>/, '');
    assert.notEqual(noContext, DEBUG_COMMAND, 'vacuous: fixture still has an execution_context');
    const stub = convertClaudeCommandToPiSkill(noContext, 'gsd-debug');
    assert.ok(stub.includes('is unsupported on Pi:'));
    assert.ok(stub.includes(REASON));
    assert.equal(stub.includes('section 1a'), false);
  });
});

describe('#5630: the skill and the workflow name the same sections', () => {
  test('the workflow still has the list and status sections the skill points at', () => {
    assert.match(DEBUG_WORKFLOW, /^## 0\. Initialize Context$/m);
    assert.match(DEBUG_WORKFLOW, /^## 1a\. LIST subcommand$/m);
    assert.match(DEBUG_WORKFLOW, /^## 1b\. STATUS subcommand$/m);
  });

  test('sections 1a and 1b spawn no agent', () => {
    const start = DEBUG_WORKFLOW.indexOf('## 1a. LIST subcommand');
    const end = DEBUG_WORKFLOW.indexOf('## 1c. CONTINUE subcommand');
    assert.ok(start >= 0 && end > start, 'vacuous: sections not found');
    const listAndStatus = DEBUG_WORKFLOW.slice(start, end);
    assert.equal(/gsd-debug-session-manager|gsd-debugger|Agent\(|gsd_dispatch/.test(listAndStatus), false);
  });
});

describe('#5630: the Pi install', () => {
  let root;
  let configDir;
  before(() => {
    ({ root, configDir } = runMinimalInstall({ runtime: 'pi', scope: 'global' }));
  });
  after(() => cleanup(root));

  test('installs the partial skill and the workflow it reads', () => {
    const body = fs.readFileSync(path.join(configDir, 'skills', 'gsd-debug', 'SKILL.md'), 'utf8');
    assert.ok(body.includes('`list`') && body.includes(REASON));
    const included = /<execution_context>\n@([^\n]+)\n<\/execution_context>/.exec(body);
    assert.ok(included, 'no execution_context include in the installed skill');
    assert.ok(included[1].endsWith('gsd-core/workflows/debug.md'), included[1]);
    assert.ok(fs.existsSync(path.join(configDir, 'gsd-core', 'workflows', 'debug.md')));
  });
});
