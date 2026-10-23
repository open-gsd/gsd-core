/**
 * #5583 — `/gsd-phase --insert` must document and forward `--sibling`
 * (#4569), accept a decimal <after> phase, and say that inserting after a
 * decimal phase nests by default. Text pins on the shipped prompt files.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const WORKFLOW = read('gsd-core/workflows/insert-phase.md');
const ROUTERS = [
  'commands/gsd/phase.md',
  'skills/gsd-phase/SKILL.md',
  'pi/package-skills/gsd-phase/SKILL.md',
];

describe('#5583 insert-phase --sibling', () => {
  test('workflow accepts a decimal <after> phase', () => {
    assert.doesNotMatch(WORKFLOW, /integer phase number to insert after/);
    assert.doesNotMatch(WORKFLOW, /Validate first argument is an integer/);
    assert.match(WORKFLOW, /Validate first argument is a phase number \(integer or decimal\)/);
  });

  test('workflow parses --sibling out of the description and forwards it', () => {
    assert.match(WORKFLOW, /--sibling/);
    assert.match(WORKFLOW, /never part of the description/);
    assert.match(WORKFLOW, /phase\.insert "\$\{after_phase\}" "\$\{description\}" \$\{sibling_flag:\+"\$sibling_flag"\}/);
  });

  test('workflow documents nest-by-default and the top-level fallback', () => {
    assert.match(WORKFLOW, /inserting after a decimal phase nests by default/i);
    assert.match(WORKFLOW, /15\.2 --sibling[\s\S]*15\.3/);
    assert.match(WORKFLOW, /top-level[^\n]*falls back to nested/i);
  });

  for (const file of ROUTERS) {
    test(`${file} lists --sibling in the insert routing`, () => {
      const text = read(file);
      assert.match(text, /\[--sibling\]/);
      assert.match(text, /nests? by default/i);
    });
  }
});
