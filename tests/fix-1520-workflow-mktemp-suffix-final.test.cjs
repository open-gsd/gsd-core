// allow-test-rule: source-text-is-the-product (#1520)
// Workflow .md text IS what the runtime loads and the agent executes, so
// asserting on its shell invocations tests the deployed contract directly.
//
// Repo-wide regression guard for #1520: NO workflow .md may invoke `mktemp`
// with a template whose `XXXXXX` run is followed by a filename suffix
// (e.g. `…-XXXXXX.json`, `…-XXXXXX.md`). BSD/macOS `mktemp` only substitutes
// the `X` run when it is the FINAL path component; a trailing suffix yields a
// literal, non-randomized path, so concurrent workflow runs collide on the same
// temp file (one run overwriting or consuming another's). The portable fix is
// `mktemp …-XXXXXX` (suffix-less) then `mv` to add the extension.
//
// This is a copy-paste-prone shell idiom — the same defect first shipped across
// five workflows before #1520 — so a prose guard is the right lock-out, mirroring
// the bug-637 hardcoded-$HOME workflow scan.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// Match `mktemp <token>` where, within the single whitespace-delimited template
// token, a maximal run of 3+ `X` is immediately followed by a filename
// character (`.`, alnum, `-`, `_`) — i.e. a suffix the BSD/macOS substitution
// can't reach.
//   - `\s+`            requires an argument (bare `mktemp` is fine — path-final
//                      is N/A — and prose like "mktemp only randomizes XXXXXX"
//                      is excluded because the X-run is in a later token).
//   - `["']?\S*?`      walks within the one quoted/unquoted template token.
//   - `X{3,}(?!X)`     anchors on the WHOLE X-run (so `XXXXXX)` does not match
//                      via a sub-run leaving a trailing `X`).
//   - `[.A-Za-z0-9_-]` the offending suffix char. A legitimate path-final form
//                      ends the token with `"`, `'`, whitespace, or `)`, none of
//                      which are in this class.
const SUFFIXED_MKTEMP_TEMPLATE = /mktemp\s+["']?\S*?X{3,}(?!X)[.A-Za-z0-9_-]/;

function collectWorkflowMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectWorkflowMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

describe('#1520: workflow mktemp templates keep XXXXXX path-final', () => {
  test('no gsd-core/workflows/**/*.md calls mktemp with a suffix after the XXXXXX run', () => {
    const files = collectWorkflowMarkdown(WORKFLOWS_DIR);
    assert.ok(files.length > 0, 'expected workflow markdown files to exist');

    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (SUFFIXED_MKTEMP_TEMPLATE.test(line)) {
          offenders.push(`${path.relative(WORKFLOWS_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepStrictEqual(
      offenders,
      [],
      'Workflow mktemp templates must keep XXXXXX as the final path component ' +
        '(create suffix-less, then `mv` to add the extension) so BSD/macOS ' +
        'randomizes the path. Offenders:\n' +
        offenders.join('\n'),
    );
  });
});
