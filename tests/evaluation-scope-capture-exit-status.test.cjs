'use strict';

/**
 * #5170 (Phase 8 of epic #5056): `check evaluation-scope` exits UNAVAILABLE (69) with its JSON on
 * stdout when the scope is `unresolvable`. The two workflow captures that keep that JSON (the
 * reason it carries is what the review prints) must survive it under `set -e`, keep the JSON for
 * exit 69, and drop whatever stdout a command that did not run left behind (any other non-zero).
 *
 * Each documented capture is extracted from the workflow and run under bash with `set -e` and a
 * stub `gsd_run` returning each status.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { span: docSpan, runBash } = require('./helpers/doc-bash-span.cjs');

const UNRESOLVABLE = '{"status":"unresolvable","reason":"git-unavailable","files":[]}';

const SKIP = skipUnless('bash', 'node');

/** The lines of a workflow file from the one starting with `from` through the one starting with `through`. */
const span = (file, from, through) => docSpan(`gsd-core/workflows/${file}`, from, through);

const run = (lines, probe, { stdout, rc }) => runBash(lines, { stdout, rc }, {
  preamble: ['PADDED_PHASE=03; quick_id=q1; LAST_REVIEW_COMMIT='],
  probe,
});

const CAPTURES = [
  {
    name: 'code-review scope capture',
    // The capture itself runs under `set -e`; the field readers below it never did (their parse failure is a status 1).
    lines: () => span('code-review.md', 'SCOPE_RC=0', 'if [ "$SCOPE_RC"').concat(['set +e'], span('code-review.md', 'scope_field() {', 'SCOPE_REASON=')),
    probe: 'printf "STATUS=%s\\nREASON=%s\\n" "$SCOPE_STATUS" "$SCOPE_REASON"',
    reads: (r) => ({ status: /^STATUS=(.*)$/m.exec(r.stdout)?.[1], reason: /^REASON=(.*)$/m.exec(r.stdout)?.[1] }),
  },
  {
    name: 'quick-task review scope capture',
    lines: () => span('quick.md', 'QUICK_SCOPE_RC=0', 'QUICK_SCOPE_JSON=$(gsd_run').concat(span('quick.md', 'if [ "$QUICK_SCOPE_RC"', 'if [ "$QUICK_SCOPE_RC"')),
    probe: 'node -e \'let s=process.argv[1];try{const v=JSON.parse(s);console.log("STATUS="+v.status+"\\nREASON="+v.reason)}catch{console.log("STATUS=\\nREASON=")}\' "$QUICK_SCOPE_JSON"',
    reads: (r) => ({ status: /^STATUS=(.*)$/m.exec(r.stdout)?.[1], reason: /^REASON=(.*)$/m.exec(r.stdout)?.[1] }),
  },
];

for (const capture of CAPTURES) {
  describe(`${capture.name} (bash, set -e, stub gsd_run)`, { skip: SKIP }, () => {
    test('exit 0 is a delivered scope: its JSON is read', () => {
      const r = run(capture.lines(), capture.probe, { stdout: '{"status":"resolved","reason":null}', rc: 0 });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(capture.reads(r).status, 'resolved');
    });

    test('exit 69 (could not look) does not abort under set -e and keeps the JSON with its reason', () => {
      const r = run(capture.lines(), capture.probe, { stdout: UNRESOLVABLE, rc: 69 });
      assert.equal(r.status, 0, `exit 69 must not abort the capture: ${r.stderr}`);
      assert.deepEqual(capture.reads(r), { status: 'unresolvable', reason: 'git-unavailable' });
    });

    test('exit 68 and exit 70 (limit-1 / limit+1 of UNAVAILABLE) are command failures: stdout is discarded', () => {
      for (const rc of [68, 70]) {
        const r = run(capture.lines(), capture.probe, { stdout: '{"status":"resolved","reason":null}', rc });
        assert.equal(r.status, 0, r.stderr);
        assert.notEqual(capture.reads(r).status, 'resolved', `exit ${rc} must not read the JSON`);
      }
    });

    test('exit 1 with nothing on stdout leaves an unresolvable scope, never an empty-and-fine one', () => {
      const r = run(capture.lines(), capture.probe, { stdout: '', rc: 1 });
      assert.equal(r.status, 0, r.stderr);
      assert.notEqual(capture.reads(r).status, 'resolved');
    });
  });
}
