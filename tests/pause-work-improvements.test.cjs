const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('pause-work improvements', () => {
  let pauseContent;

  test('pause-work.md exists', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md');
    assert.ok(fs.existsSync(p));
    pauseContent = fs.readFileSync(p, 'utf-8');
  });

  test('#1489: pause-work detects non-phase contexts (spike, deliberation, research)', () => {
    pauseContent = pauseContent || fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf-8'
    );
    assert.ok(pauseContent.includes('spike') || pauseContent.includes('Spike'),
      'pause-work should handle spike context');
    assert.ok(pauseContent.includes('deliberation') || pauseContent.includes('research'),
      'pause-work should handle deliberation/research context');
  });

  test('#1489: pause-work writes to non-phase paths when appropriate', () => {
    pauseContent = pauseContent || fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf-8'
    );
    assert.ok(pauseContent.includes('.planning/.continue-here') ||
              pauseContent.includes('.planning/spikes') ||
              pauseContent.includes('non-phase'),
      'pause-work should write to root .planning/ when not in a phase');
  });

  test('#1490: continue-here template includes required-reading section', () => {
    pauseContent = pauseContent || fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf-8'
    );
    assert.ok(pauseContent.includes('Required Reading') || pauseContent.includes('required-reading'),
      'Template should include Required Reading section');
  });

  test('#1490: continue-here template includes anti-patterns section', () => {
    pauseContent = pauseContent || fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf-8'
    );
    assert.ok(pauseContent.includes('Anti-Pattern') || pauseContent.includes('anti-pattern') ||
              pauseContent.includes('do NOT repeat'),
      'Template should include Anti-Patterns section');
  });

  test('#1490: continue-here template includes infrastructure-state section', () => {
    pauseContent = pauseContent || fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf-8'
    );
    assert.ok(pauseContent.includes('Infrastructure') || pauseContent.includes('infrastructure'),
      'Template should include Infrastructure State section');
  });

  test('#1487: pause-work documents pre-execution critique gate', () => {
    pauseContent = pauseContent || fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf-8'
    );
    assert.ok(
      pauseContent.includes('critique') || pauseContent.includes('design gate') ||
      pauseContent.includes('Pre-Execution'),
      'pause-work should document design critique gate for design→execution transitions'
    );
  });

  test('bug #4943: pause-work commit step uses conventional commit prefix docs(pause):', () => {
    pauseContent = pauseContent || fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf-8'
    );
    assert.doesNotMatch(
      pauseContent,
      /query commit "wip:/,
      'pause-work.md must not use non-conventional "wip:" commit prefix (#4943)'
    );
    assert.match(
      pauseContent,
      /query commit "docs\(pause\):/,
      'pause-work.md must use conventional "docs(pause):" commit prefix (#4943)'
    );
  });

  test('bug #4943: git-integration.md handoff format uses conventional commit prefix docs(pause):', () => {
    const gitIntContent = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'references', 'git-integration.md'), 'utf-8'
    );
    assert.doesNotMatch(
      gitIntContent,
      /query commit "wip:/,
      'git-integration.md must not use non-conventional "wip:" commit prefix (#4943)'
    );
    assert.match(
      gitIntContent,
      /query commit "docs\(pause\):/,
      'git-integration.md must use conventional "docs(pause):" commit prefix (#4943)'
    );
  });

  test('bug #4943: execute-phase.md recovery commit uses conventional commit prefix chore(recover):', () => {
    const execPhaseContent = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'), 'utf-8'
    );
    assert.doesNotMatch(
      execPhaseContent,
      /commit -m 'wip:/,
      'execute-phase.md must not use non-conventional "wip:" commit prefix (#4943)'
    );
    assert.match(
      execPhaseContent,
      /commit -m 'chore\(recover\):/,
      'execute-phase.md must use conventional "chore(recover):" commit prefix (#4943)'
    );
  });

  test('bug #4943: zh-CN git-integration.md mirror uses conventional commit prefix docs(pause):', () => {
    const zhGitIntContent = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'zh-CN', 'references', 'git-integration.md'), 'utf-8'
    );
    assert.doesNotMatch(
      zhGitIntContent,
      /query commit "wip:/,
      'zh-CN git-integration.md must not use non-conventional "wip:" commit prefix (#4943)'
    );
    assert.match(
      zhGitIntContent,
      /query commit "docs\(pause\):/,
      'zh-CN git-integration.md must use conventional "docs(pause):" commit prefix (#4943)'
    );
  });

  test('bug #4943: pause-work workflow and command checklists do not use "as WIP" wording', () => {
    pauseContent = pauseContent || fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf-8'
    );
    assert.doesNotMatch(
      pauseContent,
      /Committed as WIP/,
      'pause-work.md must not contain residual "Committed as WIP" checklist item (#4943)'
    );

    const cmdPauseContent = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'pause-work.md'), 'utf-8'
    );
    assert.doesNotMatch(
      cmdPauseContent,
      /Git commit as WIP/,
      'commands/gsd/pause-work.md must not contain residual "Git commit as WIP" description (#4943)'
    );
  });

  test('bug #4943: agents/gsd-executor.md scratch commit uses conventional commit format', () => {
    const executorContent = fs.readFileSync(
      path.join(__dirname, '..', 'agents', 'gsd-executor.md'), 'utf-8'
    );
    assert.doesNotMatch(
      executorContent,
      /git commit -m "wip"/,
      'agents/gsd-executor.md must not use non-conventional bare "wip" commit message (#4943)'
    );
    assert.match(
      executorContent,
      /git commit -m "chore\(wip\): scratch"/,
      'agents/gsd-executor.md must use conventional "chore(wip): scratch" commit message (#4943)'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3446-resume-continue-here-discovery.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3446-resume-continue-here-discovery (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #3446)
// Workflow `.md` files are the runtime contract executed by Claude Code as
// embedded bash. This test extracts the actual `check_incomplete_work` bash
// block from resume-project.md and exercises it against a planted directory
// layout — that's a behavioral integration test of the workflow contract,
// not regex-on-source.

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup, readFileNormalized } = require('./helpers.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'resume-project.md');

// Extract the first ```bash``` code block inside the
// `<step name="check_incomplete_work">` element. That's the snippet the
// runtime actually executes; it's what we want to validate.
//
// readFileNormalized() strips \r\n -> \n before the fence match below runs —
// the extracted snippet is spawned via spawnSync('bash', ...) in
// runSnippet(), so an un-normalized read on a Windows checkout would break
// bash mid-script (DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE, #2650).
function extractCheckBlock() {
  const md = readFileNormalized(WORKFLOW_PATH);
  const stepStart = md.indexOf('<step name="check_incomplete_work">');
  assert.ok(stepStart >= 0, 'resume-project.md must contain a check_incomplete_work step');
  const stepEnd = md.indexOf('</step>', stepStart);
  assert.ok(
    stepEnd >= 0,
    'check_incomplete_work step must have a closing </step> tag',
  );
  const stepBody = md.slice(stepStart, stepEnd);
  const stepLines = stepBody.split('\n');
  for (const block of scanFencedBlocks(stepLines)) {
    if (block.closeLineIdx === -1) continue;
    const info = (block.infoString || '').trim();
    if (info !== 'bash' && info !== 'sh') continue;
    return stepLines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n');
  }
  assert.fail('check_incomplete_work step must embed a ```bash code block');
}

function runSnippet(cwd, snippet) {
  // has_interrupted_agent is a downstream-orchestrator variable; default it
  // to "false" so the embedded `if` branch is a no-op during this test.
  return toLegacyResult(runHookSeam('-c', [snippet], {
    interpreter: 'bash',
    cwd,
    env: { ...process.env, has_interrupted_agent: 'false', interrupted_agent_id: '' },
  }));
}

describe('bug #3446: resume-project detects non-phase and legacy continue-here handoffs', () => {
  let tmpDir;
  let snippet;

  before(() => {
    snippet = extractCheckBlock();
    tmpDir = createTempDir('gsd-bug-3446-');

    // Plant the three discovery surfaces that bug #3446 was originally
    // filed to cover.
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', '.continue-here.md'),
      '---\ncontext: default\n---\nroot-of-.planning handoff\n',
      'utf8',
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'sketches', 'SKETCH-001'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'sketches', 'SKETCH-001', '.continue-here.md'),
      '---\ncontext: sketch\n---\nsketch handoff\n',
      'utf8',
    );

    fs.writeFileSync(
      path.join(tmpDir, '.continue-here.md'),
      '---\ncontext: legacy\n---\nlegacy repo-root handoff\n',
      'utf8',
    );
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('check_incomplete_work surfaces .planning/.continue-here.md (depth 1 under .planning)', () => {
    const result = runSnippet(tmpDir, snippet);
    assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
    assert.match(
      result.stdout,
      /\.planning\/\.continue-here\.md/,
      `expected .planning/.continue-here.md in stdout; got: ${JSON.stringify(result.stdout)}`,
    );
  });

  test('check_incomplete_work surfaces .planning/sketches/SKETCH-001/.continue-here.md (depth 3 under .planning)', () => {
    const result = runSnippet(tmpDir, snippet);
    assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
    assert.match(
      result.stdout,
      /\.planning\/sketches\/SKETCH-001\/\.continue-here\.md/,
      `expected sketch handoff in stdout; got: ${JSON.stringify(result.stdout)}`,
    );
  });

  test('check_incomplete_work surfaces legacy repo-root .continue-here.md', () => {
    const result = runSnippet(tmpDir, snippet);
    assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
    assert.match(
      result.stdout,
      /(^|\n)\.\/\.continue-here\.md(\n|$)/,
      `expected legacy ./.continue-here.md in stdout; got: ${JSON.stringify(result.stdout)}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3689-resume-glob-nomatch.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3689-resume-glob-nomatch (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #3689)
// Workflow `.md` files are the runtime contract executed by Claude Code as
// embedded bash. Asserting on the staged text of resume-project.md and on the
// behavior of the embedded snippet under real shells is a behavioral test of
// the workflow itself, not source-grep theater.

/**
 * Regression for #3689 — /gsd-resume-work silently drops
 * `.planning/.continue-here*.md` checkpoints under zsh's default NOMATCH.
 *
 * Root cause: the `check_incomplete_work` step in
 * `gsd-core/workflows/resume-project.md` used a chained `ls` with six
 * bare-glob arguments. Under zsh's default `NOMATCH` setopt the first
 * non-matching glob aborts the entire command during word-expansion — every
 * pattern after that point is never evaluated, including the one that holds
 * valid pause checkpoints (`.planning/.continue-here*.md`). `2>/dev/null ||
 * true` only suppresses ls's own stderr / exit code; it has no effect on the
 * shell's pre-exec abort.
 *
 * Fix: replace the chained `ls` with two `find` calls. `find` does not use
 * shell glob expansion, and `find <missing-dir> -maxdepth N -name PATTERN
 * -print 2>/dev/null` tolerates absent directories on both bash and zsh.
 *
 * This test covers:
 *   1. zsh under `-o nomatch`: checkpoint at `.planning/.continue-here-*.md`
 *      is listed even when `.planning/spikes`, `.planning/sketches`,
 *      `.planning/deliberations` are absent (the common new-project layout).
 *   2. bash default: same behavior.
 *   3. zsh `-o nomatch` with no `.continue-here` files anywhere: exits 0,
 *      no output, no error.
 *   4. Text invariant: resume-project.md no longer carries the brittle
 *      chained-ls pattern.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { spawnSync } = require('node:child_process');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { span } = require('./helpers/doc-bash-span.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'resume-project.md');

// The discovery lines the workflow ships, read from resume-project.md itself (#4805) rather than a
// copy that could drift: from the #2962 nullglob prelude (which keeps zsh NOMATCH from aborting a glob
// loop) through the line before the next check. Shell builtins only, so it runs as is under bash and zsh.
const DISCOVERY_SNIPPET = span(
  'gsd-core/workflows/resume-project.md',
  '# #2962: zsh aborts the block',
  '# Check for plans without summaries',
).join('\n');

// What the workflow shipped before #4805, kept only as a control: with `find` unavailable it prints nothing.
const LEGACY_FIND_SNIPPET = [
  "find .planning -maxdepth 3 -name '.continue-here*.md' -print 2>/dev/null || true",
  "find . -maxdepth 1 -name '.continue-here*.md' -print 2>/dev/null || true",
  "find .planning/async-jobs -maxdepth 1 -name '*.json' -print 2>/dev/null || true",
].join('\n');

function hasShell(name) {
  const result = toLegacyResult(runHookSeam(name, [], { interpreter: 'which' }));
  return result.status === 0 && result.stdout.trim().length > 0;
}

describe('bug #3689 — resume-project.md continue-here scan under zsh NOMATCH', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir('gsd-bug-3689-');
    // Reproduce the common new-project layout: a `.planning/` with a
    // suffixed continue-here file and *no* spike / sketch / deliberation
    // subdirectories.
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', '.continue-here-AT-1234.md'),
      '---\ncontext: default\n---\nhandoff body\n',
      'utf8',
    );
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('zsh -o nomatch lists the .planning/.continue-here-* checkpoint', { skip: !hasShell('zsh') }, () => {
    const result = toLegacyResult(runHookSeam('-o', ['nomatch', '-c', DISCOVERY_SNIPPET], {
      interpreter: 'zsh',
      cwd: tmpDir,
    }));
    assert.equal(result.status, 0, `zsh exited ${result.status}; stderr=${result.stderr}`);
    assert.match(
      result.stdout,
      /\.planning\/\.continue-here-AT-1234\.md/,
      `expected checkpoint in stdout, got: ${JSON.stringify(result.stdout)}`,
    );
  });

  test('bash default lists the .planning/.continue-here-* checkpoint', { skip: !hasShell('bash') }, () => {
    const result = toLegacyResult(runHookSeam('-c', [DISCOVERY_SNIPPET], {
      interpreter: 'bash',
      cwd: tmpDir,
    }));
    assert.equal(result.status, 0, `bash exited ${result.status}; stderr=${result.stderr}`);
    assert.match(
      result.stdout,
      /\.planning\/\.continue-here-AT-1234\.md/,
      `expected checkpoint in stdout, got: ${JSON.stringify(result.stdout)}`,
    );
  });
});

describe('bug #3689 — empty workspace exits cleanly', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir('gsd-bug-3689-');
    // No .planning/ at all, no .continue-here files. Pure greenfield.
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('zsh -o nomatch with no checkpoints exits 0, empty output', { skip: !hasShell('zsh') }, () => {
    const result = toLegacyResult(runHookSeam('-o', ['nomatch', '-c', DISCOVERY_SNIPPET], {
      interpreter: 'zsh',
      cwd: tmpDir,
    }));
    assert.equal(result.status, 0, `zsh exited ${result.status}; stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), '', `expected no stdout, got: ${JSON.stringify(result.stdout)}`);
  });
});

describe('bug #3689 — workflow text invariant', () => {
  test('resume-project.md no longer chains bare globs through ls', () => {
    const body = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.doesNotMatch(
      body,
      /ls\s+\.planning\/spikes\/\*\/\.continue-here/,
      'resume-project.md still contains the chained `ls .planning/spikes/*/.continue-here*.md` pattern that aborts under zsh NOMATCH.',
    );
  });

  test('the discovery step does not shell out to the external find binary (#4805)', () => {
    // Allowlisted agent shells (fd-only policies) refuse a bare `find`, and the per-line `2>/dev/null`
    // used to hide the refusal, so a checkpoint on disk looked absent.
    const commandLines = DISCOVERY_SNIPPET.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    assert.ok(commandLines.length > 0, 'the extracted discovery lines must contain commands');
    for (const line of commandLines) {
      assert.doesNotMatch(line, /(^|[\s;&|(])find\s/, `bare find in the discovery step: ${line}`);
    }
  });
});

// The empty-PATH runs resolve the shell with `command -v` and strip the environment. On Windows that yields an
// MSYS path (`/usr/bin/bash`) Node cannot spawn, and the MSYS runtime needs SYSTEMROOT, so the block is POSIX-only,
// like the repo's other bash-block tests. The listing semantics are plain bash and are covered on Linux and macOS.
describe('#4805 — discovery runs without any external search binary', { skip: process.platform === 'win32' ? 'POSIX shell paths and an empty PATH' : false }, () => {
  let tmpDir;
  let emptyBin;

  before(() => {
    tmpDir = createTempDir('gsd-bug-4805-');
    emptyBin = createTempDir('gsd-bug-4805-bin-');
    const plan = path.join(tmpDir, '.planning');
    fs.mkdirSync(path.join(plan, 'phases', '01-x'), { recursive: true });
    fs.mkdirSync(path.join(plan, 'phases', '01-x', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(plan, 'async-jobs'), { recursive: true });
    fs.writeFileSync(path.join(plan, '.continue-here-AT-1234.md'), 'a\n', 'utf8');
    fs.writeFileSync(path.join(plan, 'phases', '01-x', '.continue-here.md'), 'b\n', 'utf8');
    fs.writeFileSync(path.join(plan, 'phases', '01-x', 'deep', '.continue-here-too-deep.md'), 'c\n', 'utf8');
    fs.writeFileSync(path.join(plan, 'async-jobs', 'job-1.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(plan, 'async-jobs', 'notes.txt'), 'x\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.continue-here-legacy.md'), 'd\n', 'utf8');
  });

  after(() => {
    cleanup(tmpDir);
    cleanup(emptyBin);
  });

  // Run `snippet` under `shell` with a PATH holding nothing, so any external command (find included) fails.
  function runWithoutBinaries(shell, args, snippet, cwd) {
    const abs = spawnSync('sh', ['-c', `command -v ${shell}`], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }).stdout.trim();
    const r = spawnSync(abs, [...args, snippet], { cwd, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: { PATH: emptyBin, HOME: tmpDir } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  const lines = (out) => out.split('\n').filter(Boolean).sort();
  const EXPECTED = [
    './.continue-here-legacy.md',
    '.planning/.continue-here-AT-1234.md',
    '.planning/async-jobs/job-1.json',
    '.planning/phases/01-x/.continue-here.md',
  ];

  for (const [shell, args, skip] of [
    ['bash', ['-c'], !hasShell('bash')],
    ['zsh', ['-o', 'nomatch', '-c'], !hasShell('zsh')],
  ]) {
    test(`${shell}: lists every checkpoint and async-job manifest with an empty PATH`, { skip }, () => {
      const r = runWithoutBinaries(shell, args, DISCOVERY_SNIPPET, tmpDir);
      assert.equal(r.status, 0, `${shell} exited ${r.status}; stderr=${r.stderr}`);
      assert.deepEqual(lines(r.stdout), EXPECTED);
    });

    test(`${shell}: a checkpoint deeper than three levels below .planning is not listed (find -maxdepth 3 parity)`, { skip }, () => {
      const r = runWithoutBinaries(shell, args, DISCOVERY_SNIPPET, tmpDir);
      assert.ok(!r.stdout.includes('too-deep'), r.stdout);
    });

    test(`${shell}: an empty workspace exits 0 with no output`, { skip }, () => {
      const empty = createTempDir('gsd-bug-4805-empty-');
      try {
        const r = runWithoutBinaries(shell, args, DISCOVERY_SNIPPET, empty);
        assert.equal(r.status, 0, `${shell} exited ${r.status}; stderr=${r.stderr}`);
        assert.equal(r.stdout, '');
      } finally {
        cleanup(empty);
      }
    });
  }

  test('control: the pre-#4805 find lines print nothing when find is unavailable', { skip: !hasShell('bash') }, () => {
    const r = runWithoutBinaries('bash', ['-c'], LEGACY_FIND_SNIPPET, tmpDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'the refusal was swallowed, so the checkpoint looked absent');
  });
});
  });
}
