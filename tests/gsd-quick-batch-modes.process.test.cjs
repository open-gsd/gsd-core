'use strict';

/**
 * gsd-quick-batch-modes.process.test.cjs — #6532: the shipped quick-batch
 * workflow bash blocks, run by a real bash. These rows spawn bash on purpose:
 * their subject is what the blocks of `quick-batch.md` and
 * `quick-batch/steps/batch-init.md` (source-text-is-the-product) do when a
 * shell runs them against the real `gsd-tools.cjs` through the workflow's own
 * launcher: the variables they set, the `--options` they pass, and the exit
 * status they stop on. The CLI verbs themselves are tested in-process in
 * tests/gsd-quick-batch-modes.test.cjs.
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
} = require('./helpers.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { writeTasks, manifestPath, readManifest, createOk } = require('./helpers/quick-batch-modes.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'quick-batch.md');
const BATCH_INIT_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'quick-batch', 'steps', 'batch-init.md');

// ─── helpers ──────────────────────────────────────────────────────────────

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

function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
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
  fs.writeFileSync(scriptPath, script);
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

// ─── Item 1: batch-init.md passes the modes to create ───────────────────────

describe('#6532 item 1, real bash (the shipped batch-init.md blocks run by a shell): create gets the parsed modes', () => {
  test('batch-init.md passes the parsed modes to create', (t) => {
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

// ─── Items 3-5: the resume block sets the variables from the stored modes ───

describe('#6532 items 3-5, real bash (the shipped quick-batch.md init block run by a shell): a resume sets the mode variables from the stored modes', () => {
  test('a --validate batch resumed with no mode flags sets VALIDATE_MODE and loads verification-wave', (t) => {
    const dir = createTempProject('gsd-6532-resume-validate-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, '{"modes":["validate"]}');
    const res = runInitModes(t, dir, { resumeId: batchId });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.values.VALIDATE_MODE, 'true');
    assert.equal(res.values.RESEARCH_MODE, 'false');
    assert.deepEqual(res.values.SECTIONS.split(','), ['verification-wave']);
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
});

// ─── Item 4: the block stops on a refused resume ────────────────────────────

describe('#6532 item 4, real bash (the exit status of the shipped init block run by a shell): a resume whose flags differ stops the block', () => {
  const cases = [
    ['a subset', ['research', 'validate'], ['--validate']],
    ['a superset', ['validate'], ['--validate', '--research']],
    ['a different set', ['validate'], ['--research']],
    ['any flag on an empty stored set', [], ['--validate']],
  ];
  for (const [label, stored, flags] of cases) {
    test(`stops on ${label}, running nothing after the refusal`, (t) => {
      const dir = createTempProject('gsd-6532-mismatch-');
      t.after(() => cleanup(dir));
      const batchId = createOk(dir, JSON.stringify({ modes: stored }));
      const before = fs.readFileSync(manifestPath(dir, batchId));
      const res = runInitModes(t, dir, {
        resumeId: batchId,
        validate: flags.includes('--validate'),
        research: flags.includes('--research'),
      });
      assert.equal(res.outcome, OUTCOME.EXITED, res.stderr);
      assert.equal(res.exitCode, 1, 'the workflow block stops on the refusal');
      assert.equal(res.values.SECTIONS, undefined, 'nothing after the refusal runs');
      assert.deepEqual(fs.readFileSync(manifestPath(dir, batchId)), before);
    });
  }
});

// ─── Item 8: batches without stored modes keep the flag-derived variables ──

describe('#6532, real bash (the shipped init block run by a shell): a batch without options.modes keeps the flag-derived variables', () => {
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
});

// ─── A new batch (no --resume) ───────────────────────────────────────────────

describe('#6532, real bash (the shipped init block run by a shell): a new batch sets the variables from its flags', () => {
  for (const [flags, modes] of [[[], []], [['--validate'], ['validate']], [['--research', '--validate'], ['research', 'validate']]]) {
    test(`flags ${JSON.stringify(flags)} -> modes ${JSON.stringify(modes)}`, (t) => {
      const dir = createTempProject('gsd-6532-new-');
      t.after(() => cleanup(dir));
      const res = runInitModes(t, dir, { validate: flags.includes('--validate'), research: flags.includes('--research') });
      assert.equal(res.exitCode, 0, res.stderr);
      assert.equal(res.values.VALIDATE_MODE, String(modes.includes('validate')));
      assert.equal(res.values.RESEARCH_MODE, String(modes.includes('research')));
    });
  }
});

// ─── A hostile resume id ─────────────────────────────────────────────────────

describe('#6532, real bash (shell quoting of the shipped init block is the subject): a hostile resume id', () => {
  test('the workflow block passes a hostile resume id as one argument, never to the shell', (t) => {
    const dir = createTempProject('gsd-6532-hostile-');
    t.after(() => cleanup(dir));
    const res = runInitModes(t, dir, { resumeId: 'x $(touch pwned) ; touch pwned2' });
    assert.equal(res.outcome, OUTCOME.EXITED, res.stderr);
    assert.equal(res.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(dir, 'pwned2')), false);
  });
});
