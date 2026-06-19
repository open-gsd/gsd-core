'use strict';

// allow-test-rule: source-text-is-the-product
// Workflow markdown is runtime contract; these assertions verify deployed behavior text.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('review workflow default reviewer selection contract (#3079)', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), 'gsd-core', 'workflows', 'review.md'),
    'utf8'
  );

  test('documents review.default_reviewers no-flag behavior', () => {
    assert.ok(
      workflow.includes('review.default_reviewers'),
      'review workflow must reference review.default_reviewers for no-flag selection'
    );
  });

  test('documents precedence order with explicit flags and --all overrides', () => {
    assert.ok(
      workflow.includes('Individual reviewer flags') &&
      workflow.includes('--all') &&
      workflow.includes('review.default_reviewers'),
      'review workflow must document precedence: flags > --all > review.default_reviewers'
    );
  });

  test('documents unknown/undetected configured slug handling', () => {
    assert.ok(
      workflow.includes('Unknown slugs warn') &&
      workflow.includes('Known-but-undetected slugs'),
      'review workflow must document unknown and undetected slug handling'
    );
  });

  test('documents failure behavior when all configured reviewers unavailable', () => {
    assert.ok(
      workflow.includes('all configured reviewers are unavailable') &&
      workflow.includes('fail'),
      'review workflow must document failure path when configured reviewers are unavailable'
    );
  });
});

describe('review workflow source-grounding requirement in build_prompt (#1318)', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), 'gsd-core', 'workflows', 'review.md'),
    'utf8'
  );

  // Extract ONLY the build_prompt Review Instructions region — the slice of the
  // assembled prompt that is actually piped to the prompt-fed reviewers. The
  // grounding instruction is worthless unless it lives HERE (#1318): asserting
  // against the whole file would still pass if the text drifted into a note,
  // the consensus step, or a comment that never reaches a reviewer's stdin.
  //
  // The region is the fenced prompt's `## Review Instructions` section, from
  // that heading up to the next `## ` heading inside the same fenced block.
  function buildPromptReviewInstructions(src) {
    // Locate the build_prompt step, then its first fenced ```markdown block.
    // NOTE: '<step name="build_prompt">' is a literal anchor — update it if the
    // step is ever renamed or gains/reorders attributes.
    const stepIdx = src.indexOf('<step name="build_prompt">');
    assert.ok(stepIdx !== -1, 'build_prompt step must exist');

    // Fence-run-aware extraction (CommonMark): a naive `indexOf('\n```')` would
    // terminate at the FIRST triple-backtick line, truncating the prompt if its
    // body embeds a fenced code example. Mirror the close rule used by
    // src/markdown-sectionizer.cts stripFencedCode: the closing fence is a line
    // of the SAME char and >= the opener's run length, with no trailing content,
    // so a shorter nested fence inside the block is treated as content (#1318).
    // Backtick-fenced only by design — the build_prompt block is ```markdown.
    const lines = src.slice(stepIdx).split('\n');
    const openRe = /^ {0,3}(`{3,})markdown\s*$/;
    let openLen = 0;
    let bodyStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = openRe.exec(lines[i].replace(/\r$/, ''));
      if (m) { openLen = m[1].length; bodyStart = i + 1; break; }
    }
    assert.ok(bodyStart !== -1, 'build_prompt must contain a ```markdown prompt block');
    const closeRe = new RegExp(`^ {0,3}\`{${openLen},}\\s*$`);
    let bodyEnd = -1;
    for (let i = bodyStart; i < lines.length; i++) {
      if (closeRe.test(lines[i].replace(/\r$/, ''))) { bodyEnd = i; break; }
    }
    assert.ok(bodyEnd !== -1, 'build_prompt markdown fence must be closed');
    const fenced = lines.slice(bodyStart, bodyEnd).join('\n');

    const hdr = fenced.indexOf('## Review Instructions');
    assert.ok(hdr !== -1, 'fenced prompt must contain a ## Review Instructions section');
    // Next top-level `## ` heading after the Review Instructions heading.
    const after = fenced.indexOf('\n## ', hdr + 1);
    return after === -1 ? fenced.slice(hdr) : fenced.slice(hdr, after);
  }

  const reviewInstructions = buildPromptReviewInstructions(workflow);

  test('instructs reviewers to verify plan claims against source and cite file:line', () => {
    // The cross-AI prompt assembled from plan text must push agentic reviewers
    // to open the referenced source and ground findings in evidence, instead of
    // paraphrasing plan text (the false-LOW failure mode in #1318). Assert the
    // instruction lives INSIDE the prompt region, not merely somewhere in file.
    assert.ok(
      reviewInstructions.includes('Verify against source') &&
      reviewInstructions.includes('check each claim against the actual code') &&
      reviewInstructions.includes('`path/to/file:line`'),
      'build_prompt Review Instructions region must require source verification + file:line evidence'
    );
  });

  test('includes a graceful-degradation clause for reviewers without file access', () => {
    // Prompt-only reviewers (ollama / lm_studio / llama.cpp) must flag that they
    // could not verify rather than asserting an unverified finding — and this
    // clause must sit WITHIN the prompt region so reviewers actually receive it.
    assert.ok(
      reviewInstructions.includes('If you cannot read the repo (no file access)') &&
      reviewInstructions.includes('downgrade that finding to an open question'),
      'build_prompt Review Instructions region must degrade gracefully for prompt-only reviewers'
    );
  });

  test('#1318: prompt extraction is fence-run-aware — a nested code fence does not truncate it', () => {
    // Regression guard for the fenceClose hardening. The feature feeds source/plan
    // content (which routinely contains code fences) into the prompt; a naive
    // first-`\n```` close scan would stop at a nested fence and drop everything
    // after it — including the `## Review Instructions` section — yielding a
    // spurious failure or false pass. A 4-backtick outer fence must extract in
    // full past a nested 3-backtick block.
    const synthetic = [
      '<step name="build_prompt">',
      '````markdown',
      '# Prompt',
      'Example for reviewers:',
      '```bash',
      'echo hi',
      '```',
      '## Review Instructions',
      '- Verify against source and cite `path/to/file:line`.',
      '````',
      '</step>',
    ].join('\n');
    const extracted = buildPromptReviewInstructions(synthetic);
    assert.match(extracted, /## Review Instructions/);
    assert.match(extracted, /cite `path\/to\/file:line`/);
  });
});
