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
// The numbered Process steps, from **Process:** to the first worked example. Each step is
// joined with its continuation lines and its whitespace collapsed, so a step reads the same
// whether it is one line, wrapped, or separated from its neighbours by blank lines.
// Assertions below match invariant tokens within a step, never whole sentences.
// Any other line in the block (a note after a blank line) is returned as prose of its own.
function processBlock(dim) {
  const steps = [];
  const prose = [];
  let prevBlank = true;
  let last = null; // the unit the previous line went to, so a continuation joins it
  for (const line of splitLines(span(dim, '**Process:**', /\n\*\*Example\b/))) {
    if (/^\d+\.\s/.test(line)) { steps.push(line); last = steps; }
    else if (last && line.trim() && (/^\s/.test(line) || !prevBlank)) last[last.length - 1] += ` ${line}`;
    else if (line.trim()) { prose.push(line); last = prose; }
    prevBlank = !line.trim();
  }
  const norm = (u) => u.replace(/\s+/g, ' ');
  return { steps: steps.map(norm), prose: prose.map(norm) };
}
const steps = processBlock(dim11).steps;

// Every unit of the dimension a model reads: each Process step and note (joined, as above),
// and outside the Process block each paragraph and each fenced example, joined, so a wrap
// cannot split one instruction across two units.
function readingUnits(dim) {
  const { steps: blockSteps, prose: blockProse } = processBlock(dim);
  const units = [...blockSteps, ...blockProse];
  let inFence = false;
  let current = [];
  const flush = () => { if (current.length) units.push(current.join(' ').replace(/\s+/g, ' ')); current = []; };
  for (const line of splitLines(dim.replace(span(dim, '**Process:**', /\n\*\*Example\b/), ''))) {
    if (line.startsWith('```')) { flush(); inFence = !inFence; continue; }
    if (!inFence && !line.trim()) { flush(); continue; }
    current.push(line);
  }
  flush();
  return units;
}
// The review's requested guard: no arrow into PASS on anything that names the RESOLVED
// marker (always written uppercase, so "unresolved" and the lowercase example label do not
// count). Read per line and per joined unit. Whether prose grants PASS some other way is a
// reading a text test cannot make; the provenance and BLOCKER tokens below carry the rule.
const NAMES_MARKER = /\bRESOLVED\b/;
const ARROW_TO_PASS = /(→|-+>|=+>|—+>|⇒|⟶|⟹|➔|➜|➡|↦)\s*[*`_"'“”‘’]*\s*PASS\b/i;

describe('plan-checker Dimension 11 requires provenance, not a marker (#5438)', () => {
  test('nothing that names RESOLVED has an arrow into PASS, and the suffix is never evidence', () => {
    for (const text of [...splitLines(dim11), ...readingUnits(dim11)]) {
      if (NAMES_MARKER.test(text)) assert.doesNotMatch(text, ARROW_TO_PASS, `RESOLVED routed into PASS: ${text}`);
    }
    assert.ok(
      steps.some((s) => s.includes('`(RESOLVED)`') && /never evidence/.test(s)),
      'a step must say the (RESOLVED) heading suffix is never evidence',
    );
  });

  test('a resolution counts only when it cites a D-NN that exists in CONTEXT.md and answers the question', () => {
    assert.match(dim11, /only\s+the\s+user\s+closes/i);
    assert.ok(
      steps.some((l) => l.includes('`D-NN`') && l.includes('CONTEXT.md') && /\bexists\b/.test(l) && /\banswers\b/.test(l)),
      'a step must check that the cited D-NN exists in CONTEXT.md and answers the question',
    );
  });

  test('the BLOCKER step names every case: uncited, dangling, irrelevant, non-user authority', () => {
    const blocker = steps.find((l) => /\bBLOCKER\b/.test(l));
    assert.ok(blocker, 'Process must carry a BLOCKER step');
    const cases = {
      'no resolution': /no resolution/,
      'marked RESOLVED without a D-NN': /`RESOLVED`[^;]*without citing/,
      'a D-NN CONTEXT.md lacks': /does not contain/,
      'a D-NN that decides something else': /decides something else/,
      'a plan': /\bplan\b/,
      'a disposition': /disposition/,
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
      assert.match(prop, /CONTEXT\.md/);
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
    assert.match(item[0], /CONTEXT\.md/);
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
