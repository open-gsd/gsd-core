'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('root tsconfig supports the default no-emit typecheck command', () => {
  const root = path.join(__dirname, '..');
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

  const result = spawnSync(process.execPath, [tscBin, '--noEmit'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    [
      'Expected the default root TypeScript typecheck to pass.',
      'stdout:',
      result.stdout,
      'stderr:',
      result.stderr,
    ].join('\n'),
  );
});
