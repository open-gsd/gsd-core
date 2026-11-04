/**
 * #5726 — `phase add`, `phase add-batch` and `phase insert` must not widen the
 * milestone window to the whole unshipped roadmap when STATE.md names a
 * milestone that has no heading in ROADMAP.md.
 *
 * Behavioral CLI tests: each case builds a fixture project, runs the real
 * gsd-tools CLI, and asserts on exit status, stderr and the bytes left on disk.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const TWO_MILESTONES = [
  '# Roadmap',
  '',
  '## v2.0 Alpha',
  '',
  '### Phase 1: One',
  '**Goal:** a',
  '',
  '### Phase 2: Two',
  '**Goal:** b',
  '**Depends on:** Phase 1',
  '',
  '## v3.0 Beta',
  '',
  '### Phase 3: Three',
  '**Goal:** c',
  '',
].join('\n');

const FREE_FORM = [
  '# Roadmap',
  '',
  '### Phase 1: Alpha',
  '**Goal:** a',
  '',
  '### Phase 2: Beta',
  '**Goal:** b',
  '',
].join('\n');

describe('#5726 phase write verbs on an unresolved STATE milestone', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function setup({ roadmap, milestone }) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    const state = milestone === undefined
      ? '# State\n'
      : `---\nmilestone: ${milestone}\n---\n\n# State\n`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), state);
  }

  const roadmapBytes = () => fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'));
  const phaseDirs = () => {
    const dir = path.join(tmpDir, '.planning', 'phases');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  };

  const VERBS = [
    ['phase add', (cwd) => runGsdTools(['phase', 'add', 'New thing'], cwd)],
    ['phase add-batch', (cwd) => runGsdTools(['phase', 'add-batch', '--descriptions', '["New one","New two"]'], cwd)],
    ['phase insert', (cwd) => runGsdTools(['phase', 'insert', '3', 'Urgent fix'], cwd)],
  ];

  for (const stateMilestone of ['v9.9', 'v3.1']) {
    for (const [verb, run] of VERBS) {
      test(`${verb} refuses STATE milestone ${stateMilestone} with no heading, names it, writes nothing`, () => {
        setup({ roadmap: TWO_MILESTONES, milestone: stateMilestone });
        const beforeRoadmap = roadmapBytes();
        const beforeDirs = phaseDirs();

        const result = run(tmpDir);

        assert.equal(result.success, false, `${verb} must refuse: ${result.output}`);
        assert.notEqual(result.exitCode, 0);
        assert.ok(result.error.includes(stateMilestone), `error must name ${stateMilestone}: ${result.error}`);
        assert.ok(result.error.includes(verb), `error must name the verb ${verb}: ${result.error}`);
        assert.ok(roadmapBytes().equals(beforeRoadmap), 'ROADMAP.md must be byte-identical');
        assert.deepEqual(phaseDirs(), beforeDirs, 'no phase directory may be created');
      });
    }
  }

  test('phase add with STATE naming a real heading (v3.0) allocates 4 and depends on 3', () => {
    setup({ roadmap: TWO_MILESTONES, milestone: 'v3.0' });
    const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, 4);
    const roadmap = roadmapBytes().toString('utf-8');
    assert.match(roadmap, /### Phase 4: New thing[\s\S]*\*\*Depends on:\*\* Phase 3/);
    assert.deepEqual(phaseDirs(), ['04-new-thing']);
  });

  test('phase add-batch with STATE naming a real heading (v3.0) allocates 4 and 5', () => {
    setup({ roadmap: TWO_MILESTONES, milestone: 'v3.0' });
    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["New one","New two"]'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.deepEqual(JSON.parse(result.output).phases.map((p) => p.phase_number), [4, 5]);
  });

  test('phase insert with STATE naming a real heading (v3.0) inserts 3.1', () => {
    setup({ roadmap: TWO_MILESTONES, milestone: 'v3.0' });
    const result = runGsdTools(['phase', 'insert', '3', 'Urgent fix'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, '03.1');
  });

  test('STATE milestone v3 (prefix of the v3.0 heading) resolves to that heading: unchanged', () => {
    setup({ roadmap: TWO_MILESTONES, milestone: 'v3' });
    const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, 4);
  });

  for (const [label, milestone] of [
    ['no milestone field', undefined],
    ['an explicit null milestone', 'null'],
  ]) {
    test(`versioned roadmap with ${label}: phase add is unchanged`, () => {
      setup({ roadmap: TWO_MILESTONES, milestone });
      const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
      assert.equal(result.success, true, result.error);
      assert.equal(JSON.parse(result.output).phase_number, 4);
    });
  }

  test('free-form legacy roadmap with no milestone field: phase add is unchanged', () => {
    setup({ roadmap: FREE_FORM, milestone: undefined });
    const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, 3);
  });

  test('free-form legacy roadmap with STATE milestone v1.0 (no milestone headings anywhere): phase add is unchanged', () => {
    setup({ roadmap: FREE_FORM, milestone: 'v1.0' });
    const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, 3);
  });

  test('free-form legacy roadmap with STATE milestone v1.0: phase add-batch and insert are unchanged', () => {
    setup({ roadmap: FREE_FORM, milestone: 'v1.0' });
    const batch = runGsdTools(['phase', 'add-batch', '--descriptions', '["New one"]'], tmpDir);
    assert.equal(batch.success, true, batch.error);
    const insert = runGsdTools(['phase', 'insert', '2', 'Urgent fix'], tmpDir);
    assert.equal(insert.success, true, insert.error);
  });

  // A version token in a Phase heading, a fence or an HTML comment is not a
  // milestone heading, so it must not make a free-form roadmap "versioned".
  const PHASE_HEADING_VERSION = [
    '# Roadmap',
    '',
    '### Phase 1: Migrate to v2.0 API',
    '**Goal:** a',
    '',
    '### Phase 2: Two',
    '**Goal:** b',
    '',
  ].join('\n');

  const FENCED_AND_COMMENTED_VERSION = [
    '# Roadmap',
    '',
    '### Phase 1: One',
    '**Goal:** a',
    '',
    '```',
    '## v3.0 Example',
    '```',
    '',
    '<!--',
    '## v4.0 Hidden',
    '-->',
    '',
  ].join('\n');

  test('Phase heading naming a version, STATE milestone v1.0: phase add is unchanged', () => {
    setup({ roadmap: PHASE_HEADING_VERSION, milestone: 'v1.0' });
    const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, 3);
  });

  test('Phase heading naming a version, STATE milestone v1.0: phase add-batch and insert are unchanged', () => {
    setup({ roadmap: PHASE_HEADING_VERSION, milestone: 'v1.0' });
    const batch = runGsdTools(['phase', 'add-batch', '--descriptions', '["New one"]'], tmpDir);
    assert.equal(batch.success, true, batch.error);
    const insert = runGsdTools(['phase', 'insert', '2', 'Urgent fix'], tmpDir);
    assert.equal(insert.success, true, insert.error);
  });

  test('versioned headings only inside a fence and an HTML comment, STATE milestone v1.0: phase add is unchanged', () => {
    setup({ roadmap: FENCED_AND_COMMENTED_VERSION, milestone: 'v1.0' });
    const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, 2);
  });

  // STATE names a milestone the ROADMAP marks shipped: the window is the closed
  // milestone, so allocation would collide with its phases.
  const SHIPPED_IN_DETAILS = [
    '# Roadmap',
    '',
    '## v2.0 Current',
    '',
    '### Phase 4: Four',
    '**Goal:** d',
    '',
    '<details>',
    '<summary>✅ v1.0 Shipped (Phases 1-3)</summary>',
    '',
    '### Phase 1: One',
    '**Goal:** a',
    '',
    '### Phase 3: Three',
    '**Goal:** c',
    '',
    '</details>',
    '',
  ].join('\n');

  const SHIPPED_HEADING = [
    '# Roadmap',
    '',
    '## ✅ v1.0 Done (shipped)',
    '',
    '### Phase 1: One',
    '**Goal:** a',
    '',
    '## v2.0 Cur',
    '',
    '### Phase 2: Two',
    '**Goal:** b',
    '',
  ].join('\n');

  for (const [shape, roadmap] of [['a <details> block', SHIPPED_IN_DETAILS], ['a ✅ heading', SHIPPED_HEADING]]) {
    for (const [verb, run] of VERBS) {
      test(`${verb} refuses a STATE milestone v1.0 shipped as ${shape}, names it, writes nothing`, () => {
        setup({ roadmap, milestone: 'v1.0' });
        const beforeRoadmap = roadmapBytes();
        const beforeDirs = phaseDirs();

        const result = run(tmpDir);

        assert.equal(result.success, false, `${verb} must refuse: ${result.output}`);
        assert.ok(result.error.includes('v1.0'), `error must name v1.0: ${result.error}`);
        assert.ok(/already shipped/.test(result.error), `error must say the milestone is already shipped: ${result.error}`);
        assert.ok(result.error.includes(verb), `error must name the verb ${verb}: ${result.error}`);
        assert.ok(roadmapBytes().equals(beforeRoadmap), 'ROADMAP.md must be byte-identical');
        assert.deepEqual(phaseDirs(), beforeDirs, 'no phase directory may be created');
      });
    }
  }

  test('STATE milestone v2.0 (not shipped) beside a shipped v1.0 heading still allocates normally', () => {
    setup({ roadmap: SHIPPED_HEADING, milestone: 'v2.0' });
    const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, 3);
  });

  test('STATE milestone v2.0 (not shipped) beside a shipped <details> v1.0 block still allocates normally', () => {
    setup({ roadmap: SHIPPED_IN_DETAILS, milestone: 'v2.0' });
    const result = runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).phase_number, 5);
  });

  describe('the STATE milestone echoed in the refusal', () => {
    const refusalFor = (milestone) => {
      setup({ roadmap: TWO_MILESTONES, milestone });
      return runGsdTools(['phase', 'add', 'New thing'], tmpDir);
    };

    test('control characters are escaped, not written to the terminal', () => {
      const result = refusalFor('v9.9\u001b]0;pwned\u0007\u001b[31m\u009b');
      assert.equal(result.success, false);
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(result.error), `raw control bytes leaked: ${JSON.stringify(result.error)}`);
      assert.ok(result.error.includes('\\u001b'), `ESC must be shown escaped: ${result.error}`);
    });

    for (const [label, length] of [['limit-1', 79], ['limit', 80], ['limit+1', 81]]) {
      test(`a ${length}-char milestone (${label}) is ${length > 80 ? 'truncated with an ellipsis' : 'echoed whole'}`, () => {
        const milestone = `v${'9'.repeat(length - 1)}`;
        const result = refusalFor(milestone);
        assert.equal(result.success, false);
        if (length <= 80) {
          assert.ok(result.error.includes(JSON.stringify(milestone)), result.error);
        } else {
          assert.ok(!result.error.includes(milestone), 'the full over-limit value must not be echoed');
          assert.ok(result.error.includes(`${milestone.slice(0, 80)}…`), result.error);
        }
      });
    }
  });
});
