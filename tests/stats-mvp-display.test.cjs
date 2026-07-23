/**
 * stats workflow — MVP mode summary contract test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'stats.md');

describe('stats — MVP mode summary', () => {
  const content = fs.readFileSync(WORKFLOW, 'utf-8');

  test('workflow includes MVP phase count summary', () => {
    assert.match(content, /MVP/, 'must mention MVP in summary');
    assert.match(content, /mode/i, 'must reference mode field');
  });

  test('uses roadmap.analyze to count MVP phases', () => {
    assert.match(
      content,
      /roadmap[^\n]*analyze|analyze[^\n]*mode/i,
      'must consult roadmap.analyze (which surfaces mode per phase from Phase 1)'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3150-stats-json-decimal-phase-gaps.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3150-stats-json-decimal-phase-gaps (consolidation epic #1969 B2 #1971)", () => {
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

describe('bug #3150: stats.json includes contiguous decimal phases when .10 exists', () => {
  test('stats json preserves 06.7/06.8/06.9 alongside 06.10', () => {
    const tmpDir = createTempProject('gsd-bug-3150-');
    try {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'ROADMAP.md'),
        `# Roadmap\n\n### Phase 06.6: P06.6\n**Goal:** G\n\n### Phase 06.7: P06.7\n**Goal:** G\n\n### Phase 06.8: P06.8\n**Goal:** G\n\n### Phase 06.9: P06.9\n**Goal:** G\n\n### Phase 06.10: P06.10\n**Goal:** G\n`
      );

      const dirs = ['06.6-a', '06.7-b', '06.8-c', '06.9-d', '06.10-e'];
      for (const dirName of dirs) {
        const phaseDir = path.join(tmpDir, '.planning', 'phases', dirName);
        fs.mkdirSync(phaseDir, { recursive: true });
        fs.writeFileSync(path.join(phaseDir, 'PLAN.md'), '# plan\n');
        fs.writeFileSync(path.join(phaseDir, 'SUMMARY.md'), '# summary\n');
      }

      const result = runGsdTools('stats json', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      let output;
      assert.doesNotThrow(
        () => {
          output = JSON.parse(result.output);
        },
        `Command output must be valid JSON. Raw output prefix: ${result.output.slice(0, 200)}`
      );
      assert.ok(
        output && typeof output === 'object' && !Array.isArray(output),
        `Expected object output, got: ${typeof output}`
      );
      assert.ok(
        Array.isArray(output.phases),
        `Expected output.phases array. Raw output prefix: ${result.output.slice(0, 200)}`
      );
      const phaseNumbers = output.phases.map((p) => p.number);

      assert.deepStrictEqual(
        phaseNumbers,
        ['06.6', '06.7', '06.8', '06.9', '06.10'],
        'stats.json must not skip 06.7/06.8/06.9 when 06.10 exists'
      );
      assert.equal(output.phases_total, 5);
      assert.equal(output.total_plans, 5);
      assert.equal(output.total_summaries, 5);
    } finally {
      cleanup(tmpDir);
    }
  });
});
  });
}
