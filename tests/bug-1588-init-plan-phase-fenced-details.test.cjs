'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

test('init plan-phase prefers real phase details outside fenced examples and ignores backlog sentinels (#1588)', () => {
  const projectDir = createTempProject('init-1588-');
  try {
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

    const phase9 = runGsdTools('init plan-phase 9', projectDir);
    assert.ok(phase9.success, `init plan-phase 9 failed: ${phase9.error}`);
    const phase9Output = JSON.parse(phase9.output);
    assert.equal(phase9Output.phase_name, 'Real Phase');
    assert.equal(phase9Output.phase_req_ids, 'REAL-01');

    const backlog = runGsdTools('init plan-phase 999.1', projectDir);
    assert.ok(backlog.success, `init plan-phase 999.1 failed: ${backlog.error}`);
    const backlogOutput = JSON.parse(backlog.output);
    assert.equal(backlogOutput.phase_found, false);
  } finally {
    cleanup(projectDir);
  }
});
