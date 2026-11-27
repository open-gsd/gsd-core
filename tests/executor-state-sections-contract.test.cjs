'use strict';

/**
 * #6388: plan execution loads only the STATE.md sections it uses (Current Position, Decisions,
 * Blockers) instead of the whole file, so the Quick Tasks table stays out of every executor's
 * context.
 *
 * These are source-text-is-the-product assertions: the agent and workflow markdown IS what the
 * runtime loads. The read block itself runs in real bash in
 * tests/executor-state-sections.integration.test.cjs; only what no shell run can show stays here —
 * that both execution paths run the one shared block with its rules, and that no executor spawn
 * prompt hands the executor STATE.md as required reading any more.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');
const { REFERENCE_PATH, REFERENCE_INCLUDE, stateSectionBlock, SECTION_NAMES, RULES, AT_REFERENCE_RULE } = require('./helpers/executor-state-sections.cjs');

const ROOT = path.join(__dirname, '..');
const FILES = Object.freeze({
  reference: REFERENCE_PATH,
  agent: 'agents/gsd-executor.md',
  executePlan: 'gsd-core/workflows/execute-plan.md',
  executePhase: 'gsd-core/workflows/execute-phase.md',
  isolationDispatch: 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
  quick: 'gsd-core/workflows/quick.md',
  quickBatchDispatch: 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md',
});

/** The `<required_reading>` block whose first entry is `firstEntry`, as its lines. */
function requiredReadingAfter(content, firstEntry) {
  const lines = content.split('\n');
  const starts = lines.flatMap((l, i) => (l.trim() === '<required_reading>' ? [i] : []));
  const blocks = starts.map((s) => {
    const end = lines.findIndex((l, i) => i > s && l.trim() === '</required_reading>');
    assert.notEqual(end, -1, `the <required_reading> block at line ${s + 1} closes`);
    return lines.slice(s + 1, end).map((l) => l.trim());
  });
  const matching = blocks.filter((b) => b.some((l) => l.includes(firstEntry)));
  assert.equal(matching.length, 1, `exactly one <required_reading> block lists ${firstEntry}`);
  return matching[0];
}

/** Required-reading lines that hand over STATE.md, under any of its spellings. */
function stateEntries(block) {
  return block.filter((l) => /STATE\.md|\{state_rel\}|\{state_path\}|\$\{STATE_PATH\}/.test(l));
}

describe('#6388: executor state loading contract', () => {
  const text = {};
  before(() => {
    for (const [key, rel] of Object.entries(FILES)) {
      // allow-test-rule: source-text-is-the-product the executor agent, execution workflows and their reference are runtime-loaded text (#6388)
      text[key] = readFileNormalized(path.join(ROOT, rel));
    }
  });

  describe('one read block for agent and inline execution', () => {
    test('the block lives once, in the reference', () => {
      assert.ok(stateSectionBlock(text.reference), `${REFERENCE_PATH} carries the block exactly once`);
      assert.equal(stateSectionBlock(text.agent), null, 'gsd-executor.md does not carry its own copy');
      assert.equal(stateSectionBlock(text.executePlan), null, 'execute-plan.md does not carry its own copy');
    });

    test('the block reads exactly the writer-accepted names, grouped and ordered per section', () => {
      const block = stateSectionBlock(text.reference);
      const groups = {};
      for (const [key, variable] of [['position', 'STATE_POSITION'], ['decisions', 'STATE_DECISIONS'], ['blockers', 'STATE_BLOCKERS']]) {
        const call = new RegExp(`^\\s*${variable}=\\$\\(_state_section ((?:"[^"]+" ?)+)\\)$`, 'm').exec(block);
        assert.ok(call, `${variable} is assigned from _state_section`);
        groups[key] = [...call[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      }
      assert.deepEqual(groups, { ...SECTION_NAMES });
    });

    test('every read is --raw: state.get for the sections, state.load --raw only for existence', () => {
      const block = stateSectionBlock(text.reference);
      const reads = block.split('\n').filter((l) => l.includes('gsd_run query state.'));
      assert.deepEqual(reads.map((l) => /gsd_run query (state\.[a-z]+)/.exec(l)[1]).sort(), ['state.get', 'state.load']);
      for (const line of reads) assert.ok(line.includes(' --raw '), `raw read: ${line.trim()}`);
      // Nowhere in the agent definition is the whole STATE.md (state.load's state_raw) loaded any more.
      assert.equal(text.agent.includes('state.load'), false);
    });

    test('the rules after the block are stated word for word', () => {
      const lines = new Set(text.reference.split('\n'));
      for (const rule of RULES) assert.ok(lines.has(rule), `${REFERENCE_PATH} states: ${rule}`);
    });

    test('the agent runs the block in load_project_state', () => {
      const step = /<step name="load_project_state" priority="first">([\s\S]*?)<\/step>/.exec(text.agent);
      assert.ok(step, 'gsd-executor.md has a load_project_state step');
      assert.ok(step[1].split('\n').includes(REFERENCE_INCLUDE), 'load_project_state references the block on its own line');
    });

    test('execute-plan.md runs the block in init_context, after GSD_WS is parsed', () => {
      const step = /<step name="init_context" priority="first">([\s\S]*?)<\/step>/.exec(text.executePlan);
      assert.ok(step, 'execute-plan.md has an init_context step');
      const wsParse = step[1].indexOf('GSD_WS=$(echo " $GSD_ARGS"');
      assert.notEqual(wsParse, -1, 'init_context parses --ws into GSD_WS');
      assert.ok(step[1].split('\n').includes(REFERENCE_INCLUDE), 'init_context references the block on its own line');
      assert.ok(step[1].indexOf(REFERENCE_INCLUDE) > wsParse, 'init_context references the block after GSD_WS is set');
    });

    test('execute-plan.md no longer tells the executor to read STATE.md before any operation', () => {
      assert.equal(text.executePlan.includes('Read STATE.md before any operation'), false);
      const requiredReading = /<required_reading>([\s\S]*?)<\/required_reading>/.exec(text.executePlan);
      assert.ok(requiredReading, 'execute-plan.md has a required_reading block');
      assert.ok(requiredReading[1].includes("`init_context`'s STATE.md section reads"), 'required reading points at the section reads');
    });
  });

  describe('a plan\'s own STATE.md @-reference goes through the section reads', () => {
    test('gsd-executor.md load_plan and execute-plan.md execute step 1 both point at the rule', () => {
      const loadPlan = /<step name="load_plan">([\s\S]*?)<\/step>/.exec(text.agent);
      assert.ok(loadPlan, 'gsd-executor.md has a load_plan step');
      assert.ok(loadPlan[1].includes(AT_REFERENCE_RULE), 'load_plan states the @-reference rule');
      const execute = /<step name="execute">([\s\S]*?)<\/step>/.exec(text.executePlan);
      assert.ok(execute, 'execute-plan.md has an execute step');
      const contextLine = execute[1].split('\n').find((l) => l.startsWith('1. Read @context files from prompt'));
      assert.ok(contextLine, 'execute step 1 reads the @context files');
      assert.ok(contextLine.includes(AT_REFERENCE_RULE), 'execute step 1 states the @-reference rule');
    });
  });

  describe('no executor spawn prompt lists STATE.md as required reading', () => {
    test('execute-phase.md harness executor prompt', () => {
      const block = requiredReadingAfter(text.executePhase, '{phase_dir}/{plan_file} (Plan)');
      assert.deepEqual(stateEntries(block), []);
      assert.ok(block.some((l) => l.includes('{project_rel}')), 'project context stays required reading');
    });

    test('executor-isolation-dispatch.md process-spawn prompt, and no {state_rel} placeholder left to substitute', () => {
      const block = requiredReadingAfter(text.isolationDispatch, '{phase_dir}/{plan_file} (Plan');
      assert.deepEqual(stateEntries(block), []);
      assert.equal(text.isolationDispatch.includes('{state_rel}'), false);
    });

    test('quick.md executor prompt (the planner\'s own required reading is out of scope and unchanged)', () => {
      const executor = requiredReadingAfter(text.quick, '${QUICK_DIR}/${quick_id}-PLAN.md (Plan)');
      assert.deepEqual(stateEntries(executor), []);
      const planner = requiredReadingAfter(text.quick, '${STATE_PATH} (Project State)');
      assert.deepEqual(stateEntries(planner), ['- ${STATE_PATH} (Project State)']);
    });

    test('quick-batch worktree-dispatch harness prompt, and no {state_rel} mapping for the process spawn', () => {
      const block = requiredReadingAfter(text.quickBatchDispatch, '${ITEM_DIR}/${quick_id}-PLAN.md (Plan)');
      assert.deepEqual(stateEntries(block), []);
      assert.equal(text.quickBatchDispatch.includes('{state_rel}'), false);
    });
  });
});
