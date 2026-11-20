'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3805 — audit-uat must honour the audit_acknowledged marker that
// audit-open honours.
//
// isAuditItemAcknowledged is the ONE shared suppression predicate, but its
// "every scanner below" scope ended at audit.cts's file boundary:
// cmdAuditUat (src/uat.cts) hand-rolled discovery over the SAME UAT and
// VERIFICATION artifacts and never read the marker — so the documented,
// self-invalidating "this item is moot" seam worked for audit-open and was
// ignored by audit-uat, leaving no honest way to close a moot item.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const UAT_BODY = [
  '## Tests',
  '',
  '### 1. Deleted Feature Probe',
  'expected: The deleted admin route no longer exists',
  'result: pending',
  '',
].join('\n');

function seedUatPhase(tmpDir, phaseDir, frontmatterExtra) {
  const dir = path.join(tmpDir, '.planning', 'phases', phaseDir);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    'status: human_needed',
    ...(frontmatterExtra || []),
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${phaseDir}-UAT.md`), fm + UAT_BODY);
  return dir;
}

function seedVerificationPhase(tmpDir, phaseDir, frontmatterExtra) {
  const dir = path.join(tmpDir, '.planning', 'phases', phaseDir);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    'status: human_needed',
    ...(frontmatterExtra || []),
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${phaseDir}-VERIFICATION.md`), fm + [
    '# Verification',
    '',
    '## Human Verification',
    '',
    '1. **Test:** the deleted route stays deleted',
    '   - **Result:** pending',
    '',
  ].join('\n'));
  return dir;
}

function roadmapWith(phases) {
  const lines = ['# Roadmap', ''];
  for (const p of phases) lines.push(`### Phase ${p}: P${p}`, '- [ ] w', '');
  return lines.join('\n');
}

function runAudit(cwd) {
  const r = runGsdTools(['query', 'audit-uat'], cwd);
  assert.ok(r.success, r.error);
  return JSON.parse(r.output);
}

describe('#3805: audit-uat honours audit_acknowledged', () => {
  test('#3805: an acknowledged UAT file is suppressed and counted', (t) => {
    const tmpDir = createTempProject('gsd-3805-uat-');
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapWith(['02']));
    seedUatPhase(tmpDir, '02-probe', [
      'audit_acknowledged:',
      '  milestone: v1.0',
      '  at: 2026-08-24',
      '  gap_snapshot: human_needed::scenarios=1',
    ]);
    // Note: the gap_snapshot must match the CURRENT derived value for the
    // marker to suppress (self-invalidation on edit).
    const out = runAudit(tmpDir);
    assert.equal(out.summary.total_items, 0,
      `#3805: the acknowledged UAT item must be suppressed; got ${JSON.stringify(out.results)}`);
    assert.equal(out.acknowledged_files, 1,
      '#3805: the suppressed file must be visible in acknowledged_files (audit-open honesty model)');
  });

  test('#3805: a STALE gap_snapshot (content changed since ack) still surfaces', (t) => {
    const tmpDir = createTempProject('gsd-3805-uatstale-');
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapWith(['03']));
    // Marker snapshots scenarios=2 but the file now has 1 — self-invalidation.
    seedUatPhase(tmpDir, '03-probe', [
      'audit_acknowledged:',
      '  milestone: v1.0',
      '  at: 2026-08-24',
      '  gap_snapshot: human_needed::scenarios=2',
    ]);
    const out = runAudit(tmpDir);
    assert.ok(out.summary.total_items > 0,
      'a marker whose snapshot no longer matches must NOT suppress (self-invalidation)');
    assert.equal(out.acknowledged_files, 0, 'a stale marker does not count as acknowledged');
  });

  test('#3805: an acknowledged VERIFICATION file is suppressed (status snapshot)', (t) => {
    const tmpDir = createTempProject('gsd-3805-ver-');
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapWith(['04']));
    seedVerificationPhase(tmpDir, '04-probe', [
      'audit_acknowledged:',
      '  milestone: v1.0',
      '  at: 2026-08-24',
      '  status: human_needed',
    ]);
    const out = runAudit(tmpDir);
    assert.equal(out.summary.total_items, 0,
      `#3805: the acknowledged VERIFICATION item must be suppressed; got ${JSON.stringify(out.results)}`);
    assert.equal(out.acknowledged_files, 1,
      '#3805: the suppressed VERIFICATION file must be visible in acknowledged_files');
  });

  test('#3805 control: an unacknowledged open UAT file still surfaces', (t) => {
    const tmpDir = createTempProject('gsd-3805-ctl-');
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapWith(['05']));
    seedUatPhase(tmpDir, '05-probe');
    const out = runAudit(tmpDir);
    assert.ok(out.summary.total_items > 0, 'no marker → item surfaces (pre-existing behavior)');
  });
});

// ─── #6232: the documented audit-uat scope names every layout the scan walks ────────────────────────────────────

describe('#6232: the audit-uat scope text names the archives the scan walks', () => {
  const REPO_ROOT = path.join(__dirname, '..');
  const DOCS = ['skills/gsd-audit-uat/SKILL.md', 'commands/gsd/audit-uat.md'];
  // [phase directory seeded, the layout it sits in, the fragment the scope text must carry for that layout]
  const LAYOUTS = [
    ['01-live', ['.planning', 'phases'], 'phases/*/*-UAT.md'],
    ['01-flat', ['.planning', 'milestones', 'v1.0-phases'], '{planning_root}/milestones/v*-phases'],
    ['01-wsarch', ['.planning', 'milestones', 'ws-alpha-2026-01-01', 'phases'], '{planning_root}/milestones/ws-*/phases'],
    ['01-wsflat', ['.planning', 'workstreams', 'beta', 'milestones', 'v2.0-phases'], '.planning/workstreams/<name>/milestones/v*-phases'],
    ['01-wsws', ['.planning', 'workstreams', 'beta', 'milestones', 'ws-gamma-2026-02-01', 'phases'], '.planning/workstreams/<name>/milestones/ws-*/phases'],
  ];
  const VERIFICATION_BODY = ['---', 'status: human_needed', '---', '', '# Verification', '', '## Human Verification', '',
    '1. **Test:** the route stays deleted', '   - **Result:** pending', ''].join('\n');

  function seedLayouts(tmpDir) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapWith(['01']));
    for (const [dirName, segments] of LAYOUTS) {
      const dir = path.join(tmpDir, ...segments, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${dirName}-UAT.md`), ['---', 'status: human_needed', '---', '', UAT_BODY].join('\n'));
    }
  }

  test('every seeded layout is scanned, and every scope text names it', (t) => {
    const tmpDir = createTempProject('gsd-6232-');
    t.after(() => cleanup(tmpDir));
    seedLayouts(tmpDir);
    const reported = JSON.stringify(runAudit(tmpDir).results);
    for (const [dirName] of LAYOUTS) assert.ok(reported.includes(dirName), `the scan must reach ${dirName}: ${reported}`);
    for (const rel of DOCS) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const [dirName, , fragment] of LAYOUTS) assert.ok(text.includes(fragment), `${rel} must name the layout of ${dirName} (${fragment})`);
    }
  });

  test('a VERIFICATION file in an archive layout is scanned too', (t) => {
    const tmpDir = createTempProject('gsd-6232-ver-');
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapWith(['01']));
    const dir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-archived');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-archived-VERIFICATION.md'), VERIFICATION_BODY);
    assert.ok(JSON.stringify(runAudit(tmpDir).results).includes('01-archived'));
  });

  test('the two scope blocks stay identical', () => {
    const block = (rel) => {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const start = text.indexOf('**Scope:**');
      const end = text.indexOf('</context>', start);
      return start === -1 || end === -1 ? undefined : text.slice(start, end);
    };
    assert.ok(block(DOCS[0]), 'skill scope block found');
    assert.equal(block(DOCS[0]), block(DOCS[1]));
  });
});
