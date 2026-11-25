'use strict';

// /gsd-edit-phase (#2617, consolidated into /gsd-phase --edit by #2790): the consolidated command (name, description, the
// edit-phase workflow reference, the --edit or --force flag), the workflow (presenting current field values, editing
// individual fields, the five fields, regenerating from a clarified intent, validating depends_on, the in-progress and
// completed status guard with the --force override, the not-found and missing-argument errors, the diff and the
// confirmation, exiting without writing on a decline, preserving the phase number and position, writing in place, the
// milestone scope guard of #3262 in the write_updated_phase step and the success criteria, the STATE.md Roadmap Evolution
// update), and the documentation registration (INVENTORY.md row, INVENTORY-MANIFEST.json, COMMANDS.md).
// The workflow rules are case-insensitive for ASCII only, as the old patterns were; each `a.*b` is `a` then `b` on one line
// (a dot stops at LF, CR, U+2028 and U+2029), each `\s+` is one or more blanks, and an alternative another one implies
// (`phase.*not.*found` for `not.*found`, `not reference itself` for `itself`, `If tests pass`-style supersets) is not
// repeated. The name and description are read from the closed frontmatter block, where the test read the whole file.
// Every pattern is a linear walk. Was tests/edit-phase.test.cjs.

const path = require('node:path');

const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { asciiLower } = require('./lib/ascii-lower.cjs');
const { loadLib } = require('./lib/load-lib.cjs');

const COMMAND = 'commands/gsd/phase.md';
const WORKFLOW = 'gsd-core/workflows/edit-phase.md';
const INVENTORY = 'docs/INVENTORY.md';
const MANIFEST = 'docs/INVENTORY-MANIFEST.json';
const COMMANDS_DOC = 'docs/COMMANDS.md';
const FORCE_WINDOW = 300;

// The workflow is lower-cased once for all the rules that read it.
let lowered = { source: null, value: '' };
function lower(text) {
  if (lowered.source !== text) lowered = { source: text, value: asciiLower(text) };
  return lowered.value;
}

const isSpace = (char) => char !== undefined && /\s/.test(char);
const isWordChar = (char) => char !== undefined && /[A-Za-z0-9_]/.test(char);
const skipSpaces = (text, from) => {
  let at = from;
  while (at < text.length && isSpace(text[at])) at += 1;
  return at;
};
const anyOf = (text, words) => words.some((word) => text.includes(word));

// The lines of a text, cut at LF, CR, U+2028 and U+2029 (what a dot cannot cross).
function lineSegments(text) {
  const segments = [];
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (LINE_ENDS.has(text[at])) {
      segments.push(text.slice(start, at));
      start = at + 1;
    }
  }
  segments.push(text.slice(start));
  return segments;
}

// /a.*b.*c/: the words in this order on one line, with any text (and none) between them.
function sameLine(low, words) {
  return lineSegments(low).some((segment) => {
    let from = 0;
    for (const word of words) {
      const at = segment.indexOf(word, from);
      if (at === -1) return false;
      from = at + word.length;
    }
    return true;
  });
}

// /first\s+second/: `first`, then one or more blanks, then `second`.
function spaced(low, first, second) {
  let at = low.indexOf(first);
  while (at !== -1) {
    const after = at + first.length;
    const next = skipSpaces(low, after);
    if (next > after && low.startsWith(second, next)) return true;
    at = low.indexOf(first, at + 1);
  }
  return false;
}

// /\bword\b/
function wordBounded(low, word) {
  let at = low.indexOf(word);
  while (at !== -1) {
    if (!isWordChar(low[at - 1]) && !isWordChar(low[at + word.length])) return true;
    at = low.indexOf(word, at + 1);
  }
  return false;
}

// /clarified?\s+intent/: `clarifie`, an optional `d`, one or more blanks, `intent`.
function clarifiedIntent(low) {
  let at = low.indexOf('clarifie');
  while (at !== -1) {
    let p = at + 'clarifie'.length;
    if (low[p] === 'd') p += 1;
    const next = skipSpaces(low, p);
    if (next > p && low.startsWith('intent', next)) return true;
    at = low.indexOf('clarifie', at + 1);
  }
  return false;
}

// /in.progress/: `in`, any one character that is not a line end, `progress`.
function inProgress(low) {
  let at = low.indexOf('progress');
  while (at !== -1) {
    if (at >= 3 && low.startsWith('in', at - 3) && !LINE_ENDS.has(low[at - 1])) return true;
    at = low.indexOf('progress', at + 1);
  }
  return false;
}

// /--force[\s\S]{0,300}/: the first `--force` and the 300 characters after it must hold one of the words that let an edit
// go ahead; or `force` then `passed` on one line (which also covers force.*was.*passed).
function forceAllowsEdit(low) {
  const at = low.indexOf('--force');
  if (at === -1) return true;
  const window = low.slice(at, at + '--force'.length + FORCE_WINDOW);
  return anyOf(window, ['proceed', 'continue', 'allow', 'override']) || sameLine(low, ['force', 'passed']);
}

// /<anti_patterns>([\s\S]*?)<\/anti_patterns>/i and the prohibition of renumbering inside it.
function antiPatternsBlockRenumbering(low) {
  const open = '<anti_patterns>';
  const start = low.indexOf(open);
  if (start === -1) return { missing: true };
  const end = low.indexOf('</anti_patterns>', start + open.length);
  if (end === -1) return { missing: true };
  const body = low.slice(start + open.length, end);
  return { ok: body.includes('renumber') || sameLine(body, ['number', 'preserved']) || sameLine(body, ['preserve', 'number']) };
}

// /^name:\s*gsd:phase/m and /^description:/m over the frontmatter text.
function keyLineAt(text, key) {
  let at = text.indexOf(key);
  while (at !== -1) {
    if (at === 0 || LINE_ENDS.has(text[at - 1])) return at;
    at = text.indexOf(key, at + 1);
  }
  return -1;
}
function namesGsdPhase(text) {
  let at = text.indexOf('name:');
  while (at !== -1) {
    if ((at === 0 || LINE_ENDS.has(text[at - 1])) && text.startsWith('gsd:phase', skipSpaces(text, at + 5))) return true;
    at = text.indexOf('name:', at + 1);
  }
  return false;
}

// The workflow rules over the ASCII lower-cased text, one assertion each. A rule that also needs `--force` defers to the
// assertion that reports a missing `--force`, so one missing phrase is one finding.
const RULES = {
  presentsCurrentValues: [
    'the workflow must present current field values before editing',
    (low) => spaced(low, 'current', 'value') || sameLine(low, ['present', 'current']) || sameLine(low, ['display', 'current']) || low.includes('current_value'),
  ],
  editsIndividualFields: [
    'the workflow must support editing individual fields',
    (low) => spaced(low, 'specific', 'field') || spaced(low, 'individual', 'field') || sameLine(low, ['edit', 'field']),
  ],
  mentionsTitle: ['the workflow must mention the title field', (low) => wordBounded(low, 'title')],
  mentionsGoal: ['the workflow must mention the goal field', (low) => wordBounded(low, 'goal')],
  mentionsDependsOn: ['the workflow must mention the depends_on field', (low) => low.includes('depends_on')],
  mentionsRequirements: ['the workflow must mention the requirements field', (low) => low.includes('requirements')],
  mentionsSuccessCriteria: ['the workflow must mention the success_criteria field', (low) => low.includes('success_criteria')],
  regeneratesFromIntent: [
    'the workflow must support full regeneration from a clarified intent',
    (low) => low.includes('regenerate') || sameLine(low, ['rewrite', 'all']) || sameLine(low, ['all', 'from', 'clarified']) || sameLine(low, ['clarified', 'intent']),
  ],
  promptsClarifiedIntent: [
    'the workflow must prompt the user for a clarified intent during full regeneration',
    (low) => clarifiedIntent(low) || spaced(low, 'revised', 'intent') || sameLine(low, ['describe', 'revised']),
  ],
  validatesDependsOn: [
    'the workflow must validate depends_on references against the existing phases',
    (low) => sameLine(low, ['validate', 'depends']) || sameLine(low, ['depends', 'valid']) || sameLine(low, ['invalid', 'depends']),
  ],
  blocksInvalidReference: [
    'the workflow must block the write when depends_on references an invalid phase',
    (low) => sameLine(low, ['invalid', 'phase']) && anyOf(low, ['exit', 'block', 'error']),
  ],
  preventsSelfReference: [
    'the workflow must prevent a self-referencing depends_on',
    (low) => anyOf(low, ['circular', 'self-reference', 'itself']),
  ],
  checksPhaseStatus: [
    'the workflow must check the phase status before allowing an edit',
    (low) => low.includes('disk_status') || sameLine(low, ['phase', 'status']) || sameLine(low, ['status', 'check']),
  ],
  refusesInProgress: ['the workflow must refuse in_progress edits without --force', (low) => !low.includes('--force') || inProgress(low)],
  refusesCompleted: ['the workflow must refuse completed phase edits without --force', (low) => !low.includes('--force') || low.includes('completed')],
  allowsForce: ['the workflow must allow editing when --force is passed', forceAllowsEdit],
  errorsWhenPhaseMissing: [
    'the workflow must error clearly when the phase number does not exist',
    (low) => sameLine(low, ['not', 'found']) || low.includes('does not exist'),
  ],
  errorsOnMissingArgument: [
    'the workflow must error when the phase number argument is missing',
    (low) => sameLine(low, ['no', 'argument']) || low.includes('required'),
  ],
  showsDiff: [
    'the workflow must show a diff of the changes before writing',
    (low) => low.includes('diff') || sameLine(low, ['proposed', 'change']) || sameLine(low, ['show', 'change']),
  ],
  asksConfirmation: [
    'the workflow must ask for confirmation before writing',
    (low) => low.includes('confirm') || sameLine(low, ['apply', 'change']) || low.includes('y/n') || sameLine(low, ['yes', 'no']),
  ],
  exitsOnDecline: [
    'the workflow must exit without writing if the user declines the confirmation',
    (low) => sameLine(low, ['says', 'n']) || sameLine(low, ['if', 'user', 'n']) || sameLine(low, ['exit', 'without', 'writing']) || low.includes('without writing'),
  ],
  preservesNumber: [
    'the workflow must preserve the phase number and position',
    (low) => sameLine(low, ['number', 'preserved']) || sameLine(low, ['preserve', 'number']) || sameLine(low, ['position', 'preserved']) || low.includes('number and position'),
  ],
  writesInPlace: [
    'the workflow must write the phase back in place (section replacement)',
    (low) => sameLine(low, ['in', 'place']) || sameLine(low, ['replace', 'section']) || sameLine(low, ['section', 'replace']),
  ],
  updatesRoadmapEvolution: [
    'the workflow must update the STATE.md Roadmap Evolution after an edit',
    (low) => low.includes('state.add-roadmap-evolution') || low.includes('roadmap evolution'),
  ],
};

// The write_updated_phase step: the milestone scope probe before the write, the re-derivation and rollback after it.
const SCOPE_RULES = {
  capturesScopeBefore: ['write_updated_phase must run the roadmap milestone-scope probe before writing', (step) => step.includes('milestone-scope')],
  namesScopeBefore: ['the pre-write capture must be named SCOPE_BEFORE for the post-write comparison', (step) => asciiLower(step).includes('scope_before')],
  rederivesScopeAfter: ['the post-write re-derivation (SCOPE_AFTER) must be present', (step) => asciiLower(step).includes('scope_after')],
  rollsBack: ['a scope or phase-set mismatch must trigger a rollback', (step) => anyOf(asciiLower(step), ['rollback', 'restore', 'revert', 'rolled back'])],
  surfacesScopeError: ['the rollback path must surface an explicit milestone scope changed error', (step) => asciiLower(step).includes('scope changed')],
};

// The row of the Workflows table whose first cell is `edit-phase.md`, read with the shared table splitter.
function editPhaseRow(inventoryText, splitTableRow) {
  for (const line of inventoryText.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitTableRow(line);
    if (cells && cells[0] === '`edit-phase.md`') return cells;
  }
  return null;
}

// /\/gsd-phase\s+--edit/ and /\/gsd-edit-phase\b/ over the "Invoked by" cell.
const citesPhaseEdit = (cell) => spaced(cell, '/gsd-phase', '--edit');
function citesDeletedCommand(cell) {
  const deleted = '/gsd-edit-phase';
  let at = cell.indexOf(deleted);
  while (at !== -1) {
    if (!isWordChar(cell[at + deleted.length])) return true;
    at = cell.indexOf(deleted, at + 1);
  }
  return false;
}

const isArray = Array.isArray;

function manifestFamily(text, family) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    return { error: `the manifest is not valid JSON: ${err.message}`, shared: true };
  }
  const families = manifest && typeof manifest === 'object' ? manifest.families : undefined;
  if (families === null || typeof families !== 'object' || isArray(families)) return { error: 'the manifest has no families mapping', shared: true };
  if (!isArray(families[family])) return { error: `families.${family} is not a list` };
  return { list: families[family] };
}

const loadTable = () => require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-table.cjs'));

// The contract is built over a loader of the shared table splitter, so a test can hand in one that throws.
function buildCheck(load) {
  return function check(ctx) {
    const command = ctx.doc(COMMAND);
    command.frontmatter()
      .satisfies(namesGsdPhase, 'the consolidated phase.md must have name gsd:phase (#2790)')
      .satisfies((text) => keyLineAt(text, 'description:') !== -1, 'the command must have a description in its frontmatter');
    command
      .has('edit-phase.md', 'the command must reference the edit-phase workflow')
      .satisfies((text) => text.includes('--edit') || text.includes('--force'), 'the command must document the --edit flag (which supports --force)');

    const workflow = ctx.doc(WORKFLOW)
      .satisfies((text) => lower(text).includes('--force'), 'the workflow must handle the --force flag');
    for (const [, [why, test]] of Object.entries(RULES)) workflow.satisfies((text) => test(lower(text)), why);
    workflow.satisfies((text) => {
      const block = antiPatternsBlockRenumbering(lower(text));
      if (block.missing) return 'no <anti_patterns> section';
      return block.ok || 'the anti_patterns section must prohibit renumbering';
    }, 'the workflow must have an <anti_patterns> section that blocks renumbering');
    const step = workflow.step('write_updated_phase');
    for (const [, [why, test]] of Object.entries(SCOPE_RULES)) step.satisfies(test, why);
    workflow.slice('<success_criteria>', '</success_criteria>')
      .satisfies((text) => asciiLower(text).includes('milestone scope'), 'the success criteria must include the milestone-scope verification (#3262)');

    const inventory = ctx.doc(INVENTORY);
    const table = loadLib(load, 'gsd-core/bin/lib/markdown-table.cjs');
    if (table.error) {
      ctx.fail('gsd-core/bin/lib/markdown-table.cjs', table.error);
      inventory.has('edit-phase.md', 'INVENTORY.md must contain the edit-phase.md workflow row');
    } else {
      inventory.satisfies((text) => {
        const row = editPhaseRow(text, table.lib.splitTableRow);
        if (row === null) return 'no edit-phase.md workflow row';
        const invokedBy = row[2] ?? '';
        if (!citesPhaseEdit(invokedBy)) return `the Invoked by cell is "${invokedBy}"`;
        return !citesDeletedCommand(invokedBy) || `the Invoked by cell still cites the deleted /gsd-edit-phase command: "${invokedBy}"`;
      }, 'the edit-phase.md row must list "/gsd-phase --edit" as its caller and not the deleted /gsd-edit-phase (#2790)');
    }

    ctx.doc(MANIFEST).satisfies((text) => {
      const family = manifestFamily(text, 'commands');
      if (family.error) return family.error;
      return family.list.includes('/gsd-phase') || 'no /gsd-phase';
    }, 'INVENTORY-MANIFEST.json must list /gsd-phase in commands (it absorbed /gsd-edit-phase, #2790)')
      .satisfies((text) => {
        const family = manifestFamily(text, 'workflows');
        if (family.error) return family.shared ? true : family.error;
        return family.list.includes('edit-phase.md') || 'no edit-phase.md';
      }, 'INVENTORY-MANIFEST.json must list edit-phase.md in workflows');

    ctx.doc(COMMANDS_DOC).has('/gsd-phase', 'COMMANDS.md must document /gsd-phase (which absorbed /gsd-edit-phase via the --edit flag, #2790)');
  };
}

module.exports = {
  id: 'edit-phase',
  issue: '#2617',
  walkers: {
    RULES, SCOPE_RULES, lineSegments, sameLine, spaced, wordBounded, clarifiedIntent, inProgress, forceAllowsEdit, antiPatternsBlockRenumbering,
    namesGsdPhase, keyLineAt, editPhaseRow, citesPhaseEdit, citesDeletedCommand, manifestFamily, buildCheck,
  },
  check: buildCheck(loadTable),
};
