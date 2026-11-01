// allow-test-rule: source-text-is-the-product (see #3190)
// The workflow .md IS the product: its embedded bash/node snippets are loaded
// and executed verbatim by the agent host at runtime. Testing that the deployed
// commit-fix step exports the env var its own inline `node -e` body reads, and
// that the docs commit stages the converged REVIEW.md alongside REVIEW-FIX.md,
// asserts the deployed contract — not an implementation detail. There is no
// runtime API that exposes these inlined snippets; the text IS the spec.
//
// Pattern mirrors tests/code-review-pipeline-regression.test.cjs: a behavioral
// run of the inline parser body (via process-seam) PLUS docs-parity on the
// workflow text. See .gsd/bug/fix-3190-code-review-fix-auto-rewrite-review/.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
// Same gate the shipped fences carry everywhere in this suite: bash is not assumed on win32.
const HAS_BASH = process.platform !== 'win32';

// Extract the bash fence out of a named <step>, so a test can RUN it rather than grep it.
// Line-scanned rather than matched with a multiline regex: an ad-hoc fence regex trips
// local/no-adhoc-markdown-parsing, and a bare \n against readFileSync content trips
// local/no-crlf-fragile-split (Windows autocrlf yields \r\n). Same shape as bashFences() in
// tests/code-review-pipeline-regression.test.cjs, which solved this first.
function stepFence(src, name) {
  const open = src.indexOf(`<step name="${name}">`);
  assert.notStrictEqual(open, -1, `step "${name}" not found`);
  const close = src.indexOf('</step>', open);
  const lines = src.slice(open, close).replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^```bash\s*$/.test(lines[i])) { start = i + 1; continue; }
    if (start !== -1 && /^```\s*$/.test(lines[i])) return lines.slice(start, i).join('\n');
  }
  assert.fail(`step "${name}" carries no bash fence`);
}
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review-fix.md');

// ---------------------------------------------------------------------------
// The FIX_REPORT frontmatter validator body, mirrored from code-review-fix.md's
// commit_fix_report HAS_STATUS inline `node -e` script. If those lines change,
// this must be updated in tandem (the docs-parity assertions below catch a
// mismatch at the env-name level).
//
// Bug (#3190): the deployed workflow launches this body with REVIEW_PATH
// exported but the body reads process.env.FIX_REPORT_PATH — so at runtime the
// readFileSync throws and HAS_STATUS silently becomes "". The behavioral tests
// below prove the BODY is sound when FIX_REPORT_PATH is wired, and that the
// mis-wiring is the sole failure mode.
// ---------------------------------------------------------------------------
const VALIDATOR_BODY = `
  const fs = require('fs');
  const content = fs.readFileSync(process.env.FIX_REPORT_PATH, 'utf-8');
  const match = content.replace(/\\r\\n/g, '\\n').match(/^---\\n([\\s\\S]*?)\\n---/);
  if (match && /status:/.test(match[1])) { console.log('valid'); } else { console.log('invalid'); }
`;

const VALID_FIX_REPORT = [
  '---',
  'status: all_fixed',
  'findings_in_scope: 3',
  'fixed: 3',
  'skipped: 0',
  'iteration: 2',
  '---',
  '',
  'All findings resolved across 2 iterations.',
].join('\n');

/** Slice the workflow text of a single <step name="...">…</step> region. */
function stepRegion(src, name) {
  const open = src.indexOf(`<step name="${name}">`);
  assert.notStrictEqual(open, -1, `step "${name}" not found in workflow`);
  const close = src.indexOf('</step>', open);
  assert.notStrictEqual(close, -1, `step "${name}" has no closing </step>`);
  return src.slice(open, close + '</step>'.length);
}

describe('#3190 — code-review-fix --auto REVIEW.md commit + FIX_REPORT_PATH env wiring', () => {
  // -------------------------------------------------------------------------
  // Criterion 3 — behavioral: the validator body correctly detects a valid
  // status field WHEN the env var it reads is actually exported.
  // -------------------------------------------------------------------------
  test('T1 — validator body prints "valid" for a well-formed REVIEW-FIX.md when FIX_REPORT_PATH is set', () => {
    const dir = createTempDir();
    const report = path.join(dir, '05-REVIEW-FIX.md');
    fs.writeFileSync(report, VALID_FIX_REPORT, 'utf8');
    try {
      const res = runNode(['-e', VALIDATOR_BODY], {
        env: { ...process.env, FIX_REPORT_PATH: report },
      });
      assert.strictEqual(res.exitCode, 0, `validator should exit 0; stderr:\n${res.stderr}`);
      assert.strictEqual(res.stdout.trim(), 'valid');
    } finally {
      cleanup(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Criterion 3 — behavioral bug demo: the SAME body, with FIX_REPORT_PATH
  // unset (exactly what today's `REVIEW_PATH=`-only export produces in the
  // subshell), throws inside readFileSync → stdout is empty → HAS_STATUS="" →
  // the "invalid frontmatter — Not committing" branch fires unconditionally.
  // This proves the env-name coupling is load-bearing and that the body is not
  // the culprit.
  // -------------------------------------------------------------------------
  test('T2 — validator body does NOT print "valid" when FIX_REPORT_PATH is unset (the mis-wiring)', () => {
    const env = { ...process.env };
    delete env.FIX_REPORT_PATH;
    delete env.REVIEW_PATH;
    const res = runNode(['-e', VALIDATOR_BODY], { env });
    // The throw crashes node (non-zero), stdout has no "valid" — exactly the
    // silent empty string the 2>/dev/null command substitution yields in bash.
    assert.ok(
      !res.stdout.includes('valid'),
      `stdout should not contain "valid" when FIX_REPORT_PATH is unset; got: ${res.stdout}`,
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 3 — docs-parity: the commit_fix_report HAS_STATUS validator must
  // export FIX_REPORT_PATH (the var its body reads), not REVIEW_PATH.
  // -------------------------------------------------------------------------
  test('T3 — commit_fix_report HAS_STATUS exports FIX_REPORT_PATH, not REVIEW_PATH', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const region = stepRegion(src, 'commit_fix_report');
    assert.ok(
      region.includes('HAS_STATUS=$(FIX_REPORT_PATH="${FIX_REPORT_PATH}" node -e'),
      'HAS_STATUS must launch node with FIX_REPORT_PATH exported to match the process.env.FIX_REPORT_PATH its body reads',
    );
    assert.ok(
      !region.includes('HAS_STATUS=$(REVIEW_PATH="${REVIEW_PATH}" node -e'),
      'HAS_STATUS must not export REVIEW_PATH into a script that reads process.env.FIX_REPORT_PATH',
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 3 — docs-parity: the present_results FIX_FRONTMATTER extractor
  // must export FIX_REPORT_PATH, not REVIEW_PATH (else every summary field is
  // blank).
  // -------------------------------------------------------------------------
  test('T4 — present_results FIX_FRONTMATTER exports FIX_REPORT_PATH, not REVIEW_PATH', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const region = stepRegion(src, 'present_results');
    assert.ok(
      region.includes('FIX_FRONTMATTER=$(FIX_REPORT_PATH="${FIX_REPORT_PATH}" node -e'),
      'FIX_FRONTMATTER must launch node with FIX_REPORT_PATH exported to match the process.env.FIX_REPORT_PATH its body reads',
    );
    assert.ok(
      !region.includes('FIX_FRONTMATTER=$(REVIEW_PATH="${REVIEW_PATH}" node -e'),
      'FIX_FRONTMATTER must not export REVIEW_PATH into a script that reads process.env.FIX_REPORT_PATH',
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 1 — docs-parity: in --auto the single docs commit must stage the
  // converged REVIEW.md alongside REVIEW-FIX.md, gated on AUTO_MODE (non-auto
  // single-pass runs never rewrite REVIEW.md and stay out of scope).
  // -------------------------------------------------------------------------
  test('T5 — commit_fix_report stages REVIEW.md alongside REVIEW-FIX.md when AUTO_MODE', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const region = stepRegion(src, 'commit_fix_report');
    assert.ok(
      region.includes('AUTO_MODE'),
      'commit_fix_report must be aware of AUTO_MODE (only --auto rewrites REVIEW.md)',
    );
    assert.ok(
      region.includes('REVIEW_PATH') && region.includes('COMMIT_FILES'),
      'commit_fix_report must build a COMMIT_FILES list that includes REVIEW_PATH in --auto',
    );
    assert.ok(
      region.includes('--files "${COMMIT_FILES[@]}"'),
      'the docs commit must stage the assembled COMMIT_FILES array (REVIEW-FIX.md [+ REVIEW.md in --auto])',
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 2 — docs-parity: on successful convergence the spent .iterN.md
  // backups are removed so the phase directory is clean. Backup CREATION is
  // unchanged (out of scope); they are retained when the loop degrades.
  // -------------------------------------------------------------------------
  test('T6 — spent .iterN.md backups are removed on convergence, AFTER the ledger reads them', () => {
    // #3190's SEMANTICS are unchanged and still asserted here: removed on convergence, retained on
    // degradation, creation intact. What moved is the PLACEMENT, and it had to. This workflow keeps
    // one final version of REVIEW.md and REVIEW-FIX.md rather than per-iteration copies, and the
    // re-review drops a finding once it is fixed — so the backups are the only surviving record of
    // what an early --auto iteration closed. Removing them at the end of the loop erased that record
    // before `record_disposition` could read it, and the ledger then reported those findings as
    // `open (not in the current review)`: indistinguishable from never triaged (#3861 round 5).
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const loop = stepRegion(src, 'auto_iteration_loop');
    const cleanup = stepRegion(src, 'cleanup_iteration_backups');

    // Backups are still CREATED before each overwrite (the unchanged mechanism).
    assert.ok(
      loop.includes('.iter${ITERATION}.md'),
      'backup creation (cp … .iter${ITERATION}.md) must remain intact',
    );
    // And no longer removed inside the loop — that is the regression this test now guards.
    assert.ok(
      !/rm -f[\s\S]*?\.iter[\s\S]*?\*[\s\S]*?\.md/.test(loop),
      'the loop must NOT remove the backups it wrote; the ledger has not read them yet',
    );
    // Removal lives in its own step, still gated on convergence.
    assert.ok(
      /rm -f[\s\S]*?\.iter[\s\S]*?\*[\s\S]*?\.md/.test(cleanup),
      'cleanup_iteration_backups must remove spent .iterN.md backups (rm -f … .iter*.md)',
    );
    // The token greps that stood here PASSED with the branch INVERTED — the round's own review drove
    // it by flipping `= "clean"` to `!=` and watching the test stay green. Checking that FINAL_STATUS,
    // rm and "retained" occur SOMEWHERE says nothing about which branch each sits in. Execute it.
    assert.match(cleanup, /FINAL_STATUS/, 'convergence must still be re-derived from the review status');
    // Ordering is the whole point of the move.
    const recordAt = src.indexOf('<step name="record_disposition">');
    const cleanupAt = src.indexOf('<step name="cleanup_iteration_backups">');
    assert.ok(recordAt > -1 && cleanupAt > -1, 'both steps must exist');
    assert.ok(recordAt < cleanupAt, 'the ledger reads the backups BEFORE they are removed');
  });

  test('T6b — the cleanup fence, EXECUTED: removes on clean, retains on anything else', { skip: !HAS_BASH }, () => {
    // The behavioural half of T6, and the one that survives a branch inversion. Drives the shipped
    // fence in both directions against real files, so an inverted condition fails here rather than
    // passing a token grep — which is exactly what the round's review demonstrated of the first cut.
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const fence = stepFence(src, 'cleanup_iteration_backups');

    const drive = (status) => {
      const dir = createTempDir('gsd-3861-cleanup-');
      try {
        fs.writeFileSync(path.join(dir, '01-REVIEW.md'), ['---', 'status: ' + status, '---'].join('\n'));
        fs.writeFileSync(path.join(dir, '01-REVIEW.iter2.md'), 'scratch');
        fs.writeFileSync(path.join(dir, '01-REVIEW-FIX.iter2.md'), 'scratch');
        const script = [
          'set -euo pipefail',
          'AUTO_MODE=true',
          'REVIEW_PATH="' + path.join(dir, '01-REVIEW.md') + '"',
          'FIX_REPORT_PATH="' + path.join(dir, '01-REVIEW-FIX.md') + '"',
          fence,
        ].join('\n');
        const res = runHook('-c', [script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
        assert.strictEqual(res.exitCode, 0, 'the cleanup step must never abort: ' + res.stderr);
        return {
          review: fs.existsSync(path.join(dir, '01-REVIEW.iter2.md')),
          fix: fs.existsSync(path.join(dir, '01-REVIEW-FIX.iter2.md')),
          stdout: res.stdout,
        };
      } finally { cleanup(dir); }
    };

    const converged = drive('clean');
    assert.strictEqual(converged.review, false, 'a converged run removes the REVIEW backup');
    assert.strictEqual(converged.fix, false, 'and the FIX-REPORT backup');

    const degraded = drive('issues_found');
    assert.strictEqual(degraded.review, true, 'a degraded run RETAINS the REVIEW backup');
    assert.strictEqual(degraded.fix, true, 'and the FIX-REPORT backup');
    assert.match(degraded.stdout, /retained/i, 'and says so, so the trail is discoverable');

    // An unreadable or unparseable review is not evidence of convergence — retain.
    const unknown = drive('');
    assert.strictEqual(unknown.review, true, 'an unparseable status must retain, never remove');
  });
});

// ---------------------------------------------------------------------------
// #4100 — `--auto` converges when nothing is left in fix scope.
//
// Before: the loop stopped only on a re-review returning `status: clean`. A review whose remaining
// findings were all out of scope (Info, or Necessity without --all) never reaches clean, so the
// loop re-spawned the fixer with zero in-scope findings until MAX_ITERATIONS and printed the
// degradation warning over a run that had nothing left to do. The fixer's own `findings_in_scope`
// is the scope authority; `_gsd_fix_scope_empty` reads it strictly — only a frontmatter value of 0
// proves zero scope, and anything unusable keeps the old behavior.
// ---------------------------------------------------------------------------
describe('#4100 — code-review-fix --auto zero-scope convergence', () => {
  const fc = require('./helpers/fast-check-setup.cjs');

  function scopeHelper() {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const lines = stepRegion(src, 'auto_iteration_loop').replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex((l) => l === '  _gsd_fix_scope_empty() {');
    assert.notStrictEqual(start, -1, '_gsd_fix_scope_empty helper must exist in auto_iteration_loop');
    const end = lines.findIndex((l, i) => i > start && l === '  }');
    assert.notStrictEqual(end, -1, '_gsd_fix_scope_empty helper must close');
    return lines.slice(start, end + 1).join('\n');
  }

  function probe(reportBody, { name = '01-REVIEW-FIX.md', write = true } = {}) {
    const dir = createTempDir('gsd-4100-scope-');
    try {
      const report = path.join(dir, name);
      if (write) fs.writeFileSync(report, reportBody);
      const script = [
        'set -euo pipefail',
        scopeHelper(),
        'if _gsd_fix_scope_empty "$P"; then echo yes; else echo no; fi',
      ].join('\n');
      const res = runHook('-c', [script], {
        interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, P: report },
      });
      assert.strictEqual(res.exitCode, 0, 'the helper must never abort the loop: ' + res.stderr);
      return { verdict: res.stdout.trim(), pwned: fs.existsSync(path.join(dir, 'pwned')) };
    } finally { cleanup(dir); }
  }

  const report = (value, eol = '\n') =>
    ['---', 'status: all_fixed', `findings_in_scope: ${value}`, 'fixed: 0', 'skipped: 0', '---', '', 'body'].join(eol);

  test('boundary: 0 proves zero scope, 1 and -1 do not, 00 is zero, CRLF is honored', { skip: !HAS_BASH }, () => {
    assert.strictEqual(probe(report('0')).verdict, 'yes', 'limit: 0 in scope');
    assert.strictEqual(probe(report('1')).verdict, 'no', 'limit+1: 1 in scope');
    assert.strictEqual(probe(report('-1')).verdict, 'no', 'limit-1: a negative count is malformed, not zero');
    assert.strictEqual(probe(report('00')).verdict, 'yes', 'a zero-padded zero is still zero');
    assert.strictEqual(probe(report('0', '\r\n')).verdict, 'yes', 'a CRLF report is read the same');
  });

  test('never proves zero from unusable input', { skip: !HAS_BASH }, () => {
    assert.strictEqual(probe(report('')).verdict, 'no', 'blank value');
    assert.strictEqual(probe(report('none')).verdict, 'no', 'non-numeric value');
    assert.strictEqual(probe(['---', 'status: all_fixed', '---'].join('\n')).verdict, 'no', 'absent key');
    assert.strictEqual(probe('findings_in_scope: 0\n').verdict, 'no', 'no frontmatter');
    assert.strictEqual(probe(['---', 'status: partial', '---', 'findings_in_scope: 0'].join('\n')).verdict, 'no',
      'the key in the body is not the frontmatter');
    assert.strictEqual(probe('', { write: false }).verdict, 'no', 'missing report');
    const hostile = probe(report('0'), { name: 'a;$(touch pwned)`touch pwned`.md' });
    assert.strictEqual(hostile.verdict, 'yes', 'a hostile path is data');
    assert.strictEqual(hostile.pwned, false, 'and is never executed');
  });

  test('property: zero scope iff findings_in_scope is zero', { skip: !HAS_BASH }, () => {
    fc.assert(
      fc.property(fc.nat({ max: 5000 }), (n) => probe(report(String(n))).verdict === (n === 0 ? 'yes' : 'no')),
      { numRuns: 25 },
    );
  });

  test('the loop consults the helper before iterating and after every fixer pass', () => {
    const region = stepRegion(fs.readFileSync(WORKFLOW_PATH, 'utf8'), 'auto_iteration_loop');
    const calls = region.split('_gsd_fix_scope_empty "${FIX_REPORT_PATH}"').length - 1;
    assert.ok(calls >= 2, 'helper must gate the loop entry and each iteration: found ' + calls);
    assert.ok(region.includes('while [ "$NO_SCOPE_LEFT" = false ] && [ $ITERATION -lt $MAX_ITERATIONS ]; do'),
      'the loop must not start once nothing is in scope');
    assert.ok(region.includes('if [ "$NO_SCOPE_LEFT" = false ] && [ $ITERATION -ge $MAX_ITERATIONS ]; then'),
      'the degradation warning must not fire on a zero-scope stop');
  });

  test('the fix summary does not claim resolution when nothing was in scope', { skip: !HAS_BASH }, () => {
    const region = stepRegion(fs.readFileSync(WORKFLOW_PATH, 'utf8'), 'present_results').replace(/\r\n/g, '\n');
    const lines = region.split('\n');
    const marker = lines.findIndex((l) => l.includes('All issues resolved.'));
    assert.notStrictEqual(marker, -1);
    let start = marker;
    while (start > 0 && !/^```bash\s*$/.test(lines[start])) start--;
    let end = marker;
    while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
    const fence = lines.slice(start + 1, end).join('\n');
    const run = (inScope) => runHook('-c', [fence], {
      interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS,
      env: { ...process.env, FIX_STATUS: 'all_fixed', FINDINGS_IN_SCOPE: inScope, FIX_SCOPE: 'critical_warning',
        FIX_REPORT_PATH: 'x', REVIEW_PATH: 'y', PHASE_NUMBER: '1' },
    }).stdout;
    const zero = run('0');
    assert.ok(zero.includes('No findings were in fix scope'), 'zero scope says so');
    assert.ok(!zero.includes('All issues resolved.'), 'and does not claim resolution');
    assert.ok(run('2').includes('All issues resolved.'), 'a real all_fixed run is unchanged');
  });
});
