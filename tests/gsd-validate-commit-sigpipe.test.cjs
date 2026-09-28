// #4429 — `hooks/gsd-validate-commit.sh` must survive a large `commit_types`
// config. Two defects, provably coupled, covered by one suite.
//
// (1) SIGPIPE. The pre-fix hook took the first line of CONFIG_OUT with
//     `printf '%s\n' "$CONFIG_OUT" | head -1`. `head` closes after one line, so
//     `printf` is killed by SIGPIPE once CONFIG_OUT exceeds the 64 KiB pipe
//     buffer, and `set -euo pipefail` aborts the whole hook. The fix — pure
//     parameter expansion — is ALREADY on `next`; it landed INCIDENTALLY in
//     #4537, a PR about commit classification whose message never mentions
//     #4429. Nothing in the tree would notice its removal, and the failure is
//     load-dependent (the reporter: "does not reproduce on an idle machine"),
//     so a reintroduction would surface as an unrelated flaky test.
//
// (2) regcomp. `COMMIT_TYPE_ALT` joined every CONFIGURED type into one regex.
//     bash caps a compiled pattern at 64 KiB; past it `[[ =~ ]]` returns 2, and
//     `if !` cannot tell a COMPILE ERROR from "the subject does not conform".
//     A valid `feat(auth): …` was blocked with CONVENTIONAL_COMMITS_VIOLATION
//     while `feat` sat in its own valid_types.
//
// They are coupled with no gap. Each configured type contributes `len+1` bytes
// to CONFIG_OUT (type + newline) AND `len+1` to the alternation (type + pipe),
// so the two strings are the same size to within the leading flag line. The
// smallest payload that overflows the pipe (N=6059, CONFIG_OUT 65544) already
// puts the alternation at 65592 — past the 65504 ceiling. So (1) cannot be
// tested at all until (2) is fixed, which is why both land together.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const isWindows = process.platform === 'win32';

// The compiled-regex ceiling is a PROPERTY OF THE PLATFORM'S REGEX ENGINE, not a
// repo invariant — do not read these as universal constants.
//
//   bash 3.2.57 / BSD libc (macOS, this repo's stated target): bisected to a
//     65504-byte alternation compiling and 65515 failing — 6051 vs 6052 types.
//   bash 5.2.15 / glibc (the Linux tester image, which is the ONLY OS the remote
//     matrix runs): measured MATCH at 6051, 6052 and 20000 types (228943 bytes).
//     No reachable cap, so the regcomp defect does not reproduce there at all.
//
// Encoding the macOS numbers as a cross-platform expectation is precisely what
// made the first verification run red. The rows below therefore assert only what
// holds everywhere, and the control that needs a capped engine calibrates itself
// at runtime instead of assuming one.
const ALT_LAST_COMPILING = 6051;
const ALT_FIRST_FAILING = 6052;
const ALT_PAST_FAILING = 6053;
// Comfortably over the 64 KiB pipe buffer (~180 KiB of CONFIG_OUT), so the
// pre-fix race fires deterministically rather than occasionally.
const SIGPIPE_PAYLOAD = 20000;

// Same bash fan-out class as tests/hooks-opt-in.test.cjs: the hook runs under
// bash and shells out to node, so node must be on PATH.
const hookEnv = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
};

/**
 * fs.cpSync filter for makeHookLayout's copy of the live HOOKS_DIR.
 *
 * hooks/.dist-staging-<pid>/ was scripts/build-hooks.js's per-process staging
 * directory (now moved to be a sibling of hooks/ — see build-hooks.js — but
 * this filter stays as defense in depth against any future transient
 * directory living under hooks/, and against anyone reverting that move).
 * Entering a directory that a concurrent process deletes mid-walk crashes
 * Node's native fs.cpSync with an uncaught C++ exception (SIGABRT) rather
 * than a catchable JS error — see the CONTROL test below. Excluding the
 * pattern means this copy's walk never enters one, so a concurrent
 * create/delete of it is not observable here at all.
 *
 * hooks/dist/ is excluded too: makeHookLayout() deletes it from the copy
 * immediately after anyway (this test only needs the shell/lib sources,
 * never the build output), so copying it is both wasted work and needless
 * exposure to the same class of race against build-hooks.js's in-place
 * per-file renames.
 */
function isSafeHooksCopyEntry(srcPath) {
  const base = path.basename(srcPath);
  if (/^\.dist-staging-/.test(base)) return false;
  if (base === 'dist' && path.dirname(srcPath) === HOOKS_DIR) return false;
  return true;
}

/**
 * A throwaway copy of `hooks/` that the hook can actually run from.
 *
 * `hooks/lib/git-cmd.js` requires `../gsd-core/bin/lib/token-scanner.cjs`,
 * resolved relative to the hooks directory's PARENT. A copy dropped in a bare
 * tmpdir cannot resolve it: the classifier throws and the hook FAILS OPEN,
 * returning 0 for every input including garbage. Three control runs read as
 * "the pre-fix form is fine" for exactly that reason before it was caught — so
 * the layout symlinks `gsd-core` beside the copy, and every row additionally
 * asserts the run was substantive (see `assertSubstantive`).
 *
 * @param {object} t node:test context, for cleanup.
 * @param {(src: string) => string} [transform] rewrites the hook's text to
 *   reconstruct a pre-fix form. Each transform hard-asserts its anchors, so a
 *   future refactor fails loudly instead of silently testing nothing.
 * @returns {string} absolute path to the hook to run.
 */
function makeHookLayout(t, transform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4429-hooks-'));
  t.after(() => cleanup(root));
  fs.cpSync(HOOKS_DIR, path.join(root, 'hooks'), {
    recursive: true,
    dereference: true,
    filter: isSafeHooksCopyEntry,
  });
  cleanup(path.join(root, 'hooks', 'dist'));
  fs.symlinkSync(path.join(REPO_ROOT, 'gsd-core'), path.join(root, 'gsd-core'), 'dir');

  const hookPath = path.join(root, 'hooks', 'gsd-validate-commit.sh');
  if (transform) {
    // Reading the shell script's text is the point: the subject under test IS
    // the shipped script, and a pre-fix form can only be reconstructed from it.
    // (`local/no-source-grep` scopes to .cjs/.js/.ts; this is neither grep nor
    // an assertion on source text — it is building a second binary to run.)
    const src = fs.readFileSync(hookPath, 'utf-8');
    fs.writeFileSync(hookPath, transform(src), { mode: 0o755 });
  }
  return hookPath;
}

/**
 * Remove the subprocess-status pre-initialisation, restoring the form in which
 * an EXPORTED CONFIG_STATUS / CMD_STATUS / CLASSIFY_STATUS was inherited into
 * the success path and read as "the subprocess failed" (defect 3).
 */
function toPreFixAmbientStatus(src) {
  const block = 'CONFIG_STATUS=0\nCMD_STATUS=0\nCLASSIFY_STATUS=0\n\n';
  assert.ok(
    src.includes(block),
    'reconstruction anchor gone: the hook no longer pre-initialises the three '
    + 'subprocess-status variables. Re-derive the pre-fix form before trusting this suite.',
  );
  return src.replace(block, '');
}

/** Restore the `printf … | head -1` first-line extraction (defect 1). */
function toPreFixPipeline(src) {
  const shipped = 'ENABLED="${CONFIG_OUT%%$\'\\n\'*}"';
  assert.ok(
    src.includes(shipped),
    'reconstruction anchor gone: the shipped hook no longer extracts ENABLED with ' +
    'parameter expansion. Re-derive the pre-fix form before trusting this suite.',
  );
  return src.replace(shipped, 'ENABLED=$(printf \'%s\\n\' "$CONFIG_OUT" | head -1)');
}

/** Restore the unbounded `^(type1|type2|…)` alternation (defect 2). */
function toPreFixAlternation(src) {
  const listLine = '    COMMIT_TYPE_LIST=$(printf \'%s, \' "${COMMIT_TYPES[@]}")';
  const guardStart = "    SUBJECT_TYPE=''";
  const guardEnd = '    if [ "$COMMIT_TYPE_OK" -ne 1 ]; then';
  for (const [anchor, what] of [[listLine, 'COMMIT_TYPE_LIST'], [guardStart, 'SUBJECT_TYPE'], [guardEnd, 'COMMIT_TYPE_OK']]) {
    assert.ok(
      src.includes(anchor),
      `reconstruction anchor gone (${what}): the shipped hook's type check was ` +
      'restructured. Re-derive the pre-fix form before trusting this suite.',
    );
  }
  let out = src.replace(
    listLine,
    `    COMMIT_TYPE_ALT=$(IFS='|'; echo "\${COMMIT_TYPES[*]}")\n${listLine}`,
  );
  const start = out.indexOf(guardStart);
  const end = out.indexOf(guardEnd);
  assert.ok(end > start, 'pre-fix reconstruction: type-check block is out of order');
  return (
    out.slice(0, start)
    + '    if ! [[ "$SUBJECT" =~ ^($COMMIT_TYPE_ALT)(\\(.+\\))?:[[:space:]].+ ]]; then\n'
    + out.slice(end + guardEnd.length + 1)
  );
}

/**
 * A project whose `.planning/config.json` configures `count` extra commit
 * types. Every value matches the hook's own `^[a-z][a-z0-9-]*$` filter and is
 * distinct from the 10 built-ins.
 */
function makeProject(t, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4429-proj-'));
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const types = [];
  for (let i = 0; i < count; i++) types.push(`zz${i}type`);
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ hooks: { community: true, commit_types: types } }),
  );
  return dir;
}

function runValidate(hookPath, cwd, message, extraEnv = {}) {
  const r = runHook(hookPath, [], {
    input: JSON.stringify({ tool_input: { command: `git commit -m "${message}"` } }),
    encoding: 'utf-8',
    cwd,
    interpreter: 'bash',
    env: { ...hookEnv, ...extraEnv },
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * A hook whose classifier threw accepts ANY input — asserting `status === 0`
 * against it proves nothing. Every row calls this first.
 */
function assertSubstantive(res, label) {
  assert.ok(
    !res.stderr.includes('CLASSIFIER_THREW'),
    `${label}: the hook FAILED OPEN — the classifier could not resolve `
    + `gsd-core/bin/lib, so this run returns 0 for any input and proves nothing.\n`
    + `stderr: ${res.stderr.slice(0, 400)}`,
  );
}

describe('#4429 — gsd-validate-commit.sh under a large commit_types config', { skip: isWindows }, () => {
  test('a conforming subject is accepted at a payload that overflows the pipe buffer', (t) => {
    const hook = makeHookLayout(t);
    const dir = makeProject(t, SIGPIPE_PAYLOAD);
    const res = runValidate(hook, dir, 'feat(auth): add login flow');
    assertSubstantive(res, 'shipped hook');
    assert.equal(
      res.status,
      0,
      `A valid Conventional Commit was rejected with ${SIGPIPE_PAYLOAD} configured `
      + `commit_types. stdout: ${res.stdout.slice(0, 300)}`,
    );
  });

  test('the gate is not weakened: an unknown type is still blocked', (t) => {
    const hook = makeHookLayout(t);
    const dir = makeProject(t, SIGPIPE_PAYLOAD);
    const res = runValidate(hook, dir, 'nope(auth): not a configured type');
    assertSubstantive(res, 'shipped hook');
    assert.equal(res.status, 2, 'an unconfigured type must still be blocked');
    assert.match(res.stdout, /"code": "CONVENTIONAL_COMMITS_VIOLATION"/);
  });

  test('a CONFIGURED extra type is accepted — proves the config is actually read', (t) => {
    const hook = makeHookLayout(t);
    const dir = makeProject(t, SIGPIPE_PAYLOAD);
    // The LAST entry, so a truncated read cannot pass this row.
    const res = runValidate(hook, dir, `zz${SIGPIPE_PAYLOAD - 1}type: use the last configured type`);
    assertSubstantive(res, 'shipped hook');
    assert.equal(
      res.status,
      0,
      'the last configured commit type was rejected — the config was not fully read, '
      + 'so every other row in this file is measuring a default-sized list',
    );
  });

  // limit-1 / limit / limit+1 on the compiled-regex ceiling.
  for (const count of [ALT_LAST_COMPILING, ALT_FIRST_FAILING, ALT_PAST_FAILING, SIGPIPE_PAYLOAD]) {
    test(`conforming subject accepted with ${count} configured types`, (t) => {
      const hook = makeHookLayout(t);
      const dir = makeProject(t, count);
      const res = runValidate(hook, dir, 'feat(auth): add login flow');
      assertSubstantive(res, `shipped hook @ ${count}`);
      assert.equal(
        res.status,
        0,
        `Rejected a valid commit at ${count} configured types. Above ~6051 the old `
        + 'alternation exceeded bash\'s 64 KiB regcomp cap; [[ =~ ]] returned 2 and '
        + '`if !` read that compile error as "does not conform".',
      );
    });
  }

  test('CONTROL: the pre-fix alternation blocks a valid commit wherever the engine caps pattern size', (t) => {
    const hook = makeHookLayout(t, toPreFixAlternation);
    const dir = makeProject(t, ALT_FIRST_FAILING);
    const res = runValidate(hook, dir, 'feat(auth): add login flow');
    assertSubstantive(res, 'pre-fix alternation control');

    if (res.status === 0) {
      // Self-calibrating rather than assuming a cap: this engine compiled the
      // whole list-derived alternation, so the regcomp defect is NOT reachable
      // here and there is nothing for this control to reproduce. Skipped out
      // loud — never silently passed — because a green row here would otherwise
      // read as "the defect is covered" on a platform where it cannot occur.
      // glibc/bash 5.2 (the Linux tester image) measured exactly this.
      t.skip(
        `this platform's regex engine compiled a ${ALT_FIRST_FAILING}-type alternation, `
        + 'so it has no reachable compile cap and the regcomp defect cannot be '
        + 'reproduced. The defect and this control are specific to a capped engine '
        + '(bash 3.2 / BSD libc on macOS). The SIGPIPE control below is unaffected.',
      );
      return;
    }

    assert.equal(
      res.status,
      2,
      'this engine rejected the alternation somewhere, but not as a block — the '
      + 'pre-fix reconstruction did not reproduce the regcomp defect, so the rows '
      + 'above would pass with or without the fix. Re-derive it before trusting them.',
    );
  });

  test('CONTROL: the pre-fix alternation still ACCEPTS one type below the cliff', (t) => {
    // On a capped engine this pins the boundary's LOW side, so the limit-1 row is
    // not vacuous there. On an uncapped engine it passes trivially — that is
    // acknowledged, not hidden: the row it guards is the macOS-specific one, and
    // the paired high-side control above skips out loud on such platforms.
    const hook = makeHookLayout(t, toPreFixAlternation);
    const dir = makeProject(t, ALT_LAST_COMPILING);
    const res = runValidate(hook, dir, 'feat(auth): add login flow');
    assertSubstantive(res, 'pre-fix alternation control @ limit-1');
    assert.equal(
      res.status,
      0,
      `the pre-fix form already failed at ${ALT_LAST_COMPILING} types, so the `
      + 'measured regcomp boundary in this suite is wrong — re-bisect it.',
    );
  });

  test('CONTROL: the pre-fix `head -1` pipeline aborts instead of returning a verdict', (t) => {
    const hook = makeHookLayout(t, toPreFixPipeline);
    const dir = makeProject(t, SIGPIPE_PAYLOAD);
    const res = runValidate(hook, dir, 'feat(auth): add login flow');
    // No assertSubstantive here, deliberately: the pre-fix abort happens while
    // READING the config, before the classifier ever runs, so CLASSIFIER_THREW
    // could never appear on this row and asserting its absence would prove
    // nothing. Substantiveness of this layout is established by the paired
    // shipped-hook row above, which returns a real verdict from the same
    // payload and the same tmpdir construction.
    // Deliberately NOT `status === 141`. The issue saw SIGPIPE (141) on Linux CI;
    // on macOS bash 3.2 the BUILTIN printf reports "write error: Broken pipe" and
    // the script exits 1 instead of dying from the signal. Pinning 141 would be a
    // mac-red/Linux-green split. The platform-independent invariant is that the
    // hook never reaches its own verdict.
    assert.ok(
      res.status !== 0 && res.status !== 2,
      'the pre-fix pipeline form returned a real verdict, so it did not reproduce '
      + `#4429 — this control proves nothing. status=${res.status}`,
    );
    // The EVIDENCE differs by platform and the remote matrix is Linux-only, so
    // this must accept both. On Linux (bash >= 4.3) the process is killed by
    // SIGPIPE -> status 141 with NO message. On macOS bash 3.2 the BUILTIN
    // printf traps EPIPE and reports `write error: Broken pipe`, exiting 1.
    // Asserting only the message would go red on every CI lane.
    assert.ok(
      res.status === 141 || /broken pipe/i.test(`${res.stdout}${res.stderr}`),
      'expected a broken-pipe abort of the `head -1` pipeline — either SIGPIPE '
      + `(141) or a reported write error. status=${res.status} `
      + `stderr=${res.stderr.slice(0, 200)}`,
    );
  });
});

// A second, quieter defect in the same file, found by the security review of
// this change: each subprocess status is captured as `... || VAR=$?`, which
// assigns ONLY on the failure branch, and is then read via `${VAR:-0}` — which
// defaults only when unset or empty. So on the SUCCESS path the variable kept
// whatever it already held, and an EXPORTED variable of that name (a CI wrapper,
// a .envrc, another hook) was read as a subprocess failure. Because the hook
// fails OPEN on a genuine subprocess failure by design (#3838), the result was a
// silent bypass: the gate printed "validator disabled for this call" and exited
// 0 on a commit it should have blocked.
describe('#4429 — subprocess statuses must not be inherited from the environment', { skip: isWindows }, () => {
  const NON_CONFORMING = 'nope: definitely not conventional';

  for (const varName of ['CONFIG_STATUS', 'CMD_STATUS', 'CLASSIFY_STATUS']) {
    test(`an ambient ${varName} cannot disable the gate`, (t) => {
      const hook = makeHookLayout(t);
      const dir = makeProject(t, 0);
      const res = runValidate(hook, dir, NON_CONFORMING, { [varName]: '3' });
      assertSubstantive(res, `shipped hook with ambient ${varName}`);
      assert.equal(
        res.status,
        2,
        `exporting ${varName}=3 disabled the commit gate — a non-conforming `
        + `commit was accepted. stderr: ${res.stderr.slice(0, 200)}`,
      );
    });
  }

  test('all three set at once still cannot disable the gate', (t) => {
    const hook = makeHookLayout(t);
    const dir = makeProject(t, 0);
    const res = runValidate(hook, dir, NON_CONFORMING, {
      CONFIG_STATUS: '9', CMD_STATUS: '5', CLASSIFY_STATUS: '127',
    });
    assertSubstantive(res, 'shipped hook with all three ambient');
    assert.equal(res.status, 2);
  });

  test('a conforming commit is still accepted with the variables set', (t) => {
    const hook = makeHookLayout(t);
    const dir = makeProject(t, 0);
    const res = runValidate(hook, dir, 'feat(auth): add login flow', { CLASSIFY_STATUS: '3' });
    assertSubstantive(res, 'shipped hook, conforming, ambient CLASSIFY_STATUS');
    assert.equal(res.status, 0);
  });

  test('CONTROL: without the pre-init, an ambient status really does bypass the gate', (t) => {
    const hook = makeHookLayout(t, toPreFixAmbientStatus);
    const dir = makeProject(t, 0);
    const res = runValidate(hook, dir, NON_CONFORMING, { CLASSIFY_STATUS: '3' });
    // Load-bearing, not ceremony: an orphaned layout ALSO exits 0 here, so
    // without this the row would pass for entirely the wrong reason. Measured:
    // the genuine bypass emits no CLASSIFIER_THREW, an orphaned layout does.
    assertSubstantive(res, 'pre-fix ambient-status control');
    assert.equal(
      res.status,
      0,
      'the pre-fix reconstruction did NOT reproduce the bypass, so the rows above '
      + 'would pass with or without the fix. Re-derive it before trusting them.',
    );
  });

  test('a GENUINE subprocess failure still fails open, as #3838 requires', (t) => {
    const hook = makeHookLayout(t);
    const dir = makeProject(t, 0);
    // A `node` that always fails, rather than removing node from PATH: node
    // lives in /usr/bin on many Linux images, so a PATH edit is not portable
    // and would silently stop testing anything.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4429-bin-'));
    t.after(() => cleanup(binDir));
    const shim = path.join(binDir, 'node');
    fs.writeFileSync(shim, '#!/bin/sh\nexit 3\n', { mode: 0o755 });

    const res = runValidate(hook, dir, NON_CONFORMING, {
      PATH: `${binDir}${path.delimiter}${hookEnv.PATH}`,
    });
    // This row EXPECTS a fail-open, so exit 0 alone cannot tell "the node shim
    // made the config read fail" from "the layout was broken and the classifier
    // could not load". Only the latter emits CLASSIFIER_THREW, so this pins the
    // pass to the cause the row actually names.
    assertSubstantive(res, 'genuine fail-open row');
    assert.equal(
      res.status,
      0,
      'a real subprocess failure must still disable the validator and pass (#3838); '
      + 'the pre-init must close the ambient bypass WITHOUT closing this path',
    );
    assert.match(res.stderr, /validator disabled for this call/);
  });
});

describe('#4429 follow-up — makeHookLayout must survive a concurrently-deleted staging directory', { skip: isWindows }, () => {
  test('isSafeHooksCopyEntry excludes .dist-staging-* directories and the top-level dist/ dir, and nothing else', () => {
    assert.equal(isSafeHooksCopyEntry(path.join(HOOKS_DIR, '.dist-staging-12345')), false);
    assert.equal(isSafeHooksCopyEntry(path.join(HOOKS_DIR, '.dist-staging-0')), false);
    assert.equal(isSafeHooksCopyEntry(path.join(HOOKS_DIR, 'dist')), false);
    // A NESTED directory that happens to be named "dist" (e.g. hooks/lib/dist)
    // is NOT the build-output directory and must still be copied.
    assert.equal(isSafeHooksCopyEntry(path.join(HOOKS_DIR, 'lib', 'dist')), true);
    assert.equal(isSafeHooksCopyEntry(path.join(HOOKS_DIR, 'gsd-validate-commit.sh')), true);
    assert.equal(isSafeHooksCopyEntry(path.join(HOOKS_DIR, 'lib')), true);
  });

  test('the fixed copy (with filter) survives a staging directory deleted mid-walk, and excludes it from the destination', (t) => {
    // Build a throwaway HOOKS_DIR-shaped fixture so this test never touches
    // the real, shared hooks/ directory.
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4429-fixture-src-'));
    t.after(() => cleanup(fixtureRoot));
    const srcHooks = path.join(fixtureRoot, 'hooks');
    fs.mkdirSync(srcHooks, { recursive: true });
    fs.writeFileSync(path.join(srcHooks, 'gsd-validate-commit.sh'), '#!/bin/sh\necho ok\n');
    const stagingDir = path.join(srcHooks, '.dist-staging-999999');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'gsd-validate-commit.sh.123'), 'partial\n');

    const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4429-fixture-dest-'));
    t.after(() => cleanup(destRoot));

    // Deterministically simulate the exact TOCTOU: fs.cpSync's filter is
    // invoked once per entry BEFORE it recurses into/copies that entry, so
    // deleting the staging dir from inside the filter callback (for the
    // entry immediately preceding it, or via a wrapping filter below)
    // reproduces "the directory vanished mid-walk" without relying on a
    // real concurrent process and real timing luck.
    let deleted = false;
    const filterAndDelete = (srcPath) => {
      const keep = isSafeHooksCopyEntry(srcPath);
      if (!deleted && path.basename(srcPath) !== '.dist-staging-999999') {
        // Delete the staging dir the first time the walk looks at some
        // OTHER entry, so it is guaranteed gone before cpSync would ever
        // reach it (order of directory entries is otherwise unspecified).
        deleted = true;
        cleanup(stagingDir);
      }
      return keep;
    };

    assert.doesNotThrow(() => {
      fs.cpSync(srcHooks, path.join(destRoot, 'hooks'), {
        recursive: true,
        dereference: true,
        filter: filterAndDelete,
      });
    }, 'the filtered copy must not throw even though .dist-staging-999999 was deleted mid-walk');

    assert.equal(
      fs.existsSync(path.join(destRoot, 'hooks', '.dist-staging-999999')),
      false,
      'the deleted (and filtered-out) staging dir must not appear in the destination',
    );
    assert.equal(
      fs.existsSync(path.join(destRoot, 'hooks', 'gsd-validate-commit.sh')),
      true,
      'the real hook file must still be copied',
    );
  });

  // #5068 — this CONTROL used to depend on winning a REAL race: a worker
  // thread churned a staging directory while the main thread looped an
  // unfiltered fs.cpSync for up to 15 s, hoping the directory would vanish in
  // the microsecond window between the parent's readdir and the child's
  // opendir. On a loaded bench it lost that race 136 times in a row, and the
  // churn itself was a 15-second IO storm on the shared tmpdir. Real-race
  // tests are deleted and replaced (RULESET.TESTS.delete-bad-tests).
  //
  // What the defect actually is, read off Node's source (lib/internal/fs/cp/
  // cp-sync.js `copyDir`, src/node_file.cc `CpSyncCopyDir`): an fs.cpSync with
  // NO filter hands the whole walk to the native `cpSyncCopyDir`, which opens
  // every listed subdirectory with the THROWING form of
  // `std::filesystem::directory_iterator`. Any failure to open a directory it
  // has just listed — ENOENT because a concurrent build deleted it, or any
  // other errno — escapes as an uncaught C++ exception and aborts the process
  // (SIGABRT); no JS try/catch can intercept it. Passing ANY filter moves the
  // walk onto the JS implementation, whose errors are ordinary, catchable
  // Errors — which is why a deletion driven from a filter callback cannot
  // reproduce this, and why the fix (a filter) works.
  //
  // So the injection point is that exact call, made to fail deterministically
  // instead of by timing: the child leaves itself exactly ONE free file
  // descriptor. The parent directory's opendir takes it; the staging
  // directory's opendir then fails with EMFILE — every run, on every host.
  // The same fixture copied WITH the shipped filter, under the identical
  // injection, never enters the staging directory and completes.
  const STAGING = '.dist-staging-999999';

  /**
   * Copy a hooks-shaped fixture in a throwaway child that has exactly one free
   * fd when the copy starts. Returns the seam result plus the JSON markers the
   * child wrote (synchronously, so they survive an abort).
   */
  function copyWithOneFreeFd(t, filtered) {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4429-control-'));
    t.after(() => cleanup(fixtureRoot));
    const srcHooks = path.join(fixtureRoot, 'hooks');
    // The staging directory is the ONLY entry: a regular file visited first
    // would need fds of its own and fail catchably, before the walk ever
    // reached the directory this control is about.
    fs.mkdirSync(path.join(srcHooks, STAGING), { recursive: true });
    fs.writeFileSync(path.join(srcHooks, STAGING, 'gsd-validate-commit.sh.123'), 'partial\n');
    const dest = path.join(fixtureRoot, 'out');

    // The filtered run uses the SHIPPED filter, re-hosted in the child with
    // HOOKS_DIR bound to this fixture — not a look-alike.
    const child = path.join(fixtureRoot, 'copy-with-one-free-fd.cjs');
    fs.writeFileSync(child, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const os = require('node:os');",
      "const path = require('node:path');",
      `const HOOKS_DIR = ${JSON.stringify(srcHooks)};`,
      isSafeHooksCopyEntry.toString(),
      `const opts = { recursive: true, dereference: true${filtered ? ', filter: isSafeHooksCopyEntry' : ''} };`,
      // Warm-up with descriptors to spare, so no lazy load happens later.
      `fs.cpSync(HOOKS_DIR, ${JSON.stringify(`${dest}-warm`)}, opts);`,
      'const held = [];',
      'for (;;) {',
      '  try { held.push(fs.openSync(os.devNull, "r")); }',
      '  catch (e) { if (e.code === "EMFILE") break; throw e; }',
      '}',
      'fs.closeSync(held.pop());',
      'fs.writeSync(1, JSON.stringify({ phase: "ready", held: held.length }) + "\\n");',
      'let phase;',
      `try { fs.cpSync(HOOKS_DIR, ${JSON.stringify(dest)}, opts); phase = "copied"; }`,
      'catch (e) { phase = "threw:" + e.code; }',
      'for (const fd of held) fs.closeSync(fd);',
      'fs.writeSync(1, JSON.stringify({ phase }) + "\\n");',
    ].join('\n'));
    // A soft descriptor limit keeps the fill loop to ~256 opens instead of a
    // container's default of ~1M.
    const limiter = path.join(fixtureRoot, 'limit-fds.sh');
    fs.writeFileSync(limiter, 'ulimit -S -n 256 && exec "$@"\n');

    const res = runHook(limiter, [process.execPath, child], {
      interpreter: 'sh',
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    });
    const markers = res.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { res, markers, dest };
  }

  test('CONTROL: without the filter, a staging directory the native walk cannot open aborts the whole process (proves the defect is real)', (t) => {
    const { res, markers } = copyWithOneFreeFd(t, false);
    const detail = `outcome=${res.outcome} exitCode=${res.exitCode} signal=${res.signal} `
      + `markers=${JSON.stringify(markers)} stderr=${res.stderr.slice(0, 400)}`;
    // Anti-vacuous: the injection really happened — the fill loop reached
    // EMFILE and the copy started with one descriptor free.
    assert.equal(markers[0]?.phase, 'ready', `the fd injection never completed. ${detail}`);
    assert.ok(markers[0].held > 0, `no descriptors were held, so nothing was injected. ${detail}`);
    assert.equal(
      res.outcome,
      OUTCOME.KILLED,
      'the unfiltered copy did not abort when the staging directory could not be opened, so this CONTROL '
      + `does not reproduce the defect — re-derive it before trusting the fixed-copy rows. ${detail}`,
    );
    assert.equal(res.signal, 'SIGABRT', `expected an uncaught C++ exception (SIGABRT). ${detail}`);
    // The child's own try/catch never ran: the abort bypassed JS entirely.
    assert.equal(markers.length, 1, `the copy returned to JS instead of aborting. ${detail}`);
  });

  test('the fixed copy (with the shipped filter) completes under the identical injection and never enters the staging directory', (t) => {
    const { res, markers, dest } = copyWithOneFreeFd(t, true);
    const detail = `outcome=${res.outcome} exitCode=${res.exitCode} signal=${res.signal} `
      + `markers=${JSON.stringify(markers)} stderr=${res.stderr.slice(0, 400)}`;
    assert.equal(markers[0]?.phase, 'ready', `the fd injection never completed. ${detail}`);
    assert.equal(res.outcome, OUTCOME.EXITED, detail);
    assert.equal(res.exitCode, 0, detail);
    assert.equal(markers[1]?.phase, 'copied', `the filtered copy did not complete. ${detail}`);
    assert.equal(fs.statSync(dest).isDirectory(), true, 'the destination directory must exist');
    assert.equal(
      fs.existsSync(path.join(dest, STAGING)),
      false,
      'the filtered-out staging dir must not appear in the destination',
    );
  });
});
