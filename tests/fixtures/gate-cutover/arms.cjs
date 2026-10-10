'use strict';

/**
 * Cutover-equivalence arm catalogue (#5139, Phase 6 of #5056).
 *
 * One entry per payload arm of every `check` gate. Shared by the test
 * (tests/check-router-cutover-equivalence.test.cjs) and by the capture script
 * that produced the checked-in goldens, so the fixture a golden was captured
 * from and the fixture the test rebuilds are the same code.
 *
 * Deterministic by construction: fixed file content, no clock, no random. The
 * only run-dependent text is the temp root, which `normalize` rewrites to
 * `<TMP>` in BOTH capture and comparison.
 *
 * PROVENANCE (#5219, ADR-5057 §4 arm C). The goldens of groups E12–E15 (the drift gates and
 * prohibition-enforcement) were captured by executing `origin/next` at
 * 8bbdded7efd00fa7beffc10d6e39550c165875d6 (the build BEFORE the four verbs moved into gate
 * modules). To re-verify: check that commit out detached, `npm run build:lib`, copy this file and
 * fail-read-preload.cjs into its tests/fixtures/gate-cutover/, run each E12–E15 arm and diff stdout,
 * stderr and exit code against the checked-in goldens. Review-round arms whose behaviour was
 * DELIBERATELY changed by the move are marked in the golden catalogue test (E13 stamp validation).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TEST_ENV_BASE } = require('../../helpers.cjs');
const { runNode } = require('../../helpers/process-seam.cjs');
const { gitOrThrow } = require('../../helpers/git-fixture.cjs');
const { LOOP_HOOK_POINT_CLI_TIMEOUT_MS } = require('../../helpers/timeouts.cjs');
const { tempRootAliases, canonicalizeTempText } = require('../../helpers/path-compare.cjs');

const TOOLS_PATH = path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const PRELOAD_PATH = path.join(__dirname, 'fail-read-preload.cjs');

// ─── fixture plumbing ─────────────────────────────────────────────────────────

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function makeGit(root) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
  };
  const git = (...args) => gitOrThrow(args, { cwd: root, env }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return git;
}

function commit(git, root, message) {
  const dir = path.join(root, '.commits');
  const seq = fs.existsSync(dir) ? fs.readdirSync(dir).length + 1 : 1;
  write(root, `.commits/${String(seq).padStart(4, '0')}.txt`, `${message}\n`);
  git('add', '.');
  git('commit', '-m', message);
}

// ─── fixture content ──────────────────────────────────────────────────────────

const DC_PHASE = '.planning/phases/01-decisions';

function decisionsContext(bullets) {
  return `# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n${bullets.join('\n')}\n</decisions>\n`;
}

function buildDecisionCoverage(root) {
  write(root, '.planning/config.json', '{}\n');
  write(root, `${DC_PHASE}/CONTEXT.md`, decisionsContext([
    '- **D-01:** Adopt strict typing',
    '- **D-02:** Cache tokens in memory',
    '- **D-03:** Log every retry',
  ]));
  write(root, `${DC_PHASE}/CONTEXT-allcovered.md`, decisionsContext([
    '- **D-01:** Adopt strict typing',
    '- **D-02:** Cache tokens in memory',
  ]));
  write(root, `${DC_PHASE}/CONTEXT-unparsable.md`, decisionsContext(['- **DEC-01:** Something odd']));
  write(root, `${DC_PHASE}/CONTEXT-partial.md`, decisionsContext([
    '- **D-01:** Adopt strict typing',
    '- **D4x-01:** Malformed prefix',
  ]));
  write(root, `${DC_PHASE}/CONTEXT-empty.md`, '# Phase Context\n\nNothing to track here.\n');
  write(root, `${DC_PHASE}/CONTEXT-verify.md`, decisionsContext([
    '- **D-01:** Adopt strict typing',
    '- **D-03:** Log every retry',
    '- **D-04:** Back off politely',
    '- **D-05:** Never reached anywhere',
    '- **D-06:** Summarize daily',
  ]));
  write(root, `${DC_PHASE}/ctxdir/keep.txt`, 'directory used as a context path\n');
  write(root, `${DC_PHASE}/01-01-PLAN.md`, [
    '---',
    'phase: 01',
    'must_haves:',
    '  truths:',
    '    - "D-02 tokens are cached"',
    '---',
    '',
    '<objective>Implement D-01 typing</objective>',
    '',
  ].join('\n'));
  write(root, `${DC_PHASE}/01-01-SUMMARY.md`, [
    '---',
    'phase: 01',
    'files_modified:',
    '  - src/impl.txt',
    '---',
    '',
    'Done. D-06 summarized in the report.',
    '',
  ].join('\n'));
  write(root, 'src/impl.txt', 'implements D-03 exactly\n');
  const git = makeGit(root);
  commit(git, root, 'feat: init scaffold');
  commit(git, root, 'feat: implement D-04 retries');
}

function buildDecisionCoverageDisabled(root) {
  write(root, '.planning/config.json', `${JSON.stringify({ workflow: { context_coverage_gate: false } })}\n`);
  write(root, `${DC_PHASE}/01-01-PLAN.md`, '<objective>Anything</objective>\n');
}

function buildCapFiles(root) {
  write(root, '.planning/config.json', '{}\n');
  const phase = '.planning/phases/01-caps';
  write(root, `${phase}/CONTEXT.md`, decisionsContext([
    '- **D-01:** Alpha rule',
    '- **D-02:** Beta rule',
    '- **D-03:** Gamma rule',
  ]));
  const files = [];
  for (let i = 1; i <= 51; i++) {
    const rel = `src/f${String(i).padStart(2, '0')}.txt`;
    files.push(rel);
    const marker = { 49: ' D-01 ', 50: ' D-02 ', 51: ' D-03 ' }[i] || '';
    write(root, rel, `filler ${i}${marker}\n`);
  }
  write(root, `${phase}/01-01-SUMMARY.md`, `---\nphase: 01\nfiles_modified:\n${files.map((f) => `  - ${f}`).join('\n')}\n---\n\nNo decision ids here.\n`);
  commit(makeGit(root), root, 'feat: init scaffold');
}

const CAP_BYTES = 256 * 1024;

function buildCapBytes(root) {
  write(root, '.planning/config.json', '{}\n');
  const phase = '.planning/phases/01-caps';
  write(root, `${phase}/CONTEXT.md`, decisionsContext([
    '- **D-01:** Alpha rule',
    '- **D-02:** Beta rule',
    '- **D-03:** Gamma rule',
  ]));
  const sizes = [CAP_BYTES - 1, CAP_BYTES, CAP_BYTES + 1];
  const files = sizes.map((size, i) => {
    const rel = `src/big${i + 1}.txt`;
    const marker = ` D-0${i + 1}`;
    write(root, rel, `${'x'.repeat(size - marker.length)}${marker}`);
    return rel;
  });
  write(root, `${phase}/01-01-SUMMARY.md`, `---\nphase: 01\nfiles_modified:\n${files.map((f) => `  - ${f}`).join('\n')}\n---\n\nNo decision ids here.\n`);
  commit(makeGit(root), root, 'feat: init scaffold');
}

const ROADMAP = [
  '# Project Roadmap',
  '',
  '## Phase 1: Frontend Dashboard',
  '',
  'Build the user interface and dashboard components for the frontend.',
  '',
  '## Phase 2: API Backend',
  '',
  'Add a REST API endpoint and database migration for the user table.',
  '',
  '## Phase 3: Frontend Forms',
  '',
  'Build the frontend dashboard with React components and UI forms.',
  '',
].join('\n');

function buildUi({ withEvidence, uiFileInLastCommit }) {
  return (root) => {
    write(root, '.planning/config.json', '{}\n');
    write(root, '.planning/ROADMAP.md', ROADMAP);
    write(root, '.planning/phases/01-frontend-dashboard/01-01-PLAN.md', '# plan one\n');
    write(root, '.planning/phases/02-api-backend/02-01-PLAN.md', '# plan two\n');
    write(root, '.planning/phases/03-frontend-forms/03-01-PLAN.md', '# plan three\n');
    write(root, '.planning/phases/03-frontend-forms/03-UI-SPEC.md', '# UI Design Contract\n');
    if (withEvidence) {
      write(root, 'package.json', `${JSON.stringify({ name: 'demo', dependencies: { react: '18.0.0' } }, null, 2)}\n`);
    }
    const git = makeGit(root);
    commit(git, root, 'chore: scaffold');
    if (uiFileInLastCommit) {
      write(root, 'src/components/App.tsx', 'export const App = () => null;\n');
    } else {
      write(root, 'README.md', '# readme\n');
    }
    commit(git, root, 'feat: last commit');
  };
}

function tddPlan(planId, type) {
  return `---\ntype: ${type}\nphase: ${planId.slice(0, 2)}\nslug: ${planId}\n---\n# Task: ${planId}\n`;
}

function buildTdd(root) {
  write(root, '.planning/config.json', '{}\n');
  write(root, '.planning/phases/01-tdd-pass/01-01-PLAN.md', tddPlan('01-01', 'tdd'));
  write(root, '.planning/phases/02-tdd-mixed/02-01-PLAN.md', tddPlan('02-01', 'tdd'));
  write(root, '.planning/phases/02-tdd-mixed/02-02-PLAN.md', tddPlan('02-02', 'tdd'));
  write(root, '.planning/phases/03-execute-only/03-01-PLAN.md', tddPlan('03-01', 'execute'));
  write(root, '.planning/phases/04-red-only/04-01-PLAN.md', tddPlan('04-01', 'tdd'));
  const git = makeGit(root);
  commit(git, root, 'init: project scaffold');
  commit(git, root, 'test(01-01): red');
  commit(git, root, 'feat(01-01): green');
  commit(git, root, 'refactor(01-01): tidy');
  commit(git, root, 'test(02-01): red');
  commit(git, root, 'feat(02-01): green');
  commit(git, root, 'test(04-01): red');
}

const RED_OK = {
  command: 'node --test tests/add.test.cjs',
  exitCode: 1,
  output: [
    'TAP version 13',
    '# Subtest: adds numbers',
    'not ok 1 - adds numbers',
    '  ---',
    '  duration_ms: 1.15',
    "  error: 'Expected values to be strictly equal. 1 !== 2'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
    '1..1',
    '# tests 1',
    '# suites 0',
    '# pass 0',
    '# fail 1',
    '',
  ].join('\n'),
  targetTest: 'adds numbers',
  targetFile: 'tests/add.test.cjs',
  expected: '2',
  actual: '1',
};

function buildRed(root) {
  write(root, 'records/ok.json', `${JSON.stringify(RED_OK, null, 2)}\n`);
  write(root, 'records/exit-zero.json', `${JSON.stringify({ ...RED_OK, exitCode: 0 }, null, 2)}\n`);
  write(root, 'records/zero-tests.json', `${JSON.stringify({
    ...RED_OK,
    output: 'TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n',
  }, null, 2)}\n`);
  write(root, 'records/not-json.json', 'this is { not json\n');
  write(root, 'records/empty-object.json', '{}\n');
}

function buildVerifyProbe(root) {
  write(root, '.planning/config.json', '{}\n');
  write(root, 'web/package.json', `${JSON.stringify({ name: 'web', scripts: { test: 'node --version' } })}\n`);
  write(root, '.planning/phases/01-verify/01-01-PLAN.md', [
    '# Plan',
    '',
    '<task type="auto">',
    '<name>Run web tests</name>',
    '<verify><automated>cd web && npm test</automated><fails_when>non-zero exit</fails_when></verify>',
    '</task>',
    '',
    '<task type="auto">',
    '<name>Lint the missing package</name>',
    '<verify><automated>npm run lint --prefix ./missing</automated></verify>',
    '</task>',
    '',
  ].join('\n'));
  write(root, '.planning/phases/02-clean/02-01-PLAN.md', [
    '# Plan',
    '',
    '<task type="auto">',
    '<name>Run web tests</name>',
    '<verify><automated>cd web && npm test</automated><fails_when>non-zero exit</fails_when></verify>',
    '</task>',
    '',
  ].join('\n'));
}

function buildGap(config) {
  return (root) => {
    write(root, '.planning/config.json', `${JSON.stringify(config)}\n`);
    write(root, '.planning/REQUIREMENTS.md', [
      '# Requirements',
      '',
      '- [ ] **REQ-01** Users can sign in',
      '- [ ] **REQ-02** Users can sign out',
      '- [ ] **REQ-03** Users can reset a password',
      '',
    ].join('\n'));
    write(root, '.planning/phases/01-gap/CONTEXT.md', decisionsContext(['- **D-01:** Adopt strict typing']));
    write(root, '.planning/phases/01-gap/01-01-PLAN.md', [
      '---',
      'phase: 01',
      'requirements: [REQ-01]',
      '---',
      '',
      '<objective>Implement D-01 and REQ-01 sign in</objective>',
      '',
    ].join('\n'));
  };
}

function buildPredicate(root) {
  write(root, '.planning/config.json', '{}\n');
  write(root, '.planning/phases/01-pred/STATUS.md', '---\nstatus: done\n---\n# Status\n');
}

const API_PHASES = '.planning/phases';
const API_MATRIX_OK = '| capability | decision | reason |\n|---|---|---|\n| charge | INTEGRATE | |\n| refund | OPT-OUT | not needed yet |\n';
const API_MATRIX_BAD = '| capability | decision | reason |\n|---|---|---|\n| refund | OPT-OUT | |\n';
const API_PLAN_INTEGRATION = '# Plan\nIntegrate the Stripe API for payment processing.\n';
const API_PLAN_PLAIN = '# Plan\nRefactor the auth helper to use bcrypt.\n';

function buildApi(root) {
  write(root, '.planning/config.json', `${JSON.stringify({ workflow: { api_coverage_gate: true } })}\n`);
  write(root, `${API_PHASES}/01-detected/01-01-PLAN.md`, API_PLAN_INTEGRATION);
  write(root, `${API_PHASES}/02-plain/02-01-PLAN.md`, API_PLAN_PLAIN);
  write(root, `${API_PHASES}/03-matrix-ok/03-01-PLAN.md`, API_PLAN_INTEGRATION);
  write(root, `${API_PHASES}/03-matrix-ok/COVERAGE.md`, API_MATRIX_OK);
  write(root, `${API_PHASES}/04-matrix-bad/04-01-PLAN.md`, API_PLAN_INTEGRATION);
  write(root, `${API_PHASES}/04-matrix-bad/COVERAGE.md`, API_MATRIX_BAD);
  write(root, `${API_PHASES}/05-none-declared/05-01-PLAN.md`, API_PLAN_PLAIN);
  write(root, `${API_PHASES}/05-none-declared/COVERAGE.md`, '**No external API integration**: this phase is internal only\n');
  write(root, `${API_PHASES}/06-none-override/06-01-PLAN.md`, API_PLAN_INTEGRATION);
  write(root, `${API_PHASES}/06-none-override/COVERAGE.md`, '**No external API integration**: we only mock it\n');
  write(root, `${API_PHASES}/07-multi/07-01-PLAN.md`, API_PLAN_INTEGRATION);
  write(root, `${API_PHASES}/07-multi/a-COVERAGE.md`, API_MATRIX_OK);
  write(root, `${API_PHASES}/07-multi/b-COVERAGE.md`, API_MATRIX_OK);
  write(root, `${API_PHASES}/08-empty/keep.txt`, 'no plan and no roadmap section\n');
  write(root, `${API_PHASES}/09-suffixed/09-01-PLAN.md`, API_PLAN_PLAIN);
  write(root, `${API_PHASES}/09-suffixed/09-COVERAGE.md`, API_MATRIX_OK);
}

function buildApiNoPhases(root) {
  write(root, '.planning/config.json', `${JSON.stringify({ workflow: { api_coverage_gate: true } })}\n`);
}

function buildAuto(config) {
  return (root) => write(root, '.planning/config.json', `${JSON.stringify(config)}\n`);
}

function buildBare(root) {
  write(root, '.planning/config.json', '{}\n');
}

// ─── #5219 (ADR-5057 §4 arm C): the four drift / prohibition `check` gates ───────────────────────
//
// Commit dates are pinned so a fixture's commit shas, and the `last_mapped_commit` stamps derived from
// them, are identical on every machine: the goldens carry them.

const FIXED_DATE = '2026-01-01T00:00:00+00:00';
const LATER_DATE = '2026-03-01T00:00:00+00:00';

/** A git repository whose commits are dated `date` (pin both author and committer). */
function makeDatedGit(root) {
  const base = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
  };
  const run = (date, ...args) => gitOrThrow(args, { cwd: root, env: { ...base, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
  run(FIXED_DATE, 'init', '--initial-branch=main');
  run(FIXED_DATE, 'config', 'user.email', 'test@test.com');
  run(FIXED_DATE, 'config', 'user.name', 'Test');
  run(FIXED_DATE, 'config', 'commit.gpgsign', 'false');
  return (date, message) => {
    run(date, 'add', '-A');
    run(date, 'commit', '--allow-empty', '-m', message);
    return run(date, 'rev-parse', 'HEAD');
  };
}

const PLAN_FILES = (files) => `---\nphase: 01\nfiles_modified:\n${files.map((f) => `  - ${f}`).join('\n')}\n---\n\n# Plan\n`;

function buildSchemaDrift(root) {
  write(root, '.planning/config.json', '{}\n');
  write(root, 'prisma/schema.prisma', 'model User { id Int @id }\n');
  write(root, '.planning/phases/01-schema/01-01-PLAN.md', PLAN_FILES(['prisma/schema.prisma']));
  write(root, '.planning/phases/02-clean/02-01-PLAN.md', PLAN_FILES(['src/a.js']));
  write(root, '.planning/phases/03-pushed/03-01-PLAN.md', PLAN_FILES(['prisma/schema.prisma']));
  write(root, '.planning/phases/03-pushed/03-01-SUMMARY.md', '---\nphase: 03\n---\n\nRan `npx prisma db push` against the dev database.\n');
  makeDatedGit(root)(FIXED_DATE, 'chore: scaffold');
}

function buildContextDrift(action) {
  return (root) => {
    write(root, '.planning/config.json', `${JSON.stringify(action === undefined ? {} : { workflow: { context_drift_action: action } })}\n`);
    write(root, '.planning/phases/01-stale/01-RESEARCH.md', '# research\n');
    write(root, '.planning/phases/02-sync/02-CONTEXT.md', '# context\n');
    write(root, '.planning/phases/02-sync/02-RESEARCH.md', '# research\n');
    write(root, '.planning/phases/03-nocontext/03-RESEARCH.md', '# research\n');
    write(root, '.planning/phases/04-noupstream/04-CONTEXT.md', '# context\n');
    const commitAt = makeDatedGit(root);
    commitAt(FIXED_DATE, 'chore: research and baseline context');
    write(root, '.planning/phases/01-stale/01-CONTEXT.md', '# context decided later\n');
    commitAt(LATER_DATE, 'docs: decide context after research');
  };
}

const UNRESOLVABLE_SHA = '0123456789abcdef0123456789abcdef01234567';
const STRUCTURE_BODY = '# Structure\n\n- `src/` application sources\n';

/** `stamp`: how STRUCTURE.md names its baseline; `extraDirs`: new top-level dirs added after it. */
function buildCodebaseDrift({ git = true, stamp = 'none', extraDirs = [], dirDocument = false }) {
  return (root) => {
    write(root, '.planning/config.json', '{}\n');
    if (stamp === 'absent-file') return;
    write(root, '.planning/codebase/STRUCTURE.md', STRUCTURE_BODY);
    write(root, 'src/main.js', 'main\n');
    if (!git) return;
    const commitAt = makeDatedGit(root);
    const baseline = commitAt(FIXED_DATE, 'feat: baseline');
    const tree = gitOrThrow(['rev-parse', `${baseline}^{tree}`], { cwd: root }).trim();
    const stampValue = {
      none: null,
      fake: UNRESOLVABLE_SHA,
      tree,
      head: baseline,
      // #5219 (f): stamps that are not an object id spelled in full, or are not a hex id at all.
      ref: 'HEAD',
      option: '--batch',
      upper: baseline.toUpperCase(),
      short7: baseline.slice(0, 7),
      short6: baseline.slice(0, 6),
      fake64: 'f'.repeat(64),
    }[stamp];
    if (stampValue !== null) {
      write(root, '.planning/codebase/STRUCTURE.md', `---\nlast_mapped_commit: ${stampValue}\n---\n${STRUCTURE_BODY}`);
    }
    if (dirDocument) write(root, '.planning/codebase/ARCHITECTURE.md/keep.txt', 'a directory where a document is expected\n');
    commitAt(FIXED_DATE, 'docs: stamp the map');
    for (const dir of extraDirs) write(root, `${dir}/index.js`, `${dir}\n`);
    if (extraDirs.length > 0) commitAt(FIXED_DATE, 'feat: add directories');
  };
}

const PROHIBITION_REQUEST = { prohibition: { verification: 'test', text: 'never log secrets' }, check: null };

function buildProhibition(root) {
  write(root, '.planning/config.json', '{}\n');
  write(root, 'req/located-false.json', `${JSON.stringify(PROHIBITION_REQUEST)}\n`);
  write(root, 'req/judgment.json', `${JSON.stringify({ prohibition: { verification: 'judgment', text: 'prefer clarity' }, check: { kind: 'unknown-kind', target: 't' }, mode: 'interactive' })}\n`);
  write(root, 'req/not-json.json', '{not json\n');
}

const FIXTURES = {
  'schema-drift': buildSchemaDrift,
  'ctx-drift': buildContextDrift(undefined),
  'ctx-drift-block': buildContextDrift('block'),
  'cb-no-map': buildCodebaseDrift({ stamp: 'absent-file' }),
  'cb-no-git': buildCodebaseDrift({ git: false }),
  'cb-no-stamp': buildCodebaseDrift({ stamp: 'none' }),
  'cb-fake-stamp': buildCodebaseDrift({ stamp: 'fake' }),
  'cb-tree-stamp': buildCodebaseDrift({ stamp: 'tree' }),
  'cb-clean': buildCodebaseDrift({ stamp: 'head' }),
  'cb-below': buildCodebaseDrift({ stamp: 'head', extraDirs: ['alpha'] }),
  'cb-block': buildCodebaseDrift({ stamp: 'head', extraDirs: ['alpha', 'beta', 'gamma'] }),
  'cb-doc-unreadable': buildCodebaseDrift({ stamp: 'head', dirDocument: true }),
  'cb-ref-stamp': buildCodebaseDrift({ stamp: 'ref', extraDirs: ['alpha', 'beta', 'gamma'] }),
  'cb-option-stamp': buildCodebaseDrift({ stamp: 'option', extraDirs: ['alpha', 'beta', 'gamma'] }),
  'cb-upper-stamp': buildCodebaseDrift({ stamp: 'upper', extraDirs: ['alpha', 'beta', 'gamma'] }),
  'cb-short7-stamp': buildCodebaseDrift({ stamp: 'short7', extraDirs: ['alpha', 'beta', 'gamma'] }),
  'cb-short6-stamp': buildCodebaseDrift({ stamp: 'short6', extraDirs: ['alpha', 'beta', 'gamma'] }),
  'cb-fake64-stamp': buildCodebaseDrift({ stamp: 'fake64' }),
  prohibition: buildProhibition,
  dc: buildDecisionCoverage,
  'dc-disabled': buildDecisionCoverageDisabled,
  'cap-files': buildCapFiles,
  'cap-bytes': buildCapBytes,
  ui: buildUi({ withEvidence: true, uiFileInLastCommit: true }),
  'ui-plain': buildUi({ withEvidence: false, uiFileInLastCommit: false }),
  tdd: buildTdd,
  red: buildRed,
  vp: buildVerifyProbe,
  gap: buildGap({}),
  'gap-disabled': buildGap({ workflow: { post_planning_gaps: false } }),
  pred: buildPredicate,
  api: buildApi,
  'api-no-phases': buildApiNoPhases,
  'auto-both': buildAuto({ workflow: { auto_advance: true, _auto_chain_active: true } }),
  'auto-none': buildAuto({}),
  'auto-advance': buildAuto({ workflow: { auto_advance: true } }),
  'auto-chain': buildAuto({ workflow: { _auto_chain_active: true } }),
  bare: buildBare,
};

// ─── arms ─────────────────────────────────────────────────────────────────────

const arms = [];

/**
 * @param {string} gate     census gate label (E1..E11 / auto-mode / R2 / R4)
 * @param {string} id       golden file basename
 * @param {string} fixture  key of FIXTURES
 * @param {string} verb     check verb (dotted or hyphenated)
 * @param {string[]} args   argv after the verb
 * @param {object} [extra]  { failRead: '<path suffix>', env: { NAME: 'value' } }
 */
function arm(gate, id, fixture, verb, args, extra = {}) {
  arms.push({ gate, id, fixture, argv: ['query', `check.${verb}`, ...args], ...extra });
}

/** An arm whose argv is not a `check` query (the `verify` surface of the same gates). */
function armArgv(gate, id, fixture, argv, extra = {}) {
  arms.push({ gate, id, fixture, argv, ...extra });
}

const P = DC_PHASE;

// E1 decision-coverage-plan
arm('E1', 'decision-coverage-plan-disabled', 'dc-disabled', 'decision-coverage-plan', [DC_PHASE, `${DC_PHASE}/CONTEXT.md`]);
arm('E1', 'decision-coverage-plan-missing-context-arg', 'dc', 'decision-coverage-plan', [P]);
arm('E1', 'decision-coverage-plan-context-absent', 'dc', 'decision-coverage-plan', [P, `${P}/CONTEXT-nonexistent.md`]);
arm('E1', 'decision-coverage-plan-context-is-directory', 'dc', 'decision-coverage-plan', [P, `${P}/ctxdir`]);
arm('E1', 'decision-coverage-plan-could-not-parse', 'dc', 'decision-coverage-plan', [P, `${P}/CONTEXT-unparsable.md`]);
arm('E1', 'decision-coverage-plan-could-not-parse-partial', 'dc', 'decision-coverage-plan', [P, `${P}/CONTEXT-partial.md`]);
arm('E1', 'decision-coverage-plan-no-trackable', 'dc', 'decision-coverage-plan', [P, `${P}/CONTEXT-empty.md`]);
arm('E1', 'decision-coverage-plan-uncovered', 'dc', 'decision-coverage-plan', [P, `${P}/CONTEXT.md`]);
arm('E1', 'decision-coverage-plan-all-covered', 'dc', 'decision-coverage-plan', [P, `${P}/CONTEXT-allcovered.md`]);
arm('E1', 'decision-coverage-plan-context-flag', 'dc', 'decision-coverage-plan', [P, '--context', `${P}/CONTEXT.md`]);
// #4939: a phase-dir argument that names no directory (the phase NUMBER, or a file) is a caller error, not a measured zero.
arm('E1', 'decision-coverage-plan-phase-dir-not-found', 'dc', 'decision-coverage-plan', ['1', `${P}/CONTEXT.md`]);
arm('E1', 'decision-coverage-plan-phase-dir-is-file', 'dc', 'decision-coverage-plan', [`${P}/CONTEXT.md`, `${P}/CONTEXT.md`]);
arm('E1', 'decision-coverage-plan-path-escape', 'dc', 'decision-coverage-plan', ['../../outside', `${P}/CONTEXT.md`]);
arm('E1', 'decision-coverage-plan-dotted-verb', 'dc', 'decision.coverage.plan', [P, `${P}/CONTEXT.md`]);

// E2 decision-coverage-verify
arm('E2', 'decision-coverage-verify-disabled', 'dc-disabled', 'decision-coverage-verify', [DC_PHASE, `${DC_PHASE}/CONTEXT.md`]);
arm('E2', 'decision-coverage-verify-context-missing', 'dc', 'decision-coverage-verify', [P]);
arm('E2', 'decision-coverage-verify-context-absent', 'dc', 'decision-coverage-verify', [P, `${P}/CONTEXT-nonexistent.md`]);
arm('E2', 'decision-coverage-verify-could-not-parse', 'dc', 'decision-coverage-verify', [P, `${P}/CONTEXT-unparsable.md`]);
arm('E2', 'decision-coverage-verify-could-not-parse-partial', 'dc', 'decision-coverage-verify', [P, `${P}/CONTEXT-partial.md`]);
arm('E2', 'decision-coverage-verify-no-trackable', 'dc', 'decision-coverage-verify', [P, `${P}/CONTEXT-empty.md`]);
arm('E2', 'decision-coverage-verify-final', 'dc', 'decision-coverage-verify', [P, `${P}/CONTEXT-verify.md`]);
arm('E2', 'decision-coverage-verify-phase-dir-not-found', 'dc', 'decision-coverage-verify', ['1', `${P}/CONTEXT.md`]);
arm('E2', 'decision-coverage-verify-phase-dir-is-file', 'dc', 'decision-coverage-verify', [`${P}/CONTEXT.md`, `${P}/CONTEXT.md`]);
arm('E2', 'decision-coverage-verify-path-escape', 'dc', 'decision-coverage-verify', ['../../outside', `${P}/CONTEXT.md`]);

// R4 readModifiedFilesContent caps (through decision-coverage-verify)
arm('R4', 'r4-files-cap-limit-minus-1-and-limit-and-limit-plus-1', 'cap-files', 'decision-coverage-verify', ['.planning/phases/01-caps', '.planning/phases/01-caps/CONTEXT.md']);
arm('R4', 'r4-bytes-cap-limit-minus-1-and-limit-and-limit-plus-1', 'cap-bytes', 'decision-coverage-verify', ['.planning/phases/01-caps', '.planning/phases/01-caps/CONTEXT.md']);

// E3 ui-plan-gate (+ R2 phase-lookup behaviour table)
arm('E3', 'ui-plan-gate-frontend-no-spec-blocks', 'ui', 'ui-plan-gate', ['1']);
arm('E3', 'ui-plan-gate-frontend-with-spec', 'ui', 'ui-plan-gate', ['3']);
arm('E3', 'ui-plan-gate-non-frontend', 'ui', 'ui-plan-gate', ['2']);
arm('E3', 'ui-plan-gate-frontend-without-evidence', 'ui-plain', 'ui-plan-gate', ['1']);
arm('E3', 'ui-plan-gate-missing-arg', 'ui', 'ui-plan-gate', []);
arm('R2', 'r2-ui-plan-gate-numeric', 'ui', 'ui-plan-gate', ['1']);
arm('R2', 'r2-ui-plan-gate-zero-padded', 'ui', 'ui-plan-gate', ['01']);
arm('R2', 'r2-ui-plan-gate-missing-phase', 'ui', 'ui-plan-gate', ['99']);
arm('R2', 'r2-ui-plan-gate-escapes-planning', 'ui', 'ui-plan-gate', ['../../../etc']);

// E4 ui-safety-gate (+ R2)
arm('E4', 'ui-safety-gate-blocks', 'ui', 'ui-safety-gate', ['1']);
arm('E4', 'ui-safety-gate-with-spec', 'ui', 'ui-safety-gate', ['3']);
arm('E4', 'ui-safety-gate-non-frontend', 'ui', 'ui-safety-gate', ['2']);
arm('E4', 'ui-safety-gate-no-ui-files', 'ui-plain', 'ui-safety-gate', ['1']);
arm('E4', 'ui-safety-gate-missing-arg', 'ui', 'ui-safety-gate', []);
arm('R2', 'r2-ui-safety-gate-numeric', 'ui', 'ui-safety-gate', ['1']);
arm('R2', 'r2-ui-safety-gate-zero-padded', 'ui', 'ui-safety-gate', ['01']);
arm('R2', 'r2-ui-safety-gate-missing-phase', 'ui', 'ui-safety-gate', ['99']);
arm('R2', 'r2-ui-safety-gate-escapes-planning', 'ui', 'ui-safety-gate', ['../../../etc']);

// E5 tdd-review-checkpoint (+ R2)
arm('E5', 'tdd-review-checkpoint-pass', 'tdd', 'tdd-review-checkpoint', ['1']);
arm('E5', 'tdd-review-checkpoint-mixed-violation', 'tdd', 'tdd-review-checkpoint', ['2']);
arm('E5', 'tdd-review-checkpoint-no-tdd-plans', 'tdd', 'tdd-review-checkpoint', ['3']);
arm('E5', 'tdd-review-checkpoint-red-only', 'tdd', 'tdd-review-checkpoint', ['4']);
arm('E5', 'tdd-review-checkpoint-missing-arg', 'tdd', 'tdd-review-checkpoint', []);
arm('R2', 'r2-tdd-review-checkpoint-numeric', 'tdd', 'tdd-review-checkpoint', ['1']);
arm('R2', 'r2-tdd-review-checkpoint-zero-padded', 'tdd', 'tdd-review-checkpoint', ['01']);
arm('R2', 'r2-tdd-review-checkpoint-missing-phase', 'tdd', 'tdd-review-checkpoint', ['99']);
arm('R2', 'r2-tdd-review-checkpoint-escapes-planning', 'tdd', 'tdd-review-checkpoint', ['../../../etc']);

// E6 tdd-red-evidence
arm('E6', 'tdd-red-evidence-ok', 'red', 'tdd-red-evidence', ['records/ok.json']);
arm('E6', 'tdd-red-evidence-invalid-exit-zero', 'red', 'tdd-red-evidence', ['records/exit-zero.json']);
arm('E6', 'tdd-red-evidence-invalid-zero-tests', 'red', 'tdd-red-evidence', ['records/zero-tests.json']);
arm('E6', 'tdd-red-evidence-empty-object', 'red', 'tdd-red-evidence', ['records/empty-object.json']);
arm('E6', 'tdd-red-evidence-record-not-found', 'red', 'tdd-red-evidence', ['records/absent.json']);
arm('E6', 'tdd-red-evidence-record-not-json', 'red', 'tdd-red-evidence', ['records/not-json.json']);
arm('E6', 'tdd-red-evidence-missing-arg', 'red', 'tdd-red-evidence', []);
// Added by the #5139 security review (NOT a pre-move capture): a record path that escapes the project
// directory is refused BEFORE it is read — the one deliberate behaviour change of the gate move.
arm('E6', 'tdd-red-evidence-path-escape', 'red', 'tdd-red-evidence', ['../../outside.json']);

// E7 verify-command-paths
arm('E7', 'verify-command-paths-no-arg', 'vp', 'verify-command-paths', []);
arm('E7', 'verify-command-paths-dir-escapes-root', 'vp', 'verify-command-paths', ['--dir', '../../..']);
arm('E7', 'verify-command-paths-phase-unresolved', 'vp', 'verify-command-paths', ['99']);
arm('E7', 'verify-command-paths-phase-findings', 'vp', 'verify-command-paths', ['1']);
arm('E7', 'verify-command-paths-phase-clean', 'vp', 'verify-command-paths', ['2']);
arm('E7', 'verify-command-paths-dir-flag', 'vp', 'verify-command-paths', ['--dir', '.planning/phases/01-verify']);

// E8 verify-failure-directions
arm('E8', 'verify-failure-directions-no-arg', 'vp', 'verify-failure-directions', []);
arm('E8', 'verify-failure-directions-phase-unresolved', 'vp', 'verify-failure-directions', ['99']);
arm('E8', 'verify-failure-directions-phase-findings', 'vp', 'verify-failure-directions', ['1']);
arm('E8', 'verify-failure-directions-phase-clean', 'vp', 'verify-failure-directions', ['2']);

// E9 gap-analysis-plan-post
arm('E9', 'gap-analysis-plan-post-enabled', 'gap', 'gap-analysis-plan-post', ['.planning/phases/01-gap', 'REQ-01,REQ-02']);
arm('E9', 'gap-analysis-plan-post-no-req-ids', 'gap', 'gap-analysis-plan-post', ['.planning/phases/01-gap']);
arm('E9', 'gap-analysis-plan-post-disabled', 'gap-disabled', 'gap-analysis-plan-post', ['.planning/phases/01-gap', 'REQ-01']);
arm('E9', 'gap-analysis-plan-post-missing-arg', 'gap', 'gap-analysis-plan-post', []);
arm('E9', 'gap-analysis-plan-post-path-escape', 'gap', 'gap-analysis-plan-post', ['../../outside']);

// E10 predicate
const PRED_DIR = '.planning/phases/01-pred';
arm('E10', 'predicate-command-passes', 'pred', 'predicate', ['--predicate', '{"kind":"command-exit-zero","command":"true"}']);
arm('E10', 'predicate-command-blocks', 'pred', 'predicate', ['--predicate', '{"kind":"command-exit-zero","command":"echo boom >&2; exit 3"}']);
arm('E10', 'predicate-command-interpolates-phase-number', 'pred', 'predicate', ['--predicate', '{"kind":"command-exit-zero","command":"test \\"${PHASE_NUMBER}\\" = \\"07\\""}', '--phase-number', '07']);
arm('E10', 'predicate-frontmatter-match', 'pred', 'predicate', ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"STATUS.md","field":"status","equals":"done"}', '--phase-dir', PRED_DIR]);
arm('E10', 'predicate-frontmatter-mismatch', 'pred', 'predicate', ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"STATUS.md","field":"status","equals":"open"}', '--phase-dir', PRED_DIR]);
arm('E10', 'predicate-frontmatter-artifact-not-found', 'pred', 'predicate', ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"NOPE.md","field":"status","equals":"done"}', '--phase-dir', PRED_DIR]);
arm('E10', 'predicate-usage-missing-predicate', 'pred', 'predicate', []);
arm('E10', 'predicate-usage-invalid-json', 'pred', 'predicate', ['--predicate', '{not json']);
arm('E10', 'predicate-usage-evaluator-threw', 'pred', 'predicate', ['--predicate', '{"kind":"no-such-kind"}']);
arm('E10', 'predicate-usage-phase-dir-escape', 'pred', 'predicate', ['--predicate', '{"kind":"command-exit-zero","command":"true"}', '--phase-dir', '../../outside']);

// E11 api-coverage-verify-pre
const API = '.planning/phases';
arm('E11', 'api-coverage-verify-pre-no-phases-dir', 'api-no-phases', 'api-coverage-verify-pre', ['01-any']);
arm('E11', 'api-coverage-verify-pre-phase-unresolved', 'api', 'api-coverage-verify-pre', ['99-missing']);
arm('E11', 'api-coverage-verify-pre-missing-arg', 'api', 'api-coverage-verify-pre', []);
arm('E11', 'api-coverage-verify-pre-coverage-unreadable', 'api', 'api-coverage-verify-pre', [`${API}/03-matrix-ok`], { failRead: '03-matrix-ok/COVERAGE.md' });
arm('E11', 'api-coverage-verify-pre-none-declared', 'api', 'api-coverage-verify-pre', [`${API}/05-none-declared`]);
arm('E11', 'api-coverage-verify-pre-none-declared-overrides-detection', 'api', 'api-coverage-verify-pre', [`${API}/06-none-override`]);
arm('E11', 'api-coverage-verify-pre-none-declared-scope-read-error', 'api', 'api-coverage-verify-pre', [`${API}/05-none-declared`], { failRead: '05-01-PLAN.md' });
arm('E11', 'api-coverage-verify-pre-matrix-valid', 'api', 'api-coverage-verify-pre', [`${API}/03-matrix-ok`]);
arm('E11', 'api-coverage-verify-pre-matrix-suffixed-valid', 'api', 'api-coverage-verify-pre', [`${API}/09-suffixed`]);
arm('E11', 'api-coverage-verify-pre-matrix-invalid', 'api', 'api-coverage-verify-pre', [`${API}/04-matrix-bad`]);
arm('E11', 'api-coverage-verify-pre-multiple-coverage-files', 'api', 'api-coverage-verify-pre', [`${API}/07-multi`]);
arm('E11', 'api-coverage-verify-pre-scope-read-error', 'api', 'api-coverage-verify-pre', [`${API}/01-detected`], { failRead: '01-01-PLAN.md' });
arm('E11', 'api-coverage-verify-pre-empty-scope', 'api', 'api-coverage-verify-pre', [`${API}/08-empty`]);
arm('E11', 'api-coverage-verify-pre-detected', 'api', 'api-coverage-verify-pre', [`${API}/01-detected`]);
arm('E11', 'api-coverage-verify-pre-no-integration', 'api', 'api-coverage-verify-pre', [`${API}/02-plain`]);
arm('E11', 'api-coverage-verify-pre-token-only', 'api', 'api-coverage-verify-pre', ['01-detected']);

// E12 verify-schema-drift (#5219)
arm('E12', 'verify-schema-drift-no-arg', 'schema-drift', 'verify-schema-drift', []);
arm('E12', 'verify-schema-drift-no-phases-dir', 'bare', 'verify-schema-drift', ['1']);
arm('E12', 'verify-schema-drift-phase-not-found', 'schema-drift', 'verify-schema-drift', ['99']);
arm('E12', 'verify-schema-drift-blocks', 'schema-drift', 'verify-schema-drift', ['1']);
arm('E12', 'verify-schema-drift-clean', 'schema-drift', 'verify-schema-drift', ['2']);
arm('E12', 'verify-schema-drift-pushed', 'schema-drift', 'verify-schema-drift', ['3']);
arm('E12', 'verify-schema-drift-env-skip', 'schema-drift', 'verify-schema-drift', ['1'], { env: { GSD_SKIP_SCHEMA_CHECK: 'true' } });
arm('E12', 'verify-schema-drift-env-not-true', 'schema-drift', 'verify-schema-drift', ['1'], { env: { GSD_SKIP_SCHEMA_CHECK: '1' } });
arm('E12', 'verify-schema-drift-plan-unreadable', 'schema-drift', 'verify-schema-drift', ['1'], { failRead: '01-schema/01-01-PLAN.md' });
arm('E12', 'verify-schema-drift-plan-unreadable-skipped', 'schema-drift', 'verify-schema-drift', ['1'], { failRead: '01-schema/01-01-PLAN.md', env: { GSD_SKIP_SCHEMA_CHECK: 'true' } });
arm('E12', 'verify-schema-drift-dotted-verb', 'schema-drift', 'verify.schema-drift', ['1']);
armArgv('E12', 'verify-surface-schema-drift-blocks', 'schema-drift', ['verify', 'schema-drift', '1']);
armArgv('E12', 'verify-surface-schema-drift-skip-flag', 'schema-drift', ['verify', 'schema-drift', '1', '--skip']);
armArgv('E12', 'verify-surface-schema-drift-skip-flag-first', 'schema-drift', ['verify', 'schema-drift', '--skip', '1']);
armArgv('E12', 'verify-surface-schema-drift-env-ignored', 'schema-drift', ['verify', 'schema-drift', '1'], { env: { GSD_SKIP_SCHEMA_CHECK: 'true' } });
armArgv('E12', 'verify-surface-schema-drift-no-arg', 'schema-drift', ['verify', 'schema-drift']);
// Added in the #5219 review round, captured from origin/next before the move was re-checked.
armArgv('E12', 'verify-surface-schema-drift-skip-flag-no-phase', 'schema-drift', ['verify', 'schema-drift', '--skip']);
// The usage failures under the two observable error modes (JSON diagnostics; exit contract v2): the
// reason code the gates pass is part of both.
const JSON_ERRORS = { GSD_JSON_ERRORS: '1' };
const CONTRACT_V2 = { GSD_EXIT_CONTRACT: 'v2' };
arm('E12', 'verify-schema-drift-no-arg-json-errors', 'schema-drift', 'verify-schema-drift', [], { env: JSON_ERRORS });
arm('E12', 'verify-schema-drift-no-arg-contract-v2', 'schema-drift', 'verify-schema-drift', [], { env: CONTRACT_V2 });
armArgv('E12', 'verify-surface-schema-drift-no-arg-json-errors', 'schema-drift', ['verify', 'schema-drift'], { env: JSON_ERRORS });
armArgv('E12', 'verify-surface-schema-drift-no-arg-contract-v2', 'schema-drift', ['verify', 'schema-drift'], { env: CONTRACT_V2 });

// E13 verify-codebase-drift (#5219)
arm('E13', 'verify-codebase-drift-no-structure-md', 'cb-no-map', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-not-a-git-repo', 'cb-no-git', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-no-mapped-commit', 'cb-no-stamp', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-unresolvable-mapped-commit', 'cb-fake-stamp', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-non-commit-baseline', 'cb-tree-stamp', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-clean', 'cb-clean', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-below-threshold', 'cb-below', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-blocks', 'cb-block', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-document-unreadable', 'cb-doc-unreadable', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-dotted-verb', 'cb-block', 'verify.codebase-drift', []);
armArgv('E13', 'verify-surface-codebase-drift-blocks', 'cb-block', ['verify', 'codebase-drift']);
// The stamp is validated as a hex object id before git sees it (#5219 review round): arms captured from
// origin/next, where a ref name or an abbreviation shorter than 7 was handed to `git cat-file`.
// `changed`: the golden is the origin/next behaviour; the move DELIBERATELY changes it (the stamp is no
// longer a hex object id), and the cutover test pins both the old golden and the new answer.
const STAMP_NOT_A_HEX_ID = { changed: { reason: 'unresolvable-mapped-commit', exitCode: 69 } };
arm('E13', 'verify-codebase-drift-stamp-ref-name', 'cb-ref-stamp', 'verify-codebase-drift', [], STAMP_NOT_A_HEX_ID);
arm('E13', 'verify-codebase-drift-stamp-option-shaped', 'cb-option-stamp', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-stamp-uppercase-hex', 'cb-upper-stamp', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-stamp-7-hex-abbreviation', 'cb-short7-stamp', 'verify-codebase-drift', []);
arm('E13', 'verify-codebase-drift-stamp-6-hex-abbreviation', 'cb-short6-stamp', 'verify-codebase-drift', [], STAMP_NOT_A_HEX_ID);
arm('E13', 'verify-codebase-drift-stamp-64-hex-unresolvable', 'cb-fake64-stamp', 'verify-codebase-drift', []);

// E14 verify-context-drift (#5219)
arm('E14', 'verify-context-drift-no-arg', 'ctx-drift', 'verify-context-drift', []);
arm('E14', 'verify-context-drift-no-phases-dir', 'bare', 'verify-context-drift', ['1']);
arm('E14', 'verify-context-drift-phase-not-found', 'ctx-drift', 'verify-context-drift', ['99']);
arm('E14', 'verify-context-drift-stale-warns', 'ctx-drift', 'verify-context-drift', ['1']);
arm('E14', 'verify-context-drift-stale-blocks', 'ctx-drift-block', 'verify-context-drift', ['1']);
arm('E14', 'verify-context-drift-in-sync', 'ctx-drift', 'verify-context-drift', ['2']);
arm('E14', 'verify-context-drift-no-context-md', 'ctx-drift', 'verify-context-drift', ['3']);
arm('E14', 'verify-context-drift-no-upstream-artifacts', 'ctx-drift', 'verify-context-drift', ['4']);
arm('E14', 'verify-context-drift-dotted-verb', 'ctx-drift', 'verify.context-drift', ['1']);
armArgv('E14', 'verify-surface-context-drift-stale-warns', 'ctx-drift', ['verify', 'context-drift', '1']);
armArgv('E14', 'verify-surface-context-drift-no-arg', 'ctx-drift', ['verify', 'context-drift']);
armArgv('E14', 'verify-surface-context-drift-stale-blocks', 'ctx-drift-block', ['verify', 'context-drift', '1']);
arm('E14', 'verify-context-drift-no-arg-json-errors', 'ctx-drift', 'verify-context-drift', [], { env: JSON_ERRORS });
arm('E14', 'verify-context-drift-no-arg-contract-v2', 'ctx-drift', 'verify-context-drift', [], { env: CONTRACT_V2 });

// E15 prohibition-enforcement (#5219)
arm('E15', 'prohibition-enforcement-no-arg', 'prohibition', 'prohibition-enforcement', []);
arm('E15', 'prohibition-enforcement-request-file-absent', 'prohibition', 'prohibition-enforcement', ['req/absent.json']);
arm('E15', 'prohibition-enforcement-request-not-json', 'prohibition', 'prohibition-enforcement', ['req/not-json.json']);
arm('E15', 'prohibition-enforcement-request-file-located-false', 'prohibition', 'prohibition-enforcement', ['req/located-false.json']);
arm('E15', 'prohibition-enforcement-request-file-judgment-mode', 'prohibition', 'prohibition-enforcement', ['req/judgment.json']);
arm('E15', 'prohibition-enforcement-json-flag', 'prohibition', 'prohibition-enforcement', ['--json', JSON.stringify(PROHIBITION_REQUEST)]);
arm('E15', 'prohibition-enforcement-json-flag-invalid', 'prohibition', 'prohibition-enforcement', ['--json', '{not json']);
arm('E15', 'prohibition-enforcement-json-flag-without-value', 'prohibition', 'prohibition-enforcement', ['--json']);
arm('E15', 'prohibition-enforcement-no-arg-json-errors', 'prohibition', 'prohibition-enforcement', [], { env: JSON_ERRORS });
arm('E15', 'prohibition-enforcement-no-arg-contract-v2', 'prohibition', 'prohibition-enforcement', [], { env: CONTRACT_V2 });

// auto-mode (non-gate)
arm('auto', 'auto-mode-both', 'auto-both', 'auto-mode', []);
arm('auto', 'auto-mode-none', 'auto-none', 'auto-mode', []);
arm('auto', 'auto-mode-auto-advance', 'auto-advance', 'auto-mode', []);
arm('auto', 'auto-mode-auto-chain', 'auto-chain', 'auto-mode', []);

// dispatcher
arm('dispatch', 'check-unknown-verb', 'bare', 'no-such-gate', []);

// ─── execution + normalisation ────────────────────────────────────────────────

function buildFixture(name) {
  const build = FIXTURES[name];
  if (!build) throw new Error(`unknown fixture: ${name}`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gsd-cutover-${name}-`)));
  build(root);
  return root;
}

/**
 * The ONE normaliser used by capture and comparison: every spelling of the temp
 * root (raw, realpath, Windows long/short name, JSON-escaped backslashes) ->
 * <TMP>, and path separators after it -> "/". Goldens stay POSIX text.
 */
function normalize(text, root) {
  return canonicalizeTempText(text, tempRootAliases(root), { token: '<TMP>' });
}

function runArm(spec, root) {
  const env = {
    ...process.env,
    ...TEST_ENV_BASE,
    HOME: root,
    USERPROFILE: root,
    GSD_CUTOVER_FAIL_READ_SUFFIX: spec.failRead || '',
    ...(spec.env || {}),
  };
  const nodeArgs = spec.failRead ? ['--require', PRELOAD_PATH] : [];
  const r = runNode([...nodeArgs, TOOLS_PATH, ...spec.argv], {
    cwd: root,
    env,
    timeoutMs: LOOP_HOOK_POINT_CLI_TIMEOUT_MS,
  });
  return {
    argv: spec.argv,
    fixture: spec.fixture,
    ...(spec.failRead ? { failRead: spec.failRead } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    stdout: normalize(r.stdout, root),
    stderr: normalize(r.stderr, root),
    exitCode: r.exitCode,
    outcome: r.outcome,
  };
}

module.exports = { arms, FIXTURES, buildFixture, runArm, normalize, TOOLS_PATH };
