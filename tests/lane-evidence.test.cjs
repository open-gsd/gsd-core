'use strict';

// #5019: the lane-evidence verbs (persist, read, clear) are the one owner of the persisted
// external-reviewer evidence. State lives under TMPDIR keyed to the review path; these tests call
// the functions through their tmpDir seam (no bash, so Windows lanes run them) and the CLI once.

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
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), `${BLOCK}\n\n`);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(sb.state).mode & 0o777, 0o600);
  });

  test('read accepts 359, rejects 360 and 361 minutes', (t) => {
    const sb = sandbox(t);
    sb.lane('abc123');
    for (const [min, ok] of [[359, true], [360, false], [361, false]]) {
      persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
      age(sb.state, min);
      assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), ok ? `${BLOCK}\n\n` : '', `${min} min old`);
    }
  });

  test('read refreshes the mtime so a long --auto loop keeps the state', (t) => {
    const sb = sandbox(t);
    sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    age(sb.state, 300);
    readLaneEvidence(sb.review, sb.tmp);
    assert.ok(Date.now() - fs.statSync(sb.state).mtimeMs < 60000);
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
    assert.strictEqual(readLaneEvidence(other, sb.tmp), 'two\n\n');
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

  test('state or lane dir owned by another uid is ignored by read and clear', (t) => {
    if (process.platform === 'win32' || process.getuid() !== 0) return t.skip('needs root to create a foreign-owned entry');
    const sb = sandbox(t);
    const d = sb.lane('abc123');
    persistLaneEvidence(sb.review, 'abc123', 'auto', BLOCK, sb.tmp);
    fs.chownSync(sb.state, 12345, 12345);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.deepStrictEqual([fs.existsSync(d), fs.existsSync(sb.state)], [true, true], 'foreign state is left alone');
    fs.chownSync(sb.state, 0, 0); fs.chownSync(d, 12345, 12345);
    assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), '');
    clearLaneEvidence(sb.review, { tmpDir: sb.tmp });
    assert.strictEqual(fs.existsSync(d), true, 'foreign lane dir is not removed');
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
    assert.strictEqual(read.stdout, `${BLOCK}\n\n`);
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
});
