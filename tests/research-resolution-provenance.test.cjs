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
 * - Dimension 11 no longer passes on the suffix or on an uncited marker, names the
 *   provenance it does accept (a `D-NN` that exists in CONTEXT.md), and blocks the
 *   citation shapes the forgery used: none, a plan, a "disposition".
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

describe('plan-checker Dimension 11 requires provenance, not a marker (#5438)', () => {
  test('no step passes the dimension on the (RESOLVED) heading suffix', () => {
    assert.doesNotMatch(dim11, /\(RESOLVED\)`?\s*suffix\s*(→|->)\s*PASS/);
    assert.match(dim11, /A `\(RESOLVED\)` heading suffix is never evidence/);
  });

  test('a resolution counts only when it cites a D-NN that exists in CONTEXT.md', () => {
    assert.match(dim11, /Only the user closes an open question, recorded as a `D-NN` decision in the phase's CONTEXT\.md/);
    assert.match(dim11, /confirm that decision exists in CONTEXT\.md and answers the question asked/);
  });

  test('blocks an uncited marker, a dangling D-NN, and a non-user authority', () => {
    assert.match(dim11, /is marked `RESOLVED` \(inline or by the heading suffix\) without citing a `D-NN`/);
    assert.match(dim11, /cites a `D-NN` that CONTEXT\.md does not contain/);
    assert.match(dim11, /rests on a plan, a "planning-time disposition", the research itself, or another agent's output/);
  });

  test('the binding required_property carries the relevance condition', () => {
    const props = [...dim11.matchAll(/required_property:\s*"([^"]*)"/g)].map((m) => m[1]);
    assert.ok(props.length >= 1, 'Dimension 11 must carry a required_property example');
    for (const prop of props) assert.match(prop, /D-NN decision that exists in CONTEXT\.md and answers it/);
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
    const passIdx = dim11.indexOf('**Example — resolved (PASS');
    assert.notEqual(passIdx, -1);
    // The example's body: the lines between its opening and closing fence.
    const lines = splitLines(dim11.slice(passIdx));
    const open = lines.findIndex((l) => l.startsWith('```'));
    const close = lines.findIndex((l, i) => i > open && l.startsWith('```'));
    assert.ok(open !== -1 && close !== -1, 'the PASS example must be a fenced block');
    const passLines = lines.slice(open + 1, close);
    assert.ok(passLines.every((l) => !l.includes('(RESOLVED)')), 'the PASS example must not teach the heading suffix');
    const items = passLines.filter((l) => /^\d+\./.test(l));
    assert.ok(items.length >= 1);
    for (const item of items) assert.match(item, /RESOLVED \(D-\d{2}\):/, `uncited PASS item: ${item}`);

    assert.match(dim11, /\*\*Example — self-resolved, no decision on record \(BLOCKER\):\*\*/);
  });

  test('success_criteria includes the research resolution check', () => {
    const criteria = span(checker, '<success_criteria>', /<\/success_criteria>/);
    const item = criteria.match(/- \[ \] Research resolution checked[^\n]*\n[^\n]*/);
    assert.ok(item, 'success_criteria must list the research resolution check');
    assert.match(item[0], /`D-NN`/);
    assert.match(item[0], /CONTEXT\.md/);
    assert.match(item[0], /and answers it/, 'the checklist must carry the body\'s relevance condition');
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
    assert.match(rule, /\bplan\b/);
    assert.match(rule, /\bdisposition\b/);
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
    assert.match(guide, /CONTEXT\.md/);
  });
});
