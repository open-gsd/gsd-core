'use strict';

/**
 * #6302 (Phase 3 of #3711, ADR-3711 D1/D4/D7): the `executor_runtime` plan field, the
 * `workflow.cross_runtime_execution` gate and the `execute.models.<runtime>` key family.
 * Validation only: nothing here dispatches.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

let project;
let seq = 0;

before(() => { project = createTempProject('gsd-6302-'); });
after(() => { cleanup(project); });

const env = () => isolatedEnv({ home: project, base: {}, override: { GSD_HOME: project } });

const AUTO_TASK = [
  '<task type="auto">',
  '  <name>Task 1: do it</name>',
  '  <files>src/a.js</files>',
  '  <action>do the thing</action>',
  '  <verify><automated>node -e "process.exit(0)"</automated></verify>',
  '  <done>it is done</done>',
  '</task>',
].join('\n');

const CHECKPOINT_TASK = [
  '<task type="checkpoint:human-verify" gate="blocking">',
  '  <name>Task 2: check it</name>',
  '  <what-built>a thing</what-built>',
  '  <how-to-verify>look at it</how-to-verify>',
  '  <resume-signal>approved</resume-signal>',
  '</task>',
].join('\n');

/** Write a 03-05 plan with the given extra frontmatter lines and body; returns its project-relative path. */
function writePlan({ extra = [], autonomous = 'true', body = AUTO_TASK, eol = '\n' } = {}) {
  const phaseDir = path.join(project, '.planning', 'phases', '03-x');
  fs.mkdirSync(phaseDir, { recursive: true });
  const fm = [
    'phase: 03-x',
    'plan: "05"',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [src/a.js]',
    `autonomous: ${autonomous}`,
    ...extra,
    'must_haves:',
    '  truths: ["it works"]',
    '  artifacts: []',
  ];
  const file = path.join(phaseDir, `03-05-PLAN.md`);
  fs.writeFileSync(file, `---${eol}${fm.join(eol)}${eol}---${eol}<objective>x</objective>${eol}${body.split('\n').join(eol)}${eol}`);
  return path.relative(project, file);
}

function planIndexEntry() {
  const r = runGsdTools(['phase-plan-index', '03'], project, env());
  assert.equal(r.success, true, r.error);
  return JSON.parse(r.output).plans[0];
}

function verify(rel) {
  const r = runGsdTools(['verify', 'plan-structure', rel], project, env());
  // The verb exits 0 for a valid plan and 1 for an invalid one; either way it delivers the JSON verdict.
  assert.ok(r.exitCode === 0 || r.exitCode === 1, r.error);
  return JSON.parse(r.output);
}

describe('#6302 executor_runtime is parsed into the plan index', () => {
  test('a declared value is emitted', () => {
    writePlan({ extra: ['executor_runtime: codex'] });
    assert.equal(planIndexEntry().executor_runtime, 'codex');
  });

  test('an absent field is null', () => {
    writePlan();
    assert.equal(planIndexEntry().executor_runtime, null);
  });

  test('an empty, quoted-empty or whitespace value reads as unset', () => {
    for (const line of ['executor_runtime:', 'executor_runtime: ""', 'executor_runtime: "   "']) {
      writePlan({ extra: [line] });
      assert.equal(planIndexEntry().executor_runtime, null, line);
    }
  });

  test('a CRLF plan yields the bare value', () => {
    writePlan({ extra: ['executor_runtime: codex'], eol: '\r\n' });
    assert.equal(planIndexEntry().executor_runtime, 'codex');
  });

  test('a mention in the body is not the field', () => {
    writePlan({ body: `${AUTO_TASK}\nexecutor_runtime: codex` });
    assert.equal(planIndexEntry().executor_runtime, null);
  });

  test('property: a trimmed printable value round-trips', () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,30}$/),
      (value) => {
        writePlan({ extra: [`executor_runtime: ${value}`] });
        assert.equal(planIndexEntry().executor_runtime, value);
      },
    ), { numRuns: 25 });
  });
});

describe('#6302 verify plan-structure refuses executor_runtime where a foreign executor cannot work', () => {
  const mentionsBoth = (errors, a, b) => errors.some((e) => e.includes(a) && e.includes(b));

  test('autonomous: false is refused, naming both fields', () => {
    const v = verify(writePlan({ extra: ['executor_runtime: codex'], autonomous: 'false' }));
    assert.equal(v.valid, false);
    assert.ok(mentionsBoth(v.errors, 'executor_runtime', 'autonomous'), JSON.stringify(v.errors));
  });

  test('a checkpoint task is refused, naming both', () => {
    const v = verify(writePlan({ extra: ['executor_runtime: codex'], autonomous: 'false', body: `${AUTO_TASK}\n${CHECKPOINT_TASK}` }));
    assert.equal(v.valid, false);
    assert.ok(mentionsBoth(v.errors, 'executor_runtime', 'checkpoint'), JSON.stringify(v.errors));
  });

  test('a checkpoint task in an autonomous plan reports both the existing error and the conflict', () => {
    const v = verify(writePlan({ extra: ['executor_runtime: codex'], autonomous: 'true', body: `${AUTO_TASK}\n${CHECKPOINT_TASK}` }));
    assert.ok(v.errors.some((e) => e.includes('Has checkpoint tasks but autonomous is not false')), JSON.stringify(v.errors));
    assert.ok(mentionsBoth(v.errors, 'executor_runtime', 'checkpoint'), JSON.stringify(v.errors));
  });

  test('agent_hint together with executor_runtime is refused, naming both', () => {
    const v = verify(writePlan({ extra: ['executor_runtime: codex', 'agent_hint: some-specialist'] }));
    assert.equal(v.valid, false);
    assert.ok(mentionsBoth(v.errors, 'executor_runtime', 'agent_hint'), JSON.stringify(v.errors));
  });

  test('executor_runtime alone on an autonomous plan of auto tasks is valid', () => {
    const v = verify(writePlan({ extra: ['executor_runtime: codex'] }));
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.equal(v.errors.some((e) => e.includes('executor_runtime')), false);
  });

  test('agent_hint alone and no field at all stay valid', () => {
    assert.equal(verify(writePlan({ extra: ['agent_hint: some-specialist'] })).errors.some((e) => e.includes('executor_runtime')), false);
    assert.equal(verify(writePlan()).errors.some((e) => e.includes('executor_runtime')), false);
  });

  test('an empty executor_runtime next to autonomous: false and agent_hint raises no conflict', () => {
    const v = verify(writePlan({ extra: ['executor_runtime: ""', 'agent_hint: some-specialist'], autonomous: 'false' }));
    assert.equal(v.errors.some((e) => e.includes('executor_runtime')), false, JSON.stringify(v.errors));
  });

  test('the verdict does not depend on the gate', () => {
    const rel = writePlan({ extra: ['executor_runtime: codex'], autonomous: 'false' });
    try {
      const verdicts = [undefined, false, true].map((gate) => {
        fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify(gate === undefined ? {} : { workflow: { cross_runtime_execution: gate } }));
        return JSON.stringify(verify(rel));
      });
      assert.equal(new Set(verdicts).size, 1);
    } finally {
      fs.writeFileSync(path.join(project, '.planning', 'config.json'), '{}');
    }
  });

  test('a value that is not a runtime id is refused (letters, digits, underscore and dash only)', () => {
    const bad = ['co dex', 'codex;rm', '--x', 'a/b', 'a.b', '../x'];
    for (const value of bad) {
      const v = verify(writePlan({ extra: [`executor_runtime: "${value}"`] }));
      assert.equal(v.valid, false, value);
      assert.ok(v.errors.some((e) => e.includes('executor_runtime') && e.includes('runtime id')), `${value}: ${JSON.stringify(v.errors)}`);
    }
    for (const value of ['codex', 'kimi-code', 'open_code2', 'A']) {
      const v = verify(writePlan({ extra: [`executor_runtime: ${value}`] }));
      assert.equal(v.errors.some((e) => e.includes('runtime id')), false, value);
    }
  });
});

describe('#6302 the gate and the model key family are registered', () => {
  function freshProject() {
    seq += 1;
    const dir = path.join(project, `cfg-${seq}`);
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
    return dir;
  }
  const set = (dir, key, value) => runGsdTools(['config-set', key, value], dir, env());
  const get = (dir, key) => runGsdTools(['config-get', key], dir, env());

  test('the gate defaults to false when absent', () => {
    const r = get(freshProject(), 'workflow.cross_runtime_execution');
    assert.equal(r.success, true, r.error);
    assert.equal(JSON.parse(r.output), false);
  });

  test('the gate accepts true and false and reads them back', () => {
    const dir = freshProject();
    for (const value of [true, false]) {
      assert.equal(set(dir, 'workflow.cross_runtime_execution', String(value)).success, true);
      assert.equal(JSON.parse(get(dir, 'workflow.cross_runtime_execution').output), value);
    }
  });

  test('the defaults manifest and the schema manifest both carry the gate, default false', () => {
    const root = path.join(__dirname, '..', 'gsd-core', 'bin', 'shared');
    const defaults = JSON.parse(fs.readFileSync(path.join(root, 'config-defaults.manifest.json'), 'utf8'));
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'config-schema.manifest.json'), 'utf8'));
    assert.equal(defaults.workflow.cross_runtime_execution, false);
    assert.ok(schema.validKeys.includes('workflow.cross_runtime_execution'));
  });

  test('execute.models.<runtime> accepts a runtime segment of letters, digits, dash and underscore', () => {
    const dir = freshProject();
    for (const runtime of ['codex', 'kimi-code', 'open_code2', 'a']) {
      const r = set(dir, `execute.models.${runtime}`, 'some-model');
      assert.equal(r.success, true, `${runtime}: ${r.error}`);
      assert.equal(JSON.parse(get(dir, `execute.models.${runtime}`).output), 'some-model');
    }
  });

  test('execute.models refuses an empty, dotted or slashed runtime segment', () => {
    const dir = freshProject();
    for (const key of ['execute.models.', 'execute.models.a.b', 'execute.models.a/b', 'execute.models']) {
      assert.equal(set(dir, key, 'm').success, false, key);
    }
  });
});
