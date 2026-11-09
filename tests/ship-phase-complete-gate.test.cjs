'use strict';

/** #5221: /gsd:ship ships a phase only when every ROADMAP record of it reads complete (roadmap_record); anything else blocks. */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const SKIP = skipUnless('bash', 'jq', 'node');
const SHIP = 'gsd-core/workflows/ship.md';
const analyze = (number, complete) => JSON.stringify({ phases: [{ number }], roadmap_record: { [number]: complete } });

describe('ship preflight: roadmap completeness gate (#5221)', { skip: SKIP }, () => {
  const lines = () => span(SHIP, 'ANALYZE=$(gsd_run query roadmap.analyze', '[ "$VERDICT" != incomplete ]');
  const run = (stdout, rc, phase = '3') => runBash(lines(), { stdout, rc }, { preamble: [`PHASE_NUMBER=${phase}`, 'cd "$(mktemp -d)"; mkdir .planning; : > .planning/ROADMAP.md'], probe: 'echo CONTINUED' });
  const blocked = (r, code) => {
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(code));
    assert.ok(!/CONTINUED/.test(r.stdout));
  };

  test('complete phase continues', () => {
    const r = run(analyze('3', true), 0);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CONTINUED/);
  });

  test('incomplete phase blocks with PHASE_NOT_COMPLETE', () => {
    const r = run(analyze('3', false), 0);
    blocked(r, 'PHASE_NOT_COMPLETE');
  });

  test('leading-zero PHASE_NUMBER matches an unpadded roadmap number', () => {
    blocked(run(analyze('3', false), 0, '03'), 'PHASE_NOT_COMPLETE');
  });

  test('multi-segment numbers normalize per segment (03.02 matches 3.2)', () => {
    blocked(run(analyze('3.2', false), 0, '03.02'), 'PHASE_NOT_COMPLETE');
  });

  test('property: PHASE_NUMBER matches a record key iff its segments agree after stripping leading zeros', () => {
    const segs = fc.array(fc.nat({ max: 12 }), { minLength: 1, maxLength: 3 });
    const pad = fc.array(fc.nat({ max: 2 }), { minLength: 3, maxLength: 3 });
    const arms = { PHASE_NOT_COMPLETE: 0, PHASE_NOT_RECORDED: 0 };
    // Half the draws reuse the key as the phase (zero-padded), so the matching arm is reached about as often as the other.
    fc.assert(fc.property(segs, segs, fc.boolean(), pad, (key, other, reuseKey, zeros) => {
      const phase = reuseKey ? key : other;
      const padded = phase.map((s, i) => '0'.repeat(zeros[i]) + s).join('.');
      const r = run(analyze(key.join('.'), false), 0, padded);
      const same = key.join('.') === phase.join('.');
      const code = same ? 'PHASE_NOT_COMPLETE' : 'PHASE_NOT_RECORDED';
      blocked(r, code);
      arms[code]++;
    }), { numRuns: 40, seed: 5221 });
    assert.ok(arms.PHASE_NOT_COMPLETE >= 10, `matching arm reached ${arms.PHASE_NOT_COMPLETE} times`);
    assert.ok(arms.PHASE_NOT_RECORDED >= 10, `non-matching arm reached ${arms.PHASE_NOT_RECORDED} times`);
  });

  test('a phase with no ROADMAP record (heading only, absent from roadmap_record) blocks PHASE_NOT_RECORDED', () => {
    blocked(run(JSON.stringify({ phases: [{ number: '3' }], roadmap_record: {} }), 0), 'PHASE_NOT_RECORDED');
  });

  test('analyze output without a roadmap_record field is a hard error, never a skip', () => {
    const r = run(JSON.stringify({ phases: [{ number: '3' }] }), 0);
    blocked(r, 'unparseable');
    assert.ok(!/PHASE_NOT_/.test(r.stderr));
  });

  test('roadmap_record null (the ROADMAP.md progress table does not parse) blocks ROADMAP_TABLE_UNREADABLE naming the table', () => {
    const r = run(JSON.stringify({ phases: [{ number: '3' }], roadmap_record: null }), 0);
    blocked(r, 'ROADMAP_TABLE_UNREADABLE');
    assert.match(r.stderr, /ROADMAP\.md progress table/);
    assert.ok(!/unparseable|PHASE_NOT_/.test(r.stderr));
  });

  test('missing ROADMAP.md (analyze reports not found, exit 0) skips the check', () => {
    const r = runBash(lines(), { stdout: JSON.stringify({ error: 'ROADMAP.md not found', phases: [] }), rc: 0 }, { preamble: ['PHASE_NUMBER=3', 'cd "$(mktemp -d)"'], probe: 'echo CONTINUED' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CONTINUED/);
  });

  test('workstream layout (no root .planning/ROADMAP.md) still runs the gate', () => {
    const r = runBash(lines(), { stdout: analyze('3', false), rc: 0 }, { preamble: ['PHASE_NUMBER=3', 'cd "$(mktemp -d)"; mkdir -p .planning/workstreams/alpha; : > .planning/workstreams/alpha/ROADMAP.md'], probe: 'echo CONTINUED' });
    blocked(r, 'PHASE_NOT_COMPLETE');
  });

  test('--ws reaches roadmap.analyze so the workstream roadmap is the one read', () => {
    const r = runBash(lines(), { stdout: analyze('3', true), rc: 0 }, { preamble: [
      'PHASE_NUMBER=3; GSD_WS="--ws alpha"', 'cd "$(mktemp -d)"; mkdir .planning; : > .planning/ROADMAP.md',
      'gsd_run() { [ "$*" = "query roadmap.analyze --ws=alpha" ] || { echo "unexpected args: $*" >&2; return 2; }; printf %s "$STUB_OUT"; }',
    ], probe: 'echo CONTINUED' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CONTINUED/);
  });

  test('unparseable analyze output (garbage or empty, exit 0) is a hard error, never a skip', () => {
    for (const out of ['not json', '']) {
      const r = run(out, 0);
      assert.equal(r.status, 1, `stdout=${JSON.stringify(out)}`);
      assert.ok(!/PHASE_NOT_/.test(r.stderr));
      assert.ok(!/CONTINUED/.test(r.stdout));
    }
  });

  test('analyze exit 69 is a hard error, never PHASE_NOT_COMPLETE or a skip', () => {
    const r = run(analyze('3', false), 69);
    assert.equal(r.status, 1);
    assert.ok(!/PHASE_NOT_/.test(r.stderr));
    assert.ok(!/CONTINUED/.test(r.stdout));
  });

  // End to end: the real `roadmap analyze` output feeds the ship span, so the join is tested whole.
  describe('fed by real roadmap analyze', () => {
    const TABLE = '## Progress\n\n| Phase | Plans Complete | Status | Completed |\n|---|---|---|---|\n';
    const verifiedPhase1 = (tmp) => {
      const dir = path.join(tmp, '.planning', 'phases', '01-a');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '---\nplan: 01\n---\n# Plan\n');
      fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '---\nplan: 01\n---\n# Summary\n');
      fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# V\n');
    };
    const ship = (roadmap, { before } = {}) => {
      const tmp = createTempProject();
      try {
        fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), roadmap);
        if (before) before(tmp);
        const a = runGsdTools('roadmap analyze', tmp);
        assert.ok(a.success, a.error);
        return { r: run(a.output, 0, '01'), roadmap: fs.readFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), 'utf8') };
      } finally { cleanup(tmp); }
    };
    const HEAD = '# Roadmap\n\n## Milestone: v1.0\n\n';

    test('ticked checklist entry ships; unticked blocks', () => {
      assert.match(ship(`${HEAD}- [x] **Phase 1: A**\n\n### Phase 1: A\n\n**Goal**: g\n`).r.stdout, /CONTINUED/);
      const unticked = ship(`${HEAD}- [ ] **Phase 1: A**\n\n### Phase 1: A\n\n**Goal**: g\n`).r;
      blocked(unticked, 'PHASE_NOT_COMPLETE');
      assert.ok(!/by hand/.test(unticked.stderr), 'numeric phases get no custom-id hint');
    });

    test('heading-only phase blocks PHASE_NOT_RECORDED', () => {
      blocked(ship(`${HEAD}### Phase 1: A\n\n**Goal**: g\n`).r, 'PHASE_NOT_RECORDED');
    });

    test('table-only phase: Planned blocks; update-plan-progress on a verified phase writes Complete and then ships', () => {
      const roadmap = `${HEAD}### Phase 1: A\n\n**Goal**: g\n\n${TABLE}| 1. A | 0/1 | Planned | - |\n`;
      blocked(ship(roadmap).r, 'PHASE_NOT_COMPLETE');
      const after = ship(roadmap, { before: (tmp) => {
        verifiedPhase1(tmp);
        const u = runGsdTools('roadmap update-plan-progress 1', tmp);
        assert.ok(u.success, u.error);
      } });
      assert.match(after.roadmap, /\| 1\. A \| 1\/1 \| Complete/);
      assert.equal(after.r.status, 0, after.r.stderr);
      assert.match(after.r.stdout, /CONTINUED/);
    });

    // A phase the tool creates gets a ROADMAP record, so the canonical add/insert -> verify -> ship flow ships.
    const lifecycle = (roadmap, create, onCreated = () => {}) => {
      const tmp = createTempProject();
      try {
        fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), roadmap);
        const c = runGsdTools(create, tmp);
        assert.ok(c.success, c.error);
        const out = JSON.parse(c.output);
        onCreated(fs.readFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), 'utf8'));
        const n = String(out.phase_number);
        const dir = path.join(tmp, out.directory);
        const id = path.basename(dir).match(/^[\d.]+/)[0];
        fs.writeFileSync(path.join(dir, `${id}-01-PLAN.md`), '---\nplan: 01\n---\n# Plan\n');
        fs.writeFileSync(path.join(dir, `${id}-01-SUMMARY.md`), '---\nplan: 01\n---\n# Summary\n');
        fs.writeFileSync(path.join(dir, `${id}-VERIFICATION.md`), '---\nstatus: passed\n---\n# V\n');
        for (const cmd of [`roadmap update-plan-progress ${n}`, `phase complete ${n}`]) {
          const r = runGsdTools(cmd, tmp);
          assert.ok(r.success, `${cmd}: ${r.error}`);
        }
        const a = runGsdTools('roadmap analyze', tmp);
        assert.ok(a.success, a.error);
        return { out, n, record: JSON.parse(a.output).roadmap_record, r: run(a.output, 0, n), roadmap: fs.readFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), 'utf8') };
      } finally { cleanup(tmp); }
    };
    const shipped = (l) => {
      assert.equal(l.record[l.n.split('.').map((s) => s.replace(/^0+(?=\d)/, '')).join('.')], true, JSON.stringify(l.record));
      assert.equal(l.r.status, 0, l.r.stderr);
      assert.match(l.r.stdout, /CONTINUED/);
    };
    const CHECKLIST = `${HEAD}## Phases\n\n- [x] **Phase 1: A** - first\n\n## Phase Details\n\n### Phase 1: A\n\n**Goal**: g\n`;

    test('phase add writes a checklist entry beside the existing one; add -> verify -> complete -> ship ships', () => {
      const l = lifecycle(CHECKLIST, ['phase', 'add', 'Second thing']);
      assert.equal(l.out.roadmap_entry, 'checklist');
      assert.match(l.roadmap, /- \[x\] \*\*Phase 1: A\*\* - first\n- \[x\] \*\*Phase 2: Second thing\*\*/);
      shipped(l);
    });

    test('phase add writes the checklist entry in the active milestone, never under a later planned one', (t) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));
      fs.writeFileSync(path.join(tmp, '.planning', 'STATE.md'), '---\nmilestone: v1.0\n---\n# State\n');
      fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Milestones\n\n### 🚧 v1.0 Active (In Progress)\n\n'
        + '- [x] **Phase 1: A**\n\n#### Phase 1: A\n**Goal**: g\n\n### 📋 v2.0 Planned\n\n- [ ] **Phase 3: C**\n\n#### Phase 3: C\n**Goal**: g\n');
      const c = runGsdTools(['phase', 'add', 'New'], tmp);
      assert.ok(c.success, c.error);
      const n = String(JSON.parse(c.output).phase_number);
      const roadmap = fs.readFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), 'utf8');
      const planned = roadmap.indexOf('### 📋 v2.0');
      const entry = roadmap.indexOf(`**Phase ${n}: New**`);
      assert.ok(entry !== -1 && entry < planned, roadmap);
      assert.equal(JSON.parse(runGsdTools('roadmap analyze', tmp).output).roadmap_record[n], false);
    });

    test('custom-id phase (phase_naming: custom): its checklist entry and table row are the record; ticked ships, unticked blocks', (t) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));
      fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ phase_naming: 'custom' }));
      fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), CHECKLIST);
      const c = runGsdTools(['phase', 'add', 'Auth', '--id', 'AUTH'], tmp);
      assert.ok(c.success, c.error);
      const roadmapPath = path.join(tmp, '.planning', 'ROADMAP.md');
      const analyze = () => runGsdTools('roadmap analyze', tmp).output;
      assert.equal(JSON.parse(analyze()).roadmap_record.AUTH, false);
      const unticked = run(analyze(), 0, 'AUTH');
      blocked(unticked, 'PHASE_NOT_COMPLETE');
      assert.match(unticked.stderr, /tick its ROADMAP\.md checklist entry by hand/, 'custom-id dead end is explained');
      fs.writeFileSync(roadmapPath, fs.readFileSync(roadmapPath, 'utf8').replace('- [ ] **Phase AUTH:', '- [x] **Phase AUTH:'));
      assert.equal(JSON.parse(analyze()).roadmap_record.AUTH, true);
      assert.match(run(analyze(), 0, 'AUTH').stdout, /CONTINUED/);
      fs.writeFileSync(roadmapPath, `${CHECKLIST.replace('- [x] **Phase 1: A** - first\n', '')}\n${TABLE}| AUTH. Auth | 1/1 | In Progress | - |\n`);
      assert.equal(JSON.parse(analyze()).roadmap_record.AUTH, false, 'custom-id table row is read');
    });

    test('phase complete on a CRLF roadmap ticks the checklist line without a stray CR before "(completed"', (t) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));
      fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), `${HEAD}- [ ] **Phase 1: A**\n\n### Phase 1: A\n\n**Goal**: g\n`.replace(/\n/g, '\r\n'));
      verifiedPhase1(tmp);
      const c = runGsdTools('phase complete 1', tmp);
      assert.ok(c.success, c.error);
      const out = fs.readFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), 'utf8');
      assert.ok(out.includes('- [x] **Phase 1: A** (completed '), out);
      assert.ok(!out.includes('\r ('), 'no stray CR before "(completed"');
    });

    const addTo = (roadmap, config, args) => {
      const tmp = createTempProject();
      try {
        if (config) fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify(config));
        fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), roadmap);
        const c = runGsdTools(args, tmp);
        assert.ok(c.success, c.error);
        return { out: JSON.parse(c.output), roadmap: fs.readFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), 'utf8') };
      } finally { cleanup(tmp); }
    };

    test('custom-only checklist: phase add --id writes its entry into that checklist', () => {
      const { out, roadmap } = addTo(`${HEAD}## Phases\n\n- [x] **Phase SETUP: Setup**\n\n## Phase Details\n\n### Phase SETUP: Setup\n\n**Goal**: g\n`,
        { phase_naming: 'custom' }, ['phase', 'add', 'Auth', '--id', 'AUTH']);
      assert.equal(out.roadmap_entry, 'checklist');
      assert.match(roadmap, /- \[x\] \*\*Phase SETUP: Setup\*\*\n- \[ \] \*\*Phase AUTH: Auth\*\*\n/);
    });

    test('bracket-tagged checklist: phase add writes its entry into that checklist', () => {
      const { out, roadmap } = addTo('# Roadmap\n\n## [GSD.02] v2.0\n\n- [x] **[GSD.02] 01: One**\n\n### [GSD.02] 01: One\n**Goal:** a\n',
        { phase_id_convention: 'bracket', project_code: 'GSD' }, ['phase', 'add', 'Two']);
      assert.equal(out.roadmap_entry, 'checklist');
      // A bracket writer records its checklist entry in the same bracket spelling as the heading it writes.
      assert.match(roadmap, /- \[x\] \*\*\[GSD\.02\] 01: One\*\*\n- \[ \] \*\*\[GSD\.02\] 02: Two\*\*\n/);
    });

    test('phase insert after a phase with no checklist entry lands before the first later entry, not at the end', () => {
      const heads = ['1', '2', '3', '5', '9'].map((n) => `### Phase ${n}: P${n}\n\n**Goal**: g\n`).join('\n');
      const list = ['1', '2', '5', '9'].map((n) => `- [ ] **Phase ${n}: P${n}**`).join('\n');
      const { out, roadmap } = addTo(`${HEAD}## Phases\n\n${list}\n\n## Phase Details\n\n${heads}`, null, ['phase', 'insert', '3', 'X']);
      assert.equal(out.roadmap_entry, 'checklist');
      assert.match(roadmap, /\*\*Phase 2: P2\*\*\n- \[ \] \*\*Phase 0?3\.1: X\*\*\n- \[ \] \*\*Phase 5: P5\*\*/);
    });

    test('phase insert into a non-bold bullet roadmap reports roadmap_entry none and analyze leaves the phase out', (t) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));
      fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n\n- [ ] Phase 1: Foundation\n- [ ] Phase 2: API\n');
      const c = runGsdTools(['phase', 'insert', '1', 'Fix'], tmp);
      assert.ok(c.success, c.error);
      assert.match(fs.readFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), 'utf8'), /- \[ \] Phase 0?1\.1: Fix/);
      assert.equal(JSON.parse(c.output).roadmap_entry, 'none');
      const rec = JSON.parse(runGsdTools(['roadmap', 'analyze'], tmp).output).roadmap_record;
      assert.ok(!Object.keys(rec ?? {}).some((k) => /^0?1\.1$/.test(k)));
    });

    for (const [len, recorded] of [[63, true], [64, true], [65, false]]) {
      test(`custom id of ${len} chars ${recorded ? 'is recorded and read back' : 'is past the 64-char cap: reported none, absent from roadmap_record'} (boundary)`, (t) => {
        const id = 'A' + 'b'.repeat(len - 1);
        const tmp = createTempProject();
        t.after(() => cleanup(tmp));
        fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ phase_naming: 'custom' }));
        fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), `${HEAD}## Phases\n\n- [x] **Phase SETUP: Setup**\n\n## Phase Details\n\n### Phase SETUP: Setup\n\n**Goal**: g\n`);
        const c = runGsdTools(['phase', 'add', 'Auth', '--id', id], tmp);
        assert.ok(c.success, c.error);
        assert.equal(JSON.parse(c.output).roadmap_entry, recorded ? 'checklist' : 'none');
        const rec = JSON.parse(runGsdTools(['roadmap', 'analyze'], tmp).output).roadmap_record;
        assert.equal(id in rec, recorded);
      });
    }

    test('custom id with a numeric-looking prefix (P1-setup) is recorded under its own key, not folded into P1', (t) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));
      fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ phase_naming: 'custom' }));
      fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), `${HEAD}## Phases\n\n- [x] **Phase SETUP: Setup**\n\n## Phase Details\n\n### Phase SETUP: Setup\n\n**Goal**: g\n`);
      const c = runGsdTools(['phase', 'add', 'Setup', '--id', 'P1-setup'], tmp);
      assert.ok(c.success, c.error);
      const rec = JSON.parse(runGsdTools(['roadmap', 'analyze'], tmp).output).roadmap_record;
      assert.equal(JSON.parse(c.output).roadmap_entry, 'checklist');
      assert.equal(rec['P1-setup'], false);
      assert.ok(!('P1' in rec), 'not folded into P1');
    });

    test('CRLF roadmap: update-plan-progress then phase complete leave no stray CR before "(completed"', (t) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));
      fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), `${HEAD}- [ ] **Phase 1: A**\n\n### Phase 1: A\n\n**Goal**: g\n`.replace(/\n/g, '\r\n'));
      verifiedPhase1(tmp);
      for (const cmd of ['roadmap update-plan-progress 1', 'phase complete 1']) {
        const r = runGsdTools(cmd, tmp);
        assert.ok(r.success, `${cmd}: ${r.error}`);
        const out = fs.readFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), 'utf8');
        assert.ok(!out.includes('\r ('), `${cmd}: stray CR before "(completed"`);
      }
    });

    // roadmap_record keys are foldPhaseId(token); ship.md's jq `def n` must fold PHASE_NUMBER the same way.
    test('foldPhaseId and ship.md def n agree: a record keyed by foldPhaseId(t) ships PHASE_NUMBER=t', () => {
      const { foldPhaseId } = require('../gsd-core/bin/lib/roadmap.cjs');
      for (const t of ['01', '3.02', '010.001', '0', '00.0', 'AUTH', 'A01']) {
        const r = run(JSON.stringify({ roadmap_record: { [foldPhaseId(t)]: true } }), 0, t);
        assert.match(r.stdout, /CONTINUED/, `${t} -> ${foldPhaseId(t)}: ${r.stderr}`);
      }
    });

    test('phase add on a CRLF roadmap keeps CRLF and still ships', () => {
      const l = lifecycle(CHECKLIST.replace(/\n/g, '\r\n'), ['phase', 'add', 'Second thing'], (added) => {
        assert.match(added, /- \[x\] \*\*Phase 1: A\*\* - first\r\n- \[ \] \*\*Phase 2: Second thing\*\*\r\n/);
        assert.ok(!/[^\r]\n/.test(added), 'no bare LF after phase add');
      });
      shipped(l);
    });

    test('phase add-batch records every new phase', (t) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));
      fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), CHECKLIST);
      const c = runGsdTools(['phase', 'add-batch', '--descriptions', JSON.stringify(['Two', 'Three'])], tmp);
      assert.ok(c.success, c.error);
      assert.deepEqual(JSON.parse(c.output).phases.map((p) => p.roadmap_entry), ['checklist', 'checklist']);
      const a = JSON.parse(runGsdTools('roadmap analyze', tmp).output);
      assert.deepEqual(a.roadmap_record, { 1: true, 2: false, 3: false });
    });

    test('phase insert (decimal) writes its checklist entry after the anchor phase and ships', () => {
      const roadmap = `${HEAD}## Phases\n\n- [x] **Phase 1: A**\n- [ ] **Phase 2: B**\n\n## Phase Details\n\n### Phase 1: A\n\n**Goal**: g\n\n### Phase 2: B\n\n**Goal**: g\n`;
      const l = lifecycle(roadmap, ['phase', 'insert', '1', 'Urgent fix']);
      assert.match(l.n, /^0?1\.1$/);
      assert.equal(l.out.roadmap_entry, 'checklist');
      assert.match(l.roadmap, /\*\*Phase 1: A\*\*\n- \[x\] \*\*Phase 0?1\.1: Urgent fix\*\*[^\n]{0,40}\n- \[ \] \*\*Phase 2: B\*\*/);
      shipped(l);
    });

    test('no checklist: phase add writes a progress-table row instead, and ships', () => {
      const roadmap = `${HEAD}### Phase 1: A\n\n**Goal**: g\n\n${TABLE}| 1. A | 1/1 | Complete | 2026-01-01 |\n`;
      const l = lifecycle(roadmap, ['phase', 'add', 'Second thing']);
      assert.equal(l.out.roadmap_entry, 'progress_table');
      assert.match(l.roadmap, /\| 2\. Second thing \| 1\/1 \| Complete/);
      shipped(l);
    });

    test('no checklist and no progress table: phase add still succeeds, says roadmap_entry none, and ship blocks PHASE_NOT_RECORDED', () => {
      const l = lifecycle(`${HEAD}### Phase 1: A\n\n**Goal**: g\n`, ['phase', 'add', 'Second thing']);
      assert.equal(l.out.roadmap_entry, 'none');
      blocked(l.r, 'PHASE_NOT_RECORDED');
    });
  });
});
