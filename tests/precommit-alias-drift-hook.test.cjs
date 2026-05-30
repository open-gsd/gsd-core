'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, '.githooks', 'pre-commit');

/**
 * Write a mock bash script to a .sh file in tmpDir and return its absolute path.
 * The hook invokes it via GIT_OVERRIDE / NPM_OVERRIDE — bash executes the path
 * directly, so no PATH manipulation or NTFS execute-ACL fight is needed.
 */
function writeMock(tmpDir, name, content) {
  const filePath = path.join(tmpDir, `${name}.sh`);
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  return filePath;
}

describe('.githooks/pre-commit alias drift guard', () => {
  test('runs npm check when staged files include live command alias artifact', (t) => {
    const tmpDir = createTempDir('gsd-precommit-hook-');
    t.after(() => cleanup(tmpDir));

    const mockGit = writeMock(tmpDir, 'git', `#!/usr/bin/env bash\nprintf "%s\\n" "${'get-shit-done/bin/lib/command-aliases.cjs'}"\n`);
    const mockNpm = writeMock(tmpDir, 'npm', `#!/usr/bin/env bash\nprintf "called" > "$GSD_TEST_NPM_MARKER"\n`);

    const marker = path.join(tmpDir, 'npm-called.txt');

    execFileSync('bash', [HOOK_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        GIT_OVERRIDE: mockGit,
        NPM_OVERRIDE: mockNpm,
        GSD_TEST_NPM_MARKER: marker,
      },
      stdio: 'pipe',
    });

    assert.ok(fs.existsSync(marker), 'expected npm run check:alias-drift to be invoked');
  });

  test('every npm run invocation in the hook exists in package.json', () => {
    const hook = fs.readFileSync(HOOK_PATH, 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const npmRunScripts = [...hook.matchAll(/(?:"\$NPM_CMD"|\$NPM_CMD|\bnpm)\s+run\s+([A-Za-z0-9:_-]+)/g)]
      .map((match) => match[1]);

    assert.notEqual(npmRunScripts.length, 0, 'expected hook to invoke at least one npm script');

    for (const script of npmRunScripts) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(packageJson.scripts, script),
        `expected package.json to define script ${script}`,
      );
    }
  });

  test('does not run npm check when staged files are unrelated', (t) => {
    const tmpDir = createTempDir('gsd-precommit-hook-');
    t.after(() => cleanup(tmpDir));

    const mockGit = writeMock(tmpDir, 'git', `#!/usr/bin/env bash\nprintf "%s\\n" "README.md"\n`);
    const mockNpm = writeMock(tmpDir, 'npm', `#!/usr/bin/env bash\nprintf "called" > "$GSD_TEST_NPM_MARKER"\n`);

    const marker = path.join(tmpDir, 'npm-called.txt');

    execFileSync('bash', [HOOK_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        GIT_OVERRIDE: mockGit,
        NPM_OVERRIDE: mockNpm,
        GSD_TEST_NPM_MARKER: marker,
      },
      stdio: 'pipe',
    });

    assert.ok(!fs.existsSync(marker), 'expected npm check to be skipped for unrelated staged files');
  });
});
