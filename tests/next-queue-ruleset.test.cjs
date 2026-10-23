'use strict';

// #5605 — the merge-queue ruleset spec for the default branch.
//
// The file is committed, not applied: scripts/sync-rulesets.sh creates every
// ruleset under .github/rulesets/ and overrides `enforcement` with its own
// $ENFORCEMENT. So what this suite pins is the shape that matters when a
// maintainer does apply it — the merge method, a valid timeout, and that the
// committed file itself never ships as `active`.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RULESETS_DIR = path.join(__dirname, '..', '.github', 'rulesets');
const spec = JSON.parse(fs.readFileSync(path.join(RULESETS_DIR, 'next-queue.json'), 'utf8'));
const queueRule = spec.rules.find((rule) => rule.type === 'merge_queue');

describe('#5605: next-queue ruleset spec', () => {
  test('targets the default branch and is named for sync-rulesets.sh to find', () => {
    assert.equal(spec.name, 'next-queue');
    assert.equal(spec.target, 'branch');
    assert.deepEqual(spec.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
    assert.deepEqual(spec.conditions.ref_name.exclude, []);
  });

  test('carries exactly one rule, the merge queue', () => {
    assert.deepEqual(spec.rules.map((rule) => rule.type), ['merge_queue']);
  });

  test('is never committed as active', () => {
    assert.notEqual(spec.enforcement, 'active');
    assert.ok(['disabled', 'evaluate'].includes(spec.enforcement));
  });

  test('has no bypass actors until the back-merge actor is established from evaluate logs', () => {
    assert.deepEqual(spec.bypass_actors, []);
  });

  test('squashes, so each PR stays one commit on the default branch', () => {
    assert.equal(queueRule.parameters.merge_method, 'SQUASH');
  });

  test('only merges groups whose members all passed', () => {
    assert.equal(queueRule.parameters.grouping_strategy, 'ALLGREEN');
  });

  test('check_response_timeout_minutes is an integer within the REST range 1..360', () => {
    const minutes = queueRule.parameters.check_response_timeout_minutes;
    assert.ok(Number.isInteger(minutes), `expected an integer, got ${JSON.stringify(minutes)}`);
    assert.ok(minutes >= 1 && minutes <= 360, `out of range: ${minutes}`);
  });

  test('group sizing is coherent: min <= max, and builds are bounded', () => {
    const p = queueRule.parameters;
    for (const key of ['max_entries_to_build', 'max_entries_to_merge', 'min_entries_to_merge', 'min_entries_to_merge_wait_minutes']) {
      assert.ok(Number.isInteger(p[key]) && p[key] >= 0, `${key} must be a non-negative integer`);
    }
    assert.ok(p.min_entries_to_merge >= 1);
    assert.ok(p.min_entries_to_merge <= p.max_entries_to_merge);
    assert.ok(p.max_entries_to_build >= 1);
  });

  test('uses no unknown merge_queue parameters', () => {
    assert.deepEqual(Object.keys(queueRule.parameters).sort(), [
      'check_response_timeout_minutes',
      'grouping_strategy',
      'max_entries_to_build',
      'max_entries_to_merge',
      'merge_method',
      'min_entries_to_merge',
      'min_entries_to_merge_wait_minutes',
    ]);
  });
});

describe('#5605: every committed ruleset is well-formed for sync-rulesets.sh', () => {
  for (const file of fs.readdirSync(RULESETS_DIR).filter((f) => f.endsWith('.json'))) {
    test(`${file} has a unique name, a target and a rules array`, () => {
      const doc = JSON.parse(fs.readFileSync(path.join(RULESETS_DIR, file), 'utf8'));
      assert.equal(typeof doc.name, 'string');
      assert.ok(doc.name.length > 0);
      assert.ok(['branch', 'tag'].includes(doc.target));
      assert.ok(Array.isArray(doc.rules) && doc.rules.length > 0);
    });
  }

  test('ruleset names are unique across files', () => {
    const names = fs
      .readdirSync(RULESETS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(RULESETS_DIR, f), 'utf8')).name);
    assert.equal(new Set(names).size, names.length);
  });
});
