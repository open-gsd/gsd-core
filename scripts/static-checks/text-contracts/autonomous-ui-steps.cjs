'use strict';

// /gsd:autonomous gives frontend phases a UI design contract before planning (§3a.5) and an advisory UI review after
// execution (§3d.5) (#1375). The §3a.5 body lives in gsd-core/references/autonomous-ui-design-contract.md behind an
// unconditional `Read and execute:` pointer in the host (#2994), so every assertion reads the host with the reference
// spliced in at the pointer, as the test did (the splice uses a function replacement: no `$` pattern in the reference
// can be read as a replacement token). A missing marker is one finding and the checks that need it stay quiet. The
// test's tail checks of §3d.5 for verify:post dispatch, UI_SPEC_FILE and advisory lie inside the check that is bounded
// by the closing step tag, so they are asserted there once (the render-hooks word is part of the verify:post dispatch
// phrase); `consumes` stays on the unbounded tail as in the test; `3a.5` anywhere is subsumed by the `**3a.5.` heading.
// Was tests/autonomous-ui-steps.test.cjs.

const WORKFLOW = 'gsd-core/workflows/autonomous.md';
const REFERENCE = 'gsd-core/references/autonomous-ui-design-contract.md';
const POINTER = 'Read and execute: `$HOME/.claude/gsd-core/references/autonomous-ui-design-contract.md`';

const hasAny = (text, words) => words.some((word) => text.includes(word));
const need = (condition, message) => condition || message;

// The host with the reference spliced in at the pointer, or null when the pointer is gone.
function splice(host, reference) {
  const at = host.indexOf(POINTER);
  return at === -1 ? null : host.slice(0, at) + reference + host.slice(at + POINTER.length);
}

// §3a.5: the heading to the next `**3b.` heading.
function section3a5(content) {
  const start = content.indexOf('**3a.5.');
  if (start === -1) return { error: '§3a.5 heading must be present in autonomous.md' };
  const end = content.indexOf('**3b.', start);
  if (end === -1) return { error: '**3b. must follow §3a.5 in autonomous.md' };
  return { text: content.slice(start, end) };
}

// §3d.5: from its first mention to the end, and from there to the closing step tag (null when there is none).
function review(content) {
  const start = content.indexOf('3d.5');
  if (start === -1) return { error: '§3d.5 heading must be present in autonomous.md' };
  const end = content.indexOf('</step>', start);
  return { tail: content.slice(start), bounded: end === -1 ? null : content.slice(start, end) };
}

const criteria = (content) => {
  const start = content.indexOf('<success_criteria>');
  return start === -1 ? null : content.slice(start);
};

module.exports = {
  id: 'autonomous-ui-steps',
  issue: '#1375',
  walkers: { splice, section3a5, review, criteria },
  check(ctx) {
    const host = ctx.doc(WORKFLOW);
    const reference = ctx.doc(REFERENCE);
    let referenceText = null;
    reference.satisfies((text) => { referenceText = text; return true; }, 'the UI design contract reference must load');
    // Every check below reads the spliced view; a dead file or a missing pointer is already one finding.
    const onContent = (check) => (raw) => {
      if (referenceText === null) return true;
      const content = splice(raw, referenceText);
      return content === null ? true : check(content);
    };
    const inSection = (check) => onContent((content) => {
      const section = section3a5(content);
      return section.error ? true : check(section.text);
    });
    const inReview = (check) => onContent((content) => {
      const found = review(content);
      return found.error ? true : check(found);
    });
    const inBounded = (check) => inReview((found) => (found.bounded === null ? true : check(found.bounded)));
    const inCriteria = (check) => onContent((content) => {
      const tail = criteria(content);
      return tail === null ? true : check(tail);
    });

    host.satisfies((raw) => referenceText === null || need(raw.includes(POINTER), 'the pointer is gone'),
      'autonomous.md must still contain the §3a.5 reference pointer');
    host.satisfies(onContent((content) => section3a5(content).error || true), 'the §3a.5 section must be delimited');
    host.satisfies(inSection((s) => need(s.includes('loop render-hooks plan:pre'), 'not found')),
      '§3a.5 must dispatch `loop render-hooks plan:pre` to resolve active capability hooks');
    host.satisfies(inSection((s) => need(s.includes('check ui-plan-gate'), 'not found')),
      '§3a.5 must call `check ui-plan-gate` to gate on frontend indicators and existing UI-SPEC');
    host.satisfies(inSection((s) => need(s.includes('frontend'), 'not found')), '§3a.5 must read the `frontend` field from the gate result');
    host.satisfies(inSection((s) => need(s.includes('hasUiSpec'), 'not found')), '§3a.5 must read the `hasUiSpec` field from the gate result');
    host.satisfies(inSection((s) => need(s.includes('gsd-${ref.skill}'), 'not found')),
      '§3a.5 must construct skill name via `gsd-${ref.skill}` prefix (matches §3d.5 style)');
    host.satisfies(inSection((s) => need(s.includes('UI-SPEC.md'), 'not found')), '§3a.5 must check for existing UI-SPEC.md');
    host.satisfies(inSection((s) => need(!s.includes('ui-safety-gate.cjs'), 'found')),
      '§3a.5 must NOT inline ui-safety-gate.cjs (replaced by check ui-plan-gate)');
    host.satisfies(inSection((s) => need(!s.includes('RUNTIME_DIR'), 'found')),
      '§3a.5 must NOT probe RUNTIME_DIR (replaced by check ui-plan-gate via capability registry)');
    host.satisfies(inSection((s) => need(!s.includes('config-get workflow.ui_phase'), 'found')),
      '§3a.5 must NOT inline `config-get workflow.ui_phase` — toggle is owned by the capability registry');
    host.satisfies(inSection((s) => {
      const blocking = ['EXIT', 'exit the', 'halt'].filter((word) => s.includes(word));
      return need(blocking.length === 0, `found ${blocking.join(', ')}`);
    }), '§3a.5 must NOT introduce any gate-halt or exit — it is step-only and non-blocking');
    host.satisfies(inSection((s) => need(hasAny(s, ['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']), 'none of NON-BLOCKING, non-blocking, continue, proceed')),
      '§3a.5 must be explicitly non-blocking (warning + continue)');
    host.satisfies(inSection((s) => need(hasAny(s, ['kind == "step"', "kind == 'step'", 'kind=="step"']), 'none of the three spellings')),
      '§3a.5 must gate the skip decision on kind=="step" entries');
    host.satisfies(inSection((s) => need(hasAny(s, ['NO active step', 'no active step', 'no active UI step']), 'none of the three phrases')),
      '§3a.5 skip condition must reference "no active step hook(s)" — not just empty activeHooks');
    host.satisfies(inSection((s) => need(!s.includes('empty or absent'), 'found')),
      '§3a.5 must NOT use "empty or absent" as the skip condition — that misses gate-only sets');
    host.satisfies(inSection((s) => need(hasAny(s, ['ui_phase', 'ui_safety_gate', 'gate-only']), 'none of ui_phase, ui_safety_gate, gate-only')),
      '§3a.5 must document the gate-only / ui_phase=false silent-skip case');
    host.satisfies(inSection((s) => {
      const stepCheck = s.indexOf('kind == "step"');
      const gateRun = s.indexOf('check ui-plan-gate');
      if (stepCheck === -1 || gateRun === -1) return 'a marker is missing (kind == "step" and check ui-plan-gate are both needed)';
      return need(stepCheck < gateRun, 'the gate command comes first');
    }), '§3a.5 must check for active step hooks BEFORE running check ui-plan-gate');
    host.satisfies(inSection((s) => need(s.includes('gate') && hasAny(s, ['ignored', 'silently']), 'gate with ignored or silently not found')),
      '§3a.5 must explicitly note kind=="gate" entries are silently ignored');
    host.satisfies(onContent((content) => {
      const heading = content.indexOf('3a.5');
      const plan = content.indexOf('**3b. Plan**');
      if (section3a5(content).error) return true; // the §3a.5 section check reports it
      if (plan === -1) return '**3b. Plan** not found';
      return need(heading < plan, '3b comes first');
    }), 'step 3a.5 (UI design contract) should appear before step 3b (plan)');

    host.satisfies(onContent((content) => review(content).error || true), 'the §3d.5 step must be present');
    host.satisfies(inReview((found) => need(found.bounded !== null, 'no closing step tag after §3d.5')), '</step> must follow §3d.5');
    host.satisfies(inBounded((s) => need(s.includes('loop render-hooks verify:post'), 'not found')),
      '§3d.5 must dispatch `loop render-hooks verify:post` to resolve active capability hooks');
    host.satisfies(inBounded((s) => need(s.includes('gsd-${ref.skill}'), 'not found')),
      '§3d.5 must construct skill name via `gsd-${ref.skill}` prefix (capability-driven dispatch)');
    host.satisfies(inBounded((s) => need(s.includes('UI_SPEC_FILE'), 'not found')), '§3d.5 must gate on UI_SPEC_FILE for hooks that consume UI-SPEC.md');
    host.satisfies(inBounded((s) => need(hasAny(s, ['advisory', 'non-blocking', 'regardless of result']), 'none of advisory, non-blocking, regardless of result')),
      '§3d.5 must be explicitly advisory/non-blocking');
    host.satisfies(inReview((found) => need(found.tail.includes('consumes'), 'not found')),
      'UI review step should reference hook consumes array for the UI-SPEC gate');
    host.satisfies(inBounded((s) => need(!s.includes('config-get workflow.ui_review'), 'found')),
      '§3d.5 must NOT inline `config-get workflow.ui_review` — the toggle is owned by the capability registry');
    host.satisfies(onContent((content) => {
      const routing = content.indexOf('**3d. Post-Execution Routing**');
      const found = content.indexOf('3d.5');
      if (review(content).error) return true; // the §3d.5 step check reports it
      if (routing === -1) return '**3d. Post-Execution Routing** not found';
      return need(found > routing, '3d.5 comes first');
    }), 'step 3d.5 (UI review) should appear after step 3d (post-execution routing)');

    host.satisfies(onContent((content) => {
      const missing = ['ui-phase', 'ui-review'].filter((word) => !content.includes(word));
      return need(missing.length === 0, `missing ${missing.join(', ')}`);
    }), 'success criteria should reference ui-phase and ui-review');
    host.satisfies(onContent((content) => need(hasAny(content, ['Frontend phases', 'frontend phases']), 'neither spelling found')),
      'success criteria should mention frontend phases');
    host.satisfies(onContent((content) => (criteria(content) === null ? '<success_criteria> not found' : true)), 'the success criteria block must be present');
    host.satisfies(inCriteria((tail) => need(hasAny(tail, ['advisory', 'non-blocking']), 'neither advisory nor non-blocking found')),
      'success criteria should note UI review is advisory/non-blocking');
  },
};
