// allow-test-rule: source-text-is-the-product
// The workflow Markdown is the deployed contract the orchestrating LLM follows, so the contract is
// asserted on that prose (and on the shell snippet it carries, executed through the process seam).

/**
 * #5960 — mempalace's plan:pre recall step produces MEMORY-RECALL.md but the plan-phase §8 planner
 * prompt never named it, so the planner never read the recall output.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFileNormalized, createTempProject, cleanup } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');

const ROOT = path.join(__dirname, '..');
const PLAN_PHASE = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const STEP_FILE = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'plan-pre-dispatch.md');
const DISPATCH_REF = path.join(ROOT, 'gsd-core', 'references', 'loop-hook-dispatch.md');
const SHIP = path.join(ROOT, 'gsd-core', 'workflows', 'ship.md');
const MEMPALACE = path.join(ROOT, 'capabilities', 'mempalace', 'capability.json');

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

/** The MEMORY_RECALL_PATH shell snippet in §7, from its marker line to the first blank or fence line. */
function memoryRecallBlock() {
  const s = section(readFileNormalized(PLAN_PHASE), '7. Use Context Paths from INIT');
  const lines = s.split('\n');
  const from = lines.findIndex((l) => l.startsWith('# MemPalace recall (#5960)'));
  assert.ok(from !== -1, '§7 must carry the "# MemPalace recall (#5960)" shell snippet');
  const out = [];
  for (let i = from; i < lines.length; i++) {
    if (i > from && (lines[i] === '' || lines[i].startsWith('```'))) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** Run the §7 snippet under bash with PHASE_DIR_FOR_SPEC set; returns the seam result. */
function resolveMemoryRecallPath(phaseDirForSpec) {
  const script = `set -u\n${memoryRecallBlock()}\nprintf '%s' "$MEMORY_RECALL_PATH"`;
  return runHook('-c', [script], {
    interpreter: 'bash',
    env: { ...process.env, PHASE_DIR_FOR_SPEC: phaseDirForSpec },
  });
}

function withPhaseDir(t, prepare) {
  const tmp = createTempProject('planner-recall-5960-');
  t.after(() => cleanup(tmp));
  const phaseDir = path.join(tmp, 'phase');
  fs.mkdirSync(phaseDir);
  prepare(phaseDir);
  return phaseDir;
}

function bashMissing(r) {
  return r.code === 'ENOENT' || r.outcome === 'spawn_failed';
}

describe('#5960 planner reads the plan:pre memory recall', () => {
  test('planner required_reading names MEMORY-RECALL.md when present', () => {
    assert.match(plannerRequiredReading(), /^- \{MEMORY_RECALL_PATH\} \(.*MEMORY-RECALL\.md.*if exists\)/m);
  });

  test('MEMORY_RECALL_PATH resolves when the file exists', (t) => {
    const phaseDir = withPhaseDir(t, (d) => fs.writeFileSync(path.join(d, 'MEMORY-RECALL.md'), 'x', 'utf8'));
    const r = resolveMemoryRecallPath(phaseDir);
    if (bashMissing(r)) return t.skip('bash unavailable');
    assert.equal(r.stdout, `${phaseDir}/MEMORY-RECALL.md`, r.summary + r.stderr);
  });

  test('MEMORY_RECALL_PATH is empty when the file is absent', (t) => {
    const phaseDir = withPhaseDir(t, () => {});
    const r = resolveMemoryRecallPath(phaseDir);
    if (bashMissing(r)) return t.skip('bash unavailable');
    assert.equal(r.stdout, '', r.summary + r.stderr);
  });

  test('an empty phase_dir yields an empty path', (t) => {
    const r = resolveMemoryRecallPath('');
    if (bashMissing(r)) return t.skip('bash unavailable');
    assert.equal(r.stdout, '', r.summary + r.stderr);
  });

  test('a directory named MEMORY-RECALL.md is not reading', (t) => {
    const phaseDir = withPhaseDir(t, (d) => fs.mkdirSync(path.join(d, 'MEMORY-RECALL.md')));
    const r = resolveMemoryRecallPath(phaseDir);
    if (bashMissing(r)) return t.skip('bash unavailable');
    assert.equal(r.stdout, '', r.summary + r.stderr);
  });

  test('recall dispatch runs before path resolution and the planner spawn', () => {
    const text = readFileNormalized(PLAN_PHASE);
    const s56 = text.indexOf('\n## 5.6. ');
    const s7 = text.indexOf('\n## 7. Use Context Paths from INIT');
    const assign = text.indexOf('MEMORY_RECALL_PATH=');
    const s8 = text.indexOf('\n## 8. Spawn gsd-planner Agent');
    assert.ok(s56 !== -1 && s7 !== -1 && assign !== -1 && s8 !== -1, 'all anchors must be present');
    assert.ok(s56 < s7 && s7 < assign && assign < s8, `order violated: ${[s56, s7, assign, s8].join(' < ')}`);
    assert.ok(section(text, '5.6. ').includes('plan-phase/steps/plan-pre-dispatch.md'));
  });

  test('plan:pre products of generically dispatched capabilities reach the planner', () => {
    const manifest = JSON.parse(fs.readFileSync(MEMPALACE, 'utf8'));
    const produced = [];
    for (const value of Object.values(manifest)) {
      if (!Array.isArray(value)) continue;
      for (const hook of value) {
        if (hook && typeof hook === 'object' && hook.point === 'plan:pre' && hook.ref) {
          produced.push(...(hook.produces || []));
        }
      }
    }
    assert.ok(produced.length > 0, 'mempalace must declare a plan:pre ref hook that produces a file');
    const reading = plannerRequiredReading();
    for (const file of produced) {
      assert.ok(reading.includes(file), `planner required_reading must name ${file}`);
    }
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
    for (const line of [dispatchLine, shipLine, stepDispatch]) {
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
