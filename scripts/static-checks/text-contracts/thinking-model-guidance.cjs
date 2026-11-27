'use strict';

// The five thinking-model references (debug, execution, planning, research, verification) and the agents that wire
// them in: each reference has its Conflict Resolution and When NOT to Think sections, a heading for each named
// reasoning model with a **Counters:** line in its section; the planning reference orders the sufficient options from
// existing behaviour to a minimum new implementation, cross-references the adjacent guidance, states the scope and
// constraint boundaries the check cannot override and what the plan checker flags, and has the Gap Closure Mode
// section with its gaps_found trigger; each of the six agents carries the inline decision-point annotation and the
// @-reference inside the named block, never in <required_reading>. The test accepted a named model or a boundary word
// anywhere in the file; the contract asks for the heading and for the sentence the file carries. Was tests/thinking-model-guidance.test.cjs.

const path = require('node:path');

const REFERENCES = 'gsd-core/references';
const CONTEXTS = ['debug', 'execution', 'planning', 'research', 'verification'];
const NAMED_MODELS = {
  debug: ['Fault Tree Analysis', 'Hypothesis-Driven Investigation', "Occam's Razor", 'Counterfactual Thinking'],
  execution: ['Circle of Concern vs Circle of Control', 'Forcing Function', 'First Principles Thinking', "Occam's Razor", "Chesterton's Fence"],
  planning: ['Pre-Mortem Analysis', 'MECE Decomposition', 'Constraint Analysis', 'Reversibility Test', "Occam's Razor"],
  research: ['First Principles Thinking', "Simpson's Paradox Awareness", 'Survivorship Bias', 'Confirmation Bias Counter', 'Steel Man'],
  verification: ['Inversion', "Chesterton's Fence", 'Confirmation Bias Counter', 'Planning Fallacy Calibration', 'Counterfactual Thinking'],
};
const ORDERED_OPTIONS = [
  'Existing project behavior, helper, or established pattern',
  'Standard-library capability',
  'Native platform capability',
  'Already-installed dependency',
  'Minimum new implementation',
];
const BOUNDARIES = ['locked user decisions', 'requirement coverage', 'security', 'validation', 'accessibility', 'error handling', 'verification'];
const AGENT_WIRING = {
  'gsd-debugger': { ref: 'thinking-models-debug.md', block: 'step name="investigation_loop"', text: 'At investigation decision points, apply structured reasoning' },
  'gsd-executor': { ref: 'thinking-models-execution.md', block: 'step name="execute_tasks"', text: 'At execution decision points, apply structured reasoning' },
  'gsd-planner': { ref: 'thinking-models-planning.md', block: 'step name="break_into_tasks"', text: 'At decision points during plan creation, apply structured reasoning' },
  'gsd-phase-researcher': { ref: 'thinking-models-research.md', block: 'execution_flow', text: 'At research decision points, apply structured reasoning' },
  'gsd-plan-checker': { ref: 'thinking-models-planning.md', block: 'verification_dimensions', text: 'At decision points during plan verification, apply structured reasoning' },
  'gsd-verifier': { ref: 'thinking-models-verification.md', block: 'verification_process', text: 'At verification decision points, apply structured reasoning' },
};

// The sectionizer's fence scanner (build output), loaded once; a load failure is a finding of its own.
function loadFenceScanner(loader = () => require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs'))) {
  try {
    return { scan: loader().scanFencedBlocks };
  } catch (err) {
    return { error: `the markdown sectionizer cannot be loaded: ${err.message}` };
  }
}

// The section of the heading line that names the model, up to the next `## ` heading outside a fenced block, or null.
// A `## ` line inside a fenced block is example text, not a heading: the fence rules have one owner.
function sectionOf(scan, text, model) {
  const lines = text.split('\n');
  const fenced = new Array(lines.length).fill(false);
  for (const block of scan(lines)) {
    const stop = block.closeLineIdx === -1 ? lines.length - 1 : block.closeLineIdx;
    for (let at = block.openLineIdx; at <= stop; at += 1) fenced[at] = true;
  }
  const headings = lines.flatMap((line, at) => (!fenced[at] && line.startsWith('## ') ? [at] : []));
  const start = headings.find((at) => lines[at].includes(model));
  if (start === undefined) return null;
  const end = headings.find((at) => at > start);
  return lines.slice(start, end === undefined ? lines.length : end).join('\n');
}

// The text with every run of whitespace collapsed to one blank: a phrase that a line wrap may split.
const collapsed = (text) => text.split(/\s+/).join(' ');

// True when a <required_reading> block (a closed one) mentions the file.
function inRequiredReading(text, ref) {
  const open = '<required_reading>';
  const close = '</required_reading>';
  for (let at = text.indexOf(open); at !== -1;) {
    const end = text.indexOf(close, at + open.length);
    if (end === -1) return false;
    if (text.slice(at + open.length, end).includes(ref)) return true;
    at = text.indexOf(open, end + close.length);
  }
  return false;
}

function buildCheck(loadFences = () => loadFenceScanner()) {
  return (ctx) => {
    // One document per path: a file that is gone, or empty, is one finding however many assertions read it.
    const docs = new Map();
    const docOf = (rel) => {
      if (!docs.has(rel)) docs.set(rel, ctx.doc(rel));
      return docs.get(rel);
    };
    const fences = loadFences();
    if (fences.error) ctx.fail(REFERENCES, fences.error);
    for (const context of CONTEXTS) {
      const rel = `${REFERENCES}/thinking-models-${context}.md`;
      const doc = docOf(rel)
        .has('## When NOT to Think', `thinking-models-${context}.md must have a "When NOT to Think" section`)
        .has('## Conflict Resolution', `thinking-models-${context}.md must have a Conflict Resolution section (sequencing rules)`);
      for (const model of NAMED_MODELS[context]) {
        if (fences.error) continue;
        doc.satisfies((text) => {
          const section = sectionOf(fences.scan, text, model);
          if (section === null) return 'no heading names it';
          return section.includes('**Counters:**') || 'its section has no **Counters:** line';
        }, `thinking-models-${context}.md must name the model "${model}" in a heading with a **Counters:** line (the failure mode it counters)`);
      }
    }

    const planning = docOf(`${REFERENCES}/thinking-models-planning.md`);
    planning.satisfies((text) => {
      let previous = -1;
      for (const option of ORDERED_OPTIONS) {
        const at = text.indexOf(option);
        if (at < 0) return `missing option: ${option}`;
        if (!(at > previous)) return `option out of order: ${option}`;
        previous = at;
      }
      return true;
    }, 'the planning Occam check must order the sufficient options from existing behavior through minimal new implementation');
    for (const reference of ['dont_hand_roll', 'Dimension 12 (Pattern Compliance)', 'thinking-models-execution.md']) {
      planning.has(reference, `the planning Occam check must cross-reference ${reference}`);
    }
    planning.has('must never reduce requested scope', 'the planning Occam check must say it must never reduce requested scope');
    for (const boundary of BOUNDARIES) {
      planning.satisfies((text) => {
        const sentence = text.split('\n').find((line) => line.includes('must never reduce requested scope'));
        if (sentence === undefined) return true; // the missing sentence is reported once above
        return sentence.includes(boundary) || `that sentence does not name ${boundary}`;
      }, `the planning Occam check must not override ${boundary}`);
    }
    planning
      .satisfies((text) => collapsed(text).includes('the plan checker flags a new abstraction or dependency only when a higher rung is demonstrably sufficient'), 'the planning Occam check must ask the plan checker to flag avoidable new surface only when a higher rung is sufficient (the sentence may wrap across lines)')
      .slice('## Gap Closure Mode', '\n## ')
      .has(/gaps_found|gap closure mode/, 'the Gap Closure Mode section must name its trigger condition');

    for (const [agent, wiring] of Object.entries(AGENT_WIRING)) {
      const rel = `agents/${agent}.md`;
      docOf(rel)
        .has(wiring.ref, `${agent}.md must reference ${wiring.ref}`)
        .has(wiring.block, `${agent}.md must contain the block ${wiring.block}`)
        .has(wiring.text, `${agent}.md must carry the decision-point annotation "${wiring.text}"`)
        .satisfies((text) => {
          const blockAt = text.indexOf(wiring.block);
          const textAt = text.indexOf(wiring.text);
          if (blockAt === -1 || textAt === -1) return true; // a missing one is reported by its own assertion
          return blockAt < textAt || 'the annotation comes before the block';
        }, `${agent}.md must place the decision-point annotation after the block ${wiring.block}`)
        .satisfies((text) => !inRequiredReading(text, wiring.ref), `${agent}.md must not put ${wiring.ref} inside a <required_reading> block (inline @-reference wiring at decision points only)`);
    }
  };
}

module.exports = {
  id: 'thinking-model-guidance',
  walkers: { loadFenceScanner, buildCheck },
  check: buildCheck(),
};
