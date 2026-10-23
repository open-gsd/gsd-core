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
const { runNode, runGit, runHook } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
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

// Mirrors `query commit MSG [--files F...] [--files-removed F...] --raw` (src/commands.cts cmdCommit):
// --files paths missing on disk are SKIPPED (#2014), only --files-removed stages a deletion, and an
// empty index prints "nothing". A stub that `git add`s everything would mask a deletion routed
// through --files.
const REAL_COMMIT_BODY = ' local msg="$3"; shift 3; local m="" a=() r=();'
  + ' while [ $# -gt 0 ]; do case "$1" in --files) m=a;; --files-removed) m=r;; --raw) m="";;'
  + ' *) if [ "$m" = a ] && [ -e "$1" ]; then a+=("$1"); elif [ "$m" = r ] && [ ! -e "$1" ]; then r+=("$1"); fi;; esac; shift; done;'
  + ' if [ ${#a[@]} -gt 0 ]; then git add -- "${a[@]}"; fi;'
  + ' if [ ${#r[@]} -gt 0 ]; then git rm -q --cached --ignore-unmatch -- "${r[@]}"; fi;'
  + ' if git diff --cached --quiet; then echo nothing; return 0; fi;'
  + ' git commit -q -m "$msg" && git rev-parse --short HEAD; }';

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
          'COMMIT_DOCS=false',
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

  // One real-git fixture for T6c/T6d/T6e: a seeded repo holding REVIEW(-FIX).md plus two iter2 backups,
  // committed (a degraded run already committed them) or left untracked (this run just wrote them).
  const seedBackupRepo = (t, prefix, status, committedBackups) => {
    const dir = createTempDir(prefix);
    t.after(() => cleanup(dir));
    const git = (...a) => gitOrThrow(a, { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, '01-REVIEW.md'), ['---', 'status: ' + status, '---'].join('\n'));
    fs.writeFileSync(path.join(dir, '01-REVIEW-FIX.md'), 'fix');
    const writeBackups = () => {
      for (const f of ['01-REVIEW.iter2.md', '01-REVIEW-FIX.iter2.md']) fs.writeFileSync(path.join(dir, f), 'scratch');
    };
    if (committedBackups) writeBackups();
    git('add', '.');
    git('commit', '-q', '-m', 'seed');
    if (!committedBackups) writeBackups();
    return dir;
  };

  test('T6c — #5506: retained backups are COMMITTED when COMMIT_DOCS=true, left alone when false', { skip: !HAS_BASH }, (t) => {
    // A non-clean --auto run retains <NN>-REVIEW(-FIX).iterN.md. Untracked, they leave a dirty tree
    // that blocks the next checkout/worktree op. Execute the shipped fence against a real git repo
    // with a gsd_run stub that does what `query commit MSG --files F... --raw` does: add + commit,
    // print the hash. `skip` makes it print "skipped" and exit 0, as a per-phase
    // phase_commit_docs=false override does (src/commands.cts cmdCommit).
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const fence = stepFence(src, 'cleanup_iteration_backups');
    const git = (dir, ...a) => runGit(a, { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });

    const drive = (commitDocs, status = 'issues_found', mode = 'commit') => {
      const dir = seedBackupRepo(t, 'gsd-5506-cleanup-', status, false);
      const script = [
        'set -euo pipefail',
        'cd "' + dir + '"',
        'gsd_run() { echo "$*" >> gsd-calls.log; [ "$1 $2" = "query commit" ] || return 1;'
          + (mode === 'skipped' ? ' echo skipped; return 0; }'
            : mode === 'nothing' ? ' echo nothing; return 0; }'
            : mode === 'committed' ? ' echo committed; return 0; }'
            : mode === 'fail' ? ' return 1; }'
            : REAL_COMMIT_BODY),
        'AUTO_MODE=true',
        'COMMIT_DOCS=' + commitDocs,
        'PADDED_PHASE=01',
        'REVIEW_PATH="' + path.join(dir, '01-REVIEW.md') + '"',
        'FIX_REPORT_PATH="' + path.join(dir, '01-REVIEW-FIX.md') + '"',
        fence,
      ].join('\n');
      const res = runHook('-c', [script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
      assert.strictEqual(res.exitCode, 0, 'the cleanup step must never abort: ' + res.stderr);
      const calls = fs.existsSync(path.join(dir, 'gsd-calls.log')) ? fs.readFileSync(path.join(dir, 'gsd-calls.log'), 'utf8') : '';
      if (calls) fs.unlinkSync(path.join(dir, 'gsd-calls.log'));
      return {
        calls,
        stdout: res.stdout,
        status: git(dir, 'status', '--porcelain').stdout.trim(),
        subject: git(dir, 'log', '-1', '--format=%s').stdout.trim(),
        tracked: splitLines(git(dir, 'ls-files').stdout).filter(Boolean).sort(),
        count: git(dir, 'rev-list', '--count', 'HEAD').stdout.trim(),
        review: fs.existsSync(path.join(dir, '01-REVIEW.iter2.md')),
        fix: fs.existsSync(path.join(dir, '01-REVIEW-FIX.iter2.md')),
      };
    };

    const on = drive('true');
    assert.strictEqual(on.status, '', 'the tree must be clean after the step: ' + on.status);
    assert.doesNotMatch(on.stdout, /Warning: iteration backups not committed/, 'a committed hash is the success arm: no warning');
    assert.ok(on.review && on.fix, 'backups are retained on disk');
    assert.strictEqual(on.subject, 'docs(01): retain code review iteration backups');
    assert.strictEqual(on.count, '2', 'exactly one new commit beyond the seed');
    assert.deepStrictEqual(on.tracked,
      ['01-REVIEW-FIX.iter2.md', '01-REVIEW-FIX.md', '01-REVIEW.iter2.md', '01-REVIEW.md'],
      'both backups are recoverable from git');

    const off = drive('false');
    assert.strictEqual(off.calls, '', 'COMMIT_DOCS=false: .planning is gitignored, no commit attempted');
    assert.ok(off.review && off.fix, 'backups are retained on disk');

    const clean = drive('true', 'clean');
    assert.strictEqual(clean.calls, '', 'clean: no commit attempted');
    assert.ok(!clean.review && !clean.fix, 'clean: backups removed');

    // Per-phase phase_commit_docs=false: cmdCommit exits 0 printing "skipped"; the step must warn, not claim success.
    const phaseOff = drive('true', 'issues_found', 'skipped');
    assert.strictEqual(phaseOff.count, '1', 'a skipped commit commits nothing');
    assert.ok(phaseOff.review && phaseOff.fix, 'backups are retained on disk');
    assert.match(phaseOff.stdout, /Warning: iteration backups not committed \(skipped\)/);
    assert.doesNotMatch(phaseOff.stdout, /untracked/);

    // Backups already committed and unchanged: cmdCommit exits 0 printing "nothing" — success, no warning.
    const nothing = drive('true', 'issues_found', 'nothing');
    assert.doesNotMatch(nothing.stdout, /Warning: iteration backups not committed/);

    // cmdCommit prints the literal "committed" when it has no hash to report — also success.
    const committed = drive('true', 'issues_found', 'committed');
    assert.doesNotMatch(committed.stdout, /Warning: iteration backups not committed/);

    // A failed commit (non-zero exit, or a rejecting hook) warns with the reason and never claims "untracked".
    const failed = drive('true', 'issues_found', 'fail');
    assert.match(failed.stdout, /Warning: iteration backups not committed \(failed\)/);
    assert.doesNotMatch(failed.stdout, /untracked/);
  });

  test('T6d — #5506: a converged run commits the deletion of backups an earlier degraded run committed', { skip: !HAS_BASH }, (t) => {
    const fence = stepFence(fs.readFileSync(WORKFLOW_PATH, 'utf8'), 'cleanup_iteration_backups');
    const dir = seedBackupRepo(t, 'gsd-5506-converged-', 'clean', true);
    const git = (...a) => gitOrThrow(a, { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    const script = (body) => [
      'set -euo pipefail',
      'cd "' + dir + '"',
      'gsd_run() { [ "$1 $2" = "query commit" ] || return 1;' + body,
      'AUTO_MODE=true',
      'COMMIT_DOCS=true',
      'PADDED_PHASE=01',
      'REVIEW_PATH="' + path.join(dir, '01-REVIEW.md') + '"',
      'FIX_REPORT_PATH="' + path.join(dir, '01-REVIEW-FIX.md') + '"',
      fence,
    ].join('\n');
    // A "nothing" result means the deletion was not staged: the converged arm must warn.
    const warned = runHook('-c', [script(' echo nothing; return 0; }')], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
    assert.match(warned.stdout, /Warning: iteration backup deletions not committed \(nothing\)/);
    git('add', '-A');
    git('reset', '-q', '--hard');
    for (const f of ['01-REVIEW.iter2.md', '01-REVIEW-FIX.iter2.md']) fs.writeFileSync(path.join(dir, f), 'scratch');
    const res = runHook('-c', [script(REAL_COMMIT_BODY)], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(res.exitCode, 0, 'the cleanup step must never abort: ' + res.stderr);
    assert.strictEqual(git('status', '--porcelain').trim(), '', 'the tree must be clean');
    assert.deepStrictEqual(splitLines(git('ls-tree', '-r', '--name-only', 'HEAD')).filter(Boolean).sort(),
      ['01-REVIEW-FIX.md', '01-REVIEW.md'], 'the backups are gone from HEAD');
  });

  test('T6e — #5506: a converged run with COMMIT_DOCS=false leaves committed backups in place and warns', { skip: !HAS_BASH }, (t) => {
    const fence = stepFence(fs.readFileSync(WORKFLOW_PATH, 'utf8'), 'cleanup_iteration_backups');
    const dir = seedBackupRepo(t, 'gsd-5506-nodocs-', 'clean', true);
    const script = [
      'set -euo pipefail',
      'cd "' + dir + '"',
      'gsd_run() { echo "$*" >> gsd-calls.log; return 1; }',
      'AUTO_MODE=true',
      'COMMIT_DOCS=false',
      'PADDED_PHASE=01',
      'REVIEW_PATH="' + path.join(dir, '01-REVIEW.md') + '"',
      'FIX_REPORT_PATH="' + path.join(dir, '01-REVIEW-FIX.md') + '"',
      fence,
    ].join('\n');
    const res = runHook('-c', [script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(res.exitCode, 0, 'the cleanup step must never abort: ' + res.stderr);
    assert.strictEqual(gitOrThrow(['status', '--porcelain'], { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS }).trim(), '', 'no uncommitted deletions');
    assert.ok(fs.existsSync(path.join(dir, '01-REVIEW.iter2.md')), 'tracked backups are not removed without a commit');
    assert.match(res.stdout, /Warning: commit_docs is off; tracked iteration backups left in place/);
  });
});
