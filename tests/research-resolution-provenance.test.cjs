/**
 * Dimension 11 — research resolution requires a user decision on record (#5438).
 *
 * `gsd-plan-checker` Dimension 11 used to PASS when RESEARCH.md's `## Open Questions`
 * heading carried a `(RESOLVED)` suffix, and its own `fix_hint` told authors to write
 * that suffix. `gsd-phase-researcher` writes RESEARCH.md and was never told not to, so
 * the agent whose output the gate checks could close the gate itself. Sonnet and Haiku
 * passed such a forgery (#5438); Opus blocked it by reasoning past the text.
 *
 * What it cannot prove: that a model acts on the text. The subject is an LLM prompt; no
 * test here can run the checker. The #5438 PR body records the before/after model runs
 * on a fixture modelled on the issue.
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

// Dimension 11 is split in two. The agent's section keeps the Question, the Skip-if line, one plain
// Read of the reference, and the two BLOCKER examples; the reference holds the rule line, the four
// Process steps and the passing example. The checker reads the reference only when RESEARCH.md exists.
const DIM11_REF = 'gsd-core/references/plan-checker-research-resolution.md';
const DIM11_READ = `Read \`~/.claude/${DIM11_REF}\``;
const dim11Section = once(() => span(checker(), '## Dimension 11: Research Resolution', /\n## Dimension 12\b/));
// An absent reference reads as empty, so a tree without it (the base) fails the rows on their content;
// the Read row below asserts the file exists.
const dim11Ref = once(() => (fs.existsSync(path.join(ROOT, DIM11_REF)) ? read(DIM11_REF) : ''));
const dim11 = once(() => `${dim11Section()}\n${dim11Ref()}`);
// The numbered Process steps, from **Process:** (in the reference; the section carries none) to the
// next worked example, each with its whitespace collapsed so a wrap cannot split one step. The
// checker's steps are matched by invariant tokens; prompt and doc text whose wording is the contract
// is pinned as whole sentences.
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
  test('the checker reads the Dimension 11 reference once, after Skip-if and before any example, outside a code fence', () => {
    const plain = stripFencedCode(dim11Section()).text;
    const reads = splitLines(plain).filter((l) => l.includes(DIM11_READ));
    assert.equal(reads.length, 1, `the Dimension 11 section must Read ${DIM11_REF} once, as prose`);
    assert.ok(fs.existsSync(path.join(ROOT, DIM11_REF)), `${DIM11_REF}, which the section reads, exists`);
    const at = plain.indexOf(DIM11_READ);
    assert.ok(plain.indexOf('**Skip if:**') !== -1 && plain.indexOf('**Skip if:**') < at, 'the Read follows the Skip-if line');
    const firstExample = plain.search(/^\*\*Example\b/m);
    assert.ok(firstExample === -1 || at < firstExample, 'the Read comes before anything that checks the dimension');
    assert.doesNotMatch(dim11Section(), /\*\*Process:\*\*/, 'the steps live in one place, the reference');
  });

  test('no shipped file includes the Dimension 11 reference eagerly', () => {
    const name = path.basename(DIM11_REF);
    const mentions = [];
    const eager = [];
    for (const dir of ['agents', 'gsd-core', 'commands', 'skills', 'pi/package-agents', 'pi/package-skills']) {
      for (const rel of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) {
        if (!String(rel).endsWith('.md')) continue;
        const text = read(path.join(dir, String(rel)));
        if (!text.includes(name)) continue;
        mentions.push(path.join(dir, String(rel)));
        if (/@\S*plan-checker-research-resolution\.md/.test(text)) eager.push(path.join(dir, String(rel)));
      }
    }
    assert.ok(mentions.includes('agents/gsd-plan-checker.md'), 'the scan must see the checker\'s own Read of the reference');
    assert.deepEqual(eager, [], 'an @ include loads the reference whether or not RESEARCH.md exists');
  });

  test('the four Process steps end where the reference\'s first example begins', () => {
    assert.equal(steps().length, 4, `expected four Process steps: ${steps().length}`);
    assert.match(steps()[3], /No CONTEXT\.md: every question is a BLOCKER\.$/, `step 4 runs on past its own text: ${steps()[3]}`);
  });

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
    assert.match(resolve(), /No one can be asked when plan-phase's arguments carry `--auto`, as discuss-phase's chain and transition pass, or when it runs as a background or nested agent, where AskUserQuestion cannot reach the user, as `\/gsd:autonomous` dispatches it, or the convergence run around it, when it does not flatten\./);
    assert.match(resolve(), /A run that calls plan-phase inline without `--auto` asks, and waits for the answer, as `\/gsd:autonomous` does at its own blockers\./);
    assert.doesNotMatch(resolve(), /every chained caller/, 'next.md and plan-review-convergence call plan-phase without --auto');
    assert.match(resolve(), /`AUTO_CHAIN` \(`workflow\._auto_chain_active`\) is not the key: a chained run passes `--auto` anyway, and a flag an earlier chain left set \(step 15 persists it on success too\), which a manual plan-phase clears only at its step 15, after this loop, would refuse a user who is present, and again on a `--research` re-run, which stops before step 15 too\./);
    assert.doesNotMatch(resolve(), /only plan-phase's step 15 clears/, 'execute-phase, discuss-phase and transition clear the flag too');
    // auto-advance-check parses --chain and reads workflow.auto_advance, so the clause says where each lands.
    assert.match(resolve(), /`--chain` and `workflow\.auto_advance` are not keys of their own: discuss-phase's chain starts plan-phase with `--auto` on either, and every other run under them is keyed as above, so a plan-phase the user starts with `--chain`, or with `auto_advance` on, asks\./);
    // The grounds the clause states: each chained caller passes --auto; autonomous passes none and backgrounds it.
    const chain = read('gsd-core/workflows/discuss-phase/modes/chain.md');
    assert.match(chain, /\*\*If `--auto` flag present OR `--chain` flag present OR `AUTO_MODE` is\s+true:\*\* display banner and launch plan-phase/);
    assert.match(chain, /`active` = chain flag OR user preference/, 'AUTO_MODE folds in workflow.auto_advance');
    assert.match(chain, /Skill\(skill="gsd-plan-phase", args="\$\{PHASE\} --auto/);
    // An inline autonomous run asks at a research stop as it asks at every blocker.
    assert.match(read('gsd-core/workflows/autonomous.md'), /When any phase operation fails or a blocker is detected, present 3 options via AskUserQuestion/);
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
      assert.match(read(doc), /Where no one can be asked \(`--auto`, or plan-phase running as a background or nested agent, as `\/gsd-autonomous` runs it, or its convergence run, when it does not flatten\) no answer is recorded: plan-phase escalates at once and stops there rather than proceeding, and `\/gsd-autonomous` and `\/gsd-manager` do not execute the plans; they stay on disk, where `\/gsd-progress --next` or `\/gsd-execute-phase` can still run them\. `--chain` and `workflow\.auto_advance` reach plan-phase as `--auto` through discuss-phase's chain; a plan-phase run inline without `--auto` asks/, doc);
      assert.match(read(doc), /the user leaves to run `\/gsd-discuss-phase <N>` or `\/gsd-plan-phase <N> --research`\./, doc);
    }
  });

  // Resolve leaves the plans on disk when it stops, and autonomous checked only has_plans before executing.
  // plan-review-convergence runs plan-phase inline where it first plans (step 4) and where it replans (5d), and its
  // reviewers never re-run Dimension 11. Each place reads the stop marker itself, before it counts plans or loops,
  // so the stop does not rest on the model carrying the Resolve step's text into the convergence run.
  test('plan-review-convergence ends on plan-phase\'s stop marker where it plans and where it replans', () => {
    const conv = read('gsd-core/workflows/plan-review-convergence.md');
    const step4 = span(conv, '## 4. Initial Planning', /\n## 5\. /).replace(/\s+/g, ' ');
    assert.match(step4, /\*\*If plan-phase printed `PLANNING STOPPED`:\*\* a research question needs a user ruling \(`gsd-core\/references\/revision-loop\.md`, Resolve\), which no review cycle can supply\. Display that line and exit this workflow without converging; do not count plans or start step 5\./);
    assert.ok(step4.indexOf('PLANNING STOPPED') < step4.indexOf('PLAN_COUNT=$('), 'step 4 reads the stop before it counts plans');
    const replan = span(conv, '### 5d. Replan (Inline)', /\n<\/process>/).replace(/\s+/g, ' ');
    assert.match(replan, /\*\*If plan-phase printed `PLANNING STOPPED` instead:\*\* stop as step 4 does: display that line and exit this workflow without converging; never go back to step 5a\./);
    assert.ok(replan.indexOf('PLANNING STOPPED') < replan.indexOf('go back to **step 5a**'), '5d reads the stop before it loops');
    assert.match(conv, /- \[ \] A plan-phase run that prints `PLANNING STOPPED` \(step 4 or 5d\) ends the workflow; it never converges/);
  });

  // discuss-phase's chain runs plan-phase with --auto, so a research question stops it at once; its return table
  // must name that return, or the user gets no defined next step (nothing executes: the stop precedes step 15).
  test('both discuss chains name the stop among plan-phase\'s returns', () => {
    const chain = read('gsd-core/workflows/discuss-phase/modes/chain.md').replace(/\s+/g, ' ');
    assert.match(chain, /- \*\*PLANNING STOPPED\*\* → Stop chain\. A research question needs a user ruling; the plans stay on disk and are not executed: ``` Auto-advance stopped: research questions need a user ruling\. Continue: \/gsd:discuss-phase \$\{PHASE\} \$\{GSD_WS\} ```/);
    assert.match(read('gsd-core/workflows/discuss-phase-assumptions/steps/auto-advance-dispatch.md'), /Handle return: PHASE COMPLETE \/ PLANNING COMPLETE \/ PLANNING STOPPED \/ INCONCLUSIVE \/ GAPS FOUND/);
  });

  test('both stops end plan-phase with a marker line, and autonomous never executes plans whose run carries it', () => {
    assert.match(resolve(), /This stop and leaving the loop both end plan-phase with the line `PLANNING STOPPED: research questions need a user ruling`, which `\/gsd:autonomous`, `\/gsd:manager`, transition's `mode: yolo` hand-off and the `\/gsd:progress --next --auto` chain read so that they do not execute the plans\. The plans stay on disk, as after the cap gate's Abandon, so a `\/gsd:progress --next` or `\/gsd:execute-phase` the user starts can still run them\./);
    assert.doesNotMatch(resolve(), /a caller never executes/, 'the line names the callers that execute plans, not every caller');
    const auto = read('gsd-core/workflows/autonomous.md').replace(/\s+/g, ' ');
    // Each plan run reads the stop where it checks its plans: 3b, the INTERACTIVE wait at 3c, and gap closure.
    const stop = 'go to handle_blocker with that line and never execute its plans.';
    assert.ok(auto.includes(`check \`has_plans\`. If false → go to handle_blocker: "Plan phase \${PHASE_NUM} did not produce any plans." If plan-phase printed \`PLANNING STOPPED\`, ${stop}`), '3b');
    assert.ok(auto.includes(`Wait for the plan agent to complete (if not already) and verify plans exist; if it printed \`PLANNING STOPPED\`, ${stop}`), '3c wait');
    assert.ok(auto.includes(`Check \`has_context\`. If false → go to handle_blocker: "Discuss for phase \${PHASE_NUM} did not produce CONTEXT.md." If discuss printed \`PLANNING STOPPED\` (its chain runs plan-phase with \`--auto\`), ${stop}`), '3a discuss');
    assert.ok(auto.includes(`handle_blocker: "Gap closure planning for phase \${PHASE_NUM} did not produce plans." If it printed \`PLANNING STOPPED\`, ${stop}`), 'gap closure');
    // The background planner is told it cannot ask, so the no-one-can-be-asked stop is observable to it.
    assert.match(auto, /prompt="Background: no AskUserQuestion\. Run plan-phase for phase \$\{PHASE_NUM\}/);
  });

  // manager plans with --auto (inline and in the background), and its discuss calls can chain into plan-phase --auto,
  // so a research question stops those runs. The user is at the dashboard, so manager reads the stop after each,
  // never offers the phase for execution, and offers a plan run without --auto, where plan-phase asks.
  test('manager reads the stop after every run that can plan and never offers the stopped phase for execution', () => {
    const mgr = read('gsd-core/workflows/manager.md').replace(/\s+/g, ' ');
    assert.match(mgr, /Symbols: `✓` done, `◆` active, `○` pending, `·` queued, `⚠` research ruling needed\./);
    // discuss-phase chains into plan-phase with --auto, so both discuss calls read the stop.
    const discuss = 'Skill(skill="gsd-discuss-phase", args="{PHASE_NUM} {manager_flags.discuss}") ``` After discuss completes, if it printed `PLANNING STOPPED` (its chain runs plan-phase with `--auto`), handle it as step 5 does; otherwise loop back to dashboard step.';
    assert.ok(mgr.includes(`Inline discuss: \`\`\` ${discuss}`), 'compound inline discuss');
    assert.ok(mgr.includes(`Run inline with any configured flags: \`\`\` ${discuss}`), 'Discuss Phase N');
    assert.match(mgr, /- A phase in this session's `RESEARCH_STOPPED` list \(step 5\) → `✓ ⚠ ·` `⚠ Research ruling needed`, whatever its disk_status; drop its execute recommendation from `recommended_actions`, since its plans failed the research gate/);
    assert.match(mgr, /Skill\(skill="gsd-plan-phase", args="\{N\} --auto \{manager_flags\.plan\}"\) ``` Display while it runs: ``` ◆ Planning Phase \{N\}[^`]*``` If it printed `PLANNING STOPPED`, handle it as step 5 does; otherwise loop back to dashboard step\./);
    const bg = span(read('gsd-core/workflows/manager.md'), '<step name="background_completion">', /<\/step>/).replace(/\s+/g, ' ');
    const stop = bg.indexOf('**If a plan-phase result carries `PLANNING STOPPED`**');
    assert.ok(stop !== -1 && stop < bg.indexOf('Display a brief notification'), 'the stop is read before the success notification');
    assert.match(bg, /- "Leave it": the phase keeps its `⚠` status\. If the chosen run ran plan-phase and it ended without printing `PLANNING STOPPED`, remove \{N\} from `RESEARCH_STOPPED`\. Then loop back to dashboard step\. 1\. Read the result message/, 'the stop clause ends at the dashboard, never in the success notification');
    const retry = 'Skill(skill="gsd-execute-phase", args="{N}")` if the failed action was execution. If the plan run printed `PLANNING STOPPED`, handle it as this step\'s stop clause does; otherwise loop to dashboard after.';
    assert.ok(bg.includes(`"Run this phase inline instead": Dispatch the same action inline via the appropriate Skill — use \`Skill(skill="gsd-plan-phase", args="{N}")\` if the failed action was planning, or \`${retry}`), 'permission-error retry');
    assert.ok(bg.includes(`"Run inline instead": Dispatch the action inline via the appropriate Skill — use \`Skill(skill="gsd-plan-phase", args="{N}")\` if the failed action was planning, or \`${retry}`), 'other-error retry');
    assert.match(bg, /add \{N\} to `RESEARCH_STOPPED`\. Its plans stay on disk but are not ready to execute\./);
    assert.match(bg, /"Plan inline now": `Skill\(skill="gsd-plan-phase", args="\{N\} \{manager_flags\.plan\}"\)` with any `--auto` removed from the flags, so plan-phase asks each question\. - "Discuss the phase": `Skill\(skill="gsd-discuss-phase", args="\{N\}"\)`\./);
  });

  // transition's mode: yolo hand-off runs plan-phase with --auto, so a research question stops that run. The chain
  // stops there, before any execute, and points at a plan-phase run without --auto, where plan-phase asks.
  test('transition stops its yolo hand-off when the plan-phase run it starts prints the stop', () => {
    const tr = read('gsd-core/workflows/transition.md').replace(/\s+/g, ' ');
    const call = 'Exit skill and invoke SlashCommand("/gsd:plan-phase [X+1] --auto ${GSD_WS}")';
    const at = tr.indexOf(call);
    assert.ok(at !== -1, 'the yolo hand-off runs plan-phase with --auto');
    const end = tr.indexOf('**If CONTEXT.md does NOT exist:**', at);
    assert.ok(end !== -1, 'the discuss route still follows the plan route');
    // Everything between the call and the next route is the stop clause and its display, so no condition
    // can narrow it and no later instruction can run execute-phase after it.
    assert.equal(tr.slice(at + call.length, end).trim(), 'If that plan-phase run prints `PLANNING STOPPED` (a research question needs a user ruling, which `--auto` cannot ask for; `gsd-core/references/revision-loop.md`, Resolve), stop the chain: its plans stay on disk and are not executed, and Phase [X+1] is not ready. Display: ``` Auto-advance stopped: research questions need a user ruling. Continue: /gsd:plan-phase [X+1] ${GSD_WS} ```');
  });

  // /gsd:progress --next --auto re-invokes itself after each command, and its Route 0 would then execute the plans
  // a stopped plan-phase run left on disk, so the stop ends that chain. A run the user starts is not a chain.
  test('the /gsd:progress --next --auto chain ends on the stop instead of re-invoking', () => {
    const next = read('gsd-core/workflows/next.md');
    const loop = span(next, '**If `--auto` was passed:**', /\nWhen stopping due to a blocker/);
    assert.ok(loop.split('\n').includes('- A command in the chain printed `PLANNING STOPPED` (a research question needs a user ruling; `gsd-core/references/revision-loop.md`, Resolve): its plans stay on disk and are not executed, so do not re-invoke'), 'the stop is one of the chain\'s end conditions');
  });
});

// With no CONTEXT.md, Dimension 11 makes every open research question a BLOCKER that only a ruling recorded by
// discuss-phase clears, so the option that skips it says so where the user chooses.
// Dimension 11 runs in the verify loop after the planner has written the plans, and a stop leaves them on disk,
// so no surface may say the gate blocks planning: it fails the written plans.
describe('the gate is described as failing the written plans, never as blocking planning (#5438)', () => {
  test('the Research Gate purpose line, in English and in each translated FEATURES.md', () => {
    for (const doc of ['docs/features/research-gate.md', 'docs/FEATURES.md']) {
      assert.match(read(doc), /\*\*Purpose:\*\* Fail plan verification while RESEARCH\.md has unresolved open questions, so plans built on incomplete information are not accepted\. The check runs after the planner has written the plans\./, doc);
      assert.doesNotMatch(read(doc), /Block planning when RESEARCH\.md/, doc);
    }
    // Exact lines, not patterns: a pattern with a wildcard in the middle let a reverted clause pass.
    const translated = {
      'docs/ja-JP/FEATURES.md': {
        now: [
          '**目的:** RESEARCH.md に未解決のオープンクエスチョンが残っている間はプランの検証を不合格にし、不完全な情報に基づく計画が受け入れられないようにします。このチェックはプランナーがプランを書いた後に実行されます。',
          '- REQ-RESGATE-01: プランを検証する際に、RESEARCH.md の未解決オープンクエスチョンをチェックしなければならない',
          '- REQ-RESGATE-02: 未解決のオープンクエスチョンごとにブロッカーを出し、プランが受け入れられないようにしなければならない',
          '2. **ゲート** — 該当する `D-NN` のない質問はそれぞれブロッカーになる。プランナーは記録済みの決定を引用できるが、決定を追加することはできない',
        ],
        gone: ['プランニングをブロック', 'プランニング開始前に', 'プランフェーズのエントリをブロック', '不完全な情報に基づく計画を防止'],
      },
      'docs/zh-CN/FEATURES.md': {
        now: [
          '**目的：** 当 RESEARCH.md 仍有未解决的开放问题时，计划验证不通过，防止基于不完整信息的计划被接受。该检查在规划器写出计划之后运行。',
          '- REQ-RESGATE-01：系统在验证计划时，必须检查 RESEARCH.md 中未解决的开放问题',
          '- REQ-RESGATE-02：系统必须为每个未解决的开放问题提出阻断项，使计划不被接受',
          '2. **门控** — 每个没有符合条件的 `D-NN` 的问题都是阻断项；规划器可以引用已记录的决定，但不能新增决定',
        ],
        gone: ['阻止规划', '规划开始前', '阻止进入 plan-phase', '在不完整信息基础上制定计划'],
      },
      'docs/ko-KR/FEATURES.md': {
        now: [
          '**목적:** RESEARCH.md에 미해결 오픈 질문이 남아 있으면 계획 검증을 통과시키지 않아, 불완전한 정보에 기반한 계획이 승인되지 않도록 합니다. 이 검사는 플래너가 계획을 작성한 뒤에 실행됩니다.',
          '- REQ-RESGATE-01: 계획을 검증할 때 RESEARCH.md에서 미해결 오픈 질문을 확인해야 합니다.',
          '- REQ-RESGATE-02: 미해결 오픈 질문마다 블로커를 제기하여 계획이 승인되지 않도록 해야 합니다.',
          '2. **게이트** — 해당하는 `D-NN`이 없는 질문은 각각 블로커가 됨. 플래너는 이미 기록된 결정을 인용할 수 있지만 새 결정을 추가할 수는 없음',
        ],
        gone: ['계획 차단', '계획 시작 전', '플랜 페이즈 진입을 차단', '계획을 차단하여'],
      },
      'docs/pt-BR/FEATURES.md': {
        now: ['- **Research gate** — reprova a verificação dos planos quando RESEARCH.md tem questões abertas sem decisão registrada do usuário (v1.32)'],
        gone: ['bloqueia planejamento'],
      },
    };
    for (const [doc, { now, gone }] of Object.entries(translated)) {
      const text = read(doc);
      for (const line of now) assert.ok(text.includes(line), `${doc} is missing: ${line}`);
      // The old wording is checked inside the gate's own section (feature 71); other features legitimately
      // talk about planning starting. pt-BR carries only a one-line summary, so its whole file is the scope.
      const at = text.indexOf('### 71.');
      const section = at === -1 ? text : text.slice(at, text.indexOf('\n---', at));
      for (const old of gone) assert.ok(!section.includes(old), `${doc} still says: ${old}`);
    }
  });

  // The translated sections carry the English section whole: its two rule paragraphs and step 3, the four-line
  // diagram row, and row 11's "the check runs on the written plans". Exact text, so emptying or shortening one fails.
  test('each translated copy carries the English rule paragraphs, step 3, the full diagram row and row 11', () => {
    const features = {
      'docs/ja-JP/FEATURES.md': ["**解決とはユーザーが決めたこと:** オープンクエスチョンが解決済みとみなされるのは、それが引用するすべての `D-NN` がフェーズの CONTEXT.md の `<decisions>` 内（Claude's Discretion の外）にあり、そのうち1つが質問に答えている場合だけです。そうした `D-NN` を書くのは discuss-phase か、ユーザーの回答を記録するオーケストレーターだけで、リサーチャー自身が書いた印は、見出しの `(RESOLVED)` 接尾辞を含め、何も解決しません。引用された出典は事実の空白を埋めるため、それはオープンクエスチョンではありませんが、ユーザーの裁定を要する選択はどの出典でも決まりません。CONTEXT.md が Claude's Discretion に委ねた領域では、出典付きの推奨で足ります。", "**適用箇所:** plan-checker の Dimension 11。plan-phase の検証ループ内で、プランナーの実行後に動きます（#5438）。plan-phase の入口で止めるステップはありません。このゲートはそのループが動くときだけ動きます: `--skip-verify`、`workflow.plan_check: false`、`--research-phase`（リサーチのみ）はプランチェッカーを、したがってこのゲートもスキップします。verify-work のギャップクロージャーのチェックもこの次元をスキップします: そのループはチェッカーに CONTEXT.md を渡さず、ユーザーの裁定を記録する経路もないためです。", "3. **表示** — 該当する決定がない場合、プランナーは各質問を挙げたコンフリクトを返し、plan-phase がユーザーに尋ねて各回答を `D-NN` として記録するか、ユーザーがループを離れて `/gsd-discuss-phase <N>` または `/gsd-plan-phase <N> --research` を実行します。誰にも尋ねられない場合（`--auto`、または plan-phase がバックグラウンドやネストされたエージェントとして動く場合。フラット化しないときに `/gsd-autonomous` が実行する場合や、そのコンバージェンス実行がこれにあたる）は回答を記録しません: plan-phase はただちにエスカレーションして先へ進まずにそこで止まり、`/gsd-autonomous` と `/gsd-manager` はプランを実行しません。プランはディスクに残り、`/gsd-progress --next` や `/gsd-execute-phase` からはまだ実行できます。`--chain` と `workflow.auto_advance` は discuss-phase のチェーンを通じて `--auto` として plan-phase に届き、`--auto` なしでインライン実行された plan-phase は尋ねます。"],
      'docs/zh-CN/FEATURES.md': ["**已解决即由用户决定：** 只有当一个开放问题引用的每个 `D-NN` 都位于该阶段 CONTEXT.md 的 `<decisions>` 中、Claude's Discretion 之外，且其中一个回答了该问题时，它才算已解决。只有 discuss-phase，或记录用户回答的编排器，才会写入这样的 `D-NN`；研究员自己写下的标记，包括标题上的 `(RESOLVED)` 后缀，都不能解决任何问题。引用的来源可以填补事实空白，因此那不是开放问题，但任何来源都不能决定需要用户裁决的选择。在 CONTEXT.md 交由 Claude's Discretion 决定的范围内，有来源的建议即可。", "**执行位置：** plan-checker 的 Dimension 11，位于 plan-phase 的验证循环中、规划器运行之后（#5438）。plan-phase 没有在入口处拦截的步骤。只有该循环运行时此门控才会运行：`--skip-verify`、`workflow.plan_check: false` 和 `--research-phase`（仅研究）会跳过计划检查器，也就跳过此门控。verify-work 的差距修复检查同样跳过此维度：该循环不向检查器提供 CONTEXT.md，也没有记录用户裁决的途径。", "3. **呈现** — 若没有这样的决定，规划器返回一个列出每个问题的冲突；plan-phase 询问用户并把每个回答记录为 `D-NN`，或者用户离开循环去运行 `/gsd-discuss-phase <N>` 或 `/gsd-plan-phase <N> --research`。在无人可问的情况下（`--auto`，或 plan-phase 作为后台或嵌套代理运行，例如 `/gsd-autonomous` 在不展平时运行它，或其收敛运行）不会记录任何回答：plan-phase 立即升级并就此停止而不继续，`/gsd-autonomous` 和 `/gsd-manager` 不会执行这些计划；计划留在磁盘上，`/gsd-progress --next` 或 `/gsd-execute-phase` 仍可运行它们。`--chain` 和 `workflow.auto_advance` 通过 discuss-phase 的链以 `--auto` 的形式到达 plan-phase；不带 `--auto` 内联运行的 plan-phase 会询问。"],
      'docs/ko-KR/FEATURES.md': ["**해결이란 사용자가 결정한 것:** 오픈 질문은 그것이 인용하는 모든 `D-NN`이 페이즈 CONTEXT.md의 `<decisions>` 안(Claude's Discretion 밖)에 있고 그중 하나가 질문에 답할 때만 해결된 것으로 봅니다. 그런 `D-NN`은 discuss-phase 또는 사용자의 답을 기록하는 오케스트레이터만 쓰며, 리서처가 직접 쓴 표시는 제목의 `(RESOLVED)` 접미사를 포함해 아무것도 해결하지 않습니다. 인용한 출처는 사실에 관한 공백을 메우므로 그것은 오픈 질문이 아니지만, 사용자의 결정이 필요한 선택은 어떤 출처로도 정해지지 않습니다. CONTEXT.md가 Claude's Discretion에 맡긴 영역에서는 출처가 있는 권고로 충분합니다.", "**적용 지점:** plan-checker Dimension 11, plan-phase의 검증 루프 안에서 플래너가 실행된 뒤에 동작합니다(#5438). plan-phase 진입 시점에 막는 단계는 없습니다. 이 게이트는 그 루프가 동작할 때만 동작합니다: `--skip-verify`, `workflow.plan_check: false`, `--research-phase`(리서치만)는 계획 검사기를, 따라서 이 게이트도 건너뜁니다. verify-work의 갭 클로저 검사도 이 차원을 건너뜁니다: 그 루프는 검사기에 CONTEXT.md를 넘기지 않고 사용자의 결정을 기록할 경로도 없기 때문입니다.", "3. **표시** — 그런 결정이 없으면 플래너가 각 질문을 명시한 충돌을 반환하고, plan-phase가 사용자에게 물어 각 답을 `D-NN`으로 기록하거나, 사용자가 루프를 떠나 `/gsd-discuss-phase <N>` 또는 `/gsd-plan-phase <N> --research`를 실행합니다. 아무에게도 물을 수 없는 경우(`--auto`, 또는 plan-phase가 백그라운드나 중첩 에이전트로 실행되는 경우. 평탄화하지 않을 때 `/gsd-autonomous`가 실행하는 경우나 그 수렴 실행이 이에 해당)에는 답을 기록하지 않습니다: plan-phase는 즉시 에스컬레이션하고 진행하지 않고 그 자리에서 멈추며, `/gsd-autonomous`와 `/gsd-manager`는 계획을 실행하지 않습니다. 계획은 디스크에 남고 `/gsd-progress --next`나 `/gsd-execute-phase`로는 여전히 실행할 수 있습니다. `--chain`과 `workflow.auto_advance`는 discuss-phase의 체인을 통해 `--auto`로 plan-phase에 도달하며, `--auto` 없이 인라인으로 실행된 plan-phase는 묻습니다."],
    };
    for (const [doc, lines] of Object.entries(features)) {
      const text = read(doc);
      const at = text.indexOf('### 71.');
      const section = text.slice(at, text.indexOf('\n---', at));
      for (const line of lines) assert.ok(section.includes(line), `${doc} section 71 is missing: ${line}`);
    }
    const english = splitLines(read('docs/ARCHITECTURE.md'));
    const enAt = english.findIndex((l) => /Research gate \(Dimension 11\)/.test(l));
    assert.deepEqual(english.slice(enAt, enAt + 4), ["    │       └── Research gate (Dimension 11): blocks until each open RESEARCH.md question cites", "    │           only D-NNs from CONTEXT.md <decisions>, outside Claude's Discretion, one answering", "    │           it; a cited source settles only a factual gap. Skipped with the verify loop", "    │           (--skip-verify, workflow.plan_check: false, --research-phase)"], 'the English diagram row');
    const trees = {
      'docs/ja-JP/ARCHITECTURE.md': ["    │       └── Research gate (Dimension 11): blocks until each open RESEARCH.md question cites", "    │           only D-NNs from CONTEXT.md <decisions>, outside Claude's Discretion, one answering", "    │           it; a cited source settles only a factual gap. Skipped with the verify loop", "    │           (--skip-verify, workflow.plan_check: false, --research-phase)"],
      'docs/zh-CN/ARCHITECTURE.md': ["    │       └── Research gate (Dimension 11): blocks until each open RESEARCH.md question cites", "    │           only D-NNs from CONTEXT.md <decisions>, outside Claude's Discretion, one answering", "    │           it; a cited source settles only a factual gap. Skipped with the verify loop", "    │           (--skip-verify, workflow.plan_check: false, --research-phase)"],
      'docs/ko-KR/ARCHITECTURE.md': ["    │       └── 리서치 게이트 (Dimension 11): RESEARCH.md의 각 미해결 질문이 CONTEXT.md <decisions>의", "    │           D-NN만 Claude's Discretion 밖에서 인용하고 그중 하나가 답할 때까지 계획을 통과시키지", "    │           않음. 인용한 출처는 사실에 관한 공백만 메움. 검증 루프와 함께 건너뜀", "    │           (--skip-verify, workflow.plan_check: false, --research-phase)"],
      'docs/pt-BR/ARCHITECTURE.md': ["    │       └── Portão de pesquisa (Dimension 11): reprova os planos enquanto uma questão aberta do", "    │           RESEARCH.md não cita só D-NNs de CONTEXT.md <decisions>, fora de Claude's Discretion,", "    │           um deles a respondendo; uma fonte citada resolve só uma lacuna factual. Pulado com o", "    │           loop de verificação (--skip-verify, workflow.plan_check: false, --research-phase)"],
    };
    for (const [doc, row] of Object.entries(trees)) {
      const lines = splitLines(read(doc));
      const at = lines.indexOf(row[0]);
      assert.ok(at !== -1, `${doc}: the gate row`);
      assert.deepEqual(lines.slice(at, at + row.length), row, `${doc}: the full gate row`);
    }
    const rows = {
      'docs/ja-JP/reference/plan-md.md': "| **11 — Research Resolution** | RESEARCH.md が存在する場合、見出しを問わずその中の未解決の質問はすべて、フェーズの CONTEXT.md の `<decisions>` 内（Claude's Discretion の外）にある `D-NN` だけを引用し、そのうち1つが質問に答えている。このチェックは書かれたプランに対して実行される。そうした `D-NN` を書くのは discuss-phase か、ユーザーの回答を記録するオーケストレーターだけである。引用された出典は事実の空白を埋めるが、ユーザーの裁定を要する選択は決めない。Claude's Discretion の領域では、出典付きの推奨で足りる。リサーチャー自身が書いた解決の印は、`(RESOLVED)` 接尾辞を含め、解決にならない。 |",
      'docs/zh-CN/reference/plan-md.md': "| **11 — 研究解决** | 当 RESEARCH.md 存在时，其中每个未决问题（无论位于哪个标题下）只引用该阶段 CONTEXT.md `<decisions>` 中、Claude's Discretion 之外的 `D-NN`，且其中一个回答了该问题。该检查针对已写出的计划运行。只有 discuss-phase，或记录用户回答的编排器，才会写入这样的 `D-NN`。引用的来源可以填补事实空白，但不能决定需要用户裁决的选择；在 Claude's Discretion 范围内，有来源的建议即可。研究员自己写下的解决标记，包括 `(RESOLVED)` 后缀，都不算解决。 |",
      'docs/ko-KR/reference/plan-md.md': "| **11 — 리서치 해결** | RESEARCH.md가 있는 경우, 어떤 제목 아래에 있든 그 안의 모든 미결 질문이 페이즈 CONTEXT.md `<decisions>` 안(Claude's Discretion 밖)의 `D-NN`만 인용하고, 그중 하나가 질문에 답하는지. 이 검사는 작성된 계획에 대해 실행된다. 그런 `D-NN`은 discuss-phase 또는 사용자의 답을 기록하는 오케스트레이터만 쓴다. 인용한 출처는 사실에 관한 공백을 메우지만, 사용자의 결정이 필요한 선택은 정하지 못한다. Claude's Discretion 영역에서는 출처가 있는 권고로 충분하다. 리서처가 직접 쓴 해결 표시는 `(RESOLVED)` 접미사를 포함해 해결이 아니다. |",
      'docs/pt-BR/reference/plan-md.md': "| **11 — Resolução de Pesquisa** | Quando RESEARCH.md existe, cada questão em aberto nele, sob qualquer título, cita apenas decisões `D-NN` sob `<decisions>` no CONTEXT.md da fase, fora de Claude's Discretion, e uma delas a responde. A verificação roda sobre os planos escritos. Só o discuss-phase, ou o orquestrador ao registrar a resposta do usuário, escreve esse `D-NN`. Uma fonte citada resolve uma lacuna factual, mas nenhuma escolha que exija uma decisão do usuário; numa área de Claude's Discretion, uma recomendação com fonte basta. Uma marca de resolução escrita pelo próprio pesquisador, sufixo `(RESOLVED)` incluído, não resolve nada. |",
    };
    for (const [doc, row] of Object.entries(rows)) assert.ok(splitLines(read(doc)).includes(row), `${doc}: row 11`);
  });

  // The architecture diagrams list the gate inside the plan checker's verify loop, after the planner, never as a
  // plan-phase step ahead of the researcher.
  test('every architecture diagram puts the gate inside the verify loop', () => {
    for (const doc of ['docs/ARCHITECTURE.md', 'docs/ja-JP/ARCHITECTURE.md', 'docs/zh-CN/ARCHITECTURE.md', 'docs/ko-KR/ARCHITECTURE.md', 'docs/pt-BR/ARCHITECTURE.md']) {
      const lines = splitLines(read(doc));
      const gate = lines.findIndex((l) => /Research gate \(Dimension 11\)|리서치 게이트 \(Dimension 11\)|Portão de pesquisa \(Dimension 11\)/.test(l));
      const checker = lines.findIndex((l) => /├── (Plan Checker → Verify loop|계획 검사기 → 검증 루프|Plan Checker → Loop de verificação)/.test(l));
      const planner = lines.findIndex((l) => /├── (Planner \(with reachability check\)|플래너 \(도달 가능성 검사 포함\)|Planner \(com verificação de alcançabilidade\))/.test(l));
      assert.ok(gate !== -1 && checker !== -1 && planner !== -1, `${doc}: gate, planner and checker rows`);
      assert.equal(gate, checker + 1, `${doc}: the gate row sits under the verify loop`);
      assert.ok(planner < checker, `${doc}: the planner runs before the checker`);
      assert.ok(!lines.some((l) => /├── (Research gate \(blocks if|리서치 게이트 \(RESEARCH\.md에 미해결|Portão de pesquisa \(bloqueia se)/.test(l)), `${doc}: no pre-research gate step`);
    }
  });

  test('plan-md row 11, and the researcher and template rules, say the checker fails the plans', () => {
    const row = splitLines(read('docs/reference/plan-md.md')).find((l) => l.startsWith('| **11 — Research Resolution** |'));
    assert.ok(row, 'plan-md.md carries the Dimension 11 row');
    assert.doesNotMatch(row, /before planning proceeds/);
    assert.match(row, /one of which answers it\. The check runs on the written plans\./);
    assert.match(researcher().replace(/\s+/g, ' '), /The plan-checker fails the plans on every question that cites no such `D-NN`, or any other \(Dimension 11\)\./);
    assert.match(researchTemplate(), /the plan-checker fails the plans on any other \(Dimension 11\)/);
    for (const [name, text] of [['researcher', researcher()], ['template', researchTemplate()]]) {
      assert.doesNotMatch(text.replace(/\s+/g, ' '), /blocks planning/, name);
    }
  });
});

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
    const prompt = step.split('\n').find((l) => l.includes('prompt: "Validate:'));
    assert.ok(prompt, 'import hands the checker a prompt');
    assert.doesNotMatch(prompt, /Dimension 11|research.resolution|research question/i,
      'no wording of a research-resolution skip in the checker prompt, not only the dimension number');
    assert.doesNotMatch(step, /skip\w*[^.\n]{0,40}(Dimension 11|research.resolution)/i, 'nor anywhere else in the step');
  });

  // Not skipped, so import needs its own way to clear the blocker: "Ask the user to resolve issues" names no step
  // that records a D-NN, and no edit the user can make to the plan file satisfies Dimension 11.
  test('import names the route that clears a research_resolution blocker', () => {
    const step = span(read('gsd-core/workflows/import.md'), '<step name="plan_validate">', /<\/step>/).replace(/\s+/g, ' ');
    assert.match(step, /A `research_resolution` \(Dimension 11\) blocker clears only on a user ruling the checker can read: ask each question it names, record each answer as the next `- \*\*D-NN:\*\* <ruling>` under `\$\{phase_dir\}`'s CONTEXT\.md `<decisions>`, outside Claude's Discretion, as `gsd-core\/references\/revision-loop\.md`'s Resolve step does,/);
    // Dimension 11 passes a question only when RESEARCH.md cites the D-NN on it; import has no planner to write
    // the citation, so the route writes it, and commits both files before re-validating.
    assert.match(step, /cite it on that question in the phase's RESEARCH\.md as `RESOLVED \(D-NN\): <ruling>` \(Dimension 11 reads the citation there\), and commit both files at once/);
    // The commit names the files init.phase-op resolved: a path built as {NN}-RESEARCH.md skips an unnumbered
    // RESEARCH.md, and query commit still reports committed: true, leaving the citation out of the commit.
    assert.match(step, /at the `context_path` and `research_path` a fresh `gsd_run query init\.phase-op [^`]*"\{NN\}"` returns \(either file may be unnumbered\): `gsd_run query commit "docs\(\{NN\}\): record research rulings" --files "\$context_path" "\$research_path"`/);
    assert.doesNotMatch(step, /\{NN\}-(CONTEXT|RESEARCH)\.md/);
    assert.match(step, /With no CONTEXT\.md, the user runs `\/gsd:discuss-phase \{NN\} \$\{GSD_WS\}` first\. Then re-run this step/);
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
