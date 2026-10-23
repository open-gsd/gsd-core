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
const fc = require('./helpers/fast-check-setup.cjs');
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
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
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

describe('#5019 — --auto re-review keeps the external reviewer lane evidence', () => {
  const BLOCK = '<external_reviewer_evidence>X</external_reviewer_evidence>';
  const FIX = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const REVIEW = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md'), 'utf8');

  // Lines [from, to] (inclusive, first match after `from`) of a step region, so a test RUNS the
  // shipped snippet instead of grepping it.
  const lines = (src, from, to) => {
    const l = splitLines(src);
    const a = l.findIndex((x) => x.includes(from));
    assert.notStrictEqual(a, -1, `marker "${from}" not found`);
    const b = l.findIndex((x, k) => k >= a && x.trim() === to);
    assert.notStrictEqual(b, -1, `end "${to}" not found`);
    return l.slice(a, b + 1).join('\n');
  };
  // `bash -n` first: a reflow that moves an end marker into a nested construct cuts an unbalanced
  // snippet, which must fail loudly here instead of running a truncated fence.
  const bash = (script, env) => {
    script = `gsd_run() { node "${GSD_TOOLS}" "$@"; }\n${script}`; // the launcher's resolved gsd_run, pointed at this tree
    const syntax = runHook('-n', ['-c', script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(syntax.exitCode, 0, `extracted snippet is not complete shell: ${syntax.stderr}`);
    return runHook('-c', [script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, ...(env && { env: { ...process.env, ...env } }) });
  };
  // A scratch TMPDIR holding lane dirs plus an outside "victim" dir the guard must never touch.
  const sandbox = (t, fn) => {
    const dir = createTempDir('gsd-5019-');
    t.after(() => cleanup(dir));
    const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
    const victim = path.join(dir, 'victim'); fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'keep'), 'x');
    return fn({ dir, tmp, victim, review: path.join(dir, '01-REVIEW.md'), file: path.join(dir, '01-REVIEW-lane-evidence.md') });
  };
  const CALL = 'gsd_run lane-evidence-clear "$REVIEW_PATH"';
  // dispatch_reviewer_lanes run for real; only `review-lane dispatch-step` (it would spawn a CLI) is stubbed
  // to return `results`. It is the one fence that holds EXTERNAL_EVIDENCE_BLOCK and LANE_RUN_DIR, so it owns persisting them.
  const dispatch = (sb, results) => bash([
    `export TMPDIR="${sb.tmp}"; PHASE_DIR="${sb.dir}"; PADDED_PHASE=01; REPO_ROOT="${sb.dir}"; REVIEW_DEPTH=standard; DIFF_BASE=deadbeef; REVIEW_FILES=(a.ts)`,
    'real_gsd_run() { node "' + GSD_TOOLS + '" "$@"; }',
    'gsd_run() { if [ "$1" = "review-lane" ] && [ "$2" = "dispatch-step" ]; then cat >/dev/null; printf "%s" "$GSD_DISPATCH_JSON"; else real_gsd_run "$@"; fi; }',
    'set -- --codex', stepFence(REVIEW, 'dispatch_reviewer_lanes'),
    'printf "%s" "$EXTERNAL_EVIDENCE_BLOCK"'].join('\n'), { GSD_DISPATCH_JSON: JSON.stringify({ ok: true, selection: {}, results }) });
  const laneDirs = (sb) => fs.readdirSync(sb.tmp).filter((n) => n.startsWith('gsd-review-lanes-'));
  const REMOVALS = {
    'cleanup_iteration_backups': () => lines(stepRegion(FIX, 'cleanup_iteration_backups'), CALL, CALL),
    'check_empty_scope': () => lines(stepRegion(REVIEW, 'check_empty_scope'), CALL, CALL),
    // every early exit calls the one shared verb; each site's call is executed, not grepped
    'check_config_gate': () => lines(stepRegion(FIX, 'check_config_gate'), CALL, CALL),
    'check_review_exists': () => lines(stepRegion(FIX, 'check_review_exists'), CALL, CALL),
    'check_review_status': () => lines(stepRegion(FIX, 'check_review_status'), CALL, CALL),
    'spawn_fixer': () => lines(stepRegion(FIX, 'spawn_fixer'), CALL, CALL),
  };

  for (const [name, snippet] of Object.entries(REMOVALS)) {
    test(`${name}: removal deletes a valid lane dir + file, never anything else`, { skip: !HAS_BASH }, (t) => {
      const run = (sb, line1, mk) => {
        mk && mk(sb);
        fs.writeFileSync(sb.file, `${line1}\nblock\n`);
        bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${snippet()}`);
        return { file: fs.existsSync(sb.file), victim: fs.existsSync(path.join(sb.victim, 'keep')) };
      };
      sandbox(t, (sb) => {
        const d = path.join(sb.tmp, 'gsd-review-lanes-abc123'); fs.mkdirSync(d);
        const r = run(sb, 'abc123');
        assert.deepStrictEqual(r, { file: false, victim: true });
        assert.strictEqual(fs.existsSync(d), false, 'valid lane dir removed');
      });
      sandbox(t, (sb) => { // traversal: a path is data, not a path
        // 6 chars, so the length arm admits it and only the `*[!A-Za-z0-9]*` class stops it;
        // without the class D = $TMPDIR/gsd-review-lanes-x/../v resolves to the victim $TMPDIR/v.
        fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-x'));
        const v = path.join(sb.tmp, 'v'); fs.mkdirSync(v); fs.writeFileSync(path.join(v, 'keep'), 'x');
        const r = run(sb, 'x/../v');
        assert.deepStrictEqual(r, { file: false, victim: true });
        assert.strictEqual(fs.existsSync(path.join(v, 'keep')), true, 'path-shaped 6-char line 1 must not reach the victim');
      });
      sandbox(t, (sb) => { // symlinked lane dir pointing at the victim
        fs.symlinkSync(sb.victim, path.join(sb.tmp, 'gsd-review-lanes-abc123'));
        const r = run(sb, 'abc123');
        assert.deepStrictEqual(r, { file: false, victim: true });
      });
      sandbox(t, (sb) => { // wrong length / empty line 1
        const real = ['abc12', 'abc1234'].map((n) => { const d = path.join(sb.tmp, `gsd-review-lanes-${n}`); fs.mkdirSync(d); return d; });
        for (const bad of ['abc12', 'abc1234', '']) assert.deepStrictEqual(run(sb, bad), { file: false, victim: true });
        for (const d of real) assert.strictEqual(fs.existsSync(d), true, 'wrong-length suffix names a real dir: kept');
      });
      sandbox(t, (sb) => { // no file: a no-op that does not fail
        bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${snippet()}`);
        assert.strictEqual(fs.existsSync(sb.victim), true);
      });
    });
  }

  test('loop read: block only for a fresh file whose suffix names a real lane dir', { skip: !HAS_BASH }, (t) => {
    const read = lines(stepRegion(FIX, 'auto_iteration_loop'), '# #5019: re-surface', 'esac');
    const drive = (sb, line1, ageMs) => {
      fs.writeFileSync(sb.file, `${line1}\n<external_reviewer_evidence>X</external_reviewer_evidence>\n`);
      if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(sb.file, t, t); }
      const out = bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${read}\nprintf '%s' "$EXTERNAL_EVIDENCE_BLOCK"`);
      return out.stdout;
    };
    sandbox(t, (sb) => {
      fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-abc123'));
      assert.strictEqual(drive(sb, 'abc123'), `${BLOCK}\n\n`);
      // find -mmin -360 rounds differently on GNU and BSD (macOS keeps a file aged exactly 360 min),
      // so the 360 boundary itself is implementation-defined and deliberately not asserted.
      // BSD find rounds ages up to the next full minute, so the fresh sample must sit at least a minute under the 360-minute cap.
      for (const [min, fresh] of [[350, true], [361, false], [420, false]]) {
        assert.strictEqual(drive(sb, 'abc123', min * 60000).includes('X'), fresh, `${min} min old`);
      }
      assert.strictEqual(drive(sb, 'zzz999'), '', 'suffix without a lane dir');
      fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-x')); // so D resolves to the existing victim dir
      fs.mkdirSync(path.join(sb.tmp, 'v')); // 6-char path-shaped line 1: D = $TMPDIR/v, so only the character class stops it
      assert.strictEqual(drive(sb, 'x/../v'), '', 'a path is not a suffix');
      fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-abc12'));
      assert.strictEqual(drive(sb, 'abc12'), '', 'wrong length names a real dir');
      const noFile = bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.dir}/none-REVIEW.md"\n${read}\nprintf '%s' "$EXTERNAL_EVIDENCE_BLOCK"`);
      assert.strictEqual(noFile.stdout, '', 'absent file leaves the prompt unchanged');
    });
  });

  test('the evidence block round-trips dispatch to the re-review read, and the cited lane file survives', { skip: !HAS_BASH }, (t) => {
    const read = lines(stepRegion(FIX, 'auto_iteration_loop'), '# #5019: re-surface', 'esac');
    // The re-review prompt template, run through bash so the block's place in it is executed, not grepped.
    // The reviewer agent that consumes it is the one step no test can run (stated in the PR body).
    // Bounded by the Agent() call's own `prompt="` ... `")` syntax, not by prose lines inside it.
    const loop = stepRegion(FIX, 'auto_iteration_loop');
    const call = loop.indexOf('Agent(subagent_type="gsd-code-reviewer"');
    assert.notStrictEqual(call, -1, 're-review Agent() call not found');
    const from = loop.indexOf('prompt="', call) + 'prompt="'.length;
    const to = loop.indexOf('")', from);
    assert.ok(from > call && to > from, 're-review prompt literal not found');
    const tpl = loop.slice(from, to);
    sandbox(t, (sb) => {
      const cited = path.join(sb.dir, 'gsd-review-x.md'); fs.writeFileSync(cited, 'lane-only finding');
      const block = dispatch(sb, [{ ok: true, slug: 'codex', reviewPath: cited }]).stdout;
      assert.match(block, /^<external_reviewer_evidence>/);
      const [lane] = laneDirs(sb);
      fs.writeFileSync(path.join(sb.tmp, lane, 'kept'), 'lane-only finding');
      fs.writeFileSync(sb.review, '---\nstatus: issues_found\n---\n');
      // a FRESH shell: commit_review inherits nothing from dispatch but the file
      bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"; COMMIT_DOCS=false; FIX_AUTO=true\n${stepFence(REVIEW, 'commit_review')}`);
      fs.writeFileSync(sb.review, '---\nstatus: clean\n---\n'); // the re-review overwrites REVIEW.md; the lane finding must survive in the sibling file
      const out = bash([
        `export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"`, read,
        'printf "%s" "$EXTERNAL_EVIDENCE_BLOCK"', "printf '\\0'",
        `REVIEW_DEPTH=standard PHASE_DIR="${sb.dir}"; PROMPT="${tpl}"; printf '%s' "$PROMPT"`].join('\n'));
      const [blockOut, prompt] = out.stdout.split('\0');
      assert.ok(blockOut.endsWith(`${block}\n\n`), 'the re-review reads back the exact block');
      const promptHead = `\n${block}\n\n<config>\ndepth: standard\n`;
      assert.strictEqual(prompt.slice(0, promptHead.length), promptHead, 'the re-review prompt is assembled with the block ahead of <config>');
      assert.strictEqual(fs.readFileSync(path.join(sb.tmp, lane, 'kept'), 'utf8'), 'lane-only finding', 'the lane dir the reviewer cites survives');
    });
  });

  test('dispatch persists the evidence file beside REVIEW.md; a dispatch with no evidence leaves no lane dir', { skip: !HAS_BASH }, (t) => {
    sandbox(t, (sb) => {
      const block = dispatch(sb, [{ ok: true, slug: 'codex', reviewPath: '/x/codex.md' }]).stdout;
      const [lane] = laneDirs(sb);
      assert.strictEqual(fs.readFileSync(sb.file, 'utf8'), `${lane.slice('gsd-review-lanes-'.length)}\n${block}\n`);
    });
    sandbox(t, (sb) => {
      dispatch(sb, [{ ok: false, slug: 'codex', reason: 'spawn_failed' }]);
      assert.deepStrictEqual([laneDirs(sb), fs.existsSync(sb.file)], [[], false], 'no evidence: nothing for the fixer loop to read, so nothing is kept');
    });
  });

  test('commit_review keeps the persisted evidence only for --auto with a valid REVIEW.md, from a fresh shell', { skip: !HAS_BASH }, (t) => {
    const fence = stepFence(REVIEW, 'commit_review');
    const drive = (auto, reviewText) => sandbox(t, (sb) => {
      const lanes = path.join(sb.tmp, 'gsd-review-lanes-abc123'); fs.mkdirSync(lanes);
      fs.writeFileSync(sb.file, `abc123\n${BLOCK}\n`);
      if (reviewText !== null) fs.writeFileSync(sb.review, reviewText);
      // Only what a fresh shell would still know: no LANE_RUN_DIR, no EXTERNAL_EVIDENCE_BLOCK.
      bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"; COMMIT_DOCS=false${auto ? '; FIX_AUTO=true' : ''}\n${fence}`);
      return { file: fs.existsSync(sb.file), lanes: fs.existsSync(lanes) };
    });
    const VALID = '---\nstatus: issues_found\n---\n';
    assert.deepStrictEqual(drive(true, VALID), { file: true, lanes: true });
    assert.deepStrictEqual(drive(false, VALID), { file: false, lanes: false });
    // No fixer loop starts on an invalid or missing REVIEW.md, so nothing may be left for it to clean.
    assert.deepStrictEqual(drive(true, '# no frontmatter\n'), { file: false, lanes: false }, 'invalid REVIEW.md');
    assert.deepStrictEqual(drive(true, null), { file: false, lanes: false }, 'missing REVIEW.md');
  });

  test('loop read: a present but rejected evidence file warns instead of dropping the block silently', { skip: !HAS_BASH }, (t) => {
    const read = lines(stepRegion(FIX, 'auto_iteration_loop'), '# #5019: re-surface', 'fi');
    const warns = (sb, line1, ageMs) => {
      fs.writeFileSync(sb.file, `${line1}\nblock\n`);
      if (ageMs) { const d = new Date(Date.now() - ageMs); fs.utimesSync(sb.file, d, d); }
      const out = bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${read}\nprintf '%s' "$EXTERNAL_EVIDENCE_BLOCK"`);
      return { block: out.stdout, warned: out.stderr !== '' };
    };
    sandbox(t, (sb) => {
      const d = path.join(sb.tmp, 'gsd-review-lanes-abc123'); fs.mkdirSync(d);
      const degraded = { block: '', warned: true };
      assert.deepStrictEqual(warns(sb, 'abc123', 7 * 3600 * 1000), degraded, 'stale');
      assert.deepStrictEqual(warns(sb, 'zzz999'), degraded, 'lane dir missing');
      fs.symlinkSync(sb.victim, path.join(sb.tmp, 'gsd-review-lanes-sym123'));
      assert.deepStrictEqual(warns(sb, 'sym123'), degraded, 'lane dir is a symlink');
      // The evidence file itself must be a regular file: a symlink would be read through to its target.
      const target = path.join(sb.dir, 'target'); fs.writeFileSync(target, 'abc123\nsecret\n');
      cleanup(sb.file); fs.symlinkSync(target, sb.file);
      const viaLink = bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${read}\nprintf '%s' "$EXTERNAL_EVIDENCE_BLOCK"`);
      assert.deepStrictEqual({ block: viaLink.stdout, warned: viaLink.stderr !== '' }, degraded, 'evidence file is a symlink');
      cleanup(sb.file);
      assert.strictEqual(warns(sb, 'abc123').warned, false, 'fresh valid evidence: no warning');
      fs.renameSync(sb.file, path.join(sb.dir, 'moved'));
      assert.strictEqual(bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${read}`).stderr, '', 'no file: no warning');
    });
  });

  test('property: only a ^[A-Za-z0-9]{6}$ line 1 is acted on; the persist/read format round-trips', { skip: !HAS_BASH }, (t) => {
    const read = lines(stepRegion(FIX, 'auto_iteration_loop'), '# #5019: re-surface', 'esac');
    const removal = REMOVALS.cleanup_iteration_backups();
    const SUFFIX = /^[A-Za-z0-9]{6}$/;
    const runs = { numRuns: 40 }; // every sample spawns bash
    // Line 1 never holds a newline (it is line 1) or a NUL (a bash variable cannot).
    // Mostly 5-7 chars over a near-miss alphabet, so the length arm admits many and only the class must reject them.
    const near = fc.string({ unit: fc.constantFrom(...'aZ09/.*-_ ?[]'), minLength: 5, maxLength: 7 });
    const line1 = fc.oneof(near, fc.string({ maxLength: 10 })).filter((x) => !/[\n\0]/.test(x));
    fc.assert(fc.property(line1, (l1) => {
      fc.pre(!SUFFIX.test(l1));
      return sandbox(t, (sb) => {
        // A lane dir literally named after line 1 (when that is a creatable name) must survive rejection.
        let named = null;
        if (l1 && !/[/\\]/.test(l1) && l1 !== '.' && l1 !== '..') { named = path.join(sb.tmp, `gsd-review-lanes-${l1}`); fs.mkdirSync(named); }
        fs.writeFileSync(sb.file, `${l1}\nblock\n`);
        const env = `export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"`;
        const got = bash(`${env}\n${read}\nprintf '%s' "$EXTERNAL_EVIDENCE_BLOCK"`).stdout;
        bash(`${env}\n${removal}`);
        assert.strictEqual(got, '', `line 1 ${JSON.stringify(l1)} yields no block`);
        assert.strictEqual(fs.existsSync(path.join(sb.victim, 'keep')), true, 'victim untouched');
        if (named) assert.strictEqual(fs.existsSync(named), true, 'rejected suffix removes nothing');
        return true;
      });
    }), runs);
    // dispatch picks the suffix (mktemp), so the free variable is the cited path; the block must round-trip byte-exact.
    const cited = fc.string({ maxLength: 20 }).filter((x) => x.length > 0 && !/[\n\0]/.test(x) && x.trim() === x);
    fc.assert(fc.property(cited, (c) => sandbox(t, (sb) => {
      const block = dispatch(sb, [{ ok: true, slug: 'codex', reviewPath: c }]).stdout;
      const lanes = path.join(sb.tmp, laneDirs(sb)[0]);
      const env = `export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"`;
      const got = bash(`${env}\n${read}\nprintf '%s' "$EXTERNAL_EVIDENCE_BLOCK"`).stdout;
      assert.strictEqual(got, `${block}\n\n`, 'the block round-trips byte-exact');
      bash(`${env}\n${removal}`);
      assert.deepStrictEqual([fs.existsSync(lanes), fs.existsSync(sb.file), fs.existsSync(path.join(sb.victim, 'keep'))], [false, false, true]);
      return true;
    })), runs);
  });

  test('check_review_exists removes the lane evidence before it exits 1', { skip: !HAS_BASH }, (t) => {
    const fence = lines(stepRegion(FIX, 'check_review_exists'), 'if [ ! -f', 'exit 1') + '\nfi';
    sandbox(t, (sb) => {
      const d = path.join(sb.tmp, 'gsd-review-lanes-abc123'); fs.mkdirSync(d);
      fs.writeFileSync(sb.file, 'abc123\nblock\n');
      const out = bash(`export TMPDIR="${sb.tmp}"; PHASE_ARG=1; REVIEW_PATH="${sb.review}"\n${fence}`);
      assert.strictEqual(out.exitCode, 1);
      assert.deepStrictEqual([fs.existsSync(sb.file), fs.existsSync(d), fs.existsSync(path.join(sb.victim, 'keep'))], [false, false, true]);
    });
  });

  test('every exit site makes the one shared verb call; the loop read keeps the same suffix guard', () => {
    const calls = (src, step) => splitLines(stepRegion(src, step)).map((l) => l.trim()).filter((l) => l === CALL);
    for (const [src, step] of [[REVIEW, 'check_empty_scope'], ...['check_config_gate', 'check_review_exists', 'check_review_status', 'spawn_fixer', 'cleanup_iteration_backups'].map((n) => [FIX, n])]) {
      assert.deepStrictEqual(calls(src, step), [CALL], step);
    }
    // The verb owns the removal: no inline `rm -rf "$D"` fence may reappear in either workflow.
    for (const src of [REVIEW, FIX]) assert.ok(!src.includes('rm -rf "$D"'), 'inline removal fence reintroduced');
    assert.ok(splitLines(stepRegion(FIX, 'auto_iteration_loop')).some((l) => l.trim().startsWith(`case "$S" in *[!A-Za-z0-9]*|'') ;; ??????)`)), 'loop read uses the 6-char alphanumeric guard');
  });

  test('lane-evidence-clear: no argument is a usage error; an absent file is a quiet no-op', (t) => {
    const dir = createTempDir('gsd-5019-'); t.after(() => cleanup(dir));
    const noArg = runNode([GSD_TOOLS, 'lane-evidence-clear'], {});
    assert.notStrictEqual(noArg.exitCode, 0);
    assert.match(noArg.stderr, /Usage: lane-evidence-clear/);
    const none = runNode([GSD_TOOLS, 'lane-evidence-clear', path.join(dir, '01-REVIEW.md')], {});
    assert.strictEqual(none.exitCode, 0);
  });
});
