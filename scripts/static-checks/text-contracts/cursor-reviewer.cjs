'use strict';

// The Cursor CLI as a peer reviewer of /gsd-review (#1960): the review workflow detects it with `command -v cursor-agent`
// (not the IDE launcher), parses --cursor, detects itself through CURSOR_SESSION_ID, never writes the broken two-token
// "cursor agent " form or pipes a prompt into a cursor command, and lists cursor in its reviewers array; the command file,
// the help signature, COMMANDS.md and FEATURES.md (and their ja-JP and ko-KR mirrors) mention --cursor and Cursor. The lane
// descriptor cases (binary, output format, prompt channel, REVIEWS.md section) run product modules and stay in
// tests/cursor-reviewer.test.cjs. Was the text half of that test.

const REVIEW = 'gsd-core/workflows/review.md';

// A pipe, then blanks, then `cursor` that is not `cursor-agent`: the prompt piped into a cursor command.
function pipesIntoCursor(text) {
  let at = text.indexOf('|');
  while (at !== -1) {
    let cursor = at + 1;
    while (text[cursor] === ' ') cursor += 1;
    if (text.startsWith('cursor', cursor) && !text.startsWith('cursor-agent', cursor)) return true;
    at = text.indexOf('|', at + 1);
  }
  return false;
}

// `reviewers:` and `cursor` on one line: a line ends at LF, CR, U+2028 or U+2029.
function listsCursorAmongReviewers(text) {
  let at = text.indexOf('reviewers:');
  while (at !== -1) {
    const from = at + 'reviewers:'.length;
    let end = from;
    while (end < text.length && !'\n\r\u2028\u2029'.includes(text[end])) end += 1;
    if (text.slice(from, end).includes('cursor')) return true;
    at = text.indexOf('reviewers:', at + 1);
  }
  return false;
}

module.exports = {
  // The linear walkers, exported for the differential properties of tests/text-contracts.batch10.test.cjs.
  pipesIntoCursor, listsCursorAmongReviewers,
  id: 'cursor-reviewer',
  issue: '#1960',
  check(ctx) {
    ctx.doc(REVIEW)
      .has('command -v cursor-agent', 'review.md should detect cursor CLI via "command -v cursor-agent" (not the cursor IDE launcher)')
      .has('--cursor', 'review.md should parse --cursor flag')
      .has('CURSOR_SESSION_ID', 'review.md should detect self-CLI via CURSOR_SESSION_ID env var')
      .lacks('cursor agent ', 'review.md must NOT contain the broken two-token form "cursor agent " (use "cursor-agent" instead)')
      .satisfies((text) => !pipesIntoCursor(text), 'review.md must NOT pipe the prompt to a cursor command via stdin')
      .satisfies(listsCursorAmongReviewers, 'review.md should list cursor in the reviewers array');

    ctx.doc('commands/gsd/review.md')
      .has('--cursor', 'commands/gsd/review.md should mention --cursor flag')
      .has('Cursor', 'commands/gsd/review.md should mention Cursor');
    // After #3039 the help content lives in help/modes/full.md.
    ctx.doc('gsd-core/workflows/help/modes/full.md').has('--cursor', 'help.md should list --cursor in the /gsd-review command signature');
    ctx.doc('docs/COMMANDS.md').has('--cursor', 'docs/COMMANDS.md should have a --cursor flag row');
    ctx.doc('docs/FEATURES.md')
      .has('--cursor', 'docs/FEATURES.md should include --cursor in the review command signature')
      .has('Cursor', 'docs/FEATURES.md should mention Cursor in the review section');
    for (const locale of ['ja-JP', 'ko-KR']) {
      ctx.doc(`docs/${locale}/COMMANDS.md`).has('--cursor', `docs/${locale}/COMMANDS.md should have a --cursor flag row`);
      ctx.doc(`docs/${locale}/FEATURES.md`)
        .has('--cursor', `docs/${locale}/FEATURES.md should include --cursor in the review command signature`)
        .has(/Cursor/i, `docs/${locale}/FEATURES.md should mention Cursor in the review section`);
    }
  },
};
