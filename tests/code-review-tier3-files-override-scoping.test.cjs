'use strict';

/**
 * Regression coverage for #4460: code-review.md states (line 144) "Skip
 * SUMMARY/git scoping entirely when --files is provided." Tier 2 honors
 * this via `if [ -z "$FILES_OVERRIDE" ]`, but Tier 3's `#2666` cross-check
 * had no `FILES_OVERRIDE` reference at all — reached via `elif [ -n
 * "$DIFF_BASE" ]` whenever `REVIEW_FILES` was already non-empty (true
 * under `--files`, since Tier 1 fills it), so it silently appended the
 * whole phase diff onto an explicit user-supplied file list.
 *
 * Only Tier 3's own fence is extracted-and-executed VERBATIM from
 * code-review.md (never reimplemented) against a real constructed git
 * fixture. Tiers 1 and 2 are NOT sourced — both are seeded instead,
 * mimicking each tier's real successful output rather than running its
 * actual fence:
 *
 * - Tier 2's fence is not currently parseable bash at all (two unescaped
 *   `"` characters inside its embedded `node -e "..."` regex literal
 *   terminate the outer double-quoted string early, breaking bash's parse
 *   of the WHOLE script even though Tier 2's body never executes under
 *   `--files`). Real, already reported, already queued as its own issue
 *   (#4461, filed separately by #4460's own reporter) — fixing it here
 *   would be exactly the scope creep the reporter took care to avoid.
 * - Tier 1's fence is parseable bash and is covered by its own describe below (#5519). Its
 *   REPO_ROOT containment check used to misclassify every `--files` entry as "outside the
 *   repository" on Windows Git Bash, where `git rev-parse --show-toplevel` returns a mixed path
 *   (`C:/Users/...`) and GNU `realpath` returns an MSYS POSIX path (`/c/Users/...`); both sides are
 *   now normalized with `cygpath -m` and compared on a path boundary. Tier 1 is still seeded here,
 *   not sourced, so these Tier 3 cases stay independent of it.
 *
 * Seeding REVIEW_FILES directly for both tiers isolates the test to Tier
 * 3's own logic — the actual subject of #4460 — independent of either
 * earlier tier's unrelated defects.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'code-review.md');
const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const TIER3_ANCHOR = '**Tier 3 — Phase evaluation scope';

/**
 * Extract the FIRST ```bash fence appearing after `startAnchor` and before
 * `stopAnchor` (or end of file when `stopAnchor` is null).
 */
function extractFirstBashBlockAfter(content, startAnchor, stopAnchor) {
  const start = content.indexOf(startAnchor);
  assert.ok(start !== -1, `code-review.md must contain the anchor "${startAnchor}"`);
  const stop = stopAnchor ? content.indexOf(stopAnchor, start + startAnchor.length) : content.length;
  assert.ok(!stopAnchor || stop !== -1, `code-review.md must contain the anchor "${stopAnchor}" after "${startAnchor}"`);
  const region = content.slice(start, stop);

  const fenceStart = region.indexOf('```bash');
  assert.ok(fenceStart !== -1, `no \`\`\`bash fence found between "${startAnchor}" and its stop anchor`);
  const fenceEnd = region.indexOf('```', fenceStart + '```bash'.length);
  assert.ok(fenceEnd !== -1, `unterminated \`\`\`bash fence after "${startAnchor}"`);
  return region.slice(fenceStart + '```bash'.length, fenceEnd);
}

function seedFixtureRepo(dir) {
  gitOrThrow(['init', '-q'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'user.email', 't@example.com'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'user.name', 'T'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
}

function writeAndCommit(dir, relPath, content, message) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  gitOrThrow(['add', '-A'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['commit', '-q', '-m', message], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
}

// Matches the issue's own fixture exactly: a phase dir with one SUMMARY
// listing only src/alpha.js, and 5 commits adding src/{alpha,beta,gamma,
// delta,epsilon}.js.
function buildFixture(tmpDir) {
  seedFixtureRepo(tmpDir);
  writeAndCommit(tmpDir, 'README.md', '# init\n', 'chore: init');
  writeAndCommit(
    tmpDir,
    '.planning/phases/03-demo/03-01-SUMMARY.md',
    '---\nkey_files:\n  created:\n    - src/alpha.js\n---\n# Summary\n',
    'feat(03-01): phase 3 plan 1',
  );
  for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
    writeAndCommit(tmpDir, `src/${name}.js`, `${name}\n`, `feat(03-01): add ${name}`);
  }
}

/**
 * Runs ONLY Tier 3 (verbatim), seeded with the REVIEW_FILES state a working
 * Tier 1 (`filesOverride` set) or Tier 2 (`filesOverride` empty) would have
 * produced — see the module docblock for why neither earlier tier's own
 * fence is sourced here.
 */
function runTier3(tmpDir, { filesOverride, seedReviewFiles }) {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const tier3 = extractFirstBashBlockAfter(content, TIER3_ANCHOR, '**Post-processing');

  const seedInit = `REVIEW_FILES=(${seedReviewFiles.map((f) => `"${f}"`).join(' ')})`;

  const script = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    // The workflow's own launcher defines gsd_run; the fixture points it at this checkout's CLI.
    `gsd_run() { node "${TOOLS_PATH}" "$@"; }`,
    `FILES_OVERRIDE="${filesOverride || ''}"`,
    seedInit,
    'PHASE_DIR=".planning/phases/03-demo"',
    'PADDED_PHASE="03"',
    'LAST_REVIEW_COMMIT=""',
    // Tier 3 prints diagnostic "File scope: ... files from git diff" lines to
    // stdout as documentation for a human running code-review.md interactively
    // — a brace group (not a subshell: variables set inside still persist to
    // the enclosing shell) redirects that chatter to stderr (captured
    // separately below) instead of discarding it, so a failure carries
    // Tier 3's own reasoning rather than requiring another guess-and-push
    // cycle.
    '{',
    tier3,
    '} 1>&2',
    'printf \'%s\\n\' "${REVIEW_FILES[@]}"',
  ].join('\n');

  const scriptPath = path.join(tmpDir, '.tier-script.sh');
  fs.writeFileSync(scriptPath, script);

  const result = spawnSync('bash', [scriptPath], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: GIT_FIXTURE_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`bash spawn failed: ${result.error.message}\ndiagnostics:\n${result.stderr || '(none)'}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `bash exited ${result.status} (signal ${result.signal})\ndiagnostics:\n${result.stderr || '(none)'}`,
    );
  }
  // Returned as a plain object, not a decorated array: assert.deepEqual on an
  // array compares its own properties too, so an extra property attached
  // directly to the array (tried in an earlier revision of this fix) makes
  // `["src/alpha.js"]` fail deepEqual against a same-valued plain array
  // literal purely because of the decoration -- a self-inflicted false
  // failure, not a Tier 3 behavior change.
  const files = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort();
  return { files, diagnostics: result.stderr };
}

describe('#4460: code-review.md Tier 3 does not widen an explicit --files override', () => {
  const workflowContent = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const tier3Fence = extractFirstBashBlockAfter(workflowContent, TIER3_ANCHOR, '**Post-processing');

  test('the #2666 cross-check elif references FILES_OVERRIDE (the gate exists)', () => {
    const crossCheckIdx = tier3Fence.indexOf('#2666 cross-check');
    assert.ok(crossCheckIdx !== -1, 'Tier 3 fence must contain the #2666 cross-check comment');
    const elifLine = tier3Fence.slice(0, crossCheckIdx).split('\n').filter((l) => l.trim().startsWith('elif')).pop();
    assert.ok(
      elifLine && elifLine.includes('FILES_OVERRIDE'),
      `the elif guarding the #2666 cross-check must reference FILES_OVERRIDE, got: ${JSON.stringify(elifLine)}`,
    );
  });

  test('real execution: --files=src/alpha.js stays scoped to exactly that file (issue #4460 repro)', () => {
    // REVIEW_FILES is seeded to ['src/alpha.js'] directly here -- the value a
    // WORKING Tier 1 would have produced for `--files src/alpha.js` -- rather
    // than sourcing Tier 1's actual fence. See the module docblock: Tier 1's
    // own REPO_ROOT-prefix containment check is confirmed non-functional on
    // Windows CI (git rev-parse and realpath disagree on path FORMAT there,
    // not just short-vs-long names), so this test isolates Tier 3 -- the
    // actual subject of #4460 -- from that unrelated, pre-existing defect.
    const tmpDir = fs.realpathSync.native(createTempDir('gsd-4460-'));
    try {
      buildFixture(tmpDir);
      const { files, diagnostics } = runTier3(tmpDir, { filesOverride: 'src/alpha.js', seedReviewFiles: ['src/alpha.js'] });
      assert.deepEqual(
        files,
        ['src/alpha.js'],
        `--files override must not be widened by Tier 3's cross-check, got: ${JSON.stringify(files)}\ndiagnostics:\n${diagnostics || '(none)'}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('without --files, the #2666 cross-check still widens a partial (Tier-2-equivalent) scope (no regression to the cross-check itself)', () => {
    const tmpDir = fs.realpathSync.native(createTempDir('gsd-4460-'));
    try {
      buildFixture(tmpDir);
      // seedReviewFiles stands in for Tier 2's real output (["src/alpha.js"],
      // the file the fixture's SUMMARY lists) — see the module docblock for
      // why Tier 2's own fence isn't sourced here. Same seed value as the
      // --files case above; only FILES_OVERRIDE differs, which is exactly
      // the variable #4460's fix gates on.
      const { files, diagnostics } = runTier3(tmpDir, { filesOverride: '', seedReviewFiles: ['src/alpha.js'] });
      assert.deepEqual(
        files,
        ['src/alpha.js', 'src/beta.js', 'src/delta.js', 'src/epsilon.js', 'src/gamma.js'],
        `without --files, the cross-check must still widen a partial scope, got: ${JSON.stringify(files)}\ndiagnostics:\n${diagnostics || '(none)'}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('#3926 / #5164: Tier 3 scopes to the phase\'s own commits, not a range', () => {
  const workflowContent = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const tier3Fence = extractFirstBashBlockAfter(workflowContent, TIER3_ANCHOR, '**Post-processing');

  test('the fence asks the resolver and derives no range or phase-start anchor of its own', () => {
    assert.ok(/gsd_run check evaluation-scope --phase "\$\{PADDED_PHASE\}"/.test(tier3Fence), 'Tier 3 must ask the evaluation-scope resolver');
    assert.ok(!/git (?:diff|log)/.test(tier3Fence), 'Tier 3 must not run its own git diff / git log');
    assert.ok(!tier3Fence.includes('--diff-filter=A'), 'Tier 3 must not hand-roll the phase-start anchor');
  });

  test('real execution: the scope is the union of the task commits; an interleaved commit is named, not scoped', () => {
    const tmpDir = fs.realpathSync.native(createTempDir('gsd-3926-'));
    try {
      seedFixtureRepo(tmpDir);
      writeAndCommit(tmpDir, 'README.md', '# init\n', 'chore: init');
      writeAndCommit(tmpDir, '.planning/phases/03-demo/03-CONTEXT.md', 'context\n', 'docs(03): context');
      const sha = (rel, message) => {
        writeAndCommit(tmpDir, rel, `${rel}\n`, message);
        return gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS }).trim();
      };
      const alpha = sha('src/alpha.js', 'feat(03-01): add alpha');
      sha('src/quick-task.js', 'fix(quick): an unrelated quick task interleaved in the phase window');
      const beta = sha('src/beta.js', 'feat(03-01): add beta');
      writeAndCommit(
        tmpDir,
        '.planning/phases/03-demo/03-01-SUMMARY.md',
        `# Summary\n\n## Task Commits\n\n1. **Task 1: alpha** - \`${alpha}\`\n2. **Task 2: beta** - \`${beta}\`\n\n## Next\n`,
        'docs(03-01): summary',
      );
      writeAndCommit(tmpDir, 'src/later-phase.js', 'later\n', 'feat(04-01): a later phase');

      const { files, diagnostics } = runTier3(tmpDir, { filesOverride: '', seedReviewFiles: [] });
      assert.deepEqual(files, ['src/alpha.js', 'src/beta.js'], `got: ${JSON.stringify(files)}\ndiagnostics:\n${diagnostics}`);
      assert.match(diagnostics, /NOT this phase's task commits/);
      assert.match(diagnostics, /src\/quick-task\.js/);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── #5519: the Tier 1 containment guard ─────────────────────────────────────
// The fence below is extracted from code-review.md and EXECUTED verbatim (never reimplemented).
describe('#5519: Tier 1 --files containment guard', () => {
  const tier1 = extractFirstBashBlockAfter(fs.readFileSync(WORKFLOW_PATH, 'utf-8'), '**Tier 1 — --files override', '**Tier 2');
  const OUTSIDE = 'Error: File path outside repository, skipping: ';

  // Git for Windows reports the repository root in the mixed form (C:/R) while its GNU realpath reports
  // an MSYS POSIX path (/c/R/...); `cygpath -m` maps the second to the first. Simulated with bash
  // functions so the real fence runs against both forms on any host.
  const GIT_BASH_FORMS = String.raw`
git() { if [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then echo "C:/R"; else command git "$@"; fi; }
realpath() {
  node -e 'const path=require("path");let p=process.argv[1];if(p.length>2&&p[1]===":"&&p[2]==="/"){p="/"+p[0].toLowerCase()+p.slice(2);}else if(p[0]!=="/"){p="/c/R/"+p;}process.stdout.write(path.posix.normalize(p)+"\n");' "$2"
}
cygpath() {
  case "$2" in
    /[a-zA-Z]/*) printf "%s" "$(printf "%s" "$2" | cut -c2 | tr a-z A-Z):$(printf "%s" "$2" | cut -c3-)" ;;
    *) printf "%s" "$2" ;;
  esac
}
`;

  function runTier1(cwd, files, prelude = '') {
    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      prelude,
      `FILES_OVERRIDE='${files.join(',')}'`,
      'IFS="," read -ra FILES_ARRAY <<< "$FILES_OVERRIDE"',
      tier1,
      'printf "SCOPE:%s\\n" ${REVIEW_FILES[@]+"${REVIEW_FILES[@]}"}',
    ].join('\n');
    const scriptPath = path.join(cwd, '.tier1-script.sh');
    fs.writeFileSync(scriptPath, script);
    const r = spawnSync('bash', [scriptPath], { cwd, encoding: 'utf8', timeout: GIT_FIXTURE_TIMEOUT_MS });
    if (r.error) throw new Error(`bash spawn failed: ${r.error.message}`);
    assert.equal(r.status, 0, `Tier 1 exited ${r.status}: ${r.stderr}`);
    const lines = r.stdout.split('\n').map((l) => l.replace(/\r$/, ''));
    return {
      outside: lines.filter((l) => l.startsWith(OUTSIDE)).map((l) => l.slice(OUTSIDE.length)),
      // printf with an empty array still emits one bare `SCOPE:` line, which is not a file.
      kept: lines.filter((l) => l.startsWith('SCOPE:') && l !== 'SCOPE:').map((l) => l.slice('SCOPE:'.length)),
      stdout: r.stdout,
    };
  }

  let tmp;
  const withTmp = (fn) => () => {
    tmp = createTempDir('gsd-5519-');
    try { fn(tmp); } finally { cleanup(tmp); }
  };

  test('a relative path and an absolute path in either form are accepted when git and realpath report different forms', withTmp((dir) => {
    const files = ['src/a.js', '/c/R/src/a.js', 'C:/R/src/a.js'];
    const r = runTier1(dir, files, GIT_BASH_FORMS);
    assert.deepEqual(r.outside, [], `no in-repository entry may be reported outside the repository:\n${r.stdout}`);
    for (const f of files) {
      assert.ok(r.stdout.includes(`Warning: File not found, skipping: ${f}`), `${f} passed containment (it only fails the existence check on this fake root)`);
    }
  }));

  test('paths outside the repository are still rejected in the same forms, including a sibling sharing the repo-name prefix', withTmp((dir) => {
    const files = ['../../etc/passwd', '/etc/passwd', '../R-other/x', 'C:/R-other/x', '/c/R-other/x'];
    const r = runTier1(dir, files, GIT_BASH_FORMS);
    assert.deepEqual(r.outside, files, `every entry must be rejected:\n${r.stdout}`);
    assert.deepEqual(r.kept, []);
  }));

  test('real bash: in-repository files are kept; ../ escapes and a sibling sharing the repo-name prefix are rejected', (t) => {
    const probe = spawnSync('realpath', ['-m', '.'], { encoding: 'utf8', timeout: GIT_FIXTURE_TIMEOUT_MS });
    if (probe.error || probe.status !== 0) { t.skip('GNU realpath -m is not available (macOS without coreutils): the fail-closed test covers that shape'); return; }
    withTmp((rawParent) => {
    // Windows hands out 8.3 short temp paths (C:\Users\RUNNER~1\...) that git reports in long form; an
    // 8.3-vs-long mismatch is a separate path-form concern from the one under test, so build the fixture
    // under the native long name.
    const parent = fs.realpathSync.native(rawParent);
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    seedFixtureRepo(repo);
    writeAndCommit(repo, 'src/a.js', 'a\n', 'chore: init');
    fs.mkdirSync(path.join(parent, 'repo-other'));
    fs.writeFileSync(path.join(parent, 'repo-other', 'f.js'), 'x\n');
    fs.writeFileSync(path.join(parent, 'outside.js'), 'x\n');
    const r = runTier1(repo, ['src/a.js', '../repo-other/f.js', '../outside.js', '../../etc/passwd']);
    // Raw forms the fence compared, so a path-form regression is diagnosable from the failure alone.
    const forms = spawnSync('bash', ['-c', 'echo "toplevel=$(git rev-parse --show-toplevel)"; echo "realpath=$(realpath -m src/a.js)"; command -v cygpath >/dev/null && echo "cygpath-root=$(cygpath -m "$(git rev-parse --show-toplevel)")"; echo "cygpath-file=$(command -v cygpath >/dev/null && cygpath -m "$(realpath -m src/a.js)")"'], { cwd: repo, encoding: 'utf8', timeout: GIT_FIXTURE_TIMEOUT_MS }).stdout;
    assert.deepEqual(r.kept, ['src/a.js'], `only the in-repository file is reviewed:\n${r.stdout}\npath forms:\n${forms}`);
    assert.deepEqual(r.outside, ['../repo-other/f.js', '../outside.js', '../../etc/passwd']);
    })();
  });

  test('without realpath the guard still fails closed (the macOS shape)', withTmp((parent) => {
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    seedFixtureRepo(repo);
    writeAndCommit(repo, 'src/a.js', 'a\n', 'chore: init');
    const r = runTier1(repo, ['src/a.js'], 'realpath() { return 127; }');
    assert.deepEqual(r.kept, [], 'a path that cannot be verified is not reviewed');
    assert.deepEqual(r.outside, ['src/a.js']);
  }));

  test('an absolute path that still holds .. segments (no GNU realpath to resolve it) is rejected, not trusted', withTmp((parent) => {
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    seedFixtureRepo(repo);
    writeAndCommit(repo, 'src/a.js', 'a\n', 'chore: init');
    const escape = `${repo.replace(/\\/g, '/')}/../../etc/hosts`;
    const r = runTier1(repo, [escape], 'realpath() { return 127; }');
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.outside, [escape], 'an unresolved ".." path is not inside the repository');
  }));

  test('an empty repository root (git failed) accepts nothing', withTmp((dir) => {
    const r = runTier1(dir, ['/etc/hosts', 'src/a.js'], 'git() { return 128; }');
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.outside, ['/etc/hosts', 'src/a.js']);
  }));

  test('the platform notes document the Windows path-form handling instead of a limitation', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const notes = content.slice(content.indexOf('<platform_notes>'));
    assert.match(notes, /cygpath -m/, 'platform_notes explains the cygpath -m normalization of the --files check');
    assert.match(notes, /C:\/Users[^\n]*\n?[^\n]*\/c\/Users/, 'and names the two path forms Git Bash reports');
  });
});
