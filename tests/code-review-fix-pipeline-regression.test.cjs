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
const { have } = require('./helpers/bash-probe.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');
const { runGsdTools } = require('./helpers.cjs');
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

// Mirrors `query commit MSG [--files F...] [--files-removed F...] --raw` (src/commands.cts cmdCommit,
// proven against the real CLI by T6i): --files paths missing on disk are SKIPPED (#2014); only
// --files-removed stages a deletion, and a path there still on disk prints "failed" before any
// commit (staging_failed); an empty scoped diff prints "nothing"; the commit is scoped to the named
// paths (-- <paths>), so an unrelated pre-staged file is never swept in (#2112). A stub that
// `git add`s everything would mask a deletion routed through --files.
const REAL_COMMIT_BODY = ' local msg="$3"; shift 3; local m="" a=() r=() p=();'
  + ' while [ $# -gt 0 ]; do case "$1" in --files) m=a;; --files-removed) m=r;; --raw) m="";;'
  + ' *) if [ "$m" = a ] && [ -e "$1" ]; then a+=("$1");'
  + ' elif [ "$m" = r ]; then r+=("$1"); fi;; esac; shift; done;'
  + ' for f in ${r[@]+"${r[@]}"}; do [ -e "$f" ] && { echo failed; return 0; }; done;'
  + ' if [ ${#a[@]} -gt 0 ]; then git add -- "${a[@]}"; p+=("${a[@]}"); fi;'
  + ' if [ ${#r[@]} -gt 0 ]; then git rm -q --cached --ignore-unmatch -- "${r[@]}"; p+=("${r[@]}"); fi;'
  + ' if [ ${#p[@]} -eq 0 ] || git diff --cached --quiet -- "${p[@]}"; then echo nothing; return 0; fi;'
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

  // One real-git fixture for the T6 tests below: a seeded repo holding REVIEW(-FIX).md plus two
  // iter2 backups,
  // committed (a degraded run already committed them) or left untracked (this run just wrote them).
  const seedBackupRepo = (t, prefix, status, committedBackups) => {
    const dir = createTempDir(prefix);
    t.after(() => cleanup(dir));
    const git = (...a) => gitOrThrow(a, { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(
      path.join(dir, '01-REVIEW.md'),
      ['---', 'status: ' + status, '---'].join('\n')
    );
    fs.writeFileSync(path.join(dir, '01-REVIEW-FIX.md'), 'fix');
    const writeBackups = () => {
      for (const f of ['01-REVIEW.iter2.md', '01-REVIEW-FIX.iter2.md']) fs.writeFileSync(
        path.join(dir, f),
        'scratch'
      );
    };
    if (committedBackups) writeBackups();
    git('add', '.');
    git('commit', '-q', '-m', 'seed');
    if (!committedBackups) writeBackups();
    return dir;
  };

  // Shared by T6c-T6h: run the shipped fence in a seeded repo with the real-CLI stub.
  const runFence = (dir, { commitDocs = 'true', pre = '', post = '', body = REAL_COMMIT_BODY,
    interpreter = 'bash' } = {}) => {
    const fence = stepFence(fs.readFileSync(WORKFLOW_PATH, 'utf8'), 'cleanup_iteration_backups');
    const script = [
      'set -euo pipefail',
      'cd "' + dir + '"',
      'gsd_run() { [ "$1 $2" = "query commit" ] || return 1;' + body,
      'AUTO_MODE=true',
      'COMMIT_DOCS=' + commitDocs,
      'PADDED_PHASE=01',
      'REVIEW_PATH="' + path.join(dir, '01-REVIEW.md') + '"',
      'FIX_REPORT_PATH="' + path.join(dir, '01-REVIEW-FIX.md') + '"',
      pre,
      fence,
      post,
    ].join('\n');
    const res = runHook('-c', [script], { interpreter, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(res.exitCode, 0, 'the cleanup step must never abort: ' + res.stderr);
    return res;
  };
  const headFiles = (dir) => splitLines(gitOrThrow(
    ['ls-tree', '-r', '--name-only', 'HEAD'],
    { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS }
  )).filter(Boolean).sort();

  test('T6c — #5506: retained backups are COMMITTED when COMMIT_DOCS=true, left alone when false',
    { skip: !HAS_BASH }, (t) => {
    // A non-clean --auto run retains <NN>-REVIEW(-FIX).iterN.md. Untracked, they leave a dirty tree
    // that blocks the next checkout/worktree op. Execute the shipped fence against a real git repo.
    // The default mode runs the real-CLI stub (REAL_COMMIT_BODY, add + scoped commit, prints the
    // hash); the other modes make gsd_run print what cmdCommit prints for that outcome, so every
    // defined outcome is driven: `skipped` is a per-phase phase_commit_docs=false override
    // (src/commands.cts cmdCommit), `nothing` and `committed` are silent successes, `fail` exits 1.
    const git = (dir, ...a) => runGit(a, { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    const stubs = {
      skipped: ' echo skipped; return 0; }',
      nothing: ' echo nothing; return 0; }',
      committed: ' echo committed; return 0; }',
      fail: ' return 1; }',
    };

    const drive = (commitDocs, status = 'issues_found', mode = 'commit') => {
      const dir = seedBackupRepo(t, 'gsd-5506-cleanup-', status, false);
      const res = runFence(dir, {
        commitDocs,
        body: ' echo "$*" >> gsd-calls.log;' + (stubs[mode] || REAL_COMMIT_BODY),
      });
      const calls = fs.existsSync(path.join(
        dir,
        'gsd-calls.log'
      )) ? fs.readFileSync(path.join(dir, 'gsd-calls.log'), 'utf8') : '';
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
    assert.ok(on.review && on.fix, 'backups are retained on disk');
    assert.strictEqual(on.subject, 'docs(01): retain code review iteration backups');
    assert.strictEqual(on.count, '2', 'exactly one new commit beyond the seed');
    assert.deepStrictEqual(on.tracked,
      ['01-REVIEW-FIX.iter2.md', '01-REVIEW-FIX.md', '01-REVIEW.iter2.md', '01-REVIEW.md'],
      'both backups are recoverable from git');

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

    // Silent successes: nothing to warn about, nothing extra committed.
    for (const mode of ['nothing', 'committed']) {
      const quiet = drive('true', 'issues_found', mode);
      assert.strictEqual(quiet.count, '1', mode + ': the stub commits nothing');
      assert.ok(quiet.review && quiet.fix, mode + ': backups are retained on disk');
      assert.doesNotMatch(quiet.stdout, /^(Warning|Note)/m, mode + ': no warning or note');
    }

    // Per-phase phase_commit_docs=false: cmdCommit exits 0 printing "skipped";
    // say so, not "failed".
    const phaseOff = drive('true', 'issues_found', 'skipped');
    assert.strictEqual(phaseOff.count, '1', 'a skipped commit commits nothing');
    assert.ok(phaseOff.review && phaseOff.fix, 'backups are retained on disk');
    assert.match(phaseOff.stdout, /phase_commit_docs is false/);
    assert.doesNotMatch(
      phaseOff.stdout,
      /staged/,
      'a skip stages nothing, so it must not advise unstaging'
    );

    // A failed commit (non-zero exit, or a rejecting hook) commits nothing and never aborts the
    // step.
    const failed = drive('true', 'issues_found', 'fail');
    assert.strictEqual(failed.count, '1', 'a failed commit commits nothing');
    assert.ok(failed.review && failed.fix, 'backups are retained on disk');
    assert.match(failed.stdout, /commit failed/);
    assert.match(failed.stdout, /git restore --staged/);
  });

  test(
    'T6d — #5506: a converged run removes every backup and commits nothing, any COMMIT_DOCS',
    { skip: !HAS_BASH }, (t) => {
    for (const commitDocs of ['true', 'false']) {
      for (const committed of [true, false]) {
        const label = 'COMMIT_DOCS=' + commitDocs + (committed ? ', tracked' : ', untracked');
        const dir = seedBackupRepo(t, 'gsd-5506-converged-', 'clean', committed);
        runFence(dir, { commitDocs, body: ' echo "$*" >> gsd-calls.log; return 1; }' });
        assert.ok(!fs.existsSync(path.join(dir, 'gsd-calls.log')), label + ': no commit attempted');
        assert.strictEqual(
          gitOrThrow(
            ['rev-list', '--count', 'HEAD'],
            { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS }
          ).trim(),
          '1',
          label + ': no new commit'
        );
        for (const f of ['01-REVIEW.iter2.md', '01-REVIEW-FIX.iter2.md']) {
          assert.ok(!fs.existsSync(path.join(dir, f)), label + ': ' + f + ' removed');
        }
      }
    }
  });

  test(
    'T6e — #5506: only .iter<digits>.md files are backups (01-REVIEW.iterations-notes.md is not)',
    { skip: !HAS_BASH }, (t) => {
    const notes = ['01-REVIEW.iterations-notes.md', '01-REVIEW.iter2-notes.md'];
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

  test('T6f — #5506: nullglob is restored to the caller state', { skip: !HAS_BASH }, (t) => {
    const dir = seedBackupRepo(t, 'gsd-5506-shopt-', 'clean', true);
    assert.match(
      runFence(
        dir,
        { pre: 'shopt -s nullglob', post: 'shopt -q nullglob && echo NG=on || echo NG=off' }
      ).stdout,
      /NG=on/
    );
    const dir2 = seedBackupRepo(t, 'gsd-5506-shopt2-', 'clean', true);
    assert.match(
      runFence(
        dir2,
        { pre: 'shopt -u nullglob', post: 'shopt -q nullglob && echo NG=on || echo NG=off' }
      ).stdout,
      /NG=off/
    );
  });

  // The fence is run by whatever shell the agent host has; the maintainer's zsh reproduction is a
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

    const ng = seedBackupRepo(t, 'gsd-5506-zsh-ng-', 'clean', false);
    assert.match(
      runFence(
        ng,
        { ...zsh, pre: 'unsetopt NULL_GLOB',
          post: '[[ -o NULL_GLOB ]] && echo NG=on || echo NG=off' }
      ).stdout,
      /NG=off/
    );
  });

  // The three readers of "what is a backup": the cleanup fence, the disposition step's bash loop,
  // and the disposition step's node `iterOf`. They must classify every name alike.
  test('T6h — #5506: the three backup readers agree on which names are backups',
    { skip: !HAS_BASH }, () => {
    const FIX = 'gsd-core/workflows/code-review-fix.md';
    const DISP = 'gsd-core/workflows/execute-phase/steps/code-review-disposition.md';
    // `iter3` is what auto_iteration_loop writes (`.iter${ITERATION}.md`) at ITERATION=3.
    const stems = ['iter2', 'iter02', 'iter12', 'iter3', 'iter', 'iter2-notes', 'iter2.bak',
      'iterations-notes', 'iter2x.iter3'];
    const names = stems.map((s) => '01-REVIEW-FIX.' + s + '.md');
    const expected = names.map((n) => /^01-REVIEW-FIX\.iter[0-9]+\.md$/.test(n));
    const one = (name, lines, preamble, probe) => {
      const dir = createTempDir('gsd-5506-readers-');
      try {
        if (name) fs.writeFileSync(path.join(dir, name), 'x');
        const r = runBash(lines, { stdout: '', rc: 0 }, { preamble: preamble(dir), probe });
        assert.strictEqual(r.status, 0, r.stderr);
        return r.stdout.trim();
      } finally { cleanup(dir); }
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

  // The stub is only worth its place if cmdCommit does what it does: run both over the same
  // scenarios and compare the printed token, the files in HEAD and the working-tree status.
  test('T6i — #5506: the commit stub behaves like the real `query commit` CLI',
    { skip: !HAS_BASH }, (t) => {
    const A = '01-REVIEW.iter2.md';
    const B = '01-REVIEW-FIX.iter2.md';
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
        tracked: [A], setup: (
          w,
          g,
          d
        ) => { fs.unlinkSync(path.join(d, A)); }, args: ['--files-removed', A],
      },
    };
    const build = (sc) => {
      const dir = createTempDir('gsd-5506-parity-');
      t.after(() => cleanup(dir));
      const g = (...a) => gitOrThrow(a, { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
      const w = (f, c = 'scratch') => fs.writeFileSync(path.join(dir, f), c);
      g('init', '-q');
      g('config', 'user.email', 't@t');
      g('config', 'user.name', 't');
      g('config', 'commit.gpgsign', 'false');
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
      const stub = build(sc);
      const script = ['cd "' + stub.dir + '"', 'gsd_run() {' + REAL_COMMIT_BODY,
        'gsd_run query commit "msg" ' + sc.args.join(' ') + ' --raw'].join('\n');
      const sres = runHook('-c', [script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
      assert.strictEqual(sres.exitCode, 0, label + ': stub: ' + sres.stderr);
      const real = build(sc);
      const rres = runGsdTools(
        ['query', 'commit', 'msg', ...sc.args, '--raw'],
        real.dir,
        { HOME: real.dir }
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
    }
  });
});
