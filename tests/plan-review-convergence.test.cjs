/**
 * Tests for gsd:plan-review-convergence command (#2306)
 *
 * Validates that the command source and workflow contain the key structural
 * elements required for correct cross-AI plan convergence loop behavior:
 * initial planning gate, review agent spawning, CYCLE_SUMMARY contract for
 * unresolved review count extraction, stall detection, escalation gate, and STATE.md update
 * on convergence.
 *
 * v2 additions (#2306-v2):
 * - CYCLE_SUMMARY contract replaces raw grep (prevents false stalls from
 *   accumulated REVIEWS.md history across cycles)
 * - workflow.plan_review_convergence config gate (disabled by default)
 * - --ws forwarded to review agent (symmetric with replan agent)
 * - PARTIALLY RESOLVED / FULLY RESOLVED definitions in contract
 * - HIGH_LINES validation warning when HIGH_COUNT > 0 but section absent
 * - Success criteria updated to reflect CYCLE_SUMMARY parsing
 *
 * v3 additions (#724):
 * - CYCLE_SUMMARY includes current_actionable for unresolved actionable MEDIUM/LOW findings
 * - convergence requires HIGH_COUNT == 0 and ACTIONABLE_COUNT == 0
 * - reviews-mode planner/checker prompts require REVIEWS.md feedback to land in PLAN.md
 */

// allow-test-rule: source-text-is-the-product
// The workflow markdown IS the runtime instruction. Testing its text content
// tests the deployed contract — if the CYCLE_SUMMARY requirement is absent,
// the false-stall bug is absent from defenses too.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'plan-review-convergence.md');
const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-review-convergence.md');
const CONFIG_DOC_PATH = path.join(__dirname, '..', 'docs', 'CONFIGURATION.md');
const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const PLANNER_REVIEWS_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-reviews.md');
const PLAN_CHECKER_PATH = path.join(__dirname, '..', 'agents', 'gsd-plan-checker.md');

// ─── Command source ────────────────────────────────────────────────────────

describe('plan-review-convergence command source (#2306)', () => {
  const command = fs.readFileSync(COMMAND_PATH, 'utf8');

  test('command name uses gsd: prefix (installer converts to gsd- on install)', () => {
    assert.ok(
      command.includes('name: gsd:plan-review-convergence'),
      'command name must use gsd: prefix so installer converts it to gsd-plan-review-convergence'
    );
  });

  test('command declares all reviewer flags in context', () => {
    assert.ok(command.includes('--codex'), 'must document --codex flag');
    assert.ok(command.includes('--gemini'), 'must document --gemini flag');
    assert.ok(command.includes('--claude'), 'must document --claude flag');
    assert.ok(command.includes('--opencode'), 'must document --opencode flag');
    assert.ok(command.includes('--all'), 'must document --all flag');
    assert.ok(command.includes('--max-cycles'), 'must document --max-cycles flag');
  });

  test('command documents local model reviewer flags (--ollama, --lm-studio, --llama-cpp)', () => {
    assert.ok(command.includes('--ollama'), 'must document --ollama flag for local Ollama server');
    assert.ok(command.includes('--lm-studio'), 'must document --lm-studio flag for local LM Studio server');
    assert.ok(command.includes('--llama-cpp'), 'must document --llama-cpp flag for local llama.cpp server');
  });

  test('command references the workflow file via execution_context', () => {
    assert.ok(
      command.includes('@$HOME/.claude/gsd-core/workflows/plan-review-convergence.md'),
      'execution_context must reference the workflow file'
    );
  });

  test('command references supporting reference files', () => {
    assert.ok(
      command.includes('revision-loop.md'),
      'must reference revision-loop.md for stall detection pattern'
    );
    assert.ok(
      command.includes('gates.md'),
      'must reference gates.md for gate taxonomy'
    );
    assert.ok(
      command.includes('agent-contracts.md'),
      'must reference agent-contracts.md for completion markers'
    );
  });

  test('command declares Agent in allowed-tools (required for spawning sub-agents)', () => {
    assert.ok(
      command.includes('- Agent'),
      'Agent must be in allowed-tools — command spawns isolated agents for planning and reviewing'
    );
  });

  test('command has Copilot runtime_note for AskUserQuestion fallback', () => {
    assert.ok(
      command.includes('vscode_askquestions'),
      'must document vscode_askquestions fallback for Copilot compatibility'
    );
  });

  test('--codex is the default reviewer when no flag is specified', () => {
    assert.ok(
      command.includes('default if no reviewer specified') ||
      command.includes('default: --codex') ||
      command.includes('(default if no reviewer specified)'),
      '--codex must be documented as the default reviewer'
    );
  });

  test('command documents the workflow.plan_review_convergence config key', () => {
    assert.ok(
      command.includes('workflow.plan_review_convergence') ||
      command.includes('plan_review_convergence'),
      'command must document the config key required to enable the feature (#2306-v2)'
    );
  });
});

// ─── Workflow: initialization ──────────────────────────────────────────────

describe('plan-review-convergence workflow: initialization (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow calls gsd-tools.cjs init plan-phase for initialization', () => {
    assert.ok(
      workflow.includes('gsd-tools.cjs') && workflow.includes('init') && workflow.includes('plan-phase'),
      'workflow must initialize via gsd-tools.cjs init plan-phase'
    );
  });

  test('workflow parses --max-cycles with default of 3', () => {
    assert.ok(
      workflow.includes('MAX_CYCLES') && workflow.includes('3'),
      'workflow must parse --max-cycles with default of 3'
    );
  });

  test('workflow displays a startup banner with phase number and reviewer flags', () => {
    assert.ok(
      workflow.includes('PLAN CONVERGENCE') || workflow.includes('Plan Convergence'),
      'workflow must display a startup banner'
    );
  });
});

// ─── Workflow: config gate (disabled by default) ───────────────────────────

describe('plan-review-convergence workflow: config gate (#2306-v2)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow checks workflow.plan_review_convergence config key before running', () => {
    assert.ok(
      workflow.includes('workflow.plan_review_convergence'),
      'workflow must check workflow.plan_review_convergence config key — feature is disabled by default (#2306-v2)'
    );
  });

  test('workflow exits with enable instructions when config key is false', () => {
    // Must tell the user how to enable the feature
    assert.ok(
      workflow.includes('gsd config-set workflow.plan_review_convergence true') ||
      workflow.includes('config-set workflow.plan_review_convergence'),
      'workflow must show the user how to enable the feature when disabled (#2306-v2)'
    );
  });

  test('workflow defaults config key to false (opt-in, not opt-out)', () => {
    // The config-get call must default to false, not true
    const configGetMatch = workflow.match(/config-get\s+workflow\.plan_review_convergence[^\n]*/);
    assert.ok(
      configGetMatch,
      'workflow must read workflow.plan_review_convergence via config-get'
    );
    assert.ok(
      configGetMatch[0].includes('"false"') || configGetMatch[0].includes("'false'") || configGetMatch[0].includes('false'),
      'workflow must default workflow.plan_review_convergence to false (disabled by default) (#2306-v2)'
    );
  });
});

// ─── Workflow: initial planning gate ──────────────────────────────────────

describe('plan-review-convergence workflow: initial planning gate (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow skips initial planning when plans already exist', () => {
    assert.ok(
      workflow.includes('has_plans') || workflow.includes('plan_count'),
      'workflow must check whether plans already exist before spawning planning agent'
    );
  });

  test('workflow runs gsd-plan-phase when no plans exist', () => {
    assert.ok(
      workflow.includes('gsd-plan-phase'),
      'workflow must invoke gsd-plan-phase when no plans exist'
    );
  });

  test('workflow errors if initial planning produces no PLAN.md files', () => {
    assert.ok(
      workflow.includes('PLAN_COUNT') || workflow.includes('plan_count'),
      'workflow must verify PLAN.md files were created after initial planning'
    );
  });
});

// ─── Workflow: convergence loop ────────────────────────────────────────────

describe('plan-review-convergence workflow: convergence loop (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow spawns isolated review agent each cycle', () => {
    assert.ok(
      workflow.includes('gsd-review'),
      'workflow must spawn Agent → gsd-review each cycle'
    );
  });

  test('workflow extracts HIGH and actionable counts from CYCLE_SUMMARY contract, NOT from grepping REVIEWS.md', () => {
    // Critical regression guard: REVIEWS.md accumulates history across cycles;
    // resolved HIGHs from cycle N remain in the file during cycle N+1 as audit trail,
    // inflating raw grep counts and causing false stalls. Counts must come from
    // the review agent's CYCLE_SUMMARY return message, not from the file.
    assert.ok(
      workflow.includes('CYCLE_SUMMARY'),
      'workflow must use CYCLE_SUMMARY contract from review agent return message, not raw grep (#2306-v2 false-stall fix)'
    );
    assert.ok(
      workflow.includes('current_high'),
      'workflow must parse current_high from CYCLE_SUMMARY line'
    );
    assert.ok(
      workflow.includes('ACTIONABLE_COUNT') && workflow.includes('current_actionable'),
      'workflow must parse current_actionable from CYCLE_SUMMARY line (#724)'
    );
  });

  test('workflow aborts if review agent omits CYCLE_SUMMARY contract', () => {
    assert.ok(
      workflow.includes('did not honor the CYCLE_SUMMARY contract') ||
      workflow.includes('CYCLE_SUMMARY contract'),
      'workflow must abort with clear error when review agent omits CYCLE_SUMMARY (#2306-v2)'
    );
  });

  test('workflow distinguishes malformed CYCLE_SUMMARY from absent CYCLE_SUMMARY', () => {
    // Helps debugging: "present but malformed" vs "completely missing" are different errors
    assert.ok(
      workflow.includes('malformed') ||
      (workflow.includes('CYCLE_SUMMARY') && workflow.includes('present')),
      'workflow must distinguish malformed CYCLE_SUMMARY from absent one for debuggability (#2306-v2)'
    );
  });

  test('workflow fails closed when current_actionable is missing or malformed', () => {
    assert.ok(
      workflow.includes('current_actionable is missing or malformed'),
      'missing or malformed current_actionable must abort instead of silently treating actionable findings as zero (#724)'
    );
  });

  test('review agent spawn forwards --ws via GSD_WS (symmetric with replan agent)', () => {
    // Critical correctness bug: if GSD_WS is not forwarded to the review agent,
    // the review reads from the wrong workspace while replanning reads from the correct one.
    const reviewAgentBlock = workflow.match(/gsd-review['"`,\s][\s\S]{0,300}?GSD_WS/);
    assert.ok(
      reviewAgentBlock ||
      (workflow.includes("'gsd-review'") && workflow.includes('{GSD_WS}') &&
       workflow.indexOf('{GSD_WS}') < workflow.indexOf("'gsd-plan-phase'")),
      'review agent spawn must forward {GSD_WS} — workspace flag must reach the reviewer (#2306-v2 --ws fix)'
    );
  });

  test('workflow exits loop only when HIGH_COUNT and ACTIONABLE_COUNT are zero', () => {
    assert.ok(
      workflow.includes('HIGH_COUNT == 0 and ACTIONABLE_COUNT == 0'),
      'workflow must require both HIGH_COUNT and ACTIONABLE_COUNT to be zero before convergence (#724)'
    );
    assert.ok(
      workflow.includes('If HIGH_COUNT > 0 or ACTIONABLE_COUNT > 0'),
      'current_high=0 with current_actionable>0 must continue to replan/escalation instead of converging (#724)'
    );
  });

  test('workflow updates STATE.md on convergence', () => {
    assert.ok(
      workflow.includes('planned-phase') || workflow.includes('state'),
      'workflow must update STATE.md via gsd-tools.cjs when converged'
    );
  });

  test('workflow spawns replan agent with --reviews flag', () => {
    assert.ok(
      workflow.includes('--reviews'),
      'replan agent must pass --reviews so gsd-plan-phase incorporates review feedback'
    );
  });

  test('workflow passes --skip-research to replan agent (research already done)', () => {
    assert.ok(
      workflow.includes('--skip-research'),
      'replan agent must skip research — only initial planning needs research'
    );
  });
});

// ─── Workflow: CYCLE_SUMMARY contract definition ──────────────────────────

describe('plan-review-convergence workflow: CYCLE_SUMMARY contract definition (#2306-v2)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('review agent prompt defines CYCLE_SUMMARY current_high/current_actionable format', () => {
    assert.ok(
      workflow.includes('CYCLE_SUMMARY: current_high=<N> current_actionable=<M>'),
      'review agent spawn prompt must define the CYCLE_SUMMARY current_high/current_actionable output format (#724)'
    );
  });

  test('CYCLE_SUMMARY contract defines PARTIALLY RESOLVED (acknowledged, mitigation incomplete)', () => {
    assert.ok(
      workflow.includes('PARTIALLY RESOLVED'),
      'CYCLE_SUMMARY INCLUDE list must define PARTIALLY RESOLVED — prevents under-counting of in-progress issues (#2306-v2)'
    );
  });

  test('CYCLE_SUMMARY contract defines FULLY RESOLVED (verified/closed)', () => {
    assert.ok(
      workflow.includes('FULLY RESOLVED'),
      'CYCLE_SUMMARY EXCLUDE list must define FULLY RESOLVED — prevents over-counting of closed issues (#2306-v2)'
    );
  });

  test('CYCLE_SUMMARY contract requires ## Current HIGH Concerns section in review return', () => {
    assert.ok(
      workflow.includes('## Current HIGH Concerns'),
      'review agent must provide ## Current HIGH Concerns section so escalation gate can show specific issues (#2306-v2)'
    );
  });

  test('CYCLE_SUMMARY contract defines ACTIONABLE non-HIGH findings and requires their section', () => {
    assert.ok(
      workflow.includes('ACTIONABLE') && workflow.includes('Current Actionable Non-HIGH Concerns'),
      'review agent must define actionable non-HIGH findings and list current unresolved actionable items (#724)'
    );
  });
});

// ─── Workflow: HIGH_LINES validation ──────────────────────────────────────

describe('plan-review-convergence workflow: HIGH_LINES validation (#2306-v2)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow warns when HIGH_COUNT > 0 but ## Current HIGH Concerns section is absent', () => {
    // Prevents silent UX degradation: escalation gate shows blank concern list
    assert.ok(
      workflow.includes('HIGH_LINES') &&
      (workflow.includes('incomplete escalation') || workflow.includes('Current HIGH Concerns')),
      'workflow must warn when HIGH_COUNT > 0 but HIGH_LINES is empty (contract partially violated) (#2306-v2)'
    );
  });

  test('workflow warns when ACTIONABLE_COUNT > 0 but actionable section is absent', () => {
    assert.ok(
      workflow.includes('ACTIONABLE_LINES') &&
      workflow.includes('Current Actionable Non-HIGH Concerns'),
      'workflow must warn when ACTIONABLE_COUNT > 0 but actionable details are empty (#724)'
    );
  });
});

// ─── Workflow: stall detection ─────────────────────────────────────────────

describe('plan-review-convergence workflow: stall detection (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow tracks previous unresolved count to detect stalls', () => {
    assert.ok(
      workflow.includes('prev_unresolved_count'),
      'workflow must track the previous total unresolved review count for stall detection (#724)'
    );
  });

  test('workflow warns when unresolved count is not decreasing', () => {
    assert.ok(
      workflow.includes('stall') || workflow.includes('Stall') || workflow.includes('not decreasing'),
      'workflow must warn user when unresolved review count is not decreasing between cycles'
    );
  });
});

// ─── Workflow: escalation gate ────────────────────────────────────────────

describe('plan-review-convergence workflow: escalation gate (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow escalates to user when max cycles reached with HIGHs remaining', () => {
    assert.ok(
      workflow.includes('MAX_CYCLES') &&
      (workflow.includes('AskUserQuestion') || workflow.includes('vscode_askquestions')),
      'workflow must escalate to user via AskUserQuestion when max cycles reached'
    );
  });

  test('escalation offers "Proceed anyway" option', () => {
    assert.ok(
      workflow.includes('Proceed anyway'),
      'escalation gate must offer "Proceed anyway" to accept plans with remaining HIGH concerns'
    );
  });

  test('escalation offers "Manual review" option', () => {
    assert.ok(
      workflow.includes('Manual review') || workflow.includes('manual'),
      'escalation gate must offer a manual review option'
    );
  });

  test('workflow has text-mode fallback for escalation (plain numbered list)', () => {
    assert.ok(
      workflow.includes('TEXT_MODE') || workflow.includes('text_mode'),
      'workflow must support TEXT_MODE for plain-text escalation prompt'
    );
  });
});

// ─── Workflow: stall detection — behavioral ───────────────────────────────

describe('plan-review-convergence workflow: stall detection behavioral (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow surfaces stall warning when unresolved count stops decreasing', () => {
    assert.ok(
      workflow.includes('prev_unresolved_count'),
      'workflow must track prev_unresolved_count across cycles (#724)'
    );
    assert.ok(
      workflow.includes('UNRESOLVED_COUNT >= prev_unresolved_count') ||
      workflow.includes('not decreasing'),
      'workflow must compare current unresolved count against previous to detect stall (#724)'
    );
    assert.ok(
      workflow.includes('stall') || workflow.includes('Stall') || workflow.includes('not decreasing'),
      'workflow must emit a stall warning when unresolved review count is not decreasing'
    );
  });
});

// ─── Workflow: --max-cycles 1 immediate escalation — behavioral ────────────

describe('plan-review-convergence workflow: --max-cycles 1 immediate escalation behavioral (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow escalates immediately after cycle 1 when --max-cycles 1 and HIGH > 0', () => {
    assert.ok(
      workflow.includes('cycle >= MAX_CYCLES') ||
      workflow.includes('cycle >= max_cycles') ||
      (workflow.includes('MAX_CYCLES') && workflow.includes('AskUserQuestion')),
      'workflow must check cycle >= MAX_CYCLES so --max-cycles 1 triggers escalation after first cycle'
    );
    assert.ok(
      workflow.includes('HIGH_COUNT > 0') ||
      workflow.includes('ACTIONABLE_COUNT > 0') ||
      workflow.includes('HIGH concerns remain') ||
      workflow.includes('Proceed anyway'),
      'escalation gate must be reachable when unresolved findings remain after a single cycle'
    );
  });
});

// ─── Workflow: REVIEWS.md verification ────────────────────────────────────

describe('plan-review-convergence workflow: artifact verification (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow verifies REVIEWS.md exists after each review cycle', () => {
    assert.ok(
      workflow.includes('REVIEWS.md') || workflow.includes('REVIEWS_FILE'),
      'workflow must verify REVIEWS.md was produced by the review agent each cycle'
    );
  });

  test('workflow errors if review agent does not produce REVIEWS.md', () => {
    assert.ok(
      workflow.includes('REVIEWS_FILE') || workflow.includes('review agent did not produce'),
      'workflow must error if the review agent fails to produce REVIEWS.md'
    );
  });
});

// ─── Workflow: success criteria ────────────────────────────────────────────

describe('plan-review-convergence workflow: success criteria (#2306-v2)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('success criteria references CYCLE_SUMMARY parsing, not grep findings', () => {
    const successBlock = workflow.slice(workflow.lastIndexOf('<success_criteria>'));
    assert.ok(
      (successBlock.includes('CYCLE_SUMMARY') || successBlock.includes('parse')) &&
        successBlock.includes('actionable non-HIGH'),
      'success_criteria must reflect that orchestrator parses HIGH and actionable CYCLE_SUMMARY counts, not greps REVIEWS.md (#724)'
    );
    assert.ok(
      !successBlock.includes('grep HIGHs'),
      'success_criteria must NOT say "grep HIGHs" — that was the false-stall bug (#2306-v2)'
    );
  });
});

// ─── Config schema registration ───────────────────────────────────────────

describe('plan-review-convergence config schema registration (#2306-v2)', () => {
  // After Cycle 5 (#3536), config-schema.cjs is a thin adapter sourcing from
  // the manifest. Use the runtime Set instead of text-parsing the source file.
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

  test('workflow.plan_review_convergence is registered in config-schema.cjs', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.plan_review_convergence'),
      "workflow.plan_review_convergence must be registered in VALID_CONFIG_KEYS in config-schema.cjs so gsd config-set accepts it (#2306-v2)"
    );
  });
});

// ─── CONFIGURATION.md documentation ──────────────────────────────────────

describe('plan-review-convergence CONFIGURATION.md documentation (#2306-v2)', () => {
  const configDoc = fs.readFileSync(CONFIG_DOC_PATH, 'utf8');

  test('workflow.plan_review_convergence is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('workflow.plan_review_convergence'),
      'workflow.plan_review_convergence must be documented in docs/CONFIGURATION.md — schema/docs parity test enforces this (#2306-v2)'
    );
  });

  test('CONFIGURATION.md entry documents disabled-by-default behavior', () => {
    const row = configDoc.match(/workflow\.plan_review_convergence[^\n]*/);
    assert.ok(row, 'workflow.plan_review_convergence row must exist in CONFIGURATION.md');
    assert.ok(
      row[0].includes('false') || row[0].includes('disabled'),
      'CONFIGURATION.md entry must document that the feature defaults to false (disabled by default) (#2306-v2)'
    );
  });
});

// ─── Reviews-mode incorporation contract (#724) ────────────────────────────

describe('plan-review-convergence reviews-mode incorporation contract (#724)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const planPhase = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
  const plannerReviews = fs.readFileSync(PLANNER_REVIEWS_PATH, 'utf8');
  const planChecker = fs.readFileSync(PLAN_CHECKER_PATH, 'utf8');

  test('workflow replans while actionable non-HIGH findings remain', () => {
    assert.ok(
      workflow.includes('Actionable MEDIUM/LOW findings must be incorporated into executable PLAN.md content'),
      'replan agent prompt must route actionable non-HIGH findings back through plan-phase --reviews (#724)'
    );
  });

  test('plan-phase planner prompt says REVIEWS.md is feedback input, not the execution contract', () => {
    assert.ok(
      planPhase.includes('<review_incorporation_contract>') &&
        planPhase.includes('REVIEWS.md is feedback input') &&
        planPhase.includes('/gsd:execute-phase primarily consumes PLAN.md'),
      'planner prompt must explain that actionable review feedback must land in PLAN.md for execute-phase (#724)'
    );
  });

  test('plan-phase checker prompt reads REVIEWS.md in reviews mode and fails hidden actionable findings', () => {
    assert.ok(
      planPhase.includes('{reviews_path}') &&
        planPhase.includes('<review_incorporation_verification>') &&
        planPhase.includes('return `## ISSUES FOUND`'),
      'checker prompt must read REVIEWS.md and fail if actionable findings remain only there (#724)'
    );
  });

  test('planner reviews reference requires actionable findings to appear in PLAN.md or be deferred there', () => {
    assert.ok(
      plannerReviews.includes('/gsd:execute-phase primarily consumes PLAN.md') &&
        plannerReviews.includes('Every current actionable review finding') &&
        plannerReviews.includes('deferral/rejection rationale in that PLAN.md'),
      'planner reviews reference must keep REVIEWS.md from becoming a hidden execution contract (#724)'
    );
  });

  test('gsd-plan-checker has a Review Incorporation dimension for reviews mode', () => {
    assert.ok(
      planChecker.includes('Review Incorporation') &&
        planChecker.includes('current_actionable=<M>') &&
        planChecker.includes('remains only in REVIEWS.md'),
      'plan checker must validate review incorporation when REVIEWS.md is present (#724)'
    );
  });
});

// ─── Local model reviewer support ────────────────────────────────────────

describe('plan-review-convergence local model reviewer flags (#2306-local)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow parses --ollama flag into REVIEWER_FLAGS', () => {
    assert.ok(
      workflow.includes('--ollama'),
      'workflow must parse --ollama flag so it is forwarded to the review agent'
    );
  });

  test('workflow parses --lm-studio flag into REVIEWER_FLAGS', () => {
    assert.ok(
      workflow.includes('--lm-studio'),
      'workflow must parse --lm-studio flag so it is forwarded to the review agent'
    );
  });

  test('workflow parses --llama-cpp flag into REVIEWER_FLAGS', () => {
    assert.ok(
      workflow.includes('--llama-cpp'),
      'workflow must parse --llama-cpp flag so it is forwarded to the review agent'
    );
  });
});

describe('plan-review-convergence local model config schema registration (#2306-local)', () => {
  // After Cycle 5 (#3536), config-schema.cjs is a thin adapter sourcing from
  // the manifest. Use the runtime Set instead of text-parsing the source file.
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

  test('review.ollama_host is registered in config-schema.cjs', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('review.ollama_host'),
      "review.ollama_host must be in VALID_CONFIG_KEYS so gsd config-set accepts it"
    );
  });

  test('review.lm_studio_host is registered in config-schema.cjs', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('review.lm_studio_host'),
      "review.lm_studio_host must be in VALID_CONFIG_KEYS so gsd config-set accepts it"
    );
  });

  test('review.llama_cpp_host is registered in config-schema.cjs', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('review.llama_cpp_host'),
      "review.llama_cpp_host must be in VALID_CONFIG_KEYS so gsd config-set accepts it"
    );
  });
});

// ─── Workflow: source-grounding pass (#22) ───────────────────────────────────

describe('plan-review-convergence workflow: source-grounding reviewer pass (#22)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow documents plan_review.source_grounding config key (default on)', () => {
    assert.ok(
      workflow.includes('plan_review.source_grounding'),
      'workflow must document the plan_review.source_grounding config key that gates the source-grounding pass (#22)'
    );
  });

  test('workflow defines all four symbol verdicts: VERIFIED, MISSING, AMBIGUOUS, UNCHECKABLE', () => {
    assert.ok(workflow.includes('VERIFIED'), 'workflow must define VERIFIED verdict');
    assert.ok(workflow.includes('MISSING'), 'workflow must define MISSING verdict');
    assert.ok(workflow.includes('AMBIGUOUS'), 'workflow must define AMBIGUOUS verdict');
    assert.ok(workflow.includes('UNCHECKABLE'), 'workflow must define UNCHECKABLE verdict');
  });

  test('workflow specifies needs-acknowledgement gating for MISSING symbols', () => {
    assert.ok(
      workflow.includes('needs-acknowledgement'),
      'workflow must specify needs-acknowledgement (not hard block) for MISSING at grep/intel authority (#22)'
    );
  });

  test('workflow instructs reviewer to exclude symbols declared under "Artifacts this phase produces"', () => {
    assert.ok(
      workflow.includes('Artifacts this phase produces'),
      'workflow must exclude new artifacts declared by the plan from symbol verification (#22)'
    );
  });

  test('workflow requires "Verification coverage" section appended to REVIEWS.md', () => {
    assert.ok(
      workflow.includes('Verification coverage'),
      'workflow must require a Verification coverage section in REVIEWS.md listing every UNCHECKABLE/skipped symbol (#22)'
    );
  });
});

describe('plan-review-convergence local model CONFIGURATION.md documentation (#2306-local)', () => {
  const configDoc = fs.readFileSync(CONFIG_DOC_PATH, 'utf8');

  test('review.ollama_host is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.ollama_host'),
      'review.ollama_host must be documented in docs/CONFIGURATION.md'
    );
  });

  test('review.lm_studio_host is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.lm_studio_host'),
      'review.lm_studio_host must be documented in docs/CONFIGURATION.md'
    );
  });

  test('review.llama_cpp_host is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.llama_cpp_host'),
      'review.llama_cpp_host must be documented in docs/CONFIGURATION.md'
    );
  });

  test('review.models.ollama is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.models.ollama'),
      'review.models.ollama must be documented so users know how to configure the local model name'
    );
  });

  test('review.models.lm_studio is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.models.lm_studio'),
      'review.models.lm_studio must be documented so users know how to configure the local model name'
    );
  });

  test('review.models.llama_cpp is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.models.llama_cpp'),
      'review.models.llama_cpp must be documented so users know how to configure the local model name'
    );
  });
});

// ─── Bug #936: plan-phase must run inline, not inside Agent() ─────────────
//
// Regression guard: inverted from the pre-#936 behavior that locked in the bug.
// On Claude Code a depth-1 Agent has no Agent tool, so gsd-plan-phase wrapped in
// Agent() cannot spawn gsd-planner / gsd-plan-checker → the replan loop breaks.
// Fix: run plan-phase inline (bare Skill()) from the depth-0 convergence orchestrator.
//
// These tests FAIL on pre-fix code and PASS after the fix.

describe('plan-review-convergence workflow: inline plan-phase dispatch (#936)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  // Helper: extract Agent() block bodies from workflow text
  function extractAgentBlocks(content) {
    const blocks = [];
    let pos = 0;
    while (pos < content.length) {
      const start = content.indexOf('Agent(', pos);
      if (start === -1) break;
      let depth = 0;
      let i = start + 'Agent('.length - 1;
      for (; i < content.length; i++) {
        if (content[i] === '(') depth++;
        else if (content[i] === ')') { depth--; if (depth === 0) break; }
      }
      blocks.push({ start, end: i + 1, blockText: content.slice(start, i + 1) });
      pos = i + 1;
    }
    return blocks;
  }

  test('initial planning does NOT wrap gsd-plan-phase inside Agent() (#936 fix)', () => {
    // Pre-fix: Agent( ... Skill('gsd-plan-phase') ... ) in step 4
    // Post-fix: bare Skill(skill="gsd-plan-phase") at orchestrator level
    const blocks = extractAgentBlocks(workflow);
    const wrapping = blocks.filter((b) =>
      /Skill\(\s*skill=['"]gsd-plan-phase['"]/.test(b.blockText)
    );
    assert.deepStrictEqual(
      wrapping.map((b) => b.blockText.slice(0, 80).replace(/\n/g, '\\n')),
      [],
      'Initial planning must NOT wrap gsd-plan-phase inside Agent() — run it inline so ' +
      'it can spawn gsd-planner/gsd-plan-checker at depth 1. See: bug #936'
    );
  });

  test('replan step does NOT wrap gsd-plan-phase inside Agent() (#936 fix)', () => {
    // Same check as above; explicitly named for the replan site (step 5d)
    const blocks = extractAgentBlocks(workflow);
    const wrapping = blocks.filter((b) =>
      /Skill\(\s*skill=['"]gsd-plan-phase['"]/.test(b.blockText) &&
      /--reviews/.test(b.blockText)
    );
    assert.deepStrictEqual(
      wrapping.map((b) => b.blockText.slice(0, 80).replace(/\n/g, '\\n')),
      [],
      'Replan step must NOT wrap gsd-plan-phase inside Agent() — the replan loop can ' +
      'never produce a plan on Claude Code when plan-phase is at depth 1. See: bug #936'
    );
  });

  test('workflow calls gsd-plan-phase inline (bare Skill outside Agent block) (#936 fix)', () => {
    // After the fix there must be at least one bare Skill(skill="gsd-plan-phase")
    // OUTSIDE any Agent() block.
    const blocks = extractAgentBlocks(workflow);
    let masked = workflow;
    const sorted = [...blocks].sort((a, b) => b.start - a.start);
    for (const b of sorted) {
      masked = masked.slice(0, b.start) + ' '.repeat(b.end - b.start) + masked.slice(b.end);
    }
    assert.ok(
      /Skill\(\s*skill=["']gsd-plan-phase["']/.test(masked),
      'plan-review-convergence must contain at least one bare Skill(skill="gsd-plan-phase") ' +
      'outside any Agent() block — the inline call that preserves depth-0 Agent availability. See: bug #936'
    );
  });

  test('success_criteria describes inline plan-phase, not Agent → Skill (#936 fix)', () => {
    const successBlock = workflow.slice(workflow.lastIndexOf('<success_criteria>'));
    // The broken criterion said "Initial planning via Agent → Skill"
    assert.ok(
      !successBlock.includes('via Agent → Skill("gsd-plan-phase")'),
      'success_criteria must NOT describe plan-phase as Agent → Skill — that was the broken pattern. See: bug #936'
    );
    // The broken criterion said "isolated, not inline" for the replan
    assert.ok(
      !successBlock.includes('isolated, not inline'),
      'success_criteria must NOT say "isolated, not inline" for plan-phase — the fix makes it inline. See: bug #936'
    );
  });
});
