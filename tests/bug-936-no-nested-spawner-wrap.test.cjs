'use strict';
/**
 * Structural guard — bug(#936): plan-review-convergence wrapped gsd-plan-phase
 * in Agent() at TWO sites (initial planning + replan). On Claude Code, a depth-1
 * Agent has no Agent tool, so plan-phase cannot spawn gsd-planner / gsd-plan-checker
 * → the replan loop never works when HIGHs are found.
 *
 * Fix: run plan-phase INLINE (bare Skill()) from the convergence orchestrator,
 * which runs at depth 0 and has Agent available — exactly how autonomous.md,
 * manager.md, and discuss-phase-assumptions.md already chain plan-phase.
 *
 * This guard dynamically derives the set of "spawner" workflows (those containing
 * `subagent_type=`) and asserts that NO workflow wraps a spawner inside Agent()
 * UNLESS the wrapping block includes a RUNTIME != claude carve-out (the #853
 * pattern already applied to autonomous.md / manager.md).
 */

// allow-test-rule: source-text-is-the-product
// The workflow markdown IS the runtime instruction — static guards over
// workflow text are the canonical regression-test mechanism (per CONTRIBUTING
// exception matrix and tests/bug-853-bg-dispatch-runtime-gating.test.cjs).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// ── 1. Derive spawner skill names dynamically ──────────────────────────────
// A "spawner" workflow is one that contains `subagent_type=` — it NEEDS the
// Agent tool to run and therefore cannot safely be wrapped in another Agent()
// on Claude Code (where depth-1 agents have no Agent tool).

// Recursively collect all *.md files under WORKFLOWS_DIR (covers nested fragments
// like discuss-phase/modes/*.md and execute-phase/steps/*.md).
function collectWorkflowFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...collectWorkflowFiles(fullPath));
    } else if (e.name.endsWith('.md')) {
      results.push({
        name: path.relative(WORKFLOWS_DIR, fullPath),
        path: fullPath,
        content: fs.readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return results;
}

const allWorkflowFiles = collectWorkflowFiles(WORKFLOWS_DIR);

// Map: base-slug → workflow filename (e.g. "plan-phase" → "plan-phase.md")
// Skill() calls use the "gsd-<slug>" convention in all workflow files.
// We build BOTH the bare slug set and the gsd-prefixed skill-name set.
const SPAWNER_BASE_SLUGS = new Set(
  allWorkflowFiles
    .filter((w) => w.content.includes('subagent_type='))
    .map((w) => w.name.replace(/\.md$/, ''))
);

// Skill invocations use "gsd-<slug>" (e.g. gsd-plan-phase, gsd-execute-phase).
// Build the regex from the prefixed names so it actually matches what workflows write.
const SPAWNER_GSD_NAMES = new Set([...SPAWNER_BASE_SLUGS].map((s) => `gsd-${s}`));

// Build a regex that matches Skill(skill='gsd-<spawner>') or Skill(skill="gsd-<spawner>")
const spawnerPattern = new RegExp(
  `Skill\\(\\s*skill=['"](?:${[...SPAWNER_GSD_NAMES].join('|')})['"]`,
  's'
);

// ── 2. Helper: extract Agent() blocks from a workflow ─────────────────────
// Each block starts at "Agent(" and ends at the balancing ")".  We collect
// the text of each such block together with the surrounding context (a 400
// char window before the block) so we can check for RUNTIME carve-outs.

function extractAgentBlocks(content) {
  const blocks = [];
  let pos = 0;
  while (pos < content.length) {
    const start = content.indexOf('Agent(', pos);
    if (start === -1) break;
    // Walk forward to find the balancing closing paren
    let depth = 0;
    let i = start + 'Agent('.length - 1; // at the '('
    for (; i < content.length; i++) {
      if (content[i] === '(') depth++;
      else if (content[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const end = i + 1;
    const blockText = content.slice(start, end);
    // Capture context: 400 chars before the block (for RUNTIME gate detection)
    const contextBefore = content.slice(Math.max(0, start - 400), start);
    blocks.push({ start, end, blockText, contextBefore });
    pos = end;
  }
  return blocks;
}

// ── 3. Helper: does a block have a RUNTIME != claude carve-out nearby? ────
// The #853 pattern looks like: "RUNTIME is `claude`" in a preceding condition
// that switches to inline Skill() instead of the Agent() block.  A block is
// considered guarded when the 400-char context window before it (or the block
// body itself for block-internal guards) contains any of these markers.

function hasRuntimeCarveout(block) {
  const haystack = block.contextBefore + block.blockText;
  return (
    /RUNTIME[^`\n]{0,30}(?:!=|≠|is not|!==)\s*[`'"]?claude/i.test(haystack) ||
    /RUNTIME[^`\n]{0,30}claude[^`\n]{0,30}(?:inline|not.*Agent|do NOT)/i.test(haystack) ||
    /If `RUNTIME` is `claude`/i.test(haystack) ||
    /On Claude Code.*inline/is.test(haystack)
  );
}

// ── 4. The guard: scan every workflow for unguarded Agent→spawner wraps ───

describe('bug-936 — no workflow wraps a spawner skill inside Agent() without a RUNTIME carve-out', () => {
  test('spawner set is non-empty (self-check: subagent_type= grep must find files)', () => {
    assert.ok(SPAWNER_BASE_SLUGS.size > 0, `No spawner workflows found in ${WORKFLOWS_DIR} — SPAWNER_BASE_SLUGS derivation is broken`);
    // plan-phase must be a spawner (base slug)
    assert.ok(SPAWNER_BASE_SLUGS.has('plan-phase'), 'plan-phase.md must be in the spawner set (contains subagent_type=)');
    // gsd-plan-phase must be in the prefixed set used by the regex
    assert.ok(SPAWNER_GSD_NAMES.has('gsd-plan-phase'), 'gsd-plan-phase must be in SPAWNER_GSD_NAMES — the prefixed form used in Skill() calls');
  });

  for (const wf of allWorkflowFiles) {
    // Only scan files that have at least one Agent( call
    if (!wf.content.includes('Agent(')) continue;

    test(`${wf.name}: no Agent() block wraps a spawner Skill without a RUNTIME carve-out`, () => {
      const blocks = extractAgentBlocks(wf.content);
      const violations = blocks.filter((b) => {
        const wrapsSpawner = spawnerPattern.test(b.blockText);
        if (!wrapsSpawner) return false;
        return !hasRuntimeCarveout(b);
      });

      assert.deepStrictEqual(
        violations.map((v) => v.blockText.slice(0, 120).replace(/\n/g, '\\n')),
        [],
        `${wf.name} wraps a spawner Skill inside Agent() without a RUNTIME != claude carve-out.\n` +
        `Fix: run the spawner Skill inline (bare Skill() call at depth 0) OR add a RUNTIME gate.\n` +
        `See: bug #936, tests/bug-853-bg-dispatch-runtime-gating.test.cjs for the guarded pattern.`
      );
    });
  }
});

// ── 5. Focused regression: plan-review-convergence never wraps plan-phase ─

describe('bug-936 — plan-review-convergence runs plan-phase inline, not inside Agent()', () => {
  const CONVERGENCE = fs.readFileSync(
    path.join(WORKFLOWS_DIR, 'plan-review-convergence.md'),
    'utf8'
  );

  test('plan-review-convergence does NOT wrap gsd-plan-phase inside Agent()', () => {
    // The anti-pattern: Agent( block whose body contains Skill(skill='gsd-plan-phase')
    const blocks = extractAgentBlocks(CONVERGENCE);
    const wrapping = blocks.filter((b) =>
      /Skill\(\s*skill=['"]gsd-plan-phase['"]/.test(b.blockText) &&
      !hasRuntimeCarveout(b)
    );
    assert.deepStrictEqual(
      wrapping.map((v) => v.blockText.slice(0, 120).replace(/\n/g, '\\n')),
      [],
      'plan-review-convergence must NOT wrap gsd-plan-phase inside Agent(). ' +
      'Run it inline (bare Skill() at depth 0) so it can spawn gsd-planner/gsd-plan-checker. ' +
      'See: bug #936'
    );
  });

  test('plan-review-convergence calls gsd-plan-phase inline (bare Skill call outside Agent block)', () => {
    // After the fix: at least one bare Skill(skill="gsd-plan-phase") must appear
    // outside any Agent( block — that is the inline call from the depth-0 orchestrator.
    const blocks = extractAgentBlocks(CONVERGENCE);
    // Remove all Agent block ranges from the text
    let masked = CONVERGENCE;
    // Work from end to start so offsets stay valid
    const sorted = [...blocks].sort((a, b) => b.start - a.start);
    for (const b of sorted) {
      masked = masked.slice(0, b.start) + ' '.repeat(b.end - b.start) + masked.slice(b.end);
    }
    const hasInlineCall = /Skill\(\s*skill=["']gsd-plan-phase["']/.test(masked);
    assert.ok(
      hasInlineCall,
      'plan-review-convergence must contain at least one bare Skill(skill="gsd-plan-phase") ' +
      'outside any Agent() block — this is the inline call that lets plan-phase spawn its sub-agents. ' +
      'See: bug #936'
    );
  });

  test('plan-review-convergence still wraps gsd-review inside Agent() (leaf — isolation is correct)', () => {
    // gsd-review is a leaf (shells out via Bash, no subagent_type) so the Agent wrap is fine and intentional.
    const blocks = extractAgentBlocks(CONVERGENCE);
    const reviewWrap = blocks.some((b) => /Skill\(\s*skill=['"]gsd-review['"]/.test(b.blockText));
    assert.ok(reviewWrap, 'gsd-review must still be wrapped in Agent() — it is a Bash leaf and isolation is intentional');
  });
});
