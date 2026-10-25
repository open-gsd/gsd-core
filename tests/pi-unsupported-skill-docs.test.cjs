'use strict';

/**
 * #5569, #5630: the Pi how-to page and the Pi skill converter state the same partly supported skill
 * and reason. The converter's skill table and the page are two surfaces for one fact (CLAUDE.md,
 * generative fix divergence), so this fails when either changes alone.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { convertClaudeCommandToPiSkill } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const PAGE = path.join(__dirname, '..', 'docs', 'how-to', 'start-a-gsd-workflow-from-pi.md');
const DEBUG_COMMAND = path.join(__dirname, '..', 'commands', 'gsd', 'debug.md');
const REASON = 'needs nested dispatch; Pi dispatch is flat';

test('the how-to page names /skill:gsd-debug list and status as supported and the rest with the reason the skill prints', () => {
  const doc = fs.readFileSync(PAGE, 'utf8');
  assert.ok(doc.includes('/skill:gsd-debug'));
  assert.ok(doc.includes('/skill:gsd-debug list'));
  assert.ok(doc.includes('/skill:gsd-debug status'));
  assert.ok(doc.includes(REASON));
  const skill = convertClaudeCommandToPiSkill(fs.readFileSync(DEBUG_COMMAND, 'utf8'), 'gsd-debug');
  assert.ok(skill.includes(REASON));
});
