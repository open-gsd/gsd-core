'use strict';

// plan-phase §5.6 UI Design Contract Gate (#3706, #5982) and the optional sketch/spike findings probes (#3072): §5.6
// dispatches `loop render-hooks plan:pre`, runs `check ui-plan-gate` unconditionally and before Branch 5, reads
// frontend/hasUiSpec/block, inlines no config-get of the two toggles, and states Branches 1-6 (the skips, the pipeline
// step dispatch that runs without a gate, the generic gate handling and its exact recommendation block); plan-phase.md
// has no hard "Generate UI-SPEC first -> Exit workflow" redirect and no inline shell path-search; every sketch/spike
// findings `ls` probe in the bash blocks of ui-phase, plan-phase, discuss-phase and new-project ends in `|| true`.
// Dropped as implied by another assertion: the check.query OR and the check.query binding OR (both hold whenever the
// required `check ui-plan-gate` does), the whole-file --skip-ui (the section one contains it), and the bare `kind`/
// `frontend`/`AUTO_CHAIN` repeats. Was tests/plan-phase-ui-redirect.test.cjs (its bug-3072 block was folded in).

const path = require('node:path');
const { asciiLower } = require('./lib/ascii-lower.cjs');
const { loadLib } = require('./lib/load-lib.cjs');
const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { precedesWithin } = require('./lib/precedes-within.cjs');

const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
const OTHER_PROBE_FILES = ['ui-phase.md', 'discuss-phase.md', 'new-project.md'];
const SECTIONIZER = 'gsd-core/bin/lib/markdown-sectionizer.cjs';
const REAL_ROOT = path.join(__dirname, '..', '..', '..');
const WS = /\s/;
const DOT = new Set(['.']);
const NEWLINE = new Set(['\n']);
const SKIP_HEADS = ['activeHooks', 'empty', 'absent', 'Branch 1'];

// `||`, optional whitespace, then `true`: the walk of /\|\|\s*true/.
function hasNonFatalGuard(line) {
  for (let at = line.indexOf('||'); at !== -1; at = line.indexOf('||', at + 1)) {
    let pos = at + 2;
    while (pos < line.length && WS.test(line[pos])) pos += 1;
    if (line.startsWith('true', pos)) return true;
  }
  return false;
}

// The `file:line command` of every sketch/spike findings probe line in a closed bash block that lacks `|| true`.
function unguardedProbes(file, text, scanFencedBlocks) {
  const lines = text.split('\n');
  const offenders = [];
  const blocks = scanFencedBlocks(lines).filter((block) => block.closeLineIdx !== -1 && (block.infoString || '').trim() === 'bash');
  for (const block of blocks) {
    lines.slice(block.openLineIdx + 1, block.closeLineIdx).forEach((line, idx) => {
      if (!line.includes('.claude/skills/')) return;
      if (!line.includes('sketch-findings-*/SKILL.md') && !line.includes('spike-findings-*/SKILL.md')) return;
      if (!hasNonFatalGuard(line)) offenders.push(`${file}:${block.openLineIdx + 1 + idx} ${line.trim()}`);
    });
  }
  return offenders;
}

// `Generate UI-SPEC first` with `Exit workflow` anywhere after it: the old /Generate UI-SPEC first.*Exit workflow/s.
function hasHardExit(text) {
  const at = text.indexOf('Generate UI-SPEC first');
  return at !== -1 && text.includes('Exit workflow', at + 'Generate UI-SPEC first'.length);
}

// Branch 1 skips to step 6: one of the four heads, then `step 6` with no full stop between them.
const skipsToStepSix = (text) => SKIP_HEADS.some((head) => precedesWithin(text, head, 'step 6', DOT));

function buildCheck({ loadSectionizer }) {
  return function check(ctx) {
    const sectionizer = loadLib(loadSectionizer, SECTIONIZER);
    if (sectionizer.error) ctx.fail(PLAN_PHASE, sectionizer.error);
    const probeVerdict = (file) => (text) => {
      if (sectionizer.error) return true;
      const offenders = unguardedProbes(file, text, sectionizer.lib.scanFencedBlocks);
      return offenders.length === 0 || offenders.join('\n');
    };

    const plan = ctx.doc(PLAN_PHASE);
    plan
      .satisfies((text) => !hasHardExit(text) || 'a hard "Generate UI-SPEC first" then "Exit workflow" redirect is present',
        'plan-phase.md must not contain a hard "Generate UI-SPEC first -> Exit workflow" redirect')
      .satisfies(probeVerdict(PLAN_PHASE), 'optional sketch/spike findings probes must carry a non-fatal guard (|| true)');
    const section = plan.slice('## 5.6.', '\n## 6.');
    section
      .has('loop render-hooks plan:pre', '§5.6 must dispatch `loop render-hooks plan:pre` to resolve active capability hooks')
      .has('check ui-plan-gate', '§5.6 must run `gsd_run check ui-plan-gate` unconditionally (not gated inside a kind==gate loop)')
      .has('step-only case', '§5.6 must document "step-only case" to prove the check runs independently of gate presence')
      .has('GATE=$(gsd_run check ui-plan-gate', '§5.6 must contain the `GATE=$(gsd_run check ui-plan-gate` assignment')
      .has('Branch 5', '§5.6 must contain Branch 5')
      .satisfies((text) => {
        const gate = text.indexOf('GATE=$(gsd_run check ui-plan-gate');
        const branch = text.indexOf('Branch 5');
        return gate === -1 || branch === -1 || gate < branch || `GATE= at ${gate}, Branch 5 at ${branch}`;
      }, '§5.6 GATE= check must appear BEFORE Branch 5 step dispatch')
      .has('frontend', '§5.6 must read `frontend` from gate result')
      .has('hasUiSpec', '§5.6 must read `hasUiSpec` from gate result')
      .has('block', '§5.6 must read `block` from gate result')
      .lacks('config-get workflow.ui_phase', '§5.6 must NOT inline `config-get workflow.ui_phase`: the toggle is resolved by render-hooks')
      .lacks('config-get workflow.ui_safety_gate', '§5.6 must NOT inline `config-get workflow.ui_safety_gate`: the toggle is resolved by render-hooks')
      .has('activeHooks', '§5.6 Branch 1 must reference activeHooks')
      .satisfies((text) => skipsToStepSix(text) || 'no head is followed by "step 6" before a full stop',
        '§5.6 Branch 1 (both-off / empty activeHooks) must skip to step 6, NOT §5.7')
      .satisfies((text) => precedesWithin(text, 'Branch 2', 'step 5.65', NEWLINE) || 'no such line',
        '§5.6 Branch 2 must skip to step 5.65, not past the §5.65 drift gate to step 6')
      .has('UI_SPEC_PATH', '§5.6 Branch 3 must set UI_SPEC_PATH')
      .has('Using UI design contract', '§5.6 Branch 3 must display the using-contract message')
      .has('AUTO_CHAIN', '§5.6 Branches 5 and 6 must read the AUTO_CHAIN flag')
      .has('gsd-${ref.skill}', '§5.6 Branch 5 must dispatch step hooks via gsd-${ref.skill} in pipeline mode')
      .has('ref.skill', '§5.6 Branch 5 must filter activeHooks by ref.skill')
      .has('independently of whether a gate is active',
        '§5.6 Branch 5 must state step hooks fire "independently of whether a gate is active" (the {ui_phase:T,ui_safety_gate:F} regression guard)')
      .satisfies((text) => text.includes('kind == "gate"') || text.includes('kind=="gate"') || 'neither spelling is present',
        '§5.6 Branch 6 must filter by kind=="gate" (generic gate-handling)')
      .satisfies((text) => precedesWithin(asciiLower(text), 'blocking', 'true', LINE_ENDS) || 'no such line',
        '§5.6 Branch 6 must check `blocking` is true for the gate')
      .has('Exit the plan-phase workflow', '§5.6 Branch 6 must say "Exit the plan-phase workflow"')
      .has('Do not continue', '§5.6 Branch 6 must say "Do not continue"')
      .satisfies((text) => text.includes('no active blocking gate') || text.includes('no block') || 'neither phrase is present',
        '§5.6 Branch 6 must document: no active blocking gate -> continue to step 6 (no block)')
      .has('⚠ UI-SPEC.md missing for Phase', '§5.6 must include the "⚠ UI-SPEC.md missing for Phase" warning heading')
      .has('Recommended next step', '§5.6 must include the "Recommended next step" label in the recommendation block')
      .has('/gsd:ui-phase', '§5.6 must include the /gsd:ui-phase recommendation in the block')
      .has('--skip-ui', '§5.6 must include --skip-ui as the bypass option in the recommendation block')
      .has('Also available', '§5.6 recommendation block must include the "Also available" section')
      .satisfies((text) => text.includes('ui.plan-gate') || text.includes('normalizes dots') || text.includes('dots to hyphens') || 'none of the three phrases is present',
        '§5.6 must document that the check router normalizes dots to hyphens for the declared check.query')
      .has('ui_phase', '§5.6 must reference workflow.ui_phase (step hook config key)')
      .has('ui_safety_gate', '§5.6 must reference workflow.ui_safety_gate (gate hook config key)')
      .lacks('UI_GATE_JS=$(for _c in', '§5.6 must NOT contain the old shell-based ui-safety-gate.cjs path-search (now delegated to check ui-plan-gate)');

    for (const file of OTHER_PROBE_FILES) {
      ctx.doc(`gsd-core/workflows/${file}`)
        .satisfies(probeVerdict(file), 'optional sketch/spike findings probes must carry a non-fatal guard (|| true)');
    }
  };
}

const realSectionizer = () => require(path.join(REAL_ROOT, SECTIONIZER));

module.exports = {
  // The linear walkers and the loader seam, exported for the differential properties and the loader cases of
  // tests/text-contracts.batch11.test.cjs.
  walkers: { hasNonFatalGuard, unguardedProbes, hasHardExit, skipsToStepSix, buildCheck },
  id: 'plan-phase-ui-redirect',
  issue: '#3706',
  check: buildCheck({ loadSectionizer: realSectionizer }),
};
