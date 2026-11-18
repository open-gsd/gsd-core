'use strict';

/**
 * Platform-sensitive tests for the tool-owned .gsd owner (#5757), split out of
 * tests/gsd-tool-dir.test.cjs because they need a real OS.
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier.
 *
 * Tests and why each needs a real OS:
 * - "#5757: throws when .gsd is a symlink" - creates a real directory symlink; creation needs privilege on Windows (symlink-keyword)
 * - "#5757: throws when .gsd/.gitignore is a symlink" - creates a real file symlink (symlink-keyword)
 * - "#5757 case 13: parity" - both writers refuse a symlinked .gsd and run real git (symlink-keyword, raw-child-process)
 * - "#5857: a FIFO at .gsd/.gitignore" and "#5857: a FIFO at the fork-probe cache path" - create a real FIFO with mkfifo, which does not exist on Windows (skipped there) (raw-child-process)
 * - "observeHarnessForkFromHead default cache writer" - the fork-probe cache rows (1-6): real symlinks (symlink-keyword) and a real git repo with a linked worktree (raw-child-process); kept in this one platform file so the conformance tier grows by one file, not two
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup, runGsdTools } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runHook, runNode, OUTCOME } = require('./helpers/process-seam.cjs');

const { ensureToolOwnedGsdDir } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'gsd-tool-dir.cjs'),
);
const { observeHarnessForkFromHead } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs'),
);

const { splitLines } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'text-lines.cjs'),
);

const OPTIONS = { marker: '# gsd-core test owner', rules: ['/thing.json', '/.gitignore'] };

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(cwd, args) {
  return execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS }).trim();
}

/** Create a FIFO through the process seam (a bounded spawn), failing the test on any error. */
function makeFifo(file) {
  const made = runHook(file, [], { interpreter: 'mkfifo' });
  assert.strictEqual(made.outcome, OUTCOME.EXITED, `mkfifo did not run: ${made.outcome}`);
  assert.strictEqual(made.exitCode, 0, made.stderr);
}

function freshRepo() {
  const root = tmp('gsd-5757-owner-');
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

describe('ensureToolOwnedGsdDir symlink refusal (#5757)', () => {
  test('#5757: throws when .gsd is a symlink and writes nothing through it (case 7)', (t) => {
    const root = tmp('gsd-5757-owner-');
    const outside = tmp('gsd-5757-outside-');
    t.after(() => cleanup(root));
    t.after(() => cleanup(outside));
    fs.symlinkSync(outside, path.join(root, '.gsd'), 'dir');
    assert.throws(() => ensureToolOwnedGsdDir(root, OPTIONS), /symlink|outside the project/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  test('#5757: throws when .gsd/.gitignore is a symlink and leaves the target untouched (case 8)', (t) => {
    const root = tmp('gsd-5757-owner-');
    const outside = tmp('gsd-5757-outside-');
    t.after(() => cleanup(root));
    t.after(() => cleanup(outside));
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'precious\n');
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.symlinkSync(target, path.join(root, '.gsd', '.gitignore'));
    assert.throws(() => ensureToolOwnedGsdDir(root, OPTIONS), /symlink/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'precious\n');
  });
});

describe('#5757 case 13: parity - sentinel writer and probe writer share one policy', () => {
  function sentinel(root) {
    const result = runGsdTools(['record-dispatch-isolation', '--isolation', 'none'], root);
    return JSON.parse(result.output);
  }

  function probe(root) {
    fs.mkdirSync(path.join(root, '.claude', 'worktrees'), { recursive: true });
    const wt = path.join(root, '.claude', 'worktrees', 'agent-a');
    if (!fs.existsSync(wt)) git(root, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
    return observeHarnessForkFromHead({ cwd: root, headSha: git(root, ['rev-parse', 'HEAD']) });
  }

  test('both refuse to write through a symlinked .gsd', (t) => {
    const sentinelRoot = freshRepo();
    const probeRoot = freshRepo();
    const outside = tmp('gsd-5757-outside-');
    t.after(() => cleanup(sentinelRoot));
    t.after(() => cleanup(probeRoot));
    t.after(() => cleanup(outside));
    fs.symlinkSync(outside, path.join(sentinelRoot, '.gsd'), 'dir');
    fs.symlinkSync(outside, path.join(probeRoot, '.gsd'), 'dir');
    assert.strictEqual(sentinel(sentinelRoot).recorded, false);
    assert.strictEqual(probe(probeRoot).confirmed, true);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  test('both leave .gsd ignored in a fresh repository', (t) => {
    const sentinelRoot = freshRepo();
    const probeRoot = freshRepo();
    t.after(() => cleanup(sentinelRoot));
    t.after(() => cleanup(probeRoot));
    assert.strictEqual(sentinel(sentinelRoot).recorded, true);
    assert.strictEqual(probe(probeRoot).confirmed, true);
    for (const root of [sentinelRoot, probeRoot]) {
      const lines = git(root, ['status', '--porcelain']).split('\n').filter((l) => l.includes('.gsd'));
      assert.deepStrictEqual(lines, [], root);
    }
  });

  test('both writers extend one user ignore file once each and keep the user prefix', (t) => {
    const root = freshRepo();
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    const userRules = 'user-rule/\n';
    fs.writeFileSync(ignorePath, userRules);
    assert.strictEqual(sentinel(root).recorded, true);
    assert.strictEqual(probe(root).confirmed, true);
    // A second round must not duplicate either block.
    assert.strictEqual(sentinel(root).recorded, true);
    const text = fs.readFileSync(ignorePath, 'utf8');
    const lines = text.split(/\r?\n/);
    const count = (line) => lines.filter((l) => l === line).length;
    assert.ok(text.startsWith(userRules), 'user lines stay a verbatim prefix');
    assert.strictEqual(count('# gsd-core dispatch sentinel'), 1);
    assert.strictEqual(count('# gsd-core harness fork probe'), 1);
    assert.strictEqual(count('/.gitignore'), 1);
    const statusLines = git(root, ['status', '--porcelain']).split('\n').filter((l) => l.includes('.gsd'));
    assert.deepStrictEqual(statusLines, []);
  });

  test('sentinel temp write is exclusive: a link planted at the exact temp name is not written through, not unlinked, and recorded:false', (t) => {
    const root = freshRepo();
    const outside = tmp('gsd-5757-outside-');
    const preloadDir = tmp('gsd-5757-preload-');
    t.after(() => cleanup(root));
    t.after(() => cleanup(outside));
    t.after(() => cleanup(preloadDir));
    // The writer runs in a child process, so its temp name is made
    // deterministic by a preload that pins pid, Date.now and randomBytes to
    // values that spell the SAME name for the legacy (pid-Date.now) and the
    // current (pid-randomhex) schemes: 123456789012 == hex of bytes 12 34 56 78 90 12.
    const preload = path.join(preloadDir, 'pin-tmp-name.cjs');
    fs.writeFileSync(preload, [
      "Object.defineProperty(process, 'pid', { value: 4242 });",
      'Date.now = () => 123456789012;',
      "const crypto = require('node:crypto');",
      "crypto.randomBytes = () => Buffer.from('123456789012', 'hex');",
      '',
    ].join('\n'));
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    const planted = path.join(root, '.gsd', 'dispatch-isolation-sentinel.json.tmp-4242-123456789012');
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.symlinkSync(victim, planted);
    const result = runGsdTools(
      ['record-dispatch-isolation', '--isolation', 'none'],
      root,
      { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(preload)}`].filter(Boolean).join(' ') },
    );
    assert.strictEqual(JSON.parse(result.output).recorded, false);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original');
    assert.strictEqual(fs.lstatSync(planted).isSymbolicLink(), true, 'a link this process did not create is left alone');
    const leftovers = fs.readdirSync(path.join(root, '.gsd'))
      .filter((n) => n.startsWith('dispatch-isolation-sentinel.json.tmp-') && path.join(root, '.gsd', n) !== planted);
    assert.deepStrictEqual(leftovers, []);
  });

  test('sentinel refusals keep their historical error text (symlinked .gsd and symlinked .gitignore)', (t) => {
    const dirRoot = freshRepo();
    const ignoreRoot = freshRepo();
    const outside = tmp('gsd-5757-outside-');
    t.after(() => cleanup(dirRoot));
    t.after(() => cleanup(ignoreRoot));
    t.after(() => cleanup(outside));
    fs.symlinkSync(outside, path.join(dirRoot, '.gsd'), 'dir');
    assert.match(sentinel(dirRoot).error, /sentinel directory is a symlink/);
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'precious\n');
    fs.mkdirSync(path.join(ignoreRoot, '.gsd'));
    fs.symlinkSync(target, path.join(ignoreRoot, '.gsd', '.gitignore'));
    assert.match(sentinel(ignoreRoot).error, /sentinel ignore file is a symlink/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'precious\n');
  });

  test('#5857: a FIFO at .gsd/.gitignore does not hang the sentinel writer and is left alone', (t) => {
    if (process.platform === 'win32') {
      t.skip('no FIFOs on win32');
      return;
    }
    const root = freshRepo();
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.gsd'));
    const fifo = path.join(root, '.gsd', '.gitignore');
    makeFifo(fifo);
    const result = sentinel(root);
    assert.strictEqual(result.recorded, true);
    assert.ok(fs.existsSync(path.join(root, '.gsd', 'dispatch-isolation-sentinel.json')));
    assert.ok(fs.lstatSync(fifo).isFIFO(), 'the FIFO is neither replaced nor read');
  });
});

describe('observeHarnessForkFromHead default cache writer (#5757)', () => {
  /** Fresh git repo with one commit and a linked harness worktree at HEAD. */
  function makeProject() {
    const root = freshRepo();
    fs.mkdirSync(path.join(root, '.claude', 'worktrees'), { recursive: true });
    git(root, ['worktree', 'add', '-q', '--detach', path.join(root, '.claude', 'worktrees', 'agent-a'), 'HEAD']);
    return { root, head: git(root, ['rev-parse', 'HEAD']) };
  }

  function gsdStatusLines(root) {
    return git(root, ['status', '--porcelain']).split('\n').filter((l) => l.includes('.gsd'));
  }

  test('#5757: confirmed probe in a fresh repo ignores .gsd in git (case 1)', (t) => {
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    const result = observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(result.confirmed, true);
    assert.strictEqual(result.source, 'probe');
    assert.ok(fs.existsSync(path.join(root, '.gsd', 'harness-fork-probe.json')));
    assert.ok(fs.existsSync(path.join(root, '.gsd', '.gitignore')));
    assert.deepStrictEqual(gsdStatusLines(root), []);
  });

  test('#5857: a FIFO at the fork-probe cache path does not hang the probe and counts as no cache', (t) => {
    if (process.platform === 'win32') {
      t.skip('no FIFOs on win32');
      return;
    }
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.gsd'));
    makeFifo(path.join(root, '.gsd', 'harness-fork-probe.json'));
    // A child process: with the bug present the cache read blocks forever, and an in-process call would hang the runner.
    const script = [
      `const { observeHarnessForkFromHead } = require(${JSON.stringify(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs'))});`,
      `process.stdout.write(JSON.stringify(observeHarnessForkFromHead({ cwd: ${JSON.stringify(root)}, headSha: ${JSON.stringify(head)} })));`,
    ].join('\n');
    const ran = runNode(['-e', script], { cwd: root });
    assert.strictEqual(ran.outcome, OUTCOME.EXITED, `the probe did not return: ${ran.outcome}`);
    const verdict = JSON.parse(ran.stdout);
    assert.strictEqual(verdict.confirmed, true);
    assert.strictEqual(verdict.source, 'probe');
  });

  test('#5757: a symlinked .gsd is never written through; the verdict still returns (case 2)', (t) => {
    const { root, head } = makeProject();
    const outside = tmp('gsd-5757-outside-');
    t.after(() => cleanup(root));
    t.after(() => cleanup(outside));
    fs.symlinkSync(outside, path.join(root, '.gsd'), 'dir');
    const result = observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(result.confirmed, true);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  test('#5757: a symlinked cache file is never written through (case 3)', (t) => {
    const { root, head } = makeProject();
    const outsideDir = tmp('gsd-5757-outside-');
    t.after(() => cleanup(root));
    t.after(() => cleanup(outsideDir));
    const victim = path.join(outsideDir, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.symlinkSync(victim, path.join(root, '.gsd', 'harness-fork-probe.json'));
    const result = observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(result.confirmed, true);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original');
    // The planted link was replaced by a regular cache file, not followed.
    const cacheFile = path.join(root, '.gsd', 'harness-fork-probe.json');
    assert.strictEqual(fs.lstatSync(cacheFile).isFile(), true);
  });

  test('#5757: an existing user .gitignore without a catch-all keeps its rules and gains the probe rules once (case 4)', (t) => {
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    const userRules = '# mine\nkeep-me.txt\n!also-mine\n';
    fs.writeFileSync(ignorePath, userRules);
    observeHarnessForkFromHead({ cwd: root, headSha: head });
    const after = fs.readFileSync(ignorePath, 'utf8');
    assert.ok(after.startsWith(userRules), 'user lines stay a verbatim prefix');
    assert.ok(splitLines(after).includes('/harness-fork-probe.json'));
    // Probe again with the cache removed: the block is not duplicated.
    cleanup(path.join(root, '.gsd', 'harness-fork-probe.json'));
    observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(fs.readFileSync(ignorePath, 'utf8'), after);
    assert.deepStrictEqual(gsdStatusLines(root), []);
  });

  test('#5757: an existing catch-all .gitignore is left byte-for-byte unchanged (case 5)', (t) => {
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.writeFileSync(ignorePath, '*\n');
    observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(fs.readFileSync(ignorePath, 'utf8'), '*\n');
    assert.ok(fs.existsSync(path.join(root, '.gsd', 'harness-fork-probe.json')));
  });

  test('#5757: injected stateRead/stateWrite are called with the cache path and nothing hits disk (case 6)', (t) => {
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    const reads = [];
    const writes = [];
    const result = observeHarnessForkFromHead({
      cwd: root,
      headSha: head,
      stateRead: (file) => { reads.push(file); return null; },
      stateWrite: (file, content) => { writes.push([file, content]); },
    });
    const cacheFile = path.join(root, '.gsd', 'harness-fork-probe.json');
    assert.strictEqual(result.confirmed, true);
    assert.deepStrictEqual(reads, [cacheFile]);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0][0], cacheFile);
    assert.strictEqual(JSON.parse(writes[0][1]).headSha, head);
    assert.strictEqual(fs.existsSync(path.join(root, '.gsd')), false);
  });
});

describe('#5856: the ignore-file owner leaves nothing untracked when it dies mid-merge', () => {
  const MERGE_OPTIONS = { marker: '# gsd-core test owner', rules: ['/thing.json', '/.gitignore'] };

  function gsdStatusLines(root) {
    return git(root, ['status', '--porcelain', '-uall']).split('\n').filter((l) => l.includes('.gsd'));
  }

  // A SIGKILL runs no `finally`: each row fails one step of the staged merge and
  // makes every cleanup primitive a no-op until the mocks are restored right
  // after the call, so the residue a real kill would leave stays on disk.
  const KILL_POINTS = [
    {
      name: 'right after the staging directory is created',
      patch: (t, real) => t.mock.method(fs, 'writeFileSync', function writeFileSync(file) {
        if (String(file).includes(`${path.sep}.gitignore.tmp-`) && String(file).endsWith(`${path.sep}.gitignore`)) {
          throw new Error('simulated kill');
        }
        return real.writeFileSync.apply(this, arguments);
      }),
    },
    {
      name: 'after the staged ignore file is written',
      patch: (t, real) => t.mock.method(fs, 'openSync', function openSync(file) {
        if (String(file).endsWith(`${path.sep}content`)) throw new Error('simulated kill');
        return real.openSync.apply(this, arguments);
      }),
    },
    {
      name: 'at the ignore-file rename',
      patch: (t, real) => t.mock.method(fs, 'renameSync', function renameSync(from, to) {
        if (String(to).endsWith(`${path.sep}.gitignore`)) throw new Error('simulated kill');
        return real.renameSync.apply(this, arguments);
      }),
    },
  ];

  for (const point of KILL_POINTS) {
    test(`#5856: a kill ${point.name} leaves no untracked file in git status`, (t) => {
      const root = freshRepo();
      t.after(() => cleanup(root));
      fs.mkdirSync(path.join(root, '.gsd'));
      fs.writeFileSync(path.join(root, '.gsd', '.gitignore'), 'user-rule/\n');
      const real = { writeFileSync: fs.writeFileSync, openSync: fs.openSync, renameSync: fs.renameSync };
      const mocks = [
        point.patch(t, real),
        t.mock.method(fs, 'unlinkSync', () => {}),
        t.mock.method(fs, 'rmdirSync', () => {}),
        t.mock.method(fs, 'rmSync', () => {}),
      ];
      ensureToolOwnedGsdDir(root, MERGE_OPTIONS);
      for (const m of mocks) m.mock.restore();
      const residue = fs.readdirSync(path.join(root, '.gsd')).filter((n) => n.startsWith('.gitignore.tmp-'));
      assert.strictEqual(residue.length, 1, 'the killed merge left its staging directory behind');
      assert.deepStrictEqual(gsdStatusLines(root).filter((l) => l.includes('.gitignore.tmp')), []);
      assert.strictEqual(fs.readFileSync(path.join(root, '.gsd', '.gitignore'), 'utf8'), 'user-rule/\n');
    });
  }

  test('#5856: the merged ignore file ignores the owner temp name', (t) => {
    const root = freshRepo();
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.writeFileSync(path.join(root, '.gsd', '.gitignore'), 'user-rule/\n');
    ensureToolOwnedGsdDir(root, MERGE_OPTIONS);
    const probe = '.gsd/.gitignore.tmp-4242-abcdef012345';
    fs.writeFileSync(path.join(root, probe), 'x');
    assert.strictEqual(git(root, ['check-ignore', probe]), probe);
  });
});
