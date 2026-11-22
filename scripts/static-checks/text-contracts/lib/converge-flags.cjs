'use strict';

// The reviewer lane flags the convergence workflows used to list by hand. They are derived at run
// time (`gsd_run review-lane flags`), so the workflow text must not list them again.
const FORMERLY_HARDCODED_LANE_FLAGS = Object.freeze([
  '--codex', '--qwen', '--claude', '--opencode', '--ollama', '--lm-studio', '--llama-cpp',
]);
// '--claude' is left out of the literal-absence guard: the runtime-launcher preamble legitimately
// carries an unrelated `npx ... --claude --local` install-runtime flag, so a substring match would
// false-positive against that, not against a re-added reviewer-flag list.
const ANTI_PARITY_LANE_FLAGS = Object.freeze(FORMERLY_HARDCODED_LANE_FLAGS.filter((flag) => flag !== '--claude'));
const CONVERGENCE_CONTROLS = Object.freeze(['--all', '--text']);

/** The workflow forwards convergence controls and derives reviewer flags instead of listing them. */
function assertConvergeArgsForwarded(workflow, name) {
  workflow.has(/CONVERGENCE_ARGS/, `${name} should build convergence pass-through args`);
  workflow.has(/gsd_run review-lane flags/, `${name} should derive reviewer flags from the review-lane roster instead of hand-listing them`);
  for (const flag of CONVERGENCE_CONTROLS) workflow.has(flag, `${name} should pass through ${flag}`);
  workflow.has(/--max-cycles/, `${name} should pass through --max-cycles N`);
  // Deliberately inverted polarity: reviewer lane flags are declared once, in the roster. A hand-listed
  // copy reappearing in the workflow prose is the regression this exists to catch.
  for (const flag of ANTI_PARITY_LANE_FLAGS) {
    workflow.lacks(flag, `${name} should NOT hand-enumerate reviewer lane flag ${flag}; it must be derived via review-lane flags`);
  }
}

module.exports = { FORMERLY_HARDCODED_LANE_FLAGS, ANTI_PARITY_LANE_FLAGS, CONVERGENCE_CONTROLS, assertConvergeArgsForwarded };
