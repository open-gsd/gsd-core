/**
 * Regression test for #892: checklist-style roadmap phases (`- [x] **Phase NN: name**`)
 * were silently skipped by `buildRoadmapPhaseVariants()`, causing W007 false positives
 * on every on-disk phase dir when the project uses the checklist ROADMAP format.
 *
 * Covers:
 *  A. Unit-level: `buildRoadmapPhaseVariants()` in validate.cts recognises both
 *     checked (`- [x]`) and unchecked (`- [ ]`) checklist items.
 *  B. Integration: `validate health` emits NO W007 for a checklist-only roadmap
 *     whose phase dirs all appear in the checklist.
 *  C. Integration: `validate consistency` emits NO "exists on disk but not in
 *     ROADMAP.md" warning for the same checklist-only roadmap.
 *
 * Requirements: BUG-892
 */
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const {
  buildRoadmapPhaseVariants,
} = require('../gsd-core/bin/lib/validate.cjs');

// ─── A: Unit-level ────────────────────────────────────────────────────────────

describe('buildRoadmapPhaseVariants — checklist format support (#892)', () => {
  test('matches checked checklist item `- [x] **Phase 01: name**`', () => {
    const content = [
      '# Roadmap',
      '',
      '- [x] **Phase 01: infrastructure-hardening**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(
      roadmapPhases.has('01') || roadmapPhases.has('1'),
      `roadmapPhases should contain a variant of "01", got: ${JSON.stringify([...roadmapPhases])}`
    );
  });

  test('matches checked checklist item with uppercase X `- [X] **Phase 02: foo**`', () => {
    const content = [
      '# Roadmap',
      '',
      '- [X] **Phase 02: feature-work**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(
      roadmapPhases.has('02') || roadmapPhases.has('2'),
      `roadmapPhases should contain a variant of "02", got: ${JSON.stringify([...roadmapPhases])}`
    );
  });

  test('matches unchecked checklist item `- [ ] **Phase 03: name**`', () => {
    // unchecked items are also phases — they just have not been started
    const content = [
      '# Roadmap',
      '',
      '- [ ] **Phase 03: future-work**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(
      roadmapPhases.has('03') || roadmapPhases.has('3'),
      `roadmapPhases should contain a variant of "03", got: ${JSON.stringify([...roadmapPhases])}`
    );
  });

  test('collects all phases from a pure checklist roadmap (no ## headings)', () => {
    const content = [
      '# Roadmap',
      '',
      '- [x] **Phase 01: alpha**',
      '- [x] **Phase 02: beta**',
      '- [ ] **Phase 03: gamma**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    const has = (id) => roadmapPhases.has(id) || roadmapPhases.has(id.replace(/^0+/, '')) || roadmapPhases.has(String(parseInt(id, 10)).padStart(2, '0'));
    assert.ok(has('01'), 'should contain phase 01');
    assert.ok(has('02'), 'should contain phase 02');
    assert.ok(has('03'), 'should contain phase 03');
  });

  test('populates roadmapPhaseVariants with padding-normalised forms for checklist phases', () => {
    const content = [
      '# Roadmap',
      '',
      '- [x] **Phase 01: something**',
    ].join('\n');

    const { roadmapPhaseVariants } = buildRoadmapPhaseVariants(content);
    // phaseVariants() adds both '1' and '01' forms
    assert.ok(
      roadmapPhaseVariants.has('1') || roadmapPhaseVariants.has('01'),
      `roadmapPhaseVariants should contain at least one padding form, got: ${JSON.stringify([...roadmapPhaseVariants])}`
    );
  });

  test('mixed roadmap (headings + checklist) collects phases from both styles', () => {
    const content = [
      '# Roadmap',
      '',
      '## Phase 1: heading-style',
      '',
      '- [x] **Phase 02: checklist-style**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(
      roadmapPhases.has('1') || roadmapPhases.has('01'),
      'should contain heading-style phase 1'
    );
    assert.ok(
      roadmapPhases.has('02') || roadmapPhases.has('2'),
      'should contain checklist-style phase 02'
    );
  });
});

// ─── B: validate health — no W007 for checklist-only roadmaps ────────────────

describe('validate health — checklist-style roadmap phases must not emit W007 (#892)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no W007 when phase dirs match checked checklist entries in ROADMAP.md', () => {
    // Write PROJECT.md, STATE.md, config.json, and a checklist-only ROADMAP.md
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\n## What This Is\n\nTest.\n\n## Core Value\n\nValue.\n\n## Requirements\n\nRequirements.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n## Current Position\n\nPhase 1 in progress.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced', commit_docs: true }, null, 2)
    );

    // Checklist-only ROADMAP: no ## Phase headings, only checklist items
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 01: infrastructure-hardening**',
        '- [x] **Phase 02: feature-work**',
        '',
      ].join('\n')
    );

    // Create matching phase directories on disk
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-infrastructure-hardening'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-feature-work'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const w007s = output.warnings.filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007s.length,
      0,
      `W007 must not fire for phases whose dirs are listed in a checklist-style ROADMAP.md, got: ${JSON.stringify(w007s)}`
    );
  });

  test('W007 still fires when a phase dir is genuinely absent from a checklist roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\n## What This Is\n\nTest.\n\n## Core Value\n\nValue.\n\n## Requirements\n\nRequirements.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n## Current Position\n\nPhase 1 in progress.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced', commit_docs: true }, null, 2)
    );

    // ROADMAP only lists phase 01, not phase 99
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 01: known-phase**',
        '',
      ].join('\n')
    );

    // Phase 01 dir is present but also an orphan phase 99 that is NOT in ROADMAP
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-known-phase'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '99-orphan'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const w007s = output.warnings.filter((w) => w.code === 'W007');
    assert.ok(
      w007s.length > 0,
      `W007 must still fire for a phase dir genuinely not listed in ROADMAP.md, got warnings: ${JSON.stringify(output.warnings)}`
    );
    // Should only flag phase 99, not phase 01
    assert.ok(
      w007s.some((w) => w.message.includes('99')),
      `W007 should reference orphan phase 99, got: ${JSON.stringify(w007s)}`
    );
    assert.ok(
      !w007s.some((w) => w.message.includes('01') || w.message.includes('1')),
      `W007 must NOT flag phase 01 which is in the checklist, got: ${JSON.stringify(w007s)}`
    );
  });
});

// ─── C: validate consistency — no false positive for checklist-only roadmaps ─

describe('validate consistency — checklist-style roadmap phases must not emit false warnings (#892)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no "exists on disk but not in ROADMAP.md" warning for checklist-matched phases', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\n## What This Is\n\nTest.\n\n## Core Value\n\nValue.\n\n## Requirements\n\nRequirements.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n## Current Position\n\nPhase 1 in progress.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced', commit_docs: true }, null, 2)
    );

    // Checklist-only ROADMAP
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 01: infrastructure-hardening**',
        '- [x] **Phase 02: feature-work**',
        '',
      ].join('\n')
    );

    // Create matching phase directories
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-infrastructure-hardening'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-feature-work'), { recursive: true });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // No "exists on disk but not in ROADMAP" warnings for checklist-listed phases
    const diskNotInRoadmapWarnings = (output.warnings || []).filter(
      (w) => typeof w === 'string'
        ? w.includes('exists on disk but not in ROADMAP')
        : (w.message || '').includes('exists on disk but not in ROADMAP')
    );
    assert.strictEqual(
      diskNotInRoadmapWarnings.length,
      0,
      `No "exists on disk but not in ROADMAP.md" warnings should fire for checklist-listed phases, got: ${JSON.stringify(diskNotInRoadmapWarnings)}`
    );
  });
});
