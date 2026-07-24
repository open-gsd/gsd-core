// allow-test-rule: source-text-is-the-product (see #2269) — the conformance
// scan below reads gsd-core/workflows/*.md and regex-matches invocation lines;
// the workflow source text IS the product under test.
/**
 * Regression test for #2112: gsd-tools commit --files commits the entire
 * index, not the declared paths.
 *
 * `cmdCommit` staged exactly the files named in --files but then ran a bare
 * `git commit` with no pathspec, absorbing anything else that happened to be
 * staged into a commit whose message described only the named files.
 *
 * The fix adds `'--', ...stagedPaths` to the commit args **only when** the
 * caller declared a scope (explicitFiles), and only for paths that were
 * actually staged (skipped missing files are excluded to avoid #2014).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');

describe('commit --files: pathspec honors declared scope (#2112)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('commit --files does not absorb unrelated staged files', () => {
    // Developer stages a WIP file via git add (not via --files).
    fs.writeFileSync(path.join(tmpDir, 'src-wip.txt'), 'work in progress\n');
    execSync('git add src-wip.txt', { cwd: tmpDir, stdio: 'pipe' });

    // GSD writes and commits a planning artifact, naming ONLY that file.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    runGsdTools(
      ['commit', 'docs(01): add PLAN.md', '--files', '.planning/PLAN.md'],
      tmpDir,
    );

    // The commit must contain ONLY .planning/PLAN.md.
    const diffOutput = execSync('git diff HEAD~1 HEAD --name-only', {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();
    assert.strictEqual(
      diffOutput,
      '.planning/PLAN.md',
      'commit --files must contain only the named files, got:\n' + diffOutput,
    );

    // The WIP file must still be staged, not committed.
    const statusOutput = execSync('git status --porcelain', {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();
    assert.ok(
      statusOutput.includes('A  src-wip.txt') || statusOutput.includes('A\tsrc-wip.txt'),
      'src-wip.txt should remain staged, not committed. Status:\n' + statusOutput,
    );
  });

  test('commit --files with two files commits exactly those two', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'RESEARCH.md'), '# Research\n');

    runGsdTools(
      ['commit', 'docs: artifacts', '--files', '.planning/PLAN.md', '.planning/RESEARCH.md'],
      tmpDir,
    );

    const diffOutput = execSync('git diff HEAD~1 HEAD --name-only', {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    const files = diffOutput.trim().split('\n').sort();
    assert.deepEqual(
      files,
      ['.planning/PLAN.md', '.planning/RESEARCH.md'],
      'commit should contain exactly the two named files',
    );
  });

  test('commit without --files still commits the entire .planning/ index (default path)', () => {
    // Write a planning artifact and stage it.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    execSync('git add .planning/PLAN.md', { cwd: tmpDir, stdio: 'pipe' });

    // Also stage an unrelated file.
    fs.writeFileSync(path.join(tmpDir, 'extra.txt'), 'extra\n');
    execSync('git add extra.txt', { cwd: tmpDir, stdio: 'pipe' });

    runGsdTools(['commit', 'docs: default commit'], tmpDir);

    // Default path (no --files) commits everything staged.
    const diffOutput = execSync('git diff HEAD~1 HEAD --name-only', {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    const files = diffOutput.trim().split('\n').sort();
    assert.ok(
      files.includes('.planning/PLAN.md') && files.includes('extra.txt'),
      'default commit (no --files) should commit everything staged, got:\n' + files,
    );
  });

  test('missing tracked file in --files is still not committed as deletion (#2014 guard)', () => {
    // Create and commit STATE.md, then remove it from disk.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    execSync('git add .planning/STATE.md', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add STATE.md"', { cwd: tmpDir, stdio: 'pipe' });
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));

    // Also create a valid file to commit.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');

    runGsdTools(
      ['commit', 'docs: add plan', '--files', '.planning/PLAN.md', '.planning/STATE.md'],
      tmpDir,
    );

    const diffOutput = execSync('git diff HEAD~1 HEAD --name-status', {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    assert.ok(
      !diffOutput.includes('D\t.planning/STATE.md'),
      'missing tracked file must not appear as a deletion, diff was:\n' + diffOutput,
    );
    assert.ok(
      diffOutput.includes('.planning/PLAN.md'),
      'PLAN.md should be committed',
    );
  });

  test('commit --files with only missing files returns nothing_to_commit', () => {
    // Create and commit STATE.md, then remove it from disk.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    execSync('git add .planning/STATE.md', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add STATE.md"', { cwd: tmpDir, stdio: 'pipe' });
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));

    // Stage an unrelated file so the index is non-empty.
    fs.writeFileSync(path.join(tmpDir, 'extra.txt'), 'extra\n');
    execSync('git add extra.txt', { cwd: tmpDir, stdio: 'pipe' });

    const result = runGsdTools(
      ['commit', 'docs: try', '--files', '.planning/STATE.md'],
      tmpDir,
    );

    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.committed, false,
      'should not commit when all --files are missing',
    );
    assert.strictEqual(
      parsed.reason, 'nothing_to_commit',
      'should report nothing_to_commit, not absorb the index',
    );

    // The unrelated staged file must still be staged, not committed.
    const statusOutput = execSync('git status --porcelain', {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();
    assert.ok(
      statusOutput.includes('extra.txt'),
      'extra.txt should remain staged, not absorbed into a commit',
    );
  });
});

describe('workflow call sites declare --files (#2269)', () => {
  // Anchoring the command at line start keeps prose mentions (mid-sentence
  // backtick references in plan-phase.md, quick.md, etc.) out of scope while
  // covering all three invocation forms in use: gsd_run, gsd-tools,
  // gsd-tools.cjs.
  //
  // `query` is OPTIONAL. gsd-tools.cjs treats it as a meta-prefix and shifts
  // it off (bin/gsd-tools.cjs, "Accept `query` as a meta-prefix"), so
  // `gsd_run commit "msg"` and `gsd_run query commit "msg"` reach the identical
  // cmdCommit. Requiring the token left the query-less spelling — already live
  // at gsd-core/workflows/ingest-docs.md — outside the scan entirely, so a
  // future bare `gsd_run commit` would reintroduce #2269 uncaught.
  //
  // The `.*` between the binary and the command is load-bearing and must NOT
  // be tightened to `(\s+query)?\s+commit`: invocations may carry flags before
  // the command (gsd-core/workflows/onboard.md is
  // `gsd_run --cwd "$ONBOARDING_ROOT" query commit ...`). Dropping `.*` swaps
  // that call site out of coverage while the total match count stays at 86 —
  // a silent coverage loss that no count check would surface.
  const INVOCATION_RE = /^\s*gsd(_run|-tools(\.cjs)?)\b.*\b(query\s+)?commit\b/;
  // --files must be a real argument OUTSIDE the quoted commit message (a
  // message like "docs: explain --files usage" must not count), and must
  // carry a value — a trailing bare flag still selects the unscoped default.
  const hasScopedFiles = (line) => {
    const re = /--files\s+\S/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const quotesBefore = line.slice(0, m.index).split('"').length - 1;
      if (quotesBefore % 2 === 0) return true; // outside double quotes
    }
    return false;
  };

  test('scanner quote-parity handles synthetic edge-case lines', () => {
    // The scan's correctness rests on hasScopedFiles's quote-parity walk,
    // which live workflow content happens not to stress. Pin the claimed
    // edge cases with literal lines so a regex regression fails loudly.
    const bare = [
      // A prose --files inside the quoted commit message must NOT count as
      // a scope — this line is still an unscoped invocation.
      'gsd_run query commit "docs: explain --files usage"',
      // A trailing bare flag carries no value and still selects the
      // unscoped default path.
      'gsd_run query commit "docs: plan" --files',
    ];
    for (const line of bare) {
      assert.ok(INVOCATION_RE.test(line), `should match invocation: ${line}`);
      assert.strictEqual(
        hasScopedFiles(line), false,
        `must be flagged as unscoped: ${line}`,
      );
    }

    const scoped = [
      // The ordinary scoped shape.
      'gsd_run query commit "docs: plan" --files .planning/PLAN.md',
      // A quoted --files mention BEFORE the real flag must not blind the
      // scanner to the genuine scope that follows (quote parity is even
      // again after the closing quote).
      'gsd_run query commit "docs: explain --files usage" --files .planning/PLAN.md',
    ];
    for (const line of scoped) {
      assert.ok(INVOCATION_RE.test(line), `should match invocation: ${line}`);
      assert.strictEqual(
        hasScopedFiles(line), true,
        `must be recognized as scoped: ${line}`,
      );
    }

    // The query-less spelling reaches the same cmdCommit and must be in
    // scope, scoped or not. ingest-docs.md uses this form live.
    assert.ok(
      INVOCATION_RE.test('gsd_run commit "docs: ingest" --files .planning/PROJECT.md'),
      'query-less invocation must match (query is an optional meta-prefix)',
    );
    assert.strictEqual(
      hasScopedFiles('gsd_run commit "docs: ingest"'), false,
      'a bare query-less invocation must be flagged as unscoped',
    );
    assert.ok(
      INVOCATION_RE.test('gsd_run commit "docs: ingest"'),
      'a bare query-less invocation must still match the anchor',
    );

    // Flags may precede the command. onboard.md is a live instance; a regex
    // that anchors `commit` directly after the binary drops it silently.
    assert.ok(
      INVOCATION_RE.test('gsd_run --cwd "$ROOT" query commit "docs: x" --files .planning/S.md'),
      'invocation with a flag before the command must stay in scope',
    );

    // Prose mention mid-sentence: the line-start anchor keeps it out of
    // the scan entirely.
    assert.strictEqual(
      INVOCATION_RE.test('the `gsd_run query commit` step then records the artifact'),
      false,
      'prose mention must not match the invocation anchor',
    );

    // Widening `query` to optional must not pull in unrelated commands that
    // merely mention the word: `commit_docs` is a JSON key in new-project.md's
    // config-new-project payload, and the \b...\b anchors must exclude it.
    assert.strictEqual(
      INVOCATION_RE.test('gsd_run query config-new-project \'{"commit_docs":true}\''),
      false,
      'a config payload mentioning commit_docs is not a commit invocation',
    );
  });

  // The scan's verdict rests entirely on hasScopedFiles's quote-parity walk,
  // which is parser-shaped logic over adversarial text. Live workflow content
  // exercises only a handful of shapes, so pin the invariant by property:
  // a `--files` occurring ONLY inside the quoted commit message never counts,
  // and appending a real one outside the quotes always does.
  describe('property: quote-parity is what decides scope', () => {
    // Message bodies with no double quote of their own — a `"` inside the
    // message would flip parity, which is a shell-quoting bug in the workflow
    // line, not a scanner bug, and is out of this property's domain.
    const msg = fc.string({ maxLength: 60 }).filter((s) => !s.includes('"'));
    const arg = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => !/["\s]/.test(s));

    test('a --files mentioned only inside the quoted message is never a scope', () => {
      fc.assert(
        fc.property(msg, msg, (before, after) => {
          const line = `gsd_run query commit "${before} --files ${after}"`;
          assert.strictEqual(
            hasScopedFiles(line), false,
            `quoted --files must not count as scope: ${line}`,
          );
        }),
      );
    });

    test('a real --files outside the quotes always counts, whatever the message says', () => {
      fc.assert(
        fc.property(msg, arg, (message, filePath) => {
          const line = `gsd_run query commit "${message}" --files ${filePath}`;
          assert.strictEqual(
            hasScopedFiles(line), true,
            `unquoted --files must count as scope: ${line}`,
          );
        }),
      );
    });

    test('never throws, whatever the input line looks like', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (line) => {
          assert.strictEqual(typeof hasScopedFiles(line), 'boolean');
        }),
      );
    });
  });

  test('every query commit invocation passes --files', () => {
    // #2269: three workflow call sites omitted --files, landing on the
    // default branch that blanket-stages .planning/ and commits the entire
    // index. The #2112 pathspec fix is gated on explicitFiles, so it cannot
    // reach a caller that never declares a scope. This scan keeps every
    // invocation on the scoped path (and catches future bare sites) —
    // across every directory that carries live invocations, not just
    // gsd-core/workflows/: agents/, commands/, skills/, and
    // gsd-core/references/ invoke the same seam.
    const scanRoots = [
      'gsd-core/workflows',
      'gsd-core/references',
      'agents',
      'commands',
      'skills',
    ];
    const offenders = [];
    for (const root of scanRoots) {
      const rootDir = path.join(__dirname, '..', root);
      const mdFiles = fs
        .readdirSync(rootDir, { recursive: true })
        .filter((f) => f.endsWith('.md'));
      for (const file of mdFiles) {
        const raw = fs.readFileSync(path.join(rootDir, file), 'utf-8');
        // Join backslash-continued lines first: several invocations pass
        // --files on a continuation line (docs-update.md, code-review.md,
        // gsd-code-fixer.md), and a per-physical-line scan would
        // false-flag them.
        const logical = raw.replace(/\\\r?\n/g, ' ');
        for (const line of logical.split(/\r?\n/)) {
          if (INVOCATION_RE.test(line) && !hasScopedFiles(line)) {
            offenders.push(`${root}/${file}: ${line.trim()}`);
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'workflow query commit invocations without --files (unscoped commits sweep the index):\n' +
        offenders.join('\n'),
    );
  });

  describe('behavioral', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempGitProject();
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('the workflow commit shape excludes unrelated staged files (secure-phase step 7)', () => {
      // Mirrors gsd-core/workflows/secure-phase.md step 7 after #2269. The
      // --files scope is DERIVED from the workflow's own commit line rather
      // than hardcoded, so a revert of that line's --files (the #2269
      // regression) fails this behavioral test too, not only the scan above.
      const workflowRaw = fs.readFileSync(
        path.join(__dirname, '..', 'gsd-core', 'workflows', 'secure-phase.md'),
        'utf-8',
      );
      // Join backslash-continued lines first, exactly as the scan above does:
      // the workflow wraps --files onto a continuation line, so the invocation
      // token and the SECURITY.md scope live on two different physical lines
      // and a raw per-line find would miss the invocation entirely.
      const commitLine = workflowRaw
        .replace(/\\\r?\n/g, ' ')
        .split(/\r?\n/)
        .find((l) => INVOCATION_RE.test(l) && l.includes('SECURITY.md'));
      assert.ok(
        commitLine,
        'secure-phase.md step 7 commit invocation not found — did the workflow drop or rename its SECURITY.md commit?',
      );
      const filesArg = /--files\s+"([^"]+)"/.exec(commitLine);
      assert.ok(
        filesArg,
        'secure-phase.md step 7 no longer declares --files — the #2269 regression this test guards:\n' + commitLine,
      );
      // Instantiate the workflow line's shell variables with concrete values.
      const artifact = filesArg[1]
        .replace('${PHASE_DIR}', '.planning/phases/01-hardening')
        .replace('${PADDED_PHASE}', '01');
      assert.ok(
        !artifact.includes('${'),
        'unresolved shell variable in the derived artifact path — update the substitutions: ' + artifact,
      );

      const phaseDir = path.join(tmpDir, path.dirname(artifact));
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, artifact), '# Security\n');

      // Unrelated staged work a parallel agent / editor left behind.
      fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'in flight\n');
      execSync('git add unrelated.txt', { cwd: tmpDir, stdio: 'pipe' });
      // And an unstaged .planning/ stray the blanket `git add .planning/`
      // used to pull in (the vector a caller cannot defend against).
      fs.writeFileSync(path.join(tmpDir, '.planning', 'scratch.md'), 'stray\n');

      runGsdTools(
        [
          'commit',
          'docs(phase-1): add/update security threat verification',
          '--files',
          artifact,
        ],
        tmpDir,
      );

      const files = execSync('git diff HEAD~1 HEAD --name-only', {
        cwd: tmpDir,
        encoding: 'utf-8',
      })
        .trim()
        .split('\n');
      assert.deepEqual(
        files,
        [artifact],
        'the scoped workflow commit must contain only its own artifact, got:\n' + files.join('\n'),
      );

      const statusOutput = execSync('git status --porcelain', {
        cwd: tmpDir,
        encoding: 'utf-8',
      });
      assert.ok(
        statusOutput.includes('unrelated.txt'),
        'unrelated.txt should remain staged, not committed. Status:\n' + statusOutput,
      );
      assert.ok(
        statusOutput.includes('.planning/scratch.md'),
        'the unstaged .planning/ stray must not be swept in. Status:\n' + statusOutput,
      );
    });
  });
});
