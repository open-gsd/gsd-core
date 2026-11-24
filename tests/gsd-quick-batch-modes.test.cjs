'use strict';

/**
 * gsd-quick-batch-modes.test.cjs — #6532: a quick-batch stores its modes at
 * `quick-batch create` (`options.modes`) and every `init.quick-batch --resume`
 * uses them (items 1-6 and their acceptance criteria; item 7, the completion
 * condition, waits for #6531 and is not covered here).
 *
 * Every test drives the real CLI: `runGsdTools` for the verbs, and the shipped
 * workflow's own bash blocks (extracted from `quick-batch.md` and
 * `quick-batch/steps/batch-init.md`, source-text-is-the-product) run by bash
 * against the real `gsd-tools.cjs` through the workflow's own launcher.
 *
 * Named `gsd-quick-batch-*`: the `quick-batch*` production-module buckets of
 * `scripts/lint-test-file-count.cjs` are at their 2-file cap.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTempDir,
  createTempProject,
  createTempGitProject,
  cleanup,
  readFileNormalized,
  runGsdTools,
} = require('./helpers.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'quick-batch.md');
const STEPS_DIR = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'quick-batch', 'steps');
const BATCH_INIT_PATH = path.join(STEPS_DIR, 'batch-init.md');
const VERIFICATION_WAVE_PATH = path.join(STEPS_DIR, 'verification-wave.md');
const RESEARCH_PHASE_PATH = path.join(STEPS_DIR, 'research-phase.md');

const TASKS = ['- first task', '- second task'].join('\n');

// ─── helpers ──────────────────────────────────────────────────────────────

function writeTasks(dir) {
  const file = path.join(dir, '.planning', 'tasks.md');
  fs.writeFileSync(file, TASKS + '\n');
  return file;
}

function batchesDir(dir) {
  return path.join(dir, '.planning', 'quick-batches');
}

function manifestPath(dir, batchId) {
  return path.join(batchesDir(dir), batchId, 'BATCH.json');
}

function readManifest(dir, batchId) {
  return JSON.parse(fs.readFileSync(manifestPath(dir, batchId), 'utf-8'));
}

/** `quick-batch create` through the real CLI; `options` is the raw `--options` value or undefined. */
function create(dir, options) {
  const args = ['--json-errors', 'quick-batch', 'create', '--file', writeTasks(dir), '--raw'];
  if (options !== undefined) args.push('--options', options);
  return runGsdTools(args, dir);
}

function createOk(dir, options) {
  const r = create(dir, options);
  assert.ok(r.success, `create failed: ${r.error}`);
  return JSON.parse(r.output).batchId;
}

/** The typed `--json-errors` payload of a failed call. */
function errorPayload(r) {
  assert.equal(r.success, false, 'the call must fail');
  const line = r.error.split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, `no JSON error payload on stderr: ${r.error}`);
  return JSON.parse(line);
}

function initQuickBatch(dir, extra) {
  return runGsdTools(['--json-errors', 'query', 'init.quick-batch', ...extra], dir);
}

function initOk(dir, extra) {
  const r = initQuickBatch(dir, extra);
  assert.ok(r.success, `init.quick-batch failed: ${r.error}`);
  return JSON.parse(r.output);
}

/** Hand-edit `BATCH.json` (a user's edit, not a writer). */
function editManifest(dir, batchId, mutate) {
  const m = readManifest(dir, batchId);
  mutate(m);
  fs.writeFileSync(manifestPath(dir, batchId), JSON.stringify(m, null, 2) + '\n');
}

/** Finds the first bash fence in `content` whose text contains every string in `mustInclude`. */
function extractBashFence(filePath, mustInclude) {
  const lines = readFileNormalized(filePath).split('\n');
  for (const fenced of scanFencedBlocks(lines)) {
    if (fenced.closeLineIdx === -1) continue;
    if ((fenced.infoString || '').trim() !== 'bash') continue;
    const block = lines.slice(fenced.openLineIdx + 1, fenced.closeLineIdx).join('\n');
    if (mustInclude.every((s) => block.includes(s))) return block;
  }
  throw new Error(`no bash fence containing ${JSON.stringify(mustInclude)} in ${filePath}`);
}

/**
 * Run shipped workflow bash blocks in one bash process against the real
 * gsd-tools (RUNTIME_DIR points the workflow's own launcher at this checkout).
 * `vars` are the workflow variables the blocks read; `print` names the ones to
 * report back. Returns the reported values plus the process outcome.
 */
function runBlocks(t, cwd, blocks, vars, print) {
  const scriptDir = createTempDir('gsd-6532-script-');
  const home = createTempDir('gsd-6532-home-');
  t.after(() => cleanup(scriptDir));
  t.after(() => cleanup(home));
  const assignments = Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const report = print.map((name) => `printf 'VAR:%s=%s\\n' ${name} "\${${name}-}"`);
  const script = ['#!/usr/bin/env bash', ...assignments, ...blocks, ...report].join('\n');
  const scriptPath = path.join(scriptDir, 'run.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  const r = runHook(scriptPath, [], {
    interpreter: 'bash',
    cwd,
    env: isolatedEnv({ home, override: { RUNTIME_DIR: REPO_ROOT } }),
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
  });
  const values = {};
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^VAR:([A-Z_]+)=(.*)$/.exec(line);
    if (m) values[m[1]] = m[2];
  }
  return { outcome: r.outcome, exitCode: r.exitCode, stderr: r.stderr, values };
}

function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

/** The launcher block that defines `gsd_run` (Step 1 of quick-batch.md). */
function launcherBlock() {
  return extractBashFence(WORKFLOW_PATH, ['gsd_run()', 'RESPONSE_LANGUAGE=']);
}

/** quick-batch.md: the block that runs `init.quick-batch` and sets the mode variables from its result. */
function initModesBlock() {
  return extractBashFence(WORKFLOW_PATH, ['query init.quick-batch', 'VALIDATE_MODE=']);
}

/** Runs quick-batch.md's init+modes block for a resume (or a new batch when `resumeId` is empty). */
function runInitModes(t, dir, { resumeId = '', validate = false, research = false }) {
  return runBlocks(
    t,
    dir,
    [launcherBlock(), initModesBlock(), 'printf \'VAR:SECTIONS=%s\\n\' "$(printf \'%s\' "$INIT" | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).section_manifest.included.join(","))})\')"'],
    {
      RESUME_BATCH_ID: resumeId,
      VALIDATE_PARAM: validate ? '--validate' : '',
      RESEARCH_PARAM: research ? '--research' : '',
      GSD_WS: '',
      // The values parse-args would have set from the invocation's flags.
      VALIDATE_MODE: validate ? 'true' : 'false',
      RESEARCH_MODE: research ? 'true' : 'false',
    },
    ['VALIDATE_MODE', 'RESEARCH_MODE'],
  );
}

// ─── Item 1: create stores options.modes ─────────────────────────────────────

describe('#6532 item 1: quick-batch create stores options.modes', () => {
  for (const modes of [[], ['research'], ['validate'], ['research', 'validate']]) {
    test(`create persists options.modes ${JSON.stringify(modes)}`, (t) => {
      const dir = createTempProject('gsd-6532-create-');
      t.after(() => cleanup(dir));
      const batchId = createOk(dir, JSON.stringify({ modes }));
      assert.deepEqual(readManifest(dir, batchId).options, { modes });
    });
  }

  test('other options keys round-trip verbatim and are not interpreted', (t) => {
    const dir = createTempProject('gsd-6532-other-keys-');
    t.after(() => cleanup(dir));
    const options = { modes: [], validate: true, research: ['x'], note: { nested: 1 } };
    const batchId = createOk(dir, JSON.stringify(options));
    assert.deepEqual(readManifest(dir, batchId).options, options);
    // A mode-like key beside `modes` changes nothing: the stored set is `modes`.
    const init = initOk(dir, ['--resume', batchId]);
    assert.deepEqual(init.modes, []);
    assert.deepEqual(init.section_manifest.included, []);
  });

  test('batch-init.md passes the parsed modes to create (the shipped block, real CLI)', (t) => {
    const dir = createTempGitProject('gsd-6532-batch-init-');
    t.after(() => cleanup(dir));
    const tasks = writeTasks(dir);
    for (const [validate, research, expected] of [
      [true, false, ['validate']],
      [false, true, ['research']],
      [true, true, ['research', 'validate']],
      [false, false, []],
    ]) {
      const res = runBlocks(
        t,
        dir,
        [
          extractBashFence(BATCH_INIT_PATH, ['QB_OPTIONS_JSON=']),
          extractBashFence(BATCH_INIT_PATH, ['quick-batch create --file "$TASK_FILE"', 'gsd_run()']),
          'printf \'VAR:BATCH=%s\\n\' "$(printf \'%s\' "$QB_CREATE_JSON" | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).batchId)})\')"',
        ],
        { TASK_FILE: tasks, VALIDATE_MODE: String(validate), RESEARCH_MODE: String(research) },
        [],
      );
      assert.equal(res.outcome, OUTCOME.EXITED, res.stderr);
      assert.equal(res.exitCode, 0, res.stderr);
      assert.ok(res.values.BATCH, `no batch id reported: ${res.stderr}`);
      assert.deepEqual(readManifest(dir, res.values.BATCH).options, { modes: expected });
    }
  });
});

// ─── Item 2: invalid values ──────────────────────────────────────────────────

const INVALID_MODES = [
  ['a string', '"validate"'],
  ['null', 'null'],
  ['an object', '{}'],
  ['a number', '1'],
  ['an unknown string', '["bogus"]'],
  ['a non-string entry', '[1]'],
  ['a nested array', '[["validate"]]'],
  ['a duplicate', '["validate","validate"]'],
  ['the wrong order', '["validate","research"]'],
  ['a padded string', '[" validate"]'],
  ['an empty string', '[""]'],
  ['a different case', '["Validate"]'],
  ['a shell payload', '["$(touch pwned)"]'],
];

describe('#6532 item 2: create refuses an invalid options.modes and creates nothing', () => {
  for (const [label, value] of INVALID_MODES) {
    test(`refuses ${label}`, (t) => {
      const dir = createTempProject('gsd-6532-invalid-');
      t.after(() => cleanup(dir));
      const r = create(dir, `{"modes":${value},"note":"kept"}`);
      const payload = errorPayload(r);
      assert.equal(payload.reason, 'usage');
      assert.equal(payload.field, 'options.modes');
      assert.equal(fs.existsSync(batchesDir(dir)), false, 'no batch may be written');
      assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, 'no value is executed');
    });
  }

  test('a create without --options stores no modes (unknown, today\'s behavior)', (t) => {
    const dir = createTempProject('gsd-6532-no-options-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(readManifest(dir, batchId).options, 'modes'), false);
  });
});

describe('#6532 item 2: a loaded batch with an invalid options.modes fails closed', () => {
  for (const [label, value] of INVALID_MODES) {
    test(`a hand-edited ${label} fails resume and init --resume, naming the field, file untouched`, (t) => {
      const dir = createTempProject('gsd-6532-corrupt-');
      t.after(() => cleanup(dir));
      const batchId = createOk(dir, '{"modes":["validate"]}');
      editManifest(dir, batchId, (m) => { m.options.modes = JSON.parse(value); });
      const before = fs.readFileSync(manifestPath(dir, batchId));

      const resume = errorPayload(runGsdTools(['--json-errors', 'quick-batch', 'resume', '--batch', batchId], dir));
      assert.equal(resume.field, 'options.modes');
      const update = errorPayload(runGsdTools(['--json-errors', 'quick-batch', 'update', '--batch', batchId, '--updates', '[]'], dir));
      assert.equal(update.field, 'options.modes');
      const init = errorPayload(initQuickBatch(dir, ['--resume', batchId]));
      assert.equal(init.field, 'options.modes');

      assert.deepEqual(fs.readFileSync(manifestPath(dir, batchId)), before, 'core never rewrites or drops the field');
    });
  }
});

// ─── Items 3-5: init.quick-batch --resume uses the stored modes ──────────────

describe('#6532 items 3-5: init.quick-batch --resume builds the manifest and variables from the stored modes', () => {
  test('a --validate batch resumed with no mode flags loads verification-wave and sets VALIDATE_MODE', (t) => {
    const dir = createTempProject('gsd-6532-resume-validate-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, '{"modes":["validate"]}');

    const init = initOk(dir, ['--resume', batchId]);
    assert.deepEqual(init.modes, ['validate']);
    assert.ok(init.section_manifest.included.includes('verification-wave'));
    assert.equal(init.section_manifest.included.includes('research-phase'), false);

    const res = runInitModes(t, dir, { resumeId: batchId });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.values.VALIDATE_MODE, 'true');
    assert.equal(res.values.RESEARCH_MODE, 'false');
    assert.deepEqual(res.values.SECTIONS.split(','), ['verification-wave']);
  });

  test('the loaded verification-wave step runs on VALIDATE_MODE alone (the gate the variable opens)', () => {
    // The step file's gate is the shipped text the model follows.
    const gate = readFileNormalized(VERIFICATION_WAVE_PATH).split('\n').slice(0, 4).join('\n');
    assert.ok(gate.includes('Skip this step entirely if NOT `$VALIDATE_MODE`.'));
    const researchGate = readFileNormalized(RESEARCH_PHASE_PATH).split('\n').slice(0, 4).join('\n');
    assert.ok(researchGate.includes('Skip this step entirely if NOT `$RESEARCH_MODE`.'));
  });

  test('a --research --validate batch resumed with no flags restores both', (t) => {
    const dir = createTempProject('gsd-6532-resume-both-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, '{"modes":["research","validate"]}');
    const res = runInitModes(t, dir, { resumeId: batchId });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.values.VALIDATE_MODE, 'true');
    assert.equal(res.values.RESEARCH_MODE, 'true');
    assert.deepEqual(res.values.SECTIONS.split(',').sort(), ['research-phase', 'verification-wave']);
  });

  test('a batch created without modes ([]) resumed with no flags runs neither', (t) => {
    const dir = createTempProject('gsd-6532-resume-none-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, '{"modes":[]}');
    const res = runInitModes(t, dir, { resumeId: batchId });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.values.VALIDATE_MODE, 'false');
    assert.equal(res.values.RESEARCH_MODE, 'false');
    assert.equal(res.values.SECTIONS, '');
  });

  test('flags equal to the stored set are accepted', (t) => {
    const dir = createTempProject('gsd-6532-resume-equal-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, '{"modes":["research","validate"]}');
    const init = initOk(dir, ['--resume', batchId, '--validate', '--research']);
    assert.deepEqual(init.modes, ['research', 'validate']);
  });
});

// ─── Item 4: a resume whose flags differ is refused ──────────────────────────

describe('#6532 item 4: a resume whose mode flags differ from the stored set is refused', () => {
  const cases = [
    ['a subset', ['research', 'validate'], ['--validate']],
    ['a superset', ['validate'], ['--validate', '--research']],
    ['a different set', ['validate'], ['--research']],
    ['any flag on an empty stored set', [], ['--validate']],
  ];
  for (const [label, stored, flags] of cases) {
    test(`refuses ${label}, naming the stored set`, (t) => {
      const dir = createTempProject('gsd-6532-mismatch-');
      t.after(() => cleanup(dir));
      const batchId = createOk(dir, JSON.stringify({ modes: stored }));
      const before = fs.readFileSync(manifestPath(dir, batchId));

      const payload = errorPayload(initQuickBatch(dir, ['--resume', batchId, ...flags]));
      assert.equal(payload.reason, 'usage');
      assert.equal(payload.field, 'options.modes');
      assert.deepEqual(payload.stored_modes, stored);
      assert.deepEqual(payload.given_modes, flags.map((f) => f.slice(2)).sort());

      const res = runInitModes(t, dir, {
        resumeId: batchId,
        validate: flags.includes('--validate'),
        research: flags.includes('--research'),
      });
      assert.notEqual(res.exitCode, 0, 'the workflow block stops on the refusal');
      assert.equal(res.values.SECTIONS, undefined, 'nothing after the refusal runs');
      assert.deepEqual(fs.readFileSync(manifestPath(dir, batchId)), before);
    });
  }
});

// ─── Item 8: batches with unknown modes keep today's behavior ───────────────

describe('#6532: a batch without options.modes keeps the flag-derived manifest and variables', () => {
  test('no flags: nothing loaded; --validate: verification loaded', (t) => {
    const dir = createTempProject('gsd-6532-legacy-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, undefined);

    const plain = runInitModes(t, dir, { resumeId: batchId });
    assert.equal(plain.exitCode, 0, plain.stderr);
    assert.equal(plain.values.VALIDATE_MODE, 'false');
    assert.equal(plain.values.SECTIONS, '');

    const validate = runInitModes(t, dir, { resumeId: batchId, validate: true });
    assert.equal(validate.exitCode, 0, validate.stderr);
    assert.equal(validate.values.VALIDATE_MODE, 'true');
    assert.deepEqual(validate.values.SECTIONS.split(','), ['verification-wave']);
  });

  test('a legacy batch whose options hold other keys is still legacy', (t) => {
    const dir = createTempProject('gsd-6532-legacy-keys-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, '{"note":"x"}');
    assert.deepEqual(initOk(dir, ['--resume', batchId, '--research']).modes, ['research']);
  });

  test('writers keep options verbatim: an absent modes key stays absent, a stored one stays', (t) => {
    const dir = createTempProject('gsd-6532-roundtrip-');
    t.after(() => cleanup(dir));
    const legacy = createOk(dir, '{"note":"x"}');
    const stored = createOk(dir, '{"modes":["validate"],"note":"y"}');
    for (const batchId of [legacy, stored]) {
      const before = readManifest(dir, batchId).options;
      assert.ok(runGsdTools(['quick-batch', 'update', '--batch', batchId, '--updates', '[]', '--head-revision', 'abc123'], dir).success);
      assert.ok(runGsdTools(['quick-batch', 'resume', '--batch', batchId], dir).success);
      assert.deepEqual(readManifest(dir, batchId).options, before);
    }
  });
});

// ─── A new batch (no --resume) ───────────────────────────────────────────────

describe('#6532: init.quick-batch without --resume is flag-derived and reports the modes', () => {
  for (const [flags, modes] of [[[], []], [['--validate'], ['validate']], [['--research', '--validate'], ['research', 'validate']]]) {
    test(`flags ${JSON.stringify(flags)} -> modes ${JSON.stringify(modes)}`, (t) => {
      const dir = createTempProject('gsd-6532-new-');
      t.after(() => cleanup(dir));
      const init = initOk(dir, flags);
      assert.deepEqual(init.modes, modes);
      const res = runInitModes(t, dir, { validate: flags.includes('--validate'), research: flags.includes('--research') });
      assert.equal(res.exitCode, 0, res.stderr);
      assert.equal(res.values.VALIDATE_MODE, String(modes.includes('validate')));
      assert.equal(res.values.RESEARCH_MODE, String(modes.includes('research')));
    });
  }
});

// ─── CLI negative matrix for --resume ───────────────────────────────────────

describe('#6532: init.quick-batch --resume negative inputs', () => {
  const cases = [
    ['no value', ['--resume']],
    ['a flag as value', ['--resume', '--validate']],
    ['an empty value', ['--resume', '']],
    ['a whitespace value', ['--resume', '   ']],
    ['an unknown batch id', ['--resume', '260101-zzz']],
    ['a path traversal', ['--resume', '../../x']],
    ['a shell payload', ['--resume', '$(touch pwned);x']],
    ['an eq form', ['--resume=abc']],
    ['a very long id', ['--resume', 'a'.repeat(5000)]],
    ['a unicode id', ['--resume', 'bätch']],
  ];
  for (const [label, argv] of cases) {
    test(`refuses ${label}`, (t) => {
      const dir = createTempProject('gsd-6532-neg-');
      t.after(() => cleanup(dir));
      const payload = errorPayload(initQuickBatch(dir, argv));
      assert.equal(payload.reason, 'usage');
      assert.equal(fs.existsSync(batchesDir(dir)), false);
      assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
    });
  }

  test('refuses --resume given twice', (t) => {
    const dir = createTempProject('gsd-6532-dup-');
    t.after(() => cleanup(dir));
    const a = createOk(dir, '{"modes":["validate"]}');
    const b = createOk(dir, '{"modes":[]}');
    const payload = errorPayload(initQuickBatch(dir, ['--resume', a, '--resume', b]));
    assert.equal(payload.reason, 'usage');
  });

  test('the workflow block passes a hostile resume id as one argument, never to the shell', (t) => {
    const dir = createTempProject('gsd-6532-hostile-');
    t.after(() => cleanup(dir));
    const res = runInitModes(t, dir, { resumeId: 'x $(touch pwned) ; touch pwned2' });
    assert.notEqual(res.exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(dir, 'pwned2')), false);
  });
});
