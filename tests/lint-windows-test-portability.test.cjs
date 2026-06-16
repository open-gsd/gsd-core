// windows-portability-ok: fixture strings for the lint's own unit test, not real execution
'use strict';

/**
 * Tests for scripts/lint-windows-test-portability.cjs
 *
 * Uses the exported `scanContent` pure function to avoid spawning real
 * subprocesses or touching the filesystem. This keeps the test portable and
 * prevents the lint from flagging itself (the opt-out comment above covers the
 * chmod/bash-c fixture strings below).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { scanContent } = require('../scripts/lint-windows-test-portability.cjs');

describe('lint-windows-test-portability: scanContent', () => {
  test('(a) chmod 0o755 + bash -c with no guard => violation', () => {
    const src = `
      'use strict';
      fs.chmodSync(fixture, 0o755);
      execFileSync('bash', ['-c', 'echo hi']);
    `;
    const result = scanContent(src);
    assert.strictEqual(result.makesExecutable, true, 'makesExecutable');
    assert.strictEqual(result.shellDashC, true, 'shellDashC');
    assert.strictEqual(result.guarded, false, 'guarded');
    assert.strictEqual(result.optOut, false, 'optOut');
    assert.strictEqual(result.violation, true, 'violation');
  });

  test('(b) chmod 0o755 + bash -c + process.platform guard => no violation', () => {
    const src = `
      'use strict';
      fs.chmodSync(fixture, 0o755);
      execFileSync('bash', ['-c', 'echo hi']);
      if (process.platform !== 'win32') { runIt(); }
    `;
    const result = scanContent(src);
    assert.strictEqual(result.makesExecutable, true, 'makesExecutable');
    assert.strictEqual(result.shellDashC, true, 'shellDashC');
    assert.strictEqual(result.guarded, true, 'guarded');
    assert.strictEqual(result.violation, false, 'violation');
  });

  test('(c) chmod 0o644 (no exec bit) + bash -c => no violation', () => {
    const src = `
      'use strict';
      fs.chmodSync(fixture, 0o644);
      execFileSync('bash', ['-c', 'cat file']);
    `;
    const result = scanContent(src);
    assert.strictEqual(result.makesExecutable, false, 'makesExecutable');
    assert.strictEqual(result.shellDashC, true, 'shellDashC');
    assert.strictEqual(result.violation, false, 'violation');
  });

  test('(d) chmod 0o755 + execFileSync(sh, [path]) with no -c => no violation', () => {
    const src = `
      'use strict';
      fs.chmodSync(fixture, 0o755);
      execFileSync('sh', [fixturePath]);
    `;
    const result = scanContent(src);
    assert.strictEqual(result.makesExecutable, true, 'makesExecutable');
    assert.strictEqual(result.shellDashC, false, 'shellDashC');
    assert.strictEqual(result.violation, false, 'violation');
  });

  test('(e) violation pattern + windows-portability-ok opt-out => no violation', () => {
    const src = `
      // windows-portability-ok: intentional cross-platform test
      'use strict';
      fs.chmodSync(fixture, 0o755);
      execFileSync('bash', ['-c', 'run']);
    `;
    const result = scanContent(src);
    assert.strictEqual(result.makesExecutable, true, 'makesExecutable');
    assert.strictEqual(result.shellDashC, true, 'shellDashC');
    assert.strictEqual(result.optOut, true, 'optOut');
    assert.strictEqual(result.violation, false, 'violation');
  });

  test('chmod 0o111 (pure exec bits) is detected as executable', () => {
    const src = `fs.chmodSync(f, 0o111); spawnSync('sh', ['-c', 'x']);`;
    const result = scanContent(src);
    assert.strictEqual(result.makesExecutable, true, 'makesExecutable');
    assert.strictEqual(result.shellDashC, true, 'shellDashC');
    assert.strictEqual(result.violation, true, 'violation');
  });

  test('chmod 0o444 (read-only) is not executable', () => {
    const src = `fs.chmodSync(f, 0o444); execFileSync('bash', ['-c', 'x']);`;
    const result = scanContent(src);
    assert.strictEqual(result.makesExecutable, false, 'makesExecutable');
    assert.strictEqual(result.violation, false, 'violation');
  });

  test('string-literal sh -c form is detected', () => {
    const src = `
      fs.chmodSync(f, 0o755);
      exec('sh -c "run.sh"');
    `;
    const result = scanContent(src);
    assert.strictEqual(result.shellDashC, true, 'shellDashC from string literal');
    assert.strictEqual(result.violation, true, 'violation');
  });

  test('/bin/bash prefix in array form is detected', () => {
    const src = `
      fs.chmodSync(f, 0o755);
      execFileSync('/bin/bash', ['-c', 'run']);
    `;
    const result = scanContent(src);
    assert.strictEqual(result.shellDashC, true, 'shellDashC with /bin/bash prefix');
    assert.strictEqual(result.violation, true, 'violation');
  });

  test('isWindows guard suppresses violation', () => {
    const src = `
      const isWindows = process.platform === 'win32';
      fs.chmodSync(f, 0o755);
      execFileSync('bash', ['-c', 'run']);
    `;
    const result = scanContent(src);
    assert.strictEqual(result.guarded, true, 'guarded via isWindows');
    assert.strictEqual(result.violation, false, 'violation');
  });

  test('no chmod at all => no violation regardless of shell -c', () => {
    const src = `execFileSync('bash', ['-c', 'echo hi']);`;
    const result = scanContent(src);
    assert.strictEqual(result.makesExecutable, false, 'makesExecutable');
    assert.strictEqual(result.violation, false, 'violation');
  });
});
