'use strict';

// Routed-agent spawns thread the resolved model (#2072): model_overrides and models.<phaseType> were inert for
// gsd-assumptions-analyzer and gsd-code-reviewer because the workflows spawned them with no model= param. Every spawn of
// the three routed catalog agents threads a resolved model=, and the workflow obtains it (an inline resolve-model, or
// the reviewer_model field of the init.quick bundle). A parity guard reads every Agent(...) call of every workflow.
// Was tests/model-routing-spawn-threading.test.cjs; its scanner self-test is mutation cases in the batch 9 test.

const WORKFLOWS = 'gsd-core/workflows';
const ROUTED = ['gsd-code-reviewer', 'gsd-assumptions-analyzer', 'gsd-code-fixer'];

const isWordChar = (ch) => ch !== undefined && /\w/.test(ch);

// The text of each `Agent( ... )` call, tracking string state (triple quotes, double quotes) and paren depth so a prompt
// body's own parens and quotes do not end the call early. Order-independent: the params are captured whether
// subagent_type= comes before or after the prompt. A call scans from its open paren and the scan resumes after it.
function agentCalls(content) {
  const calls = [];
  let from = 0;
  for (let at = content.indexOf('Agent(', from); at !== -1; at = content.indexOf('Agent(', from)) {
    let i = at + 'Agent('.length;
    let depth = 1;
    let tripleQuoted = false;
    let quoted = false;
    while (i < content.length && depth > 0) {
      if (tripleQuoted) {
        if (content.startsWith('"""', i)) {
          tripleQuoted = false;
          i += 3;
        } else {
          i += 1;
        }
      } else if (quoted) {
        if (content[i] === '\\') {
          i += 2;
        } else {
          if (content[i] === '"') quoted = false;
          i += 1;
        }
      } else if (content.startsWith('"""', i)) {
        tripleQuoted = true;
        i += 3;
      } else if (content[i] === '"') {
        quoted = true;
        i += 1;
      } else {
        if (content[i] === '(') depth += 1;
        else if (content[i] === ')') depth -= 1;
        i += 1;
      }
    }
    calls.push(content.slice(at, i));
    from = i;
  }
  return calls;
}

// Does the call carry `model` (a whole word) then optional whitespace then `=`?
function hasModelParam(call) {
  for (let at = call.indexOf('model'); at !== -1; at = call.indexOf('model', at + 1)) {
    if (isWordChar(call[at - 1])) continue;
    let i = at + 'model'.length;
    while (i < call.length && /\s/.test(call[i])) i += 1;
    if (call[i] === '=') return true;
  }
  return false;
}

// Is `subagent_type="<agent>",` followed by whitespace (containing a newline when `acrossNewline`) and then
// `model="{<variable>}"` somewhere in the text?
function threadsModel(text, agent, variable, acrossNewline = false) {
  const prefix = `subagent_type="${agent}",`;
  const wanted = `model="{${variable}}"`;
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
    let i = at + prefix.length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (acrossNewline && !text.slice(at + prefix.length, i).includes('\n')) continue;
    if (text.startsWith(wanted, i)) return true;
  }
  return false;
}

module.exports = {
  agentCalls,
  id: 'model-routing-spawn-threading',
  issue: '#2072',
  check(ctx) {
    ctx.doc(`${WORKFLOWS}/discuss-phase-assumptions.md`)
      .has('resolve-model gsd-assumptions-analyzer', 'discuss-phase-assumptions.md must resolve the routed model')
      .satisfies((text) => threadsModel(text, 'gsd-assumptions-analyzer', 'ANALYZER_MODEL') || 'no such spawn', 'the gsd-assumptions-analyzer spawn must thread the resolved model="{ANALYZER_MODEL}"');

    ctx.doc(`${WORKFLOWS}/code-review.md`)
      .has('resolve-model gsd-code-reviewer', 'code-review.md must resolve the routed model')
      .satisfies((text) => threadsModel(text, 'gsd-code-reviewer', 'REVIEWER_MODEL') || 'no such spawn', 'the gsd-code-reviewer spawn of code-review.md must thread model="{REVIEWER_MODEL}"');

    ctx.doc(`${WORKFLOWS}/code-review-fix.md`)
      .has('resolve-model gsd-code-reviewer', 'the code-review-fix.md re-review must resolve the routed model')
      .satisfies((text) => threadsModel(text, 'gsd-code-reviewer', 'REVIEWER_MODEL') || 'no such spawn', 'the re-review spawn of code-review-fix.md must thread model="{REVIEWER_MODEL}"')
      .has('resolve-model gsd-code-fixer', 'code-review-fix.md must resolve the fixer model')
      .satisfies((text) => {
        const fixerSpawns = text.split('subagent_type="gsd-code-fixer", model="{FIXER_MODEL}"').length - 1;
        return fixerSpawns === 2 || `found ${fixerSpawns}`;
      }, 'both gsd-code-fixer spawns of code-review-fix.md must thread FIXER_MODEL');

    ctx.doc(`${WORKFLOWS}/quick.md`)
      .satisfies((text) => threadsModel(text, 'gsd-code-reviewer', 'reviewer_model', true) || 'no such spawn', 'the quick.md review step must thread the reviewer\'s own model="{reviewer_model}" from the init.quick bundle')
      .satisfies((text) => !threadsModel(text, 'gsd-code-reviewer', 'executor_model', true) || 'the reviewer reuses executor_model', 'the quick.md reviewer must not reuse the executor model: its own model_overrides would be ignored');

    for (const rel of ctx.list(WORKFLOWS, '.md', 'the workflows are what the parity guard scans')) {
      ctx.doc(rel).satisfies((text) => {
        const offenders = [];
        for (const call of agentCalls(text)) {
          const agent = ROUTED.find((name) => call.includes(`subagent_type="${name}"`));
          if (agent && !hasModelParam(call)) offenders.push(`${agent} spawn missing model=`);
        }
        return offenders.length === 0 || offenders.join('; ');
      }, 'every spawn of a routed agent (gsd-code-reviewer, gsd-assumptions-analyzer, gsd-code-fixer) must carry a model= in its Agent(...) call');
    }
  },
};
