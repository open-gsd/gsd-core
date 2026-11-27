/**
 * Process-contract cases of the phase suite (#6334, ADR-6315 item 16).
 *
 * Phase numbers are allocated across sibling git worktrees, so the subject of
 * these cases is git itself: they build repositories and linked worktrees with
 * real git and assert what `phase add` allocates against them (the `phase add`
 * call is made in this process, as everywhere else; only git is real). The
 * rest of the phase suite is tested in-process in tests/phase.test.cjs.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { createFixture, seedPhase } = require('./fixtures/index.cjs');
const { GIT_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runGsdTools, createTempProject, cleanup, absPlanningPath } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// phase number allocation across sibling git worktrees (#3849)
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add allocation vs sibling git worktrees (#3849)', () => {
  const activeWorktrees = [];
  const activeDirs = [];

  function git(args, cwd) {
    return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  }

  function initRepo(repoDir) {
    fs.mkdirSync(path.join(repoDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap v1.0', '', '### Phase 440: existing thing', '**Goal:** Setup', '', '---', ''].join('\n')
    );
    fs.mkdirSync(path.join(repoDir, '.planning', 'phases', '440-existing-thing'));
    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'init'], repoDir);
  }

  function initBracketRepo(repoDir) {
    fs.mkdirSync(path.join(repoDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'CK', phase_id_convention: 'bracket' }, null, 2) + '\n',
    );
    fs.writeFileSync(path.join(repoDir, '.planning', 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(
      path.join(repoDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## [CK.02] v2.0 — Foundation\n',
    );
    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'init'], repoDir);
  }

  /** Materialize the issue's repro: a sibling worktree branch holding Phase 441. */
  function addSiblingHolding441(repoDir) {
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-sib-'));
    git(['worktree', 'add', '--detach', worktreeDir, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir });
    fs.mkdirSync(path.join(worktreeDir, '.planning', 'phases', '441-conversation-surface'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap v1.0', '', '### Phase 440: existing thing', '**Goal:** Setup', '', '### Phase 441: conversation surface', '**Goal:** Talk', '', '---', ''].join('\n')
    );
    return worktreeDir;
  }

  /** A sibling worktree whose checkout has no .planning at all (fail-open case). */
  function addBareSibling(repoDir) {
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-bare-'));
    git(['worktree', 'add', '--detach', worktreeDir, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir });
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- fixture SETUP, not teardown: strips the tracked .planning/ so this worktree has none; cleanup() owns the dir's removal with the Windows retry budget
    fs.rmSync(path.join(worktreeDir, '.planning'), { recursive: true, force: true });
    return worktreeDir;
  }

  function teardown() {
    while (activeWorktrees.length) {
      const { repoDir, worktreeDir } = activeWorktrees.pop();
      try {
        git(['worktree', 'remove', '--force', worktreeDir], repoDir);
      } catch (_) { /* best-effort; cleanup() below still removes the directory */ }
      cleanup(worktreeDir);
    }
    while (activeDirs.length) cleanup(activeDirs.pop());
  }

  afterEach(teardown);

  test('phase add skips a number held only by a sibling worktree (dir + roadmap header)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-main-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    addSiblingHolding441(repoDir);

    const result = runGsdTools('phase add anything', repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      442,
      '#3849: sibling worktree holds Phase 441 — allocation must skip to 442, not collide'
    );
    assert.ok(
      fs.existsSync(path.join(repoDir, '.planning', 'phases', '442-anything')),
      'directory for the non-colliding 442 should be created'
    );
  });

  test('phase add-batch skips a number held only by a sibling worktree', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-batch-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    addSiblingHolding441(repoDir);

    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["New Thing"]'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases[0].phase_number,
      442,
      '#3849: the batch allocator must widen its horizon the same way the single-add allocator does'
    );
  });

  test('bracket allocation reserves reader-resolvable legacy directory and ROADMAP numbers in a sibling', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-bracket-'));
    activeDirs.push(repoDir);
    initBracketRepo(repoDir);
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-bracket-sib-'));
    git(['worktree', 'add', '--detach', sibling, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir: sibling });
    fs.mkdirSync(path.join(sibling, '.planning', 'phases', 'CK-01-legacy'), { recursive: true });
    fs.appendFileSync(
      path.join(sibling, '.planning', 'ROADMAP.md'),
      '\n### Phase 02: sibling roadmap reservation\n\n**Goal:** taken\n',
    );

    const result = runGsdTools(['phase', 'add', 'After Sibling'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 3);
    assert.strictEqual(output.directory, '.planning/phases/CK.02-03-after-sibling');
  });

  // #4304: a sibling whose bracket write context cannot resolve (no
  // project_code) contributes nothing, and resolving it must not print an
  // error to stderr while the local phase add succeeds.
  test('bracket allocation skips a sibling without a resolvable bracket context, with clean stderr', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-bracket-noctx-'));
    activeDirs.push(repoDir);
    initBracketRepo(repoDir);
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-bracket-noctx-sib-'));
    git(['worktree', 'add', '--detach', sibling, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir: sibling });
    fs.writeFileSync(
      path.join(sibling, '.planning', 'config.json'),
      JSON.stringify({ phase_id_convention: 'bracket' }, null, 2) + '\n',
    );
    fs.appendFileSync(
      path.join(sibling, '.planning', 'ROADMAP.md'),
      '\n### [CK.02] 05: sibling without a project code\n\n**Goal:** ignored\n',
    );

    const result = require('./helpers.cjs').runGsdToolsCaptured(['phase', 'add', 'Local'], repoDir);

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stderr || '', /Error:|project_code|phase_id_convention/);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.phase_number, 1);
    assert.strictEqual(output.directory, '.planning/phases/CK.02-01-local');
  });

  test('a sibling worktree without .planning/ changes nothing (fail open)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-failopen-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    addBareSibling(repoDir);

    const result = runGsdTools('phase add next thing', repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 441, 'no sibling numbers visible — max+1 from the local 440');
  });

  test('allocation FROM a linked worktree counts the main checkout too (the incident topology)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-linked-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    // The real incident ran the other direction: cwd is a linked worktree and
    // the MAIN checkout (scanned as a sibling here) holds the higher number.
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-linked-wt-'));
    git(['worktree', 'add', '--detach', worktreeDir, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir });
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- fixture SETUP, not teardown: strips the tracked .planning/ so this worktree has none; cleanup() owns the dir's removal with the Windows retry budget
    fs.rmSync(path.join(worktreeDir, '.planning'), { recursive: true, force: true });
    fs.mkdirSync(path.join(worktreeDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap v1.0', '', '### Phase 440: base', '**Goal:** Setup', '', '---', ''].join('\n')
    );

    const result = runGsdTools('phase add from linked', worktreeDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      441,
      '#3849: the main checkout (440) must be visible when allocating from a linked worktree'
    );
  });

  // Phase 6 (#5007): collectSiblingWorktreePhaseNums migrated its hand-rolled
  // header regex onto buildPhaseHeadingScanRegex with the LABEL_ONLY baseline
  // and no convention argument — a deliberate non-widening, since this is a
  // "counter" site (phase-id.cts's own LABEL_ONLY docstring guidance). A
  // bracket-tagged sibling heading must stay unrecognized before AND after
  // the migration — proving the swap did not (accidentally) start admitting
  // the ANY_BRACKET grammar the real-heading readers use.
  test('#5007: a bracket-tagged sibling heading does not corrupt (or widen) the numeric allocation horizon', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5007-bracket-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    const sha = gitOrThrow(['rev-parse', 'HEAD'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5007-bracket-sib-'));
    gitOrThrow(['worktree', 'add', '--detach', worktreeDir, sha], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    activeWorktrees.push({ repoDir, worktreeDir });
    fs.mkdirSync(path.join(worktreeDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap v1.0', '', '### [GSD.01] Phase 441: bracket-tagged sibling phase', '**Goal:** Talk', '', '---', ''].join('\n')
    );

    const result = runGsdTools('phase add anything', repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      441,
      '#5007: the bracket-tagged sibling heading is not counted (LABEL_ONLY baseline, no convention widening) — next is 441, not 442'
    );
  });

  test('phase add-batch counts bullet-only Phase N rows (#1229 reached the batch path)', () => {
    const tmp = createTempProject();
    try {
      fs.writeFileSync(
        path.join(tmp, '.planning', 'ROADMAP.md'),
        ['# Roadmap v1.0', '', '- [ ] **Phase 11: bullet-only phase**', '', '---', ''].join('\n')
      );
      const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["After Bullet"]'], tmp);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(
        output.phases[0].phase_number,
        12,
        '#3849 secondary: a bullet-only Phase 11 must not be re-allocated by add-batch'
      );
    } finally {
      cleanup(tmp);
    }
  });

  // #5113 claim 3: `Depends on` was `newId - 1`, but newId is max+1 over sibling-worktree phases too,
  // so N-1 could be a phase that exists only on another branch.
  test('#5113: phase add depends on a phase this roadmap has, not a number only a sibling holds', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5113-main-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    addSiblingHolding441(repoDir);

    const result = runGsdTools('phase add anything', repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_number, 442);

    const roadmap = fs.readFileSync(path.join(repoDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /### Phase 442: anything[\s\S]*?\*\*Depends on:\*\* Phase 440\b/);
    assert.doesNotMatch(roadmap, /Depends on:\*\* Phase 441/, 'Phase 441 exists only on another branch');
  });

  test('#5113: phase add-batch chains each phase to one that exists, the first to the real predecessor', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5113-batch-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    addSiblingHolding441(repoDir);

    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["First New","Second New"]'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(repoDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /### Phase 442: First New[\s\S]*?\*\*Depends on:\*\* Phase 440\b/);
    assert.match(roadmap, /### Phase 443: Second New[\s\S]*?\*\*Depends on:\*\* Phase 442\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase add / add-batch under phase_id_convention: bracket (#5528)
//
// The allocation scans counted only plain `Phase N` lines, so a roadmap whose only phase is
// `[GSD.02] 01` yielded a second phase numbered 1. Under the bracket convention every
// representation (heading, checklist bullet, directory) of an existing phase must block reuse.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add / add-batch allocation: non-bracket repos are unchanged, bracket repos never reuse a number (#5528)', () => {
  let tmp;
  beforeEach(() => { tmp = createTempProject('gsd-5528-'); });
  afterEach(() => { cleanup(tmp); });

  function setup(roadmapLines, { convention = 'bracket', dirs = [], milestone = 'v2.0' } = {}) {
    cleanup(tmp); // a fresh project per call: earlier `phase add` runs left phase directories behind
    tmp = createTempProject('gsd-5528-');
    const planning = path.join(tmp, '.planning');
    fs.mkdirSync(path.join(planning, 'phases'), { recursive: true });
    fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify(convention ? { phase_id_convention: convention } : {}));
    fs.writeFileSync(path.join(planning, 'STATE.md'), `---\n${milestone ? `milestone: ${milestone}\n` : ''}---\n# State\n`);
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmapLines.join('\n'));
    for (const d of dirs) fs.mkdirSync(path.join(planning, 'phases', d));
    return planning;
  }
  // Typed read-back through the CLI (roadmap get-phase), not a pattern match on ROADMAP.md.
  const roadmapPhase = (num) => JSON.parse(runGsdTools(['roadmap', 'get-phase', String(num)], tmp).output);
  const dependsOn = (num) => roadmapPhase(num).section.match(/\*\*Depends on:\*\* ([^\n]+)/)?.[1];
  // The command's job is to WRITE the phase, not only to echo a number: its directory and heading.
  function assertWritten(num, slug = 'new-thing', title = 'New thing') {
    const nn = String(num).padStart(2, '0');
    assert.ok(fs.existsSync(path.join(tmp, '.planning', 'phases', `${nn}-${slug}`)), `phases/${nn}-${slug} created`);
    const found = roadmapPhase(num);
    assert.ok(found.found && found.phase_name === title, `ROADMAP.md gains "### Phase ${num}: ${title}"`);
  }
  // A git repo at tmp plus one detached sibling worktree of it (removed with the test).
  function addSiblingWorktree(t, prefix) {
    const git = (args, cwd) => gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    git(['init', '-b', 'main'], tmp);
    git(['config', 'user.email', 'test@example.com'], tmp);
    git(['config', 'user.name', 'Test'], tmp);
    git(['add', '-A'], tmp);
    git(['commit', '-m', 'init', '--allow-empty'], tmp);
    const sibling = createTempProject(prefix);
    cleanup(sibling); // `git worktree add` needs a path that does not exist yet
    t.after(() => cleanup(sibling)); // the worktree's git metadata lives in tmp, which afterEach removes
    git(['worktree', 'add', '--detach', sibling, 'HEAD'], tmp);
    return sibling;
  }
  test('legacy (non-bracket) roadmaps step past the 999 sentinel too', () => {
    setup(['# Roadmap', '', '## Milestone v2.0', '', '### Phase 998: Near the sentinel', ''], { convention: null });
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '1000');
    setup(['# Roadmap', '', '## Milestone v2.0', '', '### Phase 997: Near the sentinel', ''], { convention: null });
    const batch = runGsdTools(['phase', 'add-batch', '--descriptions', '["A","B"]'], tmp);
    assert.deepStrictEqual(JSON.parse(batch.output).phases.map((p) => p.phase_number), [998, 1000]);
  });

  test('a milestone-prefixed repo does not count a bracket-looking heading or bullet (gsd-core-ddu6)', () => {
    setup(['# Roadmap', '', '## Milestone v2.0', '', '- [ ] **[GSD.02] 05: Existing**', '', '### [GSD.02] 05: Existing', '', '**Goal:** x', ''], { convention: 'milestone-prefixed' });
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '01');
    assertWritten(1);
  });

  test('non-bracket repo: a bracket-looking heading is still not counted (byte-identical to before)', () => {
    setup(['# Roadmap', '', '## Milestone v2.0', '', '- [ ] **[GSD.02] 01: Existing**', '', '### [GSD.02] 01: Existing', '', '**Goal:** x', ''], { convention: null });
    const result = runGsdTools('phase add "New thing" --raw', tmp);
    assert.ok(result.success, result.error);
    assert.strictEqual(result.output.trim(), '01');
    assertWritten(1);
  });

  // #5528 acceptance criterion 4: a non-bracket repo's `Depends on` still reads the whole roadmap,
  // archived milestones included, exactly as before the bracket scoping existed.
  for (const convention of [null, 'sequential', 'milestone-prefixed']) {
    test(`non-bracket (${convention}): Depends on still names a phase from a shipped milestone block`, () => {
      const rm = ['# Roadmap', '', '## Milestone v1.0 (shipped)', '', '### Phase 4: Old', '', '## Milestone v2.0', ''];
      setup(rm, { convention, dirs: ['05-held'] });
      assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '06');
      assert.strictEqual(dependsOn(6), 'Phase 4');
      setup(rm, { convention, dirs: ['05-held'] });
      runGsdTools(['phase', 'add-batch', '--descriptions', '["A","B"]'], tmp);
      assert.deepStrictEqual([dependsOn(6), dependsOn(7)], ['Phase 4', 'Phase 6']);
    });
  }

  // Bracket repos write through the bracket writer (#4304): the project code is required, headings are
  // `[GSD.02] NN`, directories `GSD.02-NN-slug`. Allocation must count every representation of an
  // existing phase of the active milestone (heading, checklist bullet, directory, sibling worktree).
  const bracketSetup = (roadmapLines, { dirs = [] } = {}) => {
    const planning = setup(roadmapLines, { dirs });
    fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({ phase_id_convention: 'bracket', project_code: 'GSD' }));
    return planning;
  };
  const bracketDir = (n, slug = 'new-thing') => path.join(tmp, '.planning', 'phases', `GSD.02-${String(n).padStart(2, '0')}-${slug}`);
  const nn = (n) => String(n).padStart(2, '0');
  const BRACKET_ROADMAP = ['# Roadmap', '', '## [GSD.02] v2.0 - Current', ''];

  test('bracket issue repro: a bracket heading blocks reuse of its number and the new phase depends on it', () => {
    bracketSetup([...BRACKET_ROADMAP, '### [GSD.02] 01: Existing', '', '**Goal:** x', '']);
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '02');
    assert.ok(fs.existsSync(bracketDir(2)), 'phases/GSD.02-02-new-thing created');
    const analyzed = JSON.parse(runGsdTools(['roadmap', 'analyze'], tmp).output);
    assert.deepStrictEqual(analyzed.phases.map((p) => p.number).sort(), ['01', '02']);
  });

  for (const [label, lines, dirs, expected] of [
    ['a checklist bullet', ['- [ ] **[GSD.02] 05: Existing**'], [], 6],
    ['a no-checkbox bracket bullet', ['- [GSD.02] 05: Existing'], [], 6],
    ['an on-disk directory with no heading', [], ['GSD.02-04-held'], 5],
    ['a letter-suffixed bullet', ['- [ ] [GSD.02] 12A: Lettered'], [], 13],
  ]) {
    test(`bracket: ${label} blocks reuse of its number`, () => {
      bracketSetup([...BRACKET_ROADMAP, ...lines, ''], { dirs });
      assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), nn(expected));
      assert.ok(fs.existsSync(bracketDir(expected)), `GSD.02-${nn(expected)}-new-thing created`);
    });
  }

  test('bracket: a directory of another milestone does not feed the active milestone numbering', () => {
    bracketSetup(BRACKET_ROADMAP, { dirs: ['GSD.01-12-old'] });
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '01');
  });

  test('bracket: a bracket sentinel (icebox) phase reserves nothing', () => {
    bracketSetup([...BRACKET_ROADMAP, '- [ ] **[GSD.999] 07: Icebox**', ''], { dirs: ['GSD.999-07-icebox'] });
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '01');
  });

  test('bracket: a prose bullet "- [GSD.02] 2026 release notes" is not phase 2026', () => {
    bracketSetup([...BRACKET_ROADMAP, '- [GSD.02] 2026 release notes', ''], {});
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '01');
  });

  test('bracket: a legacy "- [ ] Phase 5:" bullet in a bracket roadmap reserves its number and does not crash', () => {
    bracketSetup([...BRACKET_ROADMAP, '- [ ] Phase 5: legacy bullet', '']);
    const result = runGsdTools('phase add "New thing" --raw', tmp);
    assert.ok(result.success, result.error);
    assert.strictEqual(result.output.trim(), '06');
  });

  test('bracket: a "## [GSD.02] 2 - Foundation" milestone heading reserves no phase number', () => {
    bracketSetup(['# Roadmap', '', '## [GSD.02] 2 - Foundation', '']);
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '01');
  });

  test('bracket: add-batch allocates consecutive numbers after a directory-only phase', () => {
    bracketSetup(BRACKET_ROADMAP, { dirs: ['GSD.02-04-orphan'] });
    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["A","B"]'], tmp);
    assert.ok(result.success, result.error);
    assert.deepStrictEqual(JSON.parse(result.output).phases.map((p) => p.phase_number), [5, 6]);
  });

  test('bracket: a directory held only by a sibling worktree blocks reuse of its number', (t) => {
    bracketSetup(BRACKET_ROADMAP);
    const sibling = addSiblingWorktree(t, 'gsd-5528-sibd-');
    fs.mkdirSync(path.join(sibling, '.planning', 'phases', 'GSD.02-50-elsewhere'), { recursive: true });
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '51');
  });

  test('bracket: a checklist bullet held only by a sibling worktree ROADMAP blocks reuse of its number', (t) => {
    bracketSetup(BRACKET_ROADMAP);
    const sibling = addSiblingWorktree(t, 'gsd-5528-sibb-');
    fs.writeFileSync(path.join(sibling, '.planning', 'ROADMAP.md'), [...BRACKET_ROADMAP, '- [ ] **[GSD.02] 50: Elsewhere**', ''].join('\n'));
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '51');
  });

  test('bracket: allocation steps past the 999 backlog sentinel', () => {
    bracketSetup([...BRACKET_ROADMAP, '### [GSD.02] 998: Near the sentinel', '']);
    assert.strictEqual(runGsdTools('phase add "New thing" --raw', tmp).output.trim(), '1000');
  });

  test('bracket property: whatever mix of heading, bullet and directory phases exists, the next number is max+1', () => {
    const fc = require('fast-check');
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 5 }), fc.constantFrom('heading', 'bullet', 'directory'), (nums, form) => {
        const lines = form === 'directory' ? [] : nums.map((n) => (form === 'bullet' ? `- [ ] **[GSD.02] ${nn(n)}: P${n}**` : `### [GSD.02] ${nn(n)}: P${n}`));
        const dirs = form === 'directory' ? nums.map((n) => `GSD.02-${nn(n)}-held`) : [];
        bracketSetup([...BRACKET_ROADMAP, ...lines, ''], { dirs });
        return runGsdTools('phase add "New thing" --raw', tmp).output.trim() === nn(Math.max(...nums) + 1);
      }),
      { numRuns: 20, seed: 5528 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// workstream-scoped phase allocation vs sibling git worktrees (#4225)
//
// The #3849 widening horizon (collectSiblingWorktreePhaseNums) scans each
// sibling's ROOT .planning/. A --ws allocation must instead scan the sibling's
// copy of the SAME workstream: workstream numbering is independent of the root
// roadmap (Workstream Namespacing REQ-WS-01 — workstream state is isolated in
// .planning/workstreams/{name}/), so a sibling's root-roadmap numbers must not
// leak into a workstream allocation.
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add --ws workstream-scoped allocation vs sibling git worktrees (#4225)', () => {
  const activeWorktrees = [];
  const activeDirs = [];

  function git(args, cwd) {
    return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  }

  /**
   * The #4225 topology: a committed ROOT roadmap with phases 1..rootMax (every
   * linked worktree carries it), plus workstream `wsName` whose own roadmap and
   * phases/ hold 1..wsMax.
   */
  function initWsRepo(repoDir, rootMax, wsName, wsMax) {
    const rootLines = ['# Roadmap', '', '## Milestone v1.0', ''];
    for (let i = 1; i <= rootMax; i++) {
      rootLines.push(`### Phase ${i}: root phase ${i}`, '', '**Goal:** root goal', '');
    }
    fs.mkdirSync(path.join(repoDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.planning', 'ROADMAP.md'), rootLines.join('\n') + '\n');

    const wsBase = path.join(repoDir, '.planning', 'workstreams', wsName);
    const wsLines = ['# Workstream Roadmap', '', '## Milestone v1.0', ''];
    for (let i = 1; i <= wsMax; i++) {
      wsLines.push(`### Phase ${i}: ws phase ${i}`, '', '**Goal:** ws goal', '');
    }
    fs.mkdirSync(path.join(wsBase, 'phases'), { recursive: true });
    if (wsMax > 0) {
      fs.mkdirSync(path.join(wsBase, 'phases', String(wsMax).padStart(2, '0') + '-ws-phase-' + wsMax));
    }
    fs.writeFileSync(path.join(wsBase, 'ROADMAP.md'), wsLines.join('\n') + '\n');

    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'init'], repoDir);
    return wsBase;
  }

  /** A sibling linked worktree checked out at HEAD (carries the committed root roadmap). */
  function addSiblingAtHead(repoDir) {
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-sib-'));
    git(['worktree', 'add', '--detach', worktreeDir, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir });
    return worktreeDir;
  }

  function teardown() {
    while (activeWorktrees.length) {
      const { repoDir, worktreeDir } = activeWorktrees.pop();
      try {
        git(['worktree', 'remove', '--force', worktreeDir], repoDir);
      } catch (_) { /* best-effort; cleanup() below still removes the directory */ }
      cleanup(worktreeDir);
    }
    while (activeDirs.length) cleanup(activeDirs.pop());
  }

  afterEach(teardown);

  test('phase add --ws numbers from the workstream, not the sibling root roadmaps (issue verbatim)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-main-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 39, 'ws-alpha', 2);
    addSiblingAtHead(repoDir);

    const result = runGsdTools(['query', 'phase.add', 'New workstream feature', '--ws', 'ws-alpha'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      3,
      '#4225: the workstream\'s own next number (max 2 + 1), not the root roadmap\'s 39 + 1'
    );
    assert.strictEqual(output.padded, '03');
    assert.strictEqual(
      output.directory,
      '.planning/workstreams/ws-alpha/phases/03-new-workstream-feature',
      'directory must land inside the workstream with the workstream-scoped number'
    );

    const wsRoadmap = fs.readFileSync(
      path.join(repoDir, '.planning', 'workstreams', 'ws-alpha', 'ROADMAP.md'),
      'utf-8'
    );
    assert.ok(wsRoadmap.includes('### Phase 3: New workstream feature'), 'ws roadmap entry must be Phase 3');
    assert.ok(wsRoadmap.includes('**Depends on:** Phase 2'), 'dependency must reference the in-workstream predecessor');

    // The root roadmap and root phases/ are a different numbering universe — untouched.
    const rootRoadmap = fs.readFileSync(path.join(repoDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!rootRoadmap.includes('New workstream feature'), 'root roadmap must not gain the workstream phase');
    assert.ok(
      !fs.readdirSync(path.join(repoDir, '.planning', 'phases')).some((e) => e.startsWith('40-')),
      'root phases/ must not gain a 40- directory'
    );
  });

  test('phase add --ws still skips a number held by the SAME workstream in a sibling', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-same-ws-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 39, 'ws-alpha', 2);
    const sibling = addSiblingAtHead(repoDir);

    // The sibling's ws-alpha copy holds Phase 3 (a branch that already minted it).
    const sibWsPhases = path.join(sibling, '.planning', 'workstreams', 'ws-alpha', 'phases');
    fs.mkdirSync(path.join(sibWsPhases, '03-sibling-only'), { recursive: true });
    const sibWsRoadmap = path.join(sibling, '.planning', 'workstreams', 'ws-alpha', 'ROADMAP.md');
    fs.appendFileSync(sibWsRoadmap, '\n### Phase 3: sibling-only phase\n\n**Goal:** taken\n');

    const result = runGsdTools(['query', 'phase.add', 'Contended', '--ws', 'ws-alpha'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      4,
      '#4225 keeps the #3849 widening: a number taken by the same workstream on another branch is still taken — but the sibling root roadmap\'s 39 must not decide it'
    );
  });

  test('phase add --ws numbers the FIRST phase of an empty workstream as 1', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-empty-ws-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 39, 'ws-empty', 0);
    addSiblingAtHead(repoDir);

    const result = runGsdTools(['query', 'phase.add', 'First steps', '--ws', 'ws-empty'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 1, 'an empty workstream starts at 1, not root-max+1 (40)');
    assert.strictEqual(output.padded, '01');
    assert.ok(
      fs.existsSync(path.join(repoDir, '.planning', 'workstreams', 'ws-empty', 'phases', '01-first-steps')),
      'directory should be 01-first-steps inside the workstream'
    );
  });

  test('phase add --ws at the root maximum is coincidentally equal, with an in-workstream dependency', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-ws39-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 39, 'ws-alpha', 39);
    addSiblingAtHead(repoDir);

    const result = runGsdTools(['query', 'phase.add', 'Fortieth in workstream', '--ws', 'ws-alpha'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 40, 'the workstream\'s own 39+1 — correct for its own reason');
    const wsRoadmap = fs.readFileSync(
      path.join(repoDir, '.planning', 'workstreams', 'ws-alpha', 'ROADMAP.md'),
      'utf-8'
    );
    assert.ok(
      wsRoadmap.includes('**Depends on:** Phase 39'),
      'Phase 39 dependency is legitimate here: it exists in THIS workstream'
    );
  });

  test('a sibling holding only ANOTHER workstream\'s numbers does not affect --ws allocation', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-beta-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 39, 'ws-alpha', 2);
    const sibling = addSiblingAtHead(repoDir);

    // The sibling's ws-beta (a different, independent numbering universe) is at 50.
    const betaPhases = path.join(sibling, '.planning', 'workstreams', 'ws-beta', 'phases');
    fs.mkdirSync(path.join(betaPhases, '50-beta-heavy'), { recursive: true });
    const betaRoadmap = path.join(sibling, '.planning', 'workstreams', 'ws-beta', 'ROADMAP.md');
    fs.mkdirSync(path.dirname(betaRoadmap), { recursive: true });
    fs.writeFileSync(betaRoadmap, ['# Workstream Roadmap', '', '### Phase 50: beta heavy', '', '**Goal:** beta', ''].join('\n') + '\n');

    const result = runGsdTools(['query', 'phase.add', 'Alpha next', '--ws', 'ws-alpha'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      3,
      'cross-workstream numbers (root 39 in the sibling root roadmap, ws-beta 50) are different universes — ws-alpha numbers from its own 2+1'
    );
  });

  test('a sibling without the workstream directory contributes nothing (fail open)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-no-ws-sib-'));
    activeDirs.push(repoDir);
    const wsBase = initWsRepo(repoDir, 39, 'ws-alpha', 2);
    const sibling = addSiblingAtHead(repoDir);

    // The sibling predates the workstream: its checkout has no ws-alpha at all.
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- fixture SETUP, not teardown: strips the sibling's workstreams/ so it lacks the active scope; teardown() owns the dir's removal
    fs.rmSync(path.join(sibling, '.planning', 'workstreams'), { recursive: true, force: true });

    const result = runGsdTools(['query', 'phase.add', 'Local only', '--ws', 'ws-alpha'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      3,
      'a missing workstream scope in a sibling contributes nothing — local ws sources decide'
    );
    assert.ok(fs.existsSync(path.join(wsBase, 'phases', '03-local-only')));
  });

  test('phase add-batch --ws numbers sequentially from the workstream, not the root roadmap', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-batch-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 39, 'ws-alpha', 2);
    addSiblingAtHead(repoDir);

    const result = runGsdTools(
      ['query', 'phase.add-batch', '--descriptions', '["Batch A","Batch B"]', '--ws', 'ws-alpha'],
      repoDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].phase_number, 3, '#4225: the batch allocator shares the scoped horizon');
    assert.strictEqual(output.phases[1].phase_number, 4);
  });

  test('without --ws, allocation keeps the #3849 global sibling horizon byte-for-byte', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-flat-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 440, 'ws-alpha', 2);
    const sibling = addSiblingAtHead(repoDir);

    // The sibling's ROOT roadmap holds Phase 441 (#3849's shape).
    fs.appendFileSync(
      path.join(sibling, '.planning', 'ROADMAP.md'),
      '\n### Phase 441: sibling root phase\n\n**Goal:** taken\n'
    );

    const result = runGsdTools(['query', 'phase.add', 'Flat allocation'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      442,
      'no --ws: the sibling ROOT roadmap still widens the horizon exactly as #3849 shipped'
    );
  });

  test('whitespace-only GSD_WORKSTREAM uses the root sibling horizon (#4462)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4462-blank-ws-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 2, 'ws-alpha', 39);
    addSiblingAtHead(repoDir);

    const result = runGsdTools(
      ['query', 'phase.add', 'Root next'],
      repoDir,
      { GSD_WORKSTREAM: '  ' },
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 3);
    assert.strictEqual(output.directory, '.planning/phases/03-root-next');
    assert.ok(
      !fs.existsSync(path.join(repoDir, '.planning', 'workstreams', '  ')),
      'an effectively-empty env value must not mint a whitespace-named workstream',
    );
  });

  test('phase next-decimal --ws is unaffected (planningDir-scoped already)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4225-dec-'));
    activeDirs.push(repoDir);
    initWsRepo(repoDir, 39, 'ws-alpha', 2);
    addSiblingAtHead(repoDir);

    const result = runGsdTools(['query', 'phase.next-decimal', '2', '--ws', 'ws-alpha'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '02.1', 'next-decimal was never sibling-widened; the fix must not change it');
  });
});

describe('planning threat-ID revision issues from fresh plans', () => {
  let root;
  const fragment = path.join(__dirname, '..', 'gsd-core/workflows/plan-phase/steps/threat-id-check.md');
  const importWorkflow = path.join(__dirname, '..', 'gsd-core/workflows/import.md');
  const tools = path.join(__dirname, '..', 'gsd-core/bin/gsd-tools.cjs');
  function extractScanBlock() {
    const content = fs.existsSync(fragment) ? fs.readFileSync(fragment, 'utf8') : '';
    const after = content.split('## After planning')[1] || '';
    return after.split('```bash')[1]?.split('```')[0] || '';
  }
  function extractImportCommitBlock() {
    const finalize = fs.readFileSync(importWorkflow, 'utf8').split('<step name="plan_finalize">')[1] || '';
    return finalize.split('```bash')[1]?.split('```')[0] || '';
  }
  function runScan({ workstream = '', phase = '47', cli = 'node "$GSD_TEST_TOOLS" "$@"', importCommit = false, unset = '' } = {}) {
    const script = [
      'set -u',
      `gsd_run() { if [[ "$*" == 'query commit '* ]]; then echo 'commit reached'; else ${cli}; fi; }`,
      unset,
      importCommit ? extractImportCommitBlock() : `${extractScanBlock()}\nprintf "%s" "$THREAT_ID_ISSUES"`,
    ].join('\n');
    const scriptPath = path.join(root, 'threat-scan.sh');
    fs.writeFileSync(scriptPath, script);
    const result = runHook(scriptPath, [], {
      interpreter: 'bash',
      cwd: root,
      env: { ...process.env, GSD_TEST_TOOLS: tools, PHASE: phase, GSD_WS: workstream },
      // Bash launches the CLI and the issue projection as separate Node processes.
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(result.outcome, OUTCOME.EXITED, result.stderr);
    return result;
  }
  beforeEach(() => { root = fs.realpathSync(createFixture()); });
  afterEach(() => cleanup(root));
  function plan(id) {
    return `---\nphase: 47\nplan: 01\n---\n<threat_model>\n| Threat ID | Category |\n|---|---|\n| ${id} | Tampering |\n| T-47-SC | Tampering |\n</threat_model>\n`;
  }
  function scan(options) {
    const result = runScan(options);
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  test('zero register claimants produces no revision issues', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': '# No register' });
    assert.deepEqual(scan(), []);
  });
  test('one claimant produces no revision issues', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': plan('T-47-01') });
    assert.deepEqual(scan(), []);
  });
  test('fresh scan catches a second claimant written after initialization', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': plan('T-47-01') });
    assert.deepEqual(scan(), []);
    seedPhase(root, '47-security', { '47-02-PLAN.md': plan('T-47-01') });
    const issues = scan();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'blocker');
    assert.equal(issues[0].dimension, 'threat_id_uniqueness');
    assert.equal(issues[0].plan, '47-01-PLAN.md, 47-02-PLAN.md');
    assert.match(issues[0].description, /T-47-01/);
  });
  test('distinct rows and shared reserved SC produce no revision issues', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': plan('T-47-01'), '47-02-PLAN.md': plan('T-47-02') });
    assert.deepEqual(scan(), []);
  });
  test('a workstream collision blocks revision even when the root phase is clear', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': plan('T-47-01') });
    const stream = absPlanningPath(root, 'workstreams', 'feature', 'phases', '47-security');
    fs.mkdirSync(stream, { recursive: true });
    for (const number of ['01', '02']) {
      fs.writeFileSync(path.join(stream, `47-${number}-PLAN.md`), plan('T-47-01'));
    }

    assert.deepEqual(scan(), []);
    const issues = scan({ workstream: '--ws feature' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].dimension, 'threat_id_uniqueness');
    assert.match(issues[0].required_property, /at most one live plan/);
    assert.match(issues[0].description, /T-47-01.*47-01-PLAN.*47-02-PLAN/);
  });
  test('an unresolved phase reports the missing phase and blocks planning', () => {
    const result = runScan({ phase: '99' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /threat-ID scan phase not found/);
    assert.match(result.stderr, /BLOCKED: cannot validate threat-ID scan/);
    assert.equal(result.stdout, '');
  });
  test('a failed scan blocks planning', () => {
    const result = runScan({ cli: 'return 3' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /BLOCKED: threat-ID scan failed/);
    assert.equal(result.stdout, '');
  });
  test('missing scan fields block planning', () => {
    const result = runScan({ cli: "printf '%s' '{}'" });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /BLOCKED: cannot validate threat-ID scan/);
    assert.equal(result.stdout, '');
  });
  test('an imported colliding plan cannot reach the commit boundary', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': plan('T-47-01') });
    const clear = runScan({ importCommit: true });
    assert.equal(clear.exitCode, 0, clear.stderr);
    assert.match(clear.stdout, /^commit reached/m);
    seedPhase(root, '47-security', { '47-02-PLAN.md': plan('T-47-01') });

    const result = runScan({ importCommit: true });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /BLOCKED: imported plan threat-ID scan did not clear.*T-47-01/);
    assert.equal(result.stdout, '');
  });
  for (const [variable, message] of [
    ['PHASE', /needs a phase/],
    ['GSD_WS', /needs explicit workstream scope/],
  ]) {
    test(`a missing ${variable} binding blocks the scan`, () => {
      const result = runScan({ unset: `unset ${variable}`, cli: `printf '%s' '{"phase_found":true,"threat_id_duplicates":[],"threat_id_duplicate_count":0}'` });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, message);
      assert.equal(result.stdout, '');
    });
  }
  for (const [name, duplicates, count] of [
    ['a mismatched count', [], 1],
    ['an invalid ID', [{ id: 47, plans: ['01', '02'] }], 1],
    ['a single reported claimant', [{ id: 'T-47-01', plans: ['01'] }], 1],
  ]) {
    test(`scan validation rejects ${name}`, () => {
      const payload = JSON.stringify({ phase_found: true, threat_id_duplicates: duplicates, threat_id_duplicate_count: count });
      const result = runScan({ cli: `printf '%s' '${payload}'` });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /BLOCKED: cannot validate threat-ID scan/);
    });
  }
  test('import commit fence embeds the same threat-ID scan block as threat-id-check.md', () => {
    const scanBlock = extractScanBlock().trim();
    const commitBlock = extractImportCommitBlock();
    assert.ok(scanBlock.length > 0, 'threat-id-check.md scan block must be present');
    assert.ok(commitBlock.includes(scanBlock), 'import.md plan_finalize commit fence must embed the canonical scan block');
  });
  test('collision threshold preserves every claimant across generated plan sets', () => {
    const fc = require('fast-check');
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 9 }), { minLength: 3, maxLength: 3 }), planIds => {
      for (const [index, planId] of planIds.entries()) {
        seedPhase(root, '47-security', { [`47-0${planId}-PLAN.md`]: plan('T-47-01') });
        const issues = scan();
        if (index === 0) assert.deepEqual(issues, []);
        else {
          assert.equal(issues.length, 1);
          assert.equal(issues[0].plan, planIds.slice(0, index + 1).map(id => `47-0${id}-PLAN.md`).sort().join(', '));
        }
      }
      for (const id of planIds) fs.unlinkSync(absPlanningPath(root, 'phases', '47-security', `47-0${id}-PLAN.md`));
    }), { numRuns: 10, seed: 5995 });
  });
  test('file-backed scan data uses the same validation as inline data', () => {
    const payload = '{"phase_found":true,"threat_id_duplicates":[],"threat_id_duplicate_count":0}';
    fs.writeFileSync(path.join(root, 'scan.json'), payload);
    const options = { cli: "printf '%s' '@file:scan.json'" };
    assert.deepEqual(scan(options), []);

    fs.unlinkSync(path.join(root, 'scan.json'));
    const result = runScan(options);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /BLOCKED: cannot read threat-ID scan payload/);
  });
});
