'use strict';
// #5723: new-project / new-milestone closing hand-off must name discuss-phase
// as the recommended next step and execute-phase as the step that executes.
// allow-test-rule: hand-off text in shipped command/skill markdown is the product
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  'commands/gsd/new-project.md',
  'skills/gsd-new-project/SKILL.md',
  'pi/package-skills/gsd-new-project/SKILL.md',
  'commands/gsd/new-milestone.md',
  'skills/gsd-new-milestone/SKILL.md',
  'pi/package-skills/gsd-new-milestone/SKILL.md',
];

function handoffLine(rel) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  const found = lines.filter((l) => /^\*\*After( this command)?:\*\*/.test(l));
  assert.equal(found.length, 1, `${rel}: exactly one hand-off line`);
  return found[0];
}

describe('#5723 new-project/new-milestone hand-off next step', () => {
  for (const rel of FILES) {
    test(`${rel} hand-off names discuss, plan, execute in order`, () => {
      const line = handoffLine(rel);
      assert.doesNotMatch(line, /plan-phase[^;]*start execution/i);
      assert.doesNotMatch(line, /start(s)? execution/i);
      const d = line.indexOf('discuss-phase');
      const p = line.indexOf('plan-phase');
      const e = line.indexOf('execute-phase');
      assert.ok(d >= 0, 'names discuss-phase');
      assert.ok(p > d, 'plan-phase follows discuss-phase');
      assert.ok(e > p, 'execute-phase follows plan-phase');
      assert.match(line.slice(e), /execute/);
    });
  }
});
