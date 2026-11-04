'use strict';
// #5723: new-project / new-milestone closing hand-off must name discuss-phase
// as the recommended next step and execute-phase as the step that executes.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  ['commands/gsd/new-project.md', '/gsd:'],
  ['skills/gsd-new-project/SKILL.md', '/gsd-'],
  ['pi/package-skills/gsd-new-project/SKILL.md', '/skill:gsd-'],
  ['commands/gsd/new-milestone.md', '/gsd:'],
  ['skills/gsd-new-milestone/SKILL.md', '/gsd-'],
  ['pi/package-skills/gsd-new-milestone/SKILL.md', '/skill:gsd-'],
];

function handoffLine(rel) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  const found = lines.filter((l) => /^\*\*After( this command)?:\*\*/.test(l));
  assert.equal(found.length, 1, `${rel}: exactly one hand-off line`);
  return found[0];
}

describe('#5723 new-project/new-milestone hand-off next step', () => {
  for (const [rel, prefix] of FILES) {
    test(`${rel} hand-off names discuss, plan, execute in order with ${prefix} form`, () => {
      const line = handoffLine(rel);
      assert.doesNotMatch(line, /start(s)? execution/i);
      const d = line.indexOf(`${prefix}discuss-phase`);
      const p = line.indexOf(`${prefix}plan-phase`);
      const e = line.indexOf(`${prefix}execute-phase`);
      assert.ok(d >= 0, `names ${prefix}discuss-phase`);
      assert.ok(p > d, `${prefix}plan-phase follows ${prefix}discuss-phase`);
      assert.ok(e > p, `${prefix}execute-phase follows ${prefix}plan-phase`);
      assert.match(line.slice(e), /^[^`]+`\s+to execute\./);
    });
  }
});
