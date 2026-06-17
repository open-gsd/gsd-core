'use strict';

/**
 * decisions.test.cjs — regression tests for parseDecisions / extractDecisions
 *   and the check.decision-coverage-plan gate fail-loud behavior.
 *
 * Bug #1364: parseDecisions returns [] when decisions appear under markdown headers
 * (## Locked decisions / ## Implementation decisions) instead of a
 * <decisions>...</decisions> block. Also, em-dash bullets
 * '- **D-1 — title** body' are dropped as unparseable.
 *
 * Bug #1365: check.decision-coverage-plan silently returns passed:true when
 * CONTEXT.md is decision-shaped (has <decisions> block or D- tokens) but 0
 * decisions are extracted — gate now returns passed:false with format-mismatch
 * reason (could-not-parse outcome).
 *
 * Parser QA matrix (CONTRIBUTING.md 'Parser and project-file inputs'):
 *   - CRLF newlines
 *   - Unicode in a heading
 *   - Decisions-looking heading inside a fenced code block (must be ignored)
 *   - Both bullet forms: colon ('- **D-1:** ...') and em-dash ('- **D-1 — ...**')
 *   - Genuinely empty / no-decisions case (still [])
 *   - Pre-existing <decisions> block behaviour is unaffected (regression guard)
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseDecisions, extractDecisions } = require('../gsd-core/bin/lib/decisions.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Regression #1364: markdown-header fallback ───────────────────────────────

describe('parseDecisions — markdown header fallback (#1364)', () => {
  test('extracts D-NN from ## Locked decisions header (em-dash bullets)', () => {
    const md = '## Locked decisions\n- **D-1 — a** x\n- **D-2 — b** y\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(
      ds.map(d => d.id),
      ['D-1', 'D-2'],
      'should extract D-1 and D-2 from em-dash bullets under markdown header'
    );
  });

  test('extracts D-NN from ## Implementation decisions header (colon bullets)', () => {
    const md = '## Implementation decisions\n- **D-01:** Use OAuth 2.0\n- **D-02:** Redis sessions\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01', 'D-02']);
    assert.strictEqual(ds[0].text, 'Use OAuth 2.0');
  });

  test('extracts D-NN from ### Decisions header (mixed bullets)', () => {
    const md = '### Decisions\n- **D-1:** colon form\n- **D-2 — em-dash form** body text\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-1', 'D-2']);
  });

  test('extracts from header with case variation (## DECISIONS)', () => {
    const md = '## DECISIONS\n- **D-10:** uppercase heading\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-10']);
  });

  test('extracts from heading with Unicode in surrounding text (## \u{1F512} Locked decisions)', () => {
    // Unicode chars before "decisions" must not break the heading matcher.
    const md = '## \u{1F512} Locked decisions\n- **D-3 — unicode heading** value\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-3']);
  });

  test('CRLF newlines work for markdown-header path', () => {
    const md = '## Locked decisions\r\n- **D-5:** crlf bullet\r\n- **D-6 — em dash** crlf em\r\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-5', 'D-6']);
  });

  test('decisions-looking heading inside a fenced code block is ignored', () => {
    const md = [
      '```',
      '## Locked decisions',
      '- **D-99:** fake',
      '```',
      '',
      '## Real decisions',
      '- **D-1:** real',
    ].join('\n');
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-1']);
  });

  test('generic prose heading does not produce false positives', () => {
    const md = '## Context\n- some bullet\n\n## Architecture\n- another bullet\n';
    assert.deepStrictEqual(parseDecisions(md), []);
  });

  test('no decisions anywhere returns [] (no false positives)', () => {
    assert.deepStrictEqual(parseDecisions('## Locked decisions\n\nNo bullets here.\n'), []);
  });

  test('content with no decisions heading and no block returns []', () => {
    assert.deepStrictEqual(parseDecisions('# Just a title\nsome prose\n'), []);
  });
});

// ─── Regression #1364: em-dash bullet inside existing <decisions> block ───────

describe('parseDecisions — em-dash bullet form inside <decisions> block (#1364)', () => {
  test('em-dash bullet is parsed inside a <decisions> block', () => {
    const md = '<decisions>\n- **D-1 — my title** body text\n</decisions>\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-1']);
    assert.ok(ds[0].text.length > 0, 'text must not be empty');
  });

  test('em-dash bullet with alphanumeric ID is parsed', () => {
    const md = '<decisions>\n- **D-INFRA-01 — infra decision** body\n</decisions>\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-INFRA-01']);
  });
});

// ─── Regression guard: pre-existing <decisions> block behaviour unchanged ─────

describe('parseDecisions — existing <decisions> block still works (#1364 guard)', () => {
  test('colon form inside <decisions> block still parses', () => {
    const md = '<decisions>\n- **D-1:** colon form\n</decisions>\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-1']);
    assert.strictEqual(ds[0].text, 'colon form');
  });

  test('multiple D-NN in block with categories still works', () => {
    const md = `<decisions>\n### Auth\n- **D-01:** OAuth\n### Storage\n- **D-02:** Postgres\n</decisions>\n`;
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01', 'D-02']);
    assert.strictEqual(ds[0].category, 'Auth');
  });

  test('D-IDs outside the block are still ignored when a block is present', () => {
    const md = '- **D-99:** outside\n<decisions>\n- **D-01:** inside\n</decisions>\n- **D-77:** after\n';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01']);
  });

  test('empty / null / undefined still return []', () => {
    assert.deepStrictEqual(parseDecisions(''), []);
    assert.deepStrictEqual(parseDecisions(null), []);
    assert.deepStrictEqual(parseDecisions(undefined), []);
  });
});

// ─── extractDecisions outcome: 'none-present' and 'could-not-parse' ──────────

describe('extractDecisions — typed outcome (#1364 + #1365)', () => {
  test('returns outcome:parsed with decisions array when block present', () => {
    const md = '<decisions>\n- **D-1:** OAuth 2.0\n</decisions>\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed');
    assert.strictEqual(result.decisions.length, 1);
    assert.strictEqual(result.decisions[0].id, 'D-1');
  });

  test('returns outcome:parsed for markdown-header path', () => {
    const md = '## Locked decisions\n- **D-2:** use Redis\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'parsed');
    assert.strictEqual(result.decisions.length, 1);
  });

  test('returns outcome:none-present for genuinely empty content', () => {
    const result = extractDecisions('# Just a title\nsome prose without decisions\n');
    assert.strictEqual(result.outcome, 'none-present');
    assert.deepStrictEqual(result.decisions, []);
  });

  test('returns outcome:none-present for empty string', () => {
    const result = extractDecisions('');
    assert.strictEqual(result.outcome, 'none-present');
  });

  test('returns outcome:could-not-parse when <decisions> block present but yields 0 decisions', () => {
    // A <decisions> block with no parseable bullets is decision-shaped
    const md = '<decisions>\n\nJust prose, no D-NN bullets\n\n</decisions>\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse');
    assert.deepStrictEqual(result.decisions, []);
  });

  test('returns outcome:could-not-parse when D- token present but no parseable decisions', () => {
    // Content references D-01 in prose but it's malformed — not in a parseable bullet
    const md = '# Context\n\nSee also D-01 for background. No block, no heading.\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse');
    assert.deepStrictEqual(result.decisions, []);
  });

  test('returns outcome:could-not-parse when /decisions?/i heading present but 0 decisions extracted', () => {
    // Header present but no actual D-NN bullets under it
    const md = '## Locked decisions\n\nNo D-NN bullets here, just prose.\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'could-not-parse');
    assert.deepStrictEqual(result.decisions, []);
  });

  test('returns outcome:none-present for generic prose with no decision signals', () => {
    // No block, no /decisions?/i heading, no \bD- token — genuinely no decisions
    const md = '## Context\n\nSome architecture notes.\n\n## Goals\n\nBe fast.\n';
    const result = extractDecisions(md);
    assert.strictEqual(result.outcome, 'none-present');
  });

  test('parseDecisions delegates correctly (thin wrapper)', () => {
    // parseDecisions is a thin delegate that returns extractDecisions().decisions
    const md = '<decisions>\n- **D-1:** foo\n</decisions>\n';
    const fromExtract = extractDecisions(md).decisions;
    const fromParse = parseDecisions(md);
    assert.deepStrictEqual(fromParse, fromExtract);
  });
});

// ─── QA matrix for parser correctness ────────────────────────────────────────

describe('parseDecisions — parser QA matrix', () => {
  test('### category headings inside a decisions block set category', () => {
    const md = '<decisions>\n### Auth\n- **D-01:** OAuth 2.0\n### Storage\n- **D-02:** Postgres\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].category, 'Auth');
    assert.strictEqual(ds[1].category, 'Storage');
  });

  test("### Claude's Discretion section sets trackable:false", () => {
    const md = "<decisions>\n### Claude's Discretion\n- **D-01:** internal\n</decisions>";
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].trackable, false);
  });

  test('[informational] tag sets trackable:false', () => {
    const md = '<decisions>\n- **D-01 [informational]:** ref only\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].trackable, false);
  });

  test('[deferred] tag sets trackable:false', () => {
    const md = '<decisions>\n- **D-01 [deferred]:** not yet\n</decisions>';
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].trackable, false);
  });

  test('continuation lines append to text (tab-indented)', () => {
    const md = '<decisions>\n- **D-01:** first line\n\tcontinued here\n</decisions>';
    const ds = parseDecisions(md);
    assert.ok(ds[0].text.includes('first line'), 'must include first line');
    assert.ok(ds[0].text.includes('continued here'), 'must include continuation');
  });

  test('CRLF inside a <decisions> block still parses', () => {
    const md = '<decisions>\r\n- **D-01:** crlf decision\r\n</decisions>';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01']);
  });

  test('fenced code block inside document does not pollute decisions', () => {
    const md = [
      '```',
      '<decisions>',
      '- **D-99:** fake in fence',
      '</decisions>',
      '```',
      '',
      '<decisions>',
      '- **D-01:** real',
      '</decisions>',
    ].join('\n');
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01']);
  });

  test('alphanumeric IDs (D-INFRA-01) are accepted', () => {
    const md = '<decisions>\n- **D-INFRA-01:** infra call\n</decisions>';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-INFRA-01']);
  });

  test('em-dash bullet form with tags still sets tags', () => {
    const md = '<decisions>\n- **D-01 [informational] — title** body\n</decisions>';
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-01']);
    assert.ok(ds[0].tags.includes('informational'));
  });
});

// ─── #1365: fail-loud gate — check.decision-coverage-plan ────────────────────

/**
 * Gate-level tests for the could-not-parse fail-loud behavior (#1365).
 * These exercise cmdDecisionCoveragePlan via the real CLI (check decision-coverage-plan).
 *
 * Naming: check.decision-coverage-plan is invoked as `query check.decision-coverage-plan`.
 * The gate lives in check-command-router.cts; outcome flows from decisions.cts extractDecisions.
 */

function writeContextFile(phaseDir, content) {
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), content);
}

function writePlanFile(phaseDir, name, body) {
  fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
}

function writePlanningConfig(planningDir, config) {
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config));
}

function runDecisionCoveragePlan(phaseDir, contextPath, cwd) {
  return runGsdTools(['query', 'check.decision-coverage-plan', phaseDir, contextPath], cwd);
}

describe('check.decision-coverage-plan — fail-loud on could-not-parse (#1365)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1365-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('decision-shaped CONTEXT.md with <decisions> block but 0 parseable decisions → passed:false (not silent skip)', () => {
    // #1365 bug: gate used to return passed:true/skipped for this case.
    writeContextFile(phaseDir, [
      '# Phase 1',
      '',
      '<decisions>',
      '',
      'See the ADR for architecture choices. No D-NN bullets here.',
      '',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Objective\nImplement feature.\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, false,
      `Gate must return passed:false for decision-shaped but 0-extracted content. Got: ${JSON.stringify(parsed)}`);
    const msg = (parsed.message || parsed.reason || '').toLowerCase();
    assert.ok(
      msg.includes('format') || msg.includes('mismatch') || msg.includes('could not parse') || msg.includes('parse'),
      `Message must mention format mismatch or parsing issue. Got: "${parsed.message}"`
    );
  });

  test('CONTEXT.md with \\bD- token in prose but no parseable decisions → passed:false', () => {
    writeContextFile(phaseDir, [
      '# Phase 1 Context',
      '',
      'See D-01 for the authentication decision and D-02 for storage.',
      'These are just prose references, not structured decisions.',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\nRef D-01.\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, false,
      `Gate must return passed:false for D-token-but-no-parseable content. Got: ${JSON.stringify(parsed)}`);
  });

  test('genuinely empty CONTEXT.md (no decision signals) → passed:true/skipped (no false alarm)', () => {
    writeContextFile(phaseDir, [
      '# Phase 1 Context',
      '',
      '## Goals',
      'Build the feature.',
      '',
      '## Architecture',
      'Use Node.js and TypeScript.',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\nImplement the feature.\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true,
      `Gate must NOT false-alarm on genuinely empty content. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.skipped, true,
      `Gate must skip when there are no decisions. Got: ${JSON.stringify(parsed)}`);
  });

  test('well-formed CONTEXT.md with real decisions all covered → passed:true (normal case)', () => {
    writeContextFile(phaseDir, [
      '# Context',
      '',
      '<decisions>',
      '### Implementation',
      '- **D-01:** Use OAuth 2.0 for authentication',
      '</decisions>',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Must Haves\n- D-01: Implement OAuth 2.0\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true,
      `Real decisions covered → must pass. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.skipped, false);
  });

  test('well-formed CONTEXT.md with decisions heading (markdown-header) all covered → passed:true', () => {
    // After #1364 fix: markdown-header decisions are now extractable and coverable
    writeContextFile(phaseDir, [
      '# Context',
      '',
      '## Implementation decisions',
      '',
      '- **D-01:** Use Redis for caching',
    ].join('\n'));
    writePlanFile(phaseDir, '01', '# Plan\n## Must Haves\n- D-01: Implement Redis caching\n');

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true,
      `Markdown-header decisions covered → must pass. Got: ${JSON.stringify(parsed)}`);
    assert.strictEqual(parsed.skipped, false);
    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.covered, 1);
  });

  test('CONTEXT.md missing → passed:true/skipped (unchanged behavior)', () => {
    const contextPath = path.join(phaseDir, 'NONEXISTENT-CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true);
    assert.strictEqual(parsed.skipped, true);
  });

  test('gate disabled by config → passed:true/skipped (unchanged behavior)', () => {
    writeContextFile(phaseDir, '<decisions>\nNo D-NN bullets\n</decisions>');
    writePlanningConfig(planningDir, { workflow: { context_coverage_gate: false } });

    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const raw = result.output || '';
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.passed, true);
    assert.strictEqual(parsed.skipped, true);
  });
});

describe('check.decision-coverage-plan — boundary/threshold tests (#1365)', () => {
  let tmpDir;
  let planningDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1365-bva-');
    planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('exactly 1 decision extracted (limit == 1) → not could-not-parse', () => {
    writeContextFile(phaseDir, '<decisions>\n- **D-01:** single decision\n</decisions>');
    writePlanFile(phaseDir, '01', '# Plan\n## Objective\nRef D-01.\n');
    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '');
    assert.strictEqual(parsed.passed, true);
    assert.strictEqual(parsed.skipped, false);
    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.covered, 1);
  });

  test('0 decisions extracted from a real block (limit - 1 == 0) → could-not-parse / passed:false', () => {
    // Empty block = decision-shaped (block present) but 0 extracted
    writeContextFile(phaseDir, '<decisions>\n\n</decisions>');
    writePlanFile(phaseDir, '01', '# Plan\nSome plan.\n');
    const contextPath = path.join(phaseDir, 'CONTEXT.md');
    const result = runDecisionCoveragePlan(phaseDir, contextPath, tmpDir);
    const parsed = JSON.parse(result.output || '');
    assert.strictEqual(parsed.passed, false,
      `Empty block → could-not-parse → passed:false. Got: ${JSON.stringify(parsed)}`);
  });
});
