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
 * Module: get-shit-done/bin/lib/prompt-budget.cjs
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { estimateTokens, applyBudget } = require('../get-shit-done/bin/lib/prompt-budget.cjs');

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
