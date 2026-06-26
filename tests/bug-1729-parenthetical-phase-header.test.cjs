// allow-test-rule: source-text-is-the-product
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writeRoadmap(tmpDir, phaseHeading) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    '---\nmilestone: v1.0.0\n---\n',
  );
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '## Current Milestone: v1.0.0 - Test',
      '',
      phaseHeading,
      '**Goal:** Verify parenthetical phase headings',
      '',
      '### Phase 27: Next phase',
      '**Goal:** Boundary marker',
      '',
    ].join('\n'),
  );
}

function getPhase(tmpDir, phaseNum) {
  const result = runGsdTools(`roadmap get-phase ${phaseNum} --json`, tmpDir);
  assert.ok(result.success, `command failed: ${result.error || result.output}`);
  return JSON.parse(result.output);
}

describe('bug #1729: parenthetical phase heading tags before colon', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('bug-1729-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('roadmap get-phase finds unpadded phase with parenthetical before colon', () => {
    writeRoadmap(tmpDir, '### Phase 26 (Cluster B): Engine-adapter caveats');

    const payload = getPhase(tmpDir, '26');
    assert.equal(payload.found, true);
    assert.equal(payload.phase_name, 'Engine-adapter caveats');
    assert.equal(payload.goal, 'Verify parenthetical phase headings');
  });

  test('roadmap get-phase preserves padding tolerance with parenthetical before colon', () => {
    writeRoadmap(tmpDir, '### Phase 26 (Cluster B): Engine-adapter caveats');

    const payload = getPhase(tmpDir, '026');
    assert.equal(payload.found, true);
    assert.equal(payload.phase_name, 'Engine-adapter caveats');
  });

  test('roadmap get-phase still supports parenthetical after colon', () => {
    writeRoadmap(tmpDir, '### Phase 26: Engine-adapter caveats (Cluster B)');

    const payload = getPhase(tmpDir, '026');
    assert.equal(payload.found, true);
    assert.equal(payload.phase_name, 'Engine-adapter caveats (Cluster B)');
  });
});
