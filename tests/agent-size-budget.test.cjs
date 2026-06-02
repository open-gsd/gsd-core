// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Agent size budget.
 *
 * Agent definitions in `agents/gsd-*.md` are loaded verbatim into Claude's
 * context on every subagent dispatch. Unbounded growth is paid on every call
 * across every workflow.
 *
 * Budgets are tiered to reflect the intent of each agent class:
 *   - XL       : top-level orchestrators that own end-to-end rubrics
 *   - LARGE    : multi-phase operators with branching workflows
 *   - DEFAULT  : focused single-purpose agents
 *
 * Raising a budget is a deliberate choice — adjust the constant, write a
 * rationale in the PR, and make sure the bloat is not duplicated content
 * that belongs in `get-shit-done/references/`.
 *
 * Tighten-only invariant (issue #597): ceilings track the tier high-water mark
 * within GRACE lines. Budgets may only decrease, never silently creep upward.
 * The assertTightCeiling() call below enforces this automatically.
 *
 * See: https://github.com/open-gsd/gsd-core/issues/2361
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assertTightCeiling } = require('../scripts/lib/allowlist-ratchet.cjs');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

// Ceilings tightened to actualMax + GRACE per the ratchet-down rule (#597).
// XL ceiling lowered from 1600 → 1512 (actualMax=1452, gsd-debugger).
const XL_BUDGET = 1512;
// LARGE ceiling kept at 1000 (actualMax=978, slack=22 ≤ GRACE=60).
const LARGE_BUDGET = 1000;
// DEFAULT ceiling kept at 500 (actualMax=495, slack=5 ≤ GRACE=60).
const DEFAULT_BUDGET = 500;

// Grace band: maximum allowed slack (ceiling − actualMax) before a ceiling is
// considered too loose. 60 lines gives one reasonable screen of breathing room
// without permitting gross inflation.
const GRACE = 60;

const XL_AGENTS = new Set([
  'gsd-debugger',
  'gsd-planner',
]);

const LARGE_AGENTS = new Set([
  'gsd-phase-researcher',
  'gsd-verifier',
  'gsd-doc-writer',
  'gsd-plan-checker',
  'gsd-executor',
  'gsd-code-fixer',
  'gsd-codebase-mapper',
  'gsd-project-researcher',
  'gsd-roadmapper',
]);

const ALL_AGENTS = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.startsWith('gsd-') && f.endsWith('.md'))
  .map(f => f.replace('.md', ''));

function budgetFor(agent) {
  if (XL_AGENTS.has(agent)) return { tier: 'XL', limit: XL_BUDGET };
  if (LARGE_AGENTS.has(agent)) return { tier: 'LARGE', limit: LARGE_BUDGET };
  return { tier: 'DEFAULT', limit: DEFAULT_BUDGET };
}

function lineCount(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.length === 0) return 0;
  const trailingNewline = content.endsWith('\n') ? 1 : 0;
  return content.split('\n').length - trailingNewline;
}

describe('SIZE: agent line-count budget', () => {
  for (const agent of ALL_AGENTS) {
    const { tier, limit } = budgetFor(agent);
    test(`${agent} (${tier}) stays under ${limit} lines`, () => {
      const filePath = path.join(AGENTS_DIR, agent + '.md');
      const lines = lineCount(filePath);
      assert.ok(
        lines <= limit,
        `${agent}.md has ${lines} lines — exceeds ${tier} budget of ${limit}. ` +
        `Extract shared boilerplate to get-shit-done/references/ or raise the budget ` +
        `in tests/agent-size-budget.test.cjs with a rationale.`
      );
    });
  }
});

describe('SIZE: tier anti-creep (tighten-only ceilings, issue #597)', () => {
  // For each tier, compute the high-water mark across all files in that tier
  // and assert the ceiling stays tight. Prevents budgets from silently drifting
  // upward: ceiling − actualMax must not exceed GRACE.
  test('XL tier: ceiling tracks high-water mark within GRACE', () => {
    const values = ALL_AGENTS
      .filter(a => XL_AGENTS.has(a))
      .map(a => lineCount(path.join(AGENTS_DIR, a + '.md')));
    const actualMax = Math.max(...values);
    assertTightCeiling({ label: 'XL', actualMax, ceiling: XL_BUDGET, grace: GRACE, fail: assert.fail });
  });

  test('LARGE tier: ceiling tracks high-water mark within GRACE', () => {
    const values = ALL_AGENTS
      .filter(a => LARGE_AGENTS.has(a))
      .map(a => lineCount(path.join(AGENTS_DIR, a + '.md')));
    const actualMax = Math.max(...values);
    assertTightCeiling({ label: 'LARGE', actualMax, ceiling: LARGE_BUDGET, grace: GRACE, fail: assert.fail });
  });

  test('DEFAULT tier: ceiling tracks high-water mark within GRACE', () => {
    const values = ALL_AGENTS
      .filter(a => !XL_AGENTS.has(a) && !LARGE_AGENTS.has(a))
      .map(a => lineCount(path.join(AGENTS_DIR, a + '.md')));
    const actualMax = Math.max(...values);
    assertTightCeiling({ label: 'DEFAULT', actualMax, ceiling: DEFAULT_BUDGET, grace: GRACE, fail: assert.fail });
  });
});

describe('SIZE: every agent is classified', () => {
  test('every agent falls in exactly one tier', () => {
    for (const agent of ALL_AGENTS) {
      const inXL = XL_AGENTS.has(agent);
      const inLarge = LARGE_AGENTS.has(agent);
      assert.ok(
        !(inXL && inLarge),
        `${agent} is in both XL_AGENTS and LARGE_AGENTS — pick one`
      );
    }
  });

  test('every named XL agent exists', () => {
    for (const agent of XL_AGENTS) {
      const filePath = path.join(AGENTS_DIR, agent + '.md');
      assert.ok(
        fs.existsSync(filePath),
        `XL_AGENTS references ${agent}.md which does not exist — clean up the set`
      );
    }
  });

  test('every named LARGE agent exists', () => {
    for (const agent of LARGE_AGENTS) {
      const filePath = path.join(AGENTS_DIR, agent + '.md');
      assert.ok(
        fs.existsSync(filePath),
        `LARGE_AGENTS references ${agent}.md which does not exist — clean up the set`
      );
    }
  });
});
