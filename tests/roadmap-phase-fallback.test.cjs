/**
 * GSD Tools Tests - roadmap get-phase fallback to full ROADMAP.md
 *
 * Covers issue #1634: phases outside the current milestone slice should still
 * resolve by falling back to the full ROADMAP.md content.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// The planning-dir resolver (planningDir) is workstream-aware and honours
// GSD_PROJECT / GSD_WORKSTREAM. These suites write STATE.md to <tmp>/.planning
// and assume that is where it is read from, so a developer shell inside a GSD
// workstream would otherwise redirect the read and break extractCurrentMilestone.
// Isolate the vars so the file is hermetic when run directly via `node --test`.
let savedGsdProject;
let savedGsdWorkstream;
beforeEach(() => {
  savedGsdProject = process.env.GSD_PROJECT;
  savedGsdWorkstream = process.env.GSD_WORKSTREAM;
  delete process.env.GSD_PROJECT;
  delete process.env.GSD_WORKSTREAM;
});
afterEach(() => {
  if (savedGsdProject !== undefined) process.env.GSD_PROJECT = savedGsdProject;
  else delete process.env.GSD_PROJECT;
  if (savedGsdWorkstream !== undefined) process.env.GSD_WORKSTREAM = savedGsdWorkstream;
  else delete process.env.GSD_WORKSTREAM;
});

/**
 * Helper: write STATE.md with a milestone version so extractCurrentMilestone
 * will slice the roadmap to only that milestone's section.
 */
function writeState(tmpDir, version) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `---\nmilestone: ${version}\n---\n`
  );
}

describe('roadmap get-phase fallback to full ROADMAP.md (#1634)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('active milestone phase still resolves correctly', () => {
    writeState(tmpDir, 'v1.0');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Current Release

### Phase 1: Foundation
**Goal:** Set up project infrastructure

### Phase 2: API
**Goal:** Build REST API

## v2.0 Next Release

### Phase 3: Frontend
**Goal:** Build UI layer
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.equal(output.found, true, 'active milestone phase should be found');
    assert.equal(output.phase_number, '1');
    assert.equal(output.phase_name, 'Foundation');
    assert.equal(output.goal, 'Set up project infrastructure');
  });

  test('backlog sentinel outside current milestone does not resolve via fallback', () => {
    writeState(tmpDir, 'v1.0');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Current Release

### Phase 1: Foundation
**Goal:** Set up project infrastructure

## v2.0 Future Release

### Phase 999.60: Backlog Cleanup
**Goal:** Clean up technical debt from backlog
`
    );

    const result = runGsdTools('roadmap get-phase 999.60', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.equal(output.found, false, 'backlog sentinel should stay unresolved');
    assert.equal(output.phase_number, '999.60');
  });

  test('future planned milestone phase resolves via fallback', () => {
    writeState(tmpDir, 'v1.0');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Current Release

### Phase 1: Foundation
**Goal:** Set up project infrastructure

## v3.0 Planned Milestone

### Phase 1025: Advanced Analytics
**Goal:** Build analytics dashboard for enterprise customers

**Success Criteria** (what must be TRUE):
  1. Dashboard renders in under 2s
  2. Supports 10k concurrent users
`
    );

    const result = runGsdTools('roadmap get-phase 1025', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.equal(output.found, true, 'future milestone phase should be found via fallback');
    assert.equal(output.phase_number, '1025');
    assert.equal(output.phase_name, 'Advanced Analytics');
    assert.equal(output.goal, 'Build analytics dashboard for enterprise customers');
    assert.ok(Array.isArray(output.success_criteria), 'success_criteria should be extracted');
    assert.equal(output.success_criteria.length, 2, 'should have 2 criteria');
  });

  test('truly missing phase still returns found: false', () => {
    writeState(tmpDir, 'v1.0');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Current Release

### Phase 1: Foundation
**Goal:** Set up project infrastructure

## v2.0 Future Release

### Phase 5: Mobile
**Goal:** Build mobile app
`
    );

    const result = runGsdTools('roadmap get-phase 9999', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.equal(output.found, false, 'truly missing phase should return found: false');
    assert.equal(output.phase_number, '9999');
  });

  test('backlog checklist-only phase triggers malformed_roadmap via fallback', () => {
    writeState(tmpDir, 'v1.0');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Current Release

### Phase 1: Foundation
**Goal:** Set up project infrastructure

## v2.0 Backlog

- [ ] **Phase 50: Cleanup** - Remove old code
`
    );

    const result = runGsdTools('roadmap get-phase 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.equal(output.found, false, 'checklist-only phase should not be "found"');
    assert.equal(output.error, 'malformed_roadmap', 'should identify malformed roadmap via fallback');
    assert.ok(output.message.includes('missing'), 'should explain the issue');
  });

  test('checklist in milestone does not block full header match in wider roadmap', () => {
    writeState(tmpDir, 'v1.0');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Current Release

### Phase 1: Foundation
**Goal:** Set up project infrastructure

- [ ] **Phase 50: Cleanup** - referenced in checklist

## v2.0 Future Release

### Phase 50: Cleanup
**Goal:** Remove deprecated modules
`
    );

    const result = runGsdTools('roadmap get-phase 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.equal(output.found, true, 'full header in v2.0 should win over checklist in v1.0');
    assert.equal(output.phase_name, 'Cleanup');
    assert.equal(output.goal, 'Remove deprecated modules');
  });

  test('extractCurrentMilestone does not truncate on phase heading containing vX.Y (#2619)', () => {
    // Regression: phase heading like "### Phase 12: v1.0 Tech-Debt Closure"
    // was incorrectly treated as a milestone boundary because the greedy
    // `.*v\d+\.\d+` subpattern in nextMilestonePattern matched it.
    const core = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    writeState(tmpDir, 'v1.1');
    const roadmap = `# Roadmap

## Phases

### 🚧 v1.1 Launch-Ready (In Progress)

### Phase 11: Structured Logging
**Goal:** Add structured logging

### Phase 12: v1.0 Tech-Debt Closure
**Goal:** Close out v1.0 debt

### Phase 19: Security Audit
**Goal:** Full security audit
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('### Phase 12: v1.0 Tech-Debt Closure'),
      'slice must include Phase 12 (it lives inside the active milestone)'
    );
    assert.ok(
      slice.includes('### Phase 19: Security Audit'),
      'slice must include Phase 19 (truncation at Phase 12 would hide it)'
    );
  });

  test('extractCurrentMilestone handles PHASE/phase (case-insensitive) containing vX.Y (#2619 follow-up)', () => {
    // CodeRabbit follow-up: the negative lookahead `(?!Phase\s+\S)` must be
    // case-insensitive so PHASE/phase variants are also excluded.
    const core = require('../gsd-core/bin/lib/roadmap-parser.cjs');
    writeState(tmpDir, 'v1.1');
    const roadmap = `# Roadmap

## Phases

### 🚧 v1.1 Launch-Ready (In Progress)

### PHASE 11: Structured Logging
**Goal:** Add structured logging

### phase 12: v1.0 Tech-Debt Closure
**Goal:** Close out v1.0 debt

### Phase 19: Security Audit
**Goal:** Full security audit
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('### PHASE 11: Structured Logging'),
      'slice must include PHASE 11 (uppercase)'
    );
    assert.ok(
      slice.includes('### phase 12: v1.0 Tech-Debt Closure'),
      'slice must include phase 12 (lowercase with vX.Y)'
    );
    assert.ok(
      slice.includes('### Phase 19: Security Audit'),
      'slice must include Phase 19 (truncation at phase 12 would hide it)'
    );
  });

  test('section extraction from fallback includes correct content boundaries', () => {
    writeState(tmpDir, 'v1.0');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Current Release

### Phase 1: Foundation
**Goal:** Set up project infrastructure

## v2.0 Future Release

### Phase 10: Database
**Goal:** Schema design and migrations

This phase covers:
- Schema modeling
- Migration tooling
- Seed data

### Phase 11: Caching
**Goal:** Add Redis caching layer
`
    );

    const result = runGsdTools('roadmap get-phase 10', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.equal(output.found, true, 'phase 10 should be found via fallback');
    assert.ok(output.section.includes('Schema modeling'), 'section includes description');
    assert.ok(output.section.includes('Seed data'), 'section includes all bullets');
    assert.ok(!output.section.includes('Phase 11'), 'section does not include next phase');
  });
});

describe('extractCurrentMilestone — closed-sibling heading selection (#145)', () => {
  let tmpDir;
  const core = require('../gsd-core/bin/lib/roadmap-parser.cjs');

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('(1) first-match-skip: active sub-milestone selected over closed sibling', () => {
    writeState(tmpDir, 'v8.0');
    const roadmap = `# Project Roadmap

## v8.0 Overview — v8.0-F (CLOSED FAIL 2026-05-18)

This is the closed milestone body with some text.

### Phase 24: ARCHIVED
**Goal:** This phase is done and archived.

## v8.0-B Overview (STARTED 2026-05-18)

This is the active milestone body.

### Phase 31: EVAL
**Goal:** Evaluate the new system.

## v9.0 Future Milestone

### Phase 40: FUTURE
**Goal:** Future work.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 31: EVAL'),
      'slice must include Phase 31: EVAL from the active v8.0-B section'
    );
    assert.ok(
      slice.includes('v8.0-B Overview'),
      'slice must include the v8.0-B heading'
    );
    assert.ok(
      !slice.includes('Phase 24: ARCHIVED'),
      'slice must NOT include Phase 24: ARCHIVED from the closed section'
    );
    assert.ok(
      !slice.includes('closed milestone body'),
      'preamble must NOT contain closed v8.0-F body text (preamble boundary fix)'
    );
  });

  test('(7) workstream-aware: STATE.md under GSD_WORKSTREAM is read from the workstream subdir', () => {
    // Regression guard for the env-leak that made these suites pass in clean CI but
    // fail in a developer's GSD_WORKSTREAM shell. planningDir() is workstream-aware,
    // so STATE.md lives at <cwd>/.planning/workstreams/<ws>/STATE.md. Setting the env
    // here makes clean CI exercise the polluted-env resolution path.
    process.env.GSD_WORKSTREAM = 'guard-ws';
    try {
      const wsPlanning = path.join(tmpDir, '.planning', 'workstreams', 'guard-ws');
      fs.mkdirSync(wsPlanning, { recursive: true });
      fs.writeFileSync(path.join(wsPlanning, 'STATE.md'), '---\nmilestone: v8.0\n---\n');
      const roadmap = `# Project Roadmap

## v8.0 Overview — v8.0-F (CLOSED FAIL 2026-05-18)

This is the closed milestone body with some text.

### Phase 24: ARCHIVED
**Goal:** This phase is done and archived.

## v8.0-B Overview (STARTED 2026-05-18)

This is the active milestone body.

### Phase 31: EVAL
**Goal:** Evaluate the new system.

## v9.0 Future Milestone

### Phase 40: FUTURE
**Goal:** Future work.
`;
      const slice = core.extractCurrentMilestone(roadmap, tmpDir);
      assert.ok(
        slice.includes('Phase 31: EVAL'),
        'workstream-scoped STATE.md must select the active v8.0-B section',
      );
      assert.ok(
        !slice.includes('Phase 24: ARCHIVED'),
        'closed section must still be excluded under a workstream env',
      );
    } finally {
      delete process.env.GSD_WORKSTREAM;
    }
  });

  test('(2) double-closed-skip: third sibling (active) selected when first two are closed', () => {
    writeState(tmpDir, 'v9.0');
    const roadmap = `# Project Roadmap

## v9.0 Overview — v9.0 (CLOSED 2026-01-01)

Closed first sibling body text.

### Phase 1: OLD
**Goal:** Old closed phase.

## v9.0-A Overview (ARCHIVED 2026-03-01)

Archived second sibling body text.

### Phase 2: ALSO-OLD
**Goal:** Another archived phase.

## v9.0-C Overview (STARTED 2026-05-26)

Active sibling body text.

### Phase 5: GO
**Goal:** Active phase to work on.

## v10.0 Next Major

### Phase 99: FUTURE
**Goal:** Far future.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 5: GO'),
      'slice must include Phase 5: GO from active v9.0-C'
    );
    assert.ok(
      !slice.includes('Phase 1: OLD'),
      'slice must NOT include closed Phase 1: OLD'
    );
    assert.ok(
      !slice.includes('Phase 2: ALSO-OLD'),
      'slice must NOT include archived Phase 2: ALSO-OLD'
    );
  });

  test('(3) explicit sub-milestone resolution: exact version v8.0-B in STATE.md', () => {
    writeState(tmpDir, 'v8.0-B');
    const roadmap = `# Project Roadmap

## v8.0 Overview — v8.0-F (CLOSED FAIL 2026-05-18)

Closed milestone body.

### Phase 24: ARCHIVED
**Goal:** This phase is archived.

## v8.0-B Overview (STARTED 2026-05-18)

Active milestone body.

### Phase 31: EVAL
**Goal:** Evaluate the new system.

## v9.0 Future Milestone

### Phase 40: FUTURE
**Goal:** Future work.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 31: EVAL'),
      'slice must include Phase 31: EVAL when STATE has exact v8.0-B version'
    );
    assert.ok(
      slice.includes('v8.0-B Overview'),
      'slice must include the v8.0-B heading'
    );
  });

  test('(4) all-closed fallback: returns first match when all candidates are closed', () => {
    writeState(tmpDir, 'v7.0');
    const roadmap = `# Project Roadmap

## v7.0 Overview (CLOSED 2025-12-01)

First closed milestone body with unique text: alpha-unique-content.

### Phase 10: DONE
**Goal:** Completed phase.

## v7.0-A Overview (ARCHIVED 2025-12-15)

Second archived milestone body.

### Phase 11: ALSO-DONE
**Goal:** Another completed phase.

## v8.0 Next Milestone

### Phase 20: NEXT
**Goal:** Next milestone work.
`;
    let result;
    assert.doesNotThrow(() => {
      result = core.extractCurrentMilestone(roadmap, tmpDir);
    }, 'must not throw when all candidates are closed');
    assert.ok(
      result.includes('v7.0 Overview (CLOSED'),
      'fallback must return content including the first (closed) heading'
    );
    assert.ok(
      result.includes('alpha-unique-content'),
      'fallback must include content from the first closed section'
    );
  });

  test('(5) marker variants: emoji and text closed markers are all recognized', () => {
    writeState(tmpDir, 'v6.0');
    const roadmap = `# Project Roadmap

## ✅ v6.0 Foundation

Completed foundation body text.

### Phase 1: DONE-FOUNDATION
**Goal:** Foundation work.

## 🗄️ v6.0-B Storage

Archived storage body text.

### Phase 2: DONE-STORAGE
**Goal:** Storage work.

## v6.0-C Abandoned Experiment (FAILED)

Failed experiment body text.

### Phase 3: FAILED-EXPERIMENT
**Goal:** This failed.

## v6.0-D Overview (STARTED 2026-05-26)

Active body text.

### Phase 9: LIVE
**Goal:** Live active phase.

## v7.0 Next

### Phase 50: NEXT
**Goal:** Next milestone.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 9: LIVE'),
      'slice must include Phase 9: LIVE from the active v6.0-D section'
    );
    assert.ok(
      !slice.includes('Phase 1: DONE-FOUNDATION'),
      'slice must NOT include content from ✅ closed section'
    );
    assert.ok(
      !slice.includes('Phase 2: DONE-STORAGE'),
      'slice must NOT include content from 🗄️ archived section'
    );
    assert.ok(
      !slice.includes('Phase 3: FAILED-EXPERIMENT'),
      'slice must NOT include content from FAILED section'
    );

    // Sub-case: ABANDONED heading is also skipped
    writeState(tmpDir, 'v6.0');
    const roadmap2 = `# Project Roadmap

## v6.0-X Abandoned Prototype (ABANDONED)

Abandoned body text.

### Phase 4: ABANDONED-PHASE
**Goal:** Abandoned work.

## v6.0-D Overview (STARTED 2026-05-26)

Active sub-case body.

### Phase 9: LIVE
**Goal:** The active phase.
`;
    const slice2 = core.extractCurrentMilestone(roadmap2, tmpDir);
    assert.ok(
      slice2.includes('Phase 9: LIVE'),
      'ABANDONED marker must be skipped and active section selected'
    );
    assert.ok(
      !slice2.includes('Phase 4: ABANDONED-PHASE'),
      'slice must NOT include content from ABANDONED section'
    );
  });

  test('(6) single-milestone no-regression: behavior unchanged with one matching heading', () => {
    writeState(tmpDir, 'v5.0');
    const roadmap = `# Project Roadmap

## Roadmap v5.0: Solo

This is the only milestone.

### Phase 1: Only
**Goal:** The only phase in this roadmap.

## v6.0 Future

### Phase 2: FUTURE
**Goal:** Future work.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 1: Only'),
      'slice must include Phase 1: Only when only one matching heading exists'
    );
  });
});

describe('extractCurrentMilestone — boundary / active-override hardening (#145 follow-up)', () => {
  let tmpDir;
  const core = require('../gsd-core/bin/lib/roadmap-parser.cjs');

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('(a) BOUNDARY: v2.0-B in STATE must not match v2.0-Beta heading', () => {
    writeState(tmpDir, 'v2.0-B');
    const roadmap = `# Project Roadmap

## v2.0-Beta Overview (STARTED)

Beta milestone body.

### Phase 1: BETA
**Goal:** Beta phase work.

## v2.0-B Overview (STARTED)

Real milestone body.

### Phase 2: REAL
**Goal:** Real phase work.

## v3.0 Future

### Phase 99: FUTURE
**Goal:** Future work.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 2: REAL'),
      'slice must include Phase 2: REAL from the v2.0-B section'
    );
    assert.ok(
      slice.includes('v2.0-B Overview'),
      'slice must include the v2.0-B heading'
    );
    assert.ok(
      !slice.includes('Phase 1: BETA'),
      'slice must NOT include Phase 1: BETA from the v2.0-Beta section'
    );
    assert.ok(
      !slice.includes('v2.0-Beta Overview'),
      'slice must NOT include the v2.0-Beta heading'
    );
  });

  test('(b) SHIPPED-skip: v3.0 state picks v3.0-B over v3.0-A (SHIPPED)', () => {
    writeState(tmpDir, 'v3.0');
    const roadmap = `# Project Roadmap

## v3.0 Overview — v3.0-A (SHIPPED)

Shipped milestone body.

### Phase 1: OLD
**Goal:** Old shipped phase.

## v3.0-B Overview (STARTED)

Active milestone body.

### Phase 2: NEW
**Goal:** New active phase.

## v4.0 Future

### Phase 99: FUTURE
**Goal:** Future work.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 2: NEW'),
      'slice must include Phase 2: NEW from the active v3.0-B section'
    );
    assert.ok(
      !slice.includes('Phase 1: OLD'),
      'slice must NOT include Phase 1: OLD from the SHIPPED v3.0-A section'
    );
  });

  test('(c) ACTIVE-OVERRIDE: heading with "Shipped" in name but STARTED marker is not closed', () => {
    writeState(tmpDir, 'v4.0');
    const roadmap = `# Project Roadmap

## v4.0-A Legacy (CLOSED)

Closed milestone body.

### Phase 1: GONE
**Goal:** Closed phase.

## v4.0-B Shipped logs pipeline (STARTED)

Active milestone body.

### Phase 2: LIVE
**Goal:** Active live phase.

## v5.0 Future

### Phase 99: FUTURE
**Goal:** Future work.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 2: LIVE'),
      'slice must include Phase 2: LIVE — STARTED overrides "Shipped" in name'
    );
    assert.ok(
      !slice.includes('Phase 1: GONE'),
      'slice must NOT include Phase 1: GONE from the CLOSED v4.0-A section'
    );
  });

  test('(d) FAIL-SAFE naming: FAIL-safe in heading name is not a closed marker', () => {
    writeState(tmpDir, 'v5.0');
    const roadmap = `# Project Roadmap

## v5.0-A Retired (ARCHIVED)

Archived milestone body.

### Phase 1: DEAD
**Goal:** Archived phase.

## v5.0-B FAIL-safe rollout (STARTED)

Active milestone body.

### Phase 2: GO
**Goal:** Active rollout phase.

## v6.0 Future

### Phase 99: FUTURE
**Goal:** Future work.
`;
    const slice = core.extractCurrentMilestone(roadmap, tmpDir);
    assert.ok(
      slice.includes('Phase 2: GO'),
      'slice must include Phase 2: GO — FAIL-safe must not be treated as a closed marker'
    );
    assert.ok(
      !slice.includes('Phase 1: DEAD'),
      'slice must NOT include Phase 1: DEAD from the ARCHIVED v5.0-A section'
    );
  });
});
