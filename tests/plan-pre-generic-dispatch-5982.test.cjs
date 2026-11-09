'use strict';

/**
 * #5982: plan-phase §5.6 hand-rolled the plan:pre dispatch — `ref.skill` only under auto-chain,
 * `ref.agent`, and only the hardcoded UI/drift gates — so a resolved `ref.command` step, a manual-mode
 * skill step (mempalace-recall, #5960) or a third-party `check.predicate` / `check.query` gate was
 * listed in `loop render-hooks plan:pre` and then never run.
 *
 * The workflow prose is the installed contract the orchestrating LLM follows (Markdown, not a source
 * path, so local/no-source-grep does not apply), so the contract is asserted on that prose, and the
 * dedicated-section table it carries is held in parity with the real capability registry.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFileNormalized, installSpawnEnv, cleanup, createTempProject } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { LOOP_HOOK_POINT_CLI_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, 'gsd-core', 'workflows');
const PLAN_PHASE = path.join(WF, 'plan-phase.md');
const STEP_REL = 'gsd-core/workflows/plan-phase/steps/plan-pre-dispatch.md';
const STEP_FILE = path.join(ROOT, ...STEP_REL.split('/'));
const DISPATCH_REF = path.join(ROOT, 'gsd-core', 'references', 'loop-hook-dispatch.md');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

function section56() {
  const text = readFileNormalized(PLAN_PHASE);
  const start = text.indexOf('\n## 5.6. ');
  assert.ok(start !== -1, 'plan-phase.md must keep its ## 5.6. section');
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

function stepText() {
  assert.ok(fs.existsSync(STEP_FILE), `${STEP_REL} must exist`);
  return readFileNormalized(STEP_FILE);
}

/** Rows of the step file's dedicated-section table: | `capId` | §N.N | ... */
function dedicatedTable() {
  const rows = new Map();
  for (const line of stepText().split('\n')) {
    const m = line.match(/^\|\s*`([a-z0-9-]+)`\s*\|\s*§([0-9.]+)/);
    if (m) rows.set(m[1], m[2]);
  }
  return rows;
}

/** capIds of first-party capabilities that declare a plan:pre step or gate. */
function firstPartyPlanPreStepOrGate() {
  const capsDir = path.join(ROOT, 'capabilities');
  const ids = new Set();
  for (const id of fs.readdirSync(capsDir)) {
    const file = path.join(capsDir, id, 'capability.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const kind of ['steps', 'gates']) {
      for (const hook of manifest[kind] || []) {
        if (hook.point === 'plan:pre') ids.add(manifest.id);
      }
    }
  }
  return ids;
}

describe('#5982 plan:pre dispatches every active step and gate', () => {
  test('§5.6 delegates plan:pre dispatch to the step file', () => {
    assert.ok(section56().includes(STEP_REL), `§5.6 must read and execute ${STEP_REL}`);
    stepText();
  });

  test('generic dispatch runs before the UI branches can skip it', () => {
    const s = section56();
    const pointer = s.indexOf(STEP_REL);
    const branch2 = s.indexOf('**Branch 2');
    assert.ok(pointer !== -1 && branch2 !== -1, 'both the pointer and Branch 2 must be present');
    assert.ok(pointer < branch2, 'the generic dispatch must come before Branch 2 skips to step 6');
  });

  test('no §5 path jumps past the plan:pre dispatch to step 6', () => {
    // §5 research outcomes and §5.6's UI branches used to say "step 6", skipping §5.5–§5.65 (and with
    // them the generic dispatch, the security and UI gates, and the drift gate). Only Branch 1 (no active
    // plan:pre hook at all) may still go straight to step 6.
    const text = readFileNormalized(PLAN_PHASE);
    const from = text.indexOf('\n## 5. ');
    const to = text.indexOf('\n## 5.65. ');
    assert.ok(from !== -1 && to > from, 'plan-phase.md must keep ## 5. and ## 5.65.');
    const offenders = text.slice(from, to).split('\n')
      .filter((l) => /\bstep 6\b/i.test(l) && !/do not proceed/i.test(l) && !l.startsWith('**Branch 1'));
    assert.deepEqual(offenders, []);
  });

  test('the UI branches act only on the ui capability', () => {
    const s = section56();
    assert.ok(s.includes('`kind == "step"`, `capId == "ui"`'), 'Branch 5 must fire only the ui step (generic arm owns the rest)');
    assert.ok(s.includes('`kind == "gate"`, `capId == "ui"`'), 'Branch 6 must halt only on the ui gate result');
  });

  test('step dispatch is not gated on auto-chain', () => {
    assert.ok(
      !section56().includes('when pipeline mode allows auto-chaining'),
      '§5.6 must not condition ref.skill step dispatch on auto-chain (manual mode drops it)',
    );
  });

  test('the ref.command arm is the contract\'s own command line', () => {
    const contractLine = readFileNormalized(DISPATCH_REF).split('\n')
      .map((l) => l.trim()).find((l) => l.startsWith('gsd_run ${ref.command}'));
    assert.ok(contractLine, 'loop-hook-dispatch.md must define the ref.command line');
    assert.ok(stepText().includes(contractLine), `step file must run: ${contractLine}`);
  });

  test('gates dispatch by check shape: query and predicate', () => {
    const t = stepText();
    assert.ok(t.includes('gsd_run check ${hook.check.query}'), 'named-query gate arm missing');
    assert.ok(t.includes('gsd_run check predicate --predicate'), 'predicate gate arm missing');
  });

  test('the step file validates third-party ref.command and check before shell use', () => {
    const t = stepText();
    // Parity with the contract: every validation pattern loop-hook-dispatch.md names (the ref.command
    // one and the dot-normalized check.query one) must be the one the step file applies.
    const patterns = [];
    for (const line of readFileNormalized(DISPATCH_REF).split('\n')) {
      for (const m of line.matchAll(/`(\^\[a-z\][^`]{1,120}\$)`/g)) patterns.push(m[1]);
    }
    assert.equal(patterns.length, 2, `loop-hook-dispatch.md must name the step and gate patterns; got ${JSON.stringify(patterns)}`);
    for (const p of patterns) assert.ok(t.includes(p), `step file must validate with the contract pattern ${p}`);
    assert.ok(t.includes('single argv element'), 'predicate must be passed as a single argv element');
    assert.ok(t.includes('--predicate "$PREDICATE_JSON"'), 'predicate must reach argv through the quoted-heredoc variable');
    assert.ok(!t.includes("--predicate '"), 'predicate must never be re-quoted into a single-quoted shell literal');
    assert.ok(/agentVerdict[^\n]{0,200}\*\*never\*\* as a silent pass/.test(t),
      'an agentVerdict gate must be routed as a check failure, never silently passed');
  });

  test('every dedicated capId is real and its section exists', () => {
    const table = dedicatedTable();
    assert.ok(table.size > 0, 'step file must carry the dedicated-section table');
    const real = firstPartyPlanPreStepOrGate();
    // Two-way parity: every first-party plan:pre step/gate is either owned by a dedicated section or
    // deliberately generic. A new one must be placed in one of the two, or it is run twice / never.
    const GENERIC = ['mempalace'];
    assert.deepEqual([...real].sort(), [...table.keys(), ...GENERIC].sort(),
      'first-party plan:pre step/gate capIds must equal the dedicated table plus the generic allowlist');
    const planPhase = readFileNormalized(PLAN_PHASE);
    for (const [capId, sectionNo] of table) {
      assert.ok(real.has(capId), `dedicated capId ${capId} declares no first-party plan:pre step or gate`);
      assert.ok(planPhase.includes(`\n## ${sectionNo}. `), `dedicated section §${sectionNo} (${capId}) has no heading in plan-phase.md`);
    }
    assert.ok(table.has('intel'), 'intel ref.command is run by §7.9 and must not be dispatched twice');
  });

  test('mempalace-recall is generic, not dedicated (#5960)', () => {
    assert.ok(firstPartyPlanPreStepOrGate().has('mempalace'), 'fixture assumption: mempalace has a plan:pre step');
    assert.ok(!dedicatedTable().has('mempalace'), 'mempalace has no dedicated section; the generic arm must own it');
  });

  test('registry parity: a resolved first-party step with no dedicated section reaches the generic arm', (t) => {
    const tmp = createTempProject('plan-pre-5982-');
    t.after(() => cleanup(tmp));
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ mempalace: { enabled: true } }), 'utf8');
    const r = runNode([GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmp, '--raw'], {
      cwd: tmp, env: installSpawnEnv(), timeoutMs: LOOP_HOOK_POINT_CLI_TIMEOUT_MS,
    });
    assert.equal(r.outcome, OUTCOME.EXITED, `render-hooks did not exit: ${r.outcome}`);
    assert.equal(r.exitCode, 0, `render-hooks failed: ${r.stderr}`);
    const hooks = JSON.parse(r.stdout.trim()).activeHooks;
    const table = dedicatedTable();
    const generic = hooks.filter((h) => (h.kind === 'step' || h.kind === 'gate') && !table.has(h.capId));
    assert.ok(generic.some((h) => h.capId === 'mempalace' && h.kind === 'step'),
      `mempalace step must resolve and fall to the generic arm; got ${JSON.stringify(hooks.map((h) => h.capId))}`);
  });
});
