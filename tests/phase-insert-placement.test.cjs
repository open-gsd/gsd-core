'use strict';

/**
 * #5599: `phase insert` allocated the right decimal number but spliced the new
 * section (and checklist bullet) before the target's existing LATER decimal
 * children, so ROADMAP.md order contradicted the phase numbers
 * (13, 13.2, 13.1, 14). These tests assert ORDER, not just `phase_number`.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function section(num, extra = '') {
  return `### Phase ${num}: Work ${num}\n**Goal:** g${num}\n**Depends on:** none\n**Plans:** 0 plans\n${extra}\n`;
}

function headingRoadmap(nums) {
  return `# Roadmap\n\n## Milestone v1\n\n${nums.map((n) => section(n)).join('\n')}`;
}

function bulletRoadmap(nums) {
  return `# Roadmap\n\n${nums.map((n) => `- [ ] Phase ${n}: Work ${n}`).join('\n')}\n`;
}

function headingOrder(roadmap) {
  return [...roadmap.matchAll(/^#{2,4}\s+Phase\s+(\S+?):/gm)].map((m) => m[1]);
}

function bulletOrder(roadmap) {
  return [...roadmap.matchAll(/^-\s*\[[ x]\]\s*(?:\*\*)?Phase\s+(\S+?):/gm)].map((m) => m[1]);
}

describe('phase insert placement (#5599)', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}');
  });

  afterEach(() => cleanup(tmpDir));

  function insert(args, roadmapText) {
    fs.writeFileSync(roadmapPath, roadmapText);
    const result = runGsdTools(['phase', 'insert', ...args], tmpDir);
    assert.ok(result.success, `phase insert failed: ${result.error}`);
    return { out: JSON.parse(result.output), roadmap: fs.readFileSync(roadmapPath, 'utf8') };
  }

  test('heading roadmap: a new child lands after the existing child, before the next phase', () => {
    const { out, roadmap } = insert(['13', 'Gamma'], headingRoadmap(['13', '13.1', '14']));
    assert.equal(out.phase_number, '13.2');
    assert.deepEqual(headingOrder(roadmap), ['13', '13.1', '13.2', '14']);
  });

  test('--sibling insert after a mid child lands after the later sibling', () => {
    const { out, roadmap } = insert(['13.1', 'Gamma', '--sibling'], headingRoadmap(['13', '13.1', '13.2', '14']));
    assert.equal(out.phase_number, '13.3');
    assert.deepEqual(headingOrder(roadmap), ['13', '13.1', '13.2', '13.3', '14']);
  });

  test('bullet-only roadmap: a new child bullet lands after the existing child bullet', () => {
    const { out, roadmap } = insert(['13', 'Gamma'], bulletRoadmap(['13', '13.1', '14']));
    assert.equal(out.phase_number, '13.2');
    assert.deepEqual(bulletOrder(roadmap), ['13', '13.1', '13.2', '14']);
  });

  test('13.10 sorts after 13.9 (numeric, not lexical)', () => {
    const nums = ['13', '13.1', '13.2', '13.3', '13.4', '13.5', '13.6', '13.7', '13.8', '13.9', '14'];
    const { out, roadmap } = insert(['13', 'Tenth'], headingRoadmap(nums));
    assert.equal(out.phase_number, '13.10');
    assert.deepEqual(headingOrder(roadmap), [...nums.slice(0, -1), '13.10', '14']);
  });

  test('last-child control: inserting under the last child still lands right after it', () => {
    const { out, roadmap } = insert(['13.1', 'Deep'], headingRoadmap(['13', '13.1', '14']));
    assert.equal(out.phase_number, '13.1.1');
    assert.deepEqual(headingOrder(roadmap), ['13', '13.1', '13.1.1', '14']);
  });

  test('no-children control: a first child lands right after its parent', () => {
    const { out, roadmap } = insert(['13', 'First'], headingRoadmap(['13', '14']));
    assert.equal(out.phase_number, '13.1');
    assert.deepEqual(headingOrder(roadmap), ['13', '13.1', '14']);
  });

  test('target is the last phase in the file: the new child is appended after its children', () => {
    const { out, roadmap } = insert(['13', 'Tail'], headingRoadmap(['12', '13', '13.1']));
    assert.equal(out.phase_number, '13.2');
    assert.deepEqual(headingOrder(roadmap), ['12', '13', '13.1', '13.2']);
  });

  test('grandchildren stay inside the parent subtree: new child lands after them', () => {
    const { out, roadmap } = insert(['13', 'Next'], headingRoadmap(['13', '13.1', '13.1.1', '14']));
    assert.equal(out.phase_number, '13.2');
    assert.deepEqual(headingOrder(roadmap), ['13', '13.1', '13.1.1', '13.2', '14']);
  });

  test('negative space: phase 130 is not a descendant of phase 13', () => {
    const { out, roadmap } = insert(['13', 'Child'], headingRoadmap(['13', '130']));
    assert.equal(out.phase_number, '13.1');
    assert.deepEqual(headingOrder(roadmap), ['13', '13.1', '130']);
  });

  test('enumerated placement: 0..4 existing children, nested and sibling, new heading is last of its family', () => {
    for (let k = 0; k <= 4; k++) {
      const children = Array.from({ length: k }, (_, i) => `13.${i + 1}`);
      const base = headingRoadmap(['13', ...children, '14']);

      const nested = insert(['13', 'N'], base);
      assert.deepEqual(
        headingOrder(nested.roadmap),
        ['13', ...children, nested.out.phase_number, '14'],
        `nested insert with ${k} existing children`,
      );

      if (k >= 1) {
        const sibling = insert(['13.1', 'S', '--sibling'], base);
        assert.deepEqual(
          headingOrder(sibling.roadmap),
          ['13', ...children, sibling.out.phase_number, '14'],
          `sibling insert with ${k} existing children`,
        );
      }

      for (const entry of fs.readdirSync(path.join(tmpDir, '.planning', 'phases'))) {
        fs.rmSync(path.join(tmpDir, '.planning', 'phases', entry), { recursive: true, force: true });
      }
    }
  });
});
