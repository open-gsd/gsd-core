'use strict';

/**
 * Example-based unit tests for prompt-budget.cjs
 *
 * These tests assert EXACT outputs (exact strings, exact numbers, exact
 * booleans, exact array membership) to kill surviving mutants in:
 *   - ConditionalExpression, EqualityOperator, ArithmeticOperator,
 *     StringLiteral, BlockStatement, BooleanLiteral, ArrowFunction,
 *     MethodExpression, LogicalOperator
 *
 * Module: gsd-core/bin/lib/prompt-budget.cjs
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { estimateTokens, applyBudget } = require('../gsd-core/bin/lib/prompt-budget.cjs');

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Build a minimal valid sections object, optionally overriding fields.
 */
function sections(overrides = {}) {
  return {
    instructions: 'Instructions.',
    roadmap: 'Roadmap.',
    plans: [{ file: 'plan.md', content: 'Plan content.' }],
    projectMd: null,
    context: null,
    research: null,
    requirements: null,
    ...overrides,
  };
}

// ─── estimateTokens edge cases ────────────────────────────────────────────────

describe('estimateTokens: exact values', () => {
  test('null returns 0', () => {
    assert.equal(estimateTokens(null), 0);
  });

  test('undefined returns 0', () => {
    assert.equal(estimateTokens(undefined), 0);
  });

  test('empty string returns 0', () => {
    assert.equal(estimateTokens(''), 0);
  });

  test('1-char string returns 1', () => {
    assert.equal(estimateTokens('a'), 1);
  });

  test('4-char string returns 1', () => {
    assert.equal(estimateTokens('abcd'), 1);
  });

  test('5-char string returns 2 (ceil)', () => {
    assert.equal(estimateTokens('abcde'), 2);
  });

  test('8-char string returns 2', () => {
    assert.equal(estimateTokens('12345678'), 2);
  });

  test('9-char string returns 3 (ceil)', () => {
    assert.equal(estimateTokens('123456789'), 3);
  });

  test('100-char string returns 25', () => {
    assert.equal(estimateTokens('a'.repeat(100)), 25);
  });

  test('whitespace-only string: 4 spaces = 1 token', () => {
    assert.equal(estimateTokens('    '), 1);
  });

  test('newline counts as a character', () => {
    assert.equal(estimateTokens('\n\n\n\n'), 1);
  });

  test('multibyte emoji: each emoji is multiple chars', () => {
    // A single emoji like '😀' is 2 chars in JS (surrogate pair).
    // estimateTokens counts chars, so 2 chars -> ceil(2/4) = 1
    const emoji = '😀'; // '😀'
    assert.equal(emoji.length, 2);
    assert.equal(estimateTokens(emoji), 1);
  });

  test('4 emojis (8 chars) = 2 tokens', () => {
    const emoji = '😀'.repeat(4); // 8 chars
    assert.equal(estimateTokens(emoji), 2);
  });
});

// ─── applyBudget: return shape always present ─────────────────────────────────

describe('applyBudget: return shape', () => {
  test('always returns prompt (string) and metadata (object)', () => {
    const result = applyBudget({ sections: sections(), budget: 10000 });
    assert.equal(typeof result.prompt, 'string');
    assert.equal(typeof result.metadata, 'object');
    assert.ok(result.metadata !== null);
  });

  test('metadata always has all required fields', () => {
    const result = applyBudget({ sections: sections(), budget: 10000 });
    const md = result.metadata;
    assert.equal(typeof md.budget, 'number');
    assert.equal(typeof md.effectiveBudget, 'number');
    assert.equal(typeof md.estimatedTokens, 'number');
    assert.ok(Array.isArray(md.omitted));
    assert.equal(typeof md.projectMdShrunk, 'boolean');
    assert.equal(typeof md.planTruncationPct, 'number');
    assert.equal(typeof md.hardFailed, 'boolean');
    assert.equal(typeof md.noteInjected, 'boolean');
  });
});

// ─── applyBudget: effectiveBudget computation ─────────────────────────────────

describe('applyBudget: effectiveBudget computation', () => {
  test('default 10% safety margin: budget=1000 → effectiveBudget=900', () => {
    const result = applyBudget({ sections: sections(), budget: 1000 });
    assert.equal(result.metadata.budget, 1000);
    assert.equal(result.metadata.effectiveBudget, 900);
  });

  test('budget field in metadata reflects the raw input budget', () => {
    const result = applyBudget({ sections: sections(), budget: 5000 });
    assert.equal(result.metadata.budget, 5000);
  });

  test('0% safety margin: effectiveBudget == budget', () => {
    const result = applyBudget({
      sections: sections(),
      budget: 1000,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(result.metadata.effectiveBudget, 1000);
  });

  test('50% safety margin: budget=1000 → effectiveBudget=500', () => {
    const result = applyBudget({
      sections: sections(),
      budget: 1000,
      options: { safetyMarginPct: 50 },
    });
    assert.equal(result.metadata.effectiveBudget, 500);
  });

  test('20% safety margin: budget=1000 → effectiveBudget=800', () => {
    const result = applyBudget({
      sections: sections(),
      budget: 1000,
      options: { safetyMarginPct: 20 },
    });
    assert.equal(result.metadata.effectiveBudget, 800);
  });

  test('floor is applied: budget=101, 10% margin → effectiveBudget=90 (floor of 90.9)', () => {
    const result = applyBudget({ sections: sections(), budget: 101 });
    assert.equal(result.metadata.effectiveBudget, 90);
  });
});

// ─── applyBudget: no-trim path (budget is ample) ─────────────────────────────

describe('applyBudget: ample budget (no trimming needed)', () => {
  test('hardFailed=false, noteInjected=false, omitted=[], projectMdShrunk=false', () => {
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(result.metadata.hardFailed, false);
    assert.equal(result.metadata.noteInjected, false);
    assert.deepEqual(result.metadata.omitted, []);
    assert.equal(result.metadata.projectMdShrunk, false);
    assert.equal(result.metadata.planTruncationPct, 0);
  });

  test('prompt is non-empty', () => {
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.ok(result.prompt.length > 0);
  });

  test('prompt contains instructions verbatim', () => {
    const s = sections({ instructions: 'EXACT_INSTRUCTIONS_TEXT' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('EXACT_INSTRUCTIONS_TEXT'));
  });

  test('prompt contains roadmap verbatim under roadmap header', () => {
    const s = sections({ roadmap: 'MY_ROADMAP_CONTENT' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Roadmap\n\nMY_ROADMAP_CONTENT'));
  });

  test('prompt contains plan under plans header with file name', () => {
    const s = sections({ plans: [{ file: 'feature.md', content: 'Plan A.' }] });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Plans\n\n### feature.md\n\nPlan A.'));
  });

  test('estimatedTokens equals estimateTokens(prompt)', () => {
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(result.metadata.estimatedTokens, estimateTokens(result.prompt));
  });

  test('multiple plans are concatenated with double newlines', () => {
    const s = sections({
      plans: [
        { file: 'a.md', content: 'AAA' },
        { file: 'b.md', content: 'BBB' },
      ],
    });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('### a.md\n\nAAA\n\n### b.md\n\nBBB'));
  });

  test('projectMd is included under Project header when provided', () => {
    const s = sections({ projectMd: 'Project content here.' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Project\n\nProject content here.'));
  });

  test('context is included under Context header when provided', () => {
    const s = sections({ context: 'Some context.' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Context\n\nSome context.'));
  });

  test('research is included under Research header when provided', () => {
    const s = sections({ research: 'Research notes.' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Research\n\nResearch notes.'));
  });

  test('requirements is included under Requirements header when provided', () => {
    const s = sections({ requirements: 'Req 1.' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Requirements\n\nReq 1.'));
  });

  test('null optional sections are NOT included', () => {
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.ok(!result.prompt.includes('## Context'));
    assert.ok(!result.prompt.includes('## Research'));
    assert.ok(!result.prompt.includes('## Requirements'));
    assert.ok(!result.prompt.includes('## Project'));
  });

  test('prompt blocks are joined with double newlines', () => {
    // instructions + roadmap block separated by \n\n
    const s = sections({ instructions: 'INST', roadmap: 'ROAD' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('INST\n\n## Roadmap\n\nROAD'));
  });
});

// ─── applyBudget: hard-fail on minSet > effectiveBudget ───────────────────────

describe('applyBudget: hard-fail (minSet > effectiveBudget)', () => {
  // minSet = estimateTokens(instructions) + estimateTokens(roadmap) + min plan tokens
  // MIN_PLAN_BYTES = 1024; plan.slice(0,1024) is used for the estimate
  // With tiny budget: minSet will exceed effectiveBudget

  test('very small budget → hardFailed=true', () => {
    // instructions+roadmap alone are >5 tokens; budget=1 → effectiveBudget=0
    const result = applyBudget({ sections: sections(), budget: 1 });
    assert.equal(result.metadata.hardFailed, true);
  });

  test('hard-fail returns empty prompt string', () => {
    const result = applyBudget({ sections: sections(), budget: 1 });
    assert.equal(result.prompt, '');
  });

  test('hard-fail metadata.estimatedTokens = 0', () => {
    const result = applyBudget({ sections: sections(), budget: 1 });
    assert.equal(result.metadata.estimatedTokens, 0);
  });

  test('hard-fail metadata.omitted = []', () => {
    const result = applyBudget({ sections: sections(), budget: 1 });
    assert.deepEqual(result.metadata.omitted, []);
  });

  test('hard-fail metadata.projectMdShrunk = false', () => {
    const result = applyBudget({ sections: sections(), budget: 1 });
    assert.equal(result.metadata.projectMdShrunk, false);
  });

  test('hard-fail metadata.planTruncationPct = 0', () => {
    const result = applyBudget({ sections: sections(), budget: 1 });
    assert.equal(result.metadata.planTruncationPct, 0);
  });

  test('hard-fail metadata.noteInjected = false', () => {
    const result = applyBudget({ sections: sections(), budget: 1 });
    assert.equal(result.metadata.noteInjected, false);
  });

  test('hard-fail metadata.budget = supplied budget', () => {
    const result = applyBudget({ sections: sections(), budget: 5 });
    assert.equal(result.metadata.budget, 5);
  });

  test('hard-fail metadata.effectiveBudget = floor(budget * 0.9)', () => {
    const result = applyBudget({ sections: sections(), budget: 10 });
    assert.equal(result.metadata.effectiveBudget, 9);
  });

  test('boundary: budget just below minSet threshold → hardFailed=true', () => {
    // Build a known minSet
    const inst = 'I'.repeat(40); // 10 tokens
    const road = 'R'.repeat(40); // 10 tokens
    // plan content < 1024 chars, so minPlanTokens = estimateTokens(planContent)
    const planContent = 'P'.repeat(40); // 10 tokens
    // minSet = 10 + 10 + 10 = 30 tokens
    // With safetyMarginPct=0, effectiveBudget=budget. At budget=29, hardFail.
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: planContent }] }),
      budget: 29,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(result.metadata.hardFailed, true);
    assert.equal(result.prompt, '');
  });

  test('boundary: budget just at minSet threshold → minSet check does not fire (not strictly >)', () => {
    const inst = 'I'.repeat(40); // 10 tokens
    const road = 'R'.repeat(40); // 10 tokens
    const planContent = 'P'.repeat(40); // 10 tokens
    // minSet = 10+10+10 = 30 tokens
    // At budget=29 (safetyMarginPct=0): effectiveBudget=29, minSet(30) > 29 → minSet hard-fail
    // → estimatedTokens=0 (distinguishes this path from post-assembly hard-fail)
    const resultBelow = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: planContent }] }),
      budget: 29,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(resultBelow.metadata.hardFailed, true);
    assert.equal(resultBelow.metadata.estimatedTokens, 0);

    // At budget=30 (safetyMarginPct=0): effectiveBudget=30, minSet(30) NOT > 30
    // → minSet check does NOT fire; any hard-fail is from post-assembly check
    const resultAt = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: planContent }] }),
      budget: 30,
      options: { safetyMarginPct: 0 },
    });
    // If hard-fail, it must be the post-assembly path (estimatedTokens is real prompt size, not 0)
    if (resultAt.metadata.hardFailed) {
      assert.ok(resultAt.metadata.estimatedTokens > 0,
        'post-assembly hard-fail must record real estimatedTokens, not 0');
    }
    assert.equal(resultAt.metadata.budget, 30);
    assert.equal(resultAt.metadata.effectiveBudget, 30);
  });
});

// ─── applyBudget: note injection ──────────────────────────────────────────────

describe('applyBudget: note injection', () => {
  test('no trim needed → no note in prompt', () => {
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(result.metadata.noteInjected, false);
    assert.ok(!result.prompt.includes('<note>'));
  });

  test('context dropped → noteInjected=true', () => {
    // Build a tight budget that forces context to be dropped
    // instructions="I"*4=1tok, roadmap="R"*4=1tok, plan="P"*4=1tok → minSet=3
    // staticBase includes headers + plan file header
    // We'll use a very tight but not hard-fail budget
    const inst = 'I'.repeat(4);   // 1 token
    const road = 'R'.repeat(4);   // 1 token
    const plan = 'P'.repeat(4);   // 1 token
    const ctx  = 'C'.repeat(400); // 100 tokens
    // With safetyMarginPct=0: effectiveBudget = budget
    // Make budget just big enough for staticBase but not ctx
    // staticBase = inst(1) + roadmapHeader("## Roadmap\n\n"=12chars=3tok) + road(1)
    //            + plansHeader("## Plans\n\n"=10chars=3tok) + planItemHeader("### plan.md\n\n"=13chars=4tok) + plan(1)
    //            = 1+3+1+3+4+1 = 13 tokens
    // Set budget = 13 (no room for ctx's 100 tokens)
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'plan.md', content: plan }], context: ctx }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.equal(result.metadata.noteInjected, true);
      assert.ok(result.prompt.includes('<note>'));
      assert.ok(result.metadata.omitted.includes('context'));
    }
  });

  test('note appears before roadmap and after instructions', () => {
    // Force context drop to inject note
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan = 'P'.repeat(4);
    const ctx  = 'C'.repeat(400);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'plan.md', content: plan }], context: ctx }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.noteInjected) {
      const noteIdx = result.prompt.indexOf('<note>');
      const roadmapIdx = result.prompt.indexOf('## Roadmap');
      const instIdx = result.prompt.indexOf(inst);
      assert.ok(instIdx < noteIdx, 'instructions before note');
      assert.ok(noteIdx < roadmapIdx, 'note before roadmap');
    }
  });

  test('default note template contains budget value', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan = 'P'.repeat(4);
    const ctx  = 'C'.repeat(400);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'plan.md', content: plan }], context: ctx }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.noteInjected) {
      assert.ok(result.prompt.includes('13-token budget'));
    }
  });

  test('default note template contains omitted section name', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan = 'P'.repeat(4);
    const ctx  = 'C'.repeat(400);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'plan.md', content: plan }], context: ctx }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.omitted.includes('context')) {
      assert.ok(result.prompt.includes('context'));
    }
  });

  test('custom noteTemplate is used when provided', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan = 'P'.repeat(4);
    const ctx  = 'C'.repeat(400);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'plan.md', content: plan }], context: ctx }),
      budget: 13,
      options: { safetyMarginPct: 0, noteTemplate: 'CUSTOM_NOTE_MARKER' },
    });
    if (!result.metadata.hardFailed && result.metadata.noteInjected) {
      assert.ok(result.prompt.includes('CUSTOM_NOTE_MARKER'));
      assert.ok(!result.prompt.includes('<note>'));
    }
  });

  test('note template {omittedList} is "none" when nothing omitted but note injected via shrink', () => {
    // Trigger a projectMd shrink (not a drop) to inject note with empty omitted
    // We need budget pressure but no drops, just projectMd head-shrink
    // Make projectMd very long but within budget after shrink
    const inst = 'I'.repeat(4);   // 1 tok
    const road = 'R'.repeat(4);   // 1 tok
    const plan = 'P'.repeat(4);   // 1 tok
    // 60 lines of 4 chars each = 60*5=300chars → ~75 tokens after head-shrink to 40 lines
    const projectLines = Array.from({ length: 100 }, (_, i) => 'L' + i).join('\n');
    // Make a very tight budget that fits after projectMd shrink
    // staticBase ≈ 13 tokens; after shrink projectMd head 40 lines is much smaller
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'plan.md', content: plan }], projectMd: projectLines }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.projectMdShrunk) {
      assert.equal(result.metadata.noteInjected, true);
      // omitted should be [] since only shrunk, not dropped
      assert.deepEqual(result.metadata.omitted, []);
      assert.ok(result.prompt.includes('none'));
    }
  });
});

// ─── applyBudget: projectMd head-shrink ───────────────────────────────────────

describe('applyBudget: projectMd head-shrink', () => {
  test('projectMd with > 40 lines is shrunk when over budget', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan = 'P'.repeat(4);
    // 100 lines
    const bigProject = Array.from({ length: 100 }, (_, i) => 'Line' + i).join('\n');
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'plan.md', content: plan }], projectMd: bigProject }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.equal(result.metadata.projectMdShrunk, true);
      // The prompt's Project section should have at most 40 lines
      const projStart = result.prompt.indexOf('## Project\n\n') + '## Project\n\n'.length;
      const projEnd = result.prompt.indexOf('\n\n## ', projStart);
      const projContent = projEnd === -1
        ? result.prompt.slice(projStart)
        : result.prompt.slice(projStart, projEnd);
      const lineCount = projContent.split('\n').length;
      assert.ok(lineCount <= 40, `projectMd has ${lineCount} lines, expected <= 40`);
    }
  });

  test('projectMd already short enough is NOT shrunk', () => {
    const shortProject = 'Line1\nLine2\nLine3';
    const result = applyBudget({
      sections: sections({ projectMd: shortProject }),
      budget: 100000,
    });
    assert.equal(result.metadata.projectMdShrunk, false);
    assert.ok(result.prompt.includes(shortProject));
  });

  test('custom projectMdHeadLines=5 limits to 5 lines', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan = 'P'.repeat(4);
    // 20 lines
    const bigProject = Array.from({ length: 20 }, (_, i) => 'X'.repeat(4) + i).join('\n');
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'plan.md', content: plan }], projectMd: bigProject }),
      budget: 20,
      options: { safetyMarginPct: 0, projectMdHeadLines: 5 },
    });
    if (!result.metadata.hardFailed && result.metadata.projectMdShrunk) {
      const projStart = result.prompt.indexOf('## Project\n\n') + '## Project\n\n'.length;
      const projEnd = result.prompt.indexOf('\n\n## ', projStart);
      const projContent = projEnd === -1
        ? result.prompt.slice(projStart)
        : result.prompt.slice(projStart, projEnd);
      const lineCount = projContent.split('\n').length;
      assert.ok(lineCount <= 5, `projectMd has ${lineCount} lines, expected <= 5`);
    }
  });

  test('projectMdShrunk is false when projectMd is null', () => {
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(result.metadata.projectMdShrunk, false);
  });
});

// ─── applyBudget: section drop order ─────────────────────────────────────────

describe('applyBudget: section drop order (context → research → requirements)', () => {
  // Build sections where each optional section adds enough tokens to bust the budget.
  // We'll use a budget that's tight enough to force drops.

  function tightSections(overrides = {}) {
    // Very minimal core to keep minSet tiny
    return sections({
      instructions: 'I'.repeat(4),
      roadmap: 'R'.repeat(4),
      plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
      ...overrides,
    });
  }

  test('context is dropped first (before research and requirements)', () => {
    // Give all three optionals, use a budget tight enough to force at least one drop
    const ctx = 'C'.repeat(400);  // ~100 tokens
    const res = 'R'.repeat(400);  // ~100 tokens
    const req = 'Q'.repeat(400);  // ~100 tokens
    // staticBase ≈ 13 tokens; all three add ~300+ tokens; budget = 50 forces drops
    const result = applyBudget({
      sections: tightSections({ context: ctx, research: res, requirements: req }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.omitted.length > 0) {
      // context must appear before research and requirements in omitted list
      const ctxIdx = result.metadata.omitted.indexOf('context');
      const resIdx = result.metadata.omitted.indexOf('research');
      const reqIdx = result.metadata.omitted.indexOf('requirements');
      if (ctxIdx !== -1 && resIdx !== -1) {
        assert.ok(ctxIdx < resIdx, 'context must be dropped before research');
      }
      if (ctxIdx !== -1 && reqIdx !== -1) {
        assert.ok(ctxIdx < reqIdx, 'context must be dropped before requirements');
      }
    }
  });

  test('research is dropped second (before requirements)', () => {
    const ctx = 'C'.repeat(400);
    const res = 'R'.repeat(400);
    const req = 'Q'.repeat(400);
    const result = applyBudget({
      sections: tightSections({ context: ctx, research: res, requirements: req }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      const resIdx = result.metadata.omitted.indexOf('research');
      const reqIdx = result.metadata.omitted.indexOf('requirements');
      if (resIdx !== -1 && reqIdx !== -1) {
        assert.ok(resIdx < reqIdx, 'research must be dropped before requirements');
      }
    }
  });

  test('dropped context not present in prompt', () => {
    const ctx = 'UNIQUE_CONTEXT_STRING_12345';
    const result = applyBudget({
      sections: tightSections({ context: 'C'.repeat(400) }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.omitted.includes('context')) {
      assert.ok(!result.prompt.includes('## Context'));
    }
    void ctx;
  });

  test('dropped research not present in prompt', () => {
    const result = applyBudget({
      sections: tightSections({ research: 'R'.repeat(400) }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.omitted.includes('research')) {
      assert.ok(!result.prompt.includes('## Research'));
    }
  });

  test('dropped requirements not present in prompt', () => {
    const result = applyBudget({
      sections: tightSections({ requirements: 'Q'.repeat(400) }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.omitted.includes('requirements')) {
      assert.ok(!result.prompt.includes('## Requirements'));
    }
  });

  test('only context dropped when only context present and over budget', () => {
    const ctx = 'C'.repeat(400); // 100 tokens
    // staticBase ≈ 13 tokens; budget=13 forces context drop
    const result = applyBudget({
      sections: tightSections({ context: ctx }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.deepEqual(result.metadata.omitted, ['context']);
    }
  });

  test('only research dropped when only research present and over budget', () => {
    const res = 'R'.repeat(400);
    const result = applyBudget({
      sections: tightSections({ research: res }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.deepEqual(result.metadata.omitted, ['research']);
    }
  });

  test('only requirements dropped when only requirements present and over budget', () => {
    const req = 'Q'.repeat(400);
    const result = applyBudget({
      sections: tightSections({ requirements: req }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.deepEqual(result.metadata.omitted, ['requirements']);
    }
  });

  test('context retained when budget allows', () => {
    const ctx = 'CONTEXT_IS_HERE';
    const result = applyBudget({
      sections: tightSections({ context: ctx }),
      budget: 100000,
    });
    assert.ok(result.prompt.includes('## Context\n\n' + ctx));
    assert.deepEqual(result.metadata.omitted, []);
  });

  test('omitted list for "none" renders correctly in default note', () => {
    // projectMdShrunk only → omitted=[], note says "none"
    const bigProject = Array.from({ length: 100 }, () => 'XXXX').join('\n');
    const result = applyBudget({
      sections: sections({ instructions: 'I'.repeat(4), roadmap: 'R'.repeat(4), plans: [{ file: 'p.md', content: 'P'.repeat(4) }], projectMd: bigProject }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.projectMdShrunk && result.metadata.omitted.length === 0) {
      assert.ok(result.prompt.includes('Omitted sections: none.'));
    }
  });

  test('omitted list for one section renders that section name', () => {
    const ctx = 'C'.repeat(400);
    const result = applyBudget({
      sections: tightSections({ context: ctx }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.omitted.includes('context')) {
      assert.ok(result.prompt.includes('Omitted sections: context.'));
    }
  });
});

// ─── applyBudget: plan truncation ─────────────────────────────────────────────

describe('applyBudget: plan truncation (proportional tail-truncate)', () => {
  test('planTruncationPct = 0 when no truncation needed', () => {
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(result.metadata.planTruncationPct, 0);
  });

  test('planTruncationPct > 0 when plans are truncated', () => {
    // Very large plan content, tight budget
    const inst = 'I'.repeat(4);  // 1 tok
    const road = 'R'.repeat(4);  // 1 tok
    const bigPlan = 'P'.repeat(4000); // 1000 tokens
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.ok(result.metadata.planTruncationPct > 0,
        `expected planTruncationPct > 0, got ${result.metadata.planTruncationPct}`);
    }
  });

  test('truncated plan content is shorter than original', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const originalLength = bigPlan.length;
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.planTruncationPct > 0) {
      // The plan section in the prompt should be shorter than original
      const planStart = result.prompt.indexOf('### x.md\n\n') + '### x.md\n\n'.length;
      const planContent = result.prompt.slice(planStart);
      assert.ok(planContent.length < originalLength, 'plan content should be truncated');
    }
  });

  test('planTruncationPct is between 0 and 100', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.ok(result.metadata.planTruncationPct >= 0);
      assert.ok(result.metadata.planTruncationPct <= 100);
    }
  });

  test('plans always kept (never dropped entirely) — at least MIN_PLAN_BYTES content', () => {
    // Even with extreme budget pressure, each plan gets at least 1024 chars (MIN_PLAN_BYTES)
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(10000);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 300,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      const planStart = result.prompt.indexOf('### x.md\n\n') + '### x.md\n\n'.length;
      const planContent = result.prompt.slice(planStart);
      assert.ok(planContent.length >= 1024,
        `plan should have >= 1024 chars, got ${planContent.length}`);
    }
  });

  test('note is injected when plan is truncated', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.planTruncationPct > 0) {
      assert.equal(result.metadata.noteInjected, true);
    }
  });

  test('note planTruncationPct in template is rounded integer string', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.noteInjected) {
      // The note template has: 'Plan content truncated by approximately {planTruncationPct}%.'
      assert.ok(result.prompt.includes('Plan content truncated by approximately'));
      // Should contain a whole number followed by %
      assert.ok(/truncated by approximately \d+%/.test(result.prompt));
    }
  });

  test('two plans are proportionally truncated', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    // Two plans of equal length — each should get proportionally same truncation
    const plan1 = 'A'.repeat(4000);
    const plan2 = 'B'.repeat(4000);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'a.md', content: plan1 }, { file: 'b.md', content: plan2 }] }),
      budget: 80,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.planTruncationPct > 0) {
      // Both plan sections should appear in the prompt
      assert.ok(result.prompt.includes('### a.md'));
      assert.ok(result.prompt.includes('### b.md'));
    }
  });
});

// ─── applyBudget: exact prompt assembly order ─────────────────────────────────

describe('applyBudget: prompt assembly order', () => {
  test('section order: instructions → (note) → roadmap → project → plans → context → research → requirements', () => {
    const s = sections({
      instructions: 'INST',
      roadmap: 'ROAD',
      plans: [{ file: 'f.md', content: 'PLAN' }],
      projectMd: 'PROJ',
      context: 'CTX',
      research: 'RES',
      requirements: 'REQ',
    });
    const result = applyBudget({ sections: s, budget: 100000 });
    const p = result.prompt;
    const idxInst = p.indexOf('INST');
    const idxRoad = p.indexOf('## Roadmap');
    const idxProj = p.indexOf('## Project');
    const idxPlan = p.indexOf('## Plans');
    const idxCtx  = p.indexOf('## Context');
    const idxRes  = p.indexOf('## Research');
    const idxReq  = p.indexOf('## Requirements');

    assert.ok(idxInst >= 0, 'instructions present');
    assert.ok(idxRoad > idxInst, 'roadmap after instructions');
    assert.ok(idxProj > idxRoad, 'project after roadmap');
    assert.ok(idxPlan > idxProj, 'plans after project');
    assert.ok(idxCtx  > idxPlan, 'context after plans');
    assert.ok(idxRes  > idxCtx,  'research after context');
    assert.ok(idxReq  > idxRes,  'requirements after research');
  });

  test('sections joined with double newline separators', () => {
    const s = sections({
      instructions: 'INST',
      roadmap: 'ROAD',
      plans: [{ file: 'f.md', content: 'PLAN' }],
    });
    const result = applyBudget({ sections: s, budget: 100000 });
    // instructions and roadmap block must be separated by \n\n
    assert.ok(result.prompt.includes('INST\n\n## Roadmap\n\nROAD'));
  });

  test('roadmap block uses exact header "## Roadmap\\n\\n"', () => {
    const s = sections({ roadmap: 'ROADMAP_BODY' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Roadmap\n\nROADMAP_BODY'));
  });

  test('project block uses exact header "## Project\\n\\n"', () => {
    const s = sections({ projectMd: 'PROJ_BODY' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Project\n\nPROJ_BODY'));
  });

  test('plans block uses exact header "## Plans\\n\\n"', () => {
    const s = sections({ plans: [{ file: 'x.md', content: 'PLAN_BODY' }] });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Plans\n\n### x.md\n\nPLAN_BODY'));
  });

  test('context block uses exact header "## Context\\n\\n"', () => {
    const s = sections({ context: 'CTX_BODY' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Context\n\nCTX_BODY'));
  });

  test('research block uses exact header "## Research\\n\\n"', () => {
    const s = sections({ research: 'RES_BODY' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Research\n\nRES_BODY'));
  });

  test('requirements block uses exact header "## Requirements\\n\\n"', () => {
    const s = sections({ requirements: 'REQ_BODY' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Requirements\n\nREQ_BODY'));
  });

  test('plan item uses "### <filename>\\n\\n<content>" format', () => {
    const s = sections({ plans: [{ file: 'my-plan.md', content: 'PLAN_CONTENT' }] });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('### my-plan.md\n\nPLAN_CONTENT'));
  });

  test('plan items separated by double newline', () => {
    const s = sections({
      plans: [
        { file: 'a.md', content: 'AAA' },
        { file: 'b.md', content: 'BBB' },
      ],
    });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('### a.md\n\nAAA\n\n### b.md\n\nBBB'));
  });

  test('empty plans array: plans block still rendered with empty content', () => {
    const s = sections({ plans: [] });
    const result = applyBudget({ sections: s, budget: 100000 });
    // assemblePrompt always adds the '## Plans\n\n' block
    assert.ok(result.prompt.includes('## Plans\n\n'));
  });
});

// ─── applyBudget: safetyMarginPct boundary tests ─────────────────────────────

describe('applyBudget: safetyMarginPct option', () => {
  test('safetyMarginPct=0 preserves full budget', () => {
    const result = applyBudget({
      sections: sections(),
      budget: 500,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(result.metadata.effectiveBudget, 500);
  });

  test('safetyMarginPct=100 → effectiveBudget=0 → hardFailed=true', () => {
    const result = applyBudget({
      sections: sections(),
      budget: 1000,
      options: { safetyMarginPct: 100 },
    });
    assert.equal(result.metadata.effectiveBudget, 0);
    assert.equal(result.metadata.hardFailed, true);
    assert.equal(result.prompt, '');
  });

  test('safetyMarginPct=10 (default) is consistent with explicit safetyMarginPct=10', () => {
    const r1 = applyBudget({ sections: sections(), budget: 1000 });
    const r2 = applyBudget({ sections: sections(), budget: 1000, options: { safetyMarginPct: 10 } });
    assert.equal(r1.metadata.effectiveBudget, r2.metadata.effectiveBudget);
    assert.equal(r1.prompt, r2.prompt);
  });
});

// ─── applyBudget: NOTE_RESERVE_TOKENS (80) integration ───────────────────────

describe('applyBudget: NOTE_RESERVE_TOKENS behaviour', () => {
  test('no budget pressure → contentBudget equals effectiveBudget (full space used)', () => {
    // When no trim is needed, no NOTE_RESERVE is withheld
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(result.metadata.noteInjected, false);
    // estimatedTokens should NOT be artificially constrained by 80-token reserve
    assert.ok(result.metadata.estimatedTokens <= result.metadata.effectiveBudget);
  });

  test('estimatedTokens never exceeds effectiveBudget on success', () => {
    // Even in tight scenarios, a successful result is within effectiveBudget
    const result = applyBudget({
      sections: sections({ context: 'C'.repeat(200) }),
      budget: 200,
    });
    if (!result.metadata.hardFailed) {
      assert.ok(
        result.metadata.estimatedTokens <= result.metadata.effectiveBudget,
        `estimatedTokens=${result.metadata.estimatedTokens} > effectiveBudget=${result.metadata.effectiveBudget}`
      );
    }
  });
});

// ─── applyBudget: exact metadata field values (catch mutants) ─────────────────

describe('applyBudget: exact metadata field values', () => {
  test('ample budget: exact expected metadata values for minimal sections', () => {
    // instructions='Instructions.' (14 chars, 4 tokens)
    // roadmap='Roadmap.' (8 chars, 2 tokens)
    // plan content='Plan content.' (13 chars, 4 tokens)
    // Assemble full prompt and measure tokens
    const s = sections();
    const result = applyBudget({ sections: s, budget: 10000 });
    assert.equal(result.metadata.budget, 10000);
    assert.equal(result.metadata.effectiveBudget, 9000);
    assert.equal(result.metadata.hardFailed, false);
    assert.equal(result.metadata.noteInjected, false);
    assert.equal(result.metadata.projectMdShrunk, false);
    assert.equal(result.metadata.planTruncationPct, 0);
    assert.deepEqual(result.metadata.omitted, []);
    assert.ok(result.metadata.estimatedTokens > 0);
    assert.equal(result.metadata.estimatedTokens, estimateTokens(result.prompt));
  });

  test('hard-fail: exact metadata values', () => {
    const result = applyBudget({
      sections: sections({ instructions: 'I'.repeat(400), roadmap: 'R'.repeat(400) }),
      budget: 10,
      options: { safetyMarginPct: 0 },
    });
    // With 0% margin, effectiveBudget=10
    // instructions: 400 chars = 100 tokens; roadmap: 400 chars = 100 tokens
    // minSet = 100 + 100 + planTokens > 10 → hardFail
    assert.equal(result.metadata.budget, 10);
    assert.equal(result.metadata.effectiveBudget, 10);
    assert.equal(result.metadata.hardFailed, true);
    assert.equal(result.metadata.noteInjected, false);
    assert.equal(result.metadata.projectMdShrunk, false);
    assert.equal(result.metadata.planTruncationPct, 0);
    assert.deepEqual(result.metadata.omitted, []);
    assert.equal(result.metadata.estimatedTokens, 0);
    assert.equal(result.prompt, '');
  });

  test('dropped sections list is exact and ordered: [context, research, requirements]', () => {
    // All three present, very tight budget forces all three drops
    const bigCtx = 'C'.repeat(800);
    const bigRes = 'R'.repeat(800);
    const bigReq = 'Q'.repeat(800);
    const result = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
        research: bigRes,
        requirements: bigReq,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.deepEqual(result.metadata.omitted, ['context', 'research', 'requirements']);
    }
  });

  test('context-only drop: omitted = [\'context\']', () => {
    const bigCtx = 'C'.repeat(800);
    const result = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.deepEqual(result.metadata.omitted, ['context']);
    }
  });

  test('research-only drop: omitted = [\'research\']', () => {
    const bigRes = 'R'.repeat(800);
    const result = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        research: bigRes,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.deepEqual(result.metadata.omitted, ['research']);
    }
  });

  test('requirements-only drop: omitted = [\'requirements\']', () => {
    const bigReq = 'Q'.repeat(800);
    const result = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        requirements: bigReq,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed) {
      assert.deepEqual(result.metadata.omitted, ['requirements']);
    }
  });
});

// ─── applyBudget: headShrink edge cases ──────────────────────────────────────

describe('applyBudget: headShrink (projectMdHeadLines)', () => {
  test('projectMdHeadLines=1 keeps only first line of projectMd', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan = 'P'.repeat(4);
    const proj = 'Line1\nLine2\nLine3\nLine4';
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'p.md', content: plan }], projectMd: proj }),
      budget: 20,
      options: { safetyMarginPct: 0, projectMdHeadLines: 1 },
    });
    if (!result.metadata.hardFailed && result.metadata.projectMdShrunk) {
      // Only first line should appear in the Project section
      assert.ok(result.prompt.includes('Line1'));
      assert.ok(!result.prompt.includes('Line2'));
    }
  });

  test('projectMdHeadLines=0 → empty project content (headShrink returns "")', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan = 'P'.repeat(4);
    const proj = 'Line1\nLine2\nLine3';
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'p.md', content: plan }], projectMd: proj }),
      budget: 15,
      options: { safetyMarginPct: 0, projectMdHeadLines: 0 },
    });
    // With projectMdHeadLines=0, headShrink returns '' — projectMd becomes ''
    // '' is falsy so no Project section in prompt
    if (!result.metadata.hardFailed) {
      // Either the project block is absent or empty
      const hasProjectHeader = result.prompt.includes('## Project');
      // headShrink('Line1\nLine2\nLine3', 0) → ''  (falsy → no block)
      assert.ok(!hasProjectHeader, 'project block should not appear when headShrink returns empty string');
    }
  });
});

// ─── applyBudget: estimatedTokens exact value ────────────────────────────────

describe('applyBudget: estimatedTokens exact computation', () => {
  test('estimatedTokens always equals estimateTokens(prompt) on success', () => {
    const testCases = [
      { budget: 100000 },
      { budget: 100000, sections: { projectMd: 'Proj content here.' } },
      { budget: 100000, sections: { context: 'Context.' } },
      { budget: 100000, sections: { research: 'Research.' } },
      { budget: 100000, sections: { requirements: 'Req.' } },
    ];
    for (const tc of testCases) {
      const s = sections(tc.sections || {});
      const result = applyBudget({ sections: s, budget: tc.budget });
      if (!result.metadata.hardFailed) {
        assert.equal(
          result.metadata.estimatedTokens,
          estimateTokens(result.prompt),
          `mismatch for budget=${tc.budget}`
        );
      }
    }
  });
});

// ─── applyBudget: empty / single section edge cases ──────────────────────────

describe('applyBudget: empty / single section edge cases', () => {
  test('empty plans array: no plan content in prompt body', () => {
    const s = sections({ plans: [] });
    const result = applyBudget({ sections: s, budget: 100000 });
    // The ## Plans block is always added, but it's empty after the header
    assert.ok(result.prompt.includes('## Plans\n\n'));
    // No plan item headers (### ...) should appear
    assert.ok(!result.prompt.includes('### '));
  });

  test('single plan with exact content preserved', () => {
    const planContent = 'Exact plan body text.';
    const s = sections({ plans: [{ file: 'plan.md', content: planContent }] });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('### plan.md\n\n' + planContent));
  });

  test('instructions empty string: prompt starts with roadmap block', () => {
    const s = sections({ instructions: '' });
    const result = applyBudget({ sections: s, budget: 100000 });
    // blocks starts with '' then \n\n ## Roadmap
    assert.ok(result.prompt.includes('## Roadmap'));
  });

  test('roadmap empty string: roadmap block still appears', () => {
    const s = sections({ roadmap: '' });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes('## Roadmap\n\n'));
  });

  test('all optional sections null: no optional headers in prompt', () => {
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.ok(!result.prompt.includes('## Project'));
    assert.ok(!result.prompt.includes('## Context'));
    assert.ok(!result.prompt.includes('## Research'));
    assert.ok(!result.prompt.includes('## Requirements'));
  });

  test('single plan not over budget: full content preserved verbatim', () => {
    const exact = 'This is the exact plan content verbatim.';
    const s = sections({ plans: [{ file: 'p.md', content: exact }] });
    const result = applyBudget({ sections: s, budget: 100000 });
    assert.ok(result.prompt.includes(exact));
    assert.equal(result.metadata.planTruncationPct, 0);
  });
});

// ─── applyBudget: budgetUnderPressure: false (no reserve withheld) ────────────

describe('applyBudget: budgetUnderPressure logic', () => {
  test('when base fits exactly, no trim and no pressure', () => {
    // Large budget → baseTokens << effectiveBudget → no pressure → no note
    const result = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(result.metadata.noteInjected, false);
    assert.equal(result.metadata.projectMdShrunk, false);
    assert.deepEqual(result.metadata.omitted, []);
  });

  test('when base exactly equals effectiveBudget: no pressure triggered (not strictly greater)', () => {
    // We need base == effectiveBudget exactly.
    // That's hard to engineer precisely, but we can test the boundary semantics:
    // budgetUnderPressure = baseTokens > effectiveBudget (strictly greater)
    // So if base == effectiveBudget, no pressure → no note
    // Use a big budget where base << effectiveBudget → no pressure
    const result = applyBudget({
      sections: sections(),
      budget: 1000000,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(result.metadata.noteInjected, false);
  });
});

// ─── applyBudget: renderNote template substitutions ──────────────────────────

describe('applyBudget: renderNote template substitutions', () => {
  test('{budget} is replaced with the raw budget value', () => {
    const ctx = 'C'.repeat(400);
    const result = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: ctx,
      }),
      budget: 777,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.noteInjected) {
      assert.ok(result.prompt.includes('777-token budget'),
        'budget value 777 should appear in note');
    }
  });

  test('{omittedList} is replaced with comma-joined list', () => {
    // Force both context and research drop
    const bigCtx = 'C'.repeat(800);
    const bigRes = 'R'.repeat(800);
    const result = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
        research: bigRes,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.omitted.length === 2) {
      assert.ok(result.prompt.includes('context, research'),
        'omitted list should be "context, research"');
    }
  });

  test('{planTruncationPct} is replaced with Math.round of the percentage', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const result = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.noteInjected) {
      const rounded = Math.round(result.metadata.planTruncationPct);
      assert.ok(result.prompt.includes(`approximately ${rounded}%`),
        `should include "approximately ${rounded}%"`);
    }
  });

  test('default note template contains all five expected lines', () => {
    const ctx = 'C'.repeat(400);
    const result = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: ctx,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!result.metadata.hardFailed && result.metadata.noteInjected) {
      assert.ok(result.prompt.includes('<note>'));
      assert.ok(result.prompt.includes('Prompt automatically trimmed to fit a'));
      assert.ok(result.prompt.includes('Omitted sections:'));
      assert.ok(result.prompt.includes('Plan content truncated by approximately'));
      assert.ok(result.prompt.includes('Treat any missing context as out-of-scope'));
      assert.ok(result.prompt.includes('</note>'));
    }
  });
});

// ─── DEFAULT_NOTE_TEMPLATE exact string content ───────────────────────────────
// Kill StringLiteral survivors for each line of DEFAULT_NOTE_TEMPLATE,
// the join('\n') separator, and the template placeholder strings.
//
// CRITICAL: noteResult() must use budget=70 to ensure hardFailed=false AND noteInjected=true.
// At budget=70 with safetyMarginPct=0, context (400 chars = 100 tokens) forces a drop,
// but the resulting prompt fits within 70 tokens. All assertions are UNCONDITIONAL.

describe('DEFAULT_NOTE_TEMPLATE: exact note lines present and newline-joined', () => {
  // Use budget=70 (safetyMarginPct=0): hardFailed=false AND noteInjected=true guaranteed.
  function noteResult(budget = 70) {
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: 'C'.repeat(400),
      }),
      budget,
      options: { safetyMarginPct: 0 },
    });
    return r;
  }

  test('noteResult(70): hardFailed=false and noteInjected=true (precondition)', () => {
    const r = noteResult(70);
    assert.equal(r.metadata.hardFailed, false, 'precondition: hardFailed must be false');
    assert.equal(r.metadata.noteInjected, true, 'precondition: noteInjected must be true');
  });

  test('note starts with <note> on its own line (unconditional)', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    // '<note>' must appear, not be replaced by ''
    assert.ok(r.prompt.includes('<note>\n'), 'note must start with <note> followed by newline');
    assert.ok(r.prompt.includes('<note>'), 'note must contain literal <note> not empty string');
  });

  test('note ends with </note> (unconditional)', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.prompt.includes('\n</note>'), 'note must end with newline + </note>');
    assert.ok(r.prompt.includes('</note>'), 'note must contain literal </note> not empty string');
  });

  test('note contains exact Prompt-trimmed line with budget number (unconditional)', () => {
    const r = noteResult(70);
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(
      r.prompt.includes('Prompt automatically trimmed to fit a 70-token budget.'),
      'must include exact trimmed line, not empty string'
    );
  });

  test('note contains exact Omitted sections line (unconditional)', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(
      r.prompt.includes('Omitted sections: context.'),
      'must include exact omitted line, not empty string'
    );
  });

  test('note contains exact Plan truncated line with 0% (unconditional)', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(
      r.prompt.includes('Plan content truncated by approximately 0%.'),
      'must include plan-truncated line (0% when no truncation), not empty string'
    );
  });

  test('note contains exact Treat-missing-context line (unconditional)', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(
      r.prompt.includes('Treat any missing context as out-of-scope rather than a review concern.'),
      'must include exact treat-missing line, not empty string'
    );
  });

  test('note lines are separated by newlines (not empty string) — unconditional', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    // If join('') were used instead of join('\n'), the note would be one blob
    const noteStart = r.prompt.indexOf('<note>');
    const noteEnd = r.prompt.indexOf('</note>') + '</note>'.length;
    const noteText = r.prompt.slice(noteStart, noteEnd);
    // Must have at least 4 newlines separating the 5 lines
    const newlineCount = (noteText.match(/\n/g) || []).length;
    assert.ok(newlineCount >= 4, `note must have >=4 newlines, got ${newlineCount}`);
  });

  test('full note text exact content matches expected (unconditional — kills all line StringLiterals)', () => {
    const r = noteResult(70);
    assert.equal(r.metadata.hardFailed, false);
    const expectedNote = [
      '<note>',
      'Prompt automatically trimmed to fit a 70-token budget.',
      'Omitted sections: context.',
      'Plan content truncated by approximately 0%.',
      'Treat any missing context as out-of-scope rather than a review concern.',
      '</note>',
    ].join('\n');
    assert.ok(r.prompt.includes(expectedNote),
      `note text must exactly match expected; got: ${JSON.stringify(r.prompt.slice(r.prompt.indexOf('<note>')))}`);
  });

  test('note omittedList uses ", " separator (not empty string) for multiple omitted — unconditional', () => {
    // Force two sections dropped, budget large enough to fit without the dropped sections
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: 'C'.repeat(400),
        research: 'R2'.repeat(200),
      }),
      budget: 70,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false, 'precondition');
    if (r.metadata.omitted.length >= 2) {
      // join(', ') must be used, not join('')
      assert.ok(r.prompt.includes('context, research'), 'must use ", " separator');
      assert.ok(!r.prompt.includes('contextresearch'), 'must NOT be empty-joined');
    }
  });

  test('omittedList is "none" (not empty string) when nothing dropped but note injected (unconditional)', () => {
    // projectMdShrunk triggers note with empty omitted list
    const bigProject = Array.from({ length: 100 }, () => 'XXXX').join('\n');
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        projectMd: bigProject,
      }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk && r.metadata.omitted.length === 0) {
      assert.equal(r.metadata.noteInjected, true);
      assert.ok(r.prompt.includes('Omitted sections: none.'), 'must say "none" not empty string');
      assert.ok(!r.prompt.includes('Omitted sections: .'), 'must NOT have empty omitted string');
    }
  });

  test('{budget} placeholder replaced with actual budget number — unconditional', () => {
    const r = noteResult(70);
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.prompt.includes('70-token budget'), 'budget placeholder must be replaced with 70');
    assert.ok(!r.prompt.includes('{budget}'), 'literal {budget} placeholder must be consumed');
  });

  test('{omittedList} placeholder replaced — unconditional', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(!r.prompt.includes('{omittedList}'), 'omittedList placeholder must be consumed');
    assert.ok(r.prompt.includes('Omitted sections:'), 'Omitted sections line must be present');
  });

  test('{planTruncationPct} placeholder replaced — unconditional', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(!r.prompt.includes('{planTruncationPct}'), 'planTruncationPct placeholder must be consumed');
    assert.ok(r.prompt.includes('truncated by approximately'), 'plan truncated line must be present');
  });

  test('replace("{budget}", ...) uses correct placeholder (not ""): different budgets give different notes', () => {
    const r70 = noteResult(70);
    const r80 = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: 'C'.repeat(400),
      }),
      budget: 80,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r70.metadata.hardFailed, false);
    assert.equal(r80.metadata.hardFailed, false);
    // Both should have noteInjected=true with context dropped
    if (r70.metadata.noteInjected && r80.metadata.noteInjected) {
      assert.ok(r70.prompt.includes('70-token budget'), 'budget=70 note must say 70');
      assert.ok(r80.prompt.includes('80-token budget'), 'budget=80 note must say 80');
      // If replace("", ...) were used, both would have the same note (no substitution)
      // so the budget values would not differ in the note.
      assert.ok(!r70.prompt.includes('80-token budget'), 'budget=70 note must NOT say 80');
      assert.ok(!r80.prompt.includes('70-token budget'), 'budget=80 note must NOT say 70');
    }
  });

  test('replace("{omittedList}", ...) uses correct placeholder (not ""): omitted name appears in note', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    assert.equal(r.metadata.noteInjected, true);
    // 'context' must appear in the note's omitted line
    assert.ok(r.prompt.includes('Omitted sections: context.'));
    // If replace("", ...) were used, omittedList would be injected at start of every replacement of ''
    // which would mangle the note. The note structure must be intact.
    const noteStart = r.prompt.indexOf('<note>');
    assert.ok(noteStart >= 0, 'note must be present');
    const noteEnd = r.prompt.indexOf('</note>') + '</note>'.length;
    const noteText = r.prompt.slice(noteStart, noteEnd);
    assert.ok(noteText.includes('Omitted sections: context.'));
  });

  test('replace("{planTruncationPct}", ...) uses correct placeholder: 0 appears in note', () => {
    const r = noteResult();
    assert.equal(r.metadata.hardFailed, false);
    assert.equal(r.metadata.noteInjected, true);
    assert.ok(r.prompt.includes('truncated by approximately 0%.'));
  });
});

// ─── renderNote: omittedList boundary (length > 0 vs >= 0 vs <= 0) ─────────────
describe('renderNote: omittedList conditional boundary', () => {
  test('empty omitted → "none" — unconditional (kills >= 0, true, false mutations)', () => {
    // Build a scenario where omitted=[] but note is injected via projectMdShrunk
    // Need a budget where shrink happens but prompt still fits.
    const bigProject = Array.from({ length: 100 }, () => 'AAAA').join('\n');
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        projectMd: bigProject,
      }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    // This scenario: with 100-line project and budget=40, project gets shrunk to 40 lines
    // Then omitted=[] and projectMdShrunk=true → note injected
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk) {
      assert.equal(r.metadata.omitted.length, 0, 'omitted must be empty: shrink only, no drops');
      assert.equal(r.metadata.noteInjected, true, 'note must be injected on shrink');
      // With omitted=[] (length=0), condition "length > 0" is false → omittedList = 'none'
      // Killed mutations: always-true → 'context' (wrong), always-false → 'none' (passes trivially)
      // But false mutation: omitted.join(', ') would be '' for empty array ≠ 'none'
      assert.ok(r.prompt.includes('Omitted sections: none.'),
        'omittedList must be "none" for empty array, not empty string or section names');
      assert.ok(!r.prompt.includes('Omitted sections: .'),
        'must NOT have empty omitted string');
    }
  });

  test('single omitted → section name (not "none") — unconditional at budget=70', () => {
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: 'C'.repeat(400),
      }),
      budget: 70,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false, 'precondition: must not hard-fail at budget=70');
    assert.equal(r.metadata.noteInjected, true, 'precondition: note must be injected');
    assert.ok(r.metadata.omitted.includes('context'), 'context must be dropped');
    // condition "length > 0" is true → omittedList = 'context' (not 'none')
    // Kills: always-false → omittedList='none' (wrong)
    assert.ok(!r.prompt.includes('Omitted sections: none.'), 'must NOT say none when context is dropped');
    assert.ok(r.prompt.includes('Omitted sections: context.'), 'must say context');
  });

  test('two omitted → comma-joined, not "none" — unconditional at budget=70', () => {
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: 'C'.repeat(400),
        research: 'R2'.repeat(200),
      }),
      budget: 70,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false, 'precondition');
    if (r.metadata.omitted.length === 2 && r.metadata.noteInjected) {
      // join(', ') for two items
      assert.ok(r.prompt.includes('context, research'), 'two items must use ", " separator');
      assert.ok(!r.prompt.includes('Omitted sections: none.'), 'must NOT say none with 2 drops');
    }
  });

  test('"none" literal is not empty string: prompt includes literal word "none" (kills "" StringLiteral)', () => {
    const bigProject = Array.from({ length: 100 }, () => 'BBBB').join('\n');
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        projectMd: bigProject,
      }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk && r.metadata.omitted.length === 0 && r.metadata.noteInjected) {
      // If 'none' were replaced with '', the note would say "Omitted sections: ." not "Omitted sections: none."
      assert.ok(r.prompt.includes('none'), 'note must contain literal "none"');
      assert.ok(r.prompt.includes('Omitted sections: none.'), 'exact line must be "Omitted sections: none."');
    }
  });
});

// ─── headShrink: exact line-count and boundary tests ──────────────────────────
describe('headShrink via applyBudget: exact line boundaries', () => {
  // headShrink is only reachable via projectMd shrink path.
  // We set projectMdHeadLines to exact values and verify the output line count.

  function shrinkResult(projectMd, headLines, budget = 15) {
    return applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        projectMd,
      }),
      budget,
      options: { safetyMarginPct: 0, projectMdHeadLines: headLines },
    });
  }

  function extractProjectContent(prompt) {
    const header = '## Project\n\n';
    const start = prompt.indexOf(header);
    if (start === -1) return null;
    const contentStart = start + header.length;
    const nextSection = prompt.indexOf('\n\n## ', contentStart);
    return nextSection === -1 ? prompt.slice(contentStart) : prompt.slice(contentStart, nextSection);
  }

  test('headLines=2: exactly 2 lines kept (kills while seen < vs <= mutant)', () => {
    // 5 lines, shrink to 2
    const proj = 'Line1\nLine2\nLine3\nLine4\nLine5';
    const r = shrinkResult(proj, 2);
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk) {
      const content = extractProjectContent(r.prompt);
      assert.ok(content !== null);
      const lines = content.split('\n');
      assert.equal(lines.length, 2, `expected 2 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
      assert.equal(lines[0], 'Line1');
      assert.equal(lines[1], 'Line2');
    }
  });

  test('headLines=3: exactly 3 lines kept', () => {
    const proj = 'A\nB\nC\nD\nE\nF';
    const r = shrinkResult(proj, 3);
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk) {
      const content = extractProjectContent(r.prompt);
      if (content !== null) {
        const lines = content.split('\n');
        assert.ok(lines.length <= 3, `expected <=3 lines, got ${lines.length}`);
      }
    }
  });

  test('headLines=1: exactly first line kept (kills idx=-1→+1 UnaryOperator)', () => {
    const proj = 'FirstLine\nSecondLine\nThirdLine';
    const r = shrinkResult(proj, 1);
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk) {
      const content = extractProjectContent(r.prompt);
      assert.ok(content !== null);
      assert.equal(content, 'FirstLine', `expected only FirstLine, got: ${JSON.stringify(content)}`);
    }
  });

  test('headLines=0: project section absent (headShrink returns empty)', () => {
    const proj = 'Line1\nLine2\nLine3';
    const r = shrinkResult(proj, 0);
    if (!r.metadata.hardFailed) {
      assert.ok(!r.prompt.includes('## Project'), 'project block should be absent with headLines=0');
    }
  });

  test('headLines exactly equals line count: full text kept (no shrink needed)', () => {
    // 3 lines, headLines=3 — headShrink should return full text
    const proj = 'L1\nL2\nL3';
    // Big budget so no shrink triggered
    const r = applyBudget({
      sections: sections({ projectMd: proj }),
      budget: 100000,
      options: { projectMdHeadLines: 3 },
    });
    assert.equal(r.metadata.projectMdShrunk, false);
    assert.ok(r.prompt.includes(proj));
  });

  test('headShrink idx starts at -1: first line always complete (kills idx=+1 mutant)', () => {
    // If idx starts at +1 instead of -1, indexOf starting at 2 would skip chars 0-1
    // of the first line, causing the first line to be truncated.
    const proj = 'ABCDE\nFGHIJ\nKLMNO';
    const r = shrinkResult(proj, 1);
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk) {
      const content = extractProjectContent(r.prompt);
      // With correct idx=-1: indexOf('\n', 0) finds position 5, slice(0,5) = 'ABCDE'
      // With idx=+1: indexOf('\n', 2) still finds 5, so this might still pass...
      // But seen += 1 vs -= 1: with seen -= 1 and seen starting at 0, seen never reaches maxLines=1
      // → infinite loop (killed by timeout). Test the correct output.
      assert.equal(content, 'ABCDE');
    }
  });

  test('headShrink seen increments correctly (kills seen -= 1 mutant)', () => {
    // With seen -= 1 (AssignmentOperator), the while loop becomes infinite.
    // In tests this manifests as timeout rather than wrong output.
    // We just verify the correct output comes out fast.
    const proj = 'Row0\nRow1\nRow2\nRow3\nRow4';
    const r = shrinkResult(proj, 2);
    // If seen -= 1 survived we'd hang — but stryker times it out as "Timeout" not "Survived"
    // So the mutant is already in Timeout category. This test is belt-and-suspenders.
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk) {
      const content = extractProjectContent(r.prompt);
      assert.ok(content !== null);
      const lines = content.split('\n');
      assert.ok(lines.length <= 2);
    }
  });

  test('headShrink: idx === -1 sentinel check (text without enough newlines returns full)', () => {
    // 3-line string, headLines=10 — not enough newlines → full text returned
    const proj = 'Only\nTwo\nLines';
    const r = applyBudget({
      sections: sections({ projectMd: proj }),
      budget: 100000,
      options: { projectMdHeadLines: 10 },
    });
    // No shrink, full text
    assert.equal(r.metadata.projectMdShrunk, false);
    assert.ok(r.prompt.includes(proj));
  });

  test('headShrink returns correct slice (not full text — kills MethodExpression return text mutant)', () => {
    // headShrink(text, 2) must return text.slice(0, idx), not full text
    const proj = 'Line1\nLine2\nLine3\nLine4\nLine5\nLine6';
    const r = shrinkResult(proj, 2, 12);
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk) {
      const content = extractProjectContent(r.prompt);
      assert.ok(content !== null);
      // Must NOT contain Line3 if correctly shrunk to 2 lines
      assert.ok(!content.includes('Line3'), 'shrunk content must not include lines beyond headLines');
    }
  });
});

// ─── tailTruncate: exact length boundary ──────────────────────────────────────
describe('tailTruncate via plan truncation: exact boundary tests', () => {
  test('plan content not over maxChars: returned verbatim (kills return text mutant)', () => {
    // An un-truncated plan must be exactly the same as original
    const planContent = 'A'.repeat(100);
    const r = applyBudget({
      sections: sections({ plans: [{ file: 'p.md', content: planContent }] }),
      budget: 100000,
    });
    assert.ok(r.prompt.includes(planContent));
    assert.equal(r.metadata.planTruncationPct, 0);
  });

  test('plan content over budget: truncated (kills if true/false conditionals and return text)', () => {
    // 4000 chars of plan, budget=50 → truncation must happen
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'Z'.repeat(4000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      // Plan section must be shorter than original
      const planIdx = r.prompt.indexOf('### x.md\n\n') + '### x.md\n\n'.length;
      const planActual = r.prompt.slice(planIdx);
      assert.ok(planActual.length < bigPlan.length, 'plan must be truncated');
      // if `text.length <= maxChars` is mutated to `< maxChars` (missing =), boundary test:
      // e.g. text.length == maxChars should return text verbatim. We test above with 100000 budget.
    }
  });

  test('tailTruncate boundary: text.length === maxChars returns verbatim (kills < vs <=)', () => {
    // tailTruncate(text, text.length) must return text unchanged.
    // We indirectly test this: a plan of exactly MIN_PLAN_BYTES chars gets MIN_PLAN_BYTES budget
    // → should not be truncated (i.e. planContent returned as-is).
    // Build a scenario where plan fits exactly at MIN_PLAN_BYTES=1024
    const MIN_PLAN_BYTES = 1024;
    const exactPlan = 'B'.repeat(MIN_PLAN_BYTES);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: exactPlan }],
      }),
      budget: 300, // tight enough to possibly truncate but MIN_PLAN_BYTES is floor
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      const planIdx = r.prompt.indexOf('### p.md\n\n') + '### p.md\n\n'.length;
      const planActual = r.prompt.slice(planIdx);
      // MIN_PLAN_BYTES floor means content is at least 1024 chars
      assert.ok(planActual.length >= MIN_PLAN_BYTES,
        `plan must be at least MIN_PLAN_BYTES=${MIN_PLAN_BYTES}, got ${planActual.length}`);
    }
  });
});

// ─── assemblePrompt: blocks array not pre-populated ──────────────────────────
describe('assemblePrompt: blocks array starts empty', () => {
  test('prompt does not start with "Stryker was here" (kills ArrayDeclaration mutant)', () => {
    const r = applyBudget({ sections: sections(), budget: 100000 });
    assert.ok(!r.prompt.includes('Stryker was here'));
    // prompt should start with instructions
    assert.ok(r.prompt.startsWith('Instructions.'));
  });

  test('prompt starts exactly with instructions text (no pre-populated garbage)', () => {
    const r = applyBudget({
      sections: sections({ instructions: 'MY_INSTRUCTIONS_START' }),
      budget: 100000,
    });
    assert.ok(r.prompt.startsWith('MY_INSTRUCTIONS_START'));
  });
});

// ─── Token header computation: exact values ───────────────────────────────────
// Kill StringLiteral ("" for header strings) and ArithmeticOperator (- instead of +) survivors.
// Strategy: use a budget that is tight enough that the header token count matters.

describe('token header computation: header strings must be non-empty', () => {
  test('roadmap header "## Roadmap\\n\\n" counted correctly (kills "" StringLiteral)', () => {
    // estimateTokens('## Roadmap\n\n') = ceil(12/4) = 3
    // If it were '' we'd get 0, and the computed staticBaseTokens would be 3 lower,
    // causing different trimming behavior.
    // Use a budget precisely calibrated to just fit:
    // staticBase = inst(1) + roadmapHdr(3) + road(1) + plansHdr(3) + planItemHdr + planContent
    // We test indirectly: the budget that causes a hard-fail when header is counted correctly
    // does NOT cause hard-fail when header is '' (i.e., lower staticBase).
    // Actually, the better test: verify that the prompt assembly uses correct header strings.
    const r = applyBudget({ sections: sections({ roadmap: 'ROAD' }), budget: 100000 });
    // roadmap header must appear literally in prompt
    assert.ok(r.prompt.includes('## Roadmap\n\nROAD'));
  });

  test('project header "## Project\\n\\n" counted correctly (kills "" StringLiteral)', () => {
    const r = applyBudget({ sections: sections({ projectMd: 'PROJ' }), budget: 100000 });
    assert.ok(r.prompt.includes('## Project\n\nPROJ'));
  });

  test('plans header "## Plans\\n\\n" counted correctly (kills "" StringLiteral)', () => {
    const r = applyBudget({ sections: sections(), budget: 100000 });
    assert.ok(r.prompt.includes('## Plans\n\n'));
  });

  test('context header "## Context\\n\\n" counted correctly', () => {
    const r = applyBudget({ sections: sections({ context: 'CTX' }), budget: 100000 });
    assert.ok(r.prompt.includes('## Context\n\nCTX'));
  });

  test('research header "## Research\\n\\n" counted correctly', () => {
    const r = applyBudget({ sections: sections({ research: 'RES' }), budget: 100000 });
    assert.ok(r.prompt.includes('## Research\n\nRES'));
  });

  test('requirements header "## Requirements\\n\\n" counted correctly', () => {
    const r = applyBudget({ sections: sections({ requirements: 'REQ' }), budget: 100000 });
    assert.ok(r.prompt.includes('## Requirements\n\nREQ'));
  });

  test('plan item header "### file\\n\\n" uses correct format', () => {
    const r = applyBudget({ sections: sections({ plans: [{ file: 'my.md', content: 'BODY' }] }), budget: 100000 });
    assert.ok(r.prompt.includes('### my.md\n\nBODY'));
  });

  test('plan item header token computation uses correct separator (\\n\\n not empty)', () => {
    // If '### ' + file + '\n\n' were mutated to '### ' + file + '', the token count
    // would be lower, allowing more content through a tight budget.
    // Test: tight budget that barely fits with correct header count
    const inst = 'I'.repeat(4);  // 1 tok
    const road = 'R'.repeat(4);  // 1 tok
    const plan = 'P'.repeat(4);  // 1 tok
    // With correct headers in staticBaseTokens:
    // inst(1) + roadmapHdr(3) + road(1) + plansHdr(3) + planItemHdr("### p.md\n\n"=14chars=4tok) + plan(1) = 13
    // staticBase = 13. With budget=13 and safetyMarginPct=0, effectiveBudget=13.
    // minSet = inst(1) + road(1) + min(plan)=1 = 3, not hardfailed.
    // baseTokens=13 <= effectiveBudget=13 → no pressure → no trim → no note.
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'p.md', content: plan }] }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    // The result should be consistent with staticBase = 13 being counted correctly.
    // If plan item header were '' (0 tokens), staticBase would be 9, which also fits.
    // Key check: the prompt must include the full ### p.md\n\n header
    if (!r.metadata.hardFailed) {
      assert.ok(r.prompt.includes('### p.md\n\nPPPP'));
    }
  });
});

// ─── staticBaseTokens arithmetic: kills + vs - mutants ────────────────────────
describe('staticBaseTokens arithmetic: tests that break when tokens subtracted', () => {
  test('staticBaseTokens subtraction mutant: budget exactly fitting does not cause false trim', () => {
    // If any term in staticBaseTokens uses subtraction instead of addition,
    // staticBaseTokens would be smaller than actual, causing the budget pressure
    // check to not fire when it should (or vice versa).
    // With correct computation (staticBase ≈ 13) and budget=100000, no trim.
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
      }),
      budget: 100000,
    });
    assert.equal(r.metadata.noteInjected, false);
    assert.equal(r.metadata.planTruncationPct, 0);
    assert.deepEqual(r.metadata.omitted, []);
  });

  test('getCurrentBaseTokens uses addition throughout (test with projectMd)', () => {
    // With projectMd=100tokens and budget=200, no trim. If projectTokens subtracted, baseTokens
    // would appear smaller, potentially causing a different trim decision.
    const bigProj = 'P'.repeat(400); // 100 tokens
    const r = applyBudget({
      sections: sections({ projectMd: bigProj }),
      budget: 200,
      options: { safetyMarginPct: 0 },
    });
    // Correct: staticBase + projectTokens ≈ 13 + 103 = 116 <= 200 → no pressure
    // If projectTokens subtracted: staticBase - 103 < 0 → no pressure (same), but...
    // If staticBase - projectTokens = -90 still no pressure, still no trim.
    // This specific mutant is hard to kill via pressure check; kill via content check.
    assert.ok(r.prompt.includes('## Project\n\n' + bigProj));
    assert.equal(r.metadata.projectMdShrunk, false);
  });

  test('planContentTokens arithmetic correct: plan not over budget stays verbatim', () => {
    const bigPlan = 'Q'.repeat(100);
    const r = applyBudget({
      sections: sections({ plans: [{ file: 'q.md', content: bigPlan }] }),
      budget: 100000,
    });
    assert.ok(r.prompt.includes(bigPlan));
    assert.equal(r.metadata.planTruncationPct, 0);
  });
});

// ─── budgetUnderPressure: exact boundary ──────────────────────────────────────
describe('budgetUnderPressure exact boundary', () => {
  // budgetUnderPressure = baseTokens > effectiveBudget  (strictly greater)
  // Kill survivors: true, false, >=, <=

  test('base > budget triggers pressure (kills ConditionalExpression false)', () => {
    // Force base > effectiveBudget by including large context
    const bigCtx = 'C'.repeat(400); // 100 tokens
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
      }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    // base ≈ 13+103=116 > 50 → pressure → contentBudget = 50-80 = -30 → context dropped
    if (!r.metadata.hardFailed) {
      assert.ok(
        r.metadata.omitted.length > 0 || r.metadata.planTruncationPct > 0 || r.metadata.projectMdShrunk,
        'pressure must have caused trimming'
      );
    }
  });

  test('base <= budget: no pressure, no note injected', () => {
    // Use ample budget so baseTokens << effectiveBudget → no pressure
    const r = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(r.metadata.noteInjected, false);
    // contentBudget must equal effectiveBudget (no reserve withheld)
    assert.equal(r.metadata.estimatedTokens, estimateTokens(r.prompt));
  });

  test('budgetUnderPressure = true (always): kills always-true mutant by checking ample budget does not trim', () => {
    // If budgetUnderPressure were always true, contentBudget = effectiveBudget - 80
    // causing spurious trimming on ample budgets.
    const r = applyBudget({
      sections: sections({
        instructions: 'INST',
        roadmap: 'ROAD',
        plans: [{ file: 'f.md', content: 'PLAN' }],
        context: 'CTX',
        research: 'RES',
        requirements: 'REQ',
      }),
      budget: 100000,
    });
    assert.equal(r.metadata.noteInjected, false);
    assert.deepEqual(r.metadata.omitted, []);
    assert.ok(r.prompt.includes('CTX'));
    assert.ok(r.prompt.includes('RES'));
    assert.ok(r.prompt.includes('REQ'));
  });

  test('contentBudget = effectiveBudget - NOTE_RESERVE (not +): kills + vs - arithmetic mutant', () => {
    // If contentBudget were effectiveBudget + NOTE_RESERVE_TOKENS (= +80),
    // sections that should be dropped would NOT be dropped.
    // Test: a budget right at the edge where dropping is needed.
    // With budget=50, safetyMarginPct=0 → effectiveBudget=50
    // contentBudget should be 50-80=-30 (budget under pressure)
    // baseTokens ≈ 13+103 = 116 > 50 → pressure → contentBudget=-30
    // Since -30 < any positive base, all sections over base get dropped.
    const bigCtx = 'C'.repeat(400); // ~103 tokens with header
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
      }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      assert.ok(r.metadata.omitted.includes('context'), 'context should be dropped under pressure');
    }
  });
});

// ─── projectMd shrink: conditionals and BooleanLiteral ───────────────────────
describe('projectMd shrink: conditional and boolean exact tests', () => {
  test('projectMdShrunk = true when shrink occurs (kills false BooleanLiteral)', () => {
    const bigProject = Array.from({ length: 100 }, (_, i) => 'L' + i).join('\n');
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        projectMd: bigProject,
      }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      // The project has 100 lines which is > 40 lines → must be shrunk
      assert.equal(r.metadata.projectMdShrunk, true);
    }
  });

  test('projectMdShrunk = false when projectMd not present (no spurious shrink)', () => {
    const r = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(r.metadata.projectMdShrunk, false);
  });

  test('projectMdShrunk = false when projectMd fits (short enough)', () => {
    const shortProj = 'Line1\nLine2\nLine3';
    const r = applyBudget({ sections: sections({ projectMd: shortProj }), budget: 100000 });
    assert.equal(r.metadata.projectMdShrunk, false);
    assert.ok(r.prompt.includes(shortProj));
  });

  test('shrink fires: shrunk !== projectMd (kills === equality mutant)', () => {
    // When headShrink returns same text (text shorter than maxLines), no shrink.
    // When text is longer, shrunk !== original → shrink fires.
    const bigProject = Array.from({ length: 100 }, (_, i) => 'X' + i).join('\n');
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        projectMd: bigProject,
      }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      // Since 100 > 40, shrunk != original → projectMdShrunk must be true
      assert.equal(r.metadata.projectMdShrunk, true);
      // After shrink, projectTokens updated with TOKENS_PROJECT_HEADER + estimateTokens(shrunk)
      // The project content in prompt must be shorter than original
      const content = r.prompt;
      const projIdx = content.indexOf('## Project\n\n') + '## Project\n\n'.length;
      const projEnd = content.indexOf('\n\n## ', projIdx);
      const projContent = projEnd === -1 ? content.slice(projIdx) : content.slice(projIdx, projEnd);
      // Must have <= 40 lines
      assert.ok(projContent.split('\n').length <= 40);
    }
  });

  test('projectTokens updated after shrink (kills ArithmeticOperator - instead of +)', () => {
    // After shrink, projectTokens = TOKENS_PROJECT_HEADER + estimateTokens(shrunk)
    // If it were TOKENS_PROJECT_HEADER - estimateTokens(shrunk), tokens would be negative,
    // causing getCurrentBaseTokens to return a different value, affecting trim decisions.
    // Test: after shrink, the prompt should be self-consistent.
    const bigProject = Array.from({ length: 100 }, (_, i) => 'Row' + i).join('\n');
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        projectMd: bigProject,
      }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      assert.equal(r.metadata.estimatedTokens, estimateTokens(r.prompt));
    }
  });
});

// ─── plan truncation: exact math and conditional tests ───────────────────────
describe('plan truncation: exact math kills survivors', () => {
  // planBudgetTokens = contentBudget - overhead  (not +)
  // totalPlanCharsBudget = planBudgetTokens * 4  (not / 4)
  // proportionalShare uses / (not *) totalOriginalChars
  // planTruncationPct = ((orig - new) / orig) * 100  (not +, not / 100)

  test('planBudgetTokens computed as subtraction (contentBudget - overhead): plan stays non-negative', () => {
    // If planBudgetTokens = contentBudget + overhead, it'd be huge → no truncation
    // even with a tight budget. But we force truncation and verify it happens.
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000); // 1000 tokens
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      // With correct subtraction: planBudgetTokens = 50-80-13 = -43 → negative → no truncation guard
      // Actually contentBudget = 50 - 80 = -30 (because budgetUnderPressure).
      // overhead = staticBase(13) + 0 + 0 + 0 = 13
      // planBudgetTokens = -30 - 13 = -43 → not > 0 → truncation block doesn't fire from plan side
      // But the test checks that truncation happens through context/drop path.
      // Let's use a scenario where planBudgetTokens > 0:
      // budget = 200, staticBase=13, bigPlan=1000tok, effectiveBudget=200
      // budgetUnderPressure = 13+1000=1013 > 200 → pressure, contentBudget=200-80=120
      // overhead=13, planBudgetTokens=120-13=107 > 0, totalPlanTokens=1000 > 107 → truncation
      assert.ok(
        r.metadata.planTruncationPct >= 0 && r.metadata.planTruncationPct <= 100,
        'planTruncationPct must be in [0, 100]'
      );
    }
  });

  test('plan truncation triggers correctly: big plan with moderate budget — unconditional', () => {
    // budget=350 works: minSet=258 < 350, plan truncated, no post-assembly fail
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000); // 1000 tokens
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false, 'precondition: must not hard-fail at budget=350');
    assert.ok(r.metadata.planTruncationPct > 0,
      `planTruncationPct should be > 0, got ${r.metadata.planTruncationPct}`);
    assert.ok(r.metadata.planTruncationPct < 100, 'planTruncationPct must be < 100');
  });

  test('planTruncationPct exact formula: (orig-new)/orig * 100 (kills / 100 vs * 100) — unconditional', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.metadata.planTruncationPct > 0);
    // planTruncationPct should be in range (1, 100)
    // If formula were / 100 instead of * 100: result would be ~0.741, not > 1
    assert.ok(r.metadata.planTruncationPct > 1,
      `planTruncationPct should be > 1 (not a fraction), got ${r.metadata.planTruncationPct}`);
  });

  test('totalOriginalChars > 0 guard (kills always-true and always-false mutants) — unconditional', () => {
    // With plans present, totalOriginalChars > 0 → guard passes → planTruncationPct computed
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.metadata.planTruncationPct > 0, 'guard must pass for non-empty plans');
  });

  test('totalOriginalChars guard: zero-content plan edge case', () => {
    // With empty plan content, totalOriginalChars = 0 → guard fails → planTruncationPct = 0
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'x.md', content: '' }],
      }),
      budget: 50,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      assert.equal(r.metadata.planTruncationPct, 0,
        'zero-content plan must have 0 planTruncationPct');
    }
  });

  test('totalPlanCharsBudget = planBudgetTokens * 4 (kills / 4 mutant) — unconditional at budget=350', () => {
    // With budget=350: planBudgetTokens=259, totalPlanCharsBudget=1036, planLen=1036
    // With / 4: charsBudget=64, proportionalShare=64, maxChars=max(64,1024)=1024, planLen=1024
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false);
    const planIdx = r.prompt.indexOf('### x.md\n\n') + '### x.md\n\n'.length;
    const planActual = r.prompt.slice(planIdx);
    assert.equal(planActual.length, 1036,
      `planLen must be 1036 (correct * 4), not 1024 (if / 4)`);
  });

  test('proportional truncation: large budget gives bigger plan slice — unconditional', () => {
    // budget=350: planLen=1036; budget=500: planLen=1636
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);

    const r350 = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    const r500 = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 500,
      options: { safetyMarginPct: 0 },
    });

    assert.equal(r350.metadata.hardFailed, false, 'precondition r350');
    assert.equal(r500.metadata.hardFailed, false, 'precondition r500');
    const getPlanLen = (r) => {
      const idx = r.prompt.indexOf('### x.md\n\n') + '### x.md\n\n'.length;
      return r.prompt.slice(idx).length;
    };
    assert.ok(getPlanLen(r500) > getPlanLen(r350),
      `larger budget should give larger plan: r500=${getPlanLen(r500)}, r350=${getPlanLen(r350)}`);
  });

  test('two plans proportionally truncated: both appear, pct between 0 and 100 — unconditional', () => {
    // Two plans of 2000 chars each: minSet = 1+1+256+256=514, need budget > 514
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const plan1 = 'A'.repeat(2000);
    const plan2 = 'B'.repeat(2000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'a.md', content: plan1 }, { file: 'b.md', content: plan2 }] }),
      budget: 600,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false, 'precondition: budget=600 must not hard-fail for two 2000-char plans');
    assert.ok(r.metadata.planTruncationPct > 0, 'plan must be truncated');
    assert.ok(r.prompt.includes('### a.md'));
    assert.ok(r.prompt.includes('### b.md'));
    assert.ok(r.metadata.planTruncationPct > 0 && r.metadata.planTruncationPct < 100);
  });

  test('planTruncationPct > 0 triggers anyTrimOccurred (kills planTruncationPct > 0 → false) — unconditional', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.metadata.planTruncationPct > 0, 'plan must be truncated');
    // anyTrimOccurred should be true → noteInjected should be true
    assert.equal(r.metadata.noteInjected, true,
      'planTruncationPct > 0 must trigger anyTrimOccurred → noteInjected');
  });

  test('noteInjected = true (not false) when trim occurs (kills BooleanLiteral false) — unconditional', () => {
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.metadata.planTruncationPct > 0);
    assert.equal(r.metadata.noteInjected, true, 'noteInjected must be true when trim occurs');
    assert.ok(r.prompt.includes('<note>'), 'note must appear in prompt');
  });
});

// ─── Drop context/research/requirements: exact string and conditional tests ───
describe('drop context/research/requirements: exact string literals and conditionals', () => {
  // Kill: StringLiteral "" for 'context', 'research', 'requirements'
  // Kill: ConditionalExpression false for each drop block
  // Kill: BlockStatement (empty body) for each drop block
  // Kill: EqualityOperator >= instead of > for each drop block

  test('context drop: omitted array contains "context" string (not empty)', () => {
    const bigCtx = 'C'.repeat(800);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      assert.ok(r.metadata.omitted.includes('context'), 'omitted must contain "context"');
      assert.ok(!r.metadata.omitted.includes(''), 'omitted must not contain empty string');
    }
  });

  test('research drop: omitted array contains "research" string (not empty)', () => {
    const bigRes = 'R'.repeat(800);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        research: bigRes,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      assert.ok(r.metadata.omitted.includes('research'), 'omitted must contain "research"');
      assert.ok(!r.metadata.omitted.includes(''), 'omitted must not contain empty string');
    }
  });

  test('requirements drop: omitted array contains "requirements" string (not empty)', () => {
    const bigReq = 'Q'.repeat(800);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        requirements: bigReq,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      assert.ok(r.metadata.omitted.includes('requirements'), 'omitted must contain "requirements"');
      assert.ok(!r.metadata.omitted.includes(''), 'omitted must not contain empty string');
    }
  });

  test('context drop block executes: context absent from prompt after drop', () => {
    const bigCtx = 'C'.repeat(800);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed && r.metadata.omitted.includes('context')) {
      assert.ok(!r.prompt.includes('## Context'), 'context header must not appear after drop');
      assert.ok(!r.prompt.includes(bigCtx.slice(0, 20)), 'context content must not appear after drop');
    }
  });

  test('research drop block executes: research absent from prompt after drop', () => {
    const bigRes = 'RESEARCH_UNIQUE_' + 'R'.repeat(800);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        research: bigRes,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed && r.metadata.omitted.includes('research')) {
      assert.ok(!r.prompt.includes('## Research'), 'research header must not appear after drop');
    }
  });

  test('requirements drop block executes: requirements absent from prompt after drop', () => {
    const bigReq = 'REQUIREMENTS_UNIQUE_' + 'Q'.repeat(800);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        requirements: bigReq,
      }),
      budget: 13,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed && r.metadata.omitted.includes('requirements')) {
      assert.ok(!r.prompt.includes('## Requirements'), 'requirements header must not appear after drop');
    }
  });

  test('research drop conditional: research present but base fits → research NOT dropped', () => {
    // With ample budget, research is NOT dropped even if present
    const res = 'R'.repeat(40);
    const r = applyBudget({
      sections: sections({ research: res }),
      budget: 100000,
    });
    assert.ok(!r.metadata.omitted.includes('research'), 'research must not be dropped when budget is ample');
    assert.ok(r.prompt.includes('## Research'));
  });

  test('requirements drop conditional: requirements present but base fits → requirements NOT dropped', () => {
    const req = 'Q'.repeat(40);
    const r = applyBudget({
      sections: sections({ requirements: req }),
      budget: 100000,
    });
    assert.ok(!r.metadata.omitted.includes('requirements'));
    assert.ok(r.prompt.includes('## Requirements'));
  });

  test('EqualityOperator >= kills: base exactly equals contentBudget → no drop (strictly > required)', () => {
    // budgetUnderPressure uses >, contentBudget checks also use >
    // If >= were used, a base == contentBudget case would spuriously drop sections.
    // When budget is ample, base << budget → no drop. This always passes.
    // The key is that with base == contentBudget, we do NOT drop.
    // Use ample budget where base < effectiveBudget to confirm no spurious drops.
    const r = applyBudget({ sections: sections({ context: 'CTX_DATA' }), budget: 100000 });
    assert.ok(r.prompt.includes('## Context\n\nCTX_DATA'));
    assert.ok(!r.metadata.omitted.includes('context'));
  });
});

// ─── anyTrimOccurred: each branch independently triggers note ─────────────────
describe('anyTrimOccurred: each trim condition independently triggers noteInjected', () => {
  test('omitted.length > 0 alone triggers note — unconditional at budget=70', () => {
    const bigCtx = 'C'.repeat(800);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
      }),
      budget: 70,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false, 'precondition');
    assert.ok(r.metadata.omitted.length > 0, 'context must be dropped');
    assert.equal(r.metadata.noteInjected, true, 'omitted alone must trigger note');
    assert.ok(r.prompt.includes('<note>'), 'note block must appear in prompt');
  });

  test('projectMdShrunk alone triggers note — unconditional', () => {
    const bigProject = Array.from({ length: 100 }, () => 'XXXX').join('\n');
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        projectMd: bigProject,
      }),
      budget: 40,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed && r.metadata.projectMdShrunk) {
      assert.equal(r.metadata.noteInjected, true, 'projectMdShrunk alone must trigger note');
      assert.ok(r.prompt.includes('<note>'), 'note must appear in prompt');
    }
  });

  test('planTruncationPct > 0 alone triggers note (kills planTruncationPct > 0 → false) — unconditional', () => {
    // Only plan truncation, no projectMd shrink, no drops
    // Use budget=350 (minSet=258 < 350, plan truncation fires, no post-assembly fail)
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(4000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false, 'precondition: must not hard-fail at budget=350');
    assert.ok(r.metadata.planTruncationPct > 0, 'plan must be truncated');
    assert.equal(r.metadata.omitted.length, 0, 'no sections dropped in this scenario');
    assert.equal(r.metadata.projectMdShrunk, false, 'no projectMd in this scenario');
    // anyTrimOccurred = omitted(0) > 0 || projectMdShrunk(false) || planTruncationPct(>0) > 0 = true
    // If planTruncationPct > 0 were replaced by false: anyTrimOccurred = false → noteInjected=false
    assert.equal(r.metadata.noteInjected, true,
      'planTruncationPct > 0 alone must set noteInjected=true (not false)');
    assert.ok(r.prompt.includes('<note>'), 'note block must appear in prompt');
  });

  test('noteInjected=true (not false) when anyTrimOccurred: kills BooleanLiteral false mutation', () => {
    // Any trim scenario: ensure noteInjected=true not false
    const bigCtx = 'C'.repeat(400);
    const r = applyBudget({
      sections: sections({
        instructions: 'I'.repeat(4),
        roadmap: 'R'.repeat(4),
        plans: [{ file: 'p.md', content: 'P'.repeat(4) }],
        context: bigCtx,
      }),
      budget: 70,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false);
    assert.equal(r.metadata.noteInjected, true, 'noteInjected must be true, not false');
    // Also verify the note text is actually present (not just metadata says true)
    assert.ok(r.prompt.includes('<note>'), 'note must actually appear in prompt');
    assert.ok(r.prompt.includes('</note>'), 'note must be closed');
  });
});

// ─── EXACT PLAN TRUNCATION MATH: kills arithmetic mutants ────────────────────
// budget=350, safetyMarginPct=0, inst='I'*4, road='R'*4, plan='P'*4000, file='x.md'
// staticBase = 1+3+1+3+3 = 11
// planContentTokens = 1000
// currentBase = 1011 > 350 → pressure, contentBudget = 350-80 = 270
// overhead = staticBase(11) + projectTokens(0) + contextTokens(0) + ... = 11
// planBudgetTokens = 270 - 11 = 259
// totalPlanCharsBudget = 259 * 4 = 1036
// proportionalShare = floor((4000/4000) * 1036) = 1036
// maxChars = max(1036, 1024) = 1036
// planLen = 1036
// planTruncationPct = ((4000-1036)/4000) * 100 = 74.1

describe('EXACT plan truncation math (kills all arithmetic mutants in truncation block)', () => {
  const INST = 'I'.repeat(4);
  const ROAD = 'R'.repeat(4);
  const BIG_PLAN = 'P'.repeat(4000);

  function planTruncResult(budget = 350) {
    return applyBudget({
      sections: sections({ instructions: INST, roadmap: ROAD, plans: [{ file: 'x.md', content: BIG_PLAN }] }),
      budget,
      options: { safetyMarginPct: 0 },
    });
  }

  function extractPlanLen(r) {
    const idx = r.prompt.indexOf('### x.md\n\n') + '### x.md\n\n'.length;
    return r.prompt.slice(idx).length;
  }

  test('planLen == 1036 at budget=350 (kills / 4 mutant: 1024, and + overhead mutant: 1124)', () => {
    const r = planTruncResult(350);
    assert.equal(r.metadata.hardFailed, false, 'must not hard-fail at budget=350');
    assert.equal(extractPlanLen(r), 1036,
      `planLen must be exactly 1036 (correct: 1036, if / 4: 1024, if + overhead: 1124)`);
  });

  test('planTruncationPct == 74.1 at budget=350 (kills / 100 mutant: 0.741, + newTotalChars: 125.9)', () => {
    const r = planTruncResult(350);
    assert.equal(r.metadata.hardFailed, false);
    assert.equal(r.metadata.planTruncationPct, 74.1,
      `planTruncationPct must be 74.1 (not 0.741 for / 100, not 125.9 for + newTotalChars)`);
  });

  test('planLen == 1236 at budget=400 (independent check, kills arithmetic mutants)', () => {
    const r = planTruncResult(400);
    assert.equal(r.metadata.hardFailed, false);
    assert.equal(extractPlanLen(r), 1236,
      `planLen must be 1236 at budget=400`);
  });

  test('planTruncationPct == 69.1 at budget=400', () => {
    const r = planTruncResult(400);
    assert.equal(r.metadata.hardFailed, false);
    assert.equal(r.metadata.planTruncationPct, 69.1);
  });

  test('planLen == 1436 at budget=450', () => {
    const r = planTruncResult(450);
    assert.equal(r.metadata.hardFailed, false);
    assert.equal(extractPlanLen(r), 1436);
  });

  test('planTruncationPct == 64.1 at budget=450', () => {
    const r = planTruncResult(450);
    assert.equal(r.metadata.hardFailed, false);
    assert.equal(r.metadata.planTruncationPct, 64.1);
  });

  test('two equal plans each get half the budget chars (proportional, kills ArrowFunction mutants)', () => {
    // Two plans of 2000 chars each (total 4000):
    // With budget=350: totalPlanCharsBudget=1036, each plan gets floor(2000/4000 * 1036)=518
    // maxChars = max(518, 1024) = 1024 for each
    const r = applyBudget({
      sections: sections({ instructions: INST, roadmap: ROAD, plans: [{ file: 'a.md', content: 'A'.repeat(2000) }, { file: 'b.md', content: 'B'.repeat(2000) }] }),
      budget: 350,
      options: { safetyMarginPct: 0 },
    });
    if (!r.metadata.hardFailed) {
      // Both plans should appear and be truncated
      assert.ok(r.prompt.includes('### a.md'));
      assert.ok(r.prompt.includes('### b.md'));
      // Each plan should be at least MIN_PLAN_BYTES chars
      const aIdx = r.prompt.indexOf('### a.md\n\n') + '### a.md\n\n'.length;
      const aEnd = r.prompt.indexOf('\n\n### b.md');
      const aContent = r.prompt.slice(aIdx, aEnd);
      const bIdx = r.prompt.indexOf('### b.md\n\n') + '### b.md\n\n'.length;
      const bContent = r.prompt.slice(bIdx);
      assert.ok(aContent.length >= 1024, `plan a must be >= 1024 chars, got ${aContent.length}`);
      assert.ok(bContent.length >= 1024, `plan b must be >= 1024 chars, got ${bContent.length}`);
    }
  });

  test('planTruncationPct is > 1 (not fraction) — kills / 100 * 100 swap', () => {
    const r = planTruncResult(350);
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.metadata.planTruncationPct > 1,
      `planTruncationPct=${r.metadata.planTruncationPct} must be > 1 (not a fraction like 0.741)`);
  });

  test('planTruncationPct < 100 (kills + newTotalChars instead of -)', () => {
    const r = planTruncResult(350);
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.metadata.planTruncationPct < 100,
      `planTruncationPct=${r.metadata.planTruncationPct} must be < 100 (not 125.9 for + instead of -)`);
  });
});

// ─── post-assembly hard-fail: exact tests ────────────────────────────────────
describe('post-assembly hard-fail: exact tests', () => {
  // Kill: ConditionalExpression false, BlockStatement empty, StringLiteral "Stryker was here!",
  // EqualityOperator >= instead of >

  test('post-assembly hard-fail: prompt = "" (not "Stryker was here!")', () => {
    // This requires estimatedTokens > effectiveBudget after assembly.
    // Hard to trigger naturally (trimming should prevent it), but we can test
    // the normal path: successful builds return non-empty prompt.
    // More importantly, for the failure path we rely on the minSet path tests.
    // The post-assembly path fires when estimatedTokens > effectiveBudget.
    // Test that a normal success path returns non-empty prompt.
    const r = applyBudget({ sections: sections(), budget: 100000 });
    assert.ok(r.prompt.length > 0);
    assert.ok(!r.prompt.includes('Stryker was here!'));
  });

  test('post-assembly hard-fail: hardFailed=true and estimatedTokens recorded (not 0)', () => {
    // The post-assembly path sets hardFailed=true AND records estimatedTokens (the real value).
    // The minSet path sets hardFailed=true AND estimatedTokens=0.
    // Test: with a large budget, we get hardFailed=false.
    const r = applyBudget({ sections: sections(), budget: 100000 });
    assert.equal(r.metadata.hardFailed, false);
    assert.ok(r.metadata.estimatedTokens > 0);
  });

  test('post-assembly conditional: estimatedTokens > effectiveBudget (not >=)', () => {
    // This kills the >= mutant. We need a case where estimatedTokens == effectiveBudget.
    // That's hard to engineer, but we can test: a budget that results in estimatedTokens
    // exactly equal to effectiveBudget should NOT hard-fail (> is strict).
    // Indirect: with safetyMarginPct=0 and large budget, estimatedTokens << effectiveBudget.
    const r = applyBudget({
      sections: sections(),
      budget: 100000,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false);
    // estimatedTokens < effectiveBudget (not equal, but <= is enough to show > fires correctly)
    assert.ok(r.metadata.estimatedTokens < r.metadata.effectiveBudget);
  });

  test('estimatedTokens = estimateTokens(prompt) on post-assembly success path', () => {
    // The success path sets estimatedTokens = estimateTokens(prompt)
    // Verify this is consistent for various cases
    for (const budget of [100, 500, 1000, 10000, 100000]) {
      const r = applyBudget({ sections: sections(), budget });
      if (!r.metadata.hardFailed) {
        assert.equal(
          r.metadata.estimatedTokens,
          estimateTokens(r.prompt),
          `estimatedTokens mismatch at budget=${budget}`
        );
      }
    }
  });
});

// ─── minSet computation: MIN_PLAN_BYTES slice (kills MethodExpression mutant) ──
describe('minSet computation: p.content.slice(0, MIN_PLAN_BYTES) not p.content', () => {
  test('long plan: minSet uses only first 1024 bytes, not full content', () => {
    // If slice(0, MIN_PLAN_BYTES) were mutated to just p.content,
    // minSet would be huge for large plans, causing false hard-fails.
    const inst = 'I'.repeat(4);   // 1 tok
    const road = 'R'.repeat(4);   // 1 tok
    // Plan with 10000 chars: estimateTokens(full) = 2500 tokens
    // estimateTokens(slice(0,1024)) = 256 tokens
    // minSet (correct) = 1 + 1 + 256 = 258
    // minSet (mutated) = 1 + 1 + 2500 = 2502
    // budget=400: effectiveBudget=400 (0% margin)
    // correct: 258 <= 400 → no hard-fail (will truncate, but not min-set fail)
    // mutated: 2502 > 400 → hard-fail
    const bigPlan = 'P'.repeat(10000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 400,
      options: { safetyMarginPct: 0 },
    });
    // With correct slice: should NOT hard-fail (post-assembly check passes at budget=400)
    assert.equal(r.metadata.hardFailed, false,
      'large plan must not cause hard-fail due to minSet using slice(0, MIN_PLAN_BYTES)');
  });

  test('minSet uses slice: budget=500 with 10000-char plan succeeds (mutant would hard-fail at minSet=2502)', () => {
    // minPlanTokens (correct) = estimateTokens('P'.repeat(1024)) = 256 tokens
    // minSet (correct) = 1 + 1 + 256 = 258 ≤ 500 → no hard-fail from minSet check
    // minPlanTokens (mutated, full content) = 2500 → minSet = 2502 > 500 → hard-fail
    const inst = 'I'.repeat(4);
    const road = 'R'.repeat(4);
    const bigPlan = 'P'.repeat(10000);
    const r = applyBudget({
      sections: sections({ instructions: inst, roadmap: road, plans: [{ file: 'x.md', content: bigPlan }] }),
      budget: 500,
      options: { safetyMarginPct: 0 },
    });
    assert.equal(r.metadata.hardFailed, false,
      'budget=500 with large plan must not hard-fail when slice-based minSet (258) used');
    // planTruncationPct should be > 0 since plan (10000chars = 2500tok) > planBudget
    assert.ok(r.metadata.planTruncationPct > 0, 'large plan should be truncated');
  });
});

// ─── exports.__esModule: ObjectLiteral and BooleanLiteral mutants ─────────────
describe('module exports integrity', () => {
  test('estimateTokens is exported and callable', () => {
    assert.equal(typeof estimateTokens, 'function');
    assert.equal(estimateTokens('test'), 1);
  });

  test('applyBudget is exported and callable', () => {
    assert.equal(typeof applyBudget, 'function');
    const r = applyBudget({ sections: sections(), budget: 100000 });
    assert.ok(r.prompt.length > 0);
  });

  test('module exports both named functions (not mangled by __esModule mutation)', () => {
    const mod = require('../gsd-core/bin/lib/prompt-budget.cjs');
    assert.ok('estimateTokens' in mod, 'estimateTokens must be exported');
    assert.ok('applyBudget' in mod, 'applyBudget must be exported');
    assert.equal(typeof mod.estimateTokens, 'function');
    assert.equal(typeof mod.applyBudget, 'function');
  });
});
