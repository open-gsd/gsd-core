const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { CROSS_PLATFORM_TEST_REASON, runCrossPlatformTests } = require('../scripts/run-cross-platform-tests.cjs');

describe('run cross-platform tests module', () => {
  test('returns pass reason on zero exit', () => {
    const out = runCrossPlatformTests({}, {
      spawnSync: () => ({ status: 0, stdout: 'ok', stderr: '' }),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.reason, CROSS_PLATFORM_TEST_REASON.PASS);
    assert.ok(out.command.includes('--base next'));
  });

  test('classifies infrastructure failure', () => {
    const out = runCrossPlatformTests({}, {
      spawnSync: () => ({ status: 2, stdout: '', stderr: 'infrastructure failure' }),
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, CROSS_PLATFORM_TEST_REASON.INFRA_FAILURE);
  });

  test('classifies test failure from FAIL marker', () => {
    const out = runCrossPlatformTests({}, {
      spawnSync: () => ({ status: 1, stdout: 'linux FAIL 1/2 tests (1 failures)', stderr: '' }),
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, CROSS_PLATFORM_TEST_REASON.TEST_FAILURE);
  });

  test('passes options through to command args', () => {
    let cmd = null;
    let args = null;
    runCrossPlatformTests({ base: 'main', head: 'abc123', source: '/tmp/x', targets: 'linux' }, {
      spawnSync: (c, a) => {
        cmd = c;
        args = a;
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    assert.strictEqual(cmd, 'gsd-test');
    assert.deepStrictEqual(args, ['--targets', 'linux', '--base', 'main', '--head', 'abc123', '--source', '/tmp/x']);
  });
});
