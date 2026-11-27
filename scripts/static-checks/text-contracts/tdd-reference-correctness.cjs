'use strict';

// tdd.md pointer citations name the section that carries the guidance (#4267), and gsd-executor.md's plan-level
// gate section is a short pointer at tdd.md's "Gate Enforcement Rules", not a restatement (#4269). execute-plan.md
// and gsd-executor.md cite three distinct sections (Red-Green-Refactor Cycle, Fail-Fast Rules, Error Handling);
// tdd.md's Fail-Fast Rules and Error Handling sections carry that guidance; the gate-sequence rules, the git-log
// validation script and the TDD Gate Compliance contract appear in full only in tdd.md. Was
// tests/tdd-reference-correctness.test.cjs. A section with no end marker is a finding where the test read to the
// end of the file.

const CITED_SECTIONS = [
  ['"Red-Green-Refactor Cycle"', 'the commit-scope contract must cite "Red-Green-Refactor Cycle"'],
  ['"Fail-Fast Rules"', 'the fail-fast rule must cite "Fail-Fast Rules" by its literal section name, not just the words "fail-fast"'],
  ['"Error Handling"', 'error handling must cite "Error Handling" by its literal section name'],
];

const MAX_POINTER_LINES = 6;

// The executor's pointer block: from <tdd_execution> to the Plan-Level heading when there is one, else to the
// closing tag.
function executorPointer(text) {
  const start = text.indexOf('<tdd_execution>');
  if (start === -1) return { error: 'gsd-executor.md has no <tdd_execution> block' };
  const planLevel = text.indexOf('## Plan-Level');
  const end = planLevel > -1 ? planLevel : text.indexOf('</tdd_execution>');
  if (!(end > start)) return { error: 'the <tdd_execution> pointer block has no end' };
  return { text: text.slice(start, end) };
}

module.exports = {
  id: 'tdd-reference-correctness',
  issue: '#4267',
  check(ctx) {
    const plan = ctx.doc('gsd-core/workflows/execute-plan.md').slice('<tdd_plan_execution>', '</tdd_plan_execution>');
    for (const [phrase, why] of CITED_SECTIONS) plan.has(phrase, `execute-plan.md: ${why}`);

    const executor = ctx.doc('agents/gsd-executor.md');
    for (const [phrase, why] of CITED_SECTIONS) {
      executor.satisfies((text) => {
        const pointer = executorPointer(text);
        return pointer.error || pointer.text.includes(phrase);
      }, `gsd-executor.md: ${why}`);
    }

    const tdd = ctx.doc('gsd-core/references/tdd.md');
    tdd.slice('### Fail-Fast Rules', '### Executor Gate Validation')
      .has(/Unexpected GREEN in RED phase/i, 'the Fail-Fast Rules section must describe the unexpected-pass-in-RED rule');
    const errorHandling = tdd.slice('## Error Handling', '## Commit Pattern for TDD Plans');
    errorHandling.has(/fail/i, 'the Error Handling section must describe fail-in-RED/GREEN/REFACTOR guidance (fail)');
    errorHandling.has(/RED|GREEN|REFACTOR/, 'the Error Handling section must describe fail-in-RED/GREEN/REFACTOR guidance (a phase name)');

    executor
      .lacks(/A `test\(\.\.\.\)` commit exists \(RED gate\)/, 'gsd-executor.md must not restate the old RED gate-sequence wording')
      .lacks(/A `feat\(\.\.\.\)` commit exists after it \(GREEN gate\)/, 'gsd-executor.md must not restate the old GREEN gate-sequence wording')
      .has(/references\/tdd\.md/, "gsd-executor.md must point at tdd.md's Gate Enforcement Rules (the tdd.md reference)")
      .has(/Gate Enforcement Rules/, "gsd-executor.md must point at tdd.md's \"Gate Enforcement Rules\" section")
      .has(/## Plan-Level TDD Gate Enforcement/, 'the "## Plan-Level TDD Gate Enforcement" heading must still exist as an anchor')
      .slice('## Plan-Level TDD Gate Enforcement', '</tdd_execution>')
      .satisfies((text) => {
        const lines = text.split('\n').filter((line) => line.trim().length > 0).length;
        return lines <= MAX_POINTER_LINES || `${lines} non-blank lines`;
      }, `the plan-level gate section must be a short pointer (at most ${MAX_POINTER_LINES} non-blank lines)`);

    tdd
      .has(/Unexpected GREEN in RED phase/, 'tdd.md must carry the fail-fast rule')
      .has(/git log --oneline -E --grep/, 'tdd.md must carry the git-log gate validation script')
      .has(/## TDD Gate Compliance/, 'tdd.md must carry the TDD Gate Compliance SUMMARY.md contract');
    ctx.doc('agents/gsd-executor.md')
      .lacks(/git log --oneline -E --grep/, 'gsd-executor.md must not restate the git-log gate validation script: it lives only in tdd.md')
      .lacks(/If a test passes unexpectedly during RED, STOP/, 'gsd-executor.md must not restate the fail-fast rule prose: it lives only in tdd.md');
  },
};
