const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
// Generated round trips each spawn add, find, and analyze commands.
const ROUND_TRIP_TIMEOUT_MS = 120000;
const { createCustomPhaseProject: fixture, runCustomPhaseCommand: run, addCustomPhase: add, seedCustomPhaseDirectory: existingCustomDirectory, cleanup, runGsdTools, homeSandboxEnv, toPosixPath } = require('./helpers.cjs');
const locator = require('../gsd-core/bin/lib/phase-locator.cjs');

function options(code, naming = 'custom') { return {phaseNaming: naming, projectCode: code}; }


test('markerless ownership: removing a unique shorter id preserves the longer declared owner', () => {
  const cwd = fixture('CCM');
  try {
    for (const dir of ['CCM-SETUP-s', 'CCM-SETUP-2-t']) fs.mkdirSync(path.join(cwd, '.planning/phases', dir));
    fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n### Phase SETUP: Short\n### Phase SETUP-2: Long\n');
    assert.equal(run(cwd, ['query', 'find-phase', 'SETUP']).directory, '.planning/phases/CCM-SETUP-s');
    assert.equal(run(cwd, ['phase', 'remove', 'SETUP', '--force']).directory_deleted, 'CCM-SETUP-s');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), ['CCM-SETUP-2-t']);
    assert.equal(run(cwd, ['query', 'find-phase', 'SETUP-2']).directory, '.planning/phases/CCM-SETUP-2-t');
    assert.equal(run(cwd, ['roadmap', 'get-phase', 'SETUP']).found, false);
    assert.equal(run(cwd, ['roadmap', 'get-phase', 'SETUP-2']).found, true);
  } finally { cleanup(cwd); }
});

for (const code of [null, 'CCM']) {
  for (const writer of ['add', 'scaffold']) {
    test(`phase directory collision: ${writer} cannot replace a different owner's marker, code ${code}`, () => {
      const cwd = fixture(code);
      try {
        const [firstId, firstTitle, nextId, nextTitle, basename] = code
          ? ['SETUP', '2 t', 'SETUP-2', 't', 'CCM-SETUP-2-t']
          : ['A', 'b x', 'A-b', 'x', 'A-b-x'];
        add(cwd, firstId, firstTitle, code);
        const marker = path.join(cwd, '.planning/phases', basename, '.phase-id');
        const before = fs.readFileSync(marker, 'utf8');
        const args = writer === 'add' ? ['phase', 'add', nextTitle, '--id', nextId]
          : ['scaffold', 'phase-dir', '--phase', nextId, '--name', nextTitle];
        const result = runGsdTools(['--json-errors', ...args], cwd, homeSandboxEnv(cwd));
        assert.equal(result.success, false, result.output);
        assert.equal(JSON.parse(result.error).reason, 'phase_id_collision');
        assert.equal(fs.readFileSync(marker, 'utf8'), before);
        assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), [basename]);
        assert.equal(run(cwd, ['query', 'find-phase', firstId]).directory, `.planning/phases/${basename}`);
        assert.equal(run(cwd, ['roadmap', 'get-phase', nextId]).found, false);
      } finally { cleanup(cwd); }
    });
  }
}
test('phase directory collision: add-batch refuses an occupied target before creating any entry', () => {
  const cwd = fixture(null);
  try {
    const occupied = path.join(cwd, '.planning/phases/SECOND-second');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, '.phase-id'), 'OTHER');
    const result = runGsdTools(['--json-errors', 'phase', 'add-batch', 'First', 'Second'], cwd, homeSandboxEnv(cwd));
    assert.equal(result.success, false, result.output);
    assert.equal(JSON.parse(result.error).reason, 'phase_id_collision');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), ['SECOND-second']);
    assert.equal(fs.readFileSync(path.join(occupied, '.phase-id'), 'utf8'), 'OTHER');
    assert.deepEqual(run(cwd, ['query', 'roadmap.analyze']).phases, []);
  } finally { cleanup(cwd); }
});
test('phase directory collision: shared batch preflight refuses distinct ids mapping to one target', () => {
  const cwd = fixture(null);
  try {
    // CLI batches derive IDs from titles; exercise the exported writer seam's
    // explicit entry shape used by every writer without patching global I/O.
    const lib = path.resolve(__dirname, '../gsd-core/bin/lib');
    const script = `const {setJsonErrorMode} = require(${JSON.stringify(path.join(lib, 'io.cjs'))}); setJsonErrorMode(true);
      const {ExitError} = require(${JSON.stringify(path.join(lib, 'cli-exit.cjs'))});
      const locator = require(${JSON.stringify(path.join(lib, 'phase-locator.cjs'))});
      try { locator.createPhaseDirectories(${JSON.stringify(cwd)}, [{id:'A',slug:'b-x'}, {id:'A-b',slug:'x'}], locator.phaseDirectoryOptions(${JSON.stringify(cwd)})); }
      catch (cause) { if (cause instanceof ExitError) process.exitCode = cause.code; else throw cause; }`;
    const result = require('./helpers/process-seam.cjs').runNode(['-e', script], {
      timeoutMs: PROBE_TIMEOUT_MS, env: {...process.env, ...homeSandboxEnv(cwd)},
    });
    assert.notEqual(result.exitCode, 0, result.stdout);
    assert.equal(JSON.parse(result.stderr).reason, 'phase_id_collision');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
  } finally { cleanup(cwd); }
});
test('phase directory collision: numeric scaffold refuses a markerless directory', () => {
  const cwd = fixture(null, 'sequential');
  try {
    fs.mkdirSync(path.join(cwd, '.planning/phases/07-existing'));
    const result = runGsdTools(['--json-errors', 'scaffold', 'phase-dir', '--phase', '7', '--name', 'Existing'], cwd, homeSandboxEnv(cwd));
    assert.equal(result.success, false, result.output);
    assert.equal(JSON.parse(result.error).reason, 'phase_id_collision');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases/07-existing')), []);
  } finally { cleanup(cwd); }
});
test('phase directory collision: insert refuses an occupied file without changing the roadmap', () => {
  const cwd = fixture(null);
  try {
    add(cwd, '3', 'Parent');
    const occupied = path.join(cwd, '.planning/phases/03.1-extra');
    fs.writeFileSync(occupied, 'keep');
    const before = run(cwd, ['query', 'roadmap.analyze']).phases;
    const result = runGsdTools(['--json-errors', 'phase', 'insert', '3', 'Extra'], cwd, homeSandboxEnv(cwd));
    assert.equal(result.success, false, result.output);
    assert.equal(JSON.parse(result.error).reason, 'phase_id_collision');
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'keep');
    assert.deepEqual(run(cwd, ['query', 'roadmap.analyze']).phases, before);
  } finally { cleanup(cwd); }
});

for (const reverse of [false, true]) {
  for (const command of ['find-phase', 'init.plan-phase', 'init.execute-phase', 'init.phase-op', 'remove']) {
    test(`custom identity precedence: ${command} prefers a recorded id over a basename, reverse ${reverse}`, () => {
      const cwd = fixture(null);
      try {
        const phases = [['API', 'v2'], ['API-v2', 'Gateway']];
        for (const [id, title] of reverse ? phases.toReversed() : phases) add(cwd, id, title);
        if (command === 'remove') {
          const result = run(cwd, ['phase', 'remove', 'API-v2', '--force']);
          assert.equal(result.directory_deleted, 'API-v2-gateway');
          assert.equal(run(cwd, ['roadmap', 'get-phase', 'API-v2']).found, false);
          assert.equal(run(cwd, ['roadmap', 'get-phase', 'API']).found, true);
          assert.equal(fs.readFileSync(path.join(cwd, '.planning/phases/API-v2/.phase-id'), 'utf8').trim(), 'API');
        } else {
          const result = run(cwd, ['query', command, 'API-v2']);
          const expected = '.planning/phases/API-v2-gateway';
          if (command === 'find-phase') assert.equal(result.directory, expected);
          else assert.equal(result.phase_dir, toPosixPath(path.join(cwd, expected)));
          assert.equal(result.phase_number, 'API-v2');
        }
        assert.equal(run(cwd, ['query', 'find-phase', 'API']).directory, '.planning/phases/API-v2');
      } finally { cleanup(cwd); }
    });
  }
}

for (const [first, second] of [['1', '01'], ['Foo', 'FOO'], ['7.1', '07.1']]) {
  for (const owner of ['recorded', 'roadmap']) {
    test(`custom write identity: refuses equivalent ${second} after ${owner} ${first}`, () => {
      const cwd = fixture('CCM');
      try {
        if (owner === 'recorded') add(cwd, first, 'Existing', 'CCM');
        else fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase ${first}: Existing\n`);
        const before = fs.readdirSync(path.join(cwd, '.planning/phases'));
        const result = runGsdTools(['--json-errors', 'phase', 'add', 'Other', '--id', second], cwd, homeSandboxEnv(cwd));
        assert.equal(result.success, false, result.output);
        assert.equal(JSON.parse(result.error).reason, 'phase_id_collision');
        assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), before);
      } finally { cleanup(cwd); }
    });
  }
}
test('custom write identity: exact recorded numeric ids win over padding aliases', () => {
  const cwd = fixture('CCM');
  try {
    const one = existingCustomDirectory(cwd, '1', 'One', 'CCM');
    const padded = existingCustomDirectory(cwd, '01', 'Padded', 'CCM');
    for (const [id, dir] of [['1', one], ['01', padded]]) assert.equal(run(cwd, ['query', 'find-phase', id]).directory, dir);
    assert.equal(run(cwd, ['phase', 'remove', '01', '--force']).directory_deleted, path.basename(padded));
    assert.equal(run(cwd, ['query', 'find-phase', '1']).directory, one);
    assert.ok(fs.existsSync(path.join(cwd, one)));
    const mixed = existingCustomDirectory(cwd, 'Foo', 'Mixed', 'CCM');
    const upper = existingCustomDirectory(cwd, 'FOO', 'Upper', 'CCM');
    assert.equal(run(cwd, ['query', 'find-phase', 'Foo']).directory, mixed);
    assert.equal(run(cwd, ['query', 'find-phase', 'FOO']).directory, upper);
    assert.equal(run(cwd, ['query', 'find-phase', 'foo']).found, false);
  } finally { cleanup(cwd); }
});
test('custom write identity: a batch refuses duplicate ids before writing', () => {
  const cwd = fixture(null);
  try {
    const result = runGsdTools(['--json-errors', 'phase', 'add-batch', 'Same', 'same'], cwd, homeSandboxEnv(cwd));
    assert.equal(result.success, false, result.output);
    assert.equal(JSON.parse(result.error).reason, 'phase_id_collision');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
    assert.deepEqual(run(cwd, ['query', 'roadmap.analyze']).phases, []);
  } finally { cleanup(cwd); }
});
test('custom write identity: rejects an id already prefixed by the project code', () => {
  const cwd = fixture('CCM');
  try {
    const result = runGsdTools(['--json-errors', 'phase', 'add', 'Other', '--id', 'ccm-FOO'], cwd, homeSandboxEnv(cwd));
    assert.equal(result.success, false, result.output);
    assert.equal(JSON.parse(result.error).reason, 'usage');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
  } finally { cleanup(cwd); }
});
for (const ids of [['SETUP', 'SETUP-2'], ['A-B', 'A'], ['3', '3-2']]) {
  test(`custom write identity: marked prefix pair ${ids.join(' / ')} resolves independently`, () => {
    const cwd = fixture('CCM');
    try {
      const dirs = ids.map(id => add(cwd, id, 'Boundary', 'CCM'));
      for (let i = 0; i < ids.length; i++) assert.equal(run(cwd, ['query', 'find-phase', ids[i]]).directory, dirs[i]);
      assert.equal(run(cwd, ['phase', 'remove', ids[0], '--force']).directory_deleted, path.basename(dirs[0]));
      assert.equal(run(cwd, ['query', 'find-phase', ids[1]]).directory, dirs[1]);
    } finally { cleanup(cwd); }
  });
}
test('custom write identity: a roadmap-only prefix does not block a marked new id', () => {
  const cwd = fixture(null);
  try {
    fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n### Phase SETUP: Existing\n');
    const dir = add(cwd, 'SETUP-2');
    assert.equal(run(cwd, ['query', 'find-phase', 'SETUP-2']).directory, dir);
  } finally { cleanup(cwd); }
});
test('custom write identity: an unambiguous markerless owner can be removed', () => {
  const cwd = fixture(null);
  try {
    fs.mkdirSync(path.join(cwd, '.planning/phases/AUTH-legacy'));
    fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n### Phase AUTH: Legacy\n');
    assert.equal(run(cwd, ['query', 'find-phase', 'AUTH']).directory, '.planning/phases/AUTH-legacy');
    assert.equal(run(cwd, ['phase', 'remove', 'AUTH', '--force']).directory_deleted, 'AUTH-legacy');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
  } finally { cleanup(cwd); }
});
test('custom refusal codes: ambiguous markerless owners report candidates and repair path', () => {
  const cwd = fixture(null);
  try {
    fs.mkdirSync(path.join(cwd, '.planning/phases/A-B-legacy'));
    fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n### Phase A: One\n### Phase A-B: Two\n');
    const result = runGsdTools(['--json-errors', 'phase', 'remove', 'A-B', '--force'], cwd, homeSandboxEnv(cwd));
    assert.equal(result.success, false);
    const refusal = JSON.parse(result.error);
    assert.equal(refusal.reason, 'ambiguous_phase_owner');
    assert.deepEqual(refusal.candidates.sort(), ['A', 'A-B']);
    assert.equal(refusal.marker_path, 'A-B-legacy/.phase-id');
  } finally { cleanup(cwd); }
});
test('custom refusal codes: non-custom naming has a distinct reason', () => {
  const cwd = fixture(null, 'sequential');
  try {
    const result = runGsdTools(['--json-errors', 'phase', 'add', 'Other', '--id', 'AUTH'], cwd, homeSandboxEnv(cwd));
    assert.equal(result.success, false);
    assert.equal(JSON.parse(result.error).reason, 'phase_naming_not_custom');
  } finally { cleanup(cwd); }
});
for (const command of ['find-phase', 'init.plan-phase', 'init.execute-phase', 'init.phase-op']) {
  test(`custom directory handles: ${command} accepts a recorded full basename`, () => {
    const cwd = fixture('CCM');
    try {
      const dir = add(cwd, 'PRODUCT-BOUNDARY', 'Boundary', 'CCM');
      const result = run(cwd, ['query', command, path.basename(dir)]);
      if (command === 'find-phase') assert.equal(result.directory, dir);
      else assert.equal(result.phase_dir, path.join(cwd, dir).split(path.sep).join('/'));
      assert.equal(result.phase_number, 'PRODUCT-BOUNDARY');
    } finally { cleanup(cwd); }
  });
}
test('custom directory handles: remove accepts a full basename and removes its heading', () => {
  const cwd = fixture('CCM');
  try {
    const dir = add(cwd, 'PRODUCT-BOUNDARY', 'Boundary', 'CCM');
    assert.equal(run(cwd, ['phase', 'remove', path.basename(dir), '--force']).directory_deleted, path.basename(dir));
    assert.equal(run(cwd, ['roadmap', 'get-phase', 'PRODUCT-BOUNDARY']).found, false);
  } finally { cleanup(cwd); }
});
test('numeric insertion family: inserted decimals follow their unrecorded parent renumbering', () => {
  const cwd = fixture(null);
  try {
    for (const [id, name] of [['01', 'one'], ['02', 'two'], ['03', 'three']]) {
      fs.mkdirSync(path.join(cwd, '.planning/phases', `${id}-${name}`));
      fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase ${Number(id)}: ${name}\n`);
    }
    run(cwd, ['phase', 'insert', '2', 'Extra']);
    run(cwd, ['phase', 'remove', '1', '--force']);
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')).sort(), ['01-two', '01.1-extra', '02-three'].sort());
    assert.equal(run(cwd, ['query', 'find-phase', '1.1']).directory, '.planning/phases/01.1-extra');
  } finally { cleanup(cwd); }
});
for (const command of ['init.progress', 'init.manager', 'progress']) {
  test(`custom reader order: ${command} reports ids in roadmap order`, () => {
    const cwd = fixture('CCM');
    try {
      for (const id of ['ZETA', 'ALPHA', 'MIDDLE']) add(cwd, id, 'Boundary', 'CCM');
      fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '---\ncurrent_phase: ZETA\nstatus: planning\n---\n# State\n');
      const result = run(cwd, ['query', command]);
      assert.deepEqual(result.phases.map(phase => phase.number), ['ZETA', 'ALPHA', 'MIDDLE']);
      assert.ok(result.phases.every(phase => typeof phase.name === 'string' && phase.name.length > 0));
    } finally { cleanup(cwd); }
  });
}
test('custom reader order: phases list uses roadmap order', () => {
  const cwd = fixture('CCM');
  try {
    const dirs = ['ZETA', 'ALPHA', 'MIDDLE'].map(id => path.basename(add(cwd, id, 'Boundary', 'CCM')));
    assert.deepEqual(run(cwd, ['phases', 'list']).directories, dirs);
  } finally { cleanup(cwd); }
});
test('custom naming value: uppercase CUSTOM writes and resolves custom ids', () => {
  const cwd = fixture('CCM', 'CUSTOM');
  try {
    const dir = add(cwd, 'AUTH', 'Boundary', 'CCM');
    assert.equal(run(cwd, ['query', 'find-phase', 'AUTH']).directory, dir);
  } finally { cleanup(cwd); }
});
test('custom naming value: corrupt project config reports a parse failure', () => {
  const cwd = fixture(null);
  try {
    fs.mkdirSync(path.join(cwd, '.gsd'));
    fs.writeFileSync(path.join(cwd, '.gsd/defaults.json'), JSON.stringify({phase_naming: 'custom'}));
    fs.writeFileSync(path.join(cwd, '.planning/config.json'), '{ invalid');
    const result = runGsdTools(['--json-errors', 'phase', 'add', 'Other', '--id', 'AUTH'], cwd, {...homeSandboxEnv(cwd), GSD_HOME: cwd});
    assert.equal(result.success, false);
    assert.equal(JSON.parse(result.error).reason, 'config_parse_failed');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
  } finally { cleanup(cwd); }
});

for (const naming of ['custom', 'sequential']) {
  test(`batch directory safety: ${naming} rejects a project code that escapes phases`, () => {
    const cwd = fixture('../x', naming);
    try {
      const planning = path.join(cwd, '.planning');
      const beforeEntries = fs.readdirSync(planning).sort();
      const roadmapPath = path.join(planning, 'ROADMAP.md');
      const beforeRoadmap = fs.readFileSync(roadmapPath, 'utf8');
      const result = runGsdTools(['--json-errors', 'phase', 'add-batch', 'Alpha', 'Beta'], cwd, homeSandboxEnv(cwd));
      assert.equal(result.success, false, result.output);
      assert.equal(JSON.parse(result.error.split('\n').at(-1)).reason, 'usage');
      assert.deepEqual(fs.readdirSync(path.join(planning, 'phases')), []);
      assert.deepEqual(fs.readdirSync(planning).sort(), beforeEntries, 'no phase directory may be written beside phases/');
      assert.equal(fs.readFileSync(roadmapPath, 'utf8'), beforeRoadmap);
    } finally { cleanup(cwd); }
  });
  for (const code of [null, 'LOCAL']) {
    test(`batch directory safety: ${naming} preserves normal batches with code ${code}`, () => {
      const cwd = fixture(code, naming);
      try {
        const result = run(cwd, ['phase', 'add-batch', 'Alpha', 'Beta']);
        const names = naming === 'custom' ? ['ALPHA-alpha', 'BETA-beta'] : ['01-alpha', '02-beta'];
        const expected = names.map(name => `.planning/phases/${code ? `${code}-` : ''}${name}`);
        assert.equal(result.count, 2);
        assert.deepEqual(result.phases.map(phase => phase.directory), expected);
        assert.deepEqual(result.phases.map(phase => phase.phase_number), naming === 'custom' ? ['ALPHA', 'BETA'] : [1, 2]);
        for (const dir of expected) assert.ok(fs.statSync(path.join(cwd, dir)).isDirectory());
      } finally { cleanup(cwd); }
    });
  }
}

for (const code of [null, 'CCM']) {
  test(`custom readers: roadmap analyze sees disk with code ${code} (#5509)`, () => {
    const cwd = fixture(code);
    try {
      add(cwd, 'PRODUCT-BOUNDARY', 'Boundary', code);
      const result = run(cwd, ['query', 'roadmap.analyze']);
      const row = result.phases.find(p => p.number === 'PRODUCT-BOUNDARY' || p.id === 'PRODUCT-BOUNDARY');
      assert.ok(row, JSON.stringify(result));
      assert.notEqual(row.disk_status, 'no_directory');
    } finally { cleanup(cwd); }
  });
  test(`custom readers: milestone complete checks directory with code ${code} (#5509)`, () => {
    const cwd = fixture(code);
    try {
      add(cwd, 'PRODUCT-BOUNDARY', 'Boundary', code);
      const roadmap = path.join(cwd, '.planning/ROADMAP.md');
      fs.appendFileSync(roadmap, '\n### Phase MISSING: Missing\n');
      const missing = runGsdTools(['milestone', 'complete', 'v1.0', '--dry-run'], cwd, homeSandboxEnv(cwd));
      assert.equal(missing.success, false, 'a declared custom phase without a directory must block completion');
      const analyzed = run(cwd, ['query', 'roadmap.analyze']).phases;
      assert.equal(analyzed.find(phase => phase.number === 'MISSING').disk_status, 'no_directory');
      assert.notEqual(analyzed.find(phase => phase.number === 'PRODUCT-BOUNDARY').disk_status, 'no_directory');
      fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replace('### Phase MISSING: Missing', ''));
      assert.equal(run(cwd, ['milestone', 'complete', 'v1.0', '--dry-run']).dry_run, true);
    } finally { cleanup(cwd); }
  });
  test(`custom readers: suffix is never a guessed project code with code ${code} (#5509)`, () => {
    const cwd = fixture(code);
    try {
      add(cwd, 'PRODUCT-BOUNDARY', 'Boundary', code);
      assert.equal(run(cwd, ['query', 'find-phase', 'BOUNDARY']).found, false);
      assert.equal(locator.findPhaseInternal(cwd, 'BOUNDARY', undefined, options(code)), null);
      // Legacy callers receive the configured policy without an override.
      assert.equal(locator.findPhaseInternal(cwd, 'BOUNDARY'), null);
    } finally { cleanup(cwd); }
  });
  for (const id of ['PRODUCT-BOUNDARY', 'SETUP-2']) for (const verb of ['roadmap.annotate-dependencies', 'verify-command-paths', 'verify-failure-directions', 'context-drift']) {
    test(`custom readers: add then ${verb} ${id} with code ${code} (#5509)`, () => {
      const cwd = fixture(code);
      try {
        const dir = add(cwd, id, 'Boundary', code);
        fs.writeFileSync(path.join(cwd, dir, `${id}-01-PLAN.md`), `---\nphase: ${id}\nplan: 01\nwave: 1\n---\n# Plan\n`);
        const roadmap = path.join(cwd, '.planning/ROADMAP.md');
        fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replace('- [ ] TBD', `- [ ] ${id}-01: Build boundary\n- [ ] ${id}-02: Finish boundary`));
        fs.writeFileSync(path.join(cwd, dir, `${id}-02-PLAN.md`), `---\nphase: ${id}\nplan: 02\nwave: 2\n---\n# Plan\n`);
        const args = verb.startsWith('roadmap.') ? ['query', verb, id]
          : verb === 'context-drift' ? ['verify', verb, id] : ['check', verb, id];
        const result = run(cwd, args);
        if (verb.startsWith('roadmap.')) assert.equal(result.updated, true, JSON.stringify(result));
        else if (verb === 'context-drift') assert.equal(result.reason, 'no-context-md');
        else assert.notEqual(result.status, 'unresolvable', JSON.stringify(result));
      } finally { cleanup(cwd); }
    });
  }
  test(`custom controls: scaffold equals add with code ${code} (#5509)`, () => {
    const cwd = fixture(code);
    try {
      const dir = add(cwd, 'mixed-2', 'Boundary', code);
      cleanup(path.join(cwd, dir));
      fs.writeFileSync(path.join(cwd, '.planning/ROADMAP.md'), '# Roadmap\n');
      run(cwd, ['scaffold', 'phase-dir', '--phase', 'mixed-2', '--name', 'Boundary']);
      assert.ok(fs.statSync(path.join(cwd, dir)).isDirectory());
    } finally { cleanup(cwd); }
  });
}
test('custom controls: numeric projects keep custom matching disabled (#5509)', () => {
  const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
  const context = {phaseNaming: 'custom', projectCode: 'CCM', roadmap: ''};
  for (const id of ['CCM-03', 'CCM-03A', 'CCM-03.2']) {
    assert.equal(phaseId.phaseMarkdownRegexSource(id, context), phaseId.phaseMarkdownRegexSource(id));
  }
  const cwd = fixture(null, 'sequential');
  try {
    fs.mkdirSync(path.join(cwd, '.planning/phases/PRODUCT-BOUNDARY-boundary'));
    assert.equal(run(cwd, ['query', 'find-phase', 'BOUNDARY']).found, false);
    assert.equal(locator.findPhaseInternal(cwd, 'BOUNDARY'), null);
    fs.mkdirSync(path.join(cwd, '.planning/phases/03-numeric'));
    assert.equal(run(cwd, ['query', 'find-phase', '3']).directory, '.planning/phases/03-numeric');
    fs.writeFileSync(path.join(cwd, '.planning/config.json'), JSON.stringify({phase_naming: 'custom', project_code: 'CCM'}));
    fs.renameSync(path.join(cwd, '.planning/phases/03-numeric'), path.join(cwd, '.planning/phases/CCM-03-numeric'));
    fs.writeFileSync(path.join(cwd, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 3: Numeric\n');
    const bare = run(cwd, ['query', 'init.plan-phase', '3']);
    const prefixed = run(cwd, ['query', 'init.plan-phase', 'CCM-03']);
    assert.equal(prefixed.phase_dir, bare.phase_dir);
    assert.equal(prefixed.expected_phase_dir, bare.expected_phase_dir);
    assert.equal(bare.expected_phase_dir, null);
  } finally { cleanup(cwd); }
});
for (const length of [59, 60, 61]) {
  test(`custom controls: expected directory slug boundary ${length} (#5509)`, () => {
    const cwd = fixture('CCM');
    try {
      const dir = add(cwd, 'BOUNDARY', 'a'.repeat(length), 'CCM');
      const init = run(cwd, ['query', 'init.plan-phase', 'BOUNDARY']);
      assert.equal(init.expected_phase_dir, toPosixPath(path.join(cwd, dir)));
      assert.equal(init.phase_dir, init.expected_phase_dir);
    } finally { cleanup(cwd); }
  });
}
test('custom marked prefixes: fast-check resolves mixed-case and digit-leading pairs', {timeout: ROUND_TRIP_TIMEOUT_MS}, () => {
  const segment = fc.tuple(
    fc.constantFrom('A', 'b', 'c', '2A', '7b'),
    fc.array(fc.constantFrom('A', 'b', 'c', '2'), {maxLength: 2}),
  ).map(([head, tail]) => head + tail.join(''));
  fc.assert(fc.property(segment, fc.constantFrom('2', 'b', 'Ab'), fc.boolean(), fc.tuple(fc.constantFrom('2024', '3', 'Boundary', 'a2'), fc.constantFrom('roadmap', 'steps', 'Ab')).map(words => words.join(' ')), (id, suffix, prefixed, title) => {
    const code = prefixed ? 'CCM' : null;
    const cwd = fixture(code);
    try {
      const longer = `${id}-${suffix}`;
      const shortDir = add(cwd, id, title, code);
      const longDir = add(cwd, longer, title, code);
      assert.equal(run(cwd, ['query', 'find-phase', id]).directory, shortDir);
      assert.equal(run(cwd, ['query', 'find-phase', longer]).directory, longDir);
    } finally { cleanup(cwd); }
  }), {numRuns: 30, seed: 5186, examples: [['2A', '2', false, '2024 roadmap'], ['7b', 'Ab', true, '3 steps'], ['A', '2', false, '2024 roadmap']]});
});

test('custom readers: canonical matcher owns the configured inverse (#5509)', () => {
  const { matchPhaseDirs } = require('../gsd-core/bin/lib/phase-id.cjs');
  const context = {phaseNaming: 'custom', projectCode: 'CCM', roadmap: '### Phase SETUP: Setup\n### Phase SETUP-2: Extra\n'};
  const dirs = ['CCM-SETUP-setup', 'CCM-SETUP-2-extra'];
  assert.deepEqual(matchPhaseDirs(dirs, 'SETUP', undefined, context).matches, [dirs[0]]);
  assert.deepEqual(matchPhaseDirs(dirs, 'SETUP-2', undefined, context).matches, [dirs[1]]);
});

test('custom readers: smart-entry sees the current failed custom phase (#5509)', () => {
  const cwd = fixture('CCM');
  try {
    const dir = add(cwd, 'PRODUCT-BOUNDARY', 'Boundary', 'CCM');
    fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '---\ncurrent_phase: PRODUCT-BOUNDARY\nstatus: executing\n---\n# State\n');
    fs.writeFileSync(path.join(cwd, dir, 'PRODUCT-BOUNDARY-VERIFICATION.md'), 'STATUS: failed\n');
    const result = require('../gsd-core/bin/lib/smart-entry.cjs').classifyProject(cwd);
    assert.equal(result.signals.verify_failed, true);
  } finally { cleanup(cwd); }
});

test('custom readers: health rules claim directories and detect missing custom phases (#5509)', () => {
  const cwd = fixture('CCM');
  try {
    add(cwd, 'PRODUCT-BOUNDARY', 'Boundary', 'CCM');
    fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n### Phase MISSING: Missing\n');
    fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '---\nstatus: milestone complete\n---\n# State\n');
    const configPath = path.join(cwd, '.planning/config.json');
    const beforeConfig = JSON.stringify({phase_naming: 'custom', project_code: 'CCM', branching_strategy: 'bogus-strategy'});
    fs.writeFileSync(configPath, beforeConfig);
    const snapshot = require('../gsd-core/bin/lib/planning-snapshot.cjs').buildPlanningSnapshot(cwd);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
    const diskRules = require('../gsd-core/bin/lib/health-diagnostic-rules/roadmap-disk-consistency.cjs').RULES;
    assert.deepEqual(diskRules.find(r => r.code === 'W007').check(snapshot), []);
    const stateRules = require('../gsd-core/bin/lib/health-diagnostic-rules/state-consistency.cjs').RULES;
    const warnings = stateRules.find(r => r.code === 'W026').check(snapshot);
    assert.equal(warnings.length, 1);
    fs.writeFileSync(path.join(cwd, '.planning/ROADMAP.md'), '# Roadmap\n### Phase PRODUCT-BOUNDARY: Boundary\n');
    const resolved = require('../gsd-core/bin/lib/planning-snapshot.cjs').buildPlanningSnapshot(cwd);
    assert.deepEqual(stateRules.find(r => r.code === 'W026').check(resolved), []);
  } finally { cleanup(cwd); }
});

for (const id of ['2FA', '7B', '12AB', '2fa', '7b', '12ab']) for (const code of [null, 'CCM']) {
  test(`custom readers: digit-leading ID ${id} round trips with code ${code} (#5186)`, () => {
    const cwd = fixture(code);
    try {
      const dir = add(cwd, id, `T ${id}`, code);
      assert.equal(run(cwd, ['query', 'find-phase', id]).directory, dir);
      assert.equal(locator.findPhaseInternal(cwd, id).directory, dir);
    } finally { cleanup(cwd); }
  });
}

for (const value of ['Phase 3', '3', '3 of 5 (Foo)']) {
  test(`smart-entry: numeric state ${value} detects failed verification under custom naming (#5186)`, () => {
    const cwd = fixture(null);
    try {
      const dir = path.join(cwd, '.planning/phases/03-foo');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), 'STATUS: failed\n');
      fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), `---\ncurrent_phase: "${value}"\nstatus: executing\n---\n# State\n`);
      assert.equal(require('../gsd-core/bin/lib/smart-entry.cjs').classifyProject(cwd).signals.verify_failed, true);
    } finally { cleanup(cwd); }
  });
}
test('smart-entry: non-phase directories cannot hide the latest failed numeric phase (#5186)', () => {
  const cwd = fixture(null);
  try {
    for (const name of ['03-foo', 'zzz-not-a-phase']) {
      const dir = path.join(cwd, '.planning/phases', name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'VERIFICATION.md'), `STATUS: ${name === '03-foo' ? 'failed' : 'passed'}\n`);
    }
    fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '---\nstatus: executing\n---\n# State\n');
    assert.equal(require('../gsd-core/bin/lib/smart-entry.cjs').classifyProject(cwd).signals.verify_failed, true);
  } finally { cleanup(cwd); }
});

for (const code of [null, 'CCM']) {
  test(`custom removal: orphaned longer ID survives removing its prefix with code ${code} (#5186)`, () => {
    const cwd = fixture(code);
    try {
      const short = add(cwd, 'A', 'First', code);
      const long = existingCustomDirectory(cwd, 'A-B', 'Second', code);
      fs.writeFileSync(path.join(cwd, '.planning/ROADMAP.md'), '# Roadmap\n## Phases\n### Phase A: First\n');
      run(cwd, ['phase', 'remove', 'A', '--force']);
      assert.equal(fs.existsSync(path.join(cwd, short)), false);
      assert.equal(fs.existsSync(path.join(cwd, long)), true);
      assert.equal(run(cwd, ['query', 'find-phase', 'A']).found, false);
      assert.equal(run(cwd, ['query', 'find-phase', 'A-B']).directory, long);
    } finally { cleanup(cwd); }
  });
  test(`custom ownership: headings cannot reassign a directory with code ${code} (#5186)`, () => {
    const cwd = fixture(code);
    try {
      const long = existingCustomDirectory(cwd, 'A-B', 'Second', code);
      fs.writeFileSync(path.join(cwd, '.planning/ROADMAP.md'), '# Roadmap\n## Phases\n### Phase A: First\n');
      run(cwd, ['phase', 'remove', 'A', '--force']);
      assert.equal(fs.existsSync(path.join(cwd, long)), true);
    } finally { cleanup(cwd); }
  });
}

test('custom context: one context resolves a large identity set', () => {
  const script = `const phaseId = require(${JSON.stringify(require.resolve('../gsd-core/bin/lib/phase-id.cjs'))});
    const roadmap = Array.from({length:1200}, (_,i) => '### Phase AUTH-'+i+': Step\\n').join('');
    const context = phaseId.phaseDirectoryContext({phase_naming:'custom'}, roadmap);
    let resolved = 0;
    for (let i=0;i<1200;i++) {
      const id='AUTH-'+i, dir=id+'-step';
      if (phaseId.phaseKeyFromDir(dir, undefined, context) !== id
        || phaseId.phaseKeyFromToken(id, context) !== id
        || phaseId.matchPhaseDirs([dir], id, undefined, context).matches[0] !== dir) throw new Error(id);
      resolved++;
    }
    process.stdout.write(JSON.stringify({resolved}));`;
  const result = require('./helpers/process-seam.cjs').runNode(['-e', script], {timeoutMs: PROBE_TIMEOUT_MS});
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {resolved: 1200});
});

test('custom context: projected roadmap is complete or bounded by its read limit', () => {
  const cwd = fixture(null);
  try {
    const roadmap = path.join(cwd, '.planning/ROADMAP.md');
    for (const text of ['', '# Roadmap\n### Phase AUTH: Sign in\n', 'x'.repeat(2 * 1024 * 1024)]) {
      fs.writeFileSync(roadmap, text);
      const context = locator.phaseDirectoryOptions(cwd, {phase_naming: 'custom'});
      assert.equal(context.roadmap, text.slice(0, 1024 * 1024));
    }
  } finally { cleanup(cwd); }
});

for (const code of [null, 'CCM']) {
  test(`custom projection: progress preserves ID and name with code ${code} (#5186)`, () => {
    const cwd = fixture(code);
    try {
      for (const id of ['AUTH', 'A-2', '2FA', '7b']) add(cwd, id, 'Sign In', code);
      const result = run(cwd, ['query', 'progress']);
      assert.deepEqual(result.phases.map(p => [p.number, p.name]).sort(),
        [['AUTH', 'sign in'], ['A-2', 'sign in'], ['2FA', 'sign in'], ['7b', 'sign in']].sort());
    } finally { cleanup(cwd); }
  });
  test(`custom projection: health W005 accepts writer directories with code ${code} (#5186)`, () => {
    const cwd = fixture(code);
    try {
      for (const id of ['AUTH', 'A-2', '2FA', '7b']) add(cwd, id, 'Sign In', code);
      const snapshot = require('../gsd-core/bin/lib/planning-snapshot.cjs').buildPlanningSnapshot(cwd);
      const rule = require('../gsd-core/bin/lib/health-diagnostic-rules/phase-structure.cjs').RULES.find(r => r.code === 'W005');
      assert.deepEqual(rule.check(snapshot), []);
      const result = run(cwd, ['validate', 'health']);
      const warnings = result.warnings.filter(w => w.code === 'W005');
      assert.deepEqual(warnings, []);
    } finally { cleanup(cwd); }
  });
}
test('custom projection: phase plan index preserves A-2 (#5186)', () => {
  const cwd = fixture(null);
  try {
    add(cwd, 'A-2');
    assert.equal(run(cwd, ['query', 'phase-plan-index', 'A-2']).phase, 'A-2');
  } finally { cleanup(cwd); }
});
for (const nextId of ['BILLING', 'ACCOUNT', 'A-2']) for (const nextOnDisk of [false, true]) {
  test(`custom completion: AUTH advances STATE to ${nextId}, next on disk ${nextOnDisk} (#5186)`, () => {
    const cwd = fixture('CCM');
    try {
      const dir = add(cwd, 'AUTH', 'Sign In', 'CCM');
      if (nextOnDisk) add(cwd, nextId, 'Payments', 'CCM');
      else fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase ${nextId}: Payments\n`);
      fs.writeFileSync(path.join(cwd, dir, 'AUTH-01-PLAN.md'), '---\nphase: AUTH\nplan: 01\n---\n# Plan\n');
      fs.writeFileSync(path.join(cwd, dir, 'AUTH-01-SUMMARY.md'), '---\nstatus: complete\n---\n# Summary\n');
      fs.writeFileSync(path.join(cwd, dir, 'AUTH-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
      fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '---\ncurrent_phase: AUTH\nstatus: executing\n---\n# State\n\n## Current Position\nPhase: AUTH (Sign In)\nStatus: Executing\n');
      const result = run(cwd, ['phase', 'complete', 'AUTH']);
      assert.equal(result.is_last_phase, false, JSON.stringify(result));
      assert.equal(result.next_phase, nextId);
      const statePath = path.join(cwd, '.planning/STATE.md');
      const state = require('../gsd-core/bin/lib/frontmatter.cjs').extractFrontmatter(fs.readFileSync(statePath, 'utf8'), statePath);
      assert.equal(state.current_phase, nextId);
    } finally { cleanup(cwd); }
  });
}

test('custom controls: legacy numeric, suffix, decimal and bracket results stay unchanged (#5186)', () => {
  const cwd = fixture('CCM', 'sequential');
  const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
  try {
    for (const dir of ['CCM-03-number', 'CCM-04A-suffix', 'CCM-05.2-decimal', 'GSD.02-06-bracket']) {
      fs.mkdirSync(path.join(cwd, '.planning/phases', dir));
    }
    const queries = ['3', 'CCM-03', '4A', 'CCM-04A', '5.2', 'CCM-05.2'];
    const before = queries.map(id => run(cwd, ['query', 'find-phase', id]));
    const bracketBefore = locator.findPhaseInternal(cwd, 'GSD.02-06', 'bracket');
    fs.writeFileSync(path.join(cwd, '.planning/config.json'), JSON.stringify({phase_naming: 'custom', project_code: 'CCM'}));
    assert.deepEqual(queries.map(id => run(cwd, ['query', 'find-phase', id])), before);
    assert.deepEqual(locator.findPhaseInternal(cwd, 'GSD.02-06', 'bracket'), bracketBefore);
    const context = locator.phaseDirectoryOptions(cwd);
    for (const id of queries) assert.equal(phaseId.phaseMarkdownRegexSource(id, context), phaseId.phaseMarkdownRegexSource(id));
  } finally { cleanup(cwd); }
});

for (const writer of ['add', 'batch']) {
  test(`custom naming policy: ${writer} refuses a custom ID shadowed by project config (#5186)`, () => {
    const cwd = fixture(null);
    try {
      fs.mkdirSync(path.join(cwd, '.gsd'));
      fs.writeFileSync(path.join(cwd, '.gsd/defaults.json'), JSON.stringify({phase_naming: 'custom', project_code: 'GLOBAL'}));
      fs.writeFileSync(path.join(cwd, '.planning/config.json'), '{}');
      const before = fs.readFileSync(path.join(cwd, '.planning/ROADMAP.md'), 'utf8');
      const args = writer === 'add' ? ['query', 'phase.add', 'Boundary', '--id', 'PRODUCT-BOUNDARY']
        : ['phase', 'add-batch', 'Boundary', '--id', 'PRODUCT-BOUNDARY'];
      const result = runGsdTools(['--json-errors', ...args], cwd, {...homeSandboxEnv(cwd), GSD_HOME: cwd});
      assert.equal(result.success, false, result.output);
      assert.equal(JSON.parse(result.error).reason, 'phase_naming_not_custom');
      assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
      assert.equal(fs.readFileSync(path.join(cwd, '.planning/ROADMAP.md'), 'utf8'), before);
      assert.equal(fs.readFileSync(path.join(cwd, '.planning/config.json'), 'utf8'), '{}');
    } finally { cleanup(cwd); }
  });
}
test('custom naming policy: explicit project naming and project code agree at every writer and reader (#5186)', () => {
  const cwd = fixture('LOCAL');
  try {
    fs.mkdirSync(path.join(cwd, '.gsd'));
    fs.writeFileSync(path.join(cwd, '.gsd/defaults.json'), JSON.stringify({phase_naming: 'sequential', project_code: 'GLOBAL'}));
    const added = add(cwd, 'PRODUCT-BOUNDARY', 'Boundary', 'LOCAL');
    assert.equal(run(cwd, ['query', 'find-phase', 'PRODUCT-BOUNDARY']).directory, added);
    assert.equal(locator.findPhaseInternal(cwd, 'PRODUCT-BOUNDARY').directory, added);
    run(cwd, ['scaffold', 'phase-dir', '--phase', 'SCAFFOLD', '--name', 'Other']);
    assert.equal(run(cwd, ['query', 'find-phase', 'SCAFFOLD']).directory, '.planning/phases/LOCAL-SCAFFOLD-other');
    run(cwd, ['phase', 'add-batch', 'Batch Boundary']);
    assert.equal(run(cwd, ['query', 'find-phase', 'BATCH-BOUNDARY']).directory, '.planning/phases/LOCAL-BATCH-BOUNDARY-batch-boundary');
  } finally { cleanup(cwd); }
});

for (const target of ['A', 'A-B']) for (const code of [null, 'CCM']) {
  test(`custom mutation safety: ${target === 'A' ? 'a unique marked owner preserves its markerless sibling' : 'an ambiguous markerless owner refuses removal'} with code ${code} (#5186)`, () => {
    const cwd = fixture(code);
    try {
      const short = add(cwd, 'A', 'First', code);
      const long = existingCustomDirectory(cwd, 'A-B', 'Second', code);
      fs.unlinkSync(path.join(cwd, long, '.phase-id'));
      const roadmap = fs.readFileSync(path.join(cwd, '.planning/ROADMAP.md'), 'utf8');
      const result = runGsdTools(['--json-errors', 'phase', 'remove', target, '--force'], cwd, homeSandboxEnv(cwd));
      if (target === 'A') {
        assert.equal(result.success, true, result.error);
        assert.equal(JSON.parse(result.output).directory_deleted, path.basename(short));
        assert.equal(fs.existsSync(path.join(cwd, short)), false);
        assert.equal(run(cwd, ['roadmap', 'get-phase', 'A']).found, false);
        assert.equal(run(cwd, ['roadmap', 'get-phase', 'A-B']).found, true);
      } else {
        assert.equal(result.success, false, result.output);
        assert.equal(JSON.parse(result.error).reason, 'ambiguous_phase_owner');
        assert.deepEqual(JSON.parse(result.error).candidates.sort(), ['A', 'A-B']);
        assert.equal(fs.existsSync(path.join(cwd, short)), true);
        assert.equal(fs.readFileSync(path.join(cwd, '.planning/ROADMAP.md'), 'utf8'), roadmap);
      }
      assert.equal(fs.existsSync(path.join(cwd, long)), true);
    } finally { cleanup(cwd); }
  });
}
for (const [target, ids, dir] of [['2', ['03', '03-2'], '03-2-second'], ['2.1', ['02.2', '02.2-extra'], '02.2-extra-second']]) {
  test(`custom mutation safety: markerless ambiguity refuses renumbering after ${target} (#5186)`, () => {
    const cwd = fixture(null);
    try {
      const targetDir = target === '2' ? '02-first' : '02.1-first';
      fs.mkdirSync(path.join(cwd, '.planning/phases', targetDir));
      fs.mkdirSync(path.join(cwd, '.planning/phases', dir));
      fs.writeFileSync(path.join(cwd, '.planning/ROADMAP.md'), `# Roadmap\n## Phases\n### Phase ${target}: First\n${ids.map(id => `### Phase ${id}: Second\n`).join('')}`);
      const roadmap = fs.readFileSync(path.join(cwd, '.planning/ROADMAP.md'), 'utf8');
      const result = runGsdTools(['--json-errors', 'phase', 'remove', target, '--force'], cwd, homeSandboxEnv(cwd));
      assert.equal(result.success, false, result.output);
      assert.equal(JSON.parse(result.error).reason, 'ambiguous_phase_owner');
      assert.deepEqual(JSON.parse(result.error).candidates.sort(), [...ids].sort());
      assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')).sort(), [targetDir, dir].sort());
      assert.equal(fs.readFileSync(path.join(cwd, '.planning/ROADMAP.md'), 'utf8'), roadmap);
    } finally { cleanup(cwd); }
  });
}

test('custom mutation safety: numeric removal preserves recorded sibling IDs (#5186)', () => {
  const cwd = fixture(null);
  try {
    fs.mkdirSync(path.join(cwd, '.planning/phases/02-first'));
    const dir = add(cwd, '3A', 'Boundary');
    run(cwd, ['phase', 'remove', '2', '--force']);
    assert.equal(run(cwd, ['query', 'find-phase', '3A']).directory, dir);
    assert.equal(fs.readFileSync(path.join(cwd, dir, '.phase-id'), 'utf8').trim(), '3A');
  } finally { cleanup(cwd); }
});

test('custom naming policy: numeric display prefixes remain valid for sequential scaffold (#5186)', () => {
  const cwd = fixture('CCM', 'sequential');
  try {
    for (const [id, dir] of [['CCM-03', 'CCM-03-numeric'], ['CCM-04A', 'CCM-04A-numeric'], ['CCM-05.2', 'CCM-05.2-numeric']]) {
      assert.equal(run(cwd, ['scaffold', 'phase-dir', '--phase', id, '--name', 'Numeric']).directory, `.planning/phases/${dir}`);
    }
  } finally { cleanup(cwd); }
});

test('custom ownership scope: active and archived directories with the same basename keep their own records (#5186)', () => {
  const cwd = fixture('CCM');
  try {
    const original = add(cwd, 'setup-extra', 'Widget', 'CCM');
    const archive = path.join(cwd, '.planning/milestones/v1.0-phases');
    fs.mkdirSync(archive, {recursive: true});
    const archived = path.join(archive, path.basename(original));
    fs.renameSync(path.join(cwd, original), archived);
    const created = existingCustomDirectory(cwd, 'CCM-setup', 'Extra Widget', 'CCM');
    // These IDs have no segment-prefix collision. The reader supports both
    // configured-prefix and unprefixed legacy directory bodies, allowing the
    // two physical pools to retain the same basename with different records.
    const active = '.planning/phases/CCM-setup-extra-widget';
    fs.renameSync(path.join(cwd, created), path.join(cwd, active));
    assert.equal(path.basename(active), path.basename(archived));
    fs.writeFileSync(path.join(cwd, '.planning/ROADMAP.md'), '# Roadmap\n');
    for (const [id, expected] of [['CCM-setup', active], ['setup-extra', toPosixPath(path.relative(cwd, archived))]]) {
      assert.equal(run(cwd, ['query', 'find-phase', id]).directory, expected);
      assert.equal(locator.findPhaseInternal(cwd, id).directory, expected);
    }
  } finally { cleanup(cwd); }
});
test('custom ownership scope: root active identities stay separate from the ambient workstream archive (#5186)', () => {
  const cwd = fixture(null);
  const previous = process.env.GSD_WORKSTREAM;
  try {
    const ws = path.join(cwd, '.planning/workstreams/alpha');
    const archived = path.join(ws, 'milestones/v1.0-phases/ARCHIVE-boundary');
    fs.mkdirSync(archived, {recursive: true});
    fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({phase_naming: 'custom'}));
    fs.writeFileSync(path.join(archived, '.phase-id'), 'ARCHIVE');
    process.env.GSD_WORKSTREAM = 'alpha';
    const root = locator.phaseDirectoryOptions(cwd, undefined, '', null);
    assert.equal(root.directoryIds['ARCHIVE-boundary'], undefined);
    assert.equal(root.directoryIdsByRoot[path.dirname(archived)]['ARCHIVE-boundary'], 'ARCHIVE');
    assert.equal(locator.findPhaseInternal(cwd, 'ARCHIVE').directory, toPosixPath(path.relative(cwd, archived)));
  } finally {
    if (previous === undefined) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = previous;
    cleanup(cwd);
  }
});

for (const [id, alias] of [['3-Q1', '3'], ['2024-Q1', '2024'], ['007', '7']]) {
  test(`recorded identity: removing ${alias} preserves ${id}`, () => {
    const cwd = fixture(null);
    try {
      const dir = add(cwd, id, 'Quarter one');
      const result = run(cwd, ['phase', 'remove', alias, '--force']);
      assert.equal(result.directory_deleted, null);
      assert.ok(fs.existsSync(path.join(cwd, dir)), 'a numeric alias must not delete another recorded ID');
      assert.equal(run(cwd, ['query', 'find-phase', id]).found, true);
    } finally { cleanup(cwd); }
  });
}
test('recorded identity: case-insensitive configured prefix resolves the exact ID', () => {
  const cwd = fixture('CCM');
  try {
    const dir = add(cwd, '3-Q1', 'Quarter one', 'CCM');
    assert.equal(run(cwd, ['query', 'find-phase', 'ccm-3-q1']).directory, dir);
    assert.equal(run(cwd, ['phase', 'remove', 'CCM-3-q1', '--force']).directory_deleted, dir.split('/').at(-1));
  } finally { cleanup(cwd); }
});

for (const removed of ['3', 'AUTH']) {
  test(`custom removal: removing ${removed} preserves surviving roadmap identities and ordinals`, () => {
    const cwd = fixture(null);
    try {
      const ids = ['3', '4', 'AUTH', '5'];
      for (const id of ids) add(cwd, id, `X${id}`);
      const roadmap = path.join(cwd, '.planning/ROADMAP.md');
      fs.appendFileSync(roadmap, '\n## Progress\n\n| Phase | Plans | Status |\n| --- | --- | --- |\n' + ids.map(id => `| ${id}. X${id} | 0/1 | Pending |`).join('\n') + '\n');
      const { findTableWithColumns } = require('../gsd-core/bin/lib/markdown-table.cjs');
      const before = findTableWithColumns(fs.readFileSync(roadmap, 'utf8'), ['Phase', 'Plans', 'Status']);
      run(cwd, ['phase', 'remove', removed, '--force']);
      const after = findTableWithColumns(fs.readFileSync(roadmap, 'utf8'), ['Phase', 'Plans', 'Status']);
      assert.equal(run(cwd, ['roadmap', 'get-phase', removed]).found, false);
      assert.deepEqual(after.rows, before.rows.filter(row => row.Phase !== `${removed}. X${removed}`));
      for (const id of ids.filter(id => id !== removed)) {
        assert.equal(run(cwd, ['query', 'find-phase', id]).found, true, id);
        const section = run(cwd, ['roadmap', 'get-phase', id]);
        assert.equal(section.found, true, JSON.stringify(section));
        assert.equal(section.phase_name, `X${id}`);
      }
    } finally { cleanup(cwd); }
  });
}

for (const [removed, survivor] of [['1', '2024-Q1'], ['2.1', '2.2-EXTRA']]) {
  test(`custom renumbering: removal of ${removed} preserves unmarked known owner ${survivor}`, () => {
    const cwd = fixture(null);
    try {
      add(cwd, removed, 'Remove');
      const dir = path.join(cwd, '.planning/phases', `${survivor}-plan`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'survivor bytes\n');
      fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase ${survivor}: Plan\n`);
      const result = run(cwd, ['phase', 'remove', removed, '--force']);
      assert.deepEqual(result.renamed_directories, []);
      assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'survivor bytes\n');
    } finally { cleanup(cwd); }
  });
}

for (const [first, second] of [['3', '3-2'], ['3-2', '3'], ['setup', 'setup-extra'], ['setup-extra', 'setup']]) {
  test(`custom marked prefixes: ${first} and ${second} keep distinct directories`, () => {
    const cwd = fixture(null);
    try {
      const firstDir = add(cwd, first, 'First');
      const secondDir = add(cwd, second, 'Second');
      assert.equal(run(cwd, ['query', 'find-phase', first]).directory, firstDir);
      assert.equal(run(cwd, ['query', 'find-phase', second]).directory, secondDir);
    } finally { cleanup(cwd); }
  });
}

for (const id of [' A', 'B ', '[Z]', 'A B', 'A\tB', 'A:B']) {
  test(`custom ID validation: rejects unreadable ID ${JSON.stringify(id)}`, () => {
    const cwd = fixture(null);
    try {
      const roadmap = path.join(cwd, '.planning/ROADMAP.md');
      const before = fs.readFileSync(roadmap, 'utf8');
      const result = runGsdTools(['--json-errors', 'query', 'phase.add', 'Invalid', '--id', id], cwd, homeSandboxEnv(cwd));
      assert.equal(result.success, false);
      assert.equal(JSON.parse(result.error).reason, 'usage');
      assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
      assert.equal(fs.readFileSync(roadmap, 'utf8'), before);
    } finally { cleanup(cwd); }
  });
}

test('custom insertion: records AUTH.1 and permits its removal', () => {
  const cwd = fixture(null);
  try {
    add(cwd, 'AUTH', 'Sign In');
    const inserted = run(cwd, ['phase', 'insert', 'AUTH', 'Extra']);
    const marker = path.join(cwd, inserted.directory, '.phase-id');
    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'AUTH.1');
    assert.equal(run(cwd, ['query', 'find-phase', 'AUTH.1']).directory, inserted.directory);
    run(cwd, ['phase', 'remove', 'AUTH.1', '--force']);
    assert.equal(fs.existsSync(path.join(cwd, inserted.directory)), false);
    assert.equal(run(cwd, ['query', 'find-phase', 'AUTH']).found, true);
  } finally { cleanup(cwd); }
});

for (const ambiguous of [false, true]) {
  test(`custom ownership repair: only ambiguous markerless owners refuse with ambiguity ${ambiguous}`, () => {
    const cwd = fixture(null);
    try {
      const id = ambiguous ? 'AUTH-EXTRA' : 'AUTH';
      const dir = `${id}-legacy`;
      fs.mkdirSync(path.join(cwd, '.planning/phases', dir));
      fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase AUTH: Auth\n${ambiguous ? '### Phase AUTH-EXTRA: Extra\n' : ''}`);
      const result = runGsdTools(['--json-errors', 'phase', 'remove', id, '--force'], cwd, homeSandboxEnv(cwd));
      assert.equal(result.success, !ambiguous, result.error || result.output);
      if (ambiguous) {
        const refusal = JSON.parse(result.error);
        assert.equal(refusal.reason, 'ambiguous_phase_owner');
        assert.deepEqual(refusal.candidates.sort(), ['AUTH', 'AUTH-EXTRA']);
        assert.equal(refusal.marker_path, `${dir}/.phase-id`);
      } else assert.equal(JSON.parse(result.output).directory_deleted, dir);
    } finally { cleanup(cwd); }
  });
}

for (const [id, directory] of [['M1-03', '03-boundary'], ['AUTH', 'AUTH-boundary']]) {
  test(`legacy scaffold compatibility: non-custom project accepts ${id}`, () => {
    const cwd = fixture(null, 'sequential');
    try {
      const created = run(cwd, ['scaffold', 'phase-dir', '--phase', id, '--name', 'Boundary']);
      assert.equal(created.directory, `.planning/phases/${directory}`);
      assert.equal(fs.statSync(path.join(cwd, created.directory)).isDirectory(), true);
      assert.equal(fs.existsSync(path.join(cwd, created.directory, '.phase-id')), false);
    } finally { cleanup(cwd); }
  });
}

for (const command of [['query', 'progress.json'], ['query', 'roadmap.analyze'], ['query', 'find-phase', '1']]) {
  test(`read-only naming: invalid config stays silent for ${command[1]}`, () => {
    const cwd = fixture(null, 'sequential');
    try {
      fs.writeFileSync(path.join(cwd, '.planning/config.json'), '{ invalid-config.json');
      const result = require('./helpers/process-seam.cjs').runNode([path.join(__dirname, '../gsd-core/bin/gsd-tools.cjs'), ...command], {cwd, env: {...process.env, ...homeSandboxEnv(cwd)}});
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.equal(fs.readFileSync(path.join(cwd, '.planning/config.json'), 'utf8'), '{ invalid-config.json');
    } finally { cleanup(cwd); }
  });
}

for (const kind of ['oversized', 'symlink', 'fifo']) {
  test(`identity marker safety: ignores ${kind} without an unbounded read`, {skip: kind === 'fifo' && process.platform === 'win32'}, () => {
    const cwd = fixture(null);
    try {
      const dir = path.join(cwd, '.planning/phases/AUTH-boundary');
      fs.mkdirSync(dir);
      const marker = path.join(dir, '.phase-id');
      if (kind === 'oversized') fs.writeFileSync(marker, 'AUTH' + ' '.repeat(1024));
      else if (kind === 'symlink') {
        const target = path.join(cwd, 'identity.txt');
        fs.writeFileSync(target, 'AUTH');
        fs.symlinkSync(target, marker);
      } else {
        const fifo = require('./helpers/process-seam.cjs').runHook(marker, [], {interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS});
        assert.equal(fifo.exitCode, 0, fifo.stderr);
      }
      const script = `const locator = require(${JSON.stringify(require.resolve('../gsd-core/bin/lib/phase-locator.cjs'))}); process.stdout.write(JSON.stringify(locator.phaseDirectoryOptions(process.cwd(), {phase_naming:'custom'}, '').directoryIds));`;
      const result = require('./helpers/process-seam.cjs').runNode(['-e', script], {
        cwd, env: {...process.env, ...homeSandboxEnv(cwd)}, timeoutMs: PROBE_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.stdout), {});
    } finally { cleanup(cwd); }
  });
}

test('archive scope compatibility: null workstream retains the environment fallback', () => {
  const cwd = fixture(null);
  const previous = process.env.GSD_WORKSTREAM;
  try {
    const ws = path.join(cwd, '.planning/workstreams/alpha');
    const archive = path.join(ws, 'milestones/v1.0-phases');
    const archived = path.join(archive, 'AUTH-boundary');
    fs.mkdirSync(archived, {recursive: true});
    fs.writeFileSync(path.join(archived, '.phase-id'), 'AUTH');
    fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({phase_naming: 'custom'}));
    process.env.GSD_WORKSTREAM = 'alpha';
    const result = runGsdTools(['query', 'find-phase', 'AUTH'], cwd, {...homeSandboxEnv(cwd), GSD_WORKSTREAM: 'alpha'});
    assert.equal(result.success, true, result.error || result.output);
    assert.equal(JSON.parse(result.output).directory, toPosixPath(path.relative(cwd, archived)));
    // The exported archive reader forwards null to the private enumeration seam.
    const phases = locator.getArchivedPhaseDirs(cwd, null);
    assert.ok(phases.some(entry => toPosixPath(entry.fullPath) === toPosixPath(archived)), JSON.stringify(phases));
  } finally {
    if (previous === undefined) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = previous;
    cleanup(cwd);
  }
});

test('read-only naming: two-key projection agrees with loadConfig across resolution branches', () => {
  const loader = require('../gsd-core/bin/lib/config-loader.cjs');
  const cases = [
    {name: 'project shadows global', root: {}},
    {name: 'root custom', root: {phase_naming: 'custom', project_code: 'ROOT'}},
    {name: 'workstream inherits root', root: {phase_naming: 'custom', project_code: 'ROOT'}, ws: {}},
    {name: 'workstream overrides root', root: {phase_naming: 'sequential', project_code: 'ROOT'}, ws: {phase_naming: 'custom', project_code: 'WS'}},
    {name: 'workstream null uses builtins', root: {phase_naming: 'custom', project_code: 'ROOT'}, ws: {phase_naming: null, project_code: null}},
    {name: 'broken workstream falls back', root: {phase_naming: 'custom', project_code: 'ROOT'}, ws: 'invalid'},
    {name: 'absent workstream falls back', root: {phase_naming: 'custom', project_code: 'ROOT'}, ws: undefined, ambient: 'alpha'},
    {name: 'broken root with usable workstream', root: 'invalid', ws: {phase_naming: 'custom', project_code: 'WS'}},
    {name: 'project-scoped workstream inherits flat root', root: {phase_naming: 'custom', project_code: 'ROOT'}, project: {phase_naming: 'sequential', project_code: 'PROJECT'}, ws: {}},
    {name: 'project-scoped broken workstream falls back to project', root: {phase_naming: 'custom', project_code: 'ROOT'}, project: {phase_naming: 'custom', project_code: 'PROJECT'}, ws: 'invalid'},
    {name: 'explicit null ignores ambient workstream', root: {phase_naming: 'custom', project_code: 'ROOT'}, ws: {phase_naming: 'sequential', project_code: 'WS'}, override: null},
    {name: 'no planning ignores global naming', noPlanning: true},
  ];
  const saved = Object.fromEntries(['GSD_HOME', 'GSD_PROJECT', 'GSD_WORKSTREAM'].map(key => [key, process.env[key]]));
  try {
    for (const scenario of cases) {
      const cwd = fixture(null);
      try {
        process.env.GSD_HOME = cwd;
        delete process.env.GSD_PROJECT;
        delete process.env.GSD_WORKSTREAM;
        fs.mkdirSync(path.join(cwd, '.gsd'));
        fs.writeFileSync(path.join(cwd, '.gsd/defaults.json'), JSON.stringify({phase_naming: 'custom', project_code: 'GLOBAL'}));
        const writeConfig = (dir, value) => {
          fs.mkdirSync(dir, {recursive: true});
          fs.writeFileSync(path.join(dir, 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
        };
        if (scenario.noPlanning) cleanup(path.join(cwd, '.planning'));
        else {
          writeConfig(path.join(cwd, '.planning'), scenario.root);
          if (scenario.project) {
            process.env.GSD_PROJECT = 'project';
            writeConfig(path.join(cwd, '.planning/project'), scenario.project);
          }
          if (scenario.ws !== undefined || scenario.ambient) {
            process.env.GSD_WORKSTREAM = 'alpha';
            if (scenario.ws !== undefined) writeConfig(path.join(cwd, '.planning', scenario.project ? 'project' : '', 'workstreams/alpha'), scenario.ws);
          }
        }
        const expected = loader.loadConfig(cwd, {persist: false, ...(scenario.override !== undefined ? {workstream: scenario.override} : {})});
        const context = locator.phaseDirectoryOptions(cwd, undefined, '', scenario.override);
        assert.deepEqual([context.phaseNaming, context.projectCode], [expected.phase_naming, expected.project_code], scenario.name);
      } finally { cleanup(cwd); }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const code of [null, 'CCM']) for (const id of ['3', '4A', '5.2']) {
  test(`recorded scaffold identity: ${id} resolves with configured code ${code}`, () => {
    const cwd = fixture(code);
    try {
      const created = run(cwd, ['scaffold', 'phase-dir', '--phase', id, '--name', 'Numeric']);
      assert.equal(fs.readFileSync(path.join(cwd, created.directory, '.phase-id'), 'utf8').trim(), id);
      assert.equal(run(cwd, ['query', 'find-phase', id]).directory, created.directory);
    } finally { cleanup(cwd); }
  });
}

for (const padded of [false, true]) for (const removed of ['1', '2']) {
  test(`legacy removal identity: custom project renumbers numeric phases with padded headings ${padded}, removing ${removed}`, () => {
    const cwd = fixture(null);
    try {
      const names = ['a', 'b', 'c'];
      for (const [index, name] of names.entries()) {
        fs.mkdirSync(path.join(cwd, '.planning/phases', `0${index + 1}-${name}`));
        const id = `${padded ? '0' : ''}${index + 1}`;
        fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase ${id}: ${name}\n\n**Plans:** 0 plans\n`);
      }
      fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n## Progress\n\n| Phase | Plans Complete | Status | Completed |\n| --- | --- | --- | --- |\n' + names.map((name, index) => `| ${index + 1}. ${name} | 0/0 | Not started | - |`).join('\n') + '\n');
      const result = run(cwd, ['phase', 'remove', removed, '--force']);
      assert.equal(result.roadmap_updated, true);
      const survivors = names.filter((_, index) => index + 1 !== Number(removed));
      for (const [index, name] of survivors.entries()) {
        const id = String(index + 1);
        assert.equal(run(cwd, ['query', 'find-phase', id]).directory, `.planning/phases/0${id}-${name}`);
        assert.equal(run(cwd, ['roadmap', 'get-phase', id]).phase_name, name);
      }
      const health = run(cwd, ['validate', 'health']);
      assert.deepEqual(health.warnings.filter(warning => ['W006', 'W007'].includes(warning.code)), []);
    } finally { cleanup(cwd); }
  });
}
test('legacy removal identity: numeric renumbering preserves recorded headings, ordinals and references', () => {
  const cwd = fixture(null);
  try {
    for (const [id, name] of [['01', 'a'], ['02', 'b']]) {
      fs.mkdirSync(path.join(cwd, '.planning/phases', `${id}-${name}`));
      fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase ${Number(id)}: ${name}\n`);
    }
    add(cwd, '5', 'Stable');
    fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n**Depends on:** Phase 5\n- [ ] 05-01-PLAN.md\n- [ ] Phase 5: Stable\n\n## Progress\n\n| Phase | Status |\n| --- | --- |\n| 1. a | Pending |\n| 2. b | Pending |\n| 5. Stable | Pending |\n');
    run(cwd, ['phase', 'remove', '1', '--force']);
    const roadmap = fs.readFileSync(path.join(cwd, '.planning/ROADMAP.md'), 'utf8');
    assert.equal(run(cwd, ['roadmap', 'get-phase', '1']).phase_name, 'b');
    assert.equal(run(cwd, ['roadmap', 'get-phase', '5']).phase_name, 'Stable');
    const { findTableWithColumns } = require('../gsd-core/bin/lib/markdown-table.cjs');
    assert.deepEqual(findTableWithColumns(roadmap, ['Phase', 'Status']).rows,
      [{Phase: '1. b', Status: 'Pending'}, {Phase: '5. Stable', Status: 'Pending'}]);
    const stable = run(cwd, ['query', 'roadmap.analyze']).phases.find(phase => phase.number === '5');
    assert.equal(stable.depends_on, 'Phase 5');
    const bullets = require('../gsd-core/bin/lib/markdown-sectionizer.cjs').iterateBullets(
      run(cwd, ['roadmap', 'get-phase', '5']).section);
    assert.equal(bullets.find(bullet => bullet.text === '05-01-PLAN.md').checked, false);
  } finally { cleanup(cwd); }
});
test('legacy removal identity: removing a recorded numeric target leaves legacy siblings unchanged', () => {
  const cwd = fixture(null);
  try {
    add(cwd, '1', 'Stable');
    for (const id of ['02', '03']) {
      fs.mkdirSync(path.join(cwd, '.planning/phases', `${id}-legacy`));
      fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), `\n### Phase ${Number(id)}: Legacy ${id}\n`);
    }
    const result = run(cwd, ['phase', 'remove', '1', '--force']);
    assert.deepEqual(result.renamed_directories, []);
    for (const id of ['2', '3']) assert.equal(run(cwd, ['query', 'find-phase', id]).directory, `.planning/phases/0${id}-legacy`);
  } finally { cleanup(cwd); }
});

for (const code of [null, 'CCM']) {
  test(`inserted numeric aliases: 03.1 resolves and removes as 3.1 with code ${code}`, () => {
    const cwd = fixture(code);
    try {
      fs.mkdirSync(path.join(cwd, '.planning/phases', `${code ? `${code}-` : ''}03-base`));
      fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n### Phase 3: Base\n');
      const inserted = run(cwd, ['phase', 'insert', '3', 'Hot']);
      assert.equal(inserted.phase_number, '03.1');
      assert.equal(run(cwd, ['query', 'find-phase', '3.1']).directory, inserted.directory);
      const removed = run(cwd, ['phase', 'remove', '3.1', '--force']);
      assert.equal(removed.directory_deleted, path.basename(inserted.directory));
      assert.equal(fs.existsSync(path.join(cwd, inserted.directory)), false);
      assert.equal(run(cwd, ['roadmap', 'get-phase', '03.1']).found, false);
    } finally { cleanup(cwd); }
  });
  test(`recorded numeric aliases: scaffold 7 resolves as 07 with code ${code}`, () => {
    const cwd = fixture(code);
    try {
      const created = run(cwd, ['scaffold', 'phase-dir', '--phase', '7', '--name', 'A']);
      for (const query of ['7', '07', ...(code ? [`${code}-07`] : [])]) assert.equal(run(cwd, ['query', 'find-phase', query]).directory, created.directory);
    } finally { cleanup(cwd); }
  });
}

for (const id of ['[CCM.01-01]', '[CCM]-01']) {
  test(`legacy bracket scaffold: accepts ${id} outside custom naming`, () => {
    const cwd = fixture('CCM', 'sequential');
    try {
      fs.writeFileSync(path.join(cwd, '.planning/config.json'), JSON.stringify({phase_id_convention: 'bracket', project_code: 'CCM'}));
      const created = run(cwd, ['scaffold', 'phase-dir', '--phase', id, '--name', 'A']);
      assert.equal(fs.statSync(path.join(cwd, created.directory)).isDirectory(), true);
      assert.equal(fs.existsSync(path.join(cwd, created.directory, '.phase-id')), false);
    } finally { cleanup(cwd); }
  });
}

for (const writer of ['add', 'batch', 'scaffold']) for (const owner of ['recorded', 'markerless', 'roadmap']) {
  test(`shared custom identity preflight: ${writer} checks prefix ownership from ${owner}`, () => {
    const cwd = fixture(null);
    try {
      if (owner === 'recorded') add(cwd, 'AUTH', 'Existing');
      else if (owner === 'markerless') {
        fs.mkdirSync(path.join(cwd, '.planning/phases/AUTH-EXTRA-legacy'));
        fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n### Phase AUTH: Declared\n');
      } else fs.appendFileSync(path.join(cwd, '.planning/ROADMAP.md'), '\n### Phase AUTH: Declared\n');
      const before = fs.readdirSync(path.join(cwd, '.planning/phases'));
      const args = writer === 'add' ? ['query', 'phase.add', 'New', '--id', 'AUTH-EXTRA']
        : writer === 'batch' ? ['phase', 'add-batch', 'Auth Extra']
          : ['scaffold', 'phase-dir', '--phase', 'AUTH-EXTRA', '--name', 'New'];
      const result = runGsdTools(['--json-errors', ...args], cwd, homeSandboxEnv(cwd));
      assert.equal(result.success, owner !== 'markerless', result.error || result.output);
      if (owner === 'markerless') {
        assert.equal(JSON.parse(result.error).reason, 'phase_id_collision');
        assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), before);
      } else assert.equal(run(cwd, ['query', 'find-phase', 'AUTH-EXTRA']).found, true);
    } finally { cleanup(cwd); }
  });
}
for (const descriptions of [['Auth', 'Auth Extra'], ['Auth Extra', 'Auth']]) {
  test(`shared custom identity preflight: batch records prefixes in order ${descriptions.join(', ')}`, () => {
    const cwd = fixture(null);
    try {
      const result = run(cwd, ['phase', 'add-batch', ...descriptions]);
      assert.equal(result.count, 2);
      for (const phase of result.phases) {
        assert.equal(run(cwd, ['query', 'find-phase', phase.phase_number]).directory, phase.directory);
      }
    } finally { cleanup(cwd); }
  });
}

test('recorded numeric aliases: a letter-suffixed continuation never aliases its parent', () => {
  const cwd = fixture(null);
  try {
    add(cwd, '2A');
    assert.equal(run(cwd, ['query', 'find-phase', '2A-2']).found, false);
  } finally { cleanup(cwd); }
});
