'use strict';

// Regression guard for #2020 — dead SDK file references (sdk/src/..., sdk/dist/...)
// in runtime-loaded markdown cause AI runtimes to `find` them; on Git Bash for
// Windows `find /` traverses the whole drive (14h+, orphaned find.exe, 4M+ handles).
// The SDK package was retired (ADR-0174), so these paths never resolve.
//
// Scans the markdown a runtime loads + tries to locate references in
// (agents/, workflows/, references/) and fails on any sdk/(src|dist|handlers)
// file-path reference. Code-comment mentions in *.cjs (historical prose, not
// locatable file refs) are out of scope.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Runtime-loaded markdown surfaces (the issue is about references a runtime
// tries to LOCATE as files — agents/workflows/references, not source comments).
const SCAN_DIRS = ['agents', 'gsd-core/workflows', 'gsd-core/references'];
// A dead SDK file-path reference: sdk/src|sdk/dist|sdk/handlers followed by a path.
const DEAD_SDK_REF = /sdk\/(?:src|dist|handlers)\//;

function walkMd(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

describe('#2020 — no dead SDK file references in runtime-loaded markdown', () => {
  const offenders = [];
  for (const rel of SCAN_DIRS) {
    const absDir = path.join(ROOT, rel);
    for (const file of walkMd(absDir)) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (DEAD_SDK_REF.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
  }

  test('agents/workflows/references contain no sdk/src|sdk/dist|sdk/handlers references', () => {
    assert.deepEqual(offenders, [],
      `Dead SDK file references found (runtimes \`find\` these → #2020 Windows find.exe storm):\n${offenders.join('\n')}`);
  });
});
