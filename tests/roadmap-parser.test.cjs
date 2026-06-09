/**
 * roadmap-parser.cjs — unit tests
 *
 * Covers the 6 functions extracted from core.cjs per ADR-857 rollout
 * phase 2b (#870): stripShippedMilestones, extractCurrentMilestone,
 * replaceInCurrentMilestone, getRoadmapPhaseInternal, getMilestoneInfo,
 * getMilestonePhaseFilter.
 *
 * Includes:
 *   - Behavioral tests against realistic ROADMAP.md content
 *   - Adversarial fixtures (malformed frontmatter, unclosed fences,
 *     headings inside fences, unicode headings, repeated/decimal phase
 *     IDs, mixed CRLF/LF)
 *   - Shim-identity assertions verifying core.cjs re-exports are the
 *     same function objects as roadmap-parser.cjs exports
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const roadmapParser = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const core = require('../gsd-core/bin/lib/core.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

const {
  stripShippedMilestones,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  getRoadmapPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
} = roadmapParser;

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

function writeState(tmpDir, fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), lines.join('\n') + '\n');
}

// ─── Shim-identity assertions ─────────────────────────────────────────────────

describe('roadmap-parser: shim-identity — core.cjs re-exports same function objects', () => {
  test('core.extractCurrentMilestone === roadmapParser.extractCurrentMilestone', () => {
    assert.strictEqual(core.extractCurrentMilestone, roadmapParser.extractCurrentMilestone);
  });
  test('core.stripShippedMilestones === roadmapParser.stripShippedMilestones', () => {
    assert.strictEqual(core.stripShippedMilestones, roadmapParser.stripShippedMilestones);
  });
  test('core.replaceInCurrentMilestone === roadmapParser.replaceInCurrentMilestone', () => {
    assert.strictEqual(core.replaceInCurrentMilestone, roadmapParser.replaceInCurrentMilestone);
  });
  test('core.getRoadmapPhaseInternal === roadmapParser.getRoadmapPhaseInternal', () => {
    assert.strictEqual(core.getRoadmapPhaseInternal, roadmapParser.getRoadmapPhaseInternal);
  });
  test('core.getMilestoneInfo === roadmapParser.getMilestoneInfo', () => {
    assert.strictEqual(core.getMilestoneInfo, roadmapParser.getMilestoneInfo);
  });
  test('core.getMilestonePhaseFilter === roadmapParser.getMilestonePhaseFilter', () => {
    assert.strictEqual(core.getMilestonePhaseFilter, roadmapParser.getMilestonePhaseFilter);
  });
});

// ─── stripShippedMilestones ───────────────────────────────────────────────────

describe('roadmap-parser: stripShippedMilestones', () => {
  test('strips a single <details> block', () => {
    const input = 'before\n<details>\nsome shipped content\n</details>\nafter';
    const result = stripShippedMilestones(input);
    assert.ok(!result.includes('<details>'), 'details tag should be removed');
    assert.ok(!result.includes('shipped content'), 'shipped content should be removed');
    assert.ok(result.includes('before'), 'before content preserved');
    assert.ok(result.includes('after'), 'after content preserved');
  });

  test('strips multiple <details> blocks', () => {
    const input = '<details>\nA\n</details>\nmiddle\n<details>\nB\n</details>\nend';
    const result = stripShippedMilestones(input);
    assert.ok(result.includes('middle'), 'middle content preserved');
    assert.ok(result.includes('end'), 'end content preserved');
    assert.ok(!result.includes('<details>'), 'all details tags removed');
  });

  test('returns unchanged string when no <details> blocks', () => {
    const input = '## v1.0: Launch\n### Phase 1: Setup\n**Goal:** init\n';
    assert.strictEqual(stripShippedMilestones(input), input);
  });

  test('handles case-insensitive <DETAILS> tags', () => {
    const input = '<DETAILS>\nclosed content\n</DETAILS>\nafter';
    const result = stripShippedMilestones(input);
    assert.ok(!result.includes('closed content'), 'content removed');
    assert.ok(result.includes('after'), 'after content preserved');
  });
});

// ─── extractCurrentMilestone ──────────────────────────────────────────────────

describe('roadmap-parser: extractCurrentMilestone', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no cwd — strips <details> only', () => {
    const input = '<details>\nshipped\n</details>\n## v2.0: Next\n### Phase 1: Setup\n';
    const result = extractCurrentMilestone(input);
    assert.ok(!result.includes('<details>'), 'details stripped');
    assert.ok(result.includes('v2.0'), 'version heading preserved');
  });

  test('reads milestone from STATE.md and extracts that section', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    const content = [
      '<details>',
      '<summary>v1.0</summary>',
      '### Phase 1: Old',
      '</details>',
      '## v2.0: Current',
      '### Phase 2-01: Setup',
      '**Goal:** build',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('v2.0'), 'current milestone section included');
    assert.ok(!result.includes('Old'), 'shipped milestone section excluded');
  });

  test('falls back to 🚧 marker when STATE.md has no milestone field', () => {
    writeState(tmpDir, { phase: 'some-phase' });
    const content = [
      '## 🚧 **v2.0 Work in Progress**',
      '### Phase 1: Active',
      '**Goal:** do work',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('v2.0'), 'inferred v2.0 milestone section included');
  });

  test('strips shipped milestones when no STATE.md and no 🚧 marker', () => {
    const content = [
      '<details>',
      '<summary>v1.0 done</summary>',
      '### Phase 1: Done',
      '</details>',
      '## v2.0: Next (no WIP marker)',
      '### Phase 2: Future',
    ].join('\n');

    const result = extractCurrentMilestone(content);
    assert.ok(!result.includes('<details>'), 'details stripped');
    assert.ok(result.includes('v2.0'), 'remaining content preserved');
  });

  test('unicode heading — emoji-prefixed milestone', () => {
    writeState(tmpDir, { milestone: 'v3.0' });
    const content = [
      '## ✅ v1.0: Shipped',
      '## 🚧 v3.0: In Progress',
      '### Phase 3-01: Unicode Héros',
      '**Goal:** тест',
    ].join('\n');
    writeRoadmap(tmpDir, content);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('v3.0'), 'v3.0 heading included');
    assert.ok(result.includes('Unicode'), 'unicode phase name included');
  });

  test('CRLF line endings are handled', () => {
    writeState(tmpDir, { milestone: 'v1.0' });
    const content = '## v1.0: CRLF\r\n### Phase 1: Setup\r\n**Goal:** crlf goal\r\n';
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(result.includes('v1.0'), 'section found despite CRLF');
  });

  test('heading inside fenced code block not confused for milestone boundary', () => {
    writeState(tmpDir, { milestone: 'v1.0' });
    const content = [
      '## v1.0: Current Milestone',
      '### Phase 1: Real Phase',
      '**Goal:** real goal',
      '```markdown',
      '## v2.0: Fake Heading Inside Fence',
      '```',
      '### Phase 2: Also Real',
      '**Goal:** also real',
    ].join('\n');
    writeRoadmap(tmpDir, content);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const result = extractCurrentMilestone(roadmap, tmpDir);
    // The section should include Phase 1 content; the fenced heading should not terminate section early
    assert.ok(result.includes('real goal'), 'phase 1 content included');
    assert.ok(result.includes('Also Real'), 'phase 2 content also included');
  });
});

// ─── replaceInCurrentMilestone ────────────────────────────────────────────────

describe('roadmap-parser: replaceInCurrentMilestone', () => {
  test('replaces in content after last </details> when present', () => {
    const content = '<details>\nold\n</details>\n**Plans:** 0/1 plans';
    const result = replaceInCurrentMilestone(content, /0\/1 plans/, '1/1 plans complete');
    assert.ok(result.includes('1/1 plans complete'), 'replacement applied after </details>');
    assert.ok(result.includes('<details>'), 'details block untouched');
  });

  test('replaces anywhere when no </details> present', () => {
    const content = '**Plans:** 0/1 plans';
    const result = replaceInCurrentMilestone(content, /0\/1 plans/, '1/1 plans complete');
    assert.strictEqual(result, '**Plans:** 1/1 plans complete');
  });

  test('does not replace in shipped sections', () => {
    const content = '<details>\n**Plans:** 0/1 plans\n</details>\n## v2.0\n**Plans:** 0/1 plans';
    const result = replaceInCurrentMilestone(content, /0\/1 plans/, '1/1 plans complete');
    // Only the SECOND occurrence (after </details>) should be replaced
    assert.ok(result.includes('<details>\n**Plans:** 0/1 plans\n</details>'), 'shipped section unchanged');
    assert.ok(result.includes('## v2.0\n**Plans:** 1/1 plans complete'), 'current section updated');
  });
});

// ─── getRoadmapPhaseInternal ──────────────────────────────────────────────────

describe('roadmap-parser: getRoadmapPhaseInternal', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns null when ROADMAP.md missing', () => {
    const result = getRoadmapPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null);
  });

  test('returns null when phaseNum is falsy', () => {
    writeRoadmap(tmpDir, '### Phase 1: Foo\n**Goal:** bar\n');
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, null), null);
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, ''), null);
    assert.strictEqual(getRoadmapPhaseInternal(tmpDir, 0), null);
  });

  test('finds a phase by number', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase 1: Foundation',
      '**Goal:** Set up infrastructure',
      '',
      '### Phase 2: API',
      '**Goal:** Build the API',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '1');
    assert.ok(result !== null, 'result should not be null');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_name, 'Foundation');
    assert.strictEqual(result.goal, 'Set up infrastructure');
  });

  test('returns null for missing phase number', () => {
    writeRoadmap(tmpDir, '### Phase 1: Foo\n**Goal:** bar\n');
    const result = getRoadmapPhaseInternal(tmpDir, '99');
    assert.strictEqual(result, null);
  });

  test('finds milestone-prefixed phase ID (e.g. 2-01)', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, [
      '## v2.0: Current',
      '### Phase 2-01: Alpha',
      '**Goal:** first alpha phase',
      '',
      '### Phase 2-02: Beta',
      '**Goal:** beta phase',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '2-01');
    assert.ok(result !== null);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_name, 'Alpha');
    assert.strictEqual(result.goal, 'first alpha phase');
  });

  test('decimal phase ID (e.g. 1.5)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase 1.5: Intermediate',
      '**Goal:** interstitial step',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '1.5');
    assert.ok(result !== null);
    assert.strictEqual(result.phase_name, 'Intermediate');
  });
});

// ─── getMilestoneInfo ─────────────────────────────────────────────────────────

describe('roadmap-parser: getMilestoneInfo', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns default when ROADMAP.md missing', () => {
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v1.0');
    assert.strictEqual(info.name, 'milestone');
  });

  test('reads version from STATE.md and heading name', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, '## v2.0: The Big Launch\n### Phase 1: Setup\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v2.0');
    assert.match(info.name, /Big Launch/);
  });

  test('falls back to 🚧 WIP marker when STATE.md has no milestone', () => {
    writeRoadmap(tmpDir, '## 🚧 **v1.5 Work In Progress**\n### Phase 1: Do stuff\n');
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v1.5');
    assert.match(info.name, /Work In Progress/i);
  });

  test('extracts from heading when no STATE.md and no WIP marker', () => {
    writeRoadmap(tmpDir, [
      '## v3.0: Future Milestone',
      '### Phase 1: Not started',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    assert.strictEqual(info.version, 'v3.0');
    assert.match(info.name, /Future Milestone/);
  });

  test('skips completed ✅ milestones', () => {
    writeRoadmap(tmpDir, [
      '## ✅ v1.0: Shipped Already',
      '## v2.0: Next Up',
    ].join('\n'));
    const info = getMilestoneInfo(tmpDir);
    // Should not use the ✅-prefixed version as the current milestone
    assert.strictEqual(info.version, 'v2.0');
  });
});

// ─── getMilestonePhaseFilter ──────────────────────────────────────────────────

describe('roadmap-parser: getMilestonePhaseFilter', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns passAll (phaseCount=0) when ROADMAP.md missing', () => {
    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 0);
    assert.strictEqual(filter('anything'), true);
  });

  test('basic milestone phase filter — matches dirs by phase number', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Launch',
      '### Phase 1: Setup',
      '**Goal:** setup',
      '',
      '### Phase 2: Build',
      '**Goal:** build',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter.phaseCount, 2);
    assert.strictEqual(filter('01-setup'), true, '01-setup matches Phase 1');
    assert.strictEqual(filter('02-build'), true, '02-build matches Phase 2');
    assert.strictEqual(filter('03-deploy'), false, '03-deploy not in milestone');
  });

  test('milestone-prefixed phase IDs (e.g. 2-01)', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, [
      '## v2.0: Current',
      '### Phase 2-01: Alpha',
      '### Phase 2-02: Beta',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('02-01-alpha'), true, '02-01 matches Phase 2-01');
    assert.strictEqual(filter('02-02-beta'), true, '02-02 matches Phase 2-02');
    assert.strictEqual(filter('02-03-other'), false, '02-03 not in milestone');
  });

  test('versionOverride uses specified version slice', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Old',
      '### Phase 1: Old Phase',
      '',
      '## v2.0: Current',
      '### Phase 2: New Phase',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir, 'v2.0');
    assert.strictEqual(filter('02-new-phase'), true, 'phase 2 in v2.0 slice');
    assert.strictEqual(filter('01-old-phase'), false, 'phase 1 not in v2.0 slice');
  });

  test('missingExplicitVersion set when version not found in versioned roadmap', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Only Milestone',
      '### Phase 1: Foo',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir, 'v9.9');
    assert.strictEqual(filter.missingExplicitVersion, true, 'missingExplicitVersion should be true');
    assert.strictEqual(filter.phaseCount, 0);
  });

  test('zero-padded phase IDs match unpadded dirs and vice versa', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Padded Test',
      '### Phase 01: Setup',
      '### Phase 02: Build',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('1-setup'), true, 'unpadded dir matches padded Phase 01');
    assert.strictEqual(filter('02-build'), true, 'padded dir matches padded Phase 02');
  });

  test('decimal phase IDs in ROADMAP filter correctly', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Decimal Test',
      '### Phase 1.5: Interstitial',
      '### Phase 2: Normal',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.ok(filter.phaseCount >= 1, 'at least one phase found');
    // Decimal phase IDs are non-numeric so filter should handle them
    assert.strictEqual(filter('1.5-interstitial'), true, 'decimal phase dir matches');
  });

  test('repeated phase IDs — deduplication (no double count)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Repeated',
      '### Phase 1: First',
      '### Phase 1: Duplicate heading',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    // Phase 1 appears twice but should only count once
    assert.strictEqual(filter.phaseCount, 1, 'deduplication: only 1 unique phase');
  });

  test('adversarial: phase heading inside backtick fence is excluded (fix #875)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Real',
      '```',
      '### Phase 999: Fake Phase Inside Fence',
      '```',
      '### Phase 1: Real Phase',
      '**Goal:** real',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    // Phase headings inside fenced code blocks must NOT be counted as real phases.
    // getMilestonePhaseFilter is fence-aware (fix #875).
    assert.strictEqual(filter('01-real'), true, 'real phase matches');
    assert.strictEqual(filter('999-fake'), false, 'fenced phase heading is correctly excluded');
  });

  test('adversarial: unclosed fence block — does not crash', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Unclosed',
      '```',
      '### Phase 1: Inside unclosed fence',
      '**Goal:** unreachable',
      // Intentionally no closing ``` — adversarial fixture
    ].join('\n'));

    // Should not throw regardless of fence parsing behavior
    let filter;
    assert.doesNotThrow(() => {
      filter = getMilestonePhaseFilter(tmpDir);
    }, 'unclosed fence should not throw');
    assert.ok(typeof filter === 'function', 'filter is a function');
  });

  test('adversarial: phase heading inside tilde fence is excluded (fix #875)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Tilde',
      '~~~',
      '### Phase 999: Fake',
      '~~~',
      '### Phase 1: Real',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    // Phase headings inside tilde-fenced code blocks must NOT be counted as real phases.
    // getMilestonePhaseFilter is fence-aware (fix #875).
    assert.strictEqual(filter('01-real'), true, 'real phase matches despite tilde fence');
    assert.strictEqual(filter('999-fake'), false, 'tilde-fenced phase heading is correctly excluded');
  });

  test('adversarial: phase heading inside fence is excluded with CRLF endings (fix #875)', () => {
    const crlf = '## v1.0: CRLF Fence\r\n```\r\n### Phase 999: Fake\r\n```\r\n### Phase 1: Real\r\n';
    writeRoadmap(tmpDir, crlf);
    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('01-real'), true, 'real phase matches in CRLF file');
    assert.strictEqual(filter('999-fake'), false, 'fenced phase excluded in CRLF file');
  });

  test('adversarial: phase headings in back-to-back fences are excluded (fix #875)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Adjacent',
      '```',
      '### Phase 998: Fake A',
      '```',
      '```',
      '### Phase 999: Fake B',
      '```',
      '### Phase 1: Real',
    ].join('\n'));
    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('01-real'), true, 'real phase matches');
    assert.strictEqual(filter('998-fake'), false, 'first fenced phase excluded');
    assert.strictEqual(filter('999-fake'), false, 'second fenced phase excluded');
  });

  test('adversarial: CRLF line endings in roadmap', () => {
    const crlf = '## v1.0: CRLF\r\n### Phase 1: Setup\r\n### Phase 2: Build\r\n';
    writeRoadmap(tmpDir, crlf);
    let filter;
    assert.doesNotThrow(() => { filter = getMilestonePhaseFilter(tmpDir); });
    assert.ok(filter.phaseCount >= 1, 'phases found despite CRLF');
  });

  test('adversarial: mixed CRLF and LF in same file', () => {
    const mixed = '## v1.0: Mixed\r\n### Phase 1: A\n### Phase 2: B\r\n### Phase 3: C\n';
    writeRoadmap(tmpDir, mixed);
    let filter;
    assert.doesNotThrow(() => { filter = getMilestonePhaseFilter(tmpDir); });
    assert.ok(filter.phaseCount >= 1, 'phases found in mixed CRLF/LF');
  });

  test('adversarial: unicode headings', () => {
    writeState(tmpDir, { milestone: 'v1.0' });
    writeRoadmap(tmpDir, [
      '## v1.0: 日本語マイルストーン',
      '### Phase 1: Héros Réalité',
      '### Phase 2: Тест',
    ].join('\n'));

    let filter;
    assert.doesNotThrow(() => { filter = getMilestonePhaseFilter(tmpDir); });
    assert.strictEqual(filter.phaseCount, 2, '2 unicode phases found');
    assert.strictEqual(filter('01-setup'), true, 'phase 1 dir matches');
  });

  test('adversarial: bracket-prefixed phase heading ### [GSD] Phase 2-01:', () => {
    writeState(tmpDir, { milestone: 'v2.0' });
    writeRoadmap(tmpDir, [
      '## v2.0: Bracket',
      '### [GSD] Phase 2-01: Setup',
      '### [GSD] Phase 2-02: Build',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('02-01-setup'), true, 'bracket-prefixed phase 2-01 matched');
    assert.strictEqual(filter('02-02-build'), true, 'bracket-prefixed phase 2-02 matched');
  });
});
