'use strict';

/**
 * Prod-shape integration tests for `src/init.cts`'s `buildSectionManifestField`
 * seam (compiled into `gsd-core/bin/lib/init.cjs`) — #2994 (epic #1671 Phase
 * 6.3), `.gsd/phase/chore-2994-fragment-model-workflows/50-test-matrix.md`
 * sections B (compound-fact folding), D (flag value shapes), and E (the
 * `null` vs `[]` distinction).
 *
 * Every test drives the REAL CLI (`runGsdTools`, spawns `gsd-tools.cjs`) —
 * never a direct `require()` of `cmdInit*`, since `buildSectionManifestField`
 * itself is not exported and the whole point of this suite is proving the
 * flag/config plumbing that only exists at the CLI seam (`init-command-router.cjs`'s
 * `parseNamedArgs` calls) actually reaches `section_manifest`.
 *
 * Group E uses the `GSD_SECTION_MANIFEST` env override
 * (`gsd-core/bin/lib/init.cjs`'s `_sectionManifestCandidatePath`) to point the
 * CLI at a temp fixture manifest instead of the shipped
 * `gsd-core/workflows/section-manifest.json` — this is the ONLY way to
 * exercise "workflow absent from the manifest" today, because every
 * `cmdInit*` this repo currently wires (#2994's own completion) already has
 * an explicit key in the shipped artifact; Groups B and D deliberately do NOT
 * override it, driving the shipped manifest directly per the matrix's own
 * "drive from the shipped artifact wherever possible" rule.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runGsdTools, cleanup, createTempDir, createTempProject } = require('./helpers.cjs');
const { seedPhase } = require('./fixtures/index.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

function writeConfig(tmpDir, config) {
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
}

function runInitJson(argv, cwd, env = {}) {
  const result = runGsdTools(argv, cwd, env);
  assert.ok(result.success, `Command failed: ${result.error}`);
  return JSON.parse(result.output);
}

// ─── Group E: the null vs [] distinction (matrix rows E1/E2/E3/E5/E6) ──────

describe('section_manifest: null (degraded) vs [] (computed, nothing applicable) — matrix §E', () => {
  let tmpDir;
  let manifestDir;

  beforeEach(() => {
    tmpDir = createTempProject('section-manifest-e-');
    manifestDir = createTempDir('section-manifest-e-manifest-');
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(manifestDir);
  });

  test('a manifest with no "quick" key degrades section_manifest to null (row E1)', () => {
    const manifestPath = path.join(manifestDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ workflows: {} }));

    const output = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: manifestPath });
    assert.equal(output.section_manifest, null, 'an absent workflow key must degrade to null, never []');
  });

  test('a manifest with an explicit empty "quick" section list yields a computed [] (row E2)', () => {
    const manifestPath = path.join(manifestDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ workflows: { quick: [] } }));

    const output = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: manifestPath });
    assert.notEqual(output.section_manifest, null, 'a present (even empty) workflow key must NOT degrade to null');
    assert.deepEqual(output.section_manifest.included, []);
    assert.deepEqual(output.section_manifest.excluded, []);
    assert.deepEqual(output.section_manifest.read, []);
  });

  test('null and the computed [] shape are DIFFERENT values, not interchangeable (row E3)', () => {
    const absentKeyManifest = path.join(manifestDir, 'absent.json');
    fs.writeFileSync(absentKeyManifest, JSON.stringify({ workflows: {} }));
    const emptyListManifest = path.join(manifestDir, 'empty.json');
    fs.writeFileSync(emptyListManifest, JSON.stringify({ workflows: { quick: [] } }));

    const degraded = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: absentKeyManifest });
    const computed = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: emptyListManifest });

    assert.equal(degraded.section_manifest, null);
    assert.notEqual(computed.section_manifest, null);
    assert.notDeepEqual(degraded.section_manifest, computed.section_manifest, 'null must never compare equal to the computed {included:[],excluded:[],...} shape');
  });

  test('a section list where every when= evaluates false is still the computed [] shape, not null (row E2, second case)', () => {
    // "Applicable" is a FACTS question, not a shape question: a real section
    // whose gating flag was simply never passed on this invocation must still
    // be the computed {included:[],...} object, never collapse to null.
    const manifestPath = path.join(manifestDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      workflows: {
        quick: [{ id: 'discussion-phase', when: 'flag:--discuss', read: 'gsd-core/workflows/quick/steps/discussion-phase.md' }],
      },
    }));

    const output = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: manifestPath });
    assert.notEqual(output.section_manifest, null);
    assert.deepEqual(output.section_manifest.included, []);
    assert.deepEqual(output.section_manifest.excluded, ['discussion-phase']);
  });

  test('a missing manifest file degrades to null without throwing (row E5)', () => {
    const neverCreatedPath = path.join(manifestDir, 'does-not-exist.json');
    assert.equal(fs.existsSync(neverCreatedPath), false, 'sanity: file must not exist');

    const result = runGsdTools(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: neverCreatedPath });
    assert.ok(result.success, `a missing manifest file must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.equal(output.section_manifest, null);
  });

  test('a malformed-JSON manifest file degrades to null without throwing (row E6)', () => {
    const manifestPath = path.join(manifestDir, 'malformed.json');
    fs.writeFileSync(manifestPath, '{ this is not valid JSON');

    const result = runGsdTools(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: manifestPath });
    assert.ok(result.success, `a malformed manifest file must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.equal(output.section_manifest, null);
  });
});

// ─── Group B: compound-fact folding lives in init.cts, never the grammar ──

describe('compound-fact folding at the init seam — matrix §B', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('section-manifest-b-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // B1-B4: cmdInitQuick folds --full into --discuss/--research/--validate BEFORE
  // buildSectionManifestField evaluates flag:--discuss/flag:--research/flag:--validate.
  describe('cmdInitQuick folds --full into each mode fact (rows B1-B4)', () => {
    test('--discuss alone includes discussion-phase (row B1, baseline)', () => {
      const output = runInitJson(['init', 'quick', 'desc', '--discuss'], tmpDir);
      assert.ok(output.section_manifest.included.includes('discussion-phase'));
    });

    test('--full alone (no --discuss) STILL includes discussion-phase — the fold this PR exists to prove (row B2)', () => {
      const output = runInitJson(['init', 'quick', 'desc', '--full'], tmpDir);
      assert.ok(
        output.section_manifest.included.includes('discussion-phase'),
        '--full must imply --discuss for section-gating purposes, folded in cmdInitQuick before evaluation',
      );
      assert.ok(output.section_manifest.included.includes('research-phase'), '--full must also imply --research');
      assert.ok(output.section_manifest.included.includes('plan-checker-loop'), '--full must also imply --validate (plan-checker-loop)');
      assert.ok(output.section_manifest.included.includes('quick-verification'), '--full must also imply --validate (quick-verification)');
    });

    test('neither --discuss nor --full excludes discussion-phase (row B3)', () => {
      const output = runInitJson(['init', 'quick', 'desc'], tmpDir);
      assert.ok(output.section_manifest.excluded.includes('discussion-phase'));
    });

    test('--full AND --discuss together still include discussion-phase exactly once, no double-counting (row B4)', () => {
      const output = runInitJson(['init', 'quick', 'desc', '--full', '--discuss'], tmpDir);
      const occurrences = output.section_manifest.included.filter((id) => id === 'discussion-phase');
      assert.equal(occurrences.length, 1, 'discussion-phase must appear exactly once in included, never duplicated by the fold');
    });
  });

  // B5-B6: cmdInitAutonomous folds --converge OR --cross-ai into one plan_strategy_converge fact.
  describe('cmdInitAutonomous folds --converge OR --cross-ai (rows B5-B6)', () => {
    test('--converge alone drives state:plan-strategy-converge sections into included (row B5)', () => {
      const output = runInitJson(['init', 'autonomous', '--converge'], tmpDir);
      assert.equal(output.plan_strategy_converge, true);
      assert.ok(output.section_manifest.included.includes('converge-fail-fast'));
      assert.ok(output.section_manifest.included.includes('converge-banner'));
    });

    test('--cross-ai alone (the documented alias, no --converge) ALSO drives inclusion (row B6)', () => {
      const output = runInitJson(['init', 'autonomous', '--cross-ai'], tmpDir);
      assert.equal(output.plan_strategy_converge, true);
      assert.ok(output.section_manifest.included.includes('converge-fail-fast'));
      assert.ok(output.section_manifest.included.includes('converge-loop'));
    });

    test('neither flag excludes every converge-* section', () => {
      const output = runInitJson(['init', 'autonomous'], tmpDir);
      assert.equal(output.plan_strategy_converge, false);
      for (const id of ['converge-fail-fast', 'converge-banner', 'converge-dispatch-bg', 'converge-dispatch-inline', 'converge-loop']) {
        assert.ok(output.section_manifest.excluded.includes(id), `expected "${id}" excluded when neither --converge nor --cross-ai is set`);
      }
    });
  });

  // B7: cmdInitUpdate folds --next OR --rc into one next_channel fact.
  describe('cmdInitUpdate folds --next OR --rc (row B7)', () => {
    test('--rc alone (not --next) drives channel-banner into included', () => {
      const output = runInitJson(['init', 'update', '--rc'], tmpDir);
      assert.equal(output.next_channel, true);
      assert.ok(output.section_manifest.included.includes('channel-banner'));
    });

    test('--next alone also drives channel-banner into included (the other half of the OR)', () => {
      const output = runInitJson(['init', 'update', '--next'], tmpDir);
      assert.equal(output.next_channel, true);
      assert.ok(output.section_manifest.included.includes('channel-banner'));
    });

    test('neither flag excludes channel-banner', () => {
      const output = runInitJson(['init', 'update'], tmpDir);
      assert.equal(output.next_channel, false);
      assert.ok(output.section_manifest.excluded.includes('channel-banner'));
    });
  });

  // B8: cmdInitDiscussPhaseAssumptions folds --auto OR consolidated auto-mode config.
  describe('cmdInitDiscussPhaseAssumptions folds --auto flag OR config auto-mode (row B8)', () => {
    test('no --auto flag, but config workflow._auto_chain_active=true, still includes auto-advance-dispatch', () => {
      writeConfig(tmpDir, { workflow: { _auto_chain_active: true } });
      const output = runInitJson(['init', 'discuss-phase-assumptions', '99'], tmpDir);
      assert.ok(output.section_manifest.included.includes('auto-advance-dispatch'));
    });

    test('no --auto flag, but config workflow.auto_advance=true, still includes auto-advance-dispatch (the other config source)', () => {
      writeConfig(tmpDir, { workflow: { auto_advance: true } });
      const output = runInitJson(['init', 'discuss-phase-assumptions', '99'], tmpDir);
      assert.ok(output.section_manifest.included.includes('auto-advance-dispatch'));
    });

    test('--auto flag present with no config also includes auto-advance-dispatch', () => {
      const output = runInitJson(['init', 'discuss-phase-assumptions', '99', '--auto'], tmpDir);
      assert.ok(output.section_manifest.included.includes('auto-advance-dispatch'));
    });

    test('neither --auto nor either config key excludes auto-advance-dispatch', () => {
      const output = runInitJson(['init', 'discuss-phase-assumptions', '99'], tmpDir);
      assert.ok(output.section_manifest.excluded.includes('auto-advance-dispatch'));
    });
  });
});

// ─── Group D: flag value shapes — token presence, not value truthiness ────

describe('flag value shapes drive section_manifest by truthiness, not semantic value — matrix §D', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('section-manifest-d-');
    seedPhase(tmpDir, '01-sample', { '01-CONTEXT.md': '# Phase Context\n' });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('absent boolean flag (--reviews never passed) does not mark reviews-prerequisite present (row D1)', () => {
    const output = runInitJson(['init', 'plan-phase', '1'], tmpDir);
    assert.ok(output.section_manifest.excluded.includes('reviews-prerequisite'));
    assert.ok(!output.section_manifest.included.includes('reviews-prerequisite'));
  });

  test('empty-string value flag (--prd "") excludes prd-express-gate — an empty value is not a branch selection (row D2)', () => {
    const output = runInitJson(['init', 'plan-phase', '1', '--prd', ''], tmpDir);
    assert.ok(output.section_manifest.excluded.includes('prd-express-gate'));
  });

  test('string-"0" value flag (--prd "0") INCLUDES prd-express-gate — token-presence semantics, not value truthiness (row D3)', () => {
    const output = runInitJson(['init', 'plan-phase', '1', '--prd', '0'], tmpDir);
    assert.ok(output.section_manifest.included.includes('prd-express-gate'), '--prd "0" is a non-empty string and must be treated as present');
  });

  test('whitespace-only value flag (--prd "   ") includes prd-express-gate, asserted deliberately (row D4)', () => {
    const output = runInitJson(['init', 'plan-phase', '1', '--prd', '   '], tmpDir);
    assert.ok(output.section_manifest.included.includes('prd-express-gate'));
  });

  test('duplicate flag tokens (--prd a --prd b) resolve to a single membership, no crash (row D5)', () => {
    const result = runGsdTools(['init', 'plan-phase', '1', '--prd', 'a', '--prd', 'b'], tmpDir);
    assert.ok(result.success, `duplicate --prd tokens must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.section_manifest.included.includes('prd-express-gate'));
    const occurrences = output.section_manifest.included.filter((id) => id === 'prd-express-gate');
    assert.equal(occurrences.length, 1, 'must be a single membership, not one entry per duplicate token');
  });

  test('flag-shaped value (--prd --reviews) does not crash and deterministically excludes prd-express-gate (row D6)', () => {
    // parseNamedArgs treats a token starting with "--" as the NEXT flag, never
    // as this flag's value — so --prd here resolves to null (absent), not the
    // literal string "--reviews".
    //
    // Corrected after the first full verification run: the original choice of
    // `--weird` here predates ADR-3473 §8.4's strict unrecognized-flag
    // rejection (this file is from #2994/epic #1671, before #3358's strict
    // parseNamedArgs) and is itself an unrecognized flag for `plan-phase` —
    // it now correctly fails with exit 1 / "unknown flag --weird" instead of
    // proving the "flag-shaped value" point this test exists for. Swapped for
    // `--reviews`, a real declared plan-phase boolean flag, matching the same
    // substitution already used by the sibling row
    // tests/init.test.cjs:emptyPrdValueIsFalsyAndTreatedAsAbsent (row B5).
    const result = runGsdTools(['init', 'plan-phase', '1', '--prd', '--reviews'], tmpDir);
    assert.ok(result.success, `a flag-shaped value must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.section_manifest.excluded.includes('prd-express-gate'), '--prd immediately followed by another --flag token must resolve to absent, per parseNamedArgs');
  });

  test('unicode / very long value does not crash and is included as present (row D7)', () => {
    const longUnicodeValue = `产品需求文档-🚀-${'x'.repeat(2000)}`;
    const result = runGsdTools(['init', 'plan-phase', '1', '--prd', longUnicodeValue], tmpDir);
    assert.ok(result.success, `a unicode/very-long --prd value must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.section_manifest.included.includes('prd-express-gate'));
  });
});

// ─── Group F: complete-milestone workstream fact — #5195 ──────────────────
//
// `/gsd-complete-milestone --ws <name>` used to run the full PROJECT.md
// evolution review and stage PROJECT.md in the archive safety commit even
// though PROJECT.md is the ONE planning file shared across a project's
// workstreams (#4543). `init.complete-milestone` now supplies the
// `state:flat-mode` fact (as `init.new-milestone` has since #2308) so the
// review is a manifest section that only a flat-mode run includes, and the
// safety commit derives its file list from that same manifest.

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const COMPLETE_MILESTONE_WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md');
const EVOLUTION_REVIEW_ID = 'project-md-evolution-review';

/** Root planning tree (flat mode): shared PROJECT.md plus the per-scope files. */
function seedFlatMilestoneProject(tmpDir) {
  const planning = path.join(tmpDir, '.planning');
  fs.writeFileSync(path.join(planning, 'PROJECT.md'), '# Shared Project\n');
  fs.writeFileSync(path.join(planning, 'STATE.md'), '---\ncurrent_phase: 1\n---\n# State\n');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), '# Roadmap\n');
  fs.writeFileSync(path.join(planning, 'MILESTONES.md'), '# Milestones\n');
}

/** Flat tree plus a workstream `w1` with its OWN state/roadmap/milestones (PROJECT.md stays shared). */
function seedWorkstreamMilestoneProject(tmpDir) {
  seedFlatMilestoneProject(tmpDir);
  const ws = path.join(tmpDir, '.planning', 'workstreams', 'w1');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'STATE.md'), '---\ncurrent_phase: 1\n---\n# State\n');
  fs.writeFileSync(path.join(ws, 'ROADMAP.md'), '# Roadmap\n');
  fs.writeFileSync(path.join(ws, 'MILESTONES.md'), '# Milestones\n');
}

function writeActiveWorkstreamPointer(tmpDir, name) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), name);
}

/**
 * Run the workflow's real archive safety-commit fence under bash, with the
 * `commit` seam intercepted so the `--files` list it WOULD stage is recorded.
 * `init.complete-milestone` is the real CLI. `args` is what the runtime
 * substitutes for `$ARGUMENTS`.
 */
function runSafetyCommitFence(tmpDir, args) {
  const lines = splitLines(fs.readFileSync(COMPLETE_MILESTONE_WORKFLOW, 'utf8'));
  const fences = scanFencedBlocks(lines)
    .filter((b) => b.closeLineIdx !== -1 && b.infoString.trim().toLowerCase() === 'bash')
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
  const fence = fences.find((f) => f.includes('chore: archive v[X.Y] milestone files'));
  assert.ok(fence, 'the archive safety-commit fence must exist in complete-milestone.md');

  const recordFile = path.join(tmpDir, 'commit-args.txt');
  const script = [
    'gsd_run() {',
    '  if [ "$1" = "query" ] && [ "$2" = "commit" ]; then',
    '    shift 2; printf "%s\\n" "$@" > "$GSD_TEST_COMMIT_ARGS"; return 0',
    '  fi',
    '  node "$GSD_TEST_TOOLS" "$@"',
    '}',
    fence.split('$ARGUMENTS').join(args),
  ].join('\n');
  const scriptPath = path.join(tmpDir, 'safety-commit-fence.sh');
  fs.writeFileSync(scriptPath, script);

  const r = runHook(scriptPath, [], {
    interpreter: 'bash',
    cwd: tmpDir,
    env: { ...process.env, GSD_TEST_TOOLS: GSD_TOOLS, GSD_TEST_COMMIT_ARGS: recordFile },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(r.outcome, OUTCOME.EXITED, `fence must run to completion: ${r.stderr}`);
  assert.equal(r.exitCode, 0, `fence exited non-zero: ${r.stderr}`);
  const recorded = splitLines(fs.readFileSync(recordFile, 'utf8')).filter(Boolean);
  const filesAt = recorded.indexOf('--files');
  assert.notEqual(filesAt, -1, 'the commit call must declare --files');
  return recorded.slice(filesAt + 1);
}

describe('complete-milestone supplies the workstream fact; the PROJECT.md review is flat-mode only — #5195, matrix §F', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('section-manifest-f-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--ws excludes the PROJECT.md evolution review (row F1, the issue repro)', () => {
    seedWorkstreamMilestoneProject(tmpDir);
    const output = runInitJson(['init', 'complete-milestone', '--ws', 'w1'], tmpDir);
    assert.ok(output.section_manifest.excluded.includes(EVOLUTION_REVIEW_ID), 'the shared PROJECT.md review must be excluded under --ws');
    assert.ok(!output.section_manifest.included.includes(EVOLUTION_REVIEW_ID));
    assert.ok(
      !output.section_manifest.read.some((p) => p.endsWith('project-md-evolution-review.md')),
      'the review step file must not be handed to the runtime under --ws',
    );
  });

  test('flat mode includes the PROJECT.md evolution review (row F2, unchanged behavior)', () => {
    seedFlatMilestoneProject(tmpDir);
    const output = runInitJson(['init', 'complete-milestone'], tmpDir);
    assert.ok(output.section_manifest.included.includes(EVOLUTION_REVIEW_ID));
    assert.ok(!output.section_manifest.excluded.includes(EVOLUTION_REVIEW_ID));
  });

  test('an active-workstream pointer alone (no --ws) excludes the review (row F3)', () => {
    seedWorkstreamMilestoneProject(tmpDir);
    writeActiveWorkstreamPointer(tmpDir, 'w1');
    const output = runInitJson(['init', 'complete-milestone'], tmpDir);
    assert.ok(output.section_manifest.excluded.includes(EVOLUTION_REVIEW_ID));
  });

  test('git-tag inclusion is independent of the workstream fact (row F4)', () => {
    seedWorkstreamMilestoneProject(tmpDir);
    // Under --ws the config resolves from the workstream's own planning dir, not the shared root.
    const writeWsConfig = (config) => fs.writeFileSync(path.join(tmpDir, '.planning', 'workstreams', 'w1', 'config.json'), JSON.stringify(config));
    writeWsConfig({ git: { create_tag: true } });
    const tagOn = runInitJson(['init', 'complete-milestone', '--ws', 'w1'], tmpDir);
    assert.ok(tagOn.section_manifest.included.includes('git-tag'), 'git-tag follows git.create_tag=true even under --ws');

    writeWsConfig({ git: { create_tag: false } });
    const tagOff = runInitJson(['init', 'complete-milestone', '--ws', 'w1'], tmpDir);
    assert.ok(tagOff.section_manifest.excluded.includes('git-tag'), 'git-tag follows git.create_tag=false under --ws');
    assert.ok(tagOff.section_manifest.excluded.includes(EVOLUTION_REVIEW_ID));
  });

  test('project_path remains the shared root PROJECT.md under --ws (row F5, contract unchanged)', () => {
    seedWorkstreamMilestoneProject(tmpDir);
    const output = runInitJson(['init', 'complete-milestone', '--ws', 'w1'], tmpDir);
    assert.ok(output.project_path.endsWith('/.planning/PROJECT.md'), `project_path must stay the shared root file, got ${output.project_path}`);
    assert.ok(!output.project_path.includes('/workstreams/'));
    for (const key of ['state_path', 'roadmap_path', 'archive_dir', 'milestones_path']) {
      assert.ok(output[key].includes('/.planning/workstreams/w1/'), `${key} must stay workstream-scoped, got ${output[key]}`);
    }
  });

  describe('the review gate resolves the manifest itself before the gated section (matrix row F10)', () => {
    /** Run the workflow's real early gate fence; return the `PROJECT_MD_REVIEW=` line it prints. */
    function runReviewGate(args) {
      const lines = splitLines(fs.readFileSync(COMPLETE_MILESTONE_WORKFLOW, 'utf8'));
      const blocks = scanFencedBlocks(lines).filter((b) => b.closeLineIdx !== -1 && b.infoString.trim().toLowerCase() === 'bash');
      const block = blocks.find((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n').includes('PROJECT_MD_REVIEW='));
      assert.ok(block, 'complete-milestone.md must resolve the review gate in its own bash fence');
      const sectionIdx = lines.findIndex((l) => l.includes(`gsd:section id="${EVOLUTION_REVIEW_ID}"`));
      assert.ok(block.closeLineIdx < sectionIdx, 'the gate fence must come BEFORE the section it gates, else the manifest is unread when the section runs');

      const script = [
        'gsd_run() { node "$GSD_TEST_TOOLS" "$@"; }',
        lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n').split('$ARGUMENTS').join(args),
      ].join('\n');
      const scriptPath = path.join(tmpDir, 'review-gate-fence.sh');
      fs.writeFileSync(scriptPath, script);
      const r = runHook(scriptPath, [], {
        interpreter: 'bash',
        cwd: tmpDir,
        env: { ...process.env, GSD_TEST_TOOLS: GSD_TOOLS },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      assert.equal(r.outcome, OUTCOME.EXITED, `gate fence must run to completion: ${r.stderr}`);
      assert.equal(r.exitCode, 0, `gate fence exited non-zero: ${r.stderr}`);
      return splitLines(r.stdout).find((l) => l.startsWith('PROJECT_MD_REVIEW='));
    }

    test('--ws skips the review', () => {
      seedWorkstreamMilestoneProject(tmpDir);
      assert.equal(runReviewGate('--ws w1'), 'PROJECT_MD_REVIEW=skip');
    });

    test('flat mode runs the review', () => {
      seedFlatMilestoneProject(tmpDir);
      assert.equal(runReviewGate(''), 'PROJECT_MD_REVIEW=run');
    });

    test('an active-workstream pointer alone skips the review', () => {
      seedWorkstreamMilestoneProject(tmpDir);
      writeActiveWorkstreamPointer(tmpDir, 'w1');
      assert.equal(runReviewGate(''), 'PROJECT_MD_REVIEW=skip');
    });
  });

  describe('the archive safety commit follows the same manifest', () => {
    const isProjectMd = (p) => p.endsWith('/.planning/PROJECT.md');

    test('under --ws it does not stage the shared PROJECT.md (row F6)', () => {
      seedWorkstreamMilestoneProject(tmpDir);
      const files = runSafetyCommitFence(tmpDir, '--ws w1');
      assert.equal(files.filter(isProjectMd).length, 0, `PROJECT.md must not be staged under --ws, got ${JSON.stringify(files)}`);
      assert.ok(files.some((p) => p.endsWith('/.planning/workstreams/w1/STATE.md')), 'workstream STATE.md still staged');
      assert.ok(files.some((p) => p.endsWith('/.planning/workstreams/w1/ROADMAP.md')), 'workstream ROADMAP.md still staged');
      assert.ok(files.some((p) => p.endsWith('/.planning/workstreams/w1/MILESTONES.md')), 'workstream MILESTONES.md still staged');
    });

    test('in flat mode it still stages PROJECT.md (row F7)', () => {
      seedFlatMilestoneProject(tmpDir);
      const files = runSafetyCommitFence(tmpDir, '');
      assert.equal(files.filter(isProjectMd).length, 1, `PROJECT.md must be staged exactly once in flat mode, got ${JSON.stringify(files)}`);
    });

    test('it follows init\'s workstream resolution, not its own argument parse (row F8)', () => {
      seedWorkstreamMilestoneProject(tmpDir);
      writeActiveWorkstreamPointer(tmpDir, 'w1');
      const files = runSafetyCommitFence(tmpDir, '');
      assert.ok(files.some((p) => p.endsWith('/.planning/workstreams/w1/STATE.md')), 'precondition: paths resolved under the pointed workstream');
      assert.equal(files.filter(isProjectMd).length, 0, 'the pointer-resolved workstream must exclude PROJECT.md even though the fence saw no --ws');
    });
  });

  test('the workflow no longer claims PROJECT.md is workstream-scoped (row F9)', () => {
    const workflow = fs.readFileSync(COMPLETE_MILESTONE_WORKFLOW, 'utf8');
    assert.ok(
      !/MILESTONES\.md and PROJECT\.md are workstream-scoped/.test(workflow),
      'the false "PROJECT.md is workstream-scoped" sentence must be corrected (it is shared since #4543)',
    );
  });
});
