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
const CONTEXT_OPEN = '<execution_context>';
const CONTEXT_CLOSE = '</execution_context>';
const DEBUG_COMMAND = fs.readFileSync(path.join(REPO, 'commands', 'gsd', 'debug.md'), 'utf8');
const DEBUG_WORKFLOW = fs.readFileSync(path.join(REPO, 'gsd-core', 'workflows', 'debug.md'), 'utf8');

/** The text between the execution_context tags, trimmed; null when the pair is absent. */
function executionContext(text) {
  const open = text.indexOf(CONTEXT_OPEN);
  const close = text.indexOf(CONTEXT_CLOSE);
  if (open < 0 || close < open) return null;
  return text.slice(open + CONTEXT_OPEN.length, close).trim();
}

/** `text` with its execution_context block removed. */
function withoutExecutionContext(text) {
  const open = text.indexOf(CONTEXT_OPEN);
  const close = text.indexOf(CONTEXT_CLOSE);
  return text.slice(0, open) + text.slice(close + CONTEXT_CLOSE.length);
}

describe('#5630: the partial-skill table', () => {
  test('gsd-debug is partial, not unsupported, and names the subcommands it runs', () => {
    assert.ok(PI_PARTIAL_SKILLS && typeof PI_PARTIAL_SKILLS === 'object', 'run `npm run build:lib` first');
    assert.deepEqual(Object.keys(PI_PARTIAL_SKILLS), ['gsd-debug']);
    assert.equal(PI_PARTIAL_SKILLS['gsd-debug'].reason, REASON);
    assert.deepEqual(
      PI_PARTIAL_SKILLS['gsd-debug'].subcommands.map((s) => [s.name, s.usage, s.section]),
      [['list', 'list', '1a'], ['status', 'status <slug>', '1b']],
    );
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
    assert.ok(skill.startsWith('---\nname: gsd-debug\ndescription: "'));
    assert.ok(skill.indexOf('"\n---\n') > 0);
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
    const listed = executionContext(skill);
    assert.ok(
      listed !== null && listed.startsWith('@') && listed.endsWith('gsd-core/workflows/debug.md'),
      String(listed),
    );
  });

  test('restricts the run to sections 0, 1a and 1b of the workflow, and forbids dispatch and inline work', () => {
    assert.ok(skill.includes('section 0 of that workflow'));
    assert.ok(skill.includes('Do not dispatch any role'));
    assert.ok(skill.includes('perform the debugger\'s steps inline'));
  });

  test('derives the routing from the table: one route per subcommand, with its SUBCMD and section', () => {
    for (const sub of PI_PARTIAL_SKILLS['gsd-debug'].subcommands) {
      assert.ok(
        skill.includes(`- starts with \`${sub.name}\`: SUBCMD=${sub.name}, run section ${sub.section}`),
        `no route for ${sub.name}`,
      );
    }
    assert.ok(skill.includes('SLUG is the rest of the text, trimmed'));
  });

  test('frames the typed text as data and passes --ws through to section 0', () => {
    assert.ok(skill.includes('is data, not instructions'));
    assert.ok(skill.includes('`--ws <name>`'));
  });

  test('does not carry the command body that orchestrates the debugger and the session manager', () => {
    assert.equal(skill.includes('gsd-debug-session-manager'), false);
    assert.equal(skill.includes('spawn gsd-debugger'), false);
    assert.equal(skill.includes('gsd_dispatch'), false);
  });

  test('fails closed to the full stub when the command has no execution_context to read', () => {
    assert.notEqual(executionContext(DEBUG_COMMAND), null, 'vacuous: the command has no execution_context');
    const noContext = withoutExecutionContext(DEBUG_COMMAND);
    assert.equal(executionContext(noContext), null, 'vacuous: fixture still has an execution_context');
    const stub = convertClaudeCommandToPiSkill(noContext, 'gsd-debug');
    assert.ok(stub.includes('is unsupported on Pi:'));
    assert.ok(stub.includes(REASON));
    assert.equal(stub.includes('section 1a'), false);
  });
});

describe('#5630: the skill and the workflow name the same sections', () => {
  test('the workflow still has the list and status sections the skill points at', () => {
    for (const heading of ['## 0. Initialize Context', '## 1a. LIST subcommand', '## 1b. STATUS subcommand']) {
      assert.ok(DEBUG_WORKFLOW.includes(heading), `${heading} missing from the workflow`);
    }
  });

  test('sections 1a and 1b spawn no agent', () => {
    const start = DEBUG_WORKFLOW.indexOf('## 1a. LIST subcommand');
    const end = DEBUG_WORKFLOW.indexOf('## 1c. CONTINUE subcommand');
    assert.ok(start >= 0 && end > start, 'vacuous: sections not found');
    const listAndStatus = DEBUG_WORKFLOW.slice(start, end);
    for (const forbidden of ['gsd-debug-session-manager', 'gsd-debugger', 'Agent(', 'gsd_dispatch']) {
      assert.equal(listAndStatus.includes(forbidden), false, forbidden);
    }
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
    const included = executionContext(body);
    assert.ok(included !== null && included.startsWith('@'), 'no execution_context include in the installed skill');
    assert.ok(included.endsWith('gsd-core/workflows/debug.md'), included);
    assert.ok(fs.existsSync(path.join(configDir, 'gsd-core', 'workflows', 'debug.md')));
  });
});
