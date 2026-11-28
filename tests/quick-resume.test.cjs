'use strict';

/**
 * #6530 (part 1): `init.quick --resume <slug>` returns the task's own quick id,
 * slug and task directory, never a new one, and writes nothing.
 *
 * Every case drives the real CLI (`gsd-tools init quick ...`) through
 * `runGsdTools`; failures are asserted on the typed `--json-errors` payload,
 * never on prose. The spawned-binary cases live in
 * tests/quick-resume.process.test.cjs.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup, toPosixPath } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { resolveQuickResume, splitQuickResumeArgs } = require('../gsd-core/bin/lib/quick-resume.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const PINNED_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z

function quickRoot(dir, ...ws) {
  return ws.length
    ? path.join(dir, '.planning', 'workstreams', ws[0], 'quick')
    : path.join(dir, '.planning', 'quick');
}

function makeTask(dir, name, files = {}, root = quickRoot(dir)) {
  const taskDir = path.join(root, name);
  fs.mkdirSync(taskDir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(taskDir, file), content);
  }
  return taskDir;
}

/** Every path under the fixture with its size and mtime: proof that a call wrote nothing. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)}|${e.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function clockEnv(ms) {
  return { GSD_TEST_MODE: '1', GSD_NOW_MS: String(ms), TZ: 'UTC' };
}

function initQuick(dir, args, env = {}) {
  return runGsdTools(['init', 'quick', ...args], dir, env);
}

function okJson(result) {
  assert.ok(result.success, `command failed: ${result.error}`);
  return JSON.parse(result.output);
}

/** The typed `--json-errors` payload of a failed call. */
function failure(dir, args, env = {}) {
  const result = runGsdTools(['init', 'quick', ...args, '--json-errors'], dir, env);
  assert.equal(result.success, false, `expected a failure, got: ${result.output}`);
  assert.equal(result.exitCode, 1);
  return JSON.parse(result.error.trim().split('\n').pop());
}

describe('#6530 init.quick --resume keeps the task\'s quick id and slug', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-quick-resume-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns the existing quick id, slug and task directory and writes nothing', () => {
    const taskDir = makeTask(tmpDir, '260101-abc-fix-login', { '260101-abc-PLAN.md': '# plan\n' });
    const before = snapshot(tmpDir);

    const out = okJson(initQuick(tmpDir, ['--resume', 'fix-login'], clockEnv(PINNED_MS)));

    assert.equal(out.quick_id, '260101-abc');
    assert.equal(out.slug, 'fix-login');
    assert.equal(out.task_dir, toPosixPath(taskDir));
    assert.equal(out.legacy, false);
    assert.equal(out.description, null);
    assert.deepEqual(out.resume, { has_plan: true, has_summary: false, state_row: false });
    assert.deepEqual(snapshot(tmpDir), before, 'init.quick --resume must not write anything');
  });

  test('the id does not depend on the clock: calls days apart return the directory\'s id', () => {
    makeTask(tmpDir, '260101-abc-fix-login');
    const first = okJson(initQuick(tmpDir, ['--resume', 'fix-login'], clockEnv(PINNED_MS)));
    const later = okJson(initQuick(tmpDir, ['--resume', 'fix-login'], clockEnv(PINNED_MS + 3 * DAY_MS + 7000)));
    assert.equal(first.quick_id, '260101-abc');
    assert.equal(later.quick_id, '260101-abc');
    // Control: a first run at the same instant mints a clock id, which is not the task's.
    const fresh = okJson(initQuick(tmpDir, ['some', 'task'], clockEnv(PINNED_MS)));
    assert.notEqual(fresh.quick_id, '260101-abc');
  });

  test('--resume=<slug> is the same request as --resume <slug>', () => {
    makeTask(tmpDir, '260101-abc-fix-login');
    const spaced = okJson(initQuick(tmpDir, ['--resume', 'fix-login']));
    const eq = okJson(initQuick(tmpDir, ['--resume=fix-login']));
    assert.equal(spaced.quick_id, '260101-abc');
    assert.equal(eq.quick_id, '260101-abc');
    assert.equal(eq.task_dir, spaced.task_dir);
  });

  test('matches the whole slug: a slug that is a suffix of another task\'s slug finds only its own task', () => {
    const own = makeTask(tmpDir, '260101-abc-fix-login');
    const other = makeTask(tmpDir, '260102-def-other-fix-login');
    const a = okJson(initQuick(tmpDir, ['--resume', 'fix-login']));
    const b = okJson(initQuick(tmpDir, ['--resume', 'other-fix-login']));
    assert.equal(a.task_dir, toPosixPath(own));
    assert.equal(b.task_dir, toPosixPath(other));
    assert.equal(b.quick_id, '260102-def');
  });

  test('a slug that matches two task directories is refused and both are listed', () => {
    makeTask(tmpDir, '260102-def-fix-login');
    makeTask(tmpDir, '260101-abc-fix-login');
    const before = snapshot(tmpDir);
    const err = failure(tmpDir, ['--resume', 'fix-login']);
    assert.equal(err.reason, 'quick_resume_ambiguous');
    assert.deepEqual(err.matches, ['260101-abc-fix-login', '260102-def-fix-login']);
    assert.deepEqual(snapshot(tmpDir), before);
  });

  test('a current and a legacy directory with the same slug are ambiguous too', () => {
    makeTask(tmpDir, '260101-abc-fix-login');
    makeTask(tmpDir, '20250101-fix-login');
    const err = failure(tmpDir, ['--resume', 'fix-login']);
    assert.equal(err.reason, 'quick_resume_ambiguous');
    assert.deepEqual(err.matches, ['20250101-fix-login', '260101-abc-fix-login']);
  });

  test('a legacy YYYYMMDD-<slug> directory matches with quick_id null and legacy true', () => {
    const taskDir = makeTask(tmpDir, '20250101-fix-login', { 'PLAN.md': '# plan\n', 'SUMMARY.md': '---\nstatus: complete\n---\n' });
    const out = okJson(initQuick(tmpDir, ['--resume', 'fix-login'], clockEnv(PINNED_MS)));
    assert.equal(out.quick_id, null);
    assert.equal(out.legacy, true);
    assert.equal(out.slug, 'fix-login');
    assert.equal(out.task_dir, toPosixPath(taskDir));
    assert.deepEqual(out.resume, { has_plan: true, has_summary: true, state_row: false });
  });

  test('branch_name is built from the task\'s own id (and a legacy directory\'s date prefix), not the clock', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ quick_branch_template: 'gsd/quick-{quick}-{slug}' }),
    );
    makeTask(tmpDir, '260101-abc-fix-login');
    makeTask(tmpDir, '20250101-old-task');
    const current = okJson(initQuick(tmpDir, ['--resume', 'fix-login'], clockEnv(PINNED_MS)));
    const legacy = okJson(initQuick(tmpDir, ['--resume', 'old-task'], clockEnv(PINNED_MS)));
    assert.equal(current.branch_name, 'gsd/quick-260101-abc-fix-login');
    assert.equal(legacy.branch_name, 'gsd/quick-20250101-old-task');
  });

  test('has_summary and state_row report the task\'s summary file and STATE.md row', () => {
    makeTask(tmpDir, '260101-abc-fix-login', {
      '260101-abc-PLAN.md': '# plan\n',
      '260101-abc-SUMMARY.md': '---\nstatus: complete\n---\n',
    });
    makeTask(tmpDir, '260102-def-other');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '# STATE',
      '',
      '## Quick Tasks Completed',
      '',
      '| # | Description | Date | Commit | Status | Directory |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 260101-abc | Fix login | 2026-01-01 | abc1234 | complete | [260101-abc-fix-login](./quick/260101-abc-fix-login/) |',
      '',
    ].join('\n'));
    const done = okJson(initQuick(tmpDir, ['--resume', 'fix-login']));
    const open = okJson(initQuick(tmpDir, ['--resume', 'other']));
    assert.deepEqual(done.resume, { has_plan: true, has_summary: true, state_row: true });
    assert.deepEqual(open.resume, { has_plan: false, has_summary: false, state_row: false });
  });

  test('a legacy directory\'s state_row looks up the STATE.md row keyed by its date prefix and naming its directory', () => {
    makeTask(tmpDir, '20250101-fix-login', { 'PLAN.md': '# plan\n' });
    // Same day, so the same date prefix: only the Directory cell tells the two rows apart.
    makeTask(tmpDir, '20250101-other');
    // A directory whose name is only a prefix of the row's directory is not named by it.
    makeTask(tmpDir, '20250101-fix');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '# STATE',
      '',
      '## Quick Tasks Completed',
      '',
      '| # | Description | Date | Commit | Status | Directory |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 20250101 | Fix login | 2025-01-01 | abc1234 | complete | [20250101-fix-login](./quick/20250101-fix-login/) |',
      '',
    ].join('\n'));
    const done = okJson(initQuick(tmpDir, ['--resume', 'fix-login']));
    const open = okJson(initQuick(tmpDir, ['--resume', 'other']));
    const shorter = okJson(initQuick(tmpDir, ['--resume', 'fix']));
    assert.equal(done.legacy, true);
    assert.equal(done.quick_id, null);
    assert.deepEqual(done.resume, { has_plan: true, has_summary: false, state_row: true });
    assert.deepEqual(open.resume, { has_plan: false, has_summary: false, state_row: false });
    assert.deepEqual(shorter.resume, { has_plan: false, has_summary: false, state_row: false });
  });

  test('mode flags still decide the section manifest, as on a first run', () => {
    makeTask(tmpDir, '260101-abc-fix-login');
    for (const flags of [[], ['--validate'], ['--full'], ['--discuss', '--research']]) {
      const resumed = okJson(initQuick(tmpDir, ['--resume', 'fix-login', ...flags]));
      const first = okJson(initQuick(tmpDir, ['fix', 'login', ...flags]));
      assert.deepEqual(resumed.section_manifest, first.section_manifest, `flags ${flags.join(' ') || '(none)'}`);
    }
  });

  test('looks only in the active workstream\'s quick directory', () => {
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(wsDir, { recursive: true });
    const wsTask = makeTask(tmpDir, '260101-abc-ws-task', {}, quickRoot(tmpDir, 'alpha'));
    makeTask(tmpDir, '260101-xyz-root-task');
    const out = okJson(initQuick(tmpDir, ['--resume', 'ws-task'], { GSD_WORKSTREAM: 'alpha' }));
    assert.equal(out.task_dir, toPosixPath(wsTask));
    const err = failure(tmpDir, ['--resume', 'root-task'], { GSD_WORKSTREAM: 'alpha' });
    assert.equal(err.reason, 'quick_resume_not_found');
  });

  describe('no such task', () => {
    test('no directory with that slug', () => {
      makeTask(tmpDir, '260101-abc-fix-login');
      assert.equal(failure(tmpDir, ['--resume', 'fix-logout']).reason, 'quick_resume_not_found');
    });

    test('no quick directory at all', () => {
      assert.equal(failure(tmpDir, ['--resume', 'fix-login']).reason, 'quick_resume_not_found');
      assert.equal(fs.existsSync(quickRoot(tmpDir)), false, 'the lookup must not create .planning/quick');
    });

    test('.planning/quick is a file', () => {
      fs.writeFileSync(quickRoot(tmpDir), 'not a directory');
      assert.equal(failure(tmpDir, ['--resume', 'fix-login']).reason, 'quick_resume_not_found');
    });

    test('a file named like a task directory is not a task', () => {
      fs.mkdirSync(quickRoot(tmpDir), { recursive: true });
      fs.writeFileSync(path.join(quickRoot(tmpDir), '260101-abc-fix-login'), '');
      assert.equal(failure(tmpDir, ['--resume', 'fix-login']).reason, 'quick_resume_not_found');
    });

    test('a directory whose prefix is not a quick id or a legacy date does not match', () => {
      makeTask(tmpDir, '2601-abc-fix-login');
      makeTask(tmpDir, '260101-ABC-fix-login');
      makeTask(tmpDir, 'x260101-abc-fix-login');
      assert.equal(failure(tmpDir, ['--resume', 'fix-login']).reason, 'quick_resume_not_found');
    });
  });

  test('an unreadable quick directory fails with a typed error, not a crash or an empty answer', (t) => {
    makeTask(tmpDir, '260101-abc-fix-login');
    const quickDir = quickRoot(tmpDir);
    const real = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', function (p, ...rest) {
      if (path.resolve(String(p)) === quickDir) {
        const e = new Error('EACCES: permission denied');
        e.code = 'EACCES';
        throw e;
      }
      return real.call(fs, p, ...rest);
    });
    const err = failure(tmpDir, ['--resume', 'fix-login']);
    assert.equal(err.reason, 'unknown');
    assert.equal(err.code, 'EACCES');
  });

  describe('invalid input is refused before any lookup', () => {
    const hostile = [
      ['empty-ish', ' '],
      ['traversal', '..'],
      ['path separator', 'a/b'],
      ['uppercase', 'Fix-Login'],
      ['unicode', 'fix-lögin'],
      ['command substitution', '$(touch PWNED)'],
      ['backticks', '`touch PWNED`'],
      ['semicolon', 'a;touch PWNED'],
      ['over 60 chars', 'a'.repeat(61)],
    ];
    for (const [name, slug] of hostile) {
      test(`slug: ${name}`, () => {
        makeTask(tmpDir, '260101-abc-fix-login');
        const err = failure(tmpDir, ['--resume', slug]);
        assert.equal(err.reason, 'usage');
        assert.equal(fs.existsSync(path.join(tmpDir, 'PWNED')), false);
      });
    }

    // SLUG_RE is 1-60 characters: 0 (the empty rows below) and 61 are refused;
    // 1, 2, 59 and 60 are accepted.
    for (const length of [1, 2, 59, 60]) {
      test(`a ${length}-character slug is accepted`, () => {
        const slug = 'a'.repeat(length);
        makeTask(tmpDir, `260101-abc-${slug}`);
        assert.equal(okJson(initQuick(tmpDir, ['--resume', slug])).slug, slug);
      });
    }

    test('the lookup itself refuses a 0-character slug', () => {
      makeTask(tmpDir, '260101-abc-fix-login');
      assert.deepEqual(resolveQuickResume(tmpDir, ''), { ok: false, reason: 'invalid_slug' });
    });

    const usage = [
      ['missing value', ['--resume']],
      ['flag-shaped value', ['--resume', '--validate']],
      ['empty = value', ['--resume=']],
      ['empty value', ['--resume', '']],
      ['duplicate', ['--resume', 'fix-login', '--resume', 'fix-login']],
      ['duplicate, mixed forms', ['--resume', 'fix-login', '--resume=other']],
      ['a description as well', ['--resume', 'fix-login', 'more', 'words']],
    ];
    for (const [name, args] of usage) {
      test(`argv: ${name}`, () => {
        makeTask(tmpDir, '260101-abc-fix-login');
        const before = snapshot(tmpDir);
        assert.equal(failure(tmpDir, args).reason, 'usage');
        assert.deepEqual(snapshot(tmpDir), before);
      });
    }
  });

  test('without --resume, a description with unknown flags is unchanged', () => {
    const out = okJson(initQuick(tmpDir, ['add', 'a', '--dry-run', 'option', '--validate']));
    assert.equal(out.description, 'add a --dry-run option');
    assert.equal(out.slug, 'add-a-dry-run-option');
    assert.equal('legacy' in out, false, 'a first run carries no resume fields');
    assert.equal('resume' in out, false);
  });
});

describe('#6530 quick-resume properties', () => {
  const slugArb = fc.stringMatching(/^[a-z0-9-]{1,20}$/);
  const tokenArb = fc.string({ maxLength: 12 }).filter((t) => t !== '--resume' && !t.startsWith('--resume='));

  test('removing one --resume occurrence (either form) gives back exactly the other tokens', () => {
    fc.assert(
      // A value that starts with `--` is flag-shaped and is not consumed (the parser seam's rule), so keep it out here.
      fc.property(fc.array(tokenArb, { maxLength: 8 }), fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,19}$/), fc.nat(), fc.boolean(), (tokens, slug, at, eqForm) => {
        const pos = at % (tokens.length + 1);
        const inserted = eqForm ? [`--resume=${slug}`] : ['--resume', slug];
        const argv = [...tokens.slice(0, pos), ...inserted, ...tokens.slice(pos)];
        const split = splitQuickResumeArgs(argv);
        assert.equal(split.resumeCount, 1);
        assert.deepEqual(split.descriptionTokens, tokens);
        assert.deepEqual(splitQuickResumeArgs(tokens), { resumeCount: 0, descriptionTokens: tokens });
      }),
      { numRuns: 200 },
    );
  });

  test('a lookup finds a task exactly when its whole slug is a task directory\'s slug', (t) => {
    const root = createTempProject('gsd-quick-resume-prop-');
    t.after(() => cleanup(root));
    fc.assert(
      fc.property(fc.uniqueArray(slugArb, { minLength: 1, maxLength: 5 }), slugArb, (slugs, query) => {
        const dir = fs.mkdtempSync(path.join(root, 'run-'));
        slugs.forEach((slug, i) => makeTask(dir, `260101-a${String(i).padStart(2, '0')}-${slug}`));
        const r = resolveQuickResume(dir, query);
        const index = slugs.indexOf(query);
        if (index === -1) {
          assert.deepEqual(r, { ok: false, reason: 'not_found' });
        } else {
          assert.equal(r.ok, true);
          assert.equal(r.quick_id, `260101-a${String(index).padStart(2, '0')}`);
          assert.equal(r.slug, query);
        }
      }),
      { numRuns: 40 },
    );
  });
});
