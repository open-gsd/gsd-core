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

  test('#557: preserves an active <details open> block while stripping shipped bare <details>', () => {
    // <details open> marks the ACTIVE milestone (roadmap.analyze must still see its
    // phases); only closed/shipped bare <details> blocks are stripped. Regression for
    // #557, which the #2128 shared-seam migration briefly reintroduced via the seam's
    // attribute-tolerance — the details strip is now attr-INTOLERANT to keep #557 fixed.
    const input = '<details>\nshipped phase\n</details>\n<details open>\n- [ ] **Phase 9: Active**\n</details>\nafter';
    const result = stripShippedMilestones(input);
    assert.ok(!result.includes('shipped phase'), 'shipped bare <details> stripped');
    assert.ok(result.includes('<details open>'), 'active <details open> tag preserved');
    assert.ok(result.includes('Phase 9: Active'), 'active-milestone phases preserved');
    assert.ok(result.includes('after'), 'trailing content preserved');
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

  test('finds drifted project-code-prefixed headings by bare number (#1455)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase MANIFOLD-117: Prefixed Heading',
      '**Goal:** Recover from roadmapper heading drift',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '117');
    assert.ok(result !== null, 'bare number lookup should tolerate a prefixed heading');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, '117');
    assert.strictEqual(result.phase_name, 'Prefixed Heading');
    assert.strictEqual(result.goal, 'Recover from roadmapper heading drift');
  });

  test('finds drifted project-code-prefixed headings by prefixed query (#1455)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase MANIFOLD-117: Prefixed Heading',
      '**Goal:** Exact prefixed lookup works on init resolver',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, 'MANIFOLD-117');
    assert.ok(result !== null, 'prefixed lookup should resolve the matching prefixed heading');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, 'MANIFOLD-117');
    assert.strictEqual(result.phase_name, 'Prefixed Heading');
    assert.strictEqual(result.goal, 'Exact prefixed lookup works on init resolver');
  });

  test('prefers canonical bare heading before prefixed drift fallback (#1455)', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase MANIFOLD-117: Prefixed Heading',
      '**Goal:** Drift fallback',
      '',
      '### Phase 117: Bare Heading',
      '**Goal:** Canonical bare',
    ].join('\n'));

    const result = getRoadmapPhaseInternal(tmpDir, '117');
    assert.ok(result !== null, 'bare lookup should resolve');
    assert.strictEqual(result.phase_name, 'Bare Heading');
    assert.strictEqual(result.goal, 'Canonical bare');
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

  test('single-digit slug word after a phase number is not wrongly excluded (#2043)', () => {
    // The roadmap uses milestone-prefixed hyphenated phase IDs (e.g. "2-01"),
    // which switches getMilestonePhaseFilter's dir-matching regex into
    // hyphenated mode. Phase 46's roadmap name "6 Rs Pipeline Orchestrator"
    // slugifies to a dir starting with a single-digit word ("46-6-rs-…").
    // Before #2043, the hyphenated-mode regex over-collected that single
    // digit into the phase token ("46-6"), which never matched the roadmap's
    // "46" phase number, so the dir was wrongly excluded from the milestone.
    writeState(tmpDir, { milestone: 'v1.0' });
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase 2-01: Alpha',
      '**Goal:** first alpha phase',
      '',
      '### Phase 46: 6 Rs Pipeline Orchestrator',
      '**Goal:** orchestrate the rs',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(
      filter('46-6-rs-pipeline-orchestrator'),
      true,
      '46-6-rs-pipeline-orchestrator (phase 46, single-digit slug word "6") must match Phase 46',
    );
    // Legit milestone-prefixed dir still matches as before.
    assert.strictEqual(filter('02-01-alpha'), true, '02-01-alpha matches Phase 2-01');
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


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2554-decimal-phase-filter.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2554-decimal-phase-filter (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2554:
 * state disk-scan excludes decimal phase dirs (e.g. "00.1") from progress counts.
 *
 * Root cause: getMilestonePhaseFilter normalized phase IDs with `replace(/^0+/, '')`,
 * which over-strips on decimals: "00.1" → ".1", while the disk-side extractor
 * applied to "00.1-<slug>" yields "0.1" — so the dir is excluded from the milestone.
 *
 * Fix: strip leading zeros only when followed by a digit (`replace(/^0+(?=\d)/, '')`),
 * preserving the zero before the decimal point.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { getMilestonePhaseFilter } = require('../gsd-core/bin/lib/roadmap-parser.cjs');

describe('bug #2554 — getMilestonePhaseFilter decimal phase dirs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('matches decimal phase directory like "00.1-<slug>" against ROADMAP phase "00.1"', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v1.0: Current',
        '',
        '### Phase 0: Foundation',
        '**Goal:** foundation',
        '',
        '### Phase 00.1: Inserted urgent work',
        '**Goal:** inserted',
        '',
        '### Phase 1: Feature',
        '**Goal:** feature',
      ].join('\n')
    );

    const filter = getMilestonePhaseFilter(tmpDir);

    // Phase 00.1 inserted between Phase 0 and Phase 1 must match its on-disk dir.
    assert.strictEqual(
      filter('00.1-app-namespace-rename'),
      true,
      'decimal phase dir "00.1-<slug>" must be counted in the milestone'
    );

    // Neighbours should still match (no regression).
    assert.strictEqual(filter('0-foundation'), true);
    assert.strictEqual(filter('1-feature'), true);
  });

  test('preserves existing behavior for zero-padded integer phases', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v1.0: Current',
        '',
        '### Phase 01: One',
        '**Goal:** g',
        '',
        '### Phase 10: Ten',
        '**Goal:** g',
      ].join('\n')
    );

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('01-one'), true);
    assert.strictEqual(filter('10-ten'), true);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-730-milestone-phase-details-scope.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-730-milestone-phase-details-scope (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #730: phase details defined under a milestone-scoped
 * "## Milestone vX.Y — … (Phase Details)" section are invisible to phase
 * resolution (getRoadmapPhaseInternal / init phase-op) when the flat shared
 * "## Phase Details" section for an earlier milestone sits between the shared
 * ## Phases checklist and the per-milestone Phase Details section.
 *
 * The bug manifests ONLY before any .planning/phases/ directory exists because
 * findPhaseInternal masks it once the dir is created. RED step — tests 1 and 3
 * are expected to fail against current code.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Shared fixture content
// ---------------------------------------------------------------------------

const STATE_CONTENT = `---
milestone: v1.1
---
`;

const ROADMAP_CONTENT = `# Roadmap: Example

## Phases

- [x] **Phase 1: Setup** — initial scaffold

### Milestone v1.1 — Second milestone (added 2026-01-01)

- [ ] **Phase 2: Feature** — the new thing

## Phase Details

### Phase 1: Setup
**Goal:** scaffold the app.

## Milestone v1.1 — Second milestone (Phase Details)

### Phase 2: Feature
**Goal:** build the new thing.
`;

// ---------------------------------------------------------------------------
// Helper: create a bare project with .planning/ but NO .planning/phases/ dir
// ---------------------------------------------------------------------------

function createBareProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-'));
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('bug #730 — milestone (Phase Details) section scope resolution', () => {
  let dir;

  beforeEach(() => {
    dir = createBareProject();
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), STATE_CONTENT, 'utf-8');
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), ROADMAP_CONTENT, 'utf-8');
  });

  afterEach(() => {
    cleanup(dir);
  });

  // -------------------------------------------------------------------------
  // Test 1 (AC1): init phase-op resolves phase defined only under its
  // per-milestone "(Phase Details)" section
  // -------------------------------------------------------------------------
  test('init phase-op resolves a current-milestone phase defined only under its (Phase Details) section', () => {
    const r = runGsdTools('init phase-op 2', dir);
    assert.ok(r.success, `init phase-op 2 failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}, expected_phase_dir=${out.expected_phase_dir}`);
    assert.strictEqual(out.phase_name, 'Feature', `phase_name should be 'Feature'; got '${out.phase_name}'`);
    assert.strictEqual(out.padded_phase, '02', `padded_phase should be '02'; got '${out.padded_phase}'`);
    assert.strictEqual(out.expected_phase_dir, '.planning/phases/02-feature', `expected_phase_dir should be '.planning/phases/02-feature'; got '${out.expected_phase_dir}'`);
  });

  // -------------------------------------------------------------------------
  // Test 2 (AC4): first-milestone phase still resolves via the flat
  // "## Phase Details" section — no regression
  // -------------------------------------------------------------------------
  test('init phase-op still resolves a first-milestone phase (no regression on flat Phase Details)', () => {
    const r = runGsdTools('init phase-op 1', dir);
    assert.ok(r.success, `init phase-op 1 failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.phase_found, true, `phase_found should be true for phase 1; got ${out.phase_found}`);
    assert.strictEqual(out.phase_name, 'Setup', `phase_name should be 'Setup'; got '${out.phase_name}'`);
  });

  // -------------------------------------------------------------------------
  // Test 3 (AC5): getRoadmapPhaseInternal resolves the current-milestone phase
  // directly before any phases/ dir exists
  // -------------------------------------------------------------------------
  test('getRoadmapPhaseInternal resolves the current-milestone phase directly before any dir exists', () => {
    const { getRoadmapPhaseInternal } = require('../gsd-core/bin/lib/roadmap-parser.cjs');

    const res = getRoadmapPhaseInternal(dir, '2');
    assert.ok(res !== null && res !== undefined, `getRoadmapPhaseInternal returned null/undefined for phase 2`);
    assert.strictEqual(res.found, true, `res.found should be true; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.phase_name, 'Feature', `res.phase_name should be 'Feature'; got '${res.phase_name}'`);
  });

  // -------------------------------------------------------------------------
  // Test 4 (AC3): validate health raises W006 for a current-milestone phase
  // defined under (Phase Details) with no directory on disk.
  //
  // Before the fix, extractCurrentMilestone's slice stopped before the
  // "## Milestone v1.1 — … (Phase Details)" section, so phase 2's
  // "### Phase 2: Feature" header was invisible and W006 was never raised.
  // After the fix the slice includes that section and W006 is emitted.
  //
  // This test uses its OWN local fixture (separate tmpdir) so it does not
  // disturb the shared beforeEach/afterEach fixture used by tests 1–3.
  // -------------------------------------------------------------------------
  test('validate health raises W006 for a started current-milestone phase defined under (Phase Details) with no directory', () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t4-'));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      // STATE.md — milestone: v1.1
      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v1.1\n---\n`,
        'utf-8',
      );

      // ROADMAP.md — phase 2 is [x] (started/complete) so the not-started
      // guard does NOT suppress W006.  Phase 2's details live exclusively in
      // the per-milestone "(Phase Details)" section (the blind-spot pre-fix).
      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        `# Roadmap: Example\n\n## Phases\n\n- [x] **Phase 1: Setup** — initial scaffold\n\n### Milestone v1.1 — Second milestone (added 2026-01-01)\n\n- [x] **Phase 2: Feature** — the new thing\n\n## Phase Details\n\n### Phase 1: Setup\n**Goal:** scaffold the app.\n\n## Milestone v1.1 — Second milestone (Phase Details)\n\n### Phase 2: Feature\n**Goal:** build the new thing.\n`,
        'utf-8',
      );

      // Create the phase 1 directory so phase 1 does NOT trigger W006.
      // Phase 2 has NO directory — that's the missing-dir condition under test.
      fs.mkdirSync(path.join(planning, 'phases', '01-setup'), { recursive: true });

      const result = runGsdTools(['validate', 'health'], localDir);
      const payload = JSON.parse(result.output);
      const warnings = payload.warnings || [];

      // Find a W006 entry whose message references phase 2 (by number or name).
      const w006ForPhase2 = warnings.find(
        (w) =>
          w.code === 'W006' &&
          (/\b2\b/.test(w.message) || /\b02\b/.test(w.message) || /Feature/i.test(w.message)),
      );

      assert.ok(
        w006ForPhase2 != null,
        `Expected a W006 warning referencing phase 2 (Feature) — phase 2 is started ([x]) and has no directory on disk, ` +
          `but its ### Phase 2: header lives in the Milestone v1.1 (Phase Details) section which was invisible before the fix. ` +
          `Got warnings: ${JSON.stringify(warnings)}`,
      );
    } finally {
      cleanup(localDir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: three-milestone roadmap, current = latest (v1.2)
  // -------------------------------------------------------------------------
  test('init phase-op resolves the latest milestone phase in a 3-milestone roadmap', () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t5-'));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v1.2\n---\n`,
        'utf-8',
      );

      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        `# Roadmap: Example\n\n## Phases\n\n- [x] **Phase 1: Setup** — done\n\n### Milestone v1.1 — Second (added 2026-01-01)\n\n- [x] **Phase 2: Feature** — done\n\n### Milestone v1.2 — Third (added 2026-02-01)\n\n- [ ] **Phase 3: Polish** — current\n\n## Phase Details\n\n### Phase 1: Setup\n**Goal:** scaffold.\n\n## Milestone v1.1 — Second (Phase Details)\n\n### Phase 2: Feature\n**Goal:** build.\n\n## Milestone v1.2 — Third (Phase Details)\n\n### Phase 3: Polish\n**Goal:** refine.\n`,
        'utf-8',
      );

      const r = runGsdTools('init phase-op 3', localDir);
      assert.ok(r.success, `init phase-op 3 failed: ${r.error}`);

      const out = JSON.parse(r.output);
      assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}`);
      assert.strictEqual(out.phase_name, 'Polish', `phase_name should be 'Polish'; got '${out.phase_name}'`);
      assert.strictEqual(out.padded_phase, '03', `padded_phase should be '03'; got '${out.padded_phase}'`);
      assert.strictEqual(out.expected_phase_dir, '.planning/phases/03-polish', `expected_phase_dir should be '.planning/phases/03-polish'; got '${out.expected_phase_dir}'`);
    } finally {
      cleanup(localDir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: sub-milestone sharing a version prefix — closed sibling must NOT
  // cross-pollinate into the active milestone's Phase Details lookup (#730)
  // -------------------------------------------------------------------------
  test('init phase-op anchors Phase Details to the selected sub-milestone, not a closed same-prefix sibling', () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t6-'));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      // STATE.md — milestone: v3.0 (matches v3.0-B active slice)
      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v3.0\n---\n`,
        'utf-8',
      );

      // ROADMAP.md — v3.0-A is SHIPPED (closed), v3.0-B is active.
      // The Phase Details for v3.0-A comes FIRST — without version-boundary
      // anchoring the old code would grab it (first non-closed (Phase Details)
      // heading outside the window), returning phase_name='Alpha' instead of 'Beta'.
      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        [
          '# Roadmap: Example',
          '',
          '## Phases',
          '',
          '### Milestone v3.0-A — First slice (added 2026-01-01) ✅ SHIPPED',
          '',
          '- [x] **Phase 1: Alpha** — done',
          '',
          '### Milestone v3.0-B — Second slice (added 2026-02-01)',
          '',
          '- [ ] **Phase 2: Beta** — current',
          '',
          '## Phase Details',
          '',
          '## Milestone v3.0-A — First slice (Phase Details)',
          '',
          '### Phase 1: Alpha',
          '**Goal:** alpha goal.',
          '',
          '## Milestone v3.0-B — Second slice (Phase Details)',
          '',
          '### Phase 2: Beta',
          '**Goal:** beta goal.',
          '',
        ].join('\n'),
        'utf-8',
      );

      const r = runGsdTools('init phase-op 2', localDir);
      assert.ok(r.success, `init phase-op 2 failed: ${r.error}`);

      const out = JSON.parse(r.output);
      assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}, output=${JSON.stringify(out)}`);
      assert.strictEqual(out.phase_name, 'Beta', `phase_name should be 'Beta' (v3.0-B section), not '${out.phase_name}' (would indicate v3.0-A cross-pollination)`);
      assert.strictEqual(out.expected_phase_dir, '.planning/phases/02-beta', `expected_phase_dir should be '.planning/phases/02-beta'; got '${out.expected_phase_dir}'`);
    } finally {
      cleanup(localDir);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3128-roadmap-plan-count-slug-layout.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3128-roadmap-plan-count-slug-layout (consolidation epic #1969 B3 #1972)", () => {
'use strict';
// allow-test-rule: reads roadmap.cjs source to verify isPlanFile pattern was adopted — structural contract prevents silent regression to old filter (see #3128)

// Regression guard for bug #3128.
//
// roadmap.cjs countPhasePlansAndSummaries() used to filter plan files with:
//   f.endsWith('-PLAN.md') || f === 'PLAN.md'
// This misses the {N}-PLAN-{NN}-{slug}.md layout that gsd-plan-phase
// actually writes (e.g. 5-PLAN-01-setup-database.md), ending in -database.md.
// Result: init manager returned plan_count=0 and disk_status='discussed' for
// fully-planned phases, triggering unnecessary background planner agents.
//
// Root cause: same regex flaw as #2893 (fixed in phase.cjs via #2896), but
// the manager-dashboard path in roadmap.cjs was not updated alongside it.
//
// Fix: apply the same looksLikePlanFile logic from phase.cjs to roadmap.cjs.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// Require the module under test directly
const roadmapLib = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'roadmap.cjs');
const planScanLib = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'plan-scan.cjs');

// We test countPhasePlansAndSummaries indirectly via getManagerInfo since
// it is not exported. We build a real phaseDir on disk and call the full
// roadmap.cjs init manager path via its exported helper, or fall back to
// direct filesystem inspection of what the filter would produce.
// The simplest correct seam: inspect the source for the regex pattern and
// validate with a synthetic directory that the manager path returns correct counts.


// Import countPhasePlansAndSummaries by monkey-patching: we inline the
// fixed filter logic and verify it matches the file on disk.
// Since the function is module-private, we validate via its public caller
// by using the exported analyzeRoadmap / getPhaseInfo path with a
// synthetic .planning/ directory tree.

describe('bug #3128: roadmap.cjs plan-count for {N}-PLAN-{NN}-{slug}.md layout', () => {

  test('isPlanFile rejects PLAN-OUTLINE and pre-bounce derivatives', () => {
    // Inlined from fix — mirrors the exact logic in the fix
    const PLAN_OUTLINE_RE = /-PLAN-OUTLINE\.md$/i;
    const PLAN_PRE_BOUNCE_RE = /-PLAN.*\.pre-bounce\.md$/i;
    const isPlanFile = (f) =>
      (f.endsWith('-PLAN.md') || f === 'PLAN.md') ||
      (/\.md$/i.test(f) && /PLAN/i.test(f) && !PLAN_OUTLINE_RE.test(f) && !PLAN_PRE_BOUNCE_RE.test(f));

    // canonical forms — must match
    assert.ok(isPlanFile('PLAN.md'),              'PLAN.md must match');
    assert.ok(isPlanFile('5-PLAN.md'),            '5-PLAN.md must match');
    assert.ok(isPlanFile('05-PLAN.md'),           '05-PLAN.md must match');

    // slug form — was the bug; must now match
    assert.ok(isPlanFile('5-PLAN-01-setup.md'),          '5-PLAN-01-setup.md must match');
    assert.ok(isPlanFile('05-PLAN-02-database.md'),       '05-PLAN-02-database.md must match');
    assert.ok(isPlanFile('5-PLAN-DELTA-2026-05-05.md'),  '5-PLAN-DELTA-2026-05-05.md must match');

    // derivative files — must NOT match
    assert.ok(!isPlanFile('5-PLAN-OUTLINE.md'),             'PLAN-OUTLINE must not match');
    assert.ok(!isPlanFile('5-PLAN-01.pre-bounce.md'),       'pre-bounce must not match');
    assert.ok(!isPlanFile('CONTEXT.md'),                    'CONTEXT.md must not match');
    assert.ok(!isPlanFile('SUMMARY.md'),                    'SUMMARY.md must not match');
    assert.ok(!isPlanFile('5-RESEARCH.md'),                 'RESEARCH.md must not match');
  });

  test('roadmap.cjs source uses the extended isPlanFile filter', () => {
    const roadmapSrc = fs.readFileSync(roadmapLib, 'utf8');
    // Verify the fix is in place: the old simple inline filter is gone from roadmap.cjs
    assert.ok(
      !roadmapSrc.includes("phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md')"),
      'Old simple plan filter still present in roadmap.cjs — fix not applied',
    );
    // roadmap.cjs now delegates to plan-scan.cjs via require('./plan-scan.cjs')
    assert.ok(
      roadmapSrc.includes('plan-scan.cjs'),
      'roadmap.cjs does not require plan-scan.cjs — delegation not applied',
    );
    // plan-scan.cjs is where the extended plan-file detection logic lives (isRootPlanFile)
    const planScanSrc = fs.readFileSync(planScanLib, 'utf8');
    assert.ok(
      planScanSrc.includes('isRootPlanFile') && planScanSrc.includes('/PLAN/i'),
      'isRootPlanFile with /PLAN/i not found in plan-scan.cjs — canonical helper missing extended filter',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-500-planned-phase-progress-corruption.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-500-planned-phase-progress-corruption (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #500: `state planned-phase` corrupts STATE.md milestone progress.* counters.
 *
 * Two independent defects:
 *
 * RC1 — plan-phase resyncs progress it should not touch.
 *   cmdStatePlannedPhase wrote via writeStateMd, which unconditionally runs
 *   syncStateFrontmatter and rebuilds progress.* from a half-planned disk
 *   snapshot, trampling curated counters. It must route through
 *   readModifyWriteStateMd(..., { resync: false }) like other body-only writes.
 *
 * RC2 — isRootPlanFile double-counts legacy `<N>-PLAN-<NN>-SUMMARY.md` as a plan.
 *   The final `/PLAN/i` fallback matches the substring "PLAN" inside a legacy
 *   summary name, so a 4-plan/4-summary phase scans as planCount:8 / completed:false
 *   instead of planCount:4 / completed:true. A summary is never a plan.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const planScan = require('../gsd-core/bin/lib/plan-scan.cjs');
const { isRootPlanFile, scanPhasePlans } = planScan;

describe('isRootPlanFile does not count legacy summaries as plans (#500 RC2)', () => {
  test('legacy <N>-PLAN-<NN>-SUMMARY.md is not a root plan file', () => {
    assert.equal(isRootPlanFile('14-PLAN-01-SUMMARY.md'), false);
  });

  test('legacy <N>-PLAN-<NN>.md is still a root plan file', () => {
    assert.equal(isRootPlanFile('14-PLAN-01.md'), true);
  });

  test('canonical -PLAN.md is still a root plan file', () => {
    assert.equal(isRootPlanFile('01-PLAN.md'), true);
  });

  test('a 4-plan / 4-summary legacy phase scans as planCount:4 completed:true', () => {
    const tmp = createTempProject();
    const phaseDir = path.join(tmp, '.planning', 'phases', '14-legacy');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let i = 1; i <= 4; i++) {
      const nn = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `14-PLAN-${nn}.md`), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(phaseDir, `14-PLAN-${nn}-SUMMARY.md`), '# Summary\n', 'utf-8');
    }
    try {
      const scan = scanPhasePlans(phaseDir);
      assert.equal(scan.planCount, 4, `expected 4 plans, got ${scan.planCount}`);
      assert.equal(scan.summaryCount, 4, `expected 4 summaries, got ${scan.summaryCount}`);
      assert.equal(scan.completed, true, 'a fully-summarized phase must scan as completed');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('state planned-phase preserves curated milestone progress.* (#500 RC1)', () => {
  let tmpDir;

  // Curated progress counters that deliberately do NOT match what a disk scan
  // would derive (disk has only one near-empty phase dir). The bug rebuilds
  // progress.* from that disk snapshot, trampling these values.
  const STATE = `---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Active
status: in_progress
progress:
  total_phases: 7
  completed_phases: 5
  total_plans: 99
  completed_plans: 88
  percent: 88
---

# Project State

## Configuration
Current Phase: 2
Current Phase Name: builder
Total Plans in Phase: 0
Status: Not started
Last Activity: TBD
Last Activity Description: pending

## Current Position

Phase: 2 (builder)
Status: Not started
Last activity: TBD
`;

  beforeEach(() => {
    tmpDir = createTempProject();
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE, 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      '# Roadmap\n\n## 🚧 v3.0: Active\n\n### Phase 2: builder\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    // One sparse phase dir so a disk resync would derive small/zero counters.
    const dir = path.join(planning, 'phases', '02-builder');
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function readProgress() {
    const md = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const block = md.split('---')[1] || '';
    const num = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(\\d+)`));
      return m ? Number(m[1]) : null;
    };
    return {
      total_plans: num('total_plans'),
      completed_plans: num('completed_plans'),
      total_phases: num('total_phases'),
      completed_phases: num('completed_phases'),
    };
  }

  test('planned-phase updates per-phase body fields but leaves milestone progress.* untouched', () => {
    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--plans', '3'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    // The command did its real job: per-phase "Total Plans in Phase" was set.
    const md = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(md, /Total Plans in Phase:\s*3/, 'per-phase Total Plans in Phase should be updated to 3');

    // ...but the curated milestone-wide progress block is preserved verbatim.
    assert.deepEqual(readProgress(), {
      total_plans: 99,
      completed_plans: 88,
      total_phases: 7,
      completed_phases: 5,
    }, 'curated milestone progress.* must survive a planned-phase write');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3262-scan-phase-plans.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3262-scan-phase-plans (consolidation epic #1969 B3 #1972)", () => {
/**
 * Tests for the shared scanPhasePlans() helper (k014).
 *
 * Covers:
 *   - Top-level plans only (flat layout)
 *   - Top-level + nested layout (post-#3139)
 *   - Completed-summary detection (summaries >= plans)
 *   - Ignored files (OUTLINE, pre-bounce, CONTEXT, RESEARCH)
 *   - Empty phase dir → { planCount: 0, summaryCount: 0 }
 *   - Parity: helper produces correct counts for mixed flat+nested fixture tree
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

// Helper under test — must exist at this path (GREEN phase wires it up)
const scanPhasePlans = require('../gsd-core/bin/lib/plan-scan.cjs');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir;

function phaseDir(name = 'phase') {
  const d = path.join(tmpDir, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function touch(dir, ...filenames) {
  for (const f of filenames) {
    fs.writeFileSync(path.join(dir, f), '');
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plan-scan-'));
});

afterEach(() => {
  cleanup(tmpDir);
});

// ---------------------------------------------------------------------------
// Basic shapes
// ---------------------------------------------------------------------------

describe('scanPhasePlans — flat layout', () => {
  test('empty directory → zero counts', () => {
    const dir = phaseDir();
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 0, 'planCount');
    assert.strictEqual(result.summaryCount, 0, 'summaryCount');
  });

  test('bare PLAN.md counts as one plan', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'planCount');
    assert.strictEqual(result.summaryCount, 0, 'summaryCount');
  });

  test('canonical padded plan file (01-01-PLAN.md)', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'planCount');
  });

  test('canonical padded plan + matching summary → completed', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-01-SUMMARY.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1);
    assert.strictEqual(result.summaryCount, 1);
    assert.strictEqual(result.completed, true, 'phase should be complete when summaries >= plans');
  });

  test('plan without summary → not completed', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.completed, false);
  });

  test('multiple plans all summarized → completed', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-02-PLAN.md', '01-01-SUMMARY.md', '01-02-SUMMARY.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 2);
    assert.strictEqual(result.summaryCount, 2);
    assert.strictEqual(result.completed, true);
  });

  test('bare SUMMARY.md counts as one summary', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md', 'SUMMARY.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1);
    assert.strictEqual(result.summaryCount, 1);
  });

  test('extended-layout root file (5-PLAN-01-setup.md style)', () => {
    // roadmap.cjs isPlanFile explicitly matches any .md with PLAN in name at root
    // (not just ending with -PLAN.md). The canonical helper must too.
    // e.g. gsd-plan-phase writes "5-PLAN-01-setup.md".
    const dir = phaseDir();
    // The summary for this file follows the canonical *-SUMMARY.md suffix convention.
    touch(dir, '3-PLAN-01-setup.md', '3-01-SUMMARY.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'extended-layout root plan counted');
    assert.strictEqual(result.summaryCount, 1, 'extended-layout root summary counted');
  });
});

// ---------------------------------------------------------------------------
// Ignored files
// ---------------------------------------------------------------------------

describe('scanPhasePlans — ignored files', () => {
  test('PLAN-OUTLINE file is ignored (flat)', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-01-PLAN-OUTLINE.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'OUTLINE should not count as a plan');
  });

  test('pre-bounce file is ignored (flat)', () => {
    const dir = phaseDir();
    touch(dir, '01-01-PLAN.md', '01-01-PLAN.pre-bounce.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'pre-bounce should not count as a plan');
  });

  test('CONTEXT.md is not counted as a plan', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md', 'CONTEXT.md', '01-01-CONTEXT.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'CONTEXT files should not be plans');
  });

  test('RESEARCH.md is not counted as a plan', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md', 'RESEARCH.md', '01-01-RESEARCH.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'RESEARCH files should not be plans');
  });

  test('VERIFICATION.md is not counted as a plan', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md', 'VERIFICATION.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'VERIFICATION files should not be plans');
  });
});

// ---------------------------------------------------------------------------
// Nested layout (post-#3139)
// ---------------------------------------------------------------------------

describe('scanPhasePlans — nested layout', () => {
  test('nested PLAN-NN-slug.md files counted', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'PLAN-02-impl.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 2, 'nested plans counted');
    assert.strictEqual(result.hasNestedPlans, true, 'hasNestedPlans flag set');
  });

  test('nested SUMMARY-NN-slug.md files counted', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'SUMMARY-01-setup.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1);
    assert.strictEqual(result.summaryCount, 1);
    assert.strictEqual(result.completed, true);
    assert.deepStrictEqual(result.planFiles, ['plans/PLAN-01-setup.md']);
    assert.deepStrictEqual(result.summaryFiles, ['plans/SUMMARY-01-setup.md']);
  });

  test('flat root + nested plans combined', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    // root: 1 plan, 1 summary
    touch(dir, '01-01-PLAN.md', '01-01-SUMMARY.md');
    // nested: 2 plans, 1 summary
    touch(plansDir, 'PLAN-01-setup.md', 'PLAN-02-impl.md', 'SUMMARY-01-setup.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 3, 'root + nested plans');
    assert.strictEqual(result.summaryCount, 2, 'root + nested summaries');
    assert.strictEqual(result.completed, false, 'not all plans have summaries');
  });

  test('hasNestedPlans is false when plans/ directory absent', () => {
    const dir = phaseDir();
    touch(dir, 'PLAN.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.hasNestedPlans, false);
  });

  test('nested OUTLINE files are ignored', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'PLAN-01-OUTLINE.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'OUTLINE excluded in nested');
  });

  test('nested pre-bounce files are ignored', () => {
    const dir = phaseDir();
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-setup.md', 'PLAN-01.pre-bounce.md');
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1, 'pre-bounce excluded in nested');
  });

  test('plans/ that is not readable as directory does not throw', () => {
    const dir = phaseDir();
    // Create plans/ as a file (unreadable as directory)
    fs.writeFileSync(path.join(dir, 'plans'), 'not-a-directory');
    touch(dir, 'PLAN.md');
    // Should not throw
    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 1);
    assert.strictEqual(result.hasNestedPlans, false);
  });
});

// ---------------------------------------------------------------------------
// Parity: helper output shape and mixed fixture
// ---------------------------------------------------------------------------

describe('scanPhasePlans — call-site parity on mixed fixture', () => {
  // Build a fixture tree that exercises both flat and nested layout:
  // 01-foundation/
  //   01-01-PLAN.md
  //   01-01-SUMMARY.md
  //   01-01-PLAN-OUTLINE.md   (should be ignored)
  //   01-02-PLAN.md
  //   plans/
  //     PLAN-01-setup.md
  //     SUMMARY-01-setup.md

  function buildMixedPhase() {
    const dir = phaseDir('01-foundation');
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(dir, '01-01-PLAN.md', '01-01-SUMMARY.md', '01-01-PLAN-OUTLINE.md', '01-02-PLAN.md');
    touch(plansDir, 'PLAN-01-setup.md', 'SUMMARY-01-setup.md');
    return dir;
  }

  test('scanPhasePlans() counts match expected values for mixed fixture', () => {
    const dir = buildMixedPhase();
    const result = scanPhasePlans(dir);
    // flat: 01-01-PLAN.md + 01-02-PLAN.md = 2 (OUTLINE ignored)
    // nested: PLAN-01-setup.md = 1
    assert.strictEqual(result.planCount, 3, 'planCount should be 3');
    // flat: 01-01-SUMMARY.md = 1; nested: SUMMARY-01-setup.md = 1
    assert.strictEqual(result.summaryCount, 2, 'summaryCount should be 2');
    assert.strictEqual(result.completed, false, 'not all plans have summaries');
    assert.strictEqual(result.hasNestedPlans, true, 'nested layout present');
  });

  test('scanPhasePlans() output shape has required fields', () => {
    const dir = buildMixedPhase();
    const result = scanPhasePlans(dir);
    assert.ok('planCount' in result, 'planCount field present');
    assert.ok('summaryCount' in result, 'summaryCount field present');
    assert.ok('completed' in result, 'completed field present');
    assert.ok('hasNestedPlans' in result, 'hasNestedPlans field present');
    assert.ok('planFiles' in result, 'planFiles field present');
    assert.ok('summaryFiles' in result, 'summaryFiles field present');
    assert.ok(Array.isArray(result.planFiles), 'planFiles is array');
    assert.ok(Array.isArray(result.summaryFiles), 'summaryFiles is array');
  });

  test('parity baseline: 2 flat + 1 nested plans across all call sites', () => {
    // This test documents the exact expected counts for a representative fixture.
    // After the GREEN phase ports roadmap.cjs/state.cjs/init.cjs to use
    // scanPhasePlans, those call sites delegate here and this assertion is
    // the single contract all of them must satisfy.
    const dir = phaseDir('02-api');
    touch(dir, '02-01-PLAN.md', '02-02-PLAN.md', '02-01-SUMMARY.md');
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir);
    touch(plansDir, 'PLAN-01-impl.md', 'SUMMARY-01-impl.md');

    const result = scanPhasePlans(dir);
    assert.strictEqual(result.planCount, 3, 'helper: 2 flat + 1 nested');
    assert.strictEqual(result.summaryCount, 2, 'helper: 1 flat + 1 nested');
    assert.strictEqual(result.completed, false, '2 summaries < 3 plans');
    assert.strictEqual(result.hasNestedPlans, true, 'plans/ dir exists with plans');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3594-parser-adversarial-roadmap.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3594-parser-adversarial-roadmap (consolidation epic #1969 B8 #1977)", () => {
/**
 * Adversarial roadmap-parser tests (#3594).
 *
 * Loads each fixture in `tests/fixtures/adversarial/roadmap/` as the
 * project's `.planning/ROADMAP.md` and pins invariants on the public
 * `gsd-tools roadmap get-phase <N>` surface — which routes through the
 * SDK bridge when available and the CJS handler otherwise.
 *
 * Per CONTRIBUTING.md §"Testing Standards / Parser and project-file
 * inputs", the assertion target is the typed JSON shape the CLI emits,
 * not stderr prose. The harness in `tests/helpers/cli-negative.cjs`
 * (introduced by #3627 / #3593) is reused here for consistency.
 *
 * Several fixtures encode known historical regressions:
 *   - fenced-code-block headings shadowing real phases (#2787)
 *   - decimal phase prefix collisions (#3537)
 *   - HTML-comment heading false positives
 *
 * Pre-existing parser bugs surfaced by these fixtures are NOT fixed in
 * this PR — fixing them is out of scope for "add adversarial test
 * coverage." Where a fixture exposes a still-open bug, the test
 * asserts the *currently observed* behavior with a comment naming the
 * open issue, so the flip from RED→GREEN is a one-line change the day
 * the real fix lands.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCli } = require('./helpers/cli-negative.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'roadmap');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

/**
 * Create a temp project whose ROADMAP.md is the named fixture's content.
 * Returns the project directory; caller is responsible for cleanup.
 */
function projectWithFixture(t, fixtureName) {
  const projectDir = createTempProject('roadmap-adv-' + fixtureName.replace(/\W+/g, '-') + '-');
  t.after(() => cleanup(projectDir));
  fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), loadFixture(fixtureName));
  return projectDir;
}

/**
 * Run `gsd-tools roadmap get-phase <N>` and parse the JSON payload.
 * Returns `{ ok, exit, parsed, raw }` so tests can assert on either
 * the exit code or the structured payload.
 */
function getPhase(projectDir, phaseNum) {
  // No --json-errors — the get-phase command outputs JSON on success
  // via the normal stdout path. Reading the parsed payload is what the
  // workflows downstream do, so that's what we test.
  const result = runCli(['roadmap', 'get-phase', phaseNum], { cwd: projectDir, jsonErrors: false });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Leave parsed null; tests that depend on it must handle that.
  }
  return {
    exit: result.status,
    ok: result.status === 0,
    parsed,
    raw: result.stdout,
    stderr: result.stderr,
    hasStackTrace: result.hasStackTrace,
  };
}

// ─── Fenced code block heading shadowing ────────────────────────────────────

describe('feat-3594: roadmap parser and fenced-code-block headings (#2787)', () => {
  test('phase 1 in real prose is found even when ## Phase 999 appears inside a ``` block', (t) => {
    const projectDir = projectWithFixture(t, 'phase-heading-inside-fenced-code.md');
    const result = getPhase(projectDir, '1');
    assert.equal(result.hasStackTrace, false, 'no V8 stack trace');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true, 'phase 1 must be found');
    assert.equal(result.parsed.phase_number, '1');
    assert.match(result.parsed.phase_name, /real phase one/);
  });

  test('phase 999 inside a fenced block is ignored', (t) => {
    const projectDir = projectWithFixture(t, 'phase-heading-inside-fenced-code.md');
    const result = getPhase(projectDir, '999');
    assert.equal(result.hasStackTrace, false, 'no stack trace');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, false, 'phase headings inside fenced blocks must not be parsed');
  });

  test('fenced example heading does not shadow the real phase details and backlog phase stays unresolved (#1588)', (t) => {
    const projectDir = createTempProject('roadmap-1588-');
    t.after(() => cleanup(projectDir));
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.1',
        'status: planning',
        '---',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '<details open>',
        '<summary>v1.1 Current (Phases 8-9) - PLANNED</summary>',
        '',
        '- [ ] **Phase 9: Real Phase**',
        '',
        '</details>',
        '',
        '## Phase Details',
        '',
        '```markdown',
        '### Phase 9: Fenced Example Phase',
        '**Goal:** This example must not be treated as roadmap structure.',
        '```',
        '',
        '### Phase 9: Real Phase',
        '**Goal:** Use the real phase details outside the fenced block.',
        '**Requirements:** REAL-01',
        '',
        '## Backlog',
        '',
        '### Phase 999.1: Backlog Thing',
        '**Goal:** Future backlog item.',
        '',
      ].join('\n')
    );

    const phase9 = getPhase(projectDir, '9');
    assert.ok(phase9.parsed, `expected JSON payload, got: ${phase9.raw}`);
    assert.equal(phase9.parsed.found, true, 'phase 9 must be found');
    assert.equal(phase9.parsed.phase_name, 'Real Phase');
    assert.equal(phase9.parsed.goal, 'Use the real phase details outside the fenced block.');
    assert.match(phase9.parsed.section, /REAL-01/, 'real phase section must be returned');

    const backlog = getPhase(projectDir, '999.1');
    assert.ok(backlog.parsed, `expected JSON payload, got: ${backlog.raw}`);
    assert.equal(backlog.parsed.found, false, 'backlog sentinel phase must not resolve as an active roadmap phase');
  });
});

// ─── Decimal phase prefix collisions ────────────────────────────────────────

describe('feat-3594: roadmap parser handles decimal phase prefix collisions (#3537)', () => {
  test('asking for phase "2" returns the integer phase, NOT phase 2.1 or 2.10', (t) => {
    const projectDir = projectWithFixture(t, 'decimal-phase-mixed.md');
    const result = getPhase(projectDir, '2');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_number, '2');
    assert.match(result.parsed.phase_name, /integer phase two/);
  });

  test('asking for phase "2.1" returns the decimal child', (t) => {
    const projectDir = projectWithFixture(t, 'decimal-phase-mixed.md');
    const result = getPhase(projectDir, '2.1');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_number, '2.1');
    assert.match(result.parsed.phase_name, /decimal child/);
  });

  test('asking for phase "2.10" returns the decimal sibling, NOT phase 2.1', (t) => {
    const projectDir = projectWithFixture(t, 'decimal-phase-mixed.md');
    const result = getPhase(projectDir, '2.10');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_number, '2.10');
    assert.match(result.parsed.phase_name, /decimal phase 2\.10/);
  });

  test('asking for phase "21" returns phase 21, NOT phase 2 (prefix-collision guard)', (t) => {
    const projectDir = projectWithFixture(t, 'decimal-phase-mixed.md');
    const result = getPhase(projectDir, '21');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_number, '21');
    assert.match(result.parsed.phase_name, /phase twenty-one/);
  });
});

// ─── Unicode phase titles ───────────────────────────────────────────────────

describe('feat-3594: roadmap parser preserves Unicode phase titles', () => {
  test('Japanese title round-trips through phase_name', (t) => {
    const projectDir = projectWithFixture(t, 'unicode-phase-titles.md');
    const result = getPhase(projectDir, '1');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.phase_name, '日本語フェーズ — initial setup');
  });

  test('emoji + smart-quote title survives', (t) => {
    const projectDir = projectWithFixture(t, 'unicode-phase-titles.md');
    const result = getPhase(projectDir, '2');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.match(result.parsed.phase_name, /🚧/);
    assert.match(result.parsed.phase_name, /Émile/);
  });

  test('Greek-letter title survives', (t) => {
    const projectDir = projectWithFixture(t, 'unicode-phase-titles.md');
    const result = getPhase(projectDir, '3');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.phase_name, 'αβγ δεζ ηθι');
  });
});

// ─── Repeated phase IDs ─────────────────────────────────────────────────────

describe('feat-3594: roadmap parser handles repeated phase IDs deterministically', () => {
  test('two declarations of phase 1: parser returns the FIRST match (current behavior)', (t) => {
    const projectDir = projectWithFixture(t, 'repeated-phase-ids.md');
    const result = getPhase(projectDir, '1');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    // The regex uses `content.match(...)` which returns the FIRST match.
    // Pin that — a future change to last-wins or de-dup would fire.
    assert.match(result.parsed.phase_name, /first declaration/);
  });
});

// ─── HTML comments ──────────────────────────────────────────────────────────

describe('feat-3594: roadmap parser and HTML-commented headings', () => {
  test('phase 1 in real prose is found even when phase 998/999 appear inside <!-- ... -->', (t) => {
    const projectDir = projectWithFixture(t, 'markdown-headings-inside-html-comment.md');
    const result = getPhase(projectDir, '1');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, true);
    assert.equal(result.parsed.phase_name, 'real phase');
  });

  test('phase 999 inside an HTML comment remains ignored because backlog sentinels never resolve', (t) => {
    const projectDir = projectWithFixture(t, 'markdown-headings-inside-html-comment.md');
    const result = getPhase(projectDir, '999');
    assert.equal(result.hasStackTrace, false, 'no stack trace');
    assert.ok(result.parsed, `expected JSON payload, got: ${result.raw}`);
    assert.equal(result.parsed.found, false, 'backlog sentinel phases must not resolve');
  });
});

// ─── Cross-corpus invariant ────────────────────────────────────────────────

describe('feat-3594: roadmap parser does not crash on ANY corpus fixture', () => {
  const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const fixture of fixtures) {
    test(`fixture "${fixture}" — get-phase with arbitrary IDs must not crash`, (t) => {
      const projectDir = projectWithFixture(t, fixture);
      for (const id of ['1', '2', '99', '999', '0', '2.1']) {
        const result = getPhase(projectDir, id);
        assert.equal(result.hasStackTrace, false, `${fixture} id=${id}: no V8 stack frame allowed`);
        // exit status varies (0 for found, non-zero for not-found —
        // both are valid). What's pinned: the parser produced SOME output
        // (either valid JSON or a clean stderr) without crashing.
      }
    });
  }
});
  });
}
