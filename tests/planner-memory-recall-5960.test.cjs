/**
 * #5960 — mempalace's plan:pre recall step produces MEMORY-RECALL.md but the plan-phase §8 planner
 * prompt never named it, so the planner never read the recall output.
 *
 * Design: the plan:pre dispatch step file hands the declared `produces` files of the steps it
 * dispatched THIS run to the planner (PLAN_PRE_PRODUCTS), so a stale file from a run when recall was
 * enabled is not handed over once `mempalace.enabled` or `mempalace.recall_on_plan` is off (the recall
 * step is only active while `recall_on_plan` is on). §7 resolves the phase dir from INIT's
 * `expected_phase_dir` when `phase_dir` is null (a directory §2 created after INIT ran).
 *
 * The workflow Markdown is the installed contract the orchestrating LLM follows (Markdown, not a
 * source path, so local/no-source-grep does not apply). The shell snippets it carries are executed
 * under bash through the process seam, so path resolution is tested by behavior.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFileNormalized, createTempDir, createTempProject, installSpawnEnv, cleanup } = require('./helpers.cjs');
const { runHook, runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { LOOP_HOOK_POINT_CLI_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const PLAN_PHASE = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const STEP_FILE = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'plan-pre-dispatch.md');
const DISPATCH_REF = path.join(ROOT, 'gsd-core', 'references', 'loop-hook-dispatch.md');
const SHIP = path.join(ROOT, 'gsd-core', 'workflows', 'ship.md');
const VERIFY = path.join(ROOT, 'gsd-core', 'workflows', 'verify-work.md');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const PRODUCTS_MARKER = '# Plan:pre products (#5960)';
const PRODUCTS_HEADING = '## Products for the planner (#5960)';

/** The slice from `\n## <heading>` to the next `\n## `. */
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start !== -1, `missing section "## ${heading}"`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

function plannerRequiredReading() {
  const s = section(readFileNormalized(PLAN_PHASE), '8. Spawn gsd-planner Agent');
  const open = s.indexOf('<required_reading>');
  assert.ok(open !== -1, '§8 must carry <required_reading>');
  const close = s.indexOf('</required_reading>', open);
  assert.ok(close !== -1, '§8 must close </required_reading>');
  return s.slice(open, close);
}

/** Lines of the first ```bash fenced block in `text`. */
function firstBashBlock(text) {
  const lines = text.split('\n');
  const open = lines.findIndex((l) => l.startsWith('```bash'));
  assert.ok(open !== -1, 'a ```bash block must be present');
  const close = lines.findIndex((l, i) => i > open && l.startsWith('```'));
  assert.ok(close !== -1, 'the ```bash block must be closed');
  return lines.slice(open + 1, close);
}

/** The fenced bash block of the step file whose first line is the products marker. */
function productsBlock() {
  const lines = readFileNormalized(STEP_FILE).split('\n');
  const marker = lines.findIndex((l) => l === PRODUCTS_MARKER);
  assert.ok(marker !== -1, `the step file must carry a bash block starting "${PRODUCTS_MARKER}"`);
  assert.ok(lines[marker - 1].startsWith('```bash'), 'the products marker must open a ```bash block');
  const close = lines.findIndex((l, i) => i > marker && l.startsWith('```'));
  assert.ok(close !== -1, 'the products block must be closed');
  return lines.slice(marker, close);
}

function bashMissing(r) {
  return r.code === 'ENOENT' || r.outcome === 'spawn_failed';
}

/** Run `script` under bash through the process seam; skips the test and returns null when bash is absent. */
function runBashOrSkip(t, script, env) {
  const merged = { ...process.env, ...env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete merged[k];
  const r = runHook('-c', [script], { interpreter: 'bash', env: merged });
  if (bashMissing(r)) {
    t.skip('bash unavailable');
    return null;
  }
  return r;
}

const PHASE_DIR_PLACEHOLDER = '<PHASE_DIR from the phase-value block above>';

/**
 * Run the products snippet for `names`; returns the seam result or null. `phaseDir` fills both the
 * PHASE_DIR env var and the quoted heredoc unless `opts.inEnv` / `opts.heredoc` override them
 * (`inEnv: false` leaves PHASE_DIR unset, as in a fresh tool-call shell).
 */
function runProducts(t, names, phaseDir, opts = {}) {
  const inEnv = opts.inEnv !== false;
  const heredoc = opts.heredoc === undefined ? phaseDir : opts.heredoc;
  const body = productsBlock()
    .filter((l) => !l.startsWith('echo "PLAN_PRE_PRODUCTS='))
    .map((l) => {
      if (l === PHASE_DIR_PLACEHOLDER) return heredoc;
      return l.startsWith('PLAN_PRE_PRODUCES=') ? `PLAN_PRE_PRODUCES='${names}'` : l;
    })
    .join('\n');
  const script = `set -u\n${body}\nprintf '%s' "$PLAN_PRE_PRODUCTS"`;
  return runBashOrSkip(t, script, { PHASE_DIR: inEnv ? phaseDir : undefined });
}

function tempPhaseDir(t, prepare) {
  const dir = createTempDir('planner-recall-5960-');
  t.after(() => cleanup(dir));
  prepare(dir);
  return dir;
}

/** Run §7's first bash block with INIT set; prints "$PHASE_DIR_FOR_SPEC|$UI_SPEC_PATH". */
function runSection7(t, init) {
  const body = firstBashBlock(section(readFileNormalized(PLAN_PHASE), '7. Use Context Paths from INIT')).join('\n');
  assert.ok(body.includes('expected_phase_dir'), '§7 must fall back to expected_phase_dir');
  const script = `${body}\nprintf '%s|%s' "$PHASE_DIR_FOR_SPEC" "$UI_SPEC_PATH"`;
  return runBashOrSkip(t, script, { INIT: JSON.stringify(init) });
}

function toForwardSlashes(p) {
  return p.split(path.sep).join('/');
}

function activeHooksFor(t, config) {
  const tmp = createTempProject('planner-recall-5960-hooks-');
  t.after(() => cleanup(tmp));
  fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify(config), 'utf8');
  const r = runNode([GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmp, '--raw'], {
    cwd: tmp, env: installSpawnEnv(), timeoutMs: LOOP_HOOK_POINT_CLI_TIMEOUT_MS,
  });
  assert.equal(r.outcome, OUTCOME.EXITED, `render-hooks did not exit: ${r.outcome}`);
  assert.equal(r.exitCode, 0, `render-hooks failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim()).activeHooks;
}

function mempalaceSteps(hooks) {
  return hooks.filter((h) => h.capId === 'mempalace' && h.kind === 'step');
}

describe('#5960 planner reads the plan:pre memory recall', () => {
  test('planner required_reading names the plan:pre products, MEMORY-RECALL.md included', () => {
    assert.match(plannerRequiredReading(), /^- \{PLAN_PRE_PRODUCTS\} \(.*MEMORY-RECALL\.md.*if any\)/m);
  });

  describe('products snippet', () => {
    test('a present MEMORY-RECALL.md is handed over', (t) => {
      const dir = tempPhaseDir(t, (d) => fs.writeFileSync(path.join(d, 'MEMORY-RECALL.md'), 'x', 'utf8'));
      const r = runProducts(t, 'MEMORY-RECALL.md', dir);
      if (!r) return;
      assert.equal(r.stdout, `${dir}/MEMORY-RECALL.md`, r.summary + r.stderr);
    });

    test('a phase dir path containing a space is handed over intact', (t) => {
      const dir = tempPhaseDir(t, (d) => {
        fs.mkdirSync(path.join(d, 'phase dir'));
        fs.writeFileSync(path.join(d, 'phase dir', 'MEMORY-RECALL.md'), 'x', 'utf8');
      });
      const spaced = `${dir}/phase dir`;
      const r = runProducts(t, 'MEMORY-RECALL.md', spaced);
      if (!r) return;
      assert.equal(r.stdout, `${spaced}/MEMORY-RECALL.md`, r.summary + r.stderr);
    });

    test('the block echoes PLAN_PRE_PRODUCTS so the orchestrator can read it', () => {
      assert.ok(productsBlock().some((l) => l === 'echo "PLAN_PRE_PRODUCTS=${PLAN_PRE_PRODUCTS}"'));
    });

    test('PHASE_DIR absent from the environment is read from the heredoc', (t) => {
      const dir = tempPhaseDir(t, (d) => fs.writeFileSync(path.join(d, 'MEMORY-RECALL.md'), 'x', 'utf8'));
      const r = runProducts(t, 'MEMORY-RECALL.md', dir, { inEnv: false });
      if (!r) return;
      assert.equal(r.stdout, `${dir}/MEMORY-RECALL.md`, r.summary + r.stderr);
    });

    test('PHASE_DIR absent from both environment and heredoc warns and yields an empty list', (t) => {
      const r = runProducts(t, 'MEMORY-RECALL.md', '', { inEnv: false, heredoc: '' });
      if (!r) return;
      assert.equal(r.stdout, '', r.summary + r.stderr);
      assert.ok(r.stderr.includes('PHASE_DIR is empty'), r.summary + r.stderr);
    });

    test('the phase-value block prints PHASE_DIR for the products block to be filled from', () => {
      const lines = firstBashBlock(readFileNormalized(STEP_FILE));
      assert.ok(lines.includes('echo "PHASE_DIR=${PHASE_DIR}"'));
    });

    test('an absent file yields an empty list', (t) => {
      const dir = tempPhaseDir(t, () => {});
      const r = runProducts(t, 'MEMORY-RECALL.md', dir);
      if (!r) return;
      assert.equal(r.stdout, '', r.summary + r.stderr);
    });

    test('an empty PHASE_DIR yields an empty list', (t) => {
      const r = runProducts(t, 'MEMORY-RECALL.md', '');
      if (!r) return;
      assert.equal(r.stdout, '', r.summary + r.stderr);
    });

    test('a directory named MEMORY-RECALL.md is not a product', (t) => {
      const dir = tempPhaseDir(t, (d) => fs.mkdirSync(path.join(d, 'MEMORY-RECALL.md')));
      const r = runProducts(t, 'MEMORY-RECALL.md', dir);
      if (!r) return;
      assert.equal(r.stdout, '', r.summary + r.stderr);
    });

    test('only the produced files that exist are listed', (t) => {
      const dir = tempPhaseDir(t, (d) => fs.writeFileSync(path.join(d, 'B.md'), 'x', 'utf8'));
      const r = runProducts(t, 'A.md B.md', dir);
      if (!r) return;
      assert.equal(r.stdout, `${dir}/B.md`, r.summary + r.stderr);
    });

    test('several present products are comma-separated in order', (t) => {
      const dir = tempPhaseDir(t, (d) => {
        fs.writeFileSync(path.join(d, 'A.md'), 'x', 'utf8');
        fs.writeFileSync(path.join(d, 'B.md'), 'x', 'utf8');
      });
      const r = runProducts(t, 'A.md B.md', dir);
      if (!r) return;
      assert.equal(r.stdout, `${dir}/A.md, ${dir}/B.md`, r.summary + r.stderr);
    });
  });

  describe('§7 phase dir fallback', () => {
    test('falls back to expected_phase_dir when INIT has no phase_dir', (t) => {
      const dir = tempPhaseDir(t, (d) => fs.writeFileSync(path.join(d, '01-UI-SPEC.md'), 'x', 'utf8'));
      const fwd = toForwardSlashes(dir);
      const r = runSection7(t, { phase_dir: null, expected_phase_dir: fwd });
      if (!r) return;
      assert.equal(r.stdout, `${fwd}|${fwd}/01-UI-SPEC.md`, r.summary + r.stderr);
    });

    test('phase_dir wins over expected_phase_dir when both are set', (t) => {
      const dir = tempPhaseDir(t, (d) => fs.writeFileSync(path.join(d, '01-UI-SPEC.md'), 'x', 'utf8'));
      const other = tempPhaseDir(t, () => {});
      const fwd = toForwardSlashes(dir);
      const r = runSection7(t, { phase_dir: fwd, expected_phase_dir: toForwardSlashes(other) });
      if (!r) return;
      assert.equal(r.stdout, `${fwd}|${fwd}/01-UI-SPEC.md`, r.summary + r.stderr);
    });
  });

  describe('the recall step is active only while recall_on_plan is on', () => {
    test('enabled with default recall_on_plan: the recall step is active and produces MEMORY-RECALL.md', (t) => {
      const steps = mempalaceSteps(activeHooksFor(t, { mempalace: { enabled: true } }));
      const recall = steps.find((h) => h.ref && h.ref.skill === 'mempalace-recall');
      assert.ok(recall, `mempalace-recall step must be active; got ${JSON.stringify(steps)}`);
      assert.ok((recall.produces || []).includes('MEMORY-RECALL.md'), 'the step must declare MEMORY-RECALL.md');
    });

    test('recall_on_plan false: no mempalace step', (t) => {
      const steps = mempalaceSteps(activeHooksFor(t, { mempalace: { enabled: true, recall_on_plan: false } }));
      assert.deepEqual(steps, []);
    });

    test('default config (mempalace off): no mempalace step', (t) => {
      const steps = mempalaceSteps(activeHooksFor(t, {}));
      assert.deepEqual(steps, []);
    });

    test('mempalace disabled: no mempalace step', (t) => {
      const steps = mempalaceSteps(activeHooksFor(t, { mempalace: { enabled: false } }));
      assert.deepEqual(steps, []);
    });
  });

  test('products are handed over after dispatch and before the planner', () => {
    const step = readFileNormalized(STEP_FILE);
    const heading = step.indexOf(PRODUCTS_HEADING);
    const steps = step.indexOf('## Steps');
    const done = step.indexOf('When every remaining hook has been handled');
    assert.ok(heading !== -1 && steps !== -1 && done !== -1, 'all step-file anchors must be present');
    assert.ok(steps < heading && heading < done, `step-file order violated: ${[steps, heading, done].join(' < ')}`);
    const text = readFileNormalized(PLAN_PHASE);
    const s56 = text.indexOf('\n## 5.6. ');
    const s8 = text.indexOf('\n## 8. Spawn gsd-planner Agent');
    assert.ok(s56 !== -1 && s8 !== -1 && s56 < s8, 'plan-phase.md must order §5.6 before §8');
    assert.ok(section(text, '5.6. ').includes('plan-phase/steps/plan-pre-dispatch.md'));
  });

  test('inactive-hook paths state that PLAN_PRE_PRODUCTS stays empty', () => {
    const stepLine = readFileNormalized(STEP_FILE).split('\n').find((l) => l.startsWith('If no active `step` or `gate` remains'));
    assert.ok(stepLine, 'step file must carry the "If no active `step` or `gate` remains" sentence');
    assert.ok(stepLine.includes('`PLAN_PRE_PRODUCTS` stays empty'), stepLine);
    const branch1 = readFileNormalized(PLAN_PHASE).split('\n').find((l) => l.startsWith('**Branch 1 — all plan:pre hooks inactive'));
    assert.ok(branch1, 'plan-phase.md must carry Branch 1');
    assert.ok(branch1.includes('`PLAN_PRE_PRODUCTS` stays empty'), branch1);
  });

  test('skill-step dispatch is never gated on auto-chain', () => {
    const dispatchLine = readFileNormalized(DISPATCH_REF).split('\n').find((l) => l.includes('`ref.skill` present'));
    const shipLine = readFileNormalized(SHIP).split('\n').find((l) => l.startsWith('- If `ref.skill` is set'));
    const stepLine = readFileNormalized(STEP_FILE).split('\n').find((l) => l.startsWith('- **`ref.skill`**'));
    assert.ok(dispatchLine, 'loop-hook-dispatch.md must carry the "`ref.skill` present" line');
    assert.ok(shipLine, 'ship.md must carry the "- If `ref.skill` is set" line');
    assert.ok(stepLine, 'plan-pre-dispatch.md must carry the "- **`ref.skill`**" line');
    const flagClause = ', appending `--auto` to `args` only when `AUTO_CHAIN` is `true`';
    assert.ok(stepLine.includes(flagClause), 'step file must keep the --auto flag clause (it conditions a flag, not dispatch)');
    const stepDispatch = stepLine.replace(flagClause, '');
    const verifyLine = readFileNormalized(VERIFY).split('\n').find((l) => l.startsWith('**Generic step dispatch:**'));
    assert.ok(verifyLine, 'verify-work.md must carry the "**Generic step dispatch:**" line');
    assert.ok(verifyLine.includes('loop-hook-dispatch.md'), 'verify-work.md generic dispatch must cite loop-hook-dispatch.md');
    for (const line of [dispatchLine, shipLine, stepDispatch, verifyLine]) {
      assert.doesNotMatch(line, /auto[-_ ]?chain|pipeline mode|AUTO_CHAIN/i);
    }
  });

  test('dedicated ui and ai-integration arms stay auto-chain-only', () => {
    const s = section(readFileNormalized(PLAN_PHASE), '5.6. ');
    const branch5 = s.split('\n').find((l) => l.startsWith('**Branch 5 — `AUTO_CHAIN` is `true`'));
    assert.ok(branch5, 'Branch 5 must stay conditioned on AUTO_CHAIN');
    assert.ok(branch5.includes('capId == "ui"'), 'Branch 5 must act only on the ui capability');
    assert.ok(s.includes("In pipeline / `--auto` mode, invoke the hook's `ref.skill`"));
  });
});
