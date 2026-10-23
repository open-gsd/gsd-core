const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCustomPhaseProject: fixture, runCustomPhaseCommand: run, cleanup, runGsdTools, homeSandboxEnv } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');

for (const code of [null, 'CCM']) for (const title of ['2024 roadmap', '3 steps']) {
  test(`custom directory lookup: add then find digit-leading title ${title}, code ${code}`, () => {
    const cwd = fixture(code);
    try {
      if (code) fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase ${code}: Independent phase\n`);
      run(cwd, ['query', 'phase.add', title, '--id', 'SETUP']);
      const found = run(cwd, ['query', 'find-phase', 'SETUP']);
      assert.equal(found.found, true);
      assert.equal(run(cwd, ['query', 'find-phase', `SETUP-${title.split(' ')[0]}`]).found, false);
      assert.equal(found.directory, `.planning/phases/${code ? code + '-' : ''}SETUP-${title.replaceAll(' ', '-')}`);
    } finally { cleanup(cwd); }
  });
}
for (const id of ['PRODUCT-BOUNDARY', 'SETUP-2']) {
  test(`custom identity readers: planning inspect custom checkbox ${id}`, () => {
    const cwd = fixture();
    try {
      run(cwd, ['query', 'phase.add', 'Boundary', '--id', id]);
      fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n- [x] **Phase ${id}: Boundary**\n`);
      const result = run(cwd, ['query', 'planning.inspect']);
      const phase = result.phases.find(p => p.dir === `${id}-boundary`);
      assert.ok(phase, JSON.stringify(result));
      assert.equal(phase.roadmap_acceptance.checkbox, true);
    } finally { cleanup(cwd); }
  });
  test(`custom identity readers: workstream inventory custom key ${id}`, () => {
    const cwd = fixture();
    try {
      const { seedWorkstream } = require('./fixtures/index.cjs');
      const ws = seedWorkstream(cwd, {name: 'custom'});
      fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({phase_naming: 'custom'}));
      fs.writeFileSync(path.join(ws, 'STATE.md'), '---\nmilestone: v1.0\nstatus: planning\n---\n');
      fs.writeFileSync(path.join(ws, 'ROADMAP.md'), `# Roadmap\n## v1.0 Current\n### Phase ${id}: Boundary\n\n## Progress\n| Phase | Milestone | Plans Complete | Status | Completed |\n| --- | --- | --- | --- | --- |\n| ${id}. Boundary | v1.0 | 0/1 | Not started | - |\n`);
      fs.mkdirSync(path.join(ws, 'phases', `${id}-boundary`), {recursive: true});
      fs.writeFileSync(path.join(ws, 'phases', `${id}-boundary`, `${id}-01-PLAN.md`), `---\nphase: ${id}\nplan: 01\n---\n# Plan\n`);
      const extra = id === 'SETUP-2' ? '02-numeric' : `${id}-other`;
      fs.mkdirSync(path.join(ws, 'phases', extra));
      fs.writeFileSync(path.join(ws, 'phases', extra, '02-01-PLAN.md'), '---\nphase: 2\nplan: 01\n---\n# Plan\n');
      if (id === 'SETUP-2') fs.appendFileSync(path.join(ws, 'ROADMAP.md'), '| 2. Numeric | v1.0 | 0/1 | Not started | - |\n\n### Phase 2: Numeric\n');
      const inv = require('../gsd-core/bin/lib/workstream-inventory.cjs').inspectWorkstream(cwd, 'custom', {active: null});
      assert.ok(inv);
      assert.equal(inv.total_plans, id === 'SETUP-2' ? 2 : 1, JSON.stringify(inv));
    } finally { cleanup(cwd); }
  });
}
test('custom identity readers: SETUP-2 and numeric 2 have distinct owner keys', () => {
  const context = {phaseNaming: 'custom', projectCode: null, roadmap: '### Phase SETUP-2: Setup\n### Phase 2: Numeric\n', knownIds: []};
  assert.equal(phaseId.phaseKeyFromToken('SETUP-2', context), 'SETUP-2');
  assert.equal(phaseId.phaseKeyFromDir('SETUP-2-boundary', undefined, context), 'SETUP-2');
  assert.equal(phaseId.phaseKeyFromProse('SETUP-2. Setup', context), 'SETUP-2');
  assert.equal(phaseId.phaseKeyFromDir('02-numeric', undefined, context), '02');
  assert.notEqual(phaseId.phaseKeyFromToken('SETUP-2', context), phaseId.phaseKeyFromToken('2', context));
});
for (const id of ['../evil', 'bad/id', 'bad\\id', 'bad..id']) for (const verb of ['add', 'scaffold']) {
  test(`custom directory safety: ${verb} rejects unsafe id ${JSON.stringify(id)}`, () => {
    const cwd = fixture();
    try {
      const before = fs.readdirSync(path.join(cwd, '.planning')).sort();
      const args = verb === 'add' ? ['query', 'phase.add', 'x', '--id', id] : ['scaffold', 'phase-dir', '--phase', id, '--name', 'Foo'];
      const result = runGsdTools(['--json-errors', ...args], cwd, homeSandboxEnv(cwd));
      assert.equal(result.success, false, result.output);
      assert.equal(JSON.parse(result.error).reason, 'usage');
      assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning')).sort(), before);
      assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
    } finally { cleanup(cwd); }
  });
}
test('custom directory safety: writer owner rejects NUL before constructing a path', () => {
  assert.throws(() => phaseId.phaseDirectoryName('bad\0id', 'x'), phaseId.PhaseDirectoryNameError);
});
for (const verb of ['add', 'scaffold']) {
  test(`custom directory safety: ${verb} rejects NUL through its command entry point`, () => {
    const cwd = fixture();
    try {
      // An OS argv cannot contain NUL; invoke the same command function in a child.
      const lib = path.resolve(__dirname, '../gsd-core/bin/lib');
      const call = verb === 'add'
        ? `require(${JSON.stringify(path.join(lib, 'phase.cjs'))}).cmdPhaseAdd(${JSON.stringify(cwd)}, 'x', false, 'bad\\0id')`
        : `require(${JSON.stringify(path.join(lib, 'commands.cjs'))}).cmdScaffold(${JSON.stringify(cwd)}, 'phase-dir', {phase: 'bad\\0id', name: 'Foo'}, false)`;
      const script = `require(${JSON.stringify(path.join(lib, 'io.cjs'))}).setJsonErrorMode(true); const {ExitError} = require(${JSON.stringify(path.join(lib, 'cli-exit.cjs'))}); try { ${call} } catch (cause) { if (cause instanceof ExitError) process.exitCode = cause.code; else throw cause; }`;
      const result = require('./helpers/process-seam.cjs').runNode(['-e', script], {
        timeoutMs: PROBE_TIMEOUT_MS, env: {...process.env, ...homeSandboxEnv(cwd)},
      });
      assert.notEqual(result.exitCode, 0, result.stdout);
      assert.equal(JSON.parse(result.stderr).reason, 'usage');
      assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
    } finally { cleanup(cwd); }
  });
}
for (const id of ['PRODUCT-BOUNDARY', 'SETUP-2']) {
  test(`custom identity readers: state validates custom ${id} independently of numeric 2`, () => {
    const cwd = fixture();
    try {
      run(cwd, ['query', 'phase.add', 'Boundary', '--id', id]);
      const phases = path.join(cwd, '.planning/phases');
      fs.writeFileSync(path.join(phases, `${id}-boundary`, `${id}-01-PLAN.md`), `---\nphase: ${id}\nplan: 01\n---\n# Plan\n`);
      fs.mkdirSync(path.join(phases, '02-numeric'));
      for (const plan of ['01', '02']) fs.writeFileSync(path.join(phases, '02-numeric', `02-${plan}-PLAN.md`), `---\nphase: 2\nplan: ${plan}\n---\n# Plan\n`);
      fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), `---\ncurrent_phase: ${id}\nstatus: planning\ntotal_plans_in_phase: 1\n---\n# State\n\n## Current Position\n\nPhase: Milestone v0.5 complete\n`);
      const result = run(cwd, ['state', 'validate']);
      assert.equal(result.valid, true, JSON.stringify(result));
      assert.deepEqual(result.warnings, []);
    } finally { cleanup(cwd); }
  });
}
