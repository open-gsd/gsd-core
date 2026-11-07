'use strict';

// #5019: the lane-evidence verbs (persist, read, clear) are the one owner of the persisted
// external-reviewer evidence. State lives under TMPDIR keyed to the review path; these tests call
// the functions through their tmpDir seam (no bash, so Windows lanes run them), the CLI once, and, off win32, the reviewer-hop harness through the shipped fences.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const { persistLaneEvidence, readLaneEvidence, clearLaneEvidence, cmdLaneEvidencePersist } = require('../gsd-core/bin/lib/lane-evidence.cjs');

const BLOCK = '<external_reviewer_evidence>X</external_reviewer_evidence>';
const symlink = (target, link) => { try { fs.symlinkSync(target, link); return true; } catch { return false; } };

const sandbox = require('./helpers/lane-sandbox.cjs');
const age = (file, minutes) => { const d = new Date(Date.now() - minutes * 60000); fs.utimesSync(file, d, d); };

describe('#5019 lane-evidence verbs', () => {
  test('persist then read returns the block', (t) => {
    const sb = sandbox(t);
    sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    assert.strictEqual(fs.readFileSync(sb.state, 'utf8'), `abc123\nauto\n${BLOCK}`);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), BLOCK);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(sb.state).mode & 0o777, 0o600);
  });

  test('read accepts 359, rejects 360 and 361 minutes', (t) => {
    const sb = sandbox(t);
    sb.lane('abc123');
    for (const [min, ok] of [[359, true], [360, false], [361, false]]) {
      persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
      age(sb.state, min);
      assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), ok ? BLOCK : '', `${min} min old`);
    }
  });

  test('read refreshes the mtime so a long --auto loop keeps the state', (t) => {
    const sb = sandbox(t);
    sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    age(sb.state, 300);
    const aged = fs.statSync(sb.state).mtimeMs;
    readLaneEvidence(sb.review, sb.tmp);
    assert.ok(fs.statSync(sb.state).mtimeMs > aged);
  });

  test('read without a lane dir, or with a malformed state, yields nothing', (t) => {
    const sb = sandbox(t);
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp); // no lane dir exists
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
    sb.lane('abc123');
    fs.writeFileSync(sb.state, `abc12\nauto\n${BLOCK}`);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
  });

  test('CRLF line 1 is rejected by read and clear alike', (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    fs.writeFileSync(sb.state, `abc123\r\nauto\n${BLOCK}`);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [true, false], 'the dir a CR-tainted line names is never removed');
  });

  test('empty block persists nothing and removes the lane dir', (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', '', sb.tmp);
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [false, false]);
  });

  test('a failed state write removes the lane dir it would have pointed at', (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    fs.mkdirSync(sb.state); // a directory where the state file goes: the rename fails
    t.mock.method(process.stderr, 'write', () => true);
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    assert.strictEqual(fs.existsSync(d), false);
  });

  test('persist rejects an invalid suffix or mode as a usage error', (t) => {
    const sb = sandbox(t);
    for (const [suffix, mode] of [['abc12', 'auto'], ['abc1234', 'auto'], ['abc12/', 'auto'], ['abc123', 'AUTO'], ['abc123', ''], ['abc123', 'auto\nX'], ['abc123', 'once\n'], ['abc123\nauto\nx', 'auto']]) {
      assert.throws(() => persistLaneEvidence(sb.review, suffix, mode, BLOCK, sb.tmp), /Usage: lane-evidence-persist/, `${suffix}/${mode}`);
    }
    assert.strictEqual(fs.existsSync(sb.state), false);
  });

  test('read ignores a once state, which only a crashed non-auto run leaves behind', (t) => {
    const sb = sandbox(t);
    sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'once', BLOCK, sb.tmp);
    t.mock.method(process.stderr, 'write', () => true);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
  });

  test('a failed stdin read is an error exit that keeps the lane dir under a once state, which clear then removes', (t) => {
    const prevEnv = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }; // registered before the sandbox so it restores first: cleanup() reads TMPDIR
    t.after(() => { for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    const realRead = fs.readFileSync;
    const errors = [];
    t.mock.method(fs, 'readFileSync', (f, ...rest) => { if (f === 0) throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, read'), { code: 'EAGAIN' }); return realRead.call(fs, f, ...rest); });
    Object.assign(process.env, { TMPDIR: sb.tmp, TEMP: sb.tmp, TMP: sb.tmp });
    cmdLaneEvidencePersist([sb.review, 'abc123', 'auto'], (m) => errors.push(m));
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /could not read the block from stdin/);
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [true, true], 'a failed read is not "no evidence": the dir stays until clear');
    t.mock.method(process.stderr, 'write', () => true);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '', 'a once state is never re-surfaced');
    clearLaneEvidence(sb.review, { keepAuto: true, tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [false, false]);
  });

  test('an unreadable state fails soft in read and clear instead of throwing', (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    const realRead = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (f, ...rest) => { if (f === sb.state) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return realRead.call(fs, f, ...rest); });
    t.mock.method(process.stderr, 'write', () => true);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.strictEqual(fs.existsSync(sb.state), false, 'the unreadable state we own is removed');
    assert.strictEqual(fs.existsSync(d), true, 'what an unreadable state names is not trusted, so left alone');
  });

  test('clear --keep-auto keeps an auto state, removes once', (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    clearLaneEvidence(sb.review, { keepAuto: true, tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [true, true], 'auto kept');
    persistLaneEvidence(sb.review, 'abc123', 'once', BLOCK, sb.tmp);
    clearLaneEvidence(sb.review, { keepAuto: true, tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [false, false], 'once removed');
  });

  test('clear without the flag removes an auto state and its lane dir; absent state is a no-op', (t) => {
    const sb = sandbox(t);
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    const d = sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [false, false]);
    assert.strictEqual(fs.existsSync(path.join(sb.victim, 'keep')), true);
  });

  test('two reviews\' states are independent', (t) => {
    const sb = sandbox(t);
    const other = path.join(sb.dir, '02-REVIEW.md');
    sb.lane('abc123'); sb.lane('def456');
    persistLaneEvidence(sb.review, 'abc123', 'auto', 'one', sb.tmp);
    persistLaneEvidence(other, 'def456', 'auto', 'two', sb.tmp);
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
    assert.strictEqual(readLaneEvidence(other, sb.tmp), 'two');
  });

  test('symlinked state file or lane dir is never followed', (t) => {
    const sb = sandbox(t);
    const target = path.join(sb.dir, 'target'); fs.writeFileSync(target, `abc123\nauto\n${BLOCK}`);
    const d = sb.lane('abc123');
    if (!symlink(target, sb.state)) return t.skip('symlinks unavailable');
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '', 'symlinked state is not read');
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(target)], [true, true], 'neither the named dir nor the link target is removed');
    assert.throws(() => fs.lstatSync(sb.state), { code: 'ENOENT' }, 'the link itself is unlinked');
    cleanup(d);
    assert.ok(symlink(sb.victim, d));
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '', 'symlinked lane dir is not accepted');
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.strictEqual(fs.existsSync(path.join(sb.victim, 'keep')), true);
  });

  // A foreign owner is simulated by raising the uid of one lstat result, so the guard runs as non-root in CI.
  const foreign = (t, victim) => {
    const real = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (p, ...rest) => {
      const st = real.call(fs, p, ...rest);
      return p === victim ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1 }) : st;
    });
  };

  test('a foreign-owned state is ignored by read and clear', { skip: process.platform === 'win32' }, (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    foreign(t, sb.state);
    t.mock.method(process.stderr, 'write', () => true);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [true, true], 'foreign state is left alone');
  });

  test('a foreign-owned lane dir is not removed', { skip: process.platform === 'win32' }, (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    foreign(t, d);
    t.mock.method(process.stderr, 'write', () => true);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [true, false], 'foreign lane dir kept, owned state removed');
  });

  test('a lane dir that cannot be removed keeps its state, so a later clear still finds and removes both', (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    const realRm = fs.rmSync;
    const rm = t.mock.method(fs, 'rmSync', (p, ...rest) => { if (p === d) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return realRm.call(fs, p, ...rest); });
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [true, true], 'the state still names the dir');
    rm.mock.restore();
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [false, false]);
  });

  test('CLI parity: gsd-tools lane-evidence-persist/read/clear equal the direct calls', (t) => {
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    const env = { ...process.env, TMPDIR: sb.tmp, TEMP: sb.tmp, TMP: sb.tmp };
    const run = (args, input) => runNode([GSD_TOOLS, ...args], { env, ...(input !== undefined && { input }) });
    assert.strictEqual(run(['lane-evidence-persist', sb.review, 'abc123', 'auto'], BLOCK).exitCode, 0);
    assert.strictEqual(fs.readFileSync(sb.state, 'utf8'), `abc123\nauto\n${BLOCK}`);
    const read = run(['lane-evidence-read', sb.review]);
    assert.strictEqual(read.stdout, readLaneEvidence(sb.review, sb.tmp));
    assert.strictEqual(read.stdout, BLOCK);
    assert.strictEqual(run(['lane-evidence-persist', sb.review, 'bad', 'auto'], BLOCK).exitCode !== 0, true);
    assert.strictEqual(run(['lane-evidence-clear', sb.review, '--keep-auto']).exitCode, 0);
    assert.strictEqual(fs.existsSync(sb.state), true, '--keep-auto keeps an auto state');
    assert.strictEqual(run(['lane-evidence-clear', sb.review]).exitCode, 0);
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [false, false]);
  });

  test('persist, read and clear leave a git project tree and .git/info/exclude untouched', { skip: process.platform === 'win32' }, (t) => {
    const sb = sandbox(t);
    const project = path.join(sb.dir, 'project'); fs.mkdirSync(project);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const git = (...a) => runHook('-c', [`git -C "${project}" ${a.join(' ')}`], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, env });
    assert.strictEqual(git('init -q').exitCode, 0);
    const review = path.join(project, '01-REVIEW.md');
    const snap = () => [git('status --porcelain --ignored').stdout, fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8')];
    const before = snap();
    sb.lane('abc123');
    persistLaneEvidence(review, 'abc123', 'auto', BLOCK, sb.tmp);
    readLaneEvidence(review, sb.tmp);
    assert.deepStrictEqual(snap(), before);
    clearLaneEvidence(review, { tmpDir: sb.tmp });
    assert.deepStrictEqual(snap(), before);
    assert.deepStrictEqual(fs.readdirSync(project), ['.git']);
  });

  // The #5019 reviewer-hop harness stages and asserts the evidence through the shipped fences and the verbs:
  // dispatch, commit (--auto), then the generated head prompt must carry the block and the cited lane path.
  test('harness head prompt carries the evidence block', { skip: process.platform === 'win32' }, (t) => {
    const HARNESS = path.join(ROOT, 'docs', 'issueevidence', '5019-reviewer-hop-harness');
    const shipped = path.join(HARNESS, 'lib', 'shipped.cjs');
    for (const f of ['trial.sh', 'iter3.sh', 'build.sh']) {
      const r = runHook('-n', [path.join(HARNESS, f)], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
      assert.strictEqual(r.exitCode, 0, `${f}: ${r.stderr}`);
    }
    const project = sandbox(t).dir;
    for (const d of ['src', 'phase']) fs.mkdirSync(path.join(project, d));
    for (const f of ['config', 'lockout', 'messages', 'auth']) fs.copyFileSync(path.join(HARNESS, 'lib', 'fixture', `${f}.js`), path.join(project, 'src', `${f}.js`));
    const run = (verb) => {
      const gen = runNode([shipped, verb, ROOT, project, 'head'], {});
      assert.strictEqual(gen.exitCode, 0, `${verb}: ${gen.stderr}`);
      const r = runHook('-c', [gen.stdout], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS * 4, env: { ...process.env, TMPDIR: path.join(project, 'tmp') } });
      assert.strictEqual(r.exitCode, 0, `${verb}: ${r.stderr}`);
      return r.stdout;
    };
    run('dispatch');
    fs.copyFileSync(path.join(HARNESS, 'lib', 'fixture', '01-REVIEW.md'), path.join(project, 'phase', '01-REVIEW.md'));
    run('commit');
    const prompt = run('prompt');
    assert.match(prompt, /<external_reviewer_evidence>/);
    assert.ok(prompt.includes('gsd-review-cursor.md'), 'the cited lane path is in the prompt');
  });
});
