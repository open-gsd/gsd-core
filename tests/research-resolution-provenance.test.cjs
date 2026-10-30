/**
 * Dimension 11 — research resolution requires a user decision on record (#5438).
 *
 * `gsd-plan-checker` Dimension 11 used to PASS when RESEARCH.md's `## Open Questions`
 * heading carried a `(RESOLVED)` suffix, and its own `fix_hint` told authors to write
 * that suffix. `gsd-phase-researcher` writes RESEARCH.md and was never told not to, so
 * the agent whose output the gate checks could close the gate itself. Sonnet and Haiku
 * passed such a forgery (#5438); Opus blocked it by reasoning past the text.
 *
 * ## What this suite locks
 *
 * - Dimension 11 collects every open question, under any heading or in prose; passes one
 *   only on the provenance it accepts (a `D-NN` under CONTEXT.md's `<decisions>` that
 *   answers it and predates the planning run); blocks every other question, naming the
 *   citation shapes the forgery used (none, a plan, a "disposition"); and blocks every
 *   question when CONTEXT.md is absent. Only the no-questions case reaches PASS.
 * - Its fix_hint routes to recording a user ruling, not to writing the marker.
 * - Its worked examples: the PASS example cites `D-NN`; the self-resolved shape is a
 *   BLOCKER example.
 * - `<success_criteria>` carries the dimension, so the checklist the agent ends on
 *   includes it.
 * - The researcher and `gsd-core/templates/research.md` forbid self-resolution, and
 *   state the rule outside the RESEARCH.md template, no part of which carries a
 *   `RESOLVED` token a model could copy into the file the checker reads.
 *
 * ## What it cannot prove
 *
 * That a model acts on the text. The subject is an LLM prompt; no test here can run the
 * checker. The #5438 PR body records the before/after model runs on the issue's fixture.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { stripFencedCode } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');

const checker = read('agents/gsd-plan-checker.md');
const researcher = read('agents/gsd-phase-researcher.md');
const researchTemplate = read('gsd-core/templates/research.md');

function span(doc, startHeading, endPattern) {
  const start = doc.indexOf(startHeading);
  assert.notEqual(start, -1, `missing heading: ${startHeading}`);
  const rest = doc.slice(start + startHeading.length);
  const end = rest.search(endPattern);
  return end === -1 ? rest : rest.slice(0, end);
}

const dim11 = span(checker, '## Dimension 11: Research Resolution', /\n## Dimension 12\b/);
// The numbered Process steps, from **Process:** to the first worked example, each with its
// whitespace collapsed so a wrap cannot split one step. Assertions below match invariant
// tokens within a step, never whole sentences.
const steps = span(dim11, '**Process:**', /\n\*\*Example\b/)
  .split(/\n(?=\d+\.\s)/)
  .filter((s) => /^\d+\.\s/.test(s))
  .map((s) => s.replace(/\s+/g, ' ').trim());
// The dimension as a model reads its rules: everything but the fenced examples and their labels.
const rules = splitLines(stripFencedCode(dim11).text)
  .filter((l) => !/^\*\*Example\b/.test(l))
  .join('\n');

describe('plan-checker Dimension 11 requires provenance, not a marker (#5438)', () => {
  test('PASS is reached only when there are no questions, and the suffix is never evidence', () => {
    const passSteps = steps.filter((s) => /\bPASS\b/.test(s));
    assert.equal(passSteps.length, 1, 'exactly one Process step may grant PASS');
    assert.match(passSteps[0], /\b(no questions|none)\b/i, `PASS granted other than for no questions: ${passSteps[0]}`);
    assert.doesNotMatch(passSteps[0], /RESOLVED/, `PASS granted on the marker: ${passSteps[0]}`);
    assert.equal(
      (rules.match(/\bPASS\b/g) || []).length,
      (passSteps[0].match(/\bPASS\b/g) || []).length,
      'the dimension grants PASS outside its no-questions step',
    );
    assert.ok(
      steps.some((s) => s.includes('`(RESOLVED)`') && /never evidence/.test(s)),
      'a step must say the (RESOLVED) heading suffix is never evidence',
    );
  });

  test('every question still needing a ruling is collected, whatever its heading, form or claimed status', () => {
    const collect = steps[0];
    assert.match(collect, /needing an answer or a user ruling/);
    assert.match(collect, /any heading/, 'step 1 must not key on one literal heading');
    assert.match(collect, /\bprose\b/, 'step 1 must collect questions written as prose');
    assert.match(collect, /whatever status it claims/, 'a question the researcher calls closed is still collected');
    assert.match(collect, /settled with a cited source is not one/, 'research findings are not questions');
    assert.match(collect, /assumption or risk counts only if it names such a pending answer or ruling/, 'an assumption counts when it needs an answer, not only a ruling');
  });

  test('a question passes only on a D-NN under CONTEXT.md <decisions> that answers it and predates this run', () => {
    assert.match(dim11, /only\s+the\s+user\s+closes/i);
    const pass = steps.find((l) => /\bpasses only\b/.test(l));
    assert.ok(pass, 'a step must state the one way a question passes');
    assert.ok(pass.includes('`D-NN`') && pass.includes("CONTEXT.md's `<decisions>`"), `pass rule not scoped to <decisions>: ${pass}`);
    assert.match(pass, /\banswers\b/);
    assert.match(pass, /not added during this planning run/);
  });

  test('no CONTEXT.md leaves every question a BLOCKER', () => {
    assert.ok(steps.some((s) => /No CONTEXT\.md: every question is a BLOCKER/.test(s)), 'Process must say what happens without CONTEXT.md');
  });

  test('the BLOCKER step covers every other question, and names the cases: uncited, dangling, misplaced, irrelevant, non-user authority', () => {
    const blocker = steps.find((l) => /\bBLOCKER\b/.test(l));
    assert.ok(blocker, 'Process must carry a BLOCKER step');
    const cases = {
      'every other question': /every other question/i,
      'any marking, any case': /however it is marked[^:]*"Decided"[^:]*"Closed"[^:]*any case/,
      'no resolution': /no resolution/,
      'no D-NN': /no `D-NN`/,
      'a D-NN CONTEXT.md lacks': /does not contain/,
      'a D-NN outside <decisions>': /outside `<decisions>`/,
      'a D-NN that decides something else': /decides something else/,
      'a plan': /\bon a plan\b/,
      'a disposition': /"planning-time disposition"/,
      'the research itself': /research itself/,
      "another agent's output": /another agent/,
    };
    for (const [name, re] of Object.entries(cases)) assert.match(blocker, re, `BLOCKER step omits: ${name}`);
  });

  test('the binding required_property carries the relevance condition', () => {
    const props = [...dim11.matchAll(/required_property:\s*"([^"]*)"/g)].map((m) => m[1]);
    assert.ok(props.length >= 1, 'Dimension 11 must carry a required_property example');
    for (const prop of props) {
      assert.match(prop, /D-NN/);
      assert.match(prop, /CONTEXT\.md <decisions>/);
      assert.match(prop, /recorded before this run/, 'the binding property must carry the not-added-this-run condition');
      assert.match(prop, /\banswers\b/);
    }
  });

  test('fix_hint routes to recording a user ruling, never to writing the marker', () => {
    const hints = [...dim11.matchAll(/fix_hint:\s*"([^"]*)"/g)].map((m) => m[1]);
    assert.ok(hints.length >= 1, 'Dimension 11 must carry a fix_hint example');
    for (const hint of hints) {
      assert.doesNotMatch(hint, /mark section as/i, `fix_hint still prescribes the marker: ${hint}`);
      assert.match(hint, /D-NN/);
      assert.match(hint, /CONTEXT\.md/);
    }
  });

  test('the PASS example cites D-NN on every question; the self-resolved shape is a BLOCKER example', () => {
    // Every PASS example, located by its label's tokens (an **Example label that says PASS
    // and not BLOCKER), not its wording.
    const lines = splitLines(dim11);
    const labels = lines.flatMap((l, i) => (/^\*\*Example\b/.test(l) && /\bPASS\b/.test(l) && !/\bBLOCKER\b/.test(l) ? [i] : []));
    assert.ok(labels.length >= 1, 'Dimension 11 must carry a PASS example');
    for (const at of labels) {
      // The example's body: the lines between its opening and closing fence.
      const open = lines.findIndex((l, i) => i > at && l.startsWith('```'));
      const close = lines.findIndex((l, i) => i > open && l.startsWith('```'));
      assert.ok(open !== -1 && close !== -1, `the PASS example must be a fenced block: ${lines[at]}`);
      const passLines = lines.slice(open + 1, close);
      assert.ok(passLines.every((l) => !l.includes('(RESOLVED)')), `a PASS example teaches the heading suffix: ${lines[at]}`);
      const items = passLines.filter((l) => /^\d+\./.test(l));
      assert.ok(items.length >= 1, `a PASS example lists no questions: ${lines[at]}`);
      for (const item of items) assert.match(item, /RESOLVED \(D-\d{2}\):/, `uncited PASS item: ${item}`);
    }

    assert.match(dim11, /^\*\*Example\b[^\n]*self-resolved[^\n]*\bBLOCKER\b/im);
  });

  test('success_criteria includes the research resolution check', () => {
    const criteria = span(checker, '<success_criteria>', /<\/success_criteria>/);
    const item = criteria.match(/- \[ \] Research resolution checked[^\n]*\n[^\n]*/);
    assert.ok(item, 'success_criteria must list the research resolution check');
    assert.match(item[0], /`D-NN`/);
    assert.match(item[0], /CONTEXT\.md `<decisions>`/);
    assert.match(item[0], /any heading/);
    assert.match(item[0], /\banswers\b/, 'the checklist must carry the body\'s relevance condition');
  });
});

// The tokens Dimension 11 reads. A rule written inside an output template can be copied
// into RESEARCH.md along with the template, where the checker would read it as content,
// so no part of either template may carry them; the rule lives beside the template.
const GATE_TOKEN = /RESOLVED/;

// The researcher's RESEARCH.md template: the ```markdown fence that opens on the
// RESEARCH.md title line, up to its closing fence. Returns the fenced body and what follows
// it inside <output_format>.
function researchTemplateFence(doc) {
  const lines = splitLines(doc);
  const title = lines.findIndex((l, i) => l.startsWith('# Phase [X]:') && lines[i - 1] === '```markdown');
  assert.notEqual(title, -1, 'missing the RESEARCH.md template fence');
  // Its closing fence is the last bare fence before </output_format>, so a code block
  // nested inside the template cannot end it early.
  const end = lines.findIndex((l, i) => i > title && l.startsWith('</output_format>'));
  assert.notEqual(end, -1, 'missing </output_format> after the RESEARCH.md template');
  const close = lines.slice(0, end).lastIndexOf('```');
  assert.ok(close > title, 'the RESEARCH.md template fence never closes');
  return { body: lines.slice(title, close).join('\n'), after: lines.slice(close + 1, end).join('\n') };
}

describe('researcher never resolves its own questions (#5438)', () => {
  const fence = researchTemplateFence(researcher);

  test('no part of the RESEARCH.md template carries a gate token a model could copy', () => {
    assert.match(fence.body, /\n## Open Questions\n/, 'the template must keep its Open Questions section');
    assert.doesNotMatch(fence.body, GATE_TOKEN);
  });

  test('the rule after the RESEARCH.md template forbids self-resolution and the section-heading suffix', () => {
    const rule = fence.after;
    assert.match(rule, /never\s+mark\s+a\s+question\s+resolved/i);
    assert.match(rule, /`\(RESOLVED\)`\s+suffix\s+to\s+the\s+section\s+heading/);
    assert.match(rule, /RESOLVED \(D-NN\)/);
    assert.match(rule, /list\s+every\s+such\s+question\s+in\s+that\s+section/);
    assert.match(rule, /CONTEXT\.md's\s+`<decisions>`/);
    assert.match(rule, /Never\s+add\s+a\s+decision\s+to\s+CONTEXT\.md/);
    assert.match(rule, /cite a plan\b/);
    assert.match(rule, /\ba disposition\b/);
  });

  test('the return template leaves open questions to a user ruling', () => {
    const ret = span(researcher, '\n### Open Questions\n', /\n### /);
    assert.doesNotMatch(ret, GATE_TOKEN);
    assert.match(ret, /user ruling/);
    assert.match(ret, /never marked resolved/i);
  });

  test('gsd-core/templates/research.md keeps the rule in Guidelines, outside the template', () => {
    const guidelinesAt = researchTemplate.indexOf('\n## Guidelines\n');
    assert.notEqual(guidelinesAt, -1, 'missing ## Guidelines');
    // Everything above Guidelines is the file template and its worked example.
    assert.match(researchTemplate.slice(0, guidelinesAt), /\n## Open Questions\n/);
    assert.doesNotMatch(researchTemplate.slice(0, guidelinesAt), GATE_TOKEN);
    const guide = span(researchTemplate.slice(guidelinesAt), '\n**Open Questions:**\n', /\n\n/);
    assert.match(guide, /never\s+mark\s+a\s+question\s+resolved/i);
    assert.match(guide, /`\(RESOLVED\)`\s+suffix\s+to\s+the\s+`## Open Questions`\s+section\s+heading/);
    assert.match(guide, /`D-NN`/);
    assert.match(guide, /CONTEXT\.md's `<decisions>`/);
    assert.match(guide, /List every open question in that section/);
  });
});
