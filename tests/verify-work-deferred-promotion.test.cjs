'use strict';

/**
 * Writer-contract + parity tests for the #4546 deferred-follow-up promotion.
 *
 * Two parallel surfaces own the deferral contract:
 *   - the WRITER: gsd-core/workflows/verify-work.md, whose process_response step
 *     writes `reason: "Deferred follow-up: {verbatim user response}"` and whose
 *     complete_session step must offer 999.x promotion of the Deferred
 *     Follow-Ups section (reusing next.md's prior_phase_completeness entry
 *     shape);
 *   - the READER: the UAT predicate (src/uat-predicate.cts), which must treat
 *     that exact template text as non-blocking.
 *
 * Row 8 drives the writer's OWN template text (extracted from the shipped
 * workflow, placeholder substituted) through the real predicate — if either
 * surface changes its half of the contract, this fails.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateUatPassed } = require('../gsd-core/bin/lib/uat-predicate.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const VERIFY_WORK_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'verify-work.md');
const NEXT_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'next.md');

function readWorkflow(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

/** Extract the body of a named <step> block from a workflow, or throw. */
function stepBlock(src, stepName, label) {
  const start = src.indexOf(`<step name="${stepName}">`);
  assert.ok(start !== -1, `${label} must contain <step name="${stepName}">`);
  const end = src.indexOf('</step>', start);
  assert.ok(end !== -1, `<step name="${stepName}"> must be closed`);
  return src.slice(start, end);
}

describe('verify-work deferred follow-up promotion (#4546)', () => {
  const verifyWork = readWorkflow(VERIFY_WORK_PATH);

  test('writer reason template matches the predicate matcher (#4546 parity)', () => {
    // Extract the shipped reason template from the writer (process_response
    // step): `reason: "Deferred follow-up: {verbatim user response}"`.
    const m = verifyWork.match(/reason: "(Deferred follow-up: \{[^}]+\})"/);
    assert.ok(m, 'verify-work.md process_response must write the deferred reason template');
    const templateText = m[1]; // e.g. `Deferred follow-up: {verbatim user response}`
    const sampleReason = templateText.replace(/\{[^}]+\}/, 'nice to have, next version');

    // Drive the writer's own template text through the real predicate: a UAT
    // file whose only non-passing item carries this reason must pass.
    // allow-test-rule: source-text-is-the-product (#4546) — the readFileSync
    // in readWorkflow above is this marker's other suppression site: the
    // workflow text is the deployed contract.
    const tmpDir = createTempDir('gsd-4546-parity-');
    const content = [
      '---', 'status: complete', '---', '',
      '### 1. Test A', 'expected: A', 'result: passed', '',
      '### 2. Test B', 'expected: B', 'result: skipped',
      `reason: "${sampleReason}"`, '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'phase-UAT.md'), content, 'utf8');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true,
      `the writer's own deferred template text must be non-blocking to the reader: ${JSON.stringify(report.blockers)}`);
    cleanup(tmpDir);
  });

  test('complete_session offers 999.x promotion of deferred follow-ups (#4546)', () => {
    const block = stepBlock(verifyWork, 'complete_session', 'verify-work.md');

    // Detection: the step must read the Deferred Follow-Ups section the
    // process_response step writes (same section name, exact).
    assert.match(block, /Deferred Follow-Ups/,
      'complete_session must consult the Deferred Follow-Ups section');

    // An OFFER (not silent auto-mutation): the literal [P]/[K] choice pair
    // must exist — a bare prose 'offer' would satisfy nothing testable.
    assert.match(block, /\[P\] Promote to ROADMAP\.md 999\.x backlog/,
      'complete_session must present the [P] promote choice');
    assert.match(block, /\[K\] Keep them in the UAT file only/,
      'complete_session must present the [K] keep choice');

    // The promoted entry reuses next.md's exact mechanism shape.
    const nextWork = readWorkflow(NEXT_PATH);
    const nextBlock = stepBlock(nextWork, 'prior_phase_completeness', 'next.md');
    const nextShapeMarkers = ['### Phase 999.', '**Goal:**', '**Source phase:**', '**Deferred at:**'];
    for (const marker of nextShapeMarkers) {
      assert.ok(nextBlock.includes(marker),
        `next.md prior_phase_completeness entry shape must contain ${marker} (fixture sanity)`);
      assert.match(block, new RegExp(escapeRegex(marker)),
        `complete_session promotion entry must reuse the next.md shape marker: ${marker}`);
    }

    // The deferral record is committed scoped to the roadmap.
    assert.match(block, /--files[^\n]*ROADMAP\.md/,
      'the promotion commit must be scoped to .planning/ROADMAP.md via --files');
  });
});
