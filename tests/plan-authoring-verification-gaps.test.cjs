/**
 * #4927 — three gaps in the plan-authoring path.
 *
 *  1. An authored count/match acceptance gate was never run against the tree it
 *     gates. Two shapes ship defective and invisible to reading: a gate that
 *     already passes at HEAD (it measures nothing) and a gate whose literal can
 *     never match the real wording (`grep -c quickstart` against `## Quickstart`).
 *  2. A large PLAN.md written by a tool that reported success could be cut off
 *     mid-tag; nothing read the tail back. `verify plan-structure` — which both
 *     the planner and the checker already run — now fails a truncated plan.
 *  3. gsd-planner and planner-reversibility.md gave opposite answers for a
 *     one-way decision the human already settled.
 *
 * (2) is code and is tested behaviourally. (1) and (3) are agent prose, so the
 * instruction text is pinned. Issue #4927.
 */
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FRONTMATTER = [
  '---',
  'phase: 01-test',
  'plan: 01',
  'type: execute',
  'wave: 1',
  'depends_on: []',
  'files_modified: [src/a.js]',
  'autonomous: true',
  'must_haves:',
  '  truths: ["it works"]',
  '---',
  '',
].join('\n');

const TASK = [
  '<task type="auto">',
  '  <name>Do the thing</name>',
  '  <files>src/a.js</files>',
  '  <action>Implement it</action>',
  '  <verify><automated>node --test tests/a.test.js</automated></verify>',
  '  <done>It works</done>',
  '</task>',
].join('\n');

const COMPLETE = `${FRONTMATTER}<objective>Do it</objective>\n\n<tasks>\n${TASK}\n</tasks>\n\n<output>Write the summary</output>\n`;

describe('#4927 verify plan-structure fails a truncated PLAN.md', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempProject();
    fs.mkdirSync(path.join(tmp, '.planning', 'phases', '01-test'), { recursive: true });
  });
  afterEach(() => cleanup(tmp));

  function verify(content) {
    fs.writeFileSync(path.join(tmp, '.planning', 'phases', '01-test', '01-01-PLAN.md'), content);
    const res = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmp);
    assert.ok(res.exitCode === 0 || res.exitCode === 1, `a verdict was delivered, got ${res.exitCode}: ${res.error}`);
    return JSON.parse(res.output);
  }

  const truncated = (out) => (out.errors || []).some((e) => /truncat/i.test(e));

  test('a complete plan is valid and not flagged', () => {
    const out = verify(COMPLETE);
    assert.equal(truncated(out), false, JSON.stringify(out.errors));
    assert.equal(out.valid, true, JSON.stringify(out.errors));
  });

  test('a plan cut off mid-tag is invalid', () => {
    const cut = COMPLETE.slice(0, COMPLETE.indexOf('</tasks>') - 4); // ends inside "</task"
    const out = verify(cut);
    assert.equal(out.valid, false);
    assert.equal(truncated(out), true, JSON.stringify(out.errors));
  });

  test('a plan cut off after a whole task but before </tasks> is invalid', () => {
    const cut = COMPLETE.slice(0, COMPLETE.indexOf('</tasks>'));
    const out = verify(cut);
    assert.equal(out.valid, false);
    assert.equal(truncated(out), true, JSON.stringify(out.errors));
  });

  test('a plan still carrying the incremental-write sentinel is invalid', () => {
    const out = verify(COMPLETE.replace('<output>', '<!-- gsd:write-continue -->\n<output>'));
    assert.equal(out.valid, false);
    assert.equal(truncated(out), true, JSON.stringify(out.errors));
  });

  test('prose containing "<" or an HTML example does not false-positive', () => {
    const body = COMPLETE.replace('Implement it', 'Make sure a < b holds; render a <div> and a <b>bold</b> label');
    const out = verify(body);
    assert.equal(truncated(out), false, JSON.stringify(out.errors));
    assert.equal(out.valid, true, JSON.stringify(out.errors));
  });
});

describe('#4927 authored count/match gates are run before they ship', () => {
  const grounding = read('gsd-core/references/planner-verify-command-grounding.md');
  const planner = read('agents/gsd-planner.md');
  const checker = read('agents/gsd-plan-checker.md');

  test('the planner reference says to run a count/match gate against the current tree and record the baseline', () => {
    assert.match(grounding, /run (it|the gate)[^.]*\b(HEAD|current tree)\b/i);
    assert.match(grounding, /baseline/i);
  });

  test('a gate that already passes at HEAD is named as measuring nothing', () => {
    assert.match(grounding, /already passes at HEAD/i);
  });

  test('a case-mismatched literal is named, with the case-insensitive remedy', () => {
    assert.match(grounding, /case-sensitive/i);
    assert.match(grounding, /grep -(c)?i|-i\b|real casing/i);
  });

  test('the planner points at that section from its grep-gate rule', () => {
    assert.match(planner, /Grep gate hygiene[\s\S]{0,600}planner-verify-command-grounding|baseline/i);
  });

  test('the plan checker runs read-only grep gates and treats the result as a finding', () => {
    assert.match(checker, /read-only/i);
    assert.match(checker, /already passes at HEAD|baseline/i);
  });
});

describe('#4927 the reversibility instructions agree on an already-settled decision', () => {
  const planner = read('agents/gsd-planner.md');
  const reference = read('gsd-core/references/planner-reversibility.md');
  const planMdDoc = read('docs/reference/plan-md.md');

  test('gsd-planner no longer says one-way inserts a checkpoint unconditionally', () => {
    const line = planner.split('\n').find((l) => l.startsWith('**<reversibility>**')) || '';
    assert.match(line, /settled|already (decided|recorded|made)/i);
  });

  test('the reference names every way a decision becomes settled', () => {
    assert.match(reference, /CONTEXT\.md/);
    assert.match(reference, /--ingest|ADR/);
    assert.match(reference, /checkpoint:decision[^.]*(already|prior|earlier)|(already|prior|earlier)[^.]*checkpoint:decision/i);
  });

  test('the reference keeps the checkpoint for a newly surfaced one-way decision', () => {
    assert.match(reference, /newly surfaced/i);
  });

  test('the plan-md schema doc carries the same exception on the one-way row', () => {
    const row = planMdDoc.split('\n').find((l) => l.startsWith('| `one-way`')) || '';
    assert.match(row, /settled|already/i);
  });
});
