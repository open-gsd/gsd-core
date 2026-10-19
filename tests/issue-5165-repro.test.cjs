'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Reproduction test for issue #5165
// Tests: (1) progress counts only current milestone, (2) phase.complete re-run is no-op

describe('issue #5165: milestone progress and phase.complete rewind', () => {
  const gsdTools = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
  
  function runGsd(cwd, args) {
    // Quote arguments that contain spaces
    const quotedArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
    const cmd = `node ${gsdTools} query ${quotedArgs.join(' ')}`;
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  }
  
  function createTestProject(baseDir) {
    const phasesDir = path.join(baseDir, '.planning', 'phases');
    
    // Create phase directories
    fs.mkdirSync(path.join(phasesDir, '01-one'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '02-two'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '03-three'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '04-four'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '04.1-hotfix'), { recursive: true });
    
    // Create ROADMAP.md with milestone-grouped format
    const roadmap = `# Roadmap: Demo

## Milestones

- ✅ **v1.0 MVP** - Phases 1-2 (shipped 2026-09-01)
- 🚧 **v1.1 Next** - Phases 3-5 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-2) - SHIPPED 2026-09-01</summary>

### Phase 1: One
**Goal**: one
**Plans**: 1 plan

### Phase 2: Two
**Goal**: two
**Plans**: 1 plan

</details>

### 🚧 v1.1 Next (In Progress)

**Milestone Goal:** next

- [x] **Phase 3: Three** - three (completed 2026-09-20)
- [ ] **Phase 4: Four** - four
- [ ] **Phase 04.1: Hotfix** - hotfix (INSERTED)
- [ ] **Phase 5: Five** - five

#### Phase 3: Three
**Goal**: three
**Plans**: 1/1 plans complete

#### Phase 4: Four
**Goal**: four
**Success Criteria**:
  1. it works
**Plans**: 1 plan

#### Phase 04.1: Hotfix (INSERTED)
**Goal**: hotfix
**Plans**: TBD

#### Phase 5: Five
**Goal**: five
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. One | v1.0 | 1/1 | Complete | 2026-08-20 |
| 2. Two | v1.0 | 1/1 | Complete | 2026-09-01 |
| 3. Three | v1.1 | 1/1 | Complete | 2026-09-20 |
| 4. Four | v1.1 | 0/1 | In progress | - |
| 04.1. Hotfix | v1.1 | 0/0 | Not started | - |
| 5. Five | v1.1 | 0/0 | Not started | - |
`;
    fs.writeFileSync(path.join(baseDir, '.planning', 'ROADMAP.md'), roadmap);
    
    // Create STATE.md
    const state = `---
gsd_state_version: '1.0'
milestone: v1.1
milestone_name: Next
status: executing
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
  percent: 25
---

# Project State

## Current Position

Phase: 4 of 4 (Four)
Plan: 1 of 1 in current phase
Status: In progress
Last activity: 2026-10-01 — Plan 04-01 complete

Progress: [██░░░░░░░░] 25%

## Session Continuity

Last session: 2026-10-01T00:00:00.000Z
Stopped at: Plan 04-01 complete
Resume file: None
`;
    fs.writeFileSync(path.join(baseDir, '.planning', 'STATE.md'), state);
    
    // Create phase files
    const fm = (phase, plan) => `---\nphase: ${phase}\nplan: ${plan}\n---\n# x\n`;
    fs.writeFileSync(path.join(phasesDir, '01-one', '01-01-PLAN.md'), fm('01', '01'));
    fs.writeFileSync(path.join(phasesDir, '01-one', '01-01-SUMMARY.md'), fm('01', '01'));
    fs.writeFileSync(path.join(phasesDir, '02-two', '02-01-PLAN.md'), fm('02', '01'));
    fs.writeFileSync(path.join(phasesDir, '02-two', '02-01-SUMMARY.md'), fm('02', '01'));
    fs.writeFileSync(path.join(phasesDir, '03-three', '03-01-PLAN.md'), fm('03', '01'));
    fs.writeFileSync(path.join(phasesDir, '03-three', '03-01-SUMMARY.md'), fm('03', '01'));
    fs.writeFileSync(path.join(phasesDir, '04-four', '04-01-PLAN.md'), fm('04', '01'));
    fs.writeFileSync(path.join(phasesDir, '04-four', '04-01-SUMMARY.md'), fm('04', '01'));
    
    // Add verification for phases 3 and 4
    fs.writeFileSync(path.join(phasesDir, '03-three', '03-VERIFICATION.md'), '---\nphase: 03\nstatus: passed\n---\n# Verification\n');
    fs.writeFileSync(path.join(phasesDir, '04-four', '04-VERIFICATION.md'), '---\nphase: 04\nstatus: passed\n---\n# Verification\n');
    
    // Add context for 04.1
    fs.writeFileSync(path.join(phasesDir, '04.1-hotfix', '04.1-CONTEXT.md'), '# context\n');
    
    // Initialize git repo
    execSync('git init -q', { cwd: baseDir });
    execSync('git config user.email "test@test.com"', { cwd: baseDir });
    execSync('git config user.name "Test User"', { cwd: baseDir });
    execSync('git add -A', { cwd: baseDir });
    execSync('git commit -q -m "base"', { cwd: baseDir });
    
    // Prime STATE.md with a no-op write
    runGsd(baseDir, ['state.record-session', '--stopped-at', 'Plan 04-01 complete', '--resume-file', 'None']);
    execSync('git add -A', { cwd: baseDir });
    execSync('git commit -q -m "primed"', { cwd: baseDir });
    
    return baseDir;
  }
  
  test('R1a: phase.complete 4 should set percent=50, not 67', () => {
    const tmpDir = fs.mkdtempSync('/tmp/gsd-5165-');
    try {
      createTestProject(tmpDir);
      
      // Run phase.complete 4
      runGsd(tmpDir, ['phase.complete', '4']);
      
      // Read STATE.md and check percent
      const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
      
      // Should be 50% (2 of 4 phases in v1.1 complete), not 67% or 100%
      assert.ok(state.includes('percent: 50') || state.includes('Progress: [█████░░░░░] 50%'),
        `Expected percent=50, got:\n${state.match(/percent: \d+|Progress:.*\d+%/)?.[0]}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
  
  test('R1b: record-session after phase.complete should not change percent', () => {
    const tmpDir = fs.mkdtempSync('/tmp/gsd-5165-');
    try {
      createTestProject(tmpDir);
      
      // Run phase.complete 4
      runGsd(tmpDir, ['phase.complete', '4']);
      
      // Run record-session
      runGsd(tmpDir, ['state.record-session', '--stopped-at', 'X', '--resume-file', 'Y']);
      
      // Read STATE.md and check percent is still 50
      const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
      
      assert.ok(state.includes('percent: 50') || state.includes('Progress: [█████░░░░░] 50%'),
        `Expected percent=50 after record-session, got:\n${state.match(/percent: \d+|Progress:.*\d+%/)?.[0]}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
  
  test('R2: phase.complete 3 (already complete) should be no-op', () => {
    const tmpDir = fs.mkdtempSync('/tmp/gsd-5165-');
    try {
      createTestProject(tmpDir);
      
      // Get initial state
      const initialState = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
      
      // Run phase.complete 3 (already complete)
      runGsd(tmpDir, ['phase.complete', '3']);
      
      // Read state after
      const finalState = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
      
      // Should be no-op (except timestamps)
      // Extract non-timestamp lines for comparison
      const stripTimestamps = (s) => s
        .replace(/last_updated:.*$/gm, '')
        .replace(/Last session:.*$/gm, '')
        .replace(/Stopped at:.*$/gm, 'Stopped at: TIMESTAMP')
        .replace(/Last activity:.*$/gm, 'Last activity: TIMESTAMP');
      
      assert.strictEqual(stripTimestamps(initialState), stripTimestamps(finalState),
        'phase.complete on already-complete phase should be no-op');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
