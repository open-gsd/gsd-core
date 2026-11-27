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

const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const auditMod = require('../gsd-core/bin/lib/audit.cjs');
const { VERIFIER_STATUSES, VerificationStatusError } = require('../gsd-core/bin/lib/verification.cjs');

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

    const result = runGsdTools(['audit-open', '--json'], tmpDir, isolatedEnv({
      home: tmpDir, override: { GSD_WORKSTREAM: 'alpha' },
    }));
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

    const result = runGsdTools(['audit-open', '--json'], tmpDir, isolatedEnv({
      home: tmpDir, override: { GSD_WORKSTREAM: 'alpha' },
    }));
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

  test('#6172 (control): the same out-of-set status in the ACTIVE phases root still exits 1', (t) => {
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

  // Under FAILSAFE_SCHEMA every scalar is a string, so a list, a map and a bare
  // `status:` ({}) are the only non-string statuses a report can carry.
  const NON_STRING_STATUSES = [
    ['a list', 'status: [a, b]', '["a","b"]'],
    ['a map', 'status: {k: V}', '{"k":"v"}'],
    ['a bare `status:`', 'status:', '{}'],
  ];
  for (const [label, statusLine, shown] of NON_STRING_STATUSES) {
    test(`#6172: ${label} status in an archived report is one item, displayed as ${shown}`, (t) => {
      const tmpDir = createTempProject('gsd-6172-nonstr-');
      t.after(() => cleanup(tmpDir));
      seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', statusLine);
      const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
      assert.ok(r.success, r.error);
      const items = JSON.parse(r.output).items.verification_gaps;
      assert.equal(items.length, 1);
      assert.equal(items[0].status, shown);
    });

    test(`#6172: ${label} status in an archived report can be acknowledged and re-scans as acknowledged`, (t) => {
      const tmpDir = createTempProject('gsd-6172-nonstr-ack-');
      t.after(() => cleanup(tmpDir));
      seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', statusLine);
      const first = JSON.parse(runGsdTools(['query', 'audit-open', '--json'], tmpDir).output);
      assert.equal(first.items.verification_gaps.length, 1);

      const ack = runGsdTools([
        'audit-open', 'acknowledge', '--category', 'verification_gaps', '--milestone', 'v1.3',
        '--phase', first.items.verification_gaps[0].phase, '--file', first.items.verification_gaps[0].file,
        '--archived-milestone', 'v1.3',
      ], tmpDir);
      assert.ok(ack.success, `acknowledge must not throw on ${label}: ${ack.error}`);

      const second = JSON.parse(runGsdTools(['query', 'audit-open', '--json'], tmpDir).output);
      assert.equal(second.counts.verification_gaps, 0);
      assert.equal(second.acknowledged.verification_gaps, 1);
    });
  }

  test('#6172: an out-of-set item says so in --json (out_of_set) and in the human report; a genuine gap does not', (t) => {
    const tmpDir = createTempProject('gsd-6172-flag-');
    t.after(() => cleanup(tmpDir));
    seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', 'status: resolved');
    seedVerification(ARCHIVE_ROOT(tmpDir), '13-beta', 'status: gaps_found');
    const out = JSON.parse(runGsdTools(['query', 'audit-open', '--json'], tmpDir).output);
    const byFile = Object.fromEntries(out.items.verification_gaps.map((i) => [i.file, i]));
    assert.equal(byFile['12-VERIFICATION.md'].out_of_set, true);
    assert.equal('out_of_set' in byFile['13-VERIFICATION.md'], false);

    const human = runGsdTools(['query', 'audit-open'], tmpDir).output.split('\n');
    assert.match(human.find((l) => l.includes('12-VERIFICATION.md')), /outside gaps_found\/human_needed\/passed/);
    assert.doesNotMatch(human.find((l) => l.includes('13-VERIFICATION.md')), /outside/);
  });

  test('#6172: a number-looking status is the string "7" (FAILSAFE_SCHEMA) and is reported with that exact value', (t) => {
    const tmpDir = createTempProject('gsd-6172-seven-');
    t.after(() => cleanup(tmpDir));
    seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', 'status: 7');
    const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).items.verification_gaps[0].status, '7');
  });

  test('#6172: control bytes in a raw archived status are shown in escaped form, not stripped', (t) => {
    const tmpDir = createTempProject('gsd-6172-sanitize-');
    t.after(() => cleanup(tmpDir));
    // JSON-style escapes inside a double-quoted scalar: ESC, a tab and DEL.
    seedVerification(ARCHIVE_ROOT(tmpDir), '12-alpha', 'status: "evil\\u001b[31m\\tred\\u007f"');
    const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
    assert.ok(r.success, r.error);
    const item = JSON.parse(r.output).items.verification_gaps[0];
    assert.equal(item.status, 'evil\\x1b[31m\\tred\\x7f', 'every control byte is visible as an escape');
  });

  test('#6172: an archived workstream milestone under milestones/ws-<slug>-<date>/phases is archived too', (t) => {
    const tmpDir = createTempProject('gsd-6172-wsarch-');
    t.after(() => cleanup(tmpDir));
    const wsArchive = path.join(tmpDir, '.planning', 'milestones', 'ws-v7-3-catalog-models-2026-08-23', 'phases');
    seedVerification(wsArchive, '185-catalog-admin', 'status: resolved');
    const r = runGsdTools(['query', 'audit-open', '--json'], tmpDir);
    assert.ok(r.success, `audit-open must not abort on a ws-* archive: ${r.error}`);
    const items = JSON.parse(r.output).items.verification_gaps;
    assert.equal(items.length, 1);
    assert.equal(items[0].file, '185-VERIFICATION.md');
    assert.ok(items[0].archived_milestone, 'the item carries its archived milestone label');
  });

  test('#6172 property: over arbitrary raw status strings, archived never throws; active throws VerificationStatusError iff the trimmed status is non-empty and outside the closed set', () => {
    // The oracle is the closed set itself, sourced from the owner, and the
    // rule "empty after trim is no status" — not a re-run of the scanner.
    const statusArb = fc.string({
      unit: fc.constantFrom(...'abcxyzABCXYZ_ \t"\'\\:#'.split(''), '\u0001', '\u001b', '\u007f'),
      maxLength: 12,
    });
    const scan = (root, status) => {
      const tmpDir = createTempProject('gsd-6172-prop-');
      try {
        // A JSON string is a valid double-quoted scalar: any byte round-trips.
        seedVerification(root(tmpDir), '12-alpha', `status: ${JSON.stringify(status)}`);
        return { items: auditMod.auditOpenArtifacts(tmpDir).items.verification_gaps };
      } catch (err) {
        if (!(err instanceof VerificationStatusError)) throw err;
        return { threw: true };
      } finally {
        cleanup(tmpDir);
      }
    };
    fc.assert(fc.property(statusArb, (status) => {
      const trimmed = status.trim();
      const outsideClosedSet = trimmed.length > 0 && !VERIFIER_STATUSES.has(trimmed);
      const archived = scan(ARCHIVE_ROOT, status);
      const active = scan(ACTIVE_ROOT, status);
      const archivedItems = archived.threw ? null : archived.items;
      const expectedItems = outsideClosedSet || trimmed === 'gaps_found' || trimmed === 'human_needed' ? 1 : 0;
      return archivedItems !== null
        && archivedItems.length === expectedItems
        && Boolean(active.threw) === outsideClosedSet;
    }), { numRuns: 60 });
  });
});
