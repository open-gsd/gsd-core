'use strict';
// Regression test for issue #1760 — `state prune` no-ops on template-conformant
// STATE.md because it reads `Current Phase` only, never the `Phase: X of Y` line
// the canonical template emits.
//
// ADR-1769 Phase 7 fix: derive the current phase with a `Phase` / `Current Phase`
// fallback (mirroring buildStateFrontmatter), so prune engages on template STATE.md.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writeStateMd(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);
}

describe('#1760: state prune engages on template-conformant STATE.md (Phase: X of Y)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('prune engages when STATE.md uses "Phase: N of M" (no Current Phase field)', () => {
    // Template-conformant STATE.md: Current Position uses `Phase: 10 of 15`, and
    // there is NO `**Current Phase:**` body field. Pre-fix this made prune bail
    // with "Only 0 phases — nothing to prune".
    writeStateMd(tmpDir, [
      '# Session State',
      '',
      '## Current Position',
      '',
      'Phase: 10 of 15',
      'Plan: 2 of 4',
      'Status: Executing Phase 10',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old decision',
      '- [Phase 3]: Older decision',
      '- [Phase 9]: Recent decision',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3 --dry-run', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);

    // Pre-fix: { pruned: false, reason: 'Only 0 phases — nothing to prune...' }.
    // Post-fix: prune engages and reports a real cutoff_phase (10 - 3 = 7).
    assert.strictEqual(out.pruned, false, 'dry-run must report pruned:false');
    assert.ok(out.reason === undefined || !/Only 0 phases/i.test(String(out.reason)),
      `prune must not bail with "Only 0 phases" on template STATE.md; got reason=${JSON.stringify(out.reason)}`);
    assert.strictEqual(out.cutoff_phase, 7,
      `cutoff_phase must be 7 (current 10 - keep-recent 3); got ${JSON.stringify(out.cutoff_phase)}`);
  });

  test('prune still engages when "Current Phase:" IS present (no regression)', () => {
    writeStateMd(tmpDir, [
      '# Session State',
      '',
      '**Current Phase:** 10',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old decision',
      '- [Phase 9]: Recent decision',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3 --dry-run', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.cutoff_phase, 7);
  });
});
