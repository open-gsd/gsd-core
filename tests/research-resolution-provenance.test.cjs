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
 *   in `## REVISION_CONFLICT`, because the planner cannot reach the binding property itself. The
 *   shared Resolve step (`revision-loop.md`) asks the user and records each answer as a `D-NN`,
 *   so the blocker clears inside the loop. With no CONTEXT.md the user leaves the loop for discuss-phase;
 *   where no one can be asked (`--auto`, or a background or nested agent, which both of autonomous's background
 *   dispatches tell the agent it is) no answer is recorded, the planner is not re-spawned, the workflow stops at the escalation with a marker line, and autonomous never executes
 *   plans whose run carries it.
 * - verify-work's gap-closure checker skips Dimension 11: that loop has no CONTEXT.md and no route
 *   to record a ruling, so the spine and the checker prompt both scope the dimension out.
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
    assert.match(collect, /whatever status it claims \(resolved, decided, closed\)/, 'a question the researcher calls closed is still collected, whatever word it uses');
    assert.match(collect, /needing an answer or a user ruling before planning/, 'the collection is bounded to what planning needs');
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
    // A fact awaiting confirmation is not a question here: the question its error would raise is listed under
    // Open Questions on its own. A ruling written into the Assumptions Log is still a ruling, so it is still collected.
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

  // Step 1 excludes sourced facts, Discretion-area recommendations and [ASSUMED] facts; a Question line asking about
  // every "research question" would have a model that anchors on it block those too.
  test('the Question line asks about the questions step 1 collects, not every research question', () => {
    const q = splitLines(dim11()).find((l) => l.startsWith('**Question:**'));
    assert.ok(q, 'Dimension 11 must carry a Question line');
    assert.match(q, /every open question \(step 1\) cite a recorded user decision/);
    assert.doesNotMatch(q, /research question/);
  });

  test('no CONTEXT.md leaves every question a BLOCKER', () => {
    assert.ok(steps().some((s) => /No CONTEXT\.md: every question is a BLOCKER/.test(s)), 'Process must say what happens without CONTEXT.md');
  });

  test('the BLOCKER step covers every other question, and names the cases: uncited, dangling, misplaced, irrelevant, non-user authority', () => {
    const blocker = steps().find((l) => /\bBLOCKER\b/.test(l));
    assert.ok(blocker, 'Process must carry a BLOCKER step');
    const cases = {
      'every other question': /every other question/i,
      'any marking, any letter case': /however marked, in any letter case/,
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
      assert.match(prop, /one answering it/);
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
      // Both commands carry the phase: discuss-phase requires it, and plan-phase without it plans another phase.
      assert.match(hint, /\/gsd:discuss-phase \{phase\} → \/gsd:plan-phase \{phase\} --research\)/);
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
    // verify-work tells the checker to skip Dimension 11; an unconditional checklist item would contradict it.
    assert.match(item[0], /Research resolution checked \(unless skipped\):/);
    // Scoped as the Question line is: step 1 excludes sourced facts, Discretion recommendations and [ASSUMED] facts.
    assert.match(item[0], /each step-1 question, any heading/);
  });
});

describe('a research_resolution blocker has a route to the user (#5438)', () => {
  test('the planner cites a decision already on record, and otherwise returns the conflict', () => {
    const row = splitLines(plannerRevision()).find((l) => l.startsWith('| research_resolution |'));
    assert.ok(row, 'the revision strategy table must carry a research_resolution row');
    assert.match(row, /Cite a `D-NN` already under CONTEXT\.md `<decisions>`, outside Claude's Discretion/);
    assert.match(row, /add RESEARCH\.md to the Step 6 commit/, 'Step 6 commits only PLAN.md files, so the citation would stay uncommitted');
    assert.match(row, /the orchestrator commits CONTEXT\.md when it records an answer/);
    // The citation is a mark on the question, so "never mark it" would forbid the route itself.
    assert.match(row, /That citation is the only mark you write on a question/);
    assert.doesNotMatch(row, /never mark the question closed/);
    assert.match(row, /return `## REVISION_CONFLICT` naming each question/, 'the planner cannot reach the property, so the loop must not spend iterations on it');
    assert.match(row, /the orchestrator asks and records each answer as a `D-NN`/, 'the conflict must name the route that can take effect inside the loop');
    assert.match(row, /Never add a decision yourself/);
    // Step 2 holds EVERY cited D-NN to <decisions>, so one valid citation cannot carry a bad one.
    assert.match(row, /dropping any other `D-NN` it cites/);
    // The two conditions that pick the route: a citation only on the question it answers, and the
    // conflict only with no such D-NN.
    assert.match(row, /on the question it answers in RESEARCH\.md/);
    assert.match(row, /With no such `D-NN`, return `## REVISION_CONFLICT`/);
    // A D-NN recorded mid-loop is a trackable decision: cited only in RESEARCH.md, Dimension 7 and plan-phase's
    // step 13a decision-coverage gate would fail it next. Dimension 7 reads a task's action, and the gate scans
    // `<action>` bodies (XML_DECISION_TAG_NAMES), so the action is the one place both find it.
    assert.match(row, /Also cite each `D-NN` recorded in this loop in the `<action>` of the task that implements it/);
    assert.doesNotMatch(row, /must_haves`\/`truths` of the plan/, 'Dimension 7 does not read must_haves or truths');
  });

  // The row tells the re-spawned planner to edit RESEARCH.md, so plan-phase's revision prompt must hand it over.
  test('plan-phase\'s revision prompt hands the planner RESEARCH.md, which the row tells it to edit', () => {
    const prompt = span(read('gsd-core/workflows/plan-phase.md'), '<revision_context>', /<\/revision_context>/);
    const reading = span(prompt, '<required_reading>', /<\/required_reading>/);
    assert.match(reading, /- \{research_path\} \(Technical Research\)/);
  });

  // revision-loop.md's Resolve step is the shared protocol plan-phase imports. Quick's checker is handed only
  // PLAN.md and finds research by phase number, so Dimension 11 skips there and no such conflict reaches quick.
  const resolve = once(() => {
    const doc = read('gsd-core/references/revision-loop.md');
    return span(doc, '3. **Resolve**', /\n4\. \*\*Close\*\*/).replace(/\s+/g, ' ');
  });

  test('the Resolve step records the user\'s answer as a D-NN, so adopting the alternative clears the blocker inside the loop', () => {
    assert.match(resolve(), /For a `research_resolution` conflict, adopting the alternative means the user rules here/);
    assert.match(resolve(), /ask each question the conflict names/);
    // A plain `- D-02:` bullet goes untracked and `- **D-02** — …` makes the step 13a gate return could-not-parse;
    // the CONTEXT.md template's form parses.
    assert.match(resolve(), /in the template's bullet form `- \*\*D-NN:\*\* <ruling>`/);
    // Step 6 does not run when the re-spawn returns another conflict and the loop escalates, so the
    // recorded answer is committed where it is written.
    assert.match(resolve(), /commit CONTEXT\.md at once \(`gsd_run query commit "docs\(\{phase\}\): record research rulings" --files \{context_path\}`\): the planner's Step 6 commit does not run when the loop escalates/);
    assert.match(resolve(), /The re-spawned planner cites it in RESEARCH\.md and in the `<action>` of the task that implements it/);
    assert.match(resolve(), /record each answer under the checker's CONTEXT\.md `<decisions>`, outside Claude's Discretion, as the next unused `D-NN`/);
    assert.match(resolve(), /`\/gsd:discuss-phase \{phase\} \$\{GSD_WS\}` or `\/gsd:plan-phase \{phase\} --research \$\{GSD_WS\}`/, 'leaving the loop stays open to the user, in the same workstream');
    assert.doesNotMatch(resolve(), /`\/gsd:(discuss|plan)-phase( --research)?`/, 'every command the Resolve step names carries {phase}');
    assert.doesNotMatch(resolve(), /`\/gsd:(discuss-phase \{phase\}|plan-phase \{phase\} --research)`/, 'every command the Resolve step names carries ${GSD_WS}');
    // The checker reads the CONTEXT.md path plan-phase resolved at init; a file created mid-loop never reaches it.
    assert.match(resolve(), /With no CONTEXT\.md there is nowhere to record, so the user leaves the loop for `\/gsd:discuss-phase \{phase\} \$\{GSD_WS\}`, which writes one/);
  });

  // Close fires only once a resolution is applied, and plan-phase closes a line only on the revised plans a
  // re-spawn returns. Leaving the loop has no re-spawn, so without its own close the REVIEWS.md line stays
  // open and plan-review-convergence counts it until MAX_CYCLES.
  test('leaving the loop closes the conflict line and ends the workflow, so convergence does not count it for good', () => {
    assert.match(resolve(), /Leaving ends the workflow once it names the command/);
    // plan-review-convergence runs plan-phase inline and its reviewers never re-run Dimension 11, so with the line
    // closed it would converge over the open question unless leaving ends it too.
    assert.match(resolve(), /without `## PLANNING COMPLETE`, and ends any `\/gsd:plan-review-convergence` run around it too/);
    assert.match(resolve(), /so it must stop, never converge over the open question/);
    assert.match(resolve(), /close this conflict's line now \(Close, below\) with ` \| resolved: user left the loop for \{command\}`/);
    assert.match(resolve(), /leave the plans on disk as they are/);
    assert.match(resolve(), /A later checker run raises Dimension 11 again for any question still open/);
    const binding = splitLines(read('gsd-core/workflows/plan-phase.md')).find((l) => l.startsWith('- Record channel:'));
    assert.ok(binding, 'plan-phase must bind the record channel');
    const rest = read('gsd-core/workflows/plan-phase.md').split(binding)[1].split('\n')[1];
    assert.match(`${binding} ${rest}`, /plan-phase closes it; leaving the loop: close \(fence below\), then stop\./);
    // The close fence runs only when CONVERGENCE_ENABLED is "true", and nothing persists across fences, so the
    // export list it states must name it, or the close silently does nothing and the line stays open.
    const close = read('gsd-core/workflows/plan-phase.md').replace(/\s+/g, ' ');
    assert.match(close, /close its record — nothing persists across fences, so export `REVIEWS_FILE`, `CONVERGENCE_ENABLED`, the `CONFLICT_DIMENSION`\/`CONFLICT_PLAN` that opened it, and `CONFLICT_RESOLUTION`/);
  });

  // A re-spawn under --auto can only return the same conflict, and the cap gate has no --auto choice of its
  // own; proceeding there would ship the plans with the blocker open, the opposite of what the docs promise.
  test('under --auto nothing is recorded and nothing re-spawns: the blocker escalates at once and the workflow stops', () => {
    assert.match(resolve(), /Record only what the user said\. No one can be asked when .* Where no one can be asked, record no answer and do not re-spawn/);
    assert.match(resolve(), /Escalate at once, and at that gate stop the workflow rather than proceed/);
    assert.doesNotMatch(resolve(), /Repeat rule/, 'the --auto route no longer spends a planner run to reach the Repeat rule, in any wording');
    // The section's closing rule must agree, or "asking is the route everywhere" contradicts the --auto clause.
    const route = read('gsd-core/references/revision-loop.md').replace(/\s+/g, ' ');
    assert.match(route, /Asking the user is the route everywhere but where no one can be asked \(Resolve, above\), where a `research_resolution` conflict escalates and stops/);
    // Step 2 still writes the REVIEWS.md conflict line under --auto; what --auto skips is recording an answer.
    assert.match(route, /recording is in addition to asking, never instead of it/);
  });

  // Every chained caller passes --auto to plan-phase, and gsd-autonomous passes nothing but runs plan-phase as a
  // background agent when it does not flatten. Keyed to AUTO_CHAIN, a flag an interrupted chain left set would
  // refuse a present user, and autonomous would still never stop; so the key is --auto or a background agent.
  test('no one is asked under --auto or in a background agent; AUTO_CHAIN is named as not the key', () => {
    assert.match(resolve(), /No one can be asked when plan-phase's arguments carry `--auto`, as discuss-phase's chain and transition pass, or when it runs as a background or nested agent, where AskUserQuestion cannot reach the user, as `\/gsd:autonomous` dispatches it when it does not flatten\. A run that calls plan-phase inline without `--auto` asks, and waits for the answer\./);
    assert.doesNotMatch(resolve(), /every chained caller/, 'next.md and plan-review-convergence call plan-phase without --auto');
    assert.match(resolve(), /`AUTO_CHAIN` \(`workflow\._auto_chain_active`\) is not the key: a chained run passes `--auto` anyway, and a flag an interrupted chain left set, which a manual plan-phase clears only at its step 15, after this loop, would refuse a user who is present\./);
    assert.doesNotMatch(resolve(), /only plan-phase's step 15 clears/, 'execute-phase, discuss-phase and transition clear the flag too');
    assert.doesNotMatch(resolve(), /--chain/, 'plan-phase does not advertise --chain, so the rule does not name it');
    // The grounds the clause states: each chained caller passes --auto; autonomous passes none and backgrounds it.
    assert.match(read('gsd-core/workflows/discuss-phase/modes/chain.md'), /Skill\(skill="gsd-plan-phase", args="\$\{PHASE\} --auto/);
    assert.match(read('gsd-core/workflows/discuss-phase-assumptions/steps/auto-advance-dispatch.md'), /Skill\(skill="gsd-plan-phase", args="\$\{PHASE\} --auto"\)/);
    assert.match(read('gsd-core/workflows/transition.md'), /\/gsd:plan-phase \[X\+1\] --auto/);
    const auto = read('gsd-core/workflows/autonomous.md');
    const calls = auto.split('\n').filter((l) => /gsd-plan-phase\\?", args=\\?"\$\{PHASE_NUM\}/.test(l));
    assert.ok(calls.length >= 3, 'autonomous invokes plan-phase');
    for (const l of calls) assert.doesNotMatch(l, /--auto|--chain/, l);
    assert.match(auto.replace(/\s+/g, ' '), /run_in_background=true, prompt="Background: no AskUserQuestion\. Run plan-phase for phase \$\{PHASE_NUM\}/);
    // The converge strategy's background dispatch runs plan-review-convergence, and plan-phase inside it, in a
    // background agent as well, so its prompt carries the same line.
    const convergeBg = read('gsd-core/workflows/autonomous/steps/converge-dispatch-bg.md').replace(/\s+/g, ' ');
    assert.match(convergeBg, /run_in_background=true, prompt="Background: no AskUserQuestion\. Run plan convergence for phase \$\{PHASE_NUM\}/);
    // Within plan-phase, only step 15 clears a leftover flag, and it runs after the revision loop.
    assert.match(read('gsd-core/workflows/plan-phase/steps/auto-advance-check.md'), /gsd_run query config-set workflow\._auto_chain_active false/);
    const spine = read('gsd-core/workflows/plan-phase.md');
    const loop = spine.indexOf('## 12. Revision Loop');
    const step15 = spine.indexOf('plan-phase/steps/auto-advance-check.md');
    assert.ok(loop !== -1 && step15 !== -1 && step15 > loop, 'auto-advance-check runs after the revision loop');
    for (const doc of ['docs/features/research-gate.md', 'docs/FEATURES.md']) {
      assert.match(read(doc), /Where no one can be asked \(`--auto`, or plan-phase running as a background or nested agent, as `\/gsd-autonomous` runs it when it does not flatten\) no answer is recorded: plan-phase escalates at once and stops there rather than proceeding, and `\/gsd-autonomous` does not execute the plans; they stay on disk, where `\/gsd-progress --next` or `\/gsd-execute-phase` can still run them/, doc);
      assert.match(read(doc), /the user leaves to run `\/gsd-discuss-phase <N>` or `\/gsd-plan-phase <N> --research`\./, doc);
    }
  });

  // Resolve leaves the plans on disk when it stops, and autonomous checked only has_plans before executing.
  test('both stops end plan-phase with a marker line, and autonomous never executes plans whose run carries it', () => {
    assert.match(resolve(), /This stop and leaving the loop both end plan-phase with the line `PLANNING STOPPED: research questions need a user ruling`, which `\/gsd:autonomous` reads so that it does not execute the plans\. The plans stay on disk, as after the cap gate's Abandon, so `\/gsd:progress --next` or `\/gsd:execute-phase` can still run them\./);
    assert.doesNotMatch(resolve(), /a caller never executes/, 'only autonomous reads the marker');
    const auto = read('gsd-core/workflows/autonomous.md').replace(/\s+/g, ' ');
    // One rule covers all three plan runs (3b, the INTERACTIVE wait at 3c, gap closure): autonomous.md sits
    // just under its 40,960-char limit (tests/autonomous-decomposition.test.cjs), so it is stated once.
    assert.match(auto, /check `has_plans`\. If false → go to handle_blocker: "Plan phase \$\{PHASE_NUM\} did not produce any plans\." Any plan run \(here, 3c, gap closure\) printing `PLANNING STOPPED` → handle_blocker with it; never execute its plans\./);
    // The background planner is told it cannot ask, so the no-one-can-be-asked stop is observable to it.
    assert.match(auto, /prompt="Background: no AskUserQuestion\. Run plan-phase for phase \$\{PHASE_NUM\}/);
  });
});

// With no CONTEXT.md, Dimension 11 makes every open research question a BLOCKER that only a ruling recorded by
// discuss-phase clears, so the option that skips it says so where the user chooses.
describe('plan-phase\'s no-context option names the Dimension 11 consequence (#5438)', () => {
  test('both forms of "Continue without context" say open research questions block until discuss-phase', () => {
    const lines = splitLines(read('gsd-core/workflows/plan-phase.md')).filter((l) => /Continue without context\W* — /.test(l));
    assert.equal(lines.length, 2, 'the text-mode list and the AskUserQuestion options each carry the option');
    for (const l of lines) assert.match(l, / — Open research questions block until discuss-phase$/);
    // The option no longer repeats what the plan rests on, so both menus' prefaces must still say it.
    const prefaces = splitLines(read('gsd-core/workflows/plan-phase.md')).filter((l) => l.includes('No CONTEXT.md for Phase {X}: plans use research and requirements only, not your design preferences.'));
    assert.equal(prefaces.length, 2, 'the text-mode list and the AskUserQuestion question each keep the preface');
  });
});

// verify-work's gap-closure loop hands the checker only the fix plans: no CONTEXT.md, and its inline conflict
// handler has no route to record a user ruling. Dimension 11 would block every research question there with
// no way to clear it, so the loop scopes the dimension out. The spine states it because a compact-content run
// never reads the detail file; the detail file states it because that is the prompt a full run sends.
describe('verify-work\'s gap-closure checker skips Dimension 11, and import\'s does not (#5438)', () => {
  const skip = /Skip Dimension 11 \(research resolution\)/i;
  test('the spine tells the checker to skip it, so a compact-content run does too', () => {
    const step = span(read('gsd-core/workflows/verify-work.md'), '<step name="verify_gap_plans">', /<\/step>/);
    assert.match(step, skip);
    assert.match(step, /no CONTEXT\.md and has no route to record a user ruling/);
    // Not "the plans add no research": Dimension 11 checks the phase RESEARCH.md, not research a plan adds.
    assert.doesNotMatch(step, /add no research/);
  });

  // import --from must NOT skip it: /gsd-ultraplan-phase plans from the phase's RESEARCH.md and validates only
  // through import, so a skip there would pass an open research question silently.
  test('import --from\'s checker prompt does not skip it', () => {
    const step = span(read('gsd-core/workflows/import.md'), '<step name="plan_validate">', /<\/step>/);
    assert.match(step, /subagent_type: "gsd-plan-checker"/);
    assert.doesNotMatch(step, /Dimension 11|research.resolution|research question/i,
      'no wording of a research-resolution skip, not only the dimension number');
  });

  test('the checker prompt carries the same scope line', () => {
    const prompt = span(read('gsd-core/workflows/verify-work/detail/elaboration.md'), '<verification_context>', /<\/verification_context>/);
    assert.match(prompt, /\*\*Scope:\*\* Gap-closure plans\. Skip Dimension 11 \(research resolution\)/);
    assert.match(prompt, /this loop hands you no CONTEXT\.md and records no user ruling/);
    assert.doesNotMatch(prompt, /add no research/);
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
    assert.match(log, /not[\s>]+an[\s>]+assumption:[\s>]+list[\s>]+it[\s>]+under[\s>]+Open[\s>]+Questions/);
    // Dimension 11 does not collect these rows, and only the planner's human-verify checkpoint for an `[ASSUMED]`
    // package confirms one; discuss-phase runs before research and never reads RESEARCH.md. So the header says
    // what is true, and a fact whose error would change the plan raises its question under Open Questions.
    // A blockquote: a wrap carries its `> ` into the gap between two words.
    assert.match(log, /The[\s>]+planner[\s>]+gates[\s>]+`\[ASSUMED\]`[\s>]+packages[\s>]+behind[\s>]+a[\s>]+human-verify[\s>]+checkpoint;[\s>]+nothing[\s>]+else[\s>]+confirms[\s>]+an[\s>]+assumed[\s>]+fact/);
    assert.match(log, /when[\s>]+an[\s>]+error[\s>]+in[\s>]+one[\s>]+would[\s>]+change[\s>]+the[\s>]+plan,[\s>]+also[\s>]+list[\s>]+the[\s>]+question[\s>]+it[\s>]+raises[\s>]+under[\s>]+Open[\s>]+Questions/);
    assert.doesNotMatch(log, /discuss-phase[\s>]+confirms/, 'discuss-phase runs before research and confirms no assumption');
    assert.doesNotMatch(log, /decisions\s+that\s+need\s+user\s+confirmation/, 'the log header must not call its rows pending decisions');
    assert.match(fence().after, /`\[ASSUMED\]`\s+fact\s+stays\s+in\s+the\s+Assumptions\s+Log,\s+even\s+awaiting\s+confirmation/);
    assert.match(fence().after, /when\s+an\s+error\s+in\s+it\s+would\s+change\s+the\s+plan,\s+also\s+list\s+the\s+question\s+it\s+raises\s+under\s+Open\s+Questions/);
  });

  test('the rule after the RESEARCH.md template forbids self-resolution and the section-heading suffix', () => {
    const rule = fence().after;
    assert.match(rule, /never\s+mark\s+a\s+question\s+resolved,\s+decided\s+or\s+closed/i);
    assert.match(rule, /`\(RESOLVED\)`\s+suffix\s+to\s+the\s+section\s+heading/);
    assert.match(rule, /RESOLVED \(D-NN\)/);
    assert.match(rule, /using\s+the\s+decision's\s+real\s+number/, 'a placeholder D-NN must never reach RESEARCH.md');
    // Universal, as checker step 2: a question citing one valid D-NN and one that is not still blocks.
    assert.match(rule, /cites\s+no\s+such\s+`D-NN`,\s+or\s+any\s+other\s+\(Dimension\s+11\)/);
    assert.match(rule, /list\s+every\s+such\s+question\s+in\s+that\s+section/);
    assert.match(rule, /a\s+factual\s+question\s+you\s+settled/);
    assert.match(rule, /No\s+source\s+settles\s+a\s+choice\s+that\s+needs\s+a\s+user\s+ruling/);
    assert.match(rule, /Claude's\s+Discretion,\s+recommend\s+with\s+a\s+source/);
    assert.match(rule, /Claude's\s+Discretion\s+entry\s+is\s+no\s+ruling/);
    assert.match(rule, /CONTEXT\.md's\s+`<decisions>`/);
    assert.match(rule, /Never\s+add\s+a\s+decision\s+to\s+CONTEXT\.md\s+\(discuss-phase\s+or\s+the\s+orchestrator\s+records\s+the\s+user's\s+ruling\)/);
    // Anchored on the negation: matching `cite a plan` alone passes when "never" becomes "always".
    assert.match(rule, /\bnever\s+cite\s+a\s+plan,\s+a\s+disposition\b/i);
  });

  test('the return template leaves open questions to a user ruling', () => {
    const ret = span(researcher(), '\n### Open Questions\n', /\n### /);
    assert.doesNotMatch(ret, GATE_TOKEN);
    // Step 1 collects a factual question that needs an answer, not only a ruling.
    assert.match(ret, /each needs an answer or a user ruling/);
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
    // Worded as checker step 2: a Discretion D-NN rules on no question, its own included.
    assert.match(guide, /A Discretion `D-NN` is never a ruling, on that question or any other/);
    assert.match(guide, /every `D-NN` it cites is under CONTEXT\.md's `<decisions>`, outside Claude's Discretion, and one answers it/);
  });
});

// One rule, restated on every prompt surface a model reads (CLAUDE.md "Generative Fix Divergence").
// Each surface is pinned above by its own patterns; this suite asserts the shared tokens on all of
// them at once, so a surface that drops one while the others keep it fails here by name.
describe('the resolution rule says the same thing on every prompt surface (#5438)', () => {
  const flat = (t) => t.replace(/\s+/g, ' ');
  // Surfaces that tell a model what a valid citation is.
  const citing = once(() => ({
    'checker step 2': steps().find((l) => /\bpasses only\b/.test(l)) || '',
    'checker required_property': (dim11().match(/required_property:\s*"([^"]*)"/) || [])[1] || '',
    'checker success_criteria': flat((span(checker(), '<success_criteria>', /<\/success_criteria>/).match(/- \[ \] Research resolution checked[^\n]*\n[^\n]*/) || [''])[0]),
    'researcher rule': flat(researchTemplateFence(researcher()).after),
    'research template': flat(span(researchTemplate(), '\n**Open Questions:**\n', /\n\n/)),
    'planner row': splitLines(plannerRevision()).find((l) => l.startsWith('| research_resolution |')) || '',
  }));
  // Surfaces that record a user's answer as a decision.
  const recording = once(() => {
    const loop = flat(read('gsd-core/references/revision-loop.md'));
    const cut = (t) => { const at = t.indexOf('For a `research_resolution` conflict'); return at === -1 ? '' : t.slice(at, at + 600); };
    return { 'revision-loop Resolve': cut(loop) };
  });

  test('every citing surface scopes a D-NN to <decisions>, excludes Claude\'s Discretion, and needs one that answers', () => {
    for (const [name, text] of Object.entries(citing())) {
      assert.ok(text, `surface not found: ${name}`);
      assert.match(text, /<decisions>/, `${name} does not scope the D-NN to <decisions>`);
      assert.match(text, /outside Claude's Discretion|\(not Discretion\)|Discretion entry is no ruling|Discretion `D-NN` is never a ruling/, `${name} drops the Discretion exclusion`);
      assert.match(text, /one answers it|one of which answers it|one answering it|a decision that answers a question|on the question it answers/, `${name} drops the condition that a cited D-NN answers the question`);
    }
  });

  test('every recording surface writes the answer under <decisions>, outside Claude\'s Discretion', () => {
    for (const [name, text] of Object.entries(recording())) {
      assert.ok(text, `surface not found: ${name}`);
      assert.match(text, /<decisions>/, `${name} does not record under <decisions>`);
      assert.match(text, /outside Claude's Discretion/, `${name} could record a ruling into the Discretion area`);
      assert.match(text, /as the next unused `D-NN`/, `${name} does not record the answer as a citable D-NN`);
    }
  });

  test('no surface keeps a run boundary the checker cannot locate', () => {
    for (const [name, text] of Object.entries({ ...citing(), ...recording(), 'checker Dimension 11': dim11() })) {
      assert.doesNotMatch(text, /recorded before|planning run/, `${name} still carries the run boundary`);
    }
  });

  test('the agents that may write RESEARCH.md citations never add a decision themselves', () => {
    assert.match(dim11(), /never the researcher or planner/);
    assert.match(citing()['researcher rule'], /Never add a decision to CONTEXT\.md/);
    assert.match(citing()['planner row'], /Never add a decision yourself/);
  });
});
