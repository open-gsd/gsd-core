'use strict';

// The new-project workflow's MVP mode prompt: a Vertical MVP and a Horizontal Layers option, a ROADMAP template
// that emits `**Mode:** mvp` under the Vertical MVP path, and a standard-template fallback for Horizontal Layers.
// Also bug #1516: every `header: "AI Models"` prompt (the auto-mode one now lives in new-project/steps) offers an
// Adaptive option, all five model profiles are selectable, no options array has more than four labels (the
// AskUserQuestion runtime cap), both config-new-project example payloads list adaptive in the model_profile enum,
// and the workflow keeps balanced braces. The scans are linear (no `\s*` or lazy pattern over the whole file).
// Was tests/new-project-mvp-prompt.test.cjs.

const WORKFLOW = 'gsd-core/workflows/new-project.md';
const STEPS_DIR = 'gsd-core/workflows/new-project/steps';
const OPTIONS_CAP = 4;
const PROFILES = ['adaptive', 'quality', 'balanced', 'budget', 'inherit'];

const isBlank = (ch) => /\s/.test(ch);
const isWord = (ch) => /\w/.test(ch);

function skipBlank(text, at) {
  let i = at;
  while (i < text.length && isBlank(text[i])) i += 1;
  return i;
}

// Every value of `key\s*"value"` (one or more characters between the quotes), in order, as /key\s*"([^"]+)"/g.
function quotedAfter(text, key) {
  const out = [];
  let at = text.indexOf(key);
  while (at !== -1) {
    const open = skipBlank(text, at + key.length);
    let next = at + 1;
    if (text[open] === '"') {
      const close = text.indexOf('"', open + 1);
      if (close > open + 1) {
        out.push(text.slice(open + 1, close));
        next = close + 1;
      }
    }
    at = text.indexOf(key, next);
  }
  return out;
}

// The text from each `header: "AI Models"` to the next ``` fence (or 60 lines of 80 characters, whichever is first).
function aiModelsBlocks(text) {
  const blocks = [];
  const marker = '"AI Models"';
  let at = text.indexOf('header:');
  while (at !== -1) {
    const open = skipBlank(text, at + 'header:'.length);
    let next = at + 1;
    if (text.startsWith(marker, open)) {
      const fence = text.indexOf('```', at + 1);
      const limit = at + 60 * 80;
      blocks.push(text.slice(at, fence === -1 ? limit : Math.min(fence + 3, limit)));
      next = open + marker.length;
    }
    at = text.indexOf('header:', next);
  }
  return blocks;
}

// The first options array with more labels than the cap ({ index, count }), the first one never closed (its index, or
// null) and how many options arrays there are. One pass: outside an options array nothing is skipped (a quote in prose
// cannot hide an array); inside one, double-, single- and backtick-quoted strings are skipped (a backslash escapes
// the next character, and any string ends at the line end) so a bracket in a label does not close the array.
function optionsArrays(text) {
  const closeOf = new Map();
  const opens = [];
  const stack = [];
  let quote = '';
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k];
    if (quote !== '') {
      if (ch === '\\' && text[k + 1] !== '\n') k += 1;
      else if (ch === quote || ch === '\n') quote = '';
    } else if (stack.length > 0 && (ch === '"' || ch === "'" || ch === '`')) {
      quote = ch;
    } else if (ch === '[') {
      if (stack.length > 0) stack.push(k);
    } else if (ch === ']') {
      if (stack.length > 0) closeOf.set(stack.pop(), k);
    } else if (ch === 'o' && text.startsWith('options', k) && (k === 0 || !isWord(text[k - 1]))) {
      const colon = skipBlank(text, k + 'options'.length);
      const open = text[colon] === ':' ? skipBlank(text, colon + 1) : -1;
      if (open !== -1 && text[open] === '[') {
        opens.push(open);
        stack.push(open);
        k = open;
      }
    }
  }
  let offender = null;
  let unclosed = null;
  opens.forEach((open, i) => {
    const end = closeOf.get(open);
    if (end === undefined && unclosed === null) unclosed = i + 1;
    const count = end === undefined ? 0 : quotedAfter(text.slice(open, end + 1), 'label:').length;
    if (count > OPTIONS_CAP && offender === null) offender = { index: i + 1, count };
  });
  return { questions: opens.length, offender, unclosed };
}

// The value of every `model_profile"\s*:\s*"value"` (an empty value allowed), in order.
function modelProfileEnums(text) {
  const out = [];
  const key = 'model_profile"';
  let at = text.indexOf(key);
  while (at !== -1) {
    const colon = skipBlank(text, at + key.length);
    let next = at + 1;
    if (text[colon] === ':') {
      const open = skipBlank(text, colon + 1);
      if (text[open] === '"') {
        const close = text.indexOf('"', open + 1);
        if (close !== -1) {
          out.push(text.slice(open + 1, close));
          next = close + 1;
        }
      }
    }
    at = text.indexOf(key, next);
  }
  return out;
}

module.exports = {
  id: 'new-project-mvp-prompt',
  issue: '#1516',
  check(ctx) {
    const lines = (text) => text.toLowerCase().split('\n');
    ctx.doc(WORKFLOW)
      .has(/vertical mvp/i, 'the workflow must mention the Vertical MVP option in the mode prompt')
      .has(/horizontal layers/i, 'the workflow must mention the Horizontal Layers option in the mode prompt')
      .has(/\*\*mode:\*\* mvp/i, 'the ROADMAP template must emit **Mode:** mvp on the initial roadmap phases under Vertical MVP')
      .satisfies((text) => lines(text).some((line) => (line.includes('horizontal') && line.includes('standard')) || line.includes('no mode line')),
        'the workflow must specify the fallback to the standard template when Horizontal Layers is picked');

    // The host and every step file directly under new-project/steps (the test read the directory without descending).
    const steps = ctx.list(STEPS_DIR, '.md', 'the new-project step files hold the auto-mode AI Models prompt').filter((rel) => rel.split('/').length === STEPS_DIR.split('/').length + 1);
    ctx.docs([WORKFLOW, ...steps])
      .satisfies((text) => aiModelsBlocks(text).length >= 2 || `found ${aiModelsBlocks(text).length}`,
        'new-project must have at least two AI Models prompts (Step 2a auto-mode and Step 5 interactive)')
      .satisfies((text) => {
        const blocks = aiModelsBlocks(text);
        if (blocks.length === 0) return 'no AI Models block to check';
        const missing = blocks.map((block, i) => ({ i, labels: quotedAfter(block, 'label:').map((label) => label.toLowerCase()) }))
          .filter(({ labels }) => !labels.some((label) => label.startsWith('adaptive')));
        return missing.length === 0 || `AI Models prompt #${missing[0].i + 1} has labels [${missing[0].labels.join(', ')}]`;
      }, 'each AI Models prompt must include an Adaptive option (the #1516 regression: adaptive was omitted entirely)')
      .satisfies((text) => {
        const labels = aiModelsBlocks(text).flatMap((block) => quotedAfter(block, 'label:').map((label) => label.toLowerCase()));
        const missing = PROFILES.filter((profile) => !labels.some((label) => label.startsWith(profile)));
        return missing.length === 0 || `not selectable: ${missing.join(', ')}`;
      }, 'all five model profiles must be selectable options across the AI Models prompts')
      .satisfies((text) => {
        const { questions, offender, unclosed } = optionsArrays(text);
        if (questions === 0) return 'no AskUserQuestion options array found';
        if (offender !== null) return `options array #${offender.index} has ${offender.count} options`;
        return unclosed === null || `options array #${unclosed} is never closed`;
      }, `no options array may exceed the ${OPTIONS_CAP}-option AskUserQuestion runtime cap (split into multiple questions, as #3784 did for model_profile)`)
      .satisfies((text) => {
        const enums = modelProfileEnums(text);
        if (enums.length < 2) return `found ${enums.length} config-new-project example payloads`;
        const missing = enums.findIndex((value) => !value.includes('adaptive'));
        return missing === -1 || `payload #${missing + 1} model_profile enum is "${enums[missing]}"`;
      }, 'both config-new-project example payloads must list adaptive in the model_profile enum')
      .satisfies((text) => {
        let depth = 0;
        for (const ch of text) {
          if (ch === '{') depth += 1;
          if (ch === '}') depth -= 1;
        }
        return depth === 0 || `net depth ${depth}`;
      }, 'new-project.md must have balanced braces (regression guard, mirrors #3784)');
  },
};
