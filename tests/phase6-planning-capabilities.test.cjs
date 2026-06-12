// allow-test-rule: source-text-is-the-product
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLAN_PHASE_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const REGISTRY = require('../gsd-core/bin/lib/capability-registry.cjs');

function readPlanPhase() {
  return fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
}

function extractSection(content, heading, nextHeading) {
  const start = content.indexOf(heading);
  assert.notStrictEqual(start, -1, `${heading} must exist`);
  const end = content.indexOf(nextHeading, start);
  assert.notStrictEqual(end, -1, `${nextHeading} must follow ${heading}`);
  return content.slice(start, end);
}

describe('ADR-857 phase 6 planning capability migration', () => {
  test('plan-phase delegates AI integration activation to plan:pre capability hooks', () => {
    const content = readPlanPhase();
    assert.doesNotMatch(
      content,
      /config-get workflow\.ai_integration_phase/,
      'plan-phase must not read workflow.ai_integration_phase directly after capability cutover',
    );
    assert.match(content, /ai-integration/);
    assert.match(content, /loop render-hooks plan:pre/);
  });

  test('plan-phase delegates pattern mapper activation to plan:pre capability hooks', () => {
    const content = readPlanPhase();
    assert.doesNotMatch(
      content,
      /config-get workflow\.pattern_mapper/,
      'plan-phase must not read workflow.pattern_mapper directly after capability cutover',
    );
    const section = extractSection(content, '## 7.8.', '## 7.9.');
    assert.match(section, /PLAN_PRE_HOOKS_JSON/);
    assert.match(section, /pattern-mapper/);
    assert.match(section, /ref\.agent/);
  });

  test('plan-phase generic plan:pre dispatch supports skill and agent step hooks', () => {
    const content = readPlanPhase();
    const section = extractSection(content, '## 5.6.', '## 5.7.');
    assert.match(section, /ref\.skill/);
    assert.match(section, /ref\.agent/);
    assert.match(section, /Agent\(/);
    assert.match(section, /Skill\(/);
  });

  test('research and pattern mapper prompts are capability-owned fragments', () => {
    const planPreSteps = REGISTRY.byLoopPoint['plan:pre'].steps;

    const research = planPreSteps.find((step) => step.capId === 'research');
    assert.ok(research, 'research capability must register a plan:pre step');
    assert.equal(research.ref.agent, 'gsd-phase-researcher');
    assert.match(research.fragment.inline, /Research how to implement Phase/);

    const patternMapper = planPreSteps.find((step) => step.capId === 'pattern-mapper');
    assert.ok(patternMapper, 'pattern-mapper capability must register a plan:pre step');
    assert.equal(patternMapper.ref.agent, 'gsd-pattern-mapper');
    assert.match(patternMapper.fragment.inline, /Extract the list of files to be created\/modified/);
  });
});
