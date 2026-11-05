// allow-test-rule: source-text-is-the-product see #4455
// Workflow .md files — their text IS what the runtime loads. Testing text
// content (as extracted, executed bash fences) tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - autonomous.md and complete-milestone.md workstream-scoped
 * STATE/ROADMAP/archive paths (#4455)
 *
 * Both workflows used to read/write hardcoded literal `.planning/STATE.md` /
 * `.planning/ROADMAP.md` / `.planning/milestones/...` paths in their shell
 * fences — bypassing workstream scoping entirely. When GSD_WORKSTREAM is set,
 * `init.manager`/`init.complete-milestone` resolve `state_path`/`roadmap_path`/
 * `archive_dir` into the workstream, but the literal reads/writes still hit
 * root `.planning/` (or silently returned empty).
 *
 * These tests extract the real bash fences from the workflow files and
 * execute them (with a stubbed `gsd_run`) rather than string-matching the
 * markdown — the same idiom tests/new-milestone-clear-phases.test.cjs uses.
 *
 * One file (not two) per scripts/lint-test-file-count.cjs's per-module cap —
 * tests/workstream.test.cjs already owns the "workstream" module name, so
 * this is the second and last slot; the two workflows are kept apart via
 * top-level describe blocks instead of separate files.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { cleanup } = require('./helpers.cjs');

/** Return the raw text of every ```bash fenced block in `text`. */
function extractBashBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    if ((block.infoString || '').trim() !== 'bash') continue;
    blocks.push(lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n'));
  }
  return blocks;
}

// Locate the first ```bash fence strictly between two boundary strings.
function extractFenceBetween(markdown, startMarker, endMarker) {
  const startIdx = markdown.indexOf(startMarker);
  const endIdx = markdown.indexOf(endMarker);
  assert.ok(startIdx !== -1, `marker not found: ${startMarker}`);
  assert.ok(endIdx !== -1, `marker not found: ${endMarker}`);
  assert.ok(startIdx < endIdx, `${startMarker} must precede ${endMarker}`);
  const section = markdown.slice(startIdx, endIdx);
  const bashBlocks = extractBashBlocks(section);
  assert.ok(bashBlocks.length > 0, `no bash fence found between "${startMarker}" and "${endMarker}"`);
  return bashBlocks[0];
}

// Locate the ```bash fence containing `marker`, between two boundary strings.
function extractFenceContaining(markdown, startMarker, endMarker, marker) {
  const startIdx = markdown.indexOf(startMarker);
  const endIdx = markdown.indexOf(endMarker);
  assert.ok(startIdx !== -1 && endIdx !== -1 && startIdx < endIdx, 'boundary markers not found in order');
  const section = markdown.slice(startIdx, endIdx);
  for (const block of extractBashBlocks(section)) {
    if (block.includes(marker)) return block;
  }
  assert.fail(`no bash fence containing "${marker}" found between "${startMarker}" and "${endMarker}"`);
  return null;
}

describe('autonomous.md workstream-scoped paths (#4455)', () => {
  const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md');
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  const discoverPhasesFence = extractFenceBetween(content, '## 2. Discover Phases', '## 3. Execute Phase');
  const iterateFence = extractFenceBetween(content, '## 4. Iterate', '## 5. Lifecycle');
  const lifecycle5bFence = extractFenceContaining(content, '## 5. Lifecycle', '## 6. Handle Blocker', 'ARCHIVE_DIR');

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-autonomous-ws-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * Write a canned init.manager-shaped JSON payload and a gsd_run stub that
   * returns it verbatim. Each call also appends one byte to a call-log file
   * — NOT a shell variable increment, because `INIT_MANAGER=$(gsd_run ...)`
   * runs gsd_run inside the command-substitution SUBSHELL, so a variable
   * mutated there never survives back into the caller's shell.
   */
  function stubGsdRun(jsonPayload) {
    const jsonPath = path.join(tmpDir, 'init-manager.json');
    const callLogPath = path.join(tmpDir, 'gsd-run-calls.log');
    fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload));
    fs.writeFileSync(callLogPath, '');
    return `gsd_run() { printf 'x' >> "${callLogPath}"; cat "${jsonPath}"; }\n`;
  }

  /** Number of gsd_run invocations recorded by the most recent stubGsdRun-backed script. */
  function gsdRunCallCount() {
    return fs.readFileSync(path.join(tmpDir, 'gsd-run-calls.log'), 'utf8').length;
  }

  describe('discover_phases step: reads STATE.md from init.manager state_path, not a hardcoded literal', () => {
    test('flat mode: no GSD_WORKSTREAM — resolves the root STATE.md path (regression guard)', () => {
      const statePath = path.join(tmpDir, 'STATE-root.md');
      fs.writeFileSync(statePath, '# Root State\n');
      const script = `${stubGsdRun({ state_path: statePath })}${discoverPhasesFence}\nprintf 'STATE_CONTENT=[%s]\\n' "$STATE_CONTENT"`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <discover_phases fence>');
      assert.ok(r.stdout.includes('STATE_CONTENT=[# Root State'),
        `expected root STATE.md content, got: ${r.stdout}`);
    });

    test('GSD_WORKSTREAM=alpha: reads the workstream-scoped STATE.md, not the root one (#4455 regression)', () => {
      const rootStatePath = path.join(tmpDir, 'STATE-root.md');
      fs.writeFileSync(rootStatePath, '# Root State — must not be read\n');
      const wsStatePath = path.join(tmpDir, 'STATE-alpha.md');
      fs.writeFileSync(wsStatePath, '# Workstream Alpha State\n');

      const script = `${stubGsdRun({ state_path: wsStatePath })}${discoverPhasesFence}\nprintf 'STATE_CONTENT=[%s]\\n' "$STATE_CONTENT"`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <discover_phases fence>');
      assert.ok(r.stdout.includes('STATE_CONTENT=[# Workstream Alpha State'),
        `expected workstream STATE.md content, got: ${r.stdout}`);
      assert.ok(!r.stdout.includes('Root State'),
        `must not have read the root STATE.md, got: ${r.stdout}`);
    });
  });

  describe('iterate step: single init.manager fetch backs both the re-filter and the fresh re-read', () => {
    test('flat mode: resolves the root STATE.md path (regression guard)', () => {
      const statePath = path.join(tmpDir, 'STATE-root.md');
      fs.writeFileSync(statePath, '# Root State\n');
      const script = `${stubGsdRun({ state_path: statePath })}${iterateFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <iterate fence>');
      // The fence's own `cat "$STATE_PATH"` line prints the raw re-read to stdout.
      assert.ok(r.stdout.includes('# Root State'), `expected root STATE.md content, got: ${r.stdout}`);
    });

    test('GSD_WORKSTREAM=alpha: re-reads the workstream STATE.md, not root (#4455 regression)', () => {
      const rootStatePath = path.join(tmpDir, 'STATE-root.md');
      fs.writeFileSync(rootStatePath, '# Root State — must not be read\n');
      const wsStatePath = path.join(tmpDir, 'STATE-alpha.md');
      fs.writeFileSync(wsStatePath, '# Workstream Alpha State\n');

      const script = `${stubGsdRun({ state_path: wsStatePath })}${iterateFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <iterate fence>');
      assert.ok(r.stdout.includes('# Workstream Alpha State'),
        `expected workstream STATE.md content, got: ${r.stdout}`);
      assert.ok(!r.stdout.includes('Root State'),
        `must not have read the root STATE.md, got: ${r.stdout}`);
    });

    test('does not double-fetch init.manager within the iterate fence (no-double-fetch requirement)', () => {
      const statePath = path.join(tmpDir, 'STATE-root.md');
      fs.writeFileSync(statePath, '# Root State\n');
      const script = `${stubGsdRun({ state_path: statePath })}${iterateFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <iterate fence>');
      assert.strictEqual(gsdRunCallCount(), 1,
        `iterate fence must call gsd_run exactly once (no double-fetch), got ${gsdRunCallCount()}; stdout: ${r.stdout}`);
    });
  });

  describe('lifecycle step 5b: archive existence check uses init.manager archive_dir, not a hardcoded literal', () => {
    test('flat mode: checks the root milestones/ archive dir (regression guard)', () => {
      const archiveDir = path.join(tmpDir, 'milestones-root');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, 'v1.0-ROADMAP.md'), '# Archived Roadmap\n');

      const script = `milestone_version="1.0"\n${stubGsdRun({ archive_dir: archiveDir })}${lifecycle5bFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <lifecycle 5b fence>');
      // The fence concatenates with a literal bash `/` ("${ARCHIVE_DIR}/v...-ROADMAP.md"),
      // never path.join — on Windows that yields a MIXED-separator path (backslashes
      // from archiveDir + one trailing `/`), which path.join's all-backslash output
      // does not match. Mirror the fence's own concatenation instead (#4455 CI finding).
      assert.ok(r.stdout.includes(`${archiveDir}/v1.0-ROADMAP.md`),
        `expected ls to find the root archive file, got: ${r.stdout}`);
    });

    test('GSD_WORKSTREAM=alpha: checks the workstream-scoped archive dir, not root (#4455 regression)', () => {
      const rootArchiveDir = path.join(tmpDir, 'milestones-root');
      fs.mkdirSync(rootArchiveDir, { recursive: true });
      fs.writeFileSync(path.join(rootArchiveDir, 'v1.0-ROADMAP.md'), '# Root Archived Roadmap — must not be found\n');

      const wsArchiveDir = path.join(tmpDir, 'milestones-alpha');
      fs.mkdirSync(wsArchiveDir, { recursive: true });
      fs.writeFileSync(path.join(wsArchiveDir, 'v1.0-ROADMAP.md'), '# Workstream Archived Roadmap\n');

      const script = `milestone_version="1.0"\n${stubGsdRun({ archive_dir: wsArchiveDir })}${lifecycle5bFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <lifecycle 5b fence>');
      // See the flat-mode test above for why this is a literal `/` join, not path.join.
      assert.ok(r.stdout.includes(`${wsArchiveDir}/v1.0-ROADMAP.md`),
        `expected ls to find the workstream archive file, got: ${r.stdout}`);
      assert.ok(!r.stdout.includes(rootArchiveDir),
        `must not have checked the root archive dir, got: ${r.stdout}`);
    });
  });
});

describe('complete-milestone.md workstream-scoped paths (#4455)', () => {
  const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md');
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  const STEP_START = '<step name="reorganize_roadmap_and_delete_originals">';
  const STEP_END = '<step name="write_retrospective">';

  const backlogFence = extractFenceContaining(content, STEP_START, STEP_END, 'BACKLOG_SECTION');
  const sentinelFence = extractFenceContaining(content, STEP_START, STEP_END, '.gsd-allow-shrink');
  const commitFilesFence = extractFenceContaining(content, STEP_START, STEP_END, 'gsd_run query commit');
  const requirementsRmFence = extractFenceContaining(content, STEP_START, STEP_END, 'git rm');

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-complete-milestone-ws-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * Write a canned init.complete-milestone-shaped JSON payload and a gsd_run
   * stub that returns it for the `query init.complete-milestone` fetch, and
   * echoes `gsd_run_call:<argv>` for every OTHER call (e.g. `query commit
   * ...`) — the same recording-stub idiom tests/new-milestone-clear-phases.
   * test.cjs uses, so the commit `--files` list can be asserted on directly.
   */
  function stubGsdRun(jsonPayload) {
    const jsonPath = path.join(tmpDir, 'init-cm.json');
    fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload));
    return `gsd_run() { if [ "$1" = "query" ] && [ "$2" = "init.complete-milestone" ]; then cat "${jsonPath}"; else printf 'gsd_run_call:%s\\n' "$*"; fi; }\n`;
  }

  describe('backlog extraction: reads ROADMAP.md from init.complete-milestone roadmap_path', () => {
    test('flat mode: no GSD_WORKSTREAM — resolves the root ROADMAP.md path (regression guard)', () => {
      const roadmapPath = path.join(tmpDir, 'ROADMAP-root.md');
      fs.writeFileSync(roadmapPath, '# Roadmap\n\n## Backlog\n\n- 999.1 Root backlog item\n');
      const script = `${stubGsdRun({ roadmap_path: roadmapPath })}${backlogFence}\nprintf 'BACKLOG=[%s]\\n' "$BACKLOG_SECTION"`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <backlog fence>');
      assert.ok(r.stdout.includes('Root backlog item'),
        `expected root ROADMAP.md backlog content, got: ${r.stdout}`);
    });

    test('GSD_WORKSTREAM=alpha: reads the workstream-scoped ROADMAP.md, not root (#4455 regression)', () => {
      const rootRoadmapPath = path.join(tmpDir, 'ROADMAP-root.md');
      fs.writeFileSync(rootRoadmapPath, '# Roadmap\n\n## Backlog\n\n- 999.1 Root backlog item — must not be read\n');
      const wsRoadmapPath = path.join(tmpDir, 'ROADMAP-alpha.md');
      fs.writeFileSync(wsRoadmapPath, '# Roadmap\n\n## Backlog\n\n- 999.1 Workstream Alpha backlog item\n');

      const script = `${stubGsdRun({ roadmap_path: wsRoadmapPath })}${backlogFence}\nprintf 'BACKLOG=[%s]\\n' "$BACKLOG_SECTION"`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <backlog fence>');
      assert.ok(r.stdout.includes('Workstream Alpha backlog item'),
        `expected workstream ROADMAP.md backlog content, got: ${r.stdout}`);
      assert.ok(!r.stdout.includes('Root backlog item'),
        `must not have read the root ROADMAP.md, got: ${r.stdout}`);
    });
  });

  describe('write-guard sentinel: arms with init.complete-milestone roadmap_path', () => {
    test('flat mode: sentinel names the root ROADMAP.md path (regression guard)', () => {
      const roadmapPath = path.join(tmpDir, 'ROADMAP-root.md');
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      const script = `${stubGsdRun({ roadmap_path: roadmapPath })}${sentinelFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <sentinel fence>');
      const sentinelContent = fs.readFileSync(path.join(tmpDir, '.planning', '.gsd-allow-shrink'), 'utf8').trim();
      assert.strictEqual(sentinelContent, roadmapPath);
    });

    test('GSD_WORKSTREAM=alpha: sentinel names the workstream ROADMAP.md, not root (#4455 regression)', () => {
      const wsRoadmapPath = path.join(tmpDir, 'ROADMAP-alpha.md');
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      const script = `${stubGsdRun({ roadmap_path: wsRoadmapPath })}${sentinelFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <sentinel fence>');
      const sentinelContent = fs.readFileSync(path.join(tmpDir, '.planning', '.gsd-allow-shrink'), 'utf8').trim();
      assert.strictEqual(sentinelContent, wsRoadmapPath);
      assert.notStrictEqual(sentinelContent, path.join(tmpDir, '.planning', 'ROADMAP.md'));
    });
  });

  describe('safety commit --files list: STATE/ROADMAP/archive/MILESTONES/PROJECT paths all scoped together', () => {
    function runCommitFence(cmJson) {
      const script = `${stubGsdRun(cmJson)}${commitFilesFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <commit --files fence>');
      return r.stdout;
    }

    test('flat mode: --files lists root STATE/ROADMAP/archive/MILESTONES/PROJECT paths (regression guard)', () => {
      const statePath = path.join(tmpDir, 'STATE-root.md');
      const roadmapPath = path.join(tmpDir, 'ROADMAP-root.md');
      const archiveDir = path.join(tmpDir, 'milestones-root');
      const milestonesPath = path.join(tmpDir, 'MILESTONES-root.md');
      const projectPath = path.join(tmpDir, 'PROJECT-root.md');
      const out = runCommitFence({
        state_path: statePath, roadmap_path: roadmapPath, archive_dir: archiveDir,
        milestones_path: milestonesPath, project_path: projectPath,
      });

      assert.ok(out.includes('gsd_run_call:query commit'), `expected the commit call to be recorded, got: ${out}`);
      assert.ok(out.includes(statePath), `expected root STATE.md in --files, got: ${out}`);
      assert.ok(out.includes(roadmapPath), `expected root ROADMAP.md in --files, got: ${out}`);
      assert.ok(out.includes(`${archiveDir}/v[X.Y]-ROADMAP.md`), `expected root archive ROADMAP in --files, got: ${out}`);
      assert.ok(out.includes(milestonesPath), `expected root MILESTONES.md in --files, got: ${out}`);
      assert.ok(out.includes(projectPath), `expected root PROJECT.md in --files, got: ${out}`);
    });

    test('GSD_WORKSTREAM=alpha: --files lists workstream-scoped STATE/ROADMAP/archive/MILESTONES paths, but PROJECT.md STAYS root (#4455 regression)', () => {
      const wsStatePath = path.join(tmpDir, 'STATE-alpha.md');
      const wsRoadmapPath = path.join(tmpDir, 'ROADMAP-alpha.md');
      const wsArchiveDir = path.join(tmpDir, 'milestones-alpha');
      const wsMilestonesPath = path.join(tmpDir, 'MILESTONES-alpha.md');
      // PROJECT.md is genuinely SHARED across workstreams — never cloned per
      // workstream (gsd-core/references/workstream-flag.md marks it
      // `# Shared`; new-milestone.md states it outright; cmdWorkstreamCreate
      // never creates one under a workstream dir). The real
      // cmdInitCompleteMilestone therefore ALWAYS returns the root path for
      // project_path regardless of GSD_WORKSTREAM — reflected here by
      // passing the SAME root-shaped value the flat-mode test above uses,
      // not a workstream-shaped one. An earlier version of this fix wrongly
      // pinned MILESTONES.md and PROJECT.md as identically workstream-scoped
      // (caught by isolated code review, then re-caught as a genuine
      // regression after merge — see tests/init-manager.test.cjs's
      // "milestones_path/project_path/requirements_path" describe block for
      // the test that exercises the real init.cts function, not just this
      // fence-mechanics stub).
      const rootProjectPath = path.join(tmpDir, 'PROJECT-root.md');
      const out = runCommitFence({
        state_path: wsStatePath, roadmap_path: wsRoadmapPath, archive_dir: wsArchiveDir,
        milestones_path: wsMilestonesPath, project_path: rootProjectPath,
      });

      assert.ok(out.includes(wsStatePath), `expected workstream STATE.md in --files, got: ${out}`);
      assert.ok(out.includes(wsRoadmapPath), `expected workstream ROADMAP.md in --files, got: ${out}`);
      assert.ok(out.includes(`${wsArchiveDir}/v[X.Y]-ROADMAP.md`), `expected workstream archive ROADMAP in --files, got: ${out}`);
      assert.ok(out.includes(wsMilestonesPath), `expected workstream MILESTONES.md in --files, got: ${out}`);
      assert.ok(out.includes(rootProjectPath), `expected root PROJECT.md in --files, got: ${out}`);
      assert.ok(!out.includes(path.join(tmpDir, '.planning', 'STATE.md')),
        `must not fall back to the flat root STATE.md path, got: ${out}`);
      assert.ok(!out.includes(path.join(tmpDir, '.planning', 'ROADMAP.md')),
        `must not fall back to the flat root ROADMAP.md path, got: ${out}`);
      assert.ok(!out.includes(path.join(tmpDir, '.planning', 'MILESTONES.md')),
        `must not fall back to the flat root MILESTONES.md path, got: ${out}`);
    });
  });

  describe('REQUIREMENTS.md removal: git rm uses init.complete-milestone requirements_path, not a hardcoded literal', () => {
    test('flat mode: removes the root REQUIREMENTS.md path (regression guard)', () => {
      const requirementsPath = path.join(tmpDir, 'REQUIREMENTS-root.md');
      fs.writeFileSync(requirementsPath, '# Requirements\n');
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true }); // git rm needs a repo; the stub below intercepts it
      const script = `git() { printf 'git_call:%s\\n' "$*"; }\n${stubGsdRun({ requirements_path: requirementsPath })}${requirementsRmFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <requirements rm fence>');
      assert.ok(r.stdout.includes(`git_call:rm ${requirementsPath}`),
        `expected git rm to target the root REQUIREMENTS.md, got: ${r.stdout}`);
    });

    test('GSD_WORKSTREAM=alpha: removes the workstream-scoped REQUIREMENTS.md, not root (#4455 follow-up regression)', () => {
      const wsRequirementsPath = path.join(tmpDir, 'REQUIREMENTS-alpha.md');
      fs.writeFileSync(wsRequirementsPath, '# Requirements\n');
      const script = `git() { printf 'git_call:%s\\n' "$*"; }\n${stubGsdRun({ requirements_path: wsRequirementsPath })}${requirementsRmFence}`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir });
      throwIfFailed(r, 'bash <requirements rm fence>');
      assert.ok(r.stdout.includes(`git_call:rm ${wsRequirementsPath}`),
        `expected git rm to target the workstream REQUIREMENTS.md, got: ${r.stdout}`);
      assert.ok(!r.stdout.includes('git_call:rm .planning/REQUIREMENTS.md'),
        `must not have targeted the literal root REQUIREMENTS.md path, got: ${r.stdout}`);
    });
  });
});

// ─── #5861: every shell fence names scoped planning artifacts through resolved paths ───
//
// The two describes above pin two workflows (#4455). The same class recurs wherever a
// ```bash fence names a root literal for an artifact that belongs to one project or
// workstream (`.planning/STATE.md`, `.planning/phases/`, `.planning/config.json`, ...):
// under GSD_PROJECT or a workstream that line reads, writes or commits the ROOT
// project's file while every gsd-tools verb resolves the scoped one (planningDir, the
// init `*_path` / `*_dir` fields, `config-path --raw` and its directory for globs).
// Fences run verbatim (or steer the agent verbatim), so
// this scans every fence the runtime ships rather than pinning one file at a time.
describe('shell fences name scoped planning artifacts through resolved paths (#5861)', () => {
  const ROOT = path.resolve(__dirname, '..');
  // Artifacts owned by one project or workstream, plus the four shared root artifacts (HANDOFF.json,
  // the root .continue-here.md, RETROSPECTIVE.md, reports/MILESTONE_SUMMARY): those stay one .planning/
  // copy for every scope, so each fence line naming one is allowlisted (SHARED_WHY) and a new one is a
  // deliberate choice rather than a silent root literal. Repo-level directories (todos, debug, seeds,
  // threads, ...) are not listed. codebase/ and intel/ are NOT repo-level: init's codebase_dir
  // and intel_dir resolve under the selected planning directory (#3964), yet some fences still
  // name `.planning/codebase` / `.planning/intel` literally (map-codebase's commit among them).
  // That is a known gap left out of this scan's scope (a follow-up), not a design choice.
  const SCOPED = /\.planning\/(research\b|ROADMAP\.md|STATE\.md|REQUIREMENTS\.md|PROJECT\.md|config\.json|phases\b|MILESTONES\.md|milestones\b|quick\b|HANDOFF\.json|\.continue-here|v[^/\s`]*-MILESTONE-AUDIT\.md|INGEST-CONFLICTS\.md|DECISIONS-INDEX\.md|RETROSPECTIVE\.md|reports\/MILESTONE_SUMMARY)/;
  const DIRS = ['gsd-core/workflows', 'gsd-core/references', 'gsd-core/templates', 'gsd-core/contexts', 'agents', 'commands/gsd', 'capabilities'];
  // bash, sh, shell, or the z-prefixed sh.
  const SHELL_INFO = /^(bash|z?sh|shell)\b/;

  const PR_BRANCH_WHY = 'pr-branch.md classifies commit paths with drift-guarded mirrors of src/pr-branch-patterns.cts (scripts/lint-pr-branch-pattern-drift.cjs), which describe the root planning layout. Widening them to nested scopes is a change to the pattern module, its drift guard and the cherry-pick recipe tests, not to this fence.';
  const SYNTH_WHY = '#5859 owns the research synthesizer write/commit targets (it needs a scoped research_dir passed in the spawn prompt); changing these lines here would collide with that fix.';
  const ROADMAPPER_WHY = '#5859 owns the roadmapper write targets and their write-guard sentinel; changing these lines here would collide with that fix.';
  const SHARED_WHY = 'Shared root copy per the #5861 triage (per-scope placement is a maintainer decision): HANDOFF.json, the root .continue-here.md, RETROSPECTIVE.md and reports/MILESTONE_SUMMARY stay one .planning/ copy for every project and workstream, and their writers and readers name that copy.';
  // Each entry: { file, match, why }. An entry that no longer suppresses an offending line
  // is stale and fails the second test, so the list only shrinks.
  const ALLOW = [
    { file: 'gsd-core/workflows/pr-branch.md', match: /^# and `\.planning\/STATE\.md\.bak` are NOT treated as structural/, why: PR_BRANCH_WHY },
    { file: 'gsd-core/workflows/pr-branch.md', match: /^# alternative matches only FILES directly under `\.planning\/milestones\/`/, why: PR_BRANCH_WHY },
    { file: 'gsd-core/workflows/pr-branch.md', match: /^STRUCTURAL_RE="\^\\\.planning\/\(STATE\|ROADMAP/, why: PR_BRANCH_WHY },
    { file: 'gsd-core/workflows/pr-branch.md', match: /^# passed at least one milestone: `\.planning\/milestones\/<milestone>-phases\/`/, why: PR_BRANCH_WHY },
    { file: 'gsd-core/workflows/pr-branch.md', match: /^MILESTONE_PHASES_RE="\^\\\.planning\/milestones\//, why: PR_BRANCH_WHY },
    { file: 'gsd-core/workflows/pr-branch.md', match: /^\s*# milestones yet \(`\.planning\/milestones\/` absent\)/, why: PR_BRANCH_WHY },
    { file: 'gsd-core/workflows/pr-branch.md', match: /^\s*# `\.planning\/milestones\/`\), not just the expected-absent case/, why: PR_BRANCH_WHY },
    { file: 'gsd-core/workflows/pr-branch.md', match: /^\s*MILESTONE_PHASE_DIRS=\$\(find \.planning\/milestones -mindepth 1/, why: PR_BRANCH_WHY },
    { file: 'agents/gsd-research-synthesizer.md', match: /^cat \.planning\/research\/(STACK|FEATURES|ARCHITECTURE|PITFALLS)\.md$/, why: SYNTH_WHY },
    { file: 'agents/gsd-research-synthesizer.md', match: /--files \.planning\/research\/$/, why: SYNTH_WHY },
    { file: 'agents/gsd-research-synthesizer.compact.md', match: /^cat \.planning\/research\/(STACK|FEATURES|ARCHITECTURE|PITFALLS)\.md$/, why: SYNTH_WHY },
    { file: 'agents/gsd-research-synthesizer.compact.md', match: /--files \.planning\/research\/$/, why: SYNTH_WHY },
    { file: 'agents/gsd-roadmapper.md', match: /^\s*\[ -f \.planning\/(ROADMAP|STATE)\.md \] && printf '\.planning\/(ROADMAP|STATE)\.md\\n' > \.planning\/\.gsd-allow-shrink$/, why: ROADMAPPER_WHY },
    { file: 'gsd-core/workflows/new-project.md', match: /^gsd_run query commit "docs: create roadmap \(\[N\] phases\)" --files \.planning\/ROADMAP\.md /, why: '#5859 owns the new-project roadmap commit, which must commit the files the roadmapper writes; it changes together with the roadmapper targets.' },
    { file: 'gsd-core/workflows/new-milestone/steps/reset-phase-safety.md', match: /^find \.planning\/phases -mindepth 1 -maxdepth 1 -type d -exec mv/, why: '#5860 owns reset-phase-safety (the phase archive move needs its own guard and test).' },
    { file: 'gsd-core/workflows/pause-work.md', match: /^gsd_run query commit "docs\(pause\): \[context-name\] paused at \[X\]\/\[Y\]" --files \[handoff-path\] \.planning\/HANDOFF\.json$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/resume-project.md', match: /^cat \.planning\/HANDOFF\.json 2>\/dev\/null \|\| true$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/resume-project.md', match: /^#\s+dropping every pattern after it, including `\.planning\/\.continue-here\*\.md` \(#3689\);$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/resume-project.md', match: /^for f in \.planning\/\.continue-here\*\.md \\$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/next.md', match: /^\[ -f \.planning\/\.continue-here\.md \]$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/progress/steps/forensic-audit.md', match: /^ls \.planning\/HANDOFF\.json "\$PLANNING_DIR"\/phases\/\*\/\.continue-here\.md "\$PLANNING_DIR"\/phases\/\*\/\*HANDOFF\*\.md 2>\/dev\/null \|\| true$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/complete-milestone.md', match: /^ls \.planning\/RETROSPECTIVE\.md 2>\/dev\/null \|\| true$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/complete-milestone.md', match: /^gsd_run query commit "docs: update retrospective for v\$\{VERSION\}" --files \.planning\/RETROSPECTIVE\.md$/, why: SHARED_WHY },
    { file: 'agents/gsd-planner.md', match: /^cat \.planning\/RETROSPECTIVE\.md 2>\/dev\/null \| tail -100$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/milestone-summary.md', match: /^\s+"\.planning\/reports\/MILESTONE_SUMMARY-v\$\{VERSION\}\.md"$/, why: SHARED_WHY },
    { file: 'gsd-core/workflows/milestone-summary.md', match: /^\s+--resume-file "\.planning\/reports\/MILESTONE_SUMMARY-v\$\{VERSION\}\.md"$/, why: SHARED_WHY },
  ];

  function walkMd(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walkMd(p);
      return e.name.endsWith('.md') ? [p] : [];
    });
  }

  /**
   * The [start, end) line ranges of the shell fences' bodies. Lines are dedented first: a fence nested in a
   * list item sits 4+ spaces deep, past the 3 spaces scanFencedBlocks accepts, yet the agent still runs it
   * (commands/gsd/review-backlog.md, ship.md, docs-update.md, quick-batch/steps/merge-wave.md).
   */
  function shellBlocks(lines) {
    return scanFencedBlocks(lines.map((l) => l.replace(/^[ \t]+/, '')))
      .filter((block) => SHELL_INFO.test((block.infoString || '').trim()))
      .map((block) => [block.openLineIdx + 1, block.closeLineIdx === -1 ? lines.length : block.closeLineIdx]);
  }

  /** Per-line flags: true when the line sits inside a fence whose info string matches SHELL_INFO. */
  function shellLineMask(lines) {
    const mask = new Array(lines.length).fill(false);
    for (const [start, end] of shellBlocks(lines)) {
      for (let i = start; i < end; i++) mask[i] = true;
    }
    return mask;
  }

  const FILES = DIRS.flatMap((d) => walkMd(path.join(ROOT, d)))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();
  const readLines = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);

  function scan() {
    const offenders = [];
    const used = new Set();
    for (const file of FILES) {
      const lines = readLines(file);
      const mask = shellLineMask(lines);
      lines.forEach((line, i) => {
        if (!mask[i] || !SCOPED.test(line)) return;
        const hit = ALLOW.findIndex((a) => a.file === file && a.match.test(line));
        if (hit !== -1) { used.add(hit); return; }
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    return { offenders, used };
  }

  const result = scan();

  test('no shell fence names a root .planning/<scoped artifact> literally', () => {
    assert.deepStrictEqual(result.offenders, [],
      `${result.offenders.length} shell-fence line(s) name a root planning artifact. Use the init *_path/*_dir field, ` +
      '`gsd_run query config-path --raw`, or its directory: `PLANNING_DIR=$(gsd_run query config-path ${GSD_WS:+--ws=${GSD_WS##* }} --raw) && ' +
      'PLANNING_DIR=${PLANNING_DIR%/config.json}` instead.');
  });

  test('a shell fence nested 4+ spaces deep in a list item is scanned too', () => {
    const nested = ['1. step:', '     ```bash', '     cat .planning/STATE.md', '     ```', 'prose'];
    assert.deepStrictEqual(shellLineMask(nested), [false, false, true, false, false]);
  });

  test('every allowlist entry still suppresses a fence line and says why (no stale exceptions)', () => {
    const stale = ALLOW.filter((_, i) => !result.used.has(i)).map((a) => `${a.file} ${a.match}`);
    assert.deepStrictEqual(stale, [], 'stale allowlist entries: remove them');
    for (const a of ALLOW) assert.ok(typeof a.why === 'string' && a.why.length > 20, `allowlist entry needs a why: ${a.file} ${a.match}`);
  });

  // An init path placeholder ({phase_dir}, {state_path}, {roadmap_path}, ... — every `{…_path}` / `{…_dir}`)
  // is an ABSOLUTE path once the agent substitutes it, so a fence must double-quote it as upstream does
  // ("{phase_dir}/{plan_padded}-SUMMARY.md"). Bare, it splits at a space in the project path (a 3-task plan
  // counted 0 tasks, a SUMMARY commit staged two halves of a path); single-quoted, an apostrophe breaks
  // the line. The lexer carries quote state across a fence's lines, so a prompt body held in a multi-line
  // single-quoted assignment is text, not a shell word; heredoc bodies and comments are skipped too.
  const PATH_PLACEHOLDER = /\{[a-z][a-z0-9_]*_(?:path|dir)\}/y;
  const PRE_EXISTING_WHY = 'Pre-existing on next (3730c6704) in a fence #5861 does not touch; quoting it is a separate change.';
  const QUOTE_ALLOW = [
    { file: 'agents/gsd-code-fixer.md', match: /^cat \{review_path\}$/, why: PRE_EXISTING_WHY },
    { file: 'agents/gsd-debug-session-manager.md', match: /--files \{debug_file_path\}$/, why: PRE_EXISTING_WHY },
    { file: 'agents/gsd-debug-session-manager.compact.md', match: /--files \{debug_file_path\}$/, why: PRE_EXISTING_WHY },
    { file: 'gsd-core/workflows/review.md', match: /--files \{phase_dir\}\/\{padded_phase\}-REVIEWS\.md$/, why: PRE_EXISTING_WHY },
  ];

  /** Placeholders a shell fence body ([start, end) of `lines`) leaves outside double quotes. */
  function unquotedPlaceholders(lines, start, end) {
    const hits = [];
    let st = 'n'; // n: bare, s: single-quoted, d: double-quoted
    let singleOpenedOn = -1;
    const subst = []; // open $( … ): the quote state to return to, and the nested ( depth
    let heredoc = null;
    for (let i = start; i < end; i++) {
      const line = lines[i];
      if (heredoc) {
        if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.tag) heredoc = null;
        continue;
      }
      let pending = null;
      for (let j = 0; j < line.length; j++) {
        const c = line[j];
        if (st === 's') {
          if (c === "'") st = 'n';
          else if (c === '{' && singleOpenedOn === i && line.indexOf("'", j) !== -1) {
            PATH_PLACEHOLDER.lastIndex = j;
            const m = PATH_PLACEHOLDER.exec(line);
            if (m) { hits.push({ line: i, token: m[0], quote: 'single' }); j += m[0].length - 1; }
          }
          continue;
        }
        if (c === '\\') { j++; continue; }
        if (c === '$' && line[j + 1] === '(') { subst.push({ ret: st, depth: 0 }); st = 'n'; j++; continue; }
        if (st === 'd') { if (c === '"') st = 'n'; continue; }
        // st === 'n'
        if (c === '#' && (j === 0 || /\s/.test(line[j - 1]))) break;
        if (c === "'") { st = 's'; singleOpenedOn = i; continue; }
        if (c === '"') { st = 'd'; continue; }
        if (subst.length && c === '(') { subst[subst.length - 1].depth++; continue; }
        if (subst.length && c === ')') {
          const top = subst[subst.length - 1];
          if (top.depth > 0) top.depth--; else st = subst.pop().ret;
          continue;
        }
        if (c === '<' && line.startsWith('<<<', j)) { j += 2; continue; }
        if (c === '<' && line[j + 1] === '<') {
          const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(j));
          if (m) { pending = { strip: m[1] === '-', tag: m[3] }; j += m[0].length - 1; }
          continue;
        }
        if (c === '{' && line[j - 1] !== '$') {
          PATH_PLACEHOLDER.lastIndex = j;
          const m = PATH_PLACEHOLDER.exec(line);
          if (m) { hits.push({ line: i, token: m[0], quote: 'none' }); j += m[0].length - 1; }
        }
      }
      if (pending) heredoc = pending;
    }
    return hits;
  }

  function scanQuoting() {
    const offenders = [];
    const used = new Set();
    for (const file of FILES) {
      const lines = readLines(file);
      for (const [start, end] of shellBlocks(lines)) {
        for (const h of unquotedPlaceholders(lines, start, end)) {
          const line = lines[h.line];
          const hit = QUOTE_ALLOW.findIndex((a) => a.file === file && a.match.test(line.trim()));
          if (hit !== -1) { used.add(hit); continue; }
          offenders.push(`${file}:${h.line + 1}: ${h.token} (${h.quote === 'single' ? 'single-quoted' : 'unquoted'}): ${line.trim()}`);
        }
      }
    }
    return { offenders, used };
  }

  test('no shell fence leaves an init path placeholder outside double quotes', () => {
    const { offenders, used } = scanQuoting();
    assert.deepStrictEqual(offenders, [],
      `${offenders.length} placeholder(s) left bare or single-quoted. Init paths are absolute: write "{phase_dir}/<file>", ` +
      '"{state_path}", "{phase_dir}"/*-PLAN.md.');
    const stale = QUOTE_ALLOW.filter((_, i) => !used.has(i)).map((a) => `${a.file} ${a.match}`);
    assert.deepStrictEqual(stale, [], 'stale quoting allowlist entries: remove them');
  });

  test('the quoting lexer: bare and single-quoted placeholders are caught; quoted ones, prompt bodies, heredocs and comments are not', () => {
    const run = (text) => { const ls = text.split('\n'); return unquotedPlaceholders(ls, 0, ls.length).map((h) => `${h.line}:${h.token}:${h.quote}`); };
    assert.deepStrictEqual(run('cat {phase_dir}/{phase}-PLAN.md'), ['0:{phase_dir}:none']);
    assert.deepStrictEqual(run("D='{phase_dir}'"), ['0:{phase_dir}:single']);
    assert.deepStrictEqual(run('X="$(dirname {state_path})"'), ['0:{state_path}:none'], 'a command substitution resets the quoting');
    assert.deepStrictEqual(run([
      'cat "{phase_dir}/{phase}-PLAN.md" "{state_path}"', 'ls "{phase_dir}"/*-PLAN.md', 'X=$(dirname "{state_path}")',
      'echo ${STATE_FILE:+"$STATE_FILE"} # {state_path} in a comment', "P='<objective>", '- {phase_dir}/{plan_file} (Plan)', "'",
      "cat <<'EOF'", '{roadmap_path}', 'EOF', 'Y=${phase_dir}/x',
    ].join('\n')), []);
  });

  // resume-project.md's discovery glob was three levels below the ROOT .planning, so a named project's
  // phases/<dir>/ checkpoint (four levels down) was never found, and the root scan listed other scopes'
  // checkpoints as the root's. HANDOFF.json and the root .continue-here.md stay one shared root copy for
  // every scope (#5861 triage). Run the shipped fence with the real gsd-tools against both layouts.
  describe('resume-project check_incomplete_work: the shared root handoff plus the selected scope\'s phase checkpoints', () => {
    const { TOOLS_PATH } = require('./helpers.cjs');
    const md = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'resume-project.md'), 'utf8');
    const fence = extractFenceBetween(md, '<step name="check_incomplete_work">', '<step name="present_status">');
    let tmpDir;

    beforeEach(() => {
      // "PLAN" in the directory name: the plan-to-summary rewrite must touch only the file suffix.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resume-PLAN-scope-'));
      for (const rel of [
        '.planning/.continue-here.md',
        '.planning/phases/01-r/.continue-here.md', '.planning/phases/01-r/01-01-PLAN.md', '.planning/phases/01-r/01-01-SUMMARY.md',
        '.planning/beta/STATE.md',
        '.planning/beta/phases/01-x/.continue-here.md', '.planning/beta/phases/01-x/01-01-PLAN.md',
        '.planning/workstreams/ws1/phases/01-w/.continue-here.md',
      ]) {
        fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, rel), '# fixture\n');
      }
      fs.writeFileSync(path.join(tmpDir, '.planning', 'HANDOFF.json'), '{"handoff":"shared-root"}\n');
    });
    afterEach(() => cleanup(tmpDir));

    const run = (env) => {
      const script = `gsd_run() { node "${TOOLS_PATH}" "$@"; }\n${fence}`;
      const r = runHookSeam('-c', [script], {
        interpreter: 'bash', cwd: tmpDir,
        env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, GSD_WORKSTREAM: '', GSD_PROJECT: '', has_interrupted_agent: 'false', ...env },
      });
      throwIfFailed(r, 'bash <check_incomplete_work fence>');
      return r.stdout;
    };

    test('GSD_PROJECT=beta: reads the shared root handoff and lists beta\'s phase checkpoint, not the root project\'s', () => {
      const out = run({ GSD_PROJECT: 'beta' });
      assert.match(out, /"handoff":"shared-root"/, `the one root HANDOFF.json is read under every scope: ${out}`);
      assert.match(out, /^\.planning\/\.continue-here\.md$/m, `the one root .continue-here.md is listed under every scope: ${out}`);
      assert.match(out, /\.planning\/beta\/phases\/01-x\/\.continue-here\.md/, out);
      assert.match(out, /Incomplete: .*\.planning\/beta\/phases\/01-x\/01-01-PLAN\.md/, out);
      assert.doesNotMatch(out, /\.planning\/phases\/01-r\//, out);
      assert.doesNotMatch(out, /\.planning\/workstreams\//, out);
    });

    test('root project (no scope): the shared root handoff and its own phase checkpoint, never another project\'s or workstream\'s', () => {
      const out = run({});
      assert.match(out, /"handoff":"shared-root"/, out);
      assert.match(out, /^\.planning\/\.continue-here\.md$/m, out);
      assert.match(out, /\.planning\/phases\/01-r\/\.continue-here\.md/, out);
      assert.doesNotMatch(out, /\.planning\/beta\//, out);
      assert.doesNotMatch(out, /\.planning\/workstreams\//, out);
      assert.doesNotMatch(out, /Incomplete: .*01-r\/01-01-PLAN\.md/, 'a plan with its SUMMARY is complete even with PLAN in the path');
    });

    // The query unable to run (no gsd_run in this shell, #4805): the root layout, unless a scope is named.
    const runWithoutTools = (env) => runHookSeam('-c', [`gsd_run() { return 127; }\n${fence}`], {
      interpreter: 'bash', cwd: tmpDir,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, GSD_WORKSTREAM: '', GSD_PROJECT: '', has_interrupted_agent: 'false', ...env },
    });

    test('the query unable to run with no scope named: the root layout is scanned', () => {
      const r = runWithoutTools({});
      throwIfFailed(r, 'bash <check_incomplete_work fence, no gsd_run>');
      assert.match(r.stdout, /^\.planning\/phases\/01-r\/\.continue-here\.md$/m, r.stdout);
    });

    test('the query unable to run under GSD_PROJECT=beta: stops, never listing the root project\'s checkpoints as beta\'s', () => {
      const r = runWithoutTools({ GSD_PROJECT: 'beta' });
      assert.notStrictEqual(r.exitCode, 0, r.stdout);
      assert.match(r.stderr, /planning directory not resolved for this scope/, r.stderr);
      assert.doesNotMatch(r.stdout, /01-r/, r.stdout);
    });
  });

  // The triage's behavioral case. Under GSD_PROJECT=beta, discuss-phase's update_state fence records the
  // session (state.record-session writes beta's STATE.md) and commits. The commit used to name the root
  // .planning/STATE.md, so it committed nothing and left beta's STATE.md modified. Run the shipped fence
  // with the real gsd-tools in a git repo holding a root project and a named project.
  describe('discuss-phase update_state under GSD_PROJECT=beta commits the scoped STATE.md', () => {
    const { TOOLS_PATH } = require('./helpers.cjs');
    const { gitOrThrow } = require('./helpers/git-fixture.cjs');
    const md = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'discuss-phase.md'), 'utf8');
    // $ARGUMENTS is what the runtime substitutes with the command's arguments: here the phase number.
    const fence = extractFenceBetween(md, '<step name="update_state">', '<step name="auto_advance">').replace('$ARGUMENTS', '1');
    const ROOT_STATE = '# STATE Alpha\n';
    let repo;
    let home;
    const git = (...args) => gitOrThrow(args, { cwd: repo });

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-discuss-beta-'));
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-discuss-home-'));
      for (const [dir, name, mode] of [['.planning', 'Alpha', 'interactive'], ['.planning/beta', 'Beta', 'yolo']]) {
        fs.mkdirSync(path.join(repo, dir, 'phases', '01-x'), { recursive: true });
        for (const doc of ['PROJECT', 'REQUIREMENTS', 'ROADMAP', 'STATE']) {
          fs.writeFileSync(path.join(repo, dir, `${doc}.md`), `# ${doc} ${name}\n`);
        }
        fs.writeFileSync(path.join(repo, dir, 'config.json'), `${JSON.stringify({ mode })}\n`);
      }
      git('init', '-q');
      git('config', 'user.email', 't@example.invalid');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-qm', 'init');
    });
    afterEach(() => { cleanup(repo); cleanup(home); });

    test('records the session in beta\'s STATE.md and commits it: clean tree, root STATE.md untouched', () => {
      const script = [
        `gsd_run() { node "${TOOLS_PATH}" "$@"; }`,
        'PHASE=1', 'padded_phase=01',
        'phase_dir=$(gsd_run query init.phase-op "${PHASE}" --pick phase_dir)',
        fence,
      ].join('\n');
      const r = runHookSeam('-c', [script], {
        interpreter: 'bash', cwd: repo,
        env: { ...process.env, HOME: home, USERPROFILE: home, GSD_WORKSTREAM: '', GSD_PROJECT: 'beta' },
      });
      throwIfFailed(r, 'bash <discuss-phase update_state fence>');
      assert.strictEqual(git('status', '--porcelain', '--untracked-files=all'), '',
        `no modified or untracked planning files may be left behind; fence output: ${r.stdout}`);
      assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'docs(state): record phase 1 context session');
      assert.deepStrictEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim().split('\n'),
        ['.planning/beta/STATE.md'], 'the commit holds beta\'s STATE.md and nothing else');
      assert.strictEqual(fs.readFileSync(path.join(repo, '.planning', 'STATE.md'), 'utf8'), ROOT_STATE);
    });
  });

  // Root (flat) behavior must not change. The post-wave tracking commit takes state_path from init.execute-phase,
  // which is null when STATE.md is absent (a supported state: execute-phase continues on state_exists false), and
  // `--pick` prints it as an empty string. Passed as an empty pathspec, it failed the whole commit (staging_failed,
  // exit 0) and left the ROADMAP progress uncommitted, where the root literal it replaced was simply skipped.
  // Run the shipped fence with the real gsd-tools in a flat repo without STATE.md.
  describe('execute-phase post-wave tracking: a flat project without STATE.md still commits its ROADMAP progress', () => {
    const { TOOLS_PATH } = require('./helpers.cjs');
    const { gitOrThrow } = require('./helpers/git-fixture.cjs');
    const md = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8');
    const fence = extractBashBlocks(md).find((b) => b.includes('update tracking after wave'));
    const hasJq = runHookSeam('-c', ['command -v jq'], { interpreter: 'bash' }).exitCode === 0;
    let repo;
    let home;
    const git = (...args) => gitOrThrow(args, { cwd: repo });

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-postwave-flat-'));
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-postwave-home-'));
      const phase = path.join(repo, '.planning', 'phases', '01-x');
      fs.mkdirSync(phase, { recursive: true });
      fs.writeFileSync(path.join(repo, '.planning', 'ROADMAP.md'), [
        '# Roadmap', '', '### Phase 1: X', '', '**Goal:** g', '', '**Plans:** 2 plans', '', 'Plans:', '',
        '- [ ] 01-01-PLAN.md — one', '- [ ] 01-02-PLAN.md — two', '',
      ].join('\n'));
      fs.writeFileSync(path.join(repo, '.planning', 'config.json'), '{"commit_docs":true}\n');
      for (const f of ['01-01-PLAN.md', '01-02-PLAN.md', '01-01-SUMMARY.md']) fs.writeFileSync(path.join(phase, f), `# ${f}\n`);
      git('init', '-q');
      git('config', 'user.email', 't@example.invalid');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-qm', 'init');
    });
    afterEach(() => { cleanup(repo); cleanup(home); });

    test('the ROADMAP update is committed and nothing is left behind', { skip: !hasJq && 'the fence needs jq' }, () => {
      assert.ok(fence, 'execute-phase.md post-wave tracking fence not found');
      const script = [
        `gsd_run() { node "${TOOLS_PATH}" "$@"; }`,
        'TEST_EXIT=0; PHASE_NUMBER=1; N=1',
        fence.replace('$ARGUMENTS', '1').replace('{completed_plan_ids}', '01'),
      ].join('\n');
      const r = runHookSeam('-c', [script], {
        interpreter: 'bash', cwd: repo,
        env: { ...process.env, HOME: home, USERPROFILE: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' },
      });
      throwIfFailed(r, 'bash <execute-phase post-wave tracking fence>');
      assert.strictEqual(git('status', '--porcelain', '--untracked-files=all'), '', `fence output: ${r.stdout}`);
      assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'docs(phase-1): update tracking after wave 1');
      assert.deepStrictEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim().split('\n'), ['.planning/ROADMAP.md']);
    });
  });

  // The fences that glob take their planning directory from `config-path --raw`, which resolves the scope and
  // validates nothing else. planning.inspect, used here before, runs a full verification inspection and exits 1
  // with no output when any phase's VERIFICATION.md carries a legacy status (pending, partial, pass_with_caveats),
  // so these fences aborted in a plain flat project that worked on next. Run two of them verbatim with the real
  // gsd-tools in a flat project whose old phase 01 still has `status: pending`.
  describe('a flat project whose old phase has a legacy VERIFICATION status still runs the migrated fences', () => {
    const { TOOLS_PATH } = require('./helpers.cjs');
    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let repo;
    let home;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-legacy-verification-'));
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-legacy-home-'));
      for (const [rel, body] of [
        ['.planning/phases/01-x/01-VERIFICATION.md', '---\nstatus: pending\n---\n# Verification\n'],
        ['.planning/phases/01-x/01-01-SUMMARY.md', '# summary\n'],
        ['.planning/phases/02-y/02-01-PLAN.md', '# plan\n'],
        ['.planning/phases/02-y/02-01-SUMMARY.md', '# summary\n'],
        ['.planning/ROADMAP.md', '# Roadmap\n'], ['.planning/STATE.md', '# State\n'], ['.planning/config.json', '{}\n'],
      ]) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
      }
    });
    afterEach(() => { cleanup(repo); cleanup(home); });

    // $ARGUMENTS is what the runtime substitutes with the command's arguments: none here.
    const run = (fence, label) => {
      const r = runHookSeam('-c', [`gsd_run() { node "${TOOLS_PATH}" "$@"; }\n${fence.replace('$ARGUMENTS', '')}`], {
        interpreter: 'bash', cwd: repo,
        env: { ...process.env, HOME: home, USERPROFILE: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' },
      });
      throwIfFailed(r, `bash <${label}>`);
      return r.stdout;
    };

    test('transition verify_completion lists the current phase\'s plans and summaries', () => {
      const fence = extractFenceBetween(read('gsd-core/workflows/transition.md'), '<step name="verify_completion">', '**Verification logic:**');
      const out = run(fence.replace(/XX-current/g, '02-y'), 'transition verify_completion');
      assert.match(out, /\/\.planning\/phases\/02-y\/02-01-PLAN\.md$/m, out);
      assert.match(out, /\/\.planning\/phases\/02-y\/02-01-SUMMARY\.md$/m, out);
    });

    test('cleanup archives a completed milestone\'s phase directory into milestones/', () => {
      const blocks = extractBashBlocks(read('gsd-core/workflows/cleanup.md'));
      const mkdir = blocks.find((b) => b.includes('mkdir -p "$PLANNING_DIR/milestones/v{X.Y}-phases"'));
      const mv = blocks.find((b) => b.includes('mv "$PLANNING_DIR/phases/{dir}"'));
      assert.ok(mkdir && mv, 'cleanup.md archive fences not found');
      run(mkdir.replace(/\{X\.Y\}/g, '1.0'), 'cleanup archive mkdir');
      run(mv.replace(/\{X\.Y\}/g, '1.0').replace('{dir}', '01-x'), 'cleanup archive mv');
      assert.ok(fs.existsSync(path.join(repo, '.planning', 'milestones', 'v1.0-phases', '01-x', '01-VERIFICATION.md')));
      assert.ok(!fs.existsSync(path.join(repo, '.planning', 'phases', '01-x')));
    });

    // config-path prints the same forward-slash path as the init `config_path` field (toPosixPath, a no-op off
    // Windows), so the fences take its directory with ${PLANNING_DIR%/config.json}: no separator rewriting in sh,
    // which would also mangle a backslash that is part of a POSIX directory name.
    test('config-path prints the same path as init config_path, so fences and init fields agree on every platform', () => {
      const { TOOLS_PATH: TOOLS } = require('./helpers.cjs');
      fs.mkdirSync(path.join(repo, '.planning', 'beta'), { recursive: true });
      fs.mkdirSync(path.join(repo, '.planning', 'workstreams', 'ws1'), { recursive: true });
      const env = { ...process.env, HOME: home, USERPROFILE: home, GSD_PROJECT: '', GSD_WORKSTREAM: '' };
      for (const [label, args, extra] of [['root', [], {}], ['GSD_PROJECT=beta', [], { GSD_PROJECT: 'beta' }], ['--ws ws1', ['--ws', 'ws1'], {}]]) {
        const cli = (a) => runHookSeam(TOOLS, a, { interpreter: process.execPath, cwd: repo, env: { ...env, ...extra } });
        const cp = cli(['query', 'config-path', ...args, '--raw']);
        const init = cli(['query', 'init.new-project', ...args, '--pick', 'config_path']);
        throwIfFailed(cp, `config-path (${label})`); throwIfFailed(init, `init.new-project (${label})`);
        assert.strictEqual(cp.stdout.trim(), init.stdout.trim(), `${label}: config-path must print init's config_path`);
        assert.ok(!cp.stdout.includes('\\'), `${label}: config-path must print forward slashes`);
      }
    });

    test('the resolver line keeps the directory of config-path intact, including a backslash in a POSIX name', () => {
      const fence = extractFenceBetween(read('gsd-core/workflows/transition.md'), '<step name="verify_completion">', '**Verification logic:**');
      const line = fence.split('\n').find((l) => l.startsWith('PLANNING_DIR=$(gsd_run query config-path'));
      assert.ok(line, 'resolver line not found in transition verify_completion');
      for (const [printed, want] of [['/r/a\\b/.planning/beta/config.json', '/r/a\\b/.planning/beta'], ['C:/r a/.planning/beta/config.json', 'C:/r a/.planning/beta']]) {
        const r = runHookSeam('-c', [`gsd_run() { printf '%s\\n' '${printed}'; }\n${line}\necho "$PLANNING_DIR"`],
          { interpreter: 'bash', cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home } });
        throwIfFailed(r, 'bash <resolver line>');
        assert.strictEqual(r.stdout.trim(), want);
      }
    });

    test('no shell fence resolves a planning path through planning.inspect (it validates unrelated state)', () => {
      const hits = [];
      for (const file of FILES) {
        if (file === 'gsd-core/workflows/undo.md') continue; // upstream's own use, not a #5861 resolver
        const lines = readLines(file);
        for (const [start, end] of shellBlocks(lines)) {
          for (let i = start; i < end; i++) {
            if (/planning[. ]inspect\b/.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
      assert.deepStrictEqual(hits, [], 'use the directory of `gsd_run query config-path --raw` instead');
    });
  });

  // regression-gate.md picks the prior phases' VERIFICATION.md files under this scope's phases/. The selection
  // stays the root project's rule (a path below phases/ containing the phase number is excluded), and the
  // checkout path, which here contains the phase number, never takes part in it.
  test('regression-gate selects the same prior VERIFICATION.md files as the root rule, whatever the checkout path', () => {
    const fence = extractFenceBetween(fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'regression-gate.md'), 'utf8'),
      '**Step 1: Discover prior phases\' test files**', '**Step 2: Extract test file lists from prior verifications**');
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gate-01-')));
    try {
      for (const d of ['01-a', '01.1-hotfix', '02-b', '10-c', '11-d']) {
        fs.mkdirSync(path.join(repo, '.planning', 'phases', d), { recursive: true });
        fs.writeFileSync(path.join(repo, '.planning', 'phases', d, `${d.split('-')[0]}-VERIFICATION.md`), '# v\n');
      }
      const phaseDir = `${repo}/.planning/phases/01-a`.split(path.sep).join('/');
      const r = runHookSeam('-c', [`${fence.replace('{phase_dir}', phaseDir)}\nprintf '%s\\n' "$PRIOR_VERIFICATIONS"`], {
        interpreter: 'bash', cwd: repo, env: { ...process.env, HOME: repo, USERPROFILE: repo, PHASE_NUMBER: '01' },
      });
      throwIfFailed(r, 'bash <regression-gate step 1>');
      const picked = r.stdout.split('\n').filter(Boolean).map((f) => f.replace(/^.*\/\.planning\/phases\//, '')).sort();
      assert.deepStrictEqual(picked, ['02-b/02-VERIFICATION.md', '10-c/10-VERIFICATION.md', '11-d/11-VERIFICATION.md']);
    } finally {
      cleanup(repo);
    }
  });

  // audit-milestone hands the integration checker `{phase_dirs}`. It used to define none (phases.list prints bare
  // directory names), so the checker's export map looped over nothing. Step 1 now prints full phase directory
  // paths, one per line; the checker reads them line by line, quoted, and falls back to this scope's phases/*/
  // when none are passed. The repo path holds a space: an unquoted or word-split loop would lose every SUMMARY.
  describe('audit-milestone step 1 feeds the integration checker full phase directory paths', () => {
    const { TOOLS_PATH } = require('./helpers.cjs');
    const audit = extractFenceBetween(fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'audit-milestone.md'), 'utf8'),
      '## 1. Determine Milestone Scope', '## 2. Read All Phase Verifications');
    const checker = extractFenceBetween(fs.readFileSync(path.join(ROOT, 'agents', 'gsd-integration-checker.md'), 'utf8'),
      '**From SUMMARYs, extract:**', '**Build provides/consumes map:**');
    let repo;
    let home;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd checker '));
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-checker-home-'));
      for (const [rel, body] of [
        ['.planning/phases/01-x/01-01-SUMMARY.md', '# Summary\n\n## Key Files\n- src/a.ts\n'],
        ['.planning/phases/02-y/02-01-SUMMARY.md', '# Summary\n\n## Provides\n- getUser\n'],
        ['.planning/ROADMAP.md', '# Roadmap\n'], ['.planning/config.json', '{}\n'],
      ]) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
      }
    });
    afterEach(() => { cleanup(repo); cleanup(home); });

    // The checker's fence carries the runtime launcher: RUNTIME_DIR points it at this checkout's gsd-tools.
    const run = (fence, label) => {
      const r = runHookSeam('-c', [`gsd_run() { node "${TOOLS_PATH}" "$@"; }\n${fence}`], {
        interpreter: 'bash', cwd: repo,
        env: { ...process.env, HOME: home, USERPROFILE: home, GSD_WORKSTREAM: '', GSD_PROJECT: '', RUNTIME_DIR: ROOT, CLAUDE_ENV_FILE: '' },
      });
      throwIfFailed(r, `bash <${label}>`);
      return r.stdout;
    };
    const assertMap = (out) => {
      assert.match(out, /^=== .*\/\.planning\/phases\/01-x\/01-01-SUMMARY\.md ===$/m, out);
      assert.match(out, /^- src\/a\.ts$/m, out);
      assert.match(out, /^- getUser$/m, out);
    };

    test('the step-1 paths, passed as {phase_dirs}, give a non-empty export map', () => {
      const phaseDirs = run(audit.replace('$ARGUMENTS', ''), 'audit-milestone step 1').split('\n')
        .filter((l) => l && !l.startsWith('PLANNING_DIR='));
      assert.deepStrictEqual(phaseDirs, ['01-x', '02-y'].map((d) => path.join(fs.realpathSync(repo), '.planning', 'phases', d)));
      assertMap(run(checker.replace('{phase_dirs}', phaseDirs.join('\n')), 'integration checker Step 1'));
    });

    test('with no phase directories passed, the checker globs this scope\'s phases', () => {
      assertMap(run(checker.replace('{phase_dirs}', ''), 'integration checker Step 1 (fallback)'));
    });
  });
});
