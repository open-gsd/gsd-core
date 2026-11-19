/**
 * Tests for the checks of scripts/check-env.cjs (#117, #6375).
 *
 * Every test calls `collectChecks` in this process with a stand-in for npm,
 * so none of them starts the real npm: a cold npm on a Windows runner took
 * longer than the 30 s the old spawned tests allowed (#6375). The stand-in
 * also records its calls, which pins the two argument lists the script hands
 * to npm.
 *
 * What only a process shows (exit code, report text, `--json` framing) is in
 * tests/check-env.process.test.cjs.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const fc = require('fast-check');

const { collectChecks, satisfiesConstraint } = require('../scripts/check-env.cjs');
const { describeNpmVersionCheckFailure } = require('../scripts/lib/npm-version-check-diagnosis.cjs');

const LIVE_ROOT = path.resolve(__dirname, '..');
const NODE = 'v24.3.0';

const VERSION_ARGS = ['--version'];
const SYNC_ARGS = ['ci', '--dry-run', '--ignore-scripts'];

/**
 * A stand-in for `spawnSync` that answers the script's two npm calls and
 * throws on any other, so an unplanned call fails the test that made it.
 */
function fakeNpm({ version = { status: 0, stdout: '11.0.0\n' }, sync = { status: 0 } } = {}) {
  const calls = [];
  const answer = (reply) => (typeof reply === 'function' ? reply() : reply);
  const run = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (args.join(' ') === VERSION_ARGS.join(' ')) return answer(version);
    if (args.join(' ') === SYNC_ARGS.join(' ')) return answer(sync);
    throw new Error(`unplanned call: ${command} ${args.join(' ')}`);
  };
  return { run, calls };
}

const statusOf = (result, name) => {
  const row = result.checks.find((c) => c.name === name);
  assert.ok(row, `no "${name}" row in ${JSON.stringify(result.checks)}`);
  return row.status;
};
const messageOf = (result, name) => result.checks.find((c) => c.name === name).message;

describe('check-env.cjs checks', () => {
  let root;
  const dirs = {};

  /** One project directory; `files` maps a file name to its text. */
  function project(name, { engines, lockfile = true, files = {} }) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', engines }));
    if (lockfile) fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name, lockfileVersion: 3 }));
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
    dirs[name] = dir;
  }

  before(() => {
    root = createTempDir('gsd-check-env-');
    const engines = { node: '>=22.0.0', npm: '>=9.0.0' };
    project('good', { engines, files: { '.nvmrc': '24\n' } });
    project('old-node-only', { engines: { node: '<14.0.0' } });
    project('no-engines', { engines: undefined });
    project('no-lockfile', { engines, lockfile: false });
    project('no-pin', { engines });
    project('nvmrc-other-major', { engines, files: { '.nvmrc': 'v23.1.0\n' } });
    project('node-version-file', { engines, files: { '.node-version': '24.0.0\n' } });
    project('tool-versions', { engines, files: { '.tool-versions': 'python 3.12.0\nnodejs 24.1.0\n' } });
    project('tool-versions-no-node', { engines, files: { '.tool-versions': 'python 3.12.0\n' } });
    project('node-engine-only', { engines: { node: '>=22.0.0' } });
    project('pin-property', { engines });
  });

  after(() => cleanup(root));

  const check = (name, npm, overrides = {}) => collectChecks({
    projectRoot: dirs[name], run: npm.run, nodeVersion: NODE, env: {}, platform: 'linux', ...overrides,
  });

  test('every check passes for matching engines, lockfile and .nvmrc', () => {
    const npm = fakeNpm();
    const result = check('good', npm);
    assert.equal(result.pass, true);
    assert.deepEqual(
      result.checks.map((c) => [c.name, c.status]),
      [
        ['node-version', 'pass'],
        ['npm-version', 'pass'],
        ['lockfile-present', 'pass'],
        ['lockfile-sync', 'pass'],
        ['version-manager-pin', 'pass'],
      ],
    );
  });

  test('npm is called twice, with the version and lockfile-sync arguments', () => {
    const npm = fakeNpm();
    check('good', npm);
    assert.deepEqual(npm.calls.map((c) => [c.command, c.args]), [['npm', VERSION_ARGS], ['npm', SYNC_ARGS]]);
    assert.equal(npm.calls[0].options.shell, false);
    assert.equal(npm.calls[1].options.shell, false);
    assert.equal(npm.calls[1].options.cwd, dirs.good);
    for (const call of npm.calls) assert.equal(call.options.encoding, 'utf8');
    // The version call is bounded; the value is the script's to choose.
    assert.ok(Number.isInteger(npm.calls[0].options.timeout) && npm.calls[0].options.timeout > 0);
  });

  test('a call without a runner throws instead of starting the real npm', () => {
    assert.throws(() => collectChecks({ projectRoot: dirs.good }), TypeError);
    assert.throws(() => collectChecks({ projectRoot: dirs.good, run: undefined }), TypeError);
  });

  test('on win32 npm is npm.cmd, run through the shell', () => {
    const npm = fakeNpm();
    const result = check('good', npm, { platform: 'win32' });
    assert.equal(result.pass, true);
    assert.deepEqual(npm.calls.map((c) => [c.command, c.options.shell]), [['npm.cmd', true], ['npm.cmd', true]]);
  });

  describe('node-version', () => {
    test('fails when the running Node does not satisfy engines.node', () => {
      const result = check('old-node-only', fakeNpm());
      assert.equal(statusOf(result, 'node-version'), 'fail');
      assert.equal(result.pass, false);
    });

    test('fails when package.json has no engines.node', () => {
      const result = check('no-engines', fakeNpm());
      assert.equal(statusOf(result, 'node-version'), 'fail');
      assert.equal(result.pass, false);
    });

    for (const [nodeVersion, expected] of [['v21.9.9', 'fail'], ['v22.0.0', 'pass'], ['v22.0.1', 'pass']]) {
      test(`Node ${nodeVersion} against >=22.0.0 is a ${expected}`, () => {
        assert.equal(statusOf(check('no-pin', fakeNpm(), { nodeVersion }), 'node-version'), expected);
      });
    }
  });

  describe('npm-version', () => {
    test('is skipped when package.json has no engines.npm', () => {
      assert.equal(statusOf(check('node-engine-only', fakeNpm()), 'npm-version'), 'skip');
    });

    for (const [npmVersion, expected] of [['8.19.4', 'fail'], ['9.0.0', 'pass'], ['9.0.1', 'pass']]) {
      test(`npm ${npmVersion} against >=9.0.0 is a ${expected}`, () => {
        const npm = fakeNpm({ version: { status: 0, stdout: `${npmVersion}\n` } });
        assert.equal(statusOf(check('no-pin', npm), 'npm-version'), expected);
      });
    }

    // The wording belongs to describeNpmVersionCheckFailure and is tested with
    // it; these two pin that the check hands it what the runner returned.
    test('a timed-out npm --version fails the check with the timed-out diagnosis', () => {
      const error = Object.assign(new Error('spawnSync npm ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const npm = fakeNpm({ version: { status: null, stdout: '', signal: 'SIGTERM', error } });
      const result = check('no-pin', npm);
      assert.equal(statusOf(result, 'npm-version'), 'fail');
      assert.equal(
        messageOf(result, 'npm-version'),
        describeNpmVersionCheckFailure({ exitCode: 1, stdout: '', signal: 'SIGTERM', error, timedOut: true }),
      );
      assert.notEqual(
        messageOf(result, 'npm-version'),
        describeNpmVersionCheckFailure({ exitCode: 1, stdout: '', signal: 'SIGTERM', error, timedOut: false }),
      );
      assert.equal(result.pass, false);
    });

    test('a missing npm binary fails the check with the not-found diagnosis', () => {
      const error = Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' });
      const npm = fakeNpm({ version: { status: null, stdout: '', signal: null, error } });
      const result = check('no-pin', npm);
      assert.equal(statusOf(result, 'npm-version'), 'fail');
      assert.equal(
        messageOf(result, 'npm-version'),
        describeNpmVersionCheckFailure({ exitCode: 1, stdout: '', signal: null, error, timedOut: false }),
      );
      assert.notEqual(
        messageOf(result, 'npm-version'),
        describeNpmVersionCheckFailure({ exitCode: 1, stdout: '', signal: 'SIGTERM', error: null, timedOut: true }),
      );
    });
  });

  describe('lockfile', () => {
    test('a missing package-lock.json fails presence, skips sync and never asks npm to sync', () => {
      const npm = fakeNpm();
      const result = check('no-lockfile', npm);
      assert.equal(statusOf(result, 'lockfile-present'), 'fail');
      assert.equal(statusOf(result, 'lockfile-sync'), 'skip');
      assert.equal(result.pass, false);
      assert.deepEqual(npm.calls.map((c) => c.args), [VERSION_ARGS]);
    });

    test('a non-zero npm ci --dry-run fails the sync check', () => {
      const result = check('no-pin', fakeNpm({ sync: { status: 1 } }));
      assert.equal(statusOf(result, 'lockfile-present'), 'pass');
      assert.equal(statusOf(result, 'lockfile-sync'), 'fail');
      assert.equal(result.pass, false);
    });

    test('an npm ci --dry-run that ends without an exit status fails the sync check', () => {
      const result = check('no-pin', fakeNpm({ sync: { status: null, signal: 'SIGTERM' } }));
      assert.equal(statusOf(result, 'lockfile-sync'), 'fail');
    });

    test('a runner that throws on npm ci --dry-run fails the sync check', () => {
      const npm = fakeNpm({ sync: () => { throw new Error('spawn failed'); } });
      assert.equal(statusOf(check('no-pin', npm), 'lockfile-sync'), 'fail');
    });
  });

  describe('version-manager-pin', () => {
    test('is skipped when no pin file exists', () => {
      assert.equal(statusOf(check('no-pin', fakeNpm()), 'version-manager-pin'), 'skip');
    });

    test('fails when the .nvmrc major differs from the running Node', () => {
      const result = check('nvmrc-other-major', fakeNpm());
      assert.equal(statusOf(result, 'version-manager-pin'), 'fail');
      assert.equal(result.pass, false);
    });

    test('is skipped under CI=true even when the pin differs', () => {
      const result = check('nvmrc-other-major', fakeNpm(), { env: { CI: 'true' } });
      assert.equal(statusOf(result, 'version-manager-pin'), 'skip');
      assert.equal(result.pass, true);
    });

    test('reads .node-version', () => {
      assert.equal(statusOf(check('node-version-file', fakeNpm()), 'version-manager-pin'), 'pass');
      assert.equal(statusOf(check('node-version-file', fakeNpm(), { nodeVersion: 'v25.0.0' }), 'version-manager-pin'), 'fail');
    });

    test('reads the nodejs line of .tool-versions', () => {
      assert.equal(statusOf(check('tool-versions', fakeNpm()), 'version-manager-pin'), 'pass');
      assert.equal(statusOf(check('tool-versions', fakeNpm(), { nodeVersion: 'v25.0.0' }), 'version-manager-pin'), 'fail');
    });

    test('is skipped when .tool-versions has no nodejs line', () => {
      assert.equal(statusOf(check('tool-versions-no-node', fakeNpm()), 'version-manager-pin'), 'skip');
    });
  });

  test('a pin file passes exactly when its major is the running Node major', () => {
    const dir = dirs['pin-property'];
    // The running major is the pinned one or a neighbour, so both outcomes occur.
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 99 }), fc.constantFrom(-1, 0, 0, 1), fc.constantFrom('', 'v'), fc.constantFrom('', '.4', '.4.2'),
      fc.constantFrom('.nvmrc', '.node-version', '.tool-versions'),
      (pinned, offset, prefix, rest, file) => {
        const running = pinned + offset;
        const version = `${prefix}${pinned}${rest}`;
        fs.writeFileSync(path.join(dir, file), file === '.tool-versions' ? `nodejs ${version}\n` : `${version}\n`);
        try {
          const result = check('pin-property', fakeNpm(), { nodeVersion: `v${running}.0.0` });
          assert.equal(statusOf(result, 'version-manager-pin'), pinned === running ? 'pass' : 'fail');
        } finally {
          fs.unlinkSync(path.join(dir, file));
        }
      },
    ), { numRuns: 60 });
  });

  test('every row has a name, a known status and a message', () => {
    for (const name of Object.keys(dirs)) {
      for (const row of check(name, fakeNpm()).checks) {
        assert.deepEqual(Object.keys(row).sort(), ['message', 'name', 'status']);
        assert.equal(typeof row.name, 'string');
        assert.equal(typeof row.message, 'string');
        assert.ok(['pass', 'fail', 'skip'].includes(row.status), `status ${row.status} in ${name}`);
      }
    }
  });

  test('this repository passes the Node and lockfile checks with the running Node', () => {
    const npm = fakeNpm();
    const result = collectChecks({ projectRoot: LIVE_ROOT, run: npm.run });
    assert.equal(statusOf(result, 'node-version'), 'pass', messageOf(result, 'node-version'));
    assert.equal(statusOf(result, 'lockfile-present'), 'pass');
    assert.equal(npm.calls.length, 2);
  });
});

describe('satisfiesConstraint', () => {
  // The oracle orders two versions as zero-padded text, so it shares no
  // arithmetic with the code, which compares numbers part by part.
  const padded = (parts) => parts.map((n) => String(n).padStart(8, '0')).join('.');
  const order = (a, b) => (padded(a) === padded(b) ? 0 : padded(a) < padded(b) ? -1 : 1);
  const holds = { '>=': (o) => o >= 0, '>': (o) => o > 0, '<=': (o) => o <= 0, '<': (o) => o < 0, '=': (o) => o === 0 };
  const part = fc.oneof(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 99_999 }));
  const triple = fc.tuple(part, part, part);
  // Two independent triples almost never tie or differ in one part only, so
  // half the pairs are a version and a neighbour of it (or itself).
  const nudge = fc.tuple(fc.constantFrom(0, 1, 2), fc.constantFrom(-1, 0, 1));
  const pair = fc.oneof(
    fc.tuple(triple, triple),
    fc.tuple(triple, nudge).map(([version, [index, by]]) => {
      const required = [...version];
      required[index] = Math.max(0, required[index] + by);
      return [version, required];
    }),
  );

  test('agrees with a part-by-part comparison for every operator', () => {
    fc.assert(fc.property(
      pair, fc.constantFrom('>=', '>', '<=', '<', '='), fc.boolean(), fc.constantFrom('', '-rc.1', '+build.5'),
      ([version, required], op, vPrefix, suffix) => {
        const text = `${vPrefix ? 'v' : ''}${version.join('.')}${suffix}`;
        assert.equal(satisfiesConstraint(text, `${op}${required.join('.')}`), holds[op](order(version, required)));
      },
    ));
  });

  test('a constraint with no operator means equality', () => {
    fc.assert(fc.property(pair, ([version, required]) => {
      assert.equal(satisfiesConstraint(version.join('.'), required.join('.')), order(version, required) === 0);
    }));
  });

  test('a part of 1000 or more does not carry into the next part', () => {
    assert.equal(satisfiesConstraint('1.1000.0', '=2.0.0'), false);
    assert.equal(satisfiesConstraint('1.1000.0', '<2.0.0'), true);
    assert.equal(satisfiesConstraint('1.0.1000', '>=1.1.0'), false);
  });

  test('a missing minor or patch counts as zero', () => {
    assert.equal(satisfiesConstraint('24', '>=24.0.0'), true);
    assert.equal(satisfiesConstraint('24.1', '>24.0.9'), true);
    assert.equal(satisfiesConstraint('24.0.0', '>=24'), true);
    assert.equal(satisfiesConstraint('23.9.9', '>=24'), false);
  });
});
