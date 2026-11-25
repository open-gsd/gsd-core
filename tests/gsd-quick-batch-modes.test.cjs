'use strict';

/**
 * gsd-quick-batch-modes.test.cjs — #6532: a quick-batch stores its modes at
 * `quick-batch create` (`options.modes`) and every `init.quick-batch --resume`
 * uses them (items 1-6 and their acceptance criteria; item 7, the completion
 * condition, waits for #6531 and is not covered here).
 *
 * The verbs run in-process through `runGsdTools`, and the mode rules are
 * checked directly as properties. The shipped workflow bash blocks, run by a
 * real bash, are in tests/gsd-quick-batch-modes.process.test.cjs; the step
 * files' mode gates are the `quick-batch-mode-gates` text contract.
 *
 * Named `gsd-quick-batch-*`: the `quick-batch*` production-module buckets of
 * `scripts/lint-test-file-count.cjs` are at their 2-file cap.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const {
  writeTasks,
  batchesDir,
  manifestPath,
  readManifest,
  create,
  createOk,
} = require('./helpers/quick-batch-modes.cjs');
const quickBatch = require('../gsd-core/bin/lib/quick-batch.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────

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

/** Every path under `.planning/`, with each file's bytes, so a row can show that nothing was written. */
function planningSnapshot(dir) {
  const root = path.join(dir, '.planning');
  const entries = [];
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const abs = path.join(root, rel);
    entries.push([rel, fs.statSync(abs).isFile() ? fs.readFileSync(abs).toString('base64') : 'dir']);
  }
  return entries;
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

// ─── A non-object options value ─────────────────────────────────────────────

const NON_OBJECT_OPTIONS = [
  ['an array', '[1]', [1]],
  ['a string', '"x"', 'x'],
  ['a number', '5', 5],
  ['a boolean', 'true', true],
];

describe('create refuses an options value that is not a JSON object and writes nothing', () => {
  for (const [label, raw] of NON_OBJECT_OPTIONS) {
    test(`quick-batch create --options ${raw} (${label}) fails, with no batch and no quick id allocated`, (t) => {
      const dir = createTempProject('gsd-6532-options-shape-');
      t.after(() => cleanup(dir));
      const tasks = writeTasks(dir);
      const before = planningSnapshot(dir);
      // The refusal comes from the router (#6655) or from createBatch: a usage error either way,
      // with a field only from createBatch, so the field is not asserted here.
      const r = runGsdTools(['--json-errors', 'quick-batch', 'create', '--file', tasks, '--options', raw, '--raw'], dir);
      assert.equal(errorPayload(r).reason, 'usage');
      assert.equal(r.exitCode, 1);
      assert.equal(fs.existsSync(batchesDir(dir)), false, 'no batch directory');
      assert.deepEqual(planningSnapshot(dir), before, 'nothing under .planning/ changed');
    });
  }

  test('createBatch itself refuses a non-object batchOptions, naming options, before any write', (t) => {
    const dir = createTempProject('gsd-6532-options-direct-');
    t.after(() => cleanup(dir));
    const before = planningSnapshot(dir);
    // A programmatic caller can also pass a class instance, which does not serialize to the object it holds.
    for (const value of [...NON_OBJECT_OPTIONS.map(([, , v]) => v), new Date(0), new Map([['modes', []]])]) {
      const r = quickBatch.createBatch(dir, [{ description: 'a' }], { batchOptions: value });
      assert.equal(r.ok, false, String(value));
      assert.equal(r.field, 'options');
    }
    assert.deepEqual(planningSnapshot(dir), before);
  });

  test('createBatch judges options by what BATCH.json would hold, so a toJSON or an unserializable value cannot slip through', (t) => {
    const dir = createTempProject('gsd-6532-options-tojson-');
    t.after(() => cleanup(dir));
    const before = planningSnapshot(dir);
    for (const [value, field] of [
      [{ toJSON: () => [1] }, 'options'],
      [{ note: 1n }, 'options'],
      [{ modes: Object.assign(['validate'], { toJSON: () => 'x' }) }, 'options.modes'],
    ]) {
      const r = quickBatch.createBatch(dir, [{ description: 'a' }], { batchOptions: value });
      assert.equal(r.ok, false);
      assert.equal(r.field, field);
    }
    assert.deepEqual(planningSnapshot(dir), before);

    // What is written is what was judged: a value JSON drops (undefined) is not kept, and the batch loads.
    const r = quickBatch.createBatch(dir, [{ description: 'a' }], { batchOptions: { note: 'x', gone: undefined } });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.value.manifest.options, { note: 'x' });
    assert.equal(quickBatch.loadBatch(dir, r.value.batchId).ok, true);
  });

  test('createBatch still stores no options (undefined or null) as {}, and a prototype-less object as itself', (t) => {
    const dir = createTempProject('gsd-6532-options-null-');
    t.after(() => cleanup(dir));
    for (const value of [undefined, null]) {
      const r = quickBatch.createBatch(dir, [{ description: 'a' }], { batchOptions: value });
      assert.equal(r.ok, true, r.reason);
      assert.deepEqual(readManifest(dir, r.value.batchId).options, {});
    }
    const bare = Object.assign(Object.create(null), { note: 'x' });
    const r = quickBatch.createBatch(dir, [{ description: 'a' }], { batchOptions: bare });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(readManifest(dir, r.value.batchId).options, { note: 'x' });
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

// ─── The mode rules as properties ───────────────────────────────────────────

const MODES = ['research', 'validate'];
const VALID_MODE_SETS = [[], ['research'], ['validate'], ['research', 'validate']];
const isValidModeSet = (a) => VALID_MODE_SETS.some((set) => JSON.stringify(set) === JSON.stringify(a));
const sameSet = (a, b) => a.length === b.length && a.every((m) => b.includes(m));
const modeArrays = fc.array(fc.constantFrom('research', 'validate', 'bogus'), { maxLength: 5 });
// The flag sets a caller passes: init normalizes the parsed flags to canonical order (src/init.cts).
const flagSets = fc.subarray(MODES);

describe('#6532: the mode rules hold for arbitrary mode arrays', () => {
  test('validateBatchModes accepts exactly the strictly increasing subsequences of [research, validate]', () => {
    // Every valid set and the near misses run as examples, so a seed cannot leave the accept side unexercised.
    const examples = [...VALID_MODE_SETS, ['validate', 'research'], ['research', 'research'], ['bogus']].map((a) => [a]);
    fc.assert(fc.property(modeArrays, (a) => {
      const r = quickBatch.validateBatchModes(a);
      assert.equal(r.ok, isValidModeSet(a), JSON.stringify(a));
      if (r.ok) assert.deepEqual(r.value, a);
    }), { examples });
  });

  describe('resolveBatchModes accepts a flag set exactly when it is empty or equal to the stored set', () => {
    let dir;
    const batches = [];

    before(() => {
      dir = createTempProject('gsd-6532-property-');
      for (const stored of VALID_MODE_SETS) batches.push({ stored, batchId: createOk(dir, JSON.stringify({ modes: stored })) });
      batches.push({ stored: null, batchId: createOk(dir, '{"note":"no modes"}') });
    });

    after(() => cleanup(dir));

    test('every stored set against every flag set, and a batch without stored modes (exhaustive)', () => {
      // The domain is 5 batches x 4 flag sets, and every pair runs as an example. The flag sets are canonical
      // because init normalizes the parsed flags; the 'flags equal to the stored set' row passes them reversed.
      const examples = batches.flatMap((_, i) => VALID_MODE_SETS.map((flags) => [i, flags]));
      fc.assert(fc.property(fc.integer({ min: 0, max: VALID_MODE_SETS.length }), flagSets, (i, flags) => {
        const { stored, batchId } = batches[i];
        const r = quickBatch.resolveBatchModes(dir, batchId, flags);
        if (stored === null) {
          assert.deepEqual(r, { ok: true, value: { modes: flags, stored: false } });
          return;
        }
        const accept = flags.length === 0 || sameSet(flags, stored);
        assert.equal(r.ok, accept, `stored ${JSON.stringify(stored)}, flags ${JSON.stringify(flags)}`);
        if (accept) assert.deepEqual(r.value, { modes: stored, stored: true });
        else assert.equal(r.field, 'options.modes');
      }), { examples });
    });
  });
});

// ─── Items 3-5: init.quick-batch --resume uses the stored modes ──────────────

describe('#6532 items 3-5: init.quick-batch --resume builds the manifest from the stored modes', () => {
  test('a --validate batch resumed with no mode flags loads verification-wave', (t) => {
    const dir = createTempProject('gsd-6532-resume-validate-');
    t.after(() => cleanup(dir));
    const batchId = createOk(dir, '{"modes":["validate"]}');

    const init = initOk(dir, ['--resume', batchId]);
    assert.deepEqual(init.modes, ['validate']);
    assert.ok(init.section_manifest.included.includes('verification-wave'));
    assert.equal(init.section_manifest.included.includes('research-phase'), false);
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
      assert.deepEqual(fs.readFileSync(manifestPath(dir, batchId)), before);
    });
  }
});

// ─── Item 8: batches with unknown modes keep today's behavior ───────────────

describe('#6532: a batch without options.modes keeps the flag-derived manifest', () => {
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
      assert.deepEqual(initOk(dir, flags).modes, modes);
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
});
