'use strict';

/**
 * opencode-command-foreground.test.cjs — OpenCode 2.x runs a command whose selected agent has
 * `mode: subagent` as a background child session unless the command sets `subagent: false`
 * (https://opencode.ai/v2/docs/commands; epic #5331 Phase 2 #5338). GSD commands are interactive and must
 * stay in the foreground, and the converter emits every command through the OpenCode converter.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const { convertClaudeToOpencodeFrontmatter } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const commandFiles = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md')).sort();

test('the command set is non-empty (the audit below is not vacuous)', () => {
  assert.ok(commandFiles.length >= 50, `found ${commandFiles.length} commands`);
});

test('no GSD command selects an agent, so none can be demoted to a background child session', () => {
  const offenders = [];
  for (const file of commandFiles) {
    const fm = parseFrontmatter(fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8'));
    if (fm.agent !== undefined && String(fm.subagent) !== 'false') offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a command with `agent:` must also set `subagent: false` for OpenCode 2.x');
});

test('the OpenCode command converter leaves a command\'s own `subagent:`/`agent:` keys intact', () => {
  const source = '---\nname: gsd:x\ndescription: d\nagent: gsd-planner\nsubagent: false\n---\nBody\n';
  const out = convertClaudeToOpencodeFrontmatter(source, { isAgent: false });
  const fm = parseFrontmatter(out);
  assert.equal(fm.agent, 'gsd-planner');
  assert.equal(String(fm.subagent), 'false');
});
