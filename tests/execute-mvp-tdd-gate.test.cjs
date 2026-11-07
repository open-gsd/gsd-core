/**
 * execute-phase MVP+TDD gate — contract test
 * Verifies the workflow markdown documents the gate's resolution chain,
 * per-task firing condition, and end-of-phase review escalation.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runGsdTools, createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

function parseGateContract(content) {
  const lines = content.split(/\r?\n/);
  const lowerLines = lines.map(line => line.toLowerCase());

  // Detect whether the proceed-past-tdd-escalation is conditional on the MVP+TDD block
  // being ABSENT (correct) or unconditional (contradicts the block — regression).
  //
  // A contradicting unconditional proceed looks like:
  //   "regardless ... gate results ... always proceed"
  // That pattern is illegal once the MVP+TDD block is documented, because it nullifies it.
  // The proceed must be guarded ("if ... not blocked ... proceed").
  const hasUnconditionalProceed = /regardless[\s\S]{0,60}gate results[\s\S]{0,60}always proceed/i.test(content)
    || /always proceed[\s\S]{0,80}regardless/i.test(content);

  // The corrected proceed must co-occur with a conditional guard near the block mention.
  // We accept either: explicit conditional keyword ("if ... not ... block" / "otherwise proceed")
  // adjacent to the block text, OR absence of the unconditional pattern altogether.
  const hasProceedConditional = !hasUnconditionalProceed;

  return {
    hasMvpModeVariable: lowerLines.some(line => line.includes('mvp_mode')),
    hasRoadmapModeResolution: lowerLines.some(line => line.includes('phase.mvp-mode') || line.includes('roadmap') && line.includes('mode')),
    // #4011: the gate keys on TDD_MODE ALONE. Any line conjoining MVP_MODE and
    // TDD_MODE re-couples a discipline gate to a product-scope flag and makes
    // workflow.tdd_mode=true silently inert on non-MVP phases.
    hasTddOnlyGateCondition: lines.some(line => /\$TDD_MODE.{0,40}=.{0,20}"true"/.test(line) && !/MVP_MODE/.test(line)),
    // Scoped to shell-condition lines only — explanatory prose legitimately
    // mentions both flags on one line.
    hasNoMvpTddConjunct: !lines.some(line =>
      (/if \[|\] &&|&& \[/.test(line)) && /MVP_MODE/.test(line) && /TDD_MODE/.test(line)),
    hasTddOnlyEscalation: !/mvp_mode\s*(=|&&|and)/i.test((content.split('tdd review escalation')[1] || '') ),
    hasGateLabel: lowerLines.some(line => line.includes('mvp+tdd gate') || line.includes('mvp-tdd gate') || line.includes('tdd gate')),
    hasRedCommitRule: lowerLines.some(line => line.includes('failing-test commit') || line.includes('missing red commit') || line.includes('test(')),
    // Must assert the REAL refusal semantics, not merely the words "blocking" + "mvp+tdd"
    // (which "advisory (blocking: false) ... under MVP+TDD" would satisfy as a false green).
    hasBlockingEscalation:
      (content.toLowerCase().includes('refuse to mark the phase complete')
        || content.toLowerCase().includes('phase blocked')),
    hasReferenceDoc: lowerLines.some(line => line.includes('execute-mvp-tdd.md')),
    // Must NOT have an unconditional "proceed regardless of gate results" that overrides the block.
    // hasProceedConditional is true when the proceed is properly gated (or absent entirely).
    hasProceedConditional,
  };
}

describe('execute-phase — MVP+TDD gate', () => {
  const contract = parseGateContract(fs.readFileSync(WORKFLOW, 'utf-8'));

  test('Step 1 resolves MVP_MODE from roadmap mode field', () => {
    assert.ok(contract.hasMvpModeVariable, 'workflow must declare MVP_MODE');
    assert.ok(contract.hasRoadmapModeResolution, 'must consult phase mode from roadmap');
  });

  test('gate fires on TDD_MODE alone — no MVP conjunct (#4011)', () => {
    assert.ok(contract.hasTddOnlyGateCondition, 'the per-task gate must key on TDD_MODE alone');
    assert.ok(contract.hasNoMvpTddConjunct,
      'no shipped line may conjoin MVP_MODE with TDD_MODE as a gate condition — workflow.tdd_mode=true must enforce TDD on non-MVP phases too (#4011)');
  });

  test('per-task gate is documented before behavior-adding task execution', () => {
    assert.ok(contract.hasGateLabel, 'must label the gate');
    assert.ok(contract.hasRedCommitRule, 'must reference failing-test commit check');
  });

  test('end-of-phase TDD review escalates to blocking under TDD (#4011)', () => {
    assert.ok(contract.hasBlockingEscalation, 'must escalate end-of-phase review to blocking');
    assert.ok(contract.hasTddOnlyEscalation, 'the escalation must not require MVP_MODE (#4011)');
  });

  test('proceed past TDD escalation is conditional — not an unconditional override', () => {
    assert.ok(
      contract.hasProceedConditional,
      'workflow must NOT contain an unconditional "regardless of gate results, ALWAYS proceed" that nullifies the MVP+TDD block; the proceed must be guarded by the absence of an MVP+TDD block',
    );
  });

  test('workflow references execute-mvp-tdd.md', () => {
    assert.ok(contract.hasReferenceDoc, 'must reference the gate semantics file');
  });
});

describe('execute-phase MVP+TDD — resolution chain integration', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('roadmap.get-phase --pick mode returns mvp when **Mode:** mvp set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## v1.0.0\n\n### Phase 1: User Auth\n**Goal:** As a user, I want to log in, so that I can access.\n**Mode:** mvp\n`
    );
    const result = runGsdTools('roadmap get-phase 1 --pick mode', tmpDir);
    assert.ok(result.success, `roadmap get-phase should succeed, stderr: ${result.error || '(none)'}`);
    assert.strictEqual(result.output.trim(), 'mvp');
  });

  test('roadmap.get-phase --pick mode returns null/empty when no Mode line', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## v1.0.0\n\n### Phase 1: User Auth\n**Goal:** Users can log in.\n`
    );
    const result = runGsdTools('roadmap get-phase 1 --pick mode', tmpDir);
    assert.ok(result.success, `roadmap get-phase should succeed, stderr: ${result.error || '(none)'}`);
    assert.ok(result.output.trim() === '' || result.output.trim() === 'null');
  });

  test('config-get workflow.mvp_mode default is unset in fresh project', () => {
    const result = runGsdTools('config-get workflow.mvp_mode', tmpDir);
    if (result.success) {
      assert.notStrictEqual(result.output.trim(), 'true');
    }
  });
});

// ─── #4011: the gate semantics reference loads on TDD_MODE alone ─────────────

describe('execute-mvp-tdd.md — load condition decoupled from MVP (#4011)', () => {
  const REF = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-mvp-tdd.md');
  const content = fs.readFileSync(REF, 'utf-8');

  test('reference no longer requires MVP_MODE to load', () => {
    const head = content.slice(0, 1200);
    assert.ok(!/MVP_MODE\s*=\s*true\s*(AND|&&|and)\s*TDD_MODE|both.{0,20}MVP_MODE\s*=\s*true\s*AND/i.test(head),
      'execute-mvp-tdd.md must load on TDD_MODE alone (#4011)');
    assert.ok(/TDD_MODE\s*=\s*true/i.test(head), 'load condition must still name TDD_MODE');
  });
});

// ─── #5106: one definition of "a test file" for the gate ─────────────────────
// The behavior-adding check (router) and the RED-commit pathspec (this workflow) both decide
// what a test file is. They were two lists: the pathspec learned Go/Elixir/RSpec/pytest names in
// #4715 and the router never did, so a task listing only `placement_test.go` was classified
// behavior-adding and asked for a RED commit for the task that IS the RED commit.

describe('#5106: test-file conventions are one definition', () => {
  const { isBehaviorAddingTaskContent } = require('../gsd-core/bin/lib/task-command-router.cjs');
  const {
    TEST_FILE_PATHSPECS,
    TEST_FILE_GIT_PATHSPECS,
    GIT_PATHSPEC_ICASE_PREFIX,
    isTestFilePath,
  } = require('../gsd-core/bin/lib/tdd-test-files.cjs');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

  const task = (...files) => `<task tdd="true"><behavior>It does the thing</behavior><files>\n${files.map(f => `- ${f}`).join('\n')}\n</files></task>`;
  const hasSource = (...files) => isBehaviorAddingTaskContent(task(...files)).checks.has_source_files;

  test('a task listing only test files is not behavior-adding, whatever the language', () => {
    for (const file of [
      'a.test.ts', 'a.spec.js', 'tests/helper.cjs', 'test/helper.exs', '__tests__/a.js',
      'worker/internal/placement/placement_test.go', 'lib/thing_test.exs', 'spec/models/user_spec.rb',
      'spec/models/user_test.rb', 'tests/test_user.py', 'pkg/test_user.py', 'pkg/user_test.py',
    ]) {
      assert.equal(hasSource(file), false, `${file} is a test file, not production source`);
    }
  });

  test('production source is still behavior-adding, alone or beside its test', () => {
    assert.equal(hasSource('worker/internal/placement/placement.go'), true);
    assert.equal(hasSource('worker/internal/placement/placement.go', 'worker/internal/placement/placement_test.go'), true);
    assert.equal(hasSource('lib/testing_utils.go'), true, 'a name that merely contains "test" is not a test file');
    assert.equal(hasSource('src/contest.py'), true);
  });

  test('the router and the RED pathspec in execute-phase.md cannot diverge', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    const line = splitLines(src).find(l => l.includes('check evaluation-scope') && l.includes('--commits-only') && l.includes('--pathspec'));
    assert.ok(line, 'execute-phase.md has no RED-commit evaluation-scope line');
    const workflowSpecs = [...line.matchAll(/--pathspec "([^"]{1,80})"/g)].map(m => m[1]);
    // The workflow passes the CASE-INSENSITIVE pathspecs (#5766): git pathspecs are
    // case-sensitive by default, while the router (`isTestFilePath`) is not. Pinning
    // the workflow to the icase list is what makes the two answer ONE question.
    assert.deepEqual([...workflowSpecs].sort(), [...TEST_FILE_GIT_PATHSPECS].sort(),
      'the workflow pathspec list and TEST_FILE_GIT_PATHSPECS must be the same set');
    // Every workflow pathspec must carry git's case-insensitive magic prefix — a
    // plain pathspec here would silently re-open #5766 while the set comparison
    // above still passes (the icase list is derived from the same patterns).
    for (const spec of workflowSpecs) {
      assert.ok(spec.startsWith(GIT_PATHSPEC_ICASE_PREFIX),
        `workflow pathspec "${spec}" must carry the ${GIT_PATHSPEC_ICASE_PREFIX} prefix (#5766)`);
    }
    // And every entry means the same thing to the router: a path built from the spec is a test file.
    for (const spec of TEST_FILE_PATHSPECS) {
      const sample = spec.endsWith('/') ? `${spec}x.js` : spec.replace(/\*/g, 'sample');
      assert.equal(isTestFilePath(sample), true, `${spec} (as ${sample}) must be recognised as a test file`);
    }
    assert.equal(isTestFilePath('placement.go'), false);
  });
});

// ─── #5766: the gate's pathspecs are case-insensitive, like the router's ─────
// `isTestFilePath` matches `Tests/foo.rs`, `__TESTS__/a.js` and `Foo.TEST.js` (the
// basename globs carry the `i` flag, and directory segments are lowercased). Git
// pathspecs are case-SENSITIVE unless they carry the `:(icase)` magic prefix, so
// the gate used to call those paths "not a test file" and ask for a RED commit that
// already existed. The two consumers must agree, so the GATE side moved.

describe('#5766: the RED-commit gate pathspec is case-insensitive like the router', () => {
  const {
    TEST_FILE_PATHSPECS,
    TEST_FILE_GIT_PATHSPECS,
    GIT_PATHSPEC_ICASE_PREFIX,
    toCaseInsensitiveGitPathspec,
    isTestFilePath,
  } = require('../gsd-core/bin/lib/tdd-test-files.cjs');

  test('the icase list is the canonical list, one prefixed pathspec per entry', () => {
    assert.deepEqual(
      [...TEST_FILE_GIT_PATHSPECS],
      TEST_FILE_PATHSPECS.map((spec) => `${GIT_PATHSPEC_ICASE_PREFIX}${spec}`),
      'TEST_FILE_GIT_PATHSPECS must be TEST_FILE_PATHSPECS with the icase prefix, in order — '
        + 'otherwise the two lists can drift apart again (#5766)',
    );
    assert.equal(TEST_FILE_GIT_PATHSPECS.length, TEST_FILE_PATHSPECS.length);
  });

  test('toCaseInsensitiveGitPathspec is the identity plus the magic prefix', () => {
    for (const spec of TEST_FILE_PATHSPECS) {
      assert.equal(toCaseInsensitiveGitPathspec(spec), `${GIT_PATHSPEC_ICASE_PREFIX}${spec}`);
    }
  });

  test('the router already treats case variants as test files', () => {
    // The premise of #5766: these ARE test files to the router.
    for (const file of [
      'Tests/foo.rs', '__TESTS__/a.js', 'Foo.TEST.js', 'TESTS/Helper.CJS', 'SPEC/models/User_Spec.RB',
    ]) {
      assert.equal(isTestFilePath(file), true, `${file} must be recognised as a test file by the router`);
    }
    assert.equal(isTestFilePath('placement.go'), false);
  });

  describe('against a real git repository', () => {
    let tmpDir;

    beforeEach(() => { tmpDir = createTempGitProject(); });
    afterEach(() => { cleanup(tmpDir); });

    /**
     * The shas of the commits whose file set `git log` reports for the given
     * pathspecs. Empty output means "no commit touched those paths".
     */
    function commitsFor(pathspecs) {
      const args = ['log', '--format=%H', '--name-only', '--', ...pathspecs];
      return gitOrThrow(args, { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    }

    test('a plain pathspec misses a case-variant test path, the icase pathspec finds it', () => {
      // A RED commit that touches ONLY a case-variant test path.
      fs.mkdirSync(path.join(tmpDir, 'Tests'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'Tests', 'foo.rs'), '#[test]\nfn it_works() {}\n');
      gitOrThrow(['add', '-A'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['commit', '-m', 'test: add failing test'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

      // The OLD gate pathspec (case-sensitive `tests/`) cannot see `Tests/`.
      assert.equal(
        commitsFor(['tests/']).includes('Tests/foo.rs'),
        false,
        'a case-sensitive `tests/` pathspec must NOT match `Tests/foo.rs` — this is the #5766 defect',
      );

      // The NEW gate pathspec does see it.
      const icase = commitsFor([':(icase)tests/']);
      assert.ok(
        icase.includes('Tests/foo.rs'),
        'the `:(icase)tests/` pathspec must match `Tests/foo.rs` (#5766)',
      );
    });

    test('every gate pathspec matches its case variants in a real git repository', () => {
      // One case-variant sample per convention, covering both shapes the list uses:
      // a basename glob and a directory.
      //
      // The samples sit INSIDE each pathspec's real matching scope: a git pathspec whose
      // pattern starts with a literal (`test_*.py`) is anchored at the repository root,
      // so its sample is root-level; the others start with `*` and match the basename at
      // any depth.
      const samples = [
        ['Foo.TEST.js', '*.test.*'],
        ['Bar.SPEC.ts', '*.spec.*'],
        ['Tests/foo.rs', 'tests/'],
        ['__TESTS__/a.js', '__tests__/'],
        ['pkg/Thing_TEST.go', '*_test.go'],
        ['Test_thing.py', 'test_*.py'],
        ['pkg/thing_TEST.py', '*_test.py'],
        ['lib/thing_TEST.exs', '*_test.exs'],
        ['spec/models/User_Spec.rb', '*_spec.rb'],
        ['spec/models/User_TEST.rb', '*_test.rb'],
      ];

      for (const [sample] of samples) {
        const target = path.join(tmpDir, ...sample.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'test\n');
      }
      gitOrThrow(['add', '-A'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['commit', '-m', 'test: add case-variant tests'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

      for (const [sample, spec] of samples) {
        const plain = commitsFor([spec]);
        const icase = commitsFor([toCaseInsensitiveGitPathspec(spec)]);
        assert.equal(
          plain.includes(sample),
          false,
          `the case-sensitive pathspec "${spec}" must not match "${sample}" — that is the #5766 defect`,
        );
        assert.ok(
          icase.includes(sample),
          `the pathspec "${toCaseInsensitiveGitPathspec(spec)}" must match "${sample}" (#5766)`,
        );
      }
    });

    test('the whole gate pathspec set finds a RED commit that touches only a case-variant path', () => {
      // End-to-end shape of the gate: the workflow asks `git log` for the plan's
      // commits narrowed by EVERY gate pathspec at once.
      fs.mkdirSync(path.join(tmpDir, 'Tests'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'Tests', 'foo.rs'), '#[test]\nfn it_works() {}\n');
      gitOrThrow(['add', '-A'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['commit', '-m', 'test: add failing test'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

      const withOldPathspecs = commitsFor([...TEST_FILE_PATHSPECS]);
      assert.equal(
        withOldPathspecs.includes('Tests/foo.rs'),
        false,
        'the pre-#5766 pathspec set must not see `Tests/foo.rs` — the gate asked for a RED commit that existed',
      );

      const withNewPathspecs = commitsFor([...TEST_FILE_GIT_PATHSPECS]);
      assert.ok(
        withNewPathspecs.includes('Tests/foo.rs'),
        'the gate pathspec set must see the `Tests/foo.rs` RED commit (#5766)',
      );
    });
  });
});
