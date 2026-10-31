'use strict';

/**
 * Property test for the backup-name grammar of code-review-fix's cleanup_iteration_backups (#5506):
 * a backup is exactly `<stem>.iter<digits>.md`, one or more digits and nothing else.
 *
 * The owner is the shipped bash span from `BACKUP_FILES=()` through its `done`, run for real over a
 * directory of generated names. The oracle is the grammar, written as a regex on the basename.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');
const { have } = require('./helpers/bash-probe.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const FIX = 'gsd-core/workflows/code-review-fix.md';
const BACKUP = /^01-REVIEW(-FIX)?\.iter[0-9]+\.md$/;

/** Basenames of the `names` the owner span classifies as backups (its BACKUP_FILES), sorted. */
function kept(names) {
  const dir = createTempDir('gsd-5506-grammar-');
  try {
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
    const r = runBash(span(FIX, 'BACKUP_FILES=()', 'done'), { stdout: '', rc: 0 }, {
      preamble: ['cd "' + dir + '"', 'shopt -s nullglob', 'REVIEW_PATH="' + dir + '/01-REVIEW.md"',
        'FIX_REPORT_PATH="' + dir + '/01-REVIEW-FIX.md"'],
      probe: 'for _b in ${BACKUP_FILES[@]+"${BACKUP_FILES[@]}"}; do echo "${_b##*/}"; done',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter(Boolean).sort();
  } finally { cleanup(dir); }
}

const oracle = (names) => [...names].filter((n) => BACKUP.test(n)).sort();

// The span is bash: skip where there is none.
const NO_BASH = !have('bash') && 'bash is not available';

describe('#5506 backup name grammar', { skip: NO_BASH }, () => {
  test('the cleanup span keeps exactly the .iter<digits>.md names', () => {
    // Digit strings of length 0, 1, 2: below, at and above the "at least one digit" limit.
    const digits = fc.array(fc.constantFrom('0', '1', '2', '7', '9'), { maxLength: 2 })
      .map((a) => a.join(''));
    const suffix = fc.constantFrom('', '-notes', '.bak', 'x', '.md', '.iter3', 'x.iter3');
    const name = fc.tuple(fc.constantFrom('01-REVIEW', '01-REVIEW-FIX'), digits, suffix)
      .map(([stem, d, s]) => stem + '.iter' + d + s + '.md');
    fc.assert(
      fc.property(fc.array(name, { minLength: 1, maxLength: 8 }), (names) => {
        const uniq = [...new Set(names)];
        assert.deepStrictEqual(kept(uniq), oracle(uniq));
      }),
      { numRuns: 25 },
    );
  });

  test('explicit boundary names', () => {
    assert.deepStrictEqual(kept(['01-REVIEW.iter.md']), []);
    assert.deepStrictEqual(kept(['01-REVIEW.iter1.md']), ['01-REVIEW.iter1.md']);
    assert.deepStrictEqual(kept(['01-REVIEW-FIX.iter12.md']), ['01-REVIEW-FIX.iter12.md']);
  });
});
