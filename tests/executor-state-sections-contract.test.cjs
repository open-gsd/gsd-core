'use strict';

/**
 * #6388: plan execution loads only the STATE.md sections it uses (Current Position, Decisions,
 * Blockers) instead of the whole file, so the Quick Tasks table stays out of every executor's
 * context.
 *
 * These are source-text-is-the-product assertions: the agent and workflow markdown IS what the
 * runtime loads. The read block itself runs in real bash in
 * tests/executor-state-sections.integration.test.cjs; only what no shell run can show stays here —
 * that both execution paths carry the same block and rules, and that no executor spawn prompt
 * hands the executor STATE.md as required reading any more.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { BLOCK_START, stateSectionBlock, SECTION_NAMES, RULES, AT_REFERENCE_RULE } = require('./helpers/executor-state-sections.cjs');

const ROOT = path.join(__dirname, '..');
const FILES = Object.freeze({
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
      // allow-test-rule: source-text-is-the-product the executor agent and execution workflows are runtime-loaded text (#6388)
      text[key] = readFileNormalized(path.join(ROOT, rel));
    }
  });

  describe('one read block for agent and inline execution', () => {
    test('gsd-executor.md and execute-plan.md carry the same block, once each', () => {
      const agentBlock = stateSectionBlock(text.agent);
      const workflowBlock = stateSectionBlock(text.executePlan);
      assert.ok(agentBlock, 'gsd-executor.md carries the block');
      assert.ok(workflowBlock, 'execute-plan.md carries the block');
      assert.equal(workflowBlock, agentBlock);
    });

    test('the block reads exactly the writer-accepted names, grouped and ordered per section', () => {
      const block = stateSectionBlock(text.agent);
      const groups = {};
      for (const [key, variable] of [['position', 'STATE_POSITION'], ['decisions', 'STATE_DECISIONS'], ['blockers', 'STATE_BLOCKERS']]) {
        const call = new RegExp(`^\\s*${variable}=\\$\\(_state_section ((?:"[^"]+" ?)+)\\)$`, 'm').exec(block);
        assert.ok(call, `${variable} is assigned from _state_section`);
        groups[key] = [...call[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      }
      assert.deepEqual(groups, { ...SECTION_NAMES });
    });

    test('every state.get read is raw and every existence check is state.load --raw, never the full state_raw payload', () => {
      const block = stateSectionBlock(text.agent);
      const reads = block.split('\n').filter((l) => l.includes('gsd_run query state.'));
      assert.deepEqual(reads.map((l) => /gsd_run query (state\.[a-z]+)/.exec(l)[1]).sort(), ['state.get', 'state.load']);
      for (const line of reads) assert.ok(line.includes(' --raw '), `raw read: ${line.trim()}`);
      // Nowhere in the agent definition is the whole STATE.md loaded any more.
      for (const line of text.agent.split('\n').filter((l) => l.includes('state.load'))) {
        assert.ok(line.includes('--raw'), `state.load only with --raw: ${line.trim()}`);
      }
    });

    test('the rules beside the block are stated word for word in both files', () => {
      for (const key of ['agent', 'executePlan']) {
        const lines = new Set(text[key].split('\n'));
        for (const rule of RULES) assert.ok(lines.has(rule), `${FILES[key]} states: ${rule}`);
      }
    });

    test('execute-plan.md runs the block inside init_context\'s fence, after GSD_WS is parsed', () => {
      const lines = text.executePlan.split('\n');
      const startLine = lines.indexOf(BLOCK_START);
      const fence = scanFencedBlocks(lines).find((b) => b.openLineIdx < startLine && startLine < b.closeLineIdx);
      assert.ok(fence, 'the block sits inside a fence');
      const fenceLines = lines.slice(fence.openLineIdx + 1, fence.closeLineIdx);
      const wsParse = fenceLines.findIndex((l) => l.startsWith('GSD_WS=$(echo " $GSD_ARGS"'));
      assert.notEqual(wsParse, -1, 'the same fence parses --ws into GSD_WS');
      assert.ok(wsParse < fenceLines.indexOf(BLOCK_START), 'GSD_WS is set before the reads');
      const stepOpen = lines.slice(0, startLine).filter((l) => l.startsWith('<step name=')).pop();
      assert.equal(stepOpen, '<step name="init_context" priority="first">', 'the fence belongs to init_context');
    });

    test('execute-plan.md no longer tells the executor to read STATE.md before any operation', () => {
      assert.equal(text.executePlan.includes('Read STATE.md before any operation'), false);
    });
  });

  describe('a plan\'s own STATE.md @-reference goes through the section reads', () => {
    test('gsd-executor.md load_plan and execute-plan.md execute step 1 both state the rule', () => {
      const loadPlan = /<step name="load_plan">([\s\S]*?)<\/step>/.exec(text.agent);
      assert.ok(loadPlan, 'gsd-executor.md has a load_plan step');
      assert.ok(loadPlan[1].split('\n').some((l) => l.includes(AT_REFERENCE_RULE)), 'load_plan states the @-reference rule');
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
