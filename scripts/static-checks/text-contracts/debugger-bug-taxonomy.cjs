'use strict';

// Bug-taxonomy classification and strategy routing for the debugger (#1961, epic #1957 Phase 2B): the reference extract
// exists and gsd-debugger @-includes it; it defines the three classes (Bohrbug, Heisenbug/Mandelbug, Concurrency); the DEBUG.md
// template records bug_class; routing is an explicit markdown table whose rows are checked one by one (a Bohrbug row routes
// to reproduction, SBFL and bisection; a Heisenbug row to record-replay or stability and revokes SBFL; a Concurrency row
// to atomicity, order and deadlock); the six previously orphaned techniques have a General-lane route; and the reference says
// the flat menu is superseded. Was tests/debugger-bug-taxonomy.test.cjs. Its in-file routing object was a specification of
// constants that no repo file feeds, so it asserted nothing about the repo and is not carried over.

const AGENT = 'agents/gsd-debugger.md';
const REFERENCE = 'gsd-core/references/debugger-bug-taxonomy.md';
const DEBUG_TEMPLATE = 'gsd-core/templates/DEBUG.md';
const PREVIOUSLY_ORPHANED = ['rubber duck', 'delta debugging', 'working backwards', 'differential', 'comment out everything', 'follow the indirection'];

// Does the text contain `\bword\b` (ASCII word characters)?
function hasWord(text, word) {
  const isWord = (ch) => ch !== undefined && /\w/.test(ch);
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (!isWord(text[at - 1]) && !isWord(text[at + word.length])) return true;
  }
  return false;
}

// Does the line contain `first` and, somewhere after its first occurrence, `second` (case-insensitive)?
function hasInOrder(line, first, second) {
  const lower = line.toLowerCase();
  const at = lower.indexOf(first);
  return at !== -1 && lower.indexOf(second, at + first.length) !== -1;
}

// The routing table rows (lowercased): lines that start with `|`, are not a separator line, and hold at least three pipes.
function tableRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    if ([...line].every((ch) => ch === '|' || ch === '-' || /\s/.test(ch))) continue;
    if (line.split('|').length - 1 < 3) continue;
    rows.push(line.toLowerCase());
  }
  return rows;
}

const rowFor = (text, cls) => tableRows(text).find((row) => row.includes(cls)) || null;
const onRow = (cls, check) => (text) => {
  const row = rowFor(text, cls);
  return row === null ? `no ${cls} row` : check(row);
};

module.exports = {
  id: 'debugger-bug-taxonomy',
  issue: '#1961',
  check(ctx) {
    ctx.exists(REFERENCE, 'debugger-bug-taxonomy.md reference must exist');
    ctx.doc(AGENT).has('@~/.claude/gsd-core/references/debugger-bug-taxonomy.md', 'gsd-debugger.md must @-include the bug-taxonomy reference (from Phase 1.75 or the technique-selection table)');
    ctx.doc(DEBUG_TEMPLATE).has(/bug_class/, 'the DEBUG.md Current Focus must carry a bug_class field');

    ctx.doc(REFERENCE)
      .has(/bohrbug/i, 'the reference must define the class Bohrbug')
      .has(/heisenbug|mandelbug/i, 'the reference must define the class Heisenbug/Mandelbug')
      .has(/concurrency/i, 'the reference must define the class Concurrency')
      .has(/rout/i, 'the word route/routing must appear')
      .satisfies((text) => text.split(/\r|\n|\u2028|\u2029/).some((line) => line.split('|').length - 1 >= 3) || 'no line with three pipes', 'there must be a markdown table (inspectable)')
      .satisfies((text) => tableRows(text).length >= 3 || `found ${tableRows(text).length}`, 'the routing table must have at least 3 class rows')
      .satisfies(onRow('bohrbug', (row) => row.includes('reproduc') || 'no reproduction'), 'the Bohrbug row must include reproduction')
      .satisfies(onRow('bohrbug', (row) => row.includes('sbfl') || 'no SBFL'), 'the Bohrbug row must include SBFL (Phase 1.25, not the epic shorthand Phase 1B)')
      .satisfies(onRow('bohrbug', (row) => row.includes('bisect') || 'no bisect'), 'the Bohrbug row must include git bisect')
      .satisfies(onRow('heisenbug', (row) => /record-replay|stability/.test(row) || hasWord(row, 'rr') || 'no record-replay, rr or stability'), 'the Heisenbug row must include record-replay (rr) and/or stability-stress')
      .satisfies(onRow('heisenbug', (row) => row.includes('sbfl') || 'no SBFL'), 'the Heisenbug row must reference SBFL (in the revoke column)')
      .satisfies(onRow('heisenbug', (row) => /revoke|revocat/.test(row) || 'no revoke'), 'the Heisenbug row must state SBFL is REVOKED if already run (Phase 1.25 precedes classification)')
      .satisfies(onRow('concurrency', (row) => row.includes('atomicity') || 'no atomicity'), 'the Concurrency row must include atomicity')
      .satisfies(onRow('concurrency', (row) => hasWord(row, 'order') || 'no order'), 'the Concurrency row must include order')
      .satisfies(onRow('concurrency', (row) => row.includes('deadlock') || 'no deadlock'), 'the Concurrency row must include deadlock');
    for (const technique of PREVIOUSLY_ORPHANED) {
      ctx.doc(REFERENCE).satisfies((text) => text.toLowerCase().includes(technique), `the technique "${technique}" must appear in the bug-taxonomy reference (General lane): the reframe once orphaned it`);
    }
    ctx.doc(REFERENCE).satisfies((text) => /replace|supersede|routed? selection/i.test(text) || text.split(/\r|\n|\u2028|\u2029/).some((line) => hasInOrder(line, 'not', 'append')) || 'no such wording', 'the reference must state the flat menu is replaced or superseded by class-routed selection, not merely appended');
  },
};
