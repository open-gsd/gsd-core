'use strict';

/**
 * #5569, #5630, #5638: the Pi how-to page and the Pi skill converter state the same /gsd-debug
 * behavior. The converter's loop-skill table and the page are two surfaces for one fact (CLAUDE.md,
 * generative fix divergence), so this fails when either changes alone.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { convertClaudeCommandToPiSkill, PI_LOOP_SKILLS } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const PAGE = path.join(__dirname, '..', 'docs', 'how-to', 'start-a-gsd-workflow-from-pi.md');
const DEBUG_COMMAND = path.join(__dirname, '..', 'commands', 'gsd', 'debug.md');

test('the how-to page names every /skill:gsd-debug form, the role it dispatches and the limits the skill states', () => {
  const doc = fs.readFileSync(PAGE, 'utf8');
  const { role, driver } = PI_LOOP_SKILLS['gsd-debug'];
  for (const form of ['list', 'status <slug>', 'continue <slug>', '--diagnose']) {
    assert.ok(doc.includes(`/skill:gsd-debug ${form}`), `${form} missing from the page`);
  }
  assert.ok(doc.includes(role) && doc.includes(driver));
  assert.ok(doc.includes('plain-text'), 'the plain-text prompt path is not stated');
  assert.ok(doc.includes('specialist'), 'the specialist-review limit is not stated');
  const skill = convertClaudeCommandToPiSkill(fs.readFileSync(DEBUG_COMMAND, 'utf8'), 'gsd-debug');
  assert.ok(skill.includes('Specialist skill review is not run on Pi'));
  assert.ok(skill.includes(`gsd_dispatch(role="${role}"`));
});

test('the page no longer says new, continue and --diagnose cannot run on Pi', () => {
  const doc = fs.readFileSync(PAGE, 'utf8');
  assert.equal(doc.includes('needs nested dispatch; Pi dispatch is flat'), false);
  assert.equal(doc.includes('only `/skill:gsd-debug list`'), false);
});
