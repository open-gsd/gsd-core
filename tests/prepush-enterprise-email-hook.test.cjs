'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, '.githooks', 'pre-push');

function writeExec(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('.githooks/pre-push enterprise email guard', () => {
  test('blocks push when any to-be-pushed commit matches local blocked regex', (t) => {
    const tmpDir = createTempDir('gsd-prepush-hook-');
    t.after(() => cleanup(tmpDir));

    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    writeExec(path.join(binDir, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "rev-list" ]]; then
  echo "c1"
  echo "c2"
  exit 0
fi
if [[ "$1" == "show" ]]; then
  commit="$(printf '%s\n' "$@" | tail -n 1)"
  if [[ "$commit" == "c1" ]]; then
    echo "trekkie@nomorestars.com"
  else
    echo "person@example-corp.com"
  fi
  exit 0
fi
exit 1
`);

    assert.throws(() => {
      execFileSync('bash', [HOOK_PATH], {
        cwd: ROOT,
        env: {
          ...process.env,
          // MSYS2_PATH_TYPE=inherit prevents Git Bash (MSYS2) on Windows from
          // prepending its own system directories (/mingw64/bin, /usr/bin, /bin)
          // ahead of the Windows PATH entries. Without this, the real git binary
          // in MSYS2 system dirs takes priority over the mock git stub in binDir
          // even though binDir is first in the Windows PATH we pass here. The
          // real git rejects placeholder SHAs (refs-local-sha, refs-remote-sha)
          // with a fatal "ambiguous argument" error instead of returning the
          // fixture commit list from the mock stub.
          // With inherit, MSYS2 uses only the converted Windows PATH, keeping
          // binDir first. On macOS/Linux this variable is ignored.
          // Source: https://www.msys2.org/wiki/MSYS2-introduction/#path
          MSYS2_PATH_TYPE: 'inherit',
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          GSD_BLOCKED_AUTHOR_REGEX: '@example-corp\\.com$',
        },
        input: 'refs/heads/pr refs-local-sha refs/heads/pr refs-remote-sha\n',
        stdio: 'pipe',
      });
    }, /Push blocked: commit author email matched local blocked regex/);
  });

  test('allows push when to-be-pushed commits are non-enterprise emails', (t) => {
    const tmpDir = createTempDir('gsd-prepush-hook-');
    t.after(() => cleanup(tmpDir));

    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    writeExec(path.join(binDir, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "rev-list" ]]; then
  echo "c1"
  echo "c2"
  exit 0
fi
if [[ "$1" == "show" ]]; then
  echo "trekkie@nomorestars.com"
  exit 0
fi
exit 1
`);

    execFileSync('bash', [HOOK_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        // See comment above — same MSYS2 system-dir prepend fix applies here.
        // Source: https://www.msys2.org/wiki/MSYS2-introduction/#path
        MSYS2_PATH_TYPE: 'inherit',
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        GSD_BLOCKED_AUTHOR_REGEX: '@example-corp\\.com$',
      },
      input: 'refs/heads/pr refs-local-sha refs/heads/pr refs-remote-sha\n',
      stdio: 'pipe',
    });
  });
});
