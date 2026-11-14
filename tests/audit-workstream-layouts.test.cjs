'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3804 — audit-uat must see all three phase-archive layouts.
//
// listArchiveVersionDirs matched exactly one layout
// (`milestones/vX.Y-phases/<dir>/`). Two workstream layouts missed:
// archived workstream milestones (`milestones/ws-<slug>-<date>/phases/<dir>/`)
// and active workstream milestones
// (`workstreams/<ws>/milestones/vX.Y-phases/<dir>/`) — so a project using
// workstreams got an "All Clear" audit while items were open (the reporter's
// repo: 20 hidden phase artifacts), and `--ws` emptied the report entirely.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

function seedPhaseArtifact(dir, kind) {
  fs.mkdirSync(dir, { recursive: true });
  if (kind === 'deferred') {
    fs.writeFileSync(path.join(dir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- open workstream item needing a human',
      '',
    ].join('\n'));
  } else {
    // The canonical UAT.md shape the parser reads: `### N. <name>` test
    // blocks with expected/result field lines (see tests/uat.test.cjs's
    // fixtures) — the numbered-list form parses to zero items.
    fs.writeFileSync(path.join(dir, `${path.basename(dir)}-UAT.md`), [
      '---',
      'status: testing',
      '---',
      '',
      '## Tests',
      '',
      '### 1. Boot Flow',
      'expected: Workstream phase boots',
      'result: pending',
      '',
    ].join('\n'));
  }
}

function runAudit(cwd, extraArgs = []) {
  const r = runGsdTools(['query', 'audit-uat', ...extraArgs], cwd);
  assert.ok(r.success, r.error);
  return JSON.parse(r.output);
}

describe('#5042: debug sessions use the shared root directory', () => {
  test('audit-open finds root debug sessions under an active workstream', (t) => {
    const tmpDir = createTempProject('gsd-5042-debug-');
    t.after(() => cleanup(tmpDir));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    const debugDir = path.join(tmpDir, '.planning', 'debug');
    fs.mkdirSync(debugDir);
    fs.writeFileSync(path.join(debugDir, 'login-fails.md'),
      '---\nstatus: investigating\n---\n## Current Focus\nlogin failure\n');

    const result = runGsdTools(['audit-open', '--json'], tmpDir, {
      GSD_WORKSTREAM: 'alpha', HOME: tmpDir, USERPROFILE: tmpDir,
    });
    assert.ok(result.success, result.error);
    const audit = JSON.parse(result.output);
    assert.equal(audit.counts.debug_sessions, 1);
    assert.equal(audit.items.debug_sessions[0].slug, 'login-fails');
  });

  test('audit-open ignores a workstream-scoped debug directory', (t) => {
    const tmpDir = createTempProject('gsd-5042-ws-debug-');
    t.after(() => cleanup(tmpDir));
    const workstreamDebugDir = path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'debug');
    fs.mkdirSync(workstreamDebugDir, { recursive: true });
    fs.writeFileSync(path.join(workstreamDebugDir, 'wrong-location.md'),
      '---\nstatus: investigating\n---\n## Current Focus\nwrong location\n');

    const result = runGsdTools(['audit-open', '--json'], tmpDir, {
      GSD_WORKSTREAM: 'alpha', HOME: tmpDir, USERPROFILE: tmpDir,
    });
    assert.ok(result.success, result.error);
    const audit = JSON.parse(result.output);
    assert.equal(audit.counts.debug_sessions, 0);
    assert.deepEqual(audit.items.debug_sessions, []);
  });
});

describe('#3804: audit-uat sees all three phase layouts', () => {
  test('#3804: archived workstream milestones surface in audit-uat', (t) => {
    const tmpDir = createTempProject('gsd-3804-wsarch-');
    t.after(() => cleanup(tmpDir));
    const wsArchive = path.join(tmpDir, '.planning', 'milestones',
      'ws-v7-3-catalog-models-2026-08-23', 'phases', '185-catalog-admin');
    seedPhaseArtifact(wsArchive, 'deferred');

    const out = runAudit(tmpDir);
    const phase185 = out.results.filter((r) => String(r.phase).startsWith('185'));
    assert.ok(
      phase185.length >= 1 && phase185.some((r) => (r.items || []).length > 0),
      `#3804: the archived workstream phase must surface with its open item; got ${JSON.stringify(out.results.map((r) => ({ phase: r.phase, items: (r.items || []).length })))}`,
    );
  });

  test('#3804: active workstream milestones surface in audit-uat (and --ws does not empty the report)', (t) => {
    const tmpDir = createTempProject('gsd-3804-wsact-');
    t.after(() => cleanup(tmpDir));
    const wsMilestone = path.join(tmpDir, '.planning', 'workstreams', 'v7-2-boot-obs',
      'milestones', 'v1.0-phases', '176-boot-flow');
    seedPhaseArtifact(wsMilestone, 'uat');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'v7-2-boot-obs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'workstreams', 'v7-2-boot-obs', 'config.json'), '{}');

    const bare = runAudit(tmpDir);
    assert.ok(
      bare.results.some((r) => String(r.phase).startsWith('176') && (r.items || []).length > 0),
      `#3804: a flat (no --ws) audit must see the active workstream milestone's open item; got ${JSON.stringify(bare.summary)}`,
    );

    const scoped = runAudit(tmpDir, ['--ws', 'v7-2-boot-obs']);
    assert.ok(
      scoped.summary.total_items > 0,
      `#3804: --ws must not empty the report; got ${JSON.stringify(scoped.summary)}`,
    );
  });

  test('#3804 control: the flat archive layout still surfaces', (t) => {
    const tmpDir = createTempProject('gsd-3804-flat-');
    t.after(() => cleanup(tmpDir));
    seedPhaseArtifact(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '09-old'), 'deferred');

    const out = runAudit(tmpDir);
    assert.ok(
      out.results.some((r) => String(r.phase).startsWith('09') && (r.items || []).length > 0),
      'the pre-existing flat archive layout must keep surfacing',
    );
  });

  test('#3804 review: root and workstream v1.0 archives carry DISTINCT milestone labels', (t) => {
    // Two v1.0-phases trees (root + workstream) must not both label 'v1.0' —
    // audit acknowledge resolves --archived-milestone by strict label
    // equality, first-wins, so an ambiguous label can write the marker into
    // the wrong root's phase dir (#2237 class).
    const tmpDir = createTempProject('gsd-3804-labels-');
    t.after(() => cleanup(tmpDir));
    seedPhaseArtifact(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '42-root'), 'deferred');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    seedPhaseArtifact(path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'milestones', 'v1.0-phases', '42-alpha'), 'deferred');

    const out = runAudit(tmpDir);
    const labels = out.results.map((r) => r.archived_milestone).filter(Boolean);
    assert.ok(labels.includes('v1.0'), `the root label stays the bare version; got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('alpha/v1.0'), `the workstream label is prefixed; got ${JSON.stringify(labels)}`);
    assert.equal(new Set(labels).size, labels.length, 'labels must be unique across roots');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #6172 — one archived VERIFICATION.md with an out-of-set status must not
// abort the whole audit-open.
//
// scanVerificationGaps walks archived milestone roots as well as the active
// phases root and read every report through the closed-set reader, which
// throws on any status outside the set. The scan's caller rethrows that error
// on purpose (ADR-5057, the active-root hard refusal), so a single archived
// `status: resolved` report made `audit-open` exit 1 and blocked the
// /gsd-complete-milestone pre-close audit — on a file the user cannot fix
// through validate.health. Archived reports are history: an out-of-set status
// there becomes ONE reported item and the scan continues. Active reports keep
// the hard refusal.
// ─────────────────────────────────────────────────────────────────────────────

const fc = require('fast-check');
const auditMod = require('../gsd-core/bin/lib/audit.cjs');

function seedVerification(root, dirName, statusLine, extraFm = []) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const phaseToken = dirName.split('-')[0];
  fs.writeFileSync(path.join(dir, `${phaseToken}-VERIFICATION.md`), [
    '---',
    ...(statusLine === null ? [] : [statusLine]),
    ...extraFm,
    '---',
    '',
    '# Verification',
    '',
  ].join('\n'));
  return path.join(dir, `${phaseToken}-VERIFICATION.md`);
}

const ARCHIVE_ROOT = (tmpDir) => path.join(tmpDir, '.planning', 'milestones', 'v1.3-phases');
const ACTIVE_ROOT = (tmpDir) => path.join(tmpDir, '.planning', 'phases');

describe('#6172: archived out-of-set verification status does not abort audit-open', () => {
  for (const status of ['resolved', 'verified', 'failed', 'pass_with_caveats']) {
    test(`#6172: archived status "${status}" + clean active phase → exit 0, exactly one item`, (t) => {
      const tmpDir = createTempProject('gsd-6172-arch-');
      t.after(() => cleanup(tmpDir));
      seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', `status: ${status}`);
      seedVerification(ACTIVE_ROOT(tmpDir), '13-beta', 'status: passed');

      const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
      assert.ok(r.success, `audit-open must not abort on an archived "${status}" report: ${r.error}`);
      const out = JSON.parse(r.output);
      assert.equal(out.counts.verification_gaps, 1);
      assert.equal(out.items.verification_gaps.length, 1);
      const item = out.items.verification_gaps[0];
      assert.equal(item.archived_milestone, 'v1.3');
      assert.equal(item.file, '12-VERIFICATION.md');
      assert.equal(item.status, status, 'the item carries the raw status');
      assert.equal(out.has_open_items, true);
    });
  }

  test('#6172: the human report also succeeds and names the item', (t) => {
    const tmpDir = createTempProject('gsd-6172-human-');
    t.after(() => cleanup(tmpDir));
    seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', 'status: resolved');
    const r = runGsdTools(['query', 'audit-open'], tmpDir);
    assert.ok(r.success, r.error);
    assert.match(r.output, /12-VERIFICATION\.md/);
    assert.match(r.output, /archived v1\.3/);
  });

  test('#6172: the scan continues — a genuine gaps_found / human_needed report is still reported', (t) => {
    const tmpDir = createTempProject('gsd-6172-continue-');
    t.after(() => cleanup(tmpDir));
    seedVerification(ARCHIVE_ROOT(tmpDir), '01-first', 'status: resolved');
    seedVerification(ARCHIVE_ROOT(tmpDir), '02-second', 'status: gaps_found');
    seedVerification(ACTIVE_ROOT(tmpDir), '13-beta', 'status: human_needed');
    seedVerification(ARCHIVE_ROOT(tmpDir), '03-third', 'status: passed');

    const out = JSON.parse(runGsdTools(['query', 'audit-open', '--json'], tmpDir).output);
    const files = out.items.verification_gaps.map((i) => i.file).sort();
    assert.deepEqual(files, ['01-VERIFICATION.md', '02-VERIFICATION.md', '13-VERIFICATION.md']);
    assert.equal(out.counts.verification_gaps, 3, 'a passed archived report produces no item');
  });

  test('#6172: the same out-of-set status in the ACTIVE phases root still exits 1', (t) => {
    const tmpDir = createTempProject('gsd-6172-active-');
    t.after(() => cleanup(tmpDir));
    seedVerification(ACTIVE_ROOT(tmpDir), '13-beta', 'status: resolved');
    const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
    assert.equal(r.success, false, 'ADR-5057 hard refusal on the active root is unchanged');
    assert.match(r.error, /resolved/);
  });

  test('#6172: a workstream archive is archived too', (t) => {
    const tmpDir = createTempProject('gsd-6172-ws-');
    t.after(() => cleanup(tmpDir));
    const wsRoot = path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'milestones', 'v1.0-phases');
    seedVerification(wsRoot, '42-alpha', 'status: verified');
    const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.items.verification_gaps.length, 1);
    assert.equal(out.items.verification_gaps[0].archived_milestone, 'alpha/v1.0');
  });

  test('#6172: the archived item can be acknowledged; the next scan counts it as acknowledged', (t) => {
    const tmpDir = createTempProject('gsd-6172-ack-');
    t.after(() => cleanup(tmpDir));
    // Mixed case: the acknowledge writer stores the LOWERCASED raw status, so
    // the scan must compare against the lowercased raw status too.
    const file = seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', 'status: Resolved');
    const first = JSON.parse(runGsdTools(['query', 'audit-open', '--json'], tmpDir).output);
    assert.equal(first.items.verification_gaps.length, 1);

    const ack = runGsdTools([
      'audit-open', 'acknowledge', '--category', 'verification_gaps', '--milestone', 'v1.3',
      '--phase', first.items.verification_gaps[0].phase, '--file', first.items.verification_gaps[0].file,
      '--archived-milestone', 'v1.3',
    ], tmpDir);
    assert.ok(ack.success, ack.error);
    assert.match(fs.readFileSync(file, 'utf-8'), /audit_acknowledged/);

    const second = JSON.parse(runGsdTools(['query', 'audit-open', '--json'], tmpDir).output);
    assert.equal(second.counts.verification_gaps, 0);
    assert.equal(second.acknowledged.verification_gaps, 1);
  });

  test('#6172: a non-string status in an archived report does not throw and displays as a string', (t) => {
    const tmpDir = createTempProject('gsd-6172-nonstr-');
    t.after(() => cleanup(tmpDir));
    seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', 'status: [a, b]');
    seedVerification(ARCHIVE_ROOT(tmpDir), '13-beta', 'status: 7');
    const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const items = JSON.parse(r.output).items.verification_gaps;
    assert.equal(items.length, 2);
    for (const item of items) assert.equal(typeof item.status, 'string');
  });

  test('#6172: control bytes in a raw archived status are sanitized for display', (t) => {
    const tmpDir = createTempProject('gsd-6172-sanitize-');
    t.after(() => cleanup(tmpDir));
    seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', 'status: "evil\\u001b[31mred"');
    const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const item = JSON.parse(r.output).items.verification_gaps[0];
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(item.status, /[\u0000-\u001f\u007f]/);
  });

  test('#6172 property: over arbitrary raw status strings, archived never throws; active throws iff outside the closed set', () => {
    // Source the closed set from the owner so the oracle cannot drift from it.
    const CLOSED = require('../gsd-core/bin/lib/verification.cjs').VERIFIER_STATUSES;
    // Bare YAML scalars that parse to null/boolean rather than a string are
    // "no status" to the closed-set reader, a different branch; exclude them.
    const NON_STRING_SCALARS = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n']);
    const statusArb = fc.oneof(
      fc.constantFrom(...CLOSED),
      fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')), minLength: 1, maxLength: 12 }),
    ).filter((s) => !NON_STRING_SCALARS.has(s.toLowerCase()));
    const auditStatus = (root, status) => {
      const tmpDir = createTempProject('gsd-6172-prop-');
      try {
        seedVerification(root(tmpDir), '12-alpha', `status: ${status}`);
        auditMod.auditOpenArtifacts(tmpDir);
        return false;
      } catch {
        return true;
      } finally {
        cleanup(tmpDir);
      }
    };
    fc.assert(fc.property(statusArb, (status) => {
      const archivedThrew = auditStatus(ARCHIVE_ROOT, status);
      const activeThrew = auditStatus(ACTIVE_ROOT, status);
      return archivedThrew === false && activeThrew === !CLOSED.has(status);
    }), { numRuns: 60 });
  });
});
