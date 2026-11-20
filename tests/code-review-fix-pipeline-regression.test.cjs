// allow-test-rule: source-text-is-the-product (see #3190)
// The workflow .md IS the product: its embedded bash/node snippets are loaded
// and executed verbatim by the agent host at runtime. Testing that the deployed
// commit-fix step exports the env var its own inline `node -e` body reads, and
// that the docs commit stages the converged REVIEW.md alongside REVIEW-FIX.md
// (#3190), and alone when the fix report is invalid or missing (#5527),
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
const os = require('node:os');
const path = require('node:path');
const { runNode, runGit, runHook } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { have } = require('./helpers/bash-probe.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { PROBE_TIMEOUT_MS, SEAM_DEFAULT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// Every real-git fixture below runs under no developer or system git config (core.hooksPath,
// status.showUntrackedFiles), so the stub, the fence and the real CLI see the same git settings.
const GIT_CONFIG_OFF = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
const GIT_ENV = isolatedEnv({ home: os.tmpdir(), override: GIT_CONFIG_OFF });
const T6_OPTS = { timeoutMs: PROBE_TIMEOUT_MS, env: GIT_ENV };
// The fence is POSIX bash: bash on PATH and not win32 (same gate as the property test).
const { posixBashSkip } = require('./helpers/posix-bash-gate.cjs');
const BASH_SKIP = posixBashSkip();

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
const {
  createTempDir, createTempGitProject, cleanup, TOOLS_PATH, runGsdTools,
} = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

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

// Mirrors `query commit MSG [--files F...] [--files-removed F...] --raw` (src/commands.cts
// cmdCommit, proven against the real CLI by T6i): --files paths missing on disk are SKIPPED
// (#2014); only --files-removed stages a deletion, and a path there still on disk prints "failed"
// before any commit (staging_failed); an empty scoped diff prints "nothing"; the commit is scoped
// to the named paths (-- <paths>), so an unrelated pre-staged file is never swept in (#2112). A
// stub that `git add`s everything would mask a deletion routed through --files. A call that names
// no path at all is unscoped and sweeps in all of .planning/, which the fence's guard prevents.
const REAL_COMMIT_BODY = ' local msg="$3"; shift 3; local m="" n=0 a=() r=() p=();'
  + ' while [ $# -gt 0 ]; do case "$1" in --files) m=a;; --files-removed) m=r;; --raw) m="";;'
  + ' *) [ -n "$m" ] && n=1; if [ "$m" = a ] && [ -e "$1" ]; then a+=("$1");'
  + ' elif [ "$m" = r ]; then r+=("$1"); fi;; esac; shift; done;'
  + ' if [ "$n" = 0 ] && [ -e .planning ]; then a=(.planning/); fi;'
  + ' for f in ${r[@]+"${r[@]}"}; do [ -e "$f" ] && { echo failed; return 0; }; done;'
  + ' if [ ${#a[@]} -gt 0 ]; then git add -- "${a[@]}"; p+=("${a[@]}"); fi;'
  + ' if [ ${#r[@]} -gt 0 ]; then git rm -q --cached --ignore-unmatch -- "${r[@]}";'
  + ' p+=("${r[@]}"); fi;'
  + ' if [ ${#p[@]} -eq 0 ] || git diff --cached --quiet -- "${p[@]}"; then'
  + ' echo nothing; return 0; fi;'
  + ' git commit -q -m "$msg" -- "${p[@]}" && git rev-parse --short HEAD; }';

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

  test(
    'T6b — the cleanup fence, EXECUTED: removes on clean, retains on anything else',
    { skip: BASH_SKIP }, () => {
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

  // The git fixture and the gsd_run stub prefix every T6 repo is built from (seedBackupRepo, T6i).
  const initRepo = (t, prefix) => {
    const dir = createTempDir(prefix);
    t.after(() => cleanup(dir));
    const git = (...a) => gitOrThrow(a, { cwd: dir, ...T6_OPTS });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    return { dir, git };
  };
  const gsdRunStub = (body) => 'gsd_run() { [ "$1 $2" = "query commit" ] || return 1;' + body;

  // One real-git fixture for the T6 tests below: a seeded repo holding REVIEW(-FIX).md plus two
  // iter2 backups, committed (a degraded run already committed them) or left untracked (this run
  // just wrote them).
  const seedBackupRepo = (t, prefix, status, committedBackups) => {
    const { dir, git } = initRepo(t, prefix);
    fs.writeFileSync(
      path.join(dir, '01-REVIEW.md'),
      ['---', 'status: ' + status, '---'].join('\n')
    );
    fs.writeFileSync(path.join(dir, '01-REVIEW-FIX.md'), 'fix');
    const writeBackups = () => {
      for (const f of ['01-REVIEW.iter2.md', '01-REVIEW-FIX.iter2.md']) {
        fs.writeFileSync(path.join(dir, f), 'scratch');
      }
    };
    if (committedBackups) writeBackups();
    git('add', '.');
    git('commit', '-q', '-m', 'seed');
    if (!committedBackups) writeBackups();
    return dir;
  };

  // Shared by T6c-T6g: run the shipped fence in a seeded repo with the real-CLI stub.
  const runFence = (dir, { commitDocs = 'true', pre = '', post = '', body = REAL_COMMIT_BODY,
    interpreter = 'bash' } = {}) => {
    const fence = stepFence(fs.readFileSync(WORKFLOW_PATH, 'utf8'), 'cleanup_iteration_backups');
    const script = [
      'set -euo pipefail',
      'cd "' + dir + '"',
      gsdRunStub(body),
      'AUTO_MODE=true',
      'COMMIT_DOCS=' + commitDocs,
      'PADDED_PHASE=01',
      'REVIEW_PATH="' + path.join(dir, '01-REVIEW.md') + '"',
      'FIX_REPORT_PATH="' + path.join(dir, '01-REVIEW-FIX.md') + '"',
      pre,
      fence,
      post,
    ].join('\n');
    const res = runHook('-c', [script], { interpreter, ...T6_OPTS });
    assert.strictEqual(res.exitCode, 0, 'the cleanup step must never abort: ' + res.stderr);
    return res;
  };
  const headFiles = (dir) => splitLines(gitOrThrow(
    ['ls-tree', '-r', '--name-only', 'HEAD'],
    { cwd: dir, ...T6_OPTS }
  )).filter(Boolean).sort();
  // What gsd_run prints per cmdCommit outcome: T6c drives each mode, T6i checks `skipped` for real.
  const stubs = {
    skipped: ' echo skipped; return 0; }',
    nothing: ' echo nothing; return 0; }',
    committed: ' echo committed; return 0; }',
    fail: ' return 1; }',
  };

  test('T6c — #5506: retained backups are COMMITTED when COMMIT_DOCS=true, left alone when false',
    { skip: BASH_SKIP }, (t) => {
    // A non-clean --auto run retains <NN>-REVIEW(-FIX).iterN.md. Untracked, they leave a dirty tree
    // that /gsd-ship's clean-tree preflight refuses. Execute the shipped fence against a real repo.
    // The default mode runs the real-CLI stub (REAL_COMMIT_BODY, add + scoped commit, prints the
    // hash); the other modes make gsd_run print what cmdCommit prints for that outcome, so every
    // defined outcome is driven: `skipped` is a commit_docs policy skip (per-phase override or
    // gitignored .planning; src/commands.cts cmdCommit), `nothing` and `committed` are silent
    // successes, `fail` exits 1.
    const git = (dir, ...a) => runGit(a, { cwd: dir, ...T6_OPTS });

    // `keep` of the two seeded backups stay on disk (the guard boundary: 0, 1, 2); `planning` adds
    // untracked work under .planning/ that an unscoped commit would sweep in.
    const drive = (commitDocs, status = 'issues_found', mode = 'commit',
      { keep = 2, planning = false } = {}) => {
      const dir = seedBackupRepo(t, 'gsd-5506-cleanup-', status, false);
      for (const f of ['01-REVIEW-FIX.iter2.md', '01-REVIEW.iter2.md'].slice(keep)) {
        fs.unlinkSync(path.join(dir, f));
      }
      if (planning) {
        fs.mkdirSync(path.join(dir, '.planning'));
        fs.writeFileSync(path.join(dir, '.planning', 'other.md'), 'not a backup');
      }
      const res = runFence(dir, {
        commitDocs,
        body: ' echo "$*" >> gsd-calls.log;' + (stubs[mode] || REAL_COMMIT_BODY),
      });
      const log = path.join(dir, 'gsd-calls.log');
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      if (calls) fs.unlinkSync(log);
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
    assert.ok(on.review && on.fix, 'backups are retained on disk');
    assert.strictEqual(on.subject, 'docs(01): retain code review iteration backups');
    assert.strictEqual(on.count, '2', 'exactly one new commit beyond the seed');
    assert.deepStrictEqual(on.tracked,
      ['01-REVIEW-FIX.iter2.md', '01-REVIEW-FIX.md', '01-REVIEW.iter2.md', '01-REVIEW.md'],
      'both backups are recoverable from git');
    assert.doesNotMatch(on.stdout, /^(Warning|Note)/m, 'a hash prints no warning or note');

    // The guard boundary. With no backup, `query commit` must not run at all: given no path it
    // commits all of .planning/ (src/commands.cts cmdCommit), which the stub models.
    const none = drive('true', 'issues_found', 'commit', { keep: 0, planning: true });
    assert.strictEqual(none.calls, '', '0 backups: no commit attempted');
    assert.strictEqual(none.count, '1', '0 backups: no commit');
    assert.strictEqual(none.status, '?? .planning/', '0 backups: .planning/ is left alone');
    const one = drive('true', 'issues_found', 'commit', { keep: 1, planning: true });
    assert.strictEqual(one.count, '2', '1 backup: one commit');
    assert.deepStrictEqual(one.tracked,
      ['01-REVIEW-FIX.iter2.md', '01-REVIEW-FIX.md', '01-REVIEW.md'],
      '1 backup: the commit holds only that backup');

    const off = drive('false');
    assert.strictEqual(
      off.calls,
      '',
      'COMMIT_DOCS=false: .planning is gitignored, no commit attempted'
    );
    assert.ok(off.review && off.fix, 'backups are retained on disk');

    const clean = drive('true', 'clean');
    assert.strictEqual(clean.calls, '', 'clean: no commit attempted');
    assert.ok(!clean.review && !clean.fix, 'clean: backups removed');

    // Silent successes: nothing to warn about, and the fence asked for exactly one commit.
    for (const mode of ['nothing', 'committed']) {
      const quiet = drive('true', 'issues_found', mode);
      assert.strictEqual(splitLines(quiet.calls).filter(Boolean).length, 1, mode + ': one call');
      assert.ok(quiet.review && quiet.fix, mode + ': backups are retained on disk');
      assert.doesNotMatch(quiet.stdout, /^(Warning|Note)/m, mode + ': no warning or note');
    }

    // A commit_docs policy skip: cmdCommit exits 0 printing "skipped"; say so, not "failed".
    const phaseOff = drive('true', 'issues_found', 'skipped');
    assert.strictEqual(phaseOff.count, '1', 'a skipped commit commits nothing');
    assert.ok(phaseOff.review && phaseOff.fix, 'backups are retained on disk');
    assert.match(phaseOff.stdout, /skipped by the commit_docs policy/);
    assert.doesNotMatch(
      phaseOff.stdout,
      /staged/,
      'a skip stages nothing, so it must not advise unstaging'
    );
    assert.doesNotMatch(phaseOff.stdout, /already deleted/, 'a retained backup is not deleted');

    // A failed commit (non-zero exit, or a rejecting hook) commits nothing and never aborts the
    // step.
    const failed = drive('true', 'issues_found', 'fail');
    assert.strictEqual(failed.count, '1', 'a failed commit commits nothing');
    assert.ok(failed.review && failed.fix, 'backups are retained on disk');
    assert.match(failed.stdout, /commit failed/);
    assert.match(failed.stdout, /git restore --staged/);
  });

  test(
    'T6d — #5506: a converged run removes every backup; with COMMIT_DOCS=true it commits the '
      + 'removal of tracked ones, and nothing else',
    { skip: BASH_SKIP }, (t) => {
    // A degraded run commits its backups, so a later converged run may find them tracked. Deleting
    // them without a commit leaves ` D` entries that /gsd-ship refuses (maintainer ruling, 11-11).
    const backups = ['01-REVIEW.iter2.md', '01-REVIEW-FIX.iter2.md'];
    for (const commitDocs of ['true', 'false']) {
      for (const committed of [true, false]) {
        const label = 'COMMIT_DOCS=' + commitDocs + (committed ? ', tracked' : ', untracked');
        const dir = seedBackupRepo(t, 'gsd-5506-converged-', 'clean', committed);
        runFence(dir, { commitDocs, body: ' echo "$*" >> gsd-calls.log;' + REAL_COMMIT_BODY });
        const log = path.join(dir, 'gsd-calls.log');
        const calls = fs.existsSync(log)
          ? splitLines(fs.readFileSync(log, 'utf8')).filter(Boolean) : [];
        if (calls.length) fs.unlinkSync(log);
        const git = (...a) => gitOrThrow(a, { cwd: dir, ...T6_OPTS });
        for (const f of backups) {
          assert.ok(!fs.existsSync(path.join(dir, f)), label + ': ' + f + ' removed');
        }
        // COMMIT_DOCS=false with tracked backups is out of the ruling: removal is not committed.
        if (commitDocs === 'true' || !committed) {
          assert.strictEqual(git('status', '--porcelain'), '', label + ': the tree is clean');
        }
        if (commitDocs === 'true' && committed) {
          assert.strictEqual(calls.length, 1, label + ': one commit call');
          assert.match(calls[0], /--files-removed/, label + ': the removal is declared');
          assert.strictEqual(git('rev-list', '--count', 'HEAD').trim(), '2', label + ': 1 commit');
          assert.strictEqual(git('log', '-1', '--format=%s').trim(),
            'docs(01): remove spent code review iteration backups');
          for (const f of backups) {
            assert.ok(!headFiles(dir).includes(f), label + ': ' + f + ' gone from HEAD');
          }
        } else {
          assert.deepStrictEqual(calls, [], label + ': no commit attempted');
          assert.strictEqual(git('rev-list', '--count', 'HEAD').trim(), '1', label + ': no commit');
        }
      }
    }

    // A failed removal commit: the files are already deleted, so unstaging cannot help. The
    // warning must tell the user to commit the removal.
    const failDir = seedBackupRepo(t, 'gsd-5506-converged-fail-', 'clean', true);
    const failed = runFence(failDir, { commitDocs: 'true', body: ' return 1; }' });
    assert.match(failed.stdout, /commit failed/);
    assert.match(failed.stdout, /commit the removal yourself/);
    assert.doesNotMatch(failed.stdout, /git restore --staged/);
    assert.match(failed.stdout, /git add -u -- <the listed files>/, 'the hint names the paths');

    // A policy-skipped removal commit leaves the deletion uncommitted: the note says so, too.
    const skipDir = seedBackupRepo(t, 'gsd-5506-converged-skip-', 'clean', true);
    const skipped = runFence(skipDir, { commitDocs: 'true', body: stubs.skipped });
    assert.match(skipped.stdout, /skipped by the commit_docs policy/);
    assert.match(skipped.stdout, /commit the removal yourself/);

    // One tracked and one untracked backup: only the tracked one is declared (the real CLI refuses
    // an untracked path in --files-removed), and the untracked one is still deleted.
    const mixed = seedBackupRepo(t, 'gsd-5506-converged-mix-', 'clean', true);
    fs.writeFileSync(path.join(mixed, '01-REVIEW.iter3.md'), 'scratch');
    runFence(mixed, { body: ' echo "$*" >> gsd-calls.log;' + REAL_COMMIT_BODY });
    const mixedCalls = splitLines(fs.readFileSync(path.join(mixed, 'gsd-calls.log'), 'utf8'))
      .filter(Boolean);
    assert.strictEqual(mixedCalls.length, 1, 'mixed: one commit call');
    assert.doesNotMatch(mixedCalls[0], /iter3/, 'mixed: the untracked backup is not declared');
    assert.match(mixedCalls[0], /01-REVIEW\.iter2\.md/, 'mixed: the tracked backup is declared');
    assert.ok(
      !fs.existsSync(path.join(mixed, '01-REVIEW.iter3.md')),
      'mixed: untracked backup deleted',
    );
  });

  test(
    'T6e — #5506: only .iter<digits>.md files are backups (.iter2x.md, .iter2-notes.md are not)',
    { skip: BASH_SKIP }, (t) => {
    const notes = ['01-REVIEW.iter2x.md', '01-REVIEW.iter2-notes.md'];
    const degraded = seedBackupRepo(t, 'gsd-5506-glob-d-', 'issues_found', false);
    for (const n of notes) fs.writeFileSync(path.join(degraded, n), 'mine');
    runFence(degraded);
    for (const n of notes) assert.ok(
      !headFiles(degraded).includes(n),
      'a degraded run must not commit ' + n
    );
    const converged = seedBackupRepo(t, 'gsd-5506-glob-c-', 'clean', false);
    for (const n of notes) fs.writeFileSync(path.join(converged, n), 'mine');
    runFence(converged);
    for (const n of notes) assert.ok(
      fs.existsSync(path.join(converged, n)),
      'a converged run must not delete ' + n
    );
  });

  test('T6f — #5506: nullglob is restored to the caller state', { skip: BASH_SKIP }, (t) => {
    const post = 'shopt -q nullglob && echo NG=on || echo NG=off';
    const dir = seedBackupRepo(t, 'gsd-5506-shopt-', 'clean', true);
    assert.match(runFence(dir, { pre: 'shopt -s nullglob', post }).stdout, /NG=on/);
    const dir2 = seedBackupRepo(t, 'gsd-5506-shopt2-', 'clean', true);
    assert.match(runFence(dir2, { pre: 'shopt -u nullglob', post }).stdout, /NG=off/);
  });

  // Skips where zsh is absent: the lane that provides it is the macOS runner. The fence is run by
  // whatever shell the agent host has; the maintainer's zsh reproduction is a
  // bare `shopt` (rc 127 under set -e) and, with no backup, `no matches found`.
  test('T6g — #5506: the cleanup fence runs under zsh',
    { skip: !have('zsh') && 'zsh is not on PATH' }, (t) => {
    const zsh = { interpreter: 'zsh', body: ' return 1; }' };
    const backups = ['01-REVIEW.iter2.md', '01-REVIEW-FIX.iter2.md'];
    const none = seedBackupRepo(t, 'gsd-5506-zsh-none-', 'clean', false);
    for (const f of backups) fs.unlinkSync(path.join(none, f));
    runFence(none, zsh);

    const mixed = seedBackupRepo(t, 'gsd-5506-zsh-mix-', 'clean', false);
    fs.writeFileSync(path.join(mixed, '01-REVIEW.iter2-notes.md'), 'mine');
    runFence(mixed, zsh);
    for (const f of backups) assert.ok(!fs.existsSync(path.join(mixed, f)), f + ' removed');
    assert.ok(fs.existsSync(path.join(mixed, '01-REVIEW.iter2-notes.md')), 'notes kept');

    const off = seedBackupRepo(t, 'gsd-5506-zsh-off-', 'issues_found', false);
    runFence(off, { ...zsh, commitDocs: 'false' });
    for (const f of backups) assert.ok(fs.existsSync(path.join(off, f)), f + ' retained');

    // The caller's NULL_GLOB is restored from either state, as T6f checks for bash.
    for (const [pre, want] of [['unsetopt NULL_GLOB', /NG=off/], ['setopt NULL_GLOB', /NG=on/]]) {
      const ng = seedBackupRepo(t, 'gsd-5506-zsh-ng-', 'clean', false);
      const post = '[[ -o NULL_GLOB ]] && echo NG=on || echo NG=off';
      assert.match(runFence(ng, { ...zsh, pre, post }).stdout, want, pre);
    }
  });

  // The three readers of "what is a backup": the cleanup fence, the disposition step's bash loop,
  // and the disposition step's node `iterOf`. They must classify every name alike.
  test('T6h — #5506: the three backup readers agree on which names are backups',
    { skip: BASH_SKIP }, (t) => {
    const FIX = 'gsd-core/workflows/code-review-fix.md';
    const DISP = 'gsd-core/workflows/execute-phase/steps/code-review-disposition.md';
    // `iter3` is what auto_iteration_loop writes (`.iter${ITERATION}.md`) at ITERATION=3.
    const stems = ['iter2', 'iter02', 'iter12', 'iter3', 'iter', 'iter2-notes', 'iter2.bak',
      'iterations-notes', 'iter2x.iter3'];
    const names = stems.map((s) => '01-REVIEW-FIX.' + s + '.md');
    const expected = names.map((n) => /^01-REVIEW-FIX\.iter[0-9]+\.md$/.test(n));
    const one = (name, lines, preamble, probe) => {
      const dir = createTempDir('gsd-5506-readers-');
      t.after(() => cleanup(dir));
      if (name) fs.writeFileSync(path.join(dir, name), 'x');
      const r = runBash(lines, { stdout: '', rc: 0 }, { preamble: preamble(dir), probe });
      assert.strictEqual(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const reader1 = names.map((n) => one(n, span(FIX, 'BACKUP_FILES=()', 'done'),
      (d) => ['cd "' + d + '"', 'shopt -s nullglob', 'REVIEW_PATH="' + d + '/01-REVIEW.md"',
        'FIX_REPORT_PATH="' + d + '/01-REVIEW-FIX.md"'],
      'echo "${#BACKUP_FILES[@]}"') !== '0');
    const reader2 = names.map((n) => one(n, span(DISP, '_fix_any=0', 'done'),
      (d) => ['_pd="' + d + '"', 'PADDED=01'], 'echo "$_fix_any"') !== '0');
    const dispLines = splitLines(fs.readFileSync(path.join(ROOT, DISP), 'utf8'));
    const from = dispLines.findIndex(
      (l) => l.includes('const FIX_FINAL = process.env.FIX_REPORT_FILE;'));
    const to = dispLines.findIndex((l, i) => i >= from && l.trim().startsWith('const iterOf'));
    assert.ok(
      from !== -1 && to !== -1,
      'the disposition node reader must carry FIX_FINAL .. iterOf'
    );
    const node = runBash(
      ['node -e "const path = require(\'path\');', ...dispLines.slice(from, to + 1),
        'for (const n of process.argv.slice(1)) console.log(iterOf(n) !== null)" '
          + names.join(' ')],
      { stdout: '', rc: 0 },
      { setE: false, preamble: ['export FIX_REPORT_FILE=/x/01-REVIEW-FIX.md'] });
    assert.strictEqual(node.status, 0, node.stderr);
    const reader3 = splitLines(node.stdout).filter(Boolean).map((l) => l === 'true');
    assert.deepStrictEqual(reader1, expected, 'cleanup fence');
    assert.deepStrictEqual(reader2, expected, 'disposition bash loop');
    assert.deepStrictEqual(reader3, expected, 'disposition node iterOf');
    assert.strictEqual(expected.filter(Boolean).length, 4, 'iter2, iter02, iter12, iter3');
  });

  // The disposition step's backup loop under zsh, whose default NOMATCH aborts an unmatched glob
  // with `no matches found`. No backup is the common case: every non---auto run.
  test('T6j — #5506: the disposition backup loop runs under zsh',
    { skip: !have('zsh') && 'zsh is not on PATH' }, (t) => {
    const DISP = 'gsd-core/workflows/execute-phase/steps/code-review-disposition.md';
    const loop = span(DISP, '_fix_any=0', '[ "$NG_WAS_SET" = true ]').join('\n');
    const fixAny = (name) => {
      const dir = createTempDir('gsd-5506-disp-zsh-');
      t.after(() => cleanup(dir));
      if (name) fs.writeFileSync(path.join(dir, name), 'x');
      const script = ['set -euo pipefail', '_pd="' + dir + '"', 'PADDED=01', loop,
        'echo "fix_any=$_fix_any"', '[[ -o NULL_GLOB ]] && echo NG=on || echo NG=off'].join('\n');
      const res = runHook('-c', [script], { interpreter: 'zsh', ...T6_OPTS });
      assert.strictEqual(res.exitCode, 0, (name || 'no backup') + ': ' + res.stderr);
      assert.match(res.stdout, /NG=off/, 'the caller NULL_GLOB state is restored');
      return /fix_any=(\d)/.exec(res.stdout)[1];
    };
    assert.strictEqual(fixAny(null), '0', 'no backup');
    assert.strictEqual(fixAny('01-REVIEW-FIX.iter2.md'), '1', 'a digit backup');
    assert.strictEqual(fixAny('01-REVIEW-FIX.iter2-notes.md'), '0', 'a notes-only name');
  });

  // The stub is only worth its place if cmdCommit does what it does: run both over the same
  // scenarios and compare the printed token, the files in HEAD and the working-tree status.
  test('T6i — #5506: the commit stub behaves like the real `query commit` CLI',
    { skip: BASH_SKIP }, (t) => {
    const A = '01-REVIEW.iter2.md';
    const B = '01-REVIEW-FIX.iter2.md';
    const P = '.planning/phases/01-x/' + A;
    const scenarios = {
      'both --files present': { setup: (w) => { w(A); w(B); }, args: ['--files', A, B] },
      'one --files missing': { setup: (w) => { w(A); }, args: ['--files', A, B] },
      'no --files present': { setup: () => {}, args: ['--files', A, B] },
      'unrelated file pre-staged': {
        setup: (w, g) => { w(A); w('other.md', 'changed'); g('add', 'other.md'); },
        args: ['--files', A],
      },
      '--files-removed path still on disk': {
        tracked: [A], setup: () => {}, args: ['--files-removed', A],
      },
      '--files-removed deleted path': {
        tracked: [A], setup: (w, g, d) => { fs.unlinkSync(path.join(d, A)); },
        args: ['--files-removed', A],
      },
      'tracked and unchanged --files': {
        tracked: [A], setup: () => {}, args: ['--files', A], expect: 'nothing',
      },
      // The fence passes absolute paths (REVIEW_PATH, FIX_REPORT_PATH), through both flags.
      'absolute --files paths': {
        setup: (w) => { w(A); w(B); }, args: (d) => ['--files', path.join(d, A), path.join(d, B)],
      },
      'absolute --files-removed path': {
        tracked: [A], setup: (w, g, d) => { fs.unlinkSync(path.join(d, A)); },
        args: (d) => ['--files-removed', path.join(d, A)],
      },
      // What the fence's guard prevents: no path named, so the commit sweeps in .planning/.
      'empty --files list': {
        setup: (w, g, d) => { fs.mkdirSync(path.join(d, '.planning')); w('.planning/x.md'); },
        args: ['--files'],
      },
      // A check on the real CLI only: the stub side is stubs.skipped, a constant.
      'phase_commit_docs false under .planning/phases (real CLI only)': {
        body: stubs.skipped, args: ['--files', P], expect: 'skipped',
        setup: (w, g, d) => {
          fs.mkdirSync(path.join(d, '.planning/phases/01-x'), { recursive: true });
          w('.planning/config.json', '{"phase_commit_docs":{"01":false}}');
          w(P);
        },
      },
      // The converged arm passes --files-removed only: the per-phase tier must still resolve.
      'phase_commit_docs false with --files-removed under .planning/phases (real CLI only)': {
        body: stubs.skipped, args: ['--files-removed', P], expect: 'skipped',
        setup: (w, g, d) => {
          fs.mkdirSync(path.join(d, '.planning/phases/01-x'), { recursive: true });
          w(P);
          g('add', P);
          g('commit', '-q', '-m', 'track backup');
          w('.planning/config.json', '{"phase_commit_docs":{"01":false}}');
          fs.unlinkSync(path.join(d, P));
        },
      },
    };
    const build = (sc) => {
      const { dir, git: g } = initRepo(t, 'gsd-5506-parity-');
      const w = (f, c = 'scratch') => fs.writeFileSync(path.join(dir, f), c);
      w('01-REVIEW.md', 'review');
      w('other.md', 'base');
      for (const f of sc.tracked || []) w(f);
      g('add', '.');
      g('commit', '-q', '-m', 'seed');
      sc.setup(w, g, dir);
      return { dir, g };
    };
    const cls = (tok) => (/^[0-9a-f]{7,40}$/.test(tok) ? 'hash' : tok);
    for (const [label, sc] of Object.entries(scenarios)) {
      const args = (d) => (typeof sc.args === 'function' ? sc.args(d) : sc.args);
      const stub = build(sc);
      const quoted = args(stub.dir).map((a) => JSON.stringify(a)).join(' ');
      const script = ['cd "' + stub.dir + '"', gsdRunStub(sc.body || REAL_COMMIT_BODY),
        'gsd_run query commit "msg" ' + quoted + ' --raw'].join('\n');
      const sres = runHook('-c', [script], { interpreter: 'bash', ...T6_OPTS });
      assert.strictEqual(sres.exitCode, 0, label + ': stub: ' + sres.stderr);
      const real = build(sc);
      const rres = runGsdTools(
        ['query', 'commit', 'msg', ...args(real.dir), '--raw'],
        real.dir,
        isolatedEnv({ home: real.dir, override: GIT_CONFIG_OFF })
      );
      const state = (x) => ({
        head: splitLines(x.g('ls-tree', '-r', '--name-only', 'HEAD')).filter(Boolean).sort(),
        status: x.g('status', '--porcelain'),
      });
      assert.strictEqual(
        cls(sres.stdout.trim()),
        cls(rres.output.trim()),
        label + ': printed token'
      );
      assert.deepStrictEqual(state(stub), state(real), label + ': repository state');
      if (sc.expect) assert.strictEqual(rres.output.trim(), sc.expect, label + ': real CLI token');
    }
  });

  // Shared by T7/T8: strict-mode header, `head` lines (cd/stub), the step's input vars, the
  // workflow fence, then `trailer` lines.
  const fenceScript = (fence, vars, head, trailer = []) => [
    'set -uo pipefail',
    ...head,
    ...Object.entries(vars).map(([k, v]) => k + '=' + v),
    fence,
    ...trailer,
  ].join('\n');

  // #5527: the converged REVIEW.md must be committed even when the fix report is invalid or
  // missing, else a tracked rewritten REVIEW.md stays dirty and /gsd-ship asks to commit or
  // stash. The fence is EXECUTED with a stub gsd_run that records its argv.
  test('T7 — commit_fix_report EXECUTED: --auto REVIEW.md committed ' +
    'when fix report is invalid/missing/valid', { skip: BASH_SKIP }, (t) => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const fence = stepFence(src, 'commit_fix_report');

    const drive = ({ report, auto = 'true', docs = 'true' }) => {
      const dir = createTempDir('gsd-5527-');
      t.after(() => cleanup(dir));
      const reviewPath = path.join(dir, '01-REVIEW.md');
      const fixPath = path.join(dir, '01-REVIEW-FIX.md');
      const log = path.join(dir, 'argv.log');
      fs.writeFileSync(reviewPath, '---\nstatus: clean\n---\n');
      if (report !== null) fs.writeFileSync(fixPath, report);
      const script = fenceScript(fence, {
        AUTO_MODE: auto,
        COMMIT_DOCS: docs,
        PADDED_PHASE: '01',
        REVIEW_PATH: '"' + reviewPath + '"',
        FIX_REPORT_PATH: '"' + fixPath + '"',
      }, ['gsd_run() { { printf "%s\\n" "$@"; echo "--"; } >> "' + log + '"; }']);
      const res = runHook('-c', [script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
      assert.strictEqual(res.exitCode, 0, 'step must not abort: ' + res.stderr);
      const calls = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('--\n').filter(Boolean);
      assert.ok(calls.length <= 1, 'at most one query commit call');
      return { argv: calls.length ? calls[0].split('\n') : null, reviewPath, fixPath };
    };

    // AC1: fix report lacks status => REVIEW.md still committed, the malformed report is not (AC3).
    const invalid = drive({ report: '---\nfoo: bar\n---\n' });
    assert.ok(invalid.argv, 'invalid frontmatter in --auto must still commit REVIEW.md');
    assert.ok(invalid.argv.includes(invalid.reviewPath), 'REVIEW.md staged');
    assert.ok(!invalid.argv.includes(invalid.fixPath), 'malformed fix report must NOT be staged');
    assert.ok(invalid.argv.includes('docs(01): update code review report'), 'invalid: report-only message');

    // AC2: fix report absent.
    const missing = drive({ report: null });
    assert.ok(missing.argv, 'missing fix report in --auto must still commit REVIEW.md');
    assert.ok(missing.argv.includes(missing.reviewPath), 'REVIEW.md staged');
    assert.ok(!missing.argv.includes(missing.fixPath), 'absent fix report must NOT be staged');
    assert.ok(missing.argv.includes('docs(01): update code review report'), 'missing: report-only message');

    // Valid path unchanged: both staged.
    const valid = drive({ report: VALID_FIX_REPORT });
    assert.ok(valid.argv.includes(valid.fixPath) && valid.argv.includes(valid.reviewPath), 'valid: both staged');
    assert.ok(valid.argv.includes('docs(01): add code review fix report'), 'valid keeps its message');

    // Out of scope stays out: non-auto and COMMIT_DOCS=false commit no REVIEW.md.
    assert.ok(!drive({ report: '---\nfoo: bar\n---\n', auto: 'false' }).argv, 'non-auto invalid commits nothing');
    assert.ok(!drive({ report: null, docs: 'false' }).argv, 'COMMIT_DOCS=false commits nothing');
  });

  // #5527 observable: run the fence against a real repo and the real `query commit`, then read
  // `git status`. A stubbed argv proves the call, not that REVIEW.md lands or what stays dirty.
  test('T8 — commit_fix_report EXECUTED against real git: REVIEW.md lands; ' +
    'only a malformed report stays', { skip: BASH_SKIP }, (t) => {
    const fence = stepFence(fs.readFileSync(WORKFLOW_PATH, 'utf8'), 'commit_fix_report');
    const git = (cwd, ...args) => gitOrThrow(args, { cwd });
    const REVIEW = '.planning/01-REVIEW.md';
    const FIX = '.planning/01-REVIEW-FIX.md';

    const drive = (report, { ignored = false } = {}) => {
      const dir = createTempGitProject('gsd-5527-');
      t.after(() => cleanup(dir));
      if (ignored) fs.writeFileSync(path.join(dir, '.gitignore'), '.planning/\n');
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{"commit_docs": true}\n');
      fs.writeFileSync(path.join(dir, REVIEW), '---\nstatus: issues_found\n---\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'seed');
      fs.writeFileSync(path.join(dir, REVIEW), '---\nstatus: clean\n---\n'); // the --auto re-review rewrite
      fs.writeFileSync(path.join(dir, FIX), report);
      const script = fenceScript(fence, {
        AUTO_MODE: 'true',
        COMMIT_DOCS: 'true',
        PADDED_PHASE: '01',
        REVIEW_PATH: REVIEW,
        FIX_REPORT_PATH: FIX,
      }, [
        'cd ' + JSON.stringify(dir),
        'gsd_run() { ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(TOOLS_PATH) + ' "$@"; }',
      ], [
        // Typed seam: the value the dirty-tree warning is gated on, not the warning's wording.
        'printf "\\n@@DIRTY=%s@@" "${FIX_REPORT_DIRTY-UNSET}"',
      ]);
      const res = runHook('-c', [script], { interpreter: 'bash', timeoutMs: SEAM_DEFAULT_TIMEOUT_MS });
      assert.strictEqual(res.exitCode, 0, 'step must not abort: ' + res.stderr);
      return { status: git(dir, 'status', '--porcelain'), dirty: /@@DIRTY=(.*)@@/.exec(res.stdout)[1] };
    };

    const invalid = drive('---\nfoo: bar\n---\n');
    assert.strictEqual(invalid.dirty, '?? ' + FIX, 'git sees the malformed report: the warning gate is set');
    assert.strictEqual(invalid.status.trim(), '?? ' + FIX, 'REVIEW.md committed; only the malformed report remains');

    const ignoredRun = drive('---\nfoo: bar\n---\n', { ignored: true });
    assert.strictEqual(ignoredRun.status, '', 'gitignored .planning/: tree stays clean');
    assert.strictEqual(ignoredRun.dirty, '', 'git ignores the report: the warning gate is empty');

    const valid = drive(VALID_FIX_REPORT);
    assert.strictEqual(valid.status, '', 'valid report: both committed, tree clean');
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

  test(
    'boundary: 0 proves zero scope, 1 and -1 do not, 00 is zero, CRLF is honored',
    { skip: BASH_SKIP }, () => {
    assert.strictEqual(probe(report('0')).verdict, 'yes', 'limit: 0 in scope');
    assert.strictEqual(probe(report('1')).verdict, 'no', 'limit+1: 1 in scope');
    assert.strictEqual(probe(report('-1')).verdict, 'no', 'limit-1: a negative count is malformed, not zero');
    assert.strictEqual(probe(report('00')).verdict, 'yes', 'a zero-padded zero is still zero');
    assert.strictEqual(probe(report('0', '\r\n')).verdict, 'yes', 'a CRLF report is read the same');
  });

  test('never proves zero from unusable input', { skip: BASH_SKIP }, () => {
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

  test('property: zero scope iff findings_in_scope is zero', { skip: BASH_SKIP }, () => {
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

  test(
    'the fix summary does not claim resolution when nothing was in scope',
    { skip: BASH_SKIP }, () => {
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

// ---------------------------------------------------------------------------
// #5876 — gsd-code-fixer fast-forwards the branch the fixes were made for, in the
// worktree that has it checked out, not in the first `git worktree list` entry
// (the main checkout). The shipped setup_worktree and cleanup-tail fences run
// verbatim against a real repo with a linked worktree.
// ---------------------------------------------------------------------------
describe('#5876 — gsd-code-fixer cleanup fast-forwards the worktree that owns $branch', () => {
  const FIXER_COPIES = [
    path.join('agents', 'gsd-code-fixer.md'),
    path.join('agents', 'gsd-code-fixer.compact.md'),
    path.join('pi', 'package-agents', 'gsd-code-fixer.md'),
  ];
  const GIT_ENV = {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };

  /** Every bash fence of <step name="setup_worktree">, in order: [setup, cleanup tail]. */
  function setupFences(rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
    const open = src.indexOf('<step name="setup_worktree">');
    assert.notStrictEqual(open, -1, `${rel}: setup_worktree step not found`);
    const lines = splitLines(src.slice(open, src.indexOf('</step>', open)));
    const fences = [];
    let start = -1;
    lines.forEach((line, i) => {
      if (start === -1 && /^```bash\s*$/.test(line)) start = i + 1;
      else if (start !== -1 && /^```\s*$/.test(line)) { fences.push(lines.slice(start, i).join('\n')); start = -1; }
    });
    assert.ok(fences.length >= 2, `${rel}: expected a setup fence and a cleanup-tail fence, got ${fences.length}`);
    return fences;
  }

  const runBash = (cwd, script) => runHook('-c', [script], {
    interpreter: 'bash', cwd, timeoutMs: SEAM_DEFAULT_TIMEOUT_MS, env: { ...process.env, ...GIT_ENV },
  });
  /** Run one git command in `cwd` and return its trimmed stdout. */
  const gitOut = (cwd, args) => runBash(cwd, `git ${args}`).stdout.trim();

  /** repo (main, on `main`) + a linked worktree on `feature`; the root name carries a space. */
  function fixture() {
    const base = createTempDir('gsd-5876-');
    const root = path.join(base, 'with space');
    fs.mkdirSync(root);
    const repo = path.join(root, 'repo');
    const featureWt = path.join(root, 'feature-wt');
    fs.mkdirSync(repo);
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: repo });
    gitOrThrow(['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    gitOrThrow(['worktree', 'add', '-q', '-b', 'feature', featureWt], { cwd: repo });
    gitOrThrow(['commit', '-q', '--allow-empty', '-m', 'feature work'], { cwd: featureWt, env: { ...process.env, ...GIT_ENV } });
    const phaseDir = path.join(root, 'phase');
    fs.mkdirSync(phaseDir);
    return { base, root, repo, featureWt, phaseDir };
  }

  function run(rel, cwd, phaseDir, featureWt, between) {
    const [setup, cleanup] = setupFences(rel);
    const script = `padded_phase=06\nphase_dir=${JSON.stringify(phaseDir)}\nFEATURE_WT=${JSON.stringify(featureWt)}\n${setup}\n`
      + 'git commit -q --allow-empty -m "fix(06): CR-01"\n'
      + `${between || ''}\n${cleanup}\n`;
    return runBash(cwd, script);
  }

  for (const rel of FIXER_COPIES) {
    describe(rel, { skip: !HAS_BASH }, () => {
      test('from a linked worktree, the fixes land on $branch and the main checkout is untouched', () => {
        const f = fixture();
        try {
          const r = run(rel, f.featureWt, f.phaseDir, f.featureWt);
          assert.strictEqual(r.exitCode, 0, `fixer shell failed: ${r.stderr}${r.stdout}`);
          assert.strictEqual(gitOut(f.featureWt, 'log -1 --format=%s feature'), 'fix(06): CR-01', '$branch gets the fix commit');
          assert.strictEqual(gitOut(f.repo, 'log -1 --format=%s main'), 'base', 'main is not fast-forwarded');
          assert.strictEqual(gitOut(f.repo, 'branch --list "gsd-reviewfix/*"'), '', 'the temp branch is deleted after the fast-forward');
        } finally { cleanup(f.base); }
      });

      test('the fixer worktree is placed inside the session checkout, also when started from a subdirectory', () => {
        const f = fixture();
        try {
          const sub = path.join(f.featureWt, 'src', 'deep');
          fs.mkdirSync(sub, { recursive: true });
          const r = run(rel, sub, f.phaseDir, f.featureWt, 'echo "WT_PATH=$wt"');
          assert.strictEqual(r.exitCode, 0, `fixer shell failed: ${r.stderr}${r.stdout}`);
          const printed = /^WT_PATH=(.*)$/m.exec(r.stdout);
          assert.ok(printed, `the fence exposes $wt: ${r.stdout}`);
          assert.ok(fs.realpathSync(path.dirname(printed[1])).startsWith(fs.realpathSync(path.join(f.featureWt, '.claude', 'worktrees'))),
            `$wt lives under the session worktree's .claude/worktrees, got ${printed[1]}`);
          assert.strictEqual(gitOut(f.featureWt, 'log -1 --format=%s feature'), 'fix(06): CR-01');
        } finally { cleanup(f.base); }
      });

      test('with no worktree holding $branch, nothing is merged, the temp branch is preserved and the warning says so', () => {
        const f = fixture();
        try {
          const r = run(rel, f.featureWt, f.phaseDir, f.featureWt, 'git -C "$FEATURE_WT" checkout -q --detach');
          assert.strictEqual(r.exitCode, 0, `fixer shell failed: ${r.stderr}${r.stdout}`);
          assert.ok(r.stdout.includes('WARN: could not fast-forward feature to gsd-reviewfix/06-'), `warning names $branch: ${r.stdout}`);
          assert.ok(r.stdout.includes('<no worktree has it checked out>'), `warning says no worktree owns it: ${r.stdout}`);
          assert.strictEqual(gitOut(f.repo, 'log -1 --format=%s main'), 'base', 'main is not touched');
          assert.notStrictEqual(gitOut(f.repo, 'branch --list "gsd-reviewfix/*"'), '', 'the temp branch is preserved');
        } finally { cleanup(f.base); }
      });

      test('from the primary checkout, the outcome is unchanged', () => {
        const f = fixture();
        try {
          const r = run(rel, f.repo, f.phaseDir, f.featureWt);
          assert.strictEqual(r.exitCode, 0, `fixer shell failed: ${r.stderr}${r.stdout}`);
          assert.strictEqual(gitOut(f.repo, 'log -1 --format=%s main'), 'fix(06): CR-01');
          assert.strictEqual(gitOut(f.featureWt, 'log -1 --format=%s feature'), 'feature work', 'the linked branch is untouched');
          assert.strictEqual(gitOut(f.repo, 'branch --list "gsd-reviewfix/*"'), '');
        } finally { cleanup(f.base); }
      });

      test('a diverged $branch preserves the temp branch and the warning names the branch and its worktree', () => {
        const f = fixture();
        try {
          const r = run(rel, f.featureWt, f.phaseDir, f.featureWt, 'git -C "$FEATURE_WT" commit -q --allow-empty -m concurrent');
          assert.strictEqual(r.exitCode, 0, `fixer shell failed: ${r.stderr}${r.stdout}`);
          assert.ok(r.stdout.includes('WARN: could not fast-forward feature to gsd-reviewfix/06-'), `warning names $branch: ${r.stdout}`);
          assert.ok(r.stdout.includes(fs.realpathSync(f.featureWt)), `warning names the worktree the merge was tried in: ${r.stdout}`);
          assert.strictEqual(gitOut(f.repo, 'log -1 --format=%s main'), 'base', 'main is not touched');
          assert.notStrictEqual(gitOut(f.repo, 'branch --list "gsd-reviewfix/*"'), '', 'the temp branch is preserved for a manual merge');
        } finally { cleanup(f.base); }
      });
    });
  }
});
