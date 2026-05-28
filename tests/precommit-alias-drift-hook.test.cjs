'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, '.githooks', 'pre-commit');

function writeExec(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('.githooks/pre-commit alias drift guard', () => {
  test('runs npm check when staged files include command-manifest/alias artifacts', (t) => {
    const tmpDir = createTempDir('gsd-precommit-hook-');
    t.after(() => cleanup(tmpDir));

    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    writeExec(path.join(binDir, 'git'), `#!/usr/bin/env bash\nprintf "%s\\n" "${'sdk/src/query/command-manifest.phase.ts'}"\n`);
    writeExec(path.join(binDir, 'npm'), `#!/usr/bin/env bash\nprintf "called" > "$GSD_TEST_NPM_MARKER"\n`);

    const marker = path.join(tmpDir, 'npm-called.txt');

    execFileSync('bash', [HOOK_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        // MSYS2_PATH_TYPE=inherit prevents Git Bash (MSYS2) on Windows from
        // prepending its own system directories (/mingw64/bin, /usr/bin, /bin)
        // ahead of the Windows PATH entries. Without this, the real git/npm
        // binaries in MSYS2 system dirs take priority over the mock stubs in
        // binDir even though binDir is first in the Windows PATH we pass here.
        // With inherit, MSYS2 uses only the converted Windows PATH, keeping
        // binDir first. On macOS/Linux this variable is ignored.
        // Source: https://www.msys2.org/wiki/MSYS2-introduction/#path
        MSYS2_PATH_TYPE: 'inherit',
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        GSD_TEST_NPM_MARKER: marker,
      },
      stdio: 'pipe',
    });

    assert.ok(fs.existsSync(marker), 'expected npm run check:alias-drift to be invoked');
  });

  test('does not run npm check when staged files are unrelated', (t) => {
    const tmpDir = createTempDir('gsd-precommit-hook-');
    t.after(() => cleanup(tmpDir));

    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    writeExec(path.join(binDir, 'git'), `#!/usr/bin/env bash\nprintf "%s\\n" "README.md"\n`);
    writeExec(path.join(binDir, 'npm'), `#!/usr/bin/env bash\nprintf "called" > "$GSD_TEST_NPM_MARKER"\n`);

    const marker = path.join(tmpDir, 'npm-called.txt');

    execFileSync('bash', [HOOK_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        // See comment above — same MSYS2 system-dir prepend fix applies here.
        // Source: https://www.msys2.org/wiki/MSYS2-introduction/#path
        MSYS2_PATH_TYPE: 'inherit',
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        GSD_TEST_NPM_MARKER: marker,
      },
      stdio: 'pipe',
    });

    assert.ok(!fs.existsSync(marker), 'expected npm check to be skipped for unrelated staged files');
  });
});
