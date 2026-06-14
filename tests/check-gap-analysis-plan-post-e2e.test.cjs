'use strict';

/**
 * E2E content tests for plan:post hook — gap-analysis gate.
 *
 * ADR-857 phase 6 backlog: check-gap-analysis-plan-post-e2e.test.cjs
 *
 * Tests exercise:
 *   - loop render-hooks plan:post (gate discovery)
 *   - check gap-analysis.plan-post (advisory gate check)
 *
 * HARD RULES enforced here:
 *   - Every test runs a real CLI subprocess or the real resolver + real registry.
 *   - No readFileSync + .includes() source-grep on workflow files.
 *   - Asserts TYPED CONTENT (JSON fields, counts, booleans, strings).
 *   - Each test fully isolated (own fixture), cleanup in afterEach.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Write REQUIREMENTS.md with REQ-IDs in checkbox format.
 * @param {string} planningDir
 * @param {string[]} ids
 */
function writeRequirements(planningDir, ids) {
  const lines = ids.map((id, i) => `- [ ] **${id}** Requirement ${i + 1} description`);
  fs.writeFileSync(
    path.join(planningDir, 'REQUIREMENTS.md'),
    `# Requirements\n\n${lines.join('\n')}\n`
  );
}

/**
 * Write CONTEXT.md with a <decisions> block containing decisions.
 * @param {string} phaseDir
 * @param {{id: string, text: string}[]} decisions
 */
function writeContext(phaseDir, decisions) {
  const dLines = decisions.map(d => `- **${d.id}:** ${d.text}`).join('\n');
  fs.writeFileSync(
    path.join(phaseDir, 'CONTEXT.md'),
    `# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n${dLines}\n</decisions>\n`
  );
}

/**
 * Write a PLAN.md with the given body.
 * @param {string} phaseDir
 * @param {string} name  e.g. '01'
 * @param {string} body
 */
function writePlan(phaseDir, name, body) {
  fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
}

/**
 * Run loop render-hooks via spawnSync for low-level exit-code control.
 * @param {string} point
 * @param {string} cwd
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function spawnRenderHooks(point, cwd) {
  const result = spawnSync(process.execPath, [GSD_TOOLS, 'loop', 'render-hooks', point, '--raw'], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, GSD_SESSION_KEY: '', CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' },
  });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * Run check gap-analysis.plan-post via CLI with controlled args.
 * @param {string[]} extraArgs  args after 'gap-analysis.plan-post'
 * @param {string} cwd
 * @returns {{ success: boolean, output: string, error: string, exitCode: number }}
 */
function runGapCheck(extraArgs, cwd) {
  return runGsdTools(['check', 'gap-analysis.plan-post', ...extraArgs, '--raw'], cwd);
}

// ─── Section 1: render-hooks plan:post ───────────────────────────────────────

describe('render-hooks plan:post — gate discovery', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    // Initialize a valid config so schema defaults apply
    const init = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(init.success, `config-ensure-section failed: ${init.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  test('[happy] render-hooks plan:post returns gap-analysis gate hook with correct typed shape when workflow.post_planning_gaps=true (default)', () => {
    // Default config → post_planning_gaps=true (schema default)
    const r = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout);
    assert.strictEqual(envelope.point, 'plan:post');
    assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be array');
    assert.strictEqual(envelope.activeHooks.length, 1, 'exactly one active hook expected');

    const hook = envelope.activeHooks[0];
    assert.strictEqual(hook.capId, 'gap-analysis', 'capId must be gap-analysis');
    assert.strictEqual(hook.kind, 'gate', 'kind must be gate');
    assert.strictEqual(hook.blocking, false, 'blocking must be false (advisory)');
    assert.strictEqual(hook.onError, 'skip', 'onError must be skip');
    assert.strictEqual(hook.when, 'workflow.post_planning_gaps', 'when must be workflow.post_planning_gaps');
    assert.deepStrictEqual(hook.check, { query: 'gap-analysis.plan-post' }, 'check.query must be gap-analysis.plan-post');

    // rendered must mention the gate
    assert.ok(typeof envelope.rendered === 'string', 'rendered must be string');
    assert.ok(envelope.rendered.includes('gap-analysis'), 'rendered must mention gap-analysis');
    assert.ok(envelope.rendered.includes('gap-analysis.plan-post'), 'rendered must include check query');
  });

  test('[negative] render-hooks plan:post returns empty activeHooks when workflow.post_planning_gaps=false (gate deactivated)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { post_planning_gaps: false } })
    );

    const r = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout);
    assert.strictEqual(envelope.point, 'plan:post');
    // GENUINE check: must be EMPTY, not length 1
    assert.deepStrictEqual(envelope.activeHooks, [], 'activeHooks must be empty when gate disabled');
    assert.strictEqual(envelope.rendered, '_No active hooks at plan:post._',
      'rendered placeholder must match exactly when no hooks active');
  });

  test('[happy] render-hooks plan:post with explicit post_planning_gaps=true in config returns same hook as default', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { post_planning_gaps: true } })
    );

    const r = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout);
    assert.strictEqual(envelope.activeHooks.length, 1, 'exactly one hook with explicit true');
    assert.strictEqual(envelope.activeHooks[0].capId, 'gap-analysis');
    assert.strictEqual(envelope.activeHooks[0].blocking, false);
  });

  test('[bva] render-hooks plan:post envelope has exactly 3 keys (point, activeHooks, rendered) — Hyrum\'s law shape pin', () => {
    const r = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout);
    const keys = Object.keys(envelope).sort();
    assert.deepStrictEqual(keys, ['activeHooks', 'point', 'rendered'],
      `envelope must have exactly 3 keys, got: ${keys.join(',')}`);
  });
});

// ─── Section 2: check gap-analysis.plan-post — content tests ─────────────────

describe('check gap-analysis.plan-post — gate content E2E', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const init = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(init.success, `config-ensure-section failed: ${init.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  // ── Coverage table tests ────────────────────────────────────────────────────

  test('[happy] check gap-analysis.plan-post returns block:false with coverage table when phaseDir has plans covering some REQ-IDs', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01', 'REQ-02']);
    writePlan(phaseDir, '01', '# Plan 1\n\nImplements REQ-01 only.\n');

    const r = runGapCheck([phaseDir, 'REQ-01,REQ-02'], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    // GENUINE typed field assertions
    assert.strictEqual(out.block, false, 'block must be false (gap-analysis is always advisory)');
    assert.strictEqual(out.passed, true);
    assert.strictEqual(out.enabled, true);
    assert.strictEqual(out.counts.total, 2, 'total must be 2');
    assert.strictEqual(out.counts.covered, 1, 'covered must be 1 (REQ-01 only)');
    assert.strictEqual(out.counts.uncovered, 1, 'uncovered must be 1 (REQ-02 not in plan)');

    // Table content — assert specific coverage rows
    assert.ok(out.table.includes('REQ-01'), 'table must include REQ-01');
    assert.ok(out.table.includes('REQ-02'), 'table must include REQ-02');
    assert.ok(out.table.includes('✓ Covered'), 'table must show covered row');
    assert.ok(out.table.includes('✗ Not covered'), 'table must show not-covered row');
  });

  test('[happy] check gap-analysis.plan-post returns block:false with all-covered summary when all REQ-IDs and D-IDs are in plans', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writeContext(phaseDir, [{ id: 'D-01', text: 'Use pattern X for consistency' }]);
    writePlan(phaseDir, '01', '# Plan 1\n\nImplements REQ-01 and D-01.\n');

    const r = runGapCheck([phaseDir], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.block, false);
    assert.strictEqual(out.enabled, true);
    assert.strictEqual(out.counts.total, 2, 'total must be 2 (1 req + 1 decision)');
    assert.strictEqual(out.counts.covered, 2, 'both items must be covered');
    // GENUINE: uncovered must be 0, not 1
    assert.strictEqual(out.counts.uncovered, 0, 'uncovered must be 0 when all covered');
    assert.ok(/all 2 items covered/i.test(out.summary), `summary must say "all 2 items covered", got: ${out.summary}`);
  });

  test('[empty-resolution] check gap-analysis.plan-post returns block:false with empty rows when no REQUIREMENTS.md and no CONTEXT.md exist', () => {
    // No REQUIREMENTS.md, no CONTEXT.md — only a PLAN.md
    writePlan(phaseDir, '01', '# Plan\n\nSome content.\n');

    const r = runGapCheck([phaseDir], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.block, false);
    assert.strictEqual(out.enabled, true);
    // GENUINE: total must be 0 (nothing to check)
    assert.strictEqual(out.counts.total, 0, 'total must be 0 with no requirements/decisions');
    assert.strictEqual(out.counts.uncovered, 0);
    assert.ok(/no requirements or decisions/i.test(out.summary),
      `summary must mention "no requirements or decisions", got: ${out.summary}`);
  });

  // ── Disabled gate tests ─────────────────────────────────────────────────────

  test('[negative] check gap-analysis.plan-post returns enabled:false with block:false when workflow.post_planning_gaps=false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { post_planning_gaps: false } })
    );
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writePlan(phaseDir, '01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGapCheck([phaseDir], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.block, false, 'block must be false when disabled');
    assert.strictEqual(out.passed, true);
    // GENUINE: enabled must be FALSE when gate is disabled
    assert.strictEqual(out.enabled, false, 'enabled must be false when post_planning_gaps=false');
    assert.strictEqual(out.table, '', 'table must be empty string when disabled');
    assert.ok(/disabled/i.test(out.summary), `summary must mention disabled, got: ${out.summary}`);
    assert.strictEqual(out.counts.total, 0);
  });

  // ── Missing arg tests ───────────────────────────────────────────────────────

  test('[negative] check gap-analysis.plan-post exits non-zero with error string when phaseDir argument is omitted', () => {
    // Pass only --raw, no phaseDir
    const r = runGsdTools(['check', 'gap-analysis.plan-post', '--raw'], tmpDir);
    // GENUINE: must fail, not succeed
    assert.strictEqual(r.success, false, 'must fail when phaseDir omitted');
    assert.strictEqual(r.exitCode, 1, 'exit code must be 1');
    assert.ok(r.error.includes('requires a phase-dir argument'),
      `stderr must say "requires a phase-dir argument", got: ${r.error}`);
    // Output should NOT be valid JSON (it's an error message, not JSON)
    let parsed;
    try { parsed = JSON.parse(r.output); } catch (_) { parsed = null; }
    assert.strictEqual(parsed, null, 'output must not be valid JSON when phase-dir is missing');
  });

  // ── BVA: phaseReqIds=TBD ────────────────────────────────────────────────────

  test('[bva] check gap-analysis.plan-post with phaseReqIds=TBD returns zero requirement rows but still reports CONTEXT.md decisions', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['OTHER-01', 'OTHER-02']);
    writeContext(phaseDir, [{ id: 'D-01', text: 'Use canonical pattern for this module' }]);
    writePlan(phaseDir, '01', '# Plan\n\nNo decisions addressed here.\n');

    // TBD means: skip requirements, but still report CONTEXT.md decisions
    const r = runGapCheck([phaseDir, 'TBD'], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.enabled, true);
    // GENUINE: only D-01 (from CONTEXT.md) — OTHER-01/OTHER-02 must be excluded
    assert.strictEqual(out.counts.total, 1, 'total must be 1 (only D-01 from CONTEXT.md)');
    // REQUIREMENTS.md rows must not appear
    assert.ok(!out.table.includes('OTHER-01'), 'OTHER-01 must not appear in table when phaseReqIds=TBD');
    assert.ok(!out.table.includes('OTHER-02'), 'OTHER-02 must not appear in table when phaseReqIds=TBD');
    // D-01 must appear
    assert.ok(out.table.includes('D-01'), 'D-01 from CONTEXT.md must still appear');
  });

  // ── BVA: mapped REQ-ID absent from REQUIREMENTS.md ─────────────────────────

  test('[bva] check gap-analysis.plan-post with mapped REQ-ID absent from REQUIREMENTS.md emits Missing-from-REQUIREMENTS.md status in table', () => {
    // REQUIREMENTS.md has only REQ-01, but phaseReqIds includes REQ-99 (absent)
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writePlan(phaseDir, '01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGapCheck([phaseDir, 'REQ-01,REQ-99'], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.enabled, true);
    // GENUINE: uncovered must be 1 (REQ-99 is "missing" which counts as uncovered)
    assert.strictEqual(out.counts.uncovered, 1, 'uncovered must be 1 for missing REQ-99');
    assert.strictEqual(out.counts.total, 2, 'total must be 2 (REQ-01 + REQ-99)');
    assert.ok(out.table.includes('REQ-99'), 'table must include REQ-99');
    // GENUINE: the status row for REQ-99 must say "Missing from REQUIREMENTS.md"
    assert.ok(out.table.includes('Missing from REQUIREMENTS.md'),
      `table must contain "Missing from REQUIREMENTS.md" for REQ-99, got table: ${out.table}`);
    // REQ-01 must still be covered
    assert.ok(out.table.includes('✓ Covered'), 'REQ-01 must show as covered');
  });
});

// ─── Section 3: Full pipeline — render-hooks → check dispatch ─────────────────

describe('Full pipeline: render-hooks plan:post discovers gate, then check dispatched', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const init = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(init.success, `config-ensure-section failed: ${init.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  test('[happy] Full pipeline: render-hooks plan:post discovers gate hook, then check dispatched with hook.check.query returns advisory table — gate never blocking', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01', 'REQ-02']);
    writePlan(phaseDir, '01', '# Plan 1\n\nImplements REQ-01 only.\n');

    // Step 1: discover the gate hook via render-hooks
    const hookResult = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(hookResult.status, 0, `render-hooks exited non-zero: ${hookResult.stderr}`);

    const envelope = JSON.parse(hookResult.stdout);
    assert.strictEqual(envelope.activeHooks.length, 1, 'must discover exactly 1 gate hook');
    const hook = envelope.activeHooks[0];

    // GENUINE: gate must be advisory (blocking=false)
    assert.strictEqual(hook.blocking, false, 'gap-analysis gate must be non-blocking');
    assert.strictEqual(hook.check.query, 'gap-analysis.plan-post', 'check.query must be gap-analysis.plan-post');

    // Step 2: dispatch the check using the discovered query
    const checkResult = runGapCheck([phaseDir], tmpDir);
    assert.ok(checkResult.success, `check failed: ${checkResult.error}`);

    const out = JSON.parse(checkResult.output);
    // GENUINE: the check result must also say block:false
    assert.strictEqual(out.block, false, 'check must return block:false (advisory gate)');
    assert.strictEqual(out.counts.uncovered, 1, 'one uncovered item: REQ-02');
    assert.ok(out.table.length > 0, 'table must be non-empty');
    assert.ok(out.table.includes('REQ-01'), 'table must show REQ-01');
    assert.ok(out.table.includes('REQ-02'), 'table must show REQ-02');
  });

  test('[happy] Full pipeline: when post_planning_gaps=true and all items covered, check returns zero uncovered', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writePlan(phaseDir, '01', '# Plan\n\nImplements REQ-01.\n');

    // Confirm hook exists via render-hooks
    const hookResult = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(hookResult.status, 0);
    const envelope = JSON.parse(hookResult.stdout);
    assert.strictEqual(envelope.activeHooks.length, 1);

    // Run the check
    const checkResult = runGapCheck([phaseDir], tmpDir);
    assert.ok(checkResult.success, `check failed: ${checkResult.error}`);
    const out = JSON.parse(checkResult.output);

    assert.strictEqual(out.block, false);
    assert.strictEqual(out.enabled, true);
    assert.strictEqual(out.counts.total, 1);
    assert.strictEqual(out.counts.covered, 1);
    assert.strictEqual(out.counts.uncovered, 0);
  });

  test('[negative] Full pipeline: when post_planning_gaps=false, render-hooks returns empty and check returns enabled:false — dual contract agreement', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { post_planning_gaps: false } })
    );
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writePlan(phaseDir, '01', '# Plan\n\nSome content.\n');

    // Step 1: render-hooks must return empty (gate suppressed)
    const hookResult = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(hookResult.status, 0);
    const envelope = JSON.parse(hookResult.stdout);
    // GENUINE: both render-hooks and check must agree on suppression
    assert.deepStrictEqual(envelope.activeHooks, [],
      'render-hooks must return empty activeHooks when gate disabled');
    assert.strictEqual(envelope.rendered, '_No active hooks at plan:post._');

    // Step 2: check must return enabled:false, confirming dual-contract agreement
    writePlan(phaseDir, '01', '# Plan\n\nSome content.\n');
    const checkResult = runGapCheck([phaseDir], tmpDir);
    assert.ok(checkResult.success, `check failed: ${checkResult.error}`);
    const out = JSON.parse(checkResult.output);
    // GENUINE: enabled must be false (both surfaces agree gate is suppressed)
    assert.strictEqual(out.enabled, false,
      'check must return enabled:false when render-hooks also shows empty — dual contract parity');
  });
});

// ─── Section 4: Pure resolver tests against real registry ────────────────────

describe('resolveLoopHooks plan:post — pure function against real registry', () => {
  const { resolveLoopHooks, renderLoopHooks } = require('../gsd-core/bin/lib/loop-resolver.cjs');
  const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

  test('[happy] resolveLoopHooks plan:post with post_planning_gaps=true returns one gap-analysis gate', () => {
    const result = resolveLoopHooks({
      point: 'plan:post',
      registry: realRegistry,
      config: { workflow: { post_planning_gaps: true } },
    });
    assert.strictEqual(result.point, 'plan:post');
    assert.ok(Array.isArray(result.activeHooks));
    assert.strictEqual(result.activeHooks.length, 1, 'must be exactly 1 hook with post_planning_gaps=true');
    const hook = result.activeHooks[0];
    assert.strictEqual(hook.capId, 'gap-analysis');
    assert.strictEqual(hook.kind, 'gate');
    assert.strictEqual(hook.blocking, false);
    assert.strictEqual(hook.onError, 'skip');
  });

  test('[negative] resolveLoopHooks plan:post with post_planning_gaps=false returns empty activeHooks', () => {
    const result = resolveLoopHooks({
      point: 'plan:post',
      registry: realRegistry,
      config: { workflow: { post_planning_gaps: false } },
    });
    assert.strictEqual(result.point, 'plan:post');
    // GENUINE: must be empty array (not length-1)
    assert.deepStrictEqual(result.activeHooks, [],
      'activeHooks must be empty when post_planning_gaps=false');
  });

  test('[happy] renderLoopHooks plan:post with empty activeHooks returns exact placeholder string', () => {
    const result = resolveLoopHooks({
      point: 'plan:post',
      registry: realRegistry,
      config: { workflow: { post_planning_gaps: false } },
    });
    const rendered = renderLoopHooks(result);
    // GENUINE: must be exact placeholder, not a hook string
    assert.strictEqual(rendered, '_No active hooks at plan:post._',
      'rendered must be exact placeholder when no active hooks');
  });

  test('[bva] resolveLoopHooks plan:post with absent config uses schema default (post_planning_gaps=true)', () => {
    // No workflow key in config → schema default should be true → hook active
    const result = resolveLoopHooks({
      point: 'plan:post',
      registry: realRegistry,
      config: {},
    });
    // GENUINE: schema default=true means the hook should activate even with empty config
    assert.strictEqual(result.activeHooks.length, 1,
      'schema default for post_planning_gaps is true — hook must activate with empty config');
    assert.strictEqual(result.activeHooks[0].capId, 'gap-analysis');
  });

  test('[happy] real registry byLoopPoint plan:post has 1 step (mempalace), 0 contributions, and 1 gate (gap-analysis)', () => {
    const entry = realRegistry.byLoopPoint['plan:post'];
    assert.ok(entry, 'plan:post must exist in byLoopPoint');
    assert.ok(Array.isArray(entry.steps), 'steps must be an array');
    assert.ok(Array.isArray(entry.contributions), 'contributions must be an array');
    assert.ok(Array.isArray(entry.gates), 'gates must be an array');
    assert.strictEqual(entry.steps.length, 1, 'plan:post must have 1 step (mempalace capture)');
    assert.strictEqual(entry.steps[0].capId, 'mempalace', 'plan:post step must be from mempalace');
    assert.strictEqual(entry.contributions.length, 0, 'plan:post must have zero contributions');
    assert.strictEqual(entry.gates.length, 1, 'plan:post must have exactly one gate');
    assert.strictEqual(entry.gates[0].capId, 'gap-analysis');
  });
});
