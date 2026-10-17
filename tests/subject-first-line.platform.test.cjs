/**
 * #5473 — hooks/gsd-validate-commit.sh extracts a commit message's first line
 * BYTE-wise.
 *
 * On bash 3.2 (macOS /bin/bash) in a multibyte locale, the longest-suffix glob
 * `${MSG%%$'\n'*}` on a 112KB value cost ~3.5 s (measured inside the macOS
 * conformance job: the same hook on the same 114750-byte command took ~5.6 s
 * under LC_ALL=en_US.UTF-8 and ~0.55 s under LC_ALL=C), which is what pushed
 * tests/hooks-opt-in.test.cjs's 112KB rows past their 10 s bound intermittently.
 * The fix does that one expansion in the C locale, in a command substitution so
 * the locale does not leak into the rest of the hook.
 *
 * No timing is asserted here. The test traces the REAL hook (`bash -x`) on the
 * fallback path that runs the extraction and asserts what the trace shows: the
 * C locale is entered for the extraction and the subject it produces is the
 * message's first line. The behaviour tests pin that the verdict (exit status and
 * block payload) is unchanged for the shapes of message the extraction sees.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-validate-commit.sh');
const HOOK_BOUND_MS = 30000;
const skipHere = process.platform === 'win32' && 'bash hooks need a unix shell';

let project;
const env = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`,
};

// A trailing --cleanup=verbatim sets RESOLVE=0, the path that extracts the subject in bash.
const FALLBACK = '--cleanup=verbatim';

function run(command, { trace = false, extraEnv = {} } = {}) {
  return spawnSync('bash', trace ? ['-x', HOOK] : [HOOK], {
    cwd: project,
    env: { ...env, ...extraEnv },
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    timeout: HOOK_BOUND_MS,
    // A traced 112KB run writes every expansion of the value to stderr.
    maxBuffer: 256 * 1024 * 1024,
  });
}

describe('gsd-validate-commit.sh first-line extraction (#5473)', { skip: skipHere }, () => {
  before(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-first-line-'));
    fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.planning', 'config.json'),
      JSON.stringify({ hooks: { community: true } }),
    );
  });
  after(() => cleanup(project));

  test('the extraction enters the C locale in a command substitution and yields the first line', () => {
    const r = run(`git commit -m "wibble wobble" ${FALLBACK}`, { trace: true });
    assert.equal(r.status, 2, r.stderr);
    // xtrace prefixes a substitution's commands with a second `+`.
    assert.match(r.stderr, /^\+\+ LC_ALL=C$/m, 'the extraction must run in the C locale');
    assert.match(r.stderr, /^\+ SUBJECT='wibble wobble'$/m);
  });

  test('the C locale does not leak: nothing outside the extraction assigns LC_ALL', () => {
    const r = run(`git commit -m "wibble wobble" ${FALLBACK}`, { trace: true });
    const assignments = r.stderr.split('\n').filter((line) => /^\++ LC_ALL=/.test(line));
    assert.deepEqual(assignments, ['++ LC_ALL=C']);
  });

  test('verdicts are unchanged for single-line, multi-line and trailing-newline messages', () => {
    const cases = [
      ['git commit -m "feat: add thing"', 0],
      ['git commit -m "feat: add thing\nbody line one\nbody line two"', 0],
      ['git commit -m "feat: add thing\n"', 0],
      ['git commit -m "wibble wobble"', 2],
      ['git commit -m "wibble wobble\nfeat: not the subject"', 2],
      // CRLF: the first line carries its \r, as before; and a leading newline
      // makes the first line EMPTY, so the later conforming line is not the subject.
      ['git commit -m "feat: x\r\nbody"', 0],
      ['git commit -m "\nfeat: x"', 2],
    ];
    for (const [command, expected] of cases) {
      for (const suffix of ['', ` ${FALLBACK}`]) {
        const r = run(`${command}${suffix}`);
        assert.equal(r.status, expected, `${JSON.stringify(command + suffix)}: ${r.stderr}`);
      }
    }
  });

  test('a multibyte first line gives the same verdict as before, in a UTF-8 and in the C locale', () => {
    for (const extraEnv of [{ LC_ALL: 'en_US.UTF-8' }, { LC_ALL: 'C' }]) {
      const ok = run(`git commit -m "feat: añadir soporte\ncuerpo 日本語" ${FALLBACK}`, { extraEnv });
      assert.equal(ok.status, 0, `${JSON.stringify(extraEnv)}: ${ok.stderr}`);
      const bad = run(`git commit -m "arreglo: añadir 日本語\nfeat: x" ${FALLBACK}`, { extraEnv });
      assert.equal(bad.status, 2, `${JSON.stringify(extraEnv)}: ${bad.stderr}`);
    }
  });

  // The C locale is used for the EXTRACTION only. The 72-character length gate must
  // still count characters, not bytes, in the caller's locale: 72 multibyte characters
  // pass (216 bytes) and 73 do not. Needs a UTF-8 locale on the machine, else bash
  // falls back to the C locale and counts bytes (then there is nothing to pin).
  const hasUtf8Locale = spawnSync('locale', ['-a'], { encoding: 'utf8', timeout: HOOK_BOUND_MS })
    .stdout?.split(/\r?\n/).some((name) => /^en_US\.utf-?8$/i.test(name));

  test('the length gate still counts characters, not bytes, in the caller\'s UTF-8 locale', { skip: !hasUtf8Locale && 'needs an en_US.UTF-8 locale' }, () => {
    const subjectOf = (chars) => `feat: ${'日'.repeat(chars - 'feat: '.length)}`;
    const extraEnv = { LC_ALL: 'en_US.UTF-8' };
    const at72 = run(`git commit -m "${subjectOf(72)}" ${FALLBACK}`, { extraEnv });
    assert.equal(at72.status, 0, at72.stderr);
    const at73 = run(`git commit -m "${subjectOf(73)}" ${FALLBACK}`, { extraEnv });
    assert.equal(at73.status, 2, at73.stderr);
    assert.equal(JSON.parse(at73.stdout).code, 'COMMIT_SUBJECT_TOO_LONG');
  });

  test('boundary: a 112KB message still yields its first line (limit - 1, limit, limit + 1 bytes of padding)', () => {
    // MAX_ARG_STRLEN is 131072 on Linux; stay under it as the existing 112KB rows do.
    for (const pad of [112 * 1024 - 1, 112 * 1024, 112 * 1024 + 1]) {
      const command = `git commit -m "feat: x\n${'y'.repeat(pad)}" ${FALLBACK}`;
      const r = run(command, { trace: true });
      assert.equal(r.status, 0, `pad ${pad}: ${r.stderr.slice(0, 300)}`);
      assert.match(r.stderr, /^\+ SUBJECT='feat: x'$/m, `pad ${pad}`);
    }
  });
});
