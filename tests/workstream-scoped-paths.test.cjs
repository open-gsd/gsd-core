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
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
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

// ─── #5861: no root `.planning/<artifact>` literal in a shipped shell fence ────
//
// gsd-tools scopes every artifact path through `planningDir()` (named project
// `.planning/<project>`, workstream `.planning/workstreams/<ws>`). A shell fence
// that names `.planning/STATE.md`, `.planning/phases/...` etc. bypasses that and
// reads or commits the root project's files under a named project / workstream.
// Fences take the scoped path from the init `*_path` / `*_dir` fields,
// `config-path --raw` or `planning.inspect --pick generated_from.planning_root`.
// A literal that is genuinely root-only (a shared artifact, a mirror of the
// root-layout patterns) is allowlisted below with its reason; an entry that no
// longer matches a fence line fails as stale.
describe('shell fences name no root .planning/ artifact literal (#5861)', () => {
  const REPO_ROOT = path.join(__dirname, '..');
  const SCAN_DIRS = [
    path.join('gsd-core', 'workflows'),
    path.join('gsd-core', 'references'),
    path.join('gsd-core', 'templates'),
    path.join('gsd-core', 'contexts'),
    'agents',
    path.join('commands', 'gsd'),
    'capabilities',
  ];
  const SHELL_FENCES = new Set(['bash', 'sh', 'shell', 'zsh']);
  const ROOT_LITERAL = new RegExp(
    '\\.planning/(?:STATE\\.md|ROADMAP\\.md|REQUIREMENTS\\.md|PROJECT\\.md|config\\.json|phases|quick|research|' +
    'MILESTONES\\.md|milestones|INGEST-CONFLICTS\\.md|DECISIONS-INDEX\\.md|HANDOFF\\.json|\\.continue-here|' +
    'RETROSPECTIVE\\.md|reports|v[^/\\s]*MILESTONE-AUDIT)',
  );

  /** `{file, match, why}`: `match` is tested against the offending fence line of `file`. */
  const SHARED = 'a shared root artifact: no code resolves a per-scope copy, so every scope uses the one root file (moving it is a placement decision, not a fence fix)';
  const ALLOWLIST = [
    { file: 'gsd-core/workflows/complete-milestone.md', match: /\.planning\/RETROSPECTIVE\.md/, why: `RETROSPECTIVE.md is ${SHARED}` },
    { file: 'agents/gsd-planner.md', match: /\.planning\/RETROSPECTIVE\.md/, why: `RETROSPECTIVE.md is ${SHARED}` },
    { file: 'gsd-core/workflows/milestone-summary.md', match: /\.planning\/reports/, why: `reports/MILESTONE_SUMMARY is ${SHARED}` },
    { file: 'gsd-core/workflows/milestone-summary.md', match: /\.planning\/RETROSPECTIVE\.md/, why: `RETROSPECTIVE.md is ${SHARED}` },
    { file: 'gsd-core/workflows/session-report.md', match: /\.planning\/reports/, why: `reports/SESSION_REPORT is ${SHARED}` },
    { file: 'gsd-core/workflows/next.md', match: /\.planning\/\.continue-here\.md/, why: `the root .continue-here.md is ${SHARED}` },
    { file: 'gsd-core/workflows/resume-project.md', match: /\.planning\/\.continue-here/, why: `the root .continue-here*.md is ${SHARED}` },
    { file: 'gsd-core/workflows/resume-project.md', match: /\.planning\/HANDOFF\.json/, why: `HANDOFF.json is ${SHARED}` },
    {
      file: 'gsd-core/workflows/pr-branch.md',
      match: /^\s*#|STRUCTURAL_RE=|MILESTONE_PHASES_RE=|MILESTONE_PHASE_DIRS=/,
      why: 'mirrors the drift-guarded root-layout patterns in src/pr-branch-patterns.cts, which classify repo paths rather than read an artifact',
    },
  ];

  function markdownFiles(dir) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...markdownFiles(rel));
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
    return out;
  }

  /** Every shell-fence line (`{file, lineNo, text}`) that names a root artifact literal. */
  function rootLiteralLines() {
    const hits = [];
    for (const rel of SCAN_DIRS.flatMap(markdownFiles)) {
      const lines = splitLines(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      for (const block of scanFencedBlocks(lines)) {
        if (block.closeLineIdx === -1) continue;
        if (!SHELL_FENCES.has((block.infoString || '').trim())) continue;
        for (let i = block.openLineIdx + 1; i < block.closeLineIdx; i += 1) {
          if (ROOT_LITERAL.test(lines[i])) hits.push({ file: rel.split(path.sep).join('/'), lineNo: i + 1, text: lines[i] });
        }
      }
    }
    return hits;
  }

  const allowed = (hit) => ALLOWLIST.some((a) => a.file === hit.file && a.match.test(hit.text));

  test('every root-literal fence line is allowlisted with a reason', () => {
    const offenders = rootLiteralLines().filter((h) => !allowed(h));
    assert.deepEqual(
      offenders.map((h) => `${h.file}:${h.lineNo}  ${h.text.trim()}`),
      [],
      'shell fences must resolve artifact paths through the init *_path/*_dir fields, `config-path --raw` or ' +
      '`planning.inspect --pick generated_from.planning_root`, never a root `.planning/<artifact>` literal',
    );
  });

  describe('discuss-phase fences run against the real gsd-tools (the #5861 repro)', () => {
    const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
    const discussContent = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core', 'workflows', 'discuss-phase.md'), 'utf8');
    const readFence = extractFenceContaining(discussContent, 'Read project-level and prior phase context', 'Read at most **3**', 'PROJECT_PATH');
    const updateStateFence = extractFenceContaining(discussContent, '<step name="update_state">', '<step name="auto_advance">', 'state.record-session');
    let repo;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fence-scope-'));
    });
    afterEach(() => {
      cleanup(repo);
    });

    function git(args) {
      const r = runHookSeam('-c', [`git ${args}`], { interpreter: 'bash', cwd: repo });
      throwIfFailed(r, `git ${args}`);
      return r.stdout;
    }

    function seed(dir, label) {
      fs.mkdirSync(path.join(repo, dir, 'phases', '01-x'), { recursive: true });
      for (const name of ['PROJECT', 'REQUIREMENTS', 'STATE', 'ROADMAP']) {
        fs.writeFileSync(path.join(repo, dir, `${name}.md`), `# ${name} ${label}\n`);
      }
      fs.writeFileSync(path.join(repo, dir, 'config.json'), '{"mode":"yolo"}\n');
    }

    function setUpRepo(scopedDir, label) {
      git('init -q');
      git('config user.email t@example.invalid');
      git('config user.name t');
      seed('.planning', 'Root');
      if (scopedDir) seed(scopedDir, label);
      git('add -A');
      git('commit -qm init');
    }

    function runFence(fence, env) {
      const prelude = `gsd_run() { node "${GSD_TOOLS}" "$@" 2>/dev/null; }\nPHASE=1; padded_phase=01; phase_dir=.planning/phases/01-x\n`;
      const r = runHookSeam('-c', [prelude + fence], {
        interpreter: 'bash',
        cwd: repo,
        env: { ...process.env, GSD_SESSION_KEY: 'fence-scope', ...env },
      });
      throwIfFailed(r, 'bash <discuss-phase fence>');
      return r.stdout;
    }

    test('flat root project: the update_state fence commits the root STATE.md (behavior unchanged)', () => {
      setUpRepo(null);
      const out = runFence(readFence, {});
      assert.ok(out.includes('# STATE Root'), `expected the root STATE.md, got: ${out}`);
      runFence(updateStateFence, {});
      assert.equal(git('status --short').trim(), '', 'the root tracking commit leaves a clean tree');
      assert.ok(git('log -1 --name-only --format=%s').includes('.planning/STATE.md'));
    });

    test('GSD_PROJECT=beta: reads the project files and commits the project STATE.md', () => {
      setUpRepo('.planning/beta', 'Beta');
      const out = runFence(readFence, { GSD_PROJECT: 'beta' });
      assert.ok(out.includes('# STATE Beta') && out.includes('# REQUIREMENTS Beta') && out.includes('# PROJECT Beta'),
        `expected the beta project files, got: ${out}`);
      assert.ok(!out.includes('Root'), `must not read any root project file, got: ${out}`);
      runFence(updateStateFence, { GSD_PROJECT: 'beta' });
      assert.equal(git('status --short').trim(), '', 'the scoped tracking commit leaves a clean tree');
      assert.ok(git('log -1 --name-only --format=%s').includes('.planning/beta/STATE.md'));
    });

    test('settings.md config fence: GSD_PROJECT=beta resolves the project config.json, flat resolves the root one', () => {
      const settingsContent = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core', 'workflows', 'settings.md'), 'utf8');
      const settingsFence = extractFenceContaining(settingsContent, '<step name="ensure_and_load_config">', '<step name="read_current">', 'GSD_CONFIG_PATH');
      const tail = settingsFence.slice(settingsFence.indexOf('if [[ -z "${GSD_CONFIG_PATH:-}" ]]; then'));
      setUpRepo('.planning/beta', 'Beta');
      const echoed = `${tail}\nprintf 'CFG=[%s]\\n' "$GSD_CONFIG_PATH"`;
      const beta = runFence(echoed, { GSD_PROJECT: 'beta' });
      assert.ok(beta.includes(`${path.join('.planning', 'beta', 'config.json')}]`), `expected the beta config.json, got: ${beta}`);
      const flat = runFence(echoed, {});
      assert.ok(flat.includes(`${path.join('.planning', 'config.json')}]`) && !flat.includes('beta'), `expected the root config.json, got: ${flat}`);
    });

    test('regression-gate: a phase number that appears in the repo path does not exclude every prior VERIFICATION.md', () => {
      const gateContent = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'regression-gate.md'), 'utf8');
      const gateFence = extractBashBlocks(gateContent).find((b) => b.includes('PRIOR_VERIFICATIONS='));
      assert.ok(gateFence, 'regression-gate.md has a PRIOR_VERIFICATIONS fence');
      // The harness prelude below stands in for the launcher preamble the fence carries.
      const head = gateFence
        .split('\n').filter((l) => !l.startsWith('_GSD_SHIM_NAME='))
        .map((l) => (l === '$ARGUMENTS' ? '7' : l)).join('\n').replaceAll('{phase_number}', '7');
      const parent = repo;
      repo = path.join(parent, 'proj7'); // the absolute path holds the phase number 7
      fs.mkdirSync(repo);
      try {
        setUpRepo(null);
        fs.mkdirSync(path.join(repo, '.planning', 'phases', '06-prior'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.planning', 'phases', '06-prior', '06-VERIFICATION.md'), '# v\n');
        fs.mkdirSync(path.join(repo, '.planning', 'phases', '07-current'), { recursive: true });
        const out = runFence(`${head}\nprintf 'PRIOR=[%s]\\n' "$PRIOR_VERIFICATIONS"`, {});
        assert.ok(out.includes('06-VERIFICATION.md'), `prior phase verification must be found, got: ${out}`);
      } finally {
        repo = parent;
      }
    });

    test('an unresolved scope root aborts the fence instead of writing under /', () => {
      const script = `gsd_run() { :; }\n${discussContent.slice(discussContent.indexOf('PLANNING_ROOT=$(gsd_run query planning.inspect'), discussContent.indexOf('cat "${PROJECT_PATH}"'))}\necho REACHED`;
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: repo });
      assert.notEqual(r.exitCode, 0, `an empty PLANNING_ROOT must stop the fence, got: ${r.stdout}`);
      assert.ok(!r.stdout.includes('REACHED'), 'the fence must not continue past an unresolved root');
    });

    test('--ws ws1: reads the workstream files and commits the workstream STATE.md', () => {
      setUpRepo('.planning/workstreams/ws1', 'WS1');
      const out = runFence(`GSD_WS="--ws ws1"\n${readFence}`, {});
      assert.ok(out.includes('# STATE WS1') && out.includes('# REQUIREMENTS WS1'), `expected the ws1 files, got: ${out}`);
      assert.ok(!out.includes('STATE Root'), `must not read the root STATE.md, got: ${out}`);
      runFence(`GSD_WS="--ws ws1"\n${updateStateFence}`, {});
      assert.equal(git('status --short').trim(), '', 'the workstream tracking commit leaves a clean tree');
      assert.ok(git('log -1 --name-only --format=%s').includes('.planning/workstreams/ws1/STATE.md'));
    });
  });

  // Prose outside fences steers an agent just as a fence does: "Read `.planning/STATE.md`" sends a
  // named-project run to the root project's file. The instruction surfaces scan the same names.
  const PROSE_DIRS = [path.join('gsd-core', 'workflows'), 'agents', path.join('commands', 'gsd')];
  const PROSE_LITERAL = /\.planning\/(?:STATE\.md|ROADMAP\.md|REQUIREMENTS\.md|config\.json|phases\/)/;
  const PROSE_ALLOWLIST = [
    { file: 'gsd-core/workflows/complete-milestone.md', match: /not the literal `\.planning\/ROADMAP\.md`|\.planning\/ROADMAP\.md/, why: 'names the root literal only as the wrong answer next to `$ROADMAP_PATH`' },
    { file: 'gsd-core/workflows/new-milestone.md', match: /\.planning\/STATE\.md/, why: 'names the root literal only as the wrong answer: STATE.md is resolved through init.new-milestone' },
    { file: 'gsd-core/workflows/progress.md', match: /\.planning\/phases\//, why: 'negative example: a workstream project does not keep its phases under the root path' },
    { file: 'gsd-core/workflows/settings.md', match: /hardcode\S* `\.planning\/config\.json`|hardcoded `\.planning\/config\.json`/, why: 'negative example next to `$GSD_CONFIG_PATH`' },
    { file: 'gsd-core/workflows/settings-advanced.md', match: /\.planning\/config\.json` — workstream installs must route/, why: 'states why the root literal must not be used; the line names `$GSD_CONFIG_PATH`' },
    { file: 'gsd-core/workflows/smart-entry.md', match: /^\s*- Read `\.planning\/STATE\.md` \(frontmatter \+ body\)/, why: 'gsd-tools-down fallback: runs only when the CLI cannot run, so it cannot ask planning.inspect for the scope root and reads the flat file by construction (lint-state-field-drift PROMPT_LAYER_EXEMPTIONS pins this exact line)' },
    { file: 'gsd-core/workflows/undo.md', match: /\.planning\/phases\/03-auth/, why: 'historical incident quote, not an instruction' },
    { file: 'gsd-core/workflows/help/modes/full.md', match: /Result: Creates `\.planning\/phases\/01-foundation/, why: 'example command output for the flat project' },
    { file: 'gsd-core/workflows/help/modes/full.compact.md', match: /Result: Creates `\.planning\/phases\/01-foundation/, why: 'example command output for the flat project' },
    { file: 'agents/gsd-roadmapper.md', match: /\.planning\/ROADMAP\.md/, why: 'write targets of the roadmapper are owned by #5859, which names the flat fallback explicitly' },
    { file: 'agents/gsd-roadmapper.compact.md', match: /\.planning\/ROADMAP\.md/, why: 'write targets of the roadmapper are owned by #5859, which names the flat fallback explicitly' },
  ];

  function proseRootLiteralLines() {
    const hits = [];
    for (const rel of PROSE_DIRS.flatMap(markdownFiles)) {
      const lines = splitLines(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      const fenced = new Set();
      for (const block of scanFencedBlocks(lines)) {
        const end = block.closeLineIdx === -1 ? lines.length - 1 : block.closeLineIdx;
        for (let i = block.openLineIdx; i <= end; i += 1) fenced.add(i);
      }
      lines.forEach((text, i) => {
        if (!fenced.has(i) && PROSE_LITERAL.test(text)) hits.push({ file: rel.split(path.sep).join('/'), lineNo: i + 1, text });
      });
    }
    return hits;
  }

  test('prose in workflows, agents and commands names no root artifact path unless allowlisted', () => {
    const offenders = proseRootLiteralLines().filter((h) => !PROSE_ALLOWLIST.some((a) => a.file === h.file && a.match.test(h.text)));
    assert.deepEqual(offenders.map((h) => `${h.file}:${h.lineNo}  ${h.text.trim().slice(0, 120)}`), [],
      'name the scoped path ({planning_root}/..., an init *_path field or $GSD_CONFIG_PATH), not the root `.planning/<artifact>`');
    const hits = proseRootLiteralLines();
    const stale = PROSE_ALLOWLIST.filter((a) => !hits.some((h) => h.file === a.file && a.match.test(h.text)));
    assert.deepEqual(stale.map((a) => `${a.file} ${a.match}`), [], 'remove prose allowlist entries that no longer match');
  });

  test('every PLANNING_ROOT assignment in a shipped fence is followed by the unresolved-root guard', () => {
    const missing = [];
    for (const rel of SCAN_DIRS.flatMap(markdownFiles)) {
      const lines = splitLines(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      lines.forEach((line, i) => {
        if (/^\s*PLANNING_ROOT=\$\(/.test(line) && !/^\s*: "\$\{PLANNING_ROOT:\?/.test(lines[i + 1] || '')) {
          missing.push(`${rel.split(path.sep).join('/')}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(missing, [], 'an empty PLANNING_ROOT would make "${PLANNING_ROOT}/phases" resolve to /phases');
  });

  test('every allowlist entry still matches a fence line (no stale entries)', () => {
    const hits = rootLiteralLines();
    const stale = ALLOWLIST.filter((a) => !hits.some((h) => h.file === a.file && a.match.test(h.text)));
    assert.deepEqual(stale.map((a) => `${a.file} ${a.match}`), [], 'remove allowlist entries that no longer match');
    for (const a of ALLOWLIST) assert.ok(a.why && a.why.length > 10, `allowlist entry for ${a.file} needs a reason`);
  });
});
