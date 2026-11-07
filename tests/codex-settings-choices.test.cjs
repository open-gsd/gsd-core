'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const catalog = require('../gsd-core/bin/shared/model-catalog.json');
const { runGsdTools, createTempDir, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');

test('#5591 catalog contains the seven approved display choices and registered IDs', () => {
  assert.deepEqual(catalog.codexModelChoices, [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol (current)', description: 'Latest workhorse model for coding and everyday work' },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier model for the most demanding work' },
    { id: 'gpt-6-sol', name: 'GPT-6-Sol', description: 'Previous generation workhorse model' },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Older generation workhorse model' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', description: 'Older fast and efficient model' },
  ]);
  const choiceIds = catalog.codexModelChoices.map(({ id }) => id).sort();
  const effortIds = Object.keys(catalog.codexModelEffort).filter((id) => id !== '_baseline').sort();
  assert.deepEqual(choiceIds, effortIds, 'the display choices and registered Codex effort IDs stay in sync');
});

test('#5591 workflow reads catalog choices and maps selections back to IDs', () => {
  const advanced = fs.readFileSync(path.join(root, 'gsd-core/workflows/settings-advanced.md'), 'utf8');
  assert.match(advanced, /codexModelChoices/);
  assert.match(advanced, /gsd_run query codex-model-choices/);
  assert.match(advanced, /Map a catalog choice back to its `id`/);
});

test('#5591 choices query works outside a project without changing files', (t) => {
  const dir = createTempDir('gsd-codex-choices-');
  t.after(() => cleanup(dir));
  const before = fs.readdirSync(dir);
  for (const flags of [[], ['--raw'], ['--pick', 'choices[0].id']]) {
    const r = runGsdTools(['query', 'codex-model-choices', ...flags], dir, { HOME: dir });
    assert.equal(r.exitCode, 0, r.error);
    if (flags.includes('--pick')) {
      assert.equal(r.output, catalog.codexModelChoices[0].id);
    } else {
      assert.deepEqual(JSON.parse(r.output), { choices: catalog.codexModelChoices });
    }
  }
  assert.deepEqual(fs.readdirSync(dir), before);
});

test('#5591 choices query rejects unexpected arguments without side effects', (t) => {
  const dir = createTempDir('gsd-codex-choices-invalid-');
  t.after(() => cleanup(dir));
  const before = fs.readdirSync(dir);
  const invalid = [
    ['extra'], [''], ['   '], ['--unknown'], ['--unknown', '--unknown'],
    ['--model='], ['--model==value'], ['--model', '--weird'],
    ['x'.repeat(4096)], ['模型'], ['; touch marker'], ['$(touch marker)'],
    ['`touch marker`'], ['&&'], ['"quoted"'],
  ];
  for (const args of invalid) {
    const r = runGsdTools(['query', 'codex-model-choices', ...args, '--json-errors'], dir, { HOME: dir });
    assert.equal(r.exitCode, 1);
    assert.equal(r.output, '');
    const diagnostic = JSON.parse(r.error);
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.reason, ERROR_REASON.USAGE);
    assert.doesNotMatch(r.error, /\n\s+at\s/);
  }
  assert.deepEqual(fs.readdirSync(dir), before);
});

test('#5591 PATH-only launcher can query choices without a sibling catalog', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX launcher layout; direct query tests run on every platform');
    return;
  }
  const dir = createTempDir('gsd-codex-choices-path-');
  t.after(() => cleanup(dir));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const shim = path.join(binDir, 'gsd_run');
  fs.symlinkSync(path.join(root, 'gsd-core', 'bin', 'gsd_run'), shim);
  const advanced = fs.readFileSync(path.join(root, 'gsd-core/workflows/settings-advanced.md'), 'utf8');
  const launcher = advanced.split('\n').find((line) => line.startsWith('_GSD_SHIM_NAME='));
  assert.ok(launcher, 'exercise the workflow launcher, including its PATH branch');
  const harness = path.join(dir, 'harness.sh');
  fs.writeFileSync(harness, [
    launcher,
    '[ "$GSD_TOOLS" = "$EXPECTED_SHIM" ] || exit 91',
    'gsd_run query codex-model-choices',
  ].join('\n'));
  const r = runHook(harness, [], {
    interpreter: '/bin/sh', cwd: dir, timeoutMs: PROBE_TIMEOUT_MS,
    env: { ...TEST_ENV_BASE, HOME: dir, RUNTIME_DIR: dir,
      EXPECTED_SHIM: shim, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { choices: catalog.codexModelChoices });
  assert.equal(fs.existsSync(path.join(binDir, 'shared')), false);
  assert.equal(fs.existsSync(path.join(dir, '.planning')), false);
});
