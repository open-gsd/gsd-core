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
 * - Dimension 11 collects every question still needing an answer or a ruling, under any heading
 *   or in prose. A cited source closes a factual question only; a Claude's Discretion area of
 *   CONTEXT.md takes a sourced recommendation; an `[ASSUMED]` fact, even unconfirmed, is not a
 *   question. It passes a question only on the provenance it accepts: every `D-NN` it cites sits
 *   under CONTEXT.md's `<decisions>`, outside Claude's Discretion, and one answers it. Only
 *   discuss-phase or the orchestrator, recording the user's answer, writes such a `D-NN`.
 *   It blocks every other question, naming the citation shapes the forgery used (none, a plan, a
 *   "disposition"), and every question when CONTEXT.md is absent. Only the no-questions case
 *   reaches PASS.
 * - Its fix_hint routes to recording a user ruling, not to writing the marker: a decision already
 *   on record is cited; otherwise the user rules, recorded by the orchestrator or by discuss-phase
 *   and a research re-run, or a source settles a factual gap.
 * - `planner-revision.md` carries the same route as a `research_resolution` strategy row, ending
 *   in `## REVISION_CONFLICT`, because the planner cannot reach the binding property itself.
 * - Its worked examples: the PASS example cites `D-NN`; the self-resolved shape, and a real
 *   `D-NN` that decides something else, are a BLOCKER example.
 * - `<success_criteria>` carries the dimension, so the checklist the agent ends on
 *   includes it.
 * - The researcher and `gsd-core/templates/research.md` forbid self-resolution, and
 *   state the rule outside the RESEARCH.md template, no part of which carries a
 *   `RESOLVED` token a model could copy into the file the checker reads. The template's
 *   Assumptions Log holds facts; a choice awaiting a ruling goes under Open Questions.
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

// Subjects load on first use, inside a test: a missing file or heading then fails that test by
// name instead of throwing before any test registers (RULESET.TESTS.guard-toplevel-readFileSync).
function once(load) {
  let loaded = false;
  let value;
  return () => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
    return value;
  };
}

const checker = once(() => read('agents/gsd-plan-checker.md'));
const researcher = once(() => read('agents/gsd-phase-researcher.md'));
const researchTemplate = once(() => read('gsd-core/templates/research.md'));
const plannerRevision = once(() => read('gsd-core/references/planner-revision.md'));

function span(doc, startHeading, endPattern) {
  const start = doc.indexOf(startHeading);
  assert.notEqual(start, -1, `missing heading: ${startHeading}`);
  const rest = doc.slice(start + startHeading.length);
  const end = rest.search(endPattern);
  return end === -1 ? rest : rest.slice(0, end);
}

const dim11 = once(() => span(checker(), '## Dimension 11: Research Resolution', /\n## Dimension 12\b/));
// The numbered Process steps, from **Process:** to the first worked example, each with its
// whitespace collapsed so a wrap cannot split one step. Assertions below match invariant
// tokens within a step, never whole sentences.
const steps = once(() =>
  span(dim11(), '**Process:**', /\n\*\*Example\b/)
    .split(/\n(?=\d+\.\s)/)
    .filter((s) => /^\d+\.\s/.test(s))
    .map((s) => s.replace(/\s+/g, ' ').trim()),
);
// The dimension as a model reads its rules: everything but the fenced examples and their labels.
const rules = once(() =>
  splitLines(stripFencedCode(dim11()).text)
    .filter((l) => !/^\*\*Example\b/.test(l))
    .join('\n'),
);

describe('plan-checker Dimension 11 requires provenance, not a marker (#5438)', () => {
  test('PASS is reached only when there are no questions, and the suffix is never evidence', () => {
    const passSteps = steps().filter((s) => /\bPASS\b/.test(s));
    assert.equal(passSteps.length, 1, 'exactly one Process step may grant PASS');
    assert.match(passSteps[0], /\b(no questions|none)\b/i, `PASS granted other than for no questions: ${passSteps[0]}`);
    assert.doesNotMatch(passSteps[0], /RESOLVED/, `PASS granted on the marker: ${passSteps[0]}`);
    assert.equal(
      (rules().match(/\bPASS\b/g) || []).length,
      (passSteps[0].match(/\bPASS\b/g) || []).length,
      'the dimension grants PASS outside its no-questions step',
    );
    assert.ok(
      steps().some((s) => s.includes('`(RESOLVED)`') && /never evidence/.test(s)),
      'a step must say the (RESOLVED) heading suffix is never evidence',
    );
  });

  test('every question still needing a ruling is collected, whatever its heading, form or claimed status', () => {
    const collect = steps()[0];
    assert.match(collect, /needing an answer or a user ruling/);
    assert.match(collect, /any heading/, 'step 1 must not key on one literal heading');
    assert.match(collect, /\bprose\b/, 'step 1 must collect questions written as prose');
    assert.match(collect, /whatever status it claims/, 'a question the researcher calls closed is still collected');
    // The exclusions sit after their marker, so they stay exclusions: one that moves in front of it, or a
    // marker reworded into a collection rule, fails here.
    const marker = collect.indexOf('Not one:');
    assert.notEqual(marker, -1, 'step 1 must mark what it excludes');
    const collected = collect.slice(0, marker);
    const excluded = collect.slice(marker);
    assert.doesNotMatch(collected, /cited source|Discretion|ASSUMED/, 'an exclusion sits on the collecting side of its marker');
    assert.match(excluded, /a fact settled with a cited source/, 'research findings are not questions');
    assert.match(excluded, /no source settles a ruling/, 'a source must not close a question that needs a ruling');
    assert.match(excluded, /a question with a sourced recommendation in an area CONTEXT\.md lists under Claude's Discretion/, 'the exclusion binds per question, and CONTEXT.md decides what is delegated');
    // A fact awaiting confirmation is confirmed by a human-verify checkpoint or discuss-phase, not
    // here; a ruling written into the Assumptions Log is still a ruling, so it is still collected.
    assert.match(excluded, /`\[ASSUMED\]` fact, even unconfirmed \(a ruling is never a fact\)/, 'an Assumptions Log fact is not a question, even awaiting confirmation; a ruling is never one');
  });

  test('a question passes only on a D-NN under CONTEXT.md <decisions> that answers it, which only the user\'s recorded answer writes', () => {
    assert.match(dim11(), /only\s+the\s+user\s+closes/i);
    // The checker cannot see when a D-NN was added, so authorship is the rule, not a time boundary.
    assert.match(dim11(), /discuss-phase or the orchestrator records the ruling as a `D-NN`, never the researcher or planner/);
    const pass = steps().find((l) => /\bpasses only\b/.test(l));
    assert.ok(pass, 'a step must state the one way a question passes');
    assert.ok(pass.includes('every `D-NN` it cites') && pass.includes("CONTEXT.md's `<decisions>`"), `pass rule not scoped to <decisions> for every citation: ${pass}`);
    assert.match(pass, /\bone answers\b/, 'one real citation must not carry a second that is missing, and one must answer');
    assert.match(pass, /outside Claude's Discretion/, 'a Discretion entry delegates the choice, so it records no ruling');
    assert.doesNotMatch(dim11(), /planning run|recorded before/, 'a run boundary the checker cannot locate gives one input two verdicts');
  });

  test('no CONTEXT.md leaves every question a BLOCKER', () => {
    assert.ok(steps().some((s) => /No CONTEXT\.md: every question is a BLOCKER/.test(s)), 'Process must say what happens without CONTEXT.md');
  });

  test('the BLOCKER step covers every other question, and names the cases: uncited, dangling, misplaced, irrelevant, non-user authority', () => {
    const blocker = steps().find((l) => /\bBLOCKER\b/.test(l));
    assert.ok(blocker, 'Process must carry a BLOCKER step');
    const cases = {
      'every other question': /every other question/i,
      'any marking, any letter case': /however marked, in any case/,
      'no D-NN': /no `D-NN`/,
      'a D-NN CONTEXT.md lacks': /CONTEXT\.md lacks/,
      'a D-NN outside <decisions>': /outside `<decisions>`/,
      'a D-NN that decides something else': /deciding something else/,
      // "only": a valid answering D-NN must not turn into a blocker for also naming a plan.
      'a plan': /resting only on a plan\b/,
      'a disposition': /"planning-time disposition"/,
      'the research itself': /research itself/,
      "another agent's output": /another agent/,
    };
    for (const [name, re] of Object.entries(cases)) assert.match(blocker, re, `BLOCKER step omits: ${name}`);
  });

  test('the worked issue carries the dimension and blocker severity the revision loop keys on', () => {
    const lines = splitLines(dim11());
    const at = lines.findIndex((l) => l.startsWith('**Example — unresolved questions:**'));
    assert.notEqual(at, -1, 'Dimension 11 must carry the unresolved-questions example');
    const close = lines.findIndex((l, i) => i > at + 1 && l.startsWith('```'));
    const example = lines.slice(at, close).map((l) => l.trim());
    assert.ok(example.includes('dimension: research_resolution'));
    assert.ok(example.includes('severity: blocker'));
  });

  test('the binding required_property carries the relevance condition', () => {
    const props = [...dim11().matchAll(/required_property:\s*"([^"]*)"/g)].map((m) => m[1]);
    assert.ok(props.length >= 1, 'Dimension 11 must carry a required_property example');
    for (const prop of props) {
      assert.match(prop, /cites only D-NNs/);
      assert.match(prop, /CONTEXT\.md <decisions> \(not Discretion\)/, 'the binding property must carry the rule step 2 enforces, or the planner can satisfy it where the checker refuses');
      assert.doesNotMatch(prop, /planning run|recorded before/, 'the binding property must hold only what the checker can see');
      assert.match(prop, /one of which answers it/);
    }
  });

  test('fix_hint routes to a decision on record, else a user ruling and a research re-run, never to the planner adding one', () => {
    const hints = [...dim11().matchAll(/fix_hint:\s*"([^"]*)"/g)].map((m) => m[1]);
    assert.ok(hints.length >= 1, 'Dimension 11 must carry a fix_hint example');
    for (const hint of hints) {
      assert.doesNotMatch(hint, /mark section as/i, `fix_hint still prescribes the marker: ${hint}`);
      assert.match(hint, /D-NN/);
      assert.match(hint, /<decisions>/);
      // The BLOCKER goes to the planner's revision loop. It can cite a decision already on record;
      // otherwise the user rules, and the hint names who records it and what settles a factual gap.
      assert.match(hint, /Cite a D-NN under <decisions> that answers it/);
      assert.match(hint, /Else the user rules \(orchestrator records a D-NN, or/);
      assert.match(hint, /a source settles a factual gap/);
      assert.match(hint, /\/gsd:discuss-phase/);
      assert.match(hint, /\/gsd:plan-phase --research/);
    }
  });

  test('the PASS example cites D-NN on every question; the self-resolved shape is a BLOCKER example', () => {
    // Every PASS example, located by its label's tokens (an **Example label that says PASS
    // and not BLOCKER), not its wording.
    const lines = splitLines(dim11());
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

    assert.match(dim11(), /^\*\*Example\b[^\n]*self-resolved[^\n]*\bBLOCKER\b/im);
  });

  test('a BLOCKER example cites a real D-NN that decides something else', () => {
    // #5438's checker models follow the examples: a real D-NN under <decisions> is not enough.
    const lines = splitLines(dim11());
    const at = lines.findIndex((l) => /^\*\*Example\b/.test(l) && /\bBLOCKER\b/.test(l));
    assert.notEqual(at, -1, 'Dimension 11 must carry a BLOCKER example');
    assert.match(lines[at], /real (D-\d{2}) decides/, 'the label must say the cited D-NN is real but decides something else');
    const id = lines[at].match(/real (D-\d{2})/)[1];
    const open = lines.findIndex((l, i) => i > at && l.startsWith('```'));
    const close = lines.findIndex((l, i) => i > open && l.startsWith('```'));
    const body = lines.slice(open + 1, close);
    assert.ok(body.some((l) => l.includes(`RESOLVED (${id}):`)), `the BLOCKER example must cite ${id}`);
  });

  test('success_criteria includes the research resolution check', () => {
    const criteria = span(checker(), '<success_criteria>', /<\/success_criteria>/);
    const item = criteria.match(/- \[ \] Research resolution checked[^\n]*\n[^\n]*/);
    assert.ok(item, 'success_criteria must list the research resolution check');
    assert.match(item[0], /cites only `D-NN`s/);
    assert.match(item[0], /CONTEXT\.md `<decisions>` \(not Discretion\)/);
    assert.match(item[0], /any heading/);
    assert.match(item[0], /one answering it/, 'the checklist must carry the body\'s relevance condition');
  });
});

describe('a research_resolution blocker has a route to the user (#5438)', () => {
  test('the planner cites a decision already on record, and otherwise returns the conflict', () => {
    const row = splitLines(plannerRevision()).find((l) => l.startsWith('| research_resolution |'));
    assert.ok(row, 'the revision strategy table must carry a research_resolution row');
    assert.match(row, /Cite a `D-NN` already under CONTEXT\.md `<decisions>`, outside Claude's Discretion/);
    assert.match(row, /add RESEARCH\.md to the Step 6 commit/, 'Step 6 commits only PLAN.md files, so the citation would stay uncommitted');
    assert.match(row, /return `## REVISION_CONFLICT`/, 'the planner cannot reach the property, so the loop must not spend iterations on it');
    assert.match(row, /`\/gsd:discuss-phase`/);
    assert.match(row, /`\/gsd:plan-phase --research`/);
    assert.match(row, /never add a decision/);
    assert.match(row, /never mark the question closed/);
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
  const fence = once(() => researchTemplateFence(researcher()));

  test('no part of the RESEARCH.md template carries a gate token a model could copy', () => {
    assert.match(fence().body, /\n## Open Questions\n/, 'the template must keep its Open Questions section');
    assert.doesNotMatch(fence().body, GATE_TOKEN);
  });

  test('the Assumptions Log holds facts, and a choice needing a ruling goes under Open Questions', () => {
    const log = span(fence().body, '## Assumptions Log', /\n## /);
    assert.match(log, /facts\s+that\s+need\s+user\s+confirmation/);
    assert.match(log, /not\s+an\s+assumption:\s+list\s+it\s+under\s+Open\s+Questions/);
    assert.doesNotMatch(log, /decisions\s+that\s+need\s+user\s+confirmation/, 'the log header must not call its rows pending decisions');
    assert.match(fence().after, /`\[ASSUMED\]`\s+fact\s+stays\s+in\s+the\s+Assumptions\s+Log/);
  });

  test('the rule after the RESEARCH.md template forbids self-resolution and the section-heading suffix', () => {
    const rule = fence().after;
    assert.match(rule, /never\s+mark\s+a\s+question\s+resolved,\s+decided\s+or\s+closed/i);
    assert.match(rule, /`\(RESOLVED\)`\s+suffix\s+to\s+the\s+section\s+heading/);
    assert.match(rule, /RESOLVED \(D-NN\)/);
    assert.match(rule, /list\s+every\s+such\s+question\s+in\s+that\s+section/);
    assert.match(rule, /a\s+factual\s+question\s+you\s+settled/);
    assert.match(rule, /No\s+source\s+settles\s+a\s+choice\s+that\s+needs\s+a\s+user\s+ruling/);
    assert.match(rule, /Claude's\s+Discretion,\s+recommend\s+with\s+a\s+source/);
    assert.match(rule, /Claude's\s+Discretion\s+entry\s+is\s+no\s+ruling/);
    assert.match(rule, /CONTEXT\.md's\s+`<decisions>`/);
    assert.match(rule, /Never\s+add\s+a\s+decision\s+to\s+CONTEXT\.md/);
    // Anchored on the negation: matching `cite a plan` alone passes when "never" becomes "always".
    assert.match(rule, /\bnever\s+cite\s+a\s+plan,\s+a\s+disposition\b/i);
  });

  test('the return template leaves open questions to a user ruling', () => {
    const ret = span(researcher(), '\n### Open Questions\n', /\n### /);
    assert.doesNotMatch(ret, GATE_TOKEN);
    assert.match(ret, /user ruling/);
    assert.match(ret, /never marked resolved/i);
  });

  test('gsd-core/templates/research.md keeps the rule in Guidelines, outside the template', () => {
    const guidelinesAt = researchTemplate().indexOf('\n## Guidelines\n');
    assert.notEqual(guidelinesAt, -1, 'missing ## Guidelines');
    // Everything above Guidelines is the file template and its worked example.
    assert.match(researchTemplate().slice(0, guidelinesAt), /\n## Open Questions\n/);
    assert.doesNotMatch(researchTemplate().slice(0, guidelinesAt), GATE_TOKEN);
    const guide = span(researchTemplate().slice(guidelinesAt), '\n**Open Questions:**\n', /\n\n/);
    assert.match(guide, /never\s+mark\s+a\s+question\s+resolved,\s+decided\s+or\s+closed/i);
    assert.match(guide, /`\(RESOLVED\)`\s+suffix\s+to\s+the\s+`## Open Questions`\s+section\s+heading/);
    assert.match(guide, /every `D-NN` it cites/);
    assert.match(guide, /one answers it/);
    assert.match(guide, /CONTEXT\.md's `<decisions>`/);
    assert.match(guide, /List every open question in that section/);
    assert.match(guide, /No source settles a choice that needs a user ruling/);
    assert.match(guide, /Claude's Discretion, recommend with a source/);
    assert.match(guide, /Discretion entry is never a ruling/);
  });
});
