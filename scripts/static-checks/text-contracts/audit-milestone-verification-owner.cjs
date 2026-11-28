'use strict';

// /gsd-audit-milestone takes each phase's verification verdict from its owner, `verification.status` (#6812). Step 2
// reads it, and the owner's next step, each with a hard stop on a failure, and lists the owner's closed set
// (VERIFICATION_STATUS); `VERIFICATION_STATUS` is assigned by that read alone, and nothing in the workflow reads the
// report's own status (a `Status: passed` bullet or a `frontmatter.get --field status`). The step 5d matrix keys every
// row on a member of that set and has a row for each, with the verdict the matrix fixes for the members whose verdict
// depends on nothing else, and only a `passed` row gives satisfied; under `passed`, a `? NEEDS HUMAN` requirement row
// gives partial and a `✗ BLOCKED` one unsatisfied, with no catch-all `passed` row above them. The output schema's
// `verification_status` lists the same set plus the audit's own `orphaned`. The set is read from the owner, so a member
// it gains or loses is a finding here until the workflow follows.

const { loadLib } = require('./lib/load-lib.cjs');

const WORKFLOW = 'gsd-core/workflows/audit-milestone.md';
const OWNER = 'gsd-core/bin/lib/verification.cjs';
const TABLE = 'gsd-core/bin/lib/markdown-table.cjs';

// A read of the owner's `field` into `name`, stopping on a failure.
const ownerRead = (name, field) =>
  new RegExp(`^${name}=\\$\\(gsd_run query verification\\.status "[^"\\n]+" --pick ${field}\\) \\|\\| \\{ [^\\n]*exit 1; \\}$`, 'm');
const OWNER_READ = ownerRead('VERIFICATION_STATUS', 'status');
const NEXT_READS = [ownerRead('NEXT_ACTION', 'next_action'), ownerRead('NEXT_COMMAND', 'next_command')];
// Reads of the report's own status: a status bullet (bold or not) naming a status (quoted or not), or a frontmatter read
// of the field.
const RAW_STATUS_BULLET = /^[ \t]*[-*][ \t]+(?:\*\*)?Status(?::\*\*|\*\*:|:)[ \t]*[`"']?(?:passed|gaps_found)\b/im;
const RAW_STATUS_QUERY = /frontmatter\.get\b[^\n]*--field[ =]status\b/;
// The audit's own marker for a requirement no phase verified (step 5e), the one schema value outside the owner's set.
const ORPHANED = 'orphaned';
// The requirement rows of a `passed` report that override the report's status, with the verdict each gives.
const REPORT_ROWS = { '? NEEDS HUMAN': 'partial', '✗ BLOCKED': 'unsatisfied' };
// The catch-all Report Row cells: `any`, and `other` (any Status not named above it), so a `passed` row with one of them
// above a named report row catches that row first.
const CATCH_ALL = ['any', 'other'];

// The final verdict of a row: the bold word its last cell starts with.
const verdictOf = (row) => (/^\*\*([a-z]+)\*\*/.exec(row[row.length - 1]) || [])[1];

// The difference between two lists read as sets, or true when they hold the same values.
function sameSet(found, expected) {
  const extra = found.filter((value) => !expected.includes(value));
  const absent = expected.filter((value) => !found.includes(value));
  if (extra.length === 0 && absent.length === 0) return true;
  return [absent.length > 0 ? `missing ${absent.join(', ')}` : '', extra.length > 0 ? `not in the set: ${extra.join(', ')}` : '']
    .filter(Boolean)
    .join('; ');
}

// The 5d matrix body rows as cells with backticks dropped: the rows after its delimiter row (the header and the
// delimiter are not keyed on a status). A table without a delimiter row has no body rows.
function matrixRows(text, { splitTableRow, isDelimiterRow }) {
  const rows = text
    .split('\n')
    .filter((line) => /^\|.*\|$/.test(line.trim()))
    .map((line) => splitTableRow(line).map((cell) => cell.replace(/`/g, '')));
  const delimiter = rows.findIndex(isDelimiterRow);
  return delimiter === -1 ? [] : rows.slice(delimiter + 1);
}

// The problems of the matrix rows against the owner's set `S`.
function matrixProblems(rows, S) {
  const members = Object.values(S);
  // The members whose requirement verdict is fixed by the status alone; `passed` and `missing` also depend on the
  // report row and SUMMARY.
  const fixed = {
    [S.GAPS_FOUND]: 'unsatisfied',
    [S.HUMAN_NEEDED]: 'partial',
    [S.STALE]: 'partial',
    [S.UNPARSEABLE]: 'unsatisfied',
    [S.PHASE_DIR_NOT_FOUND]: 'unsatisfied',
  };
  const problems = [];
  for (const row of rows) {
    if (!members.includes(row[0])) problems.push(`row keyed on ${row[0]}, outside the set`);
    else if (row[0] !== S.PASSED && verdictOf(row) === 'satisfied') problems.push(`a ${row[0]} row gives satisfied`);
  }
  for (const m of members) {
    const own = rows.filter((row) => row[0] === m);
    if (own.length === 0) problems.push(`no row for ${m}`);
    else if (fixed[m] && own.some((row) => verdictOf(row) !== fixed[m])) problems.push(`${m} must give ${fixed[m]}`);
  }
  for (const [reportRow, verdict] of Object.entries(REPORT_ROWS)) {
    const at = rows.findIndex((row) => row[0] === S.PASSED && row[1] === reportRow);
    if (at === -1) problems.push(`no ${S.PASSED} row for a ${reportRow} requirement`);
    else if (verdictOf(rows[at]) !== verdict) problems.push(`a ${reportRow} requirement under ${S.PASSED} must give ${verdict}`);
    else if (rows.slice(0, at).some((row) => row[0] === S.PASSED && CATCH_ALL.includes(row[1]))) {
      problems.push(`a catch-all ${S.PASSED} row above the ${reportRow} row catches it first`);
    }
  }
  return problems;
}

// The contract with the owner and the table splitter loaded through the given loaders: a library that cannot be
// loaded is one finding naming it, and the workflow is not read.
function buildCheck({
  loadOwner = () => require('../../../gsd-core/bin/lib/verification.cjs'),
  loadTable = () => require('../../../gsd-core/bin/lib/markdown-table.cjs'),
} = {}) {
  return function check(ctx) {
    const owner = loadLib(loadOwner, OWNER);
    const table = loadLib(loadTable, TABLE);
    if (owner.error) ctx.fail(OWNER, owner.error);
    if (table.error) ctx.fail(TABLE, table.error);
    if (owner.error || table.error) return;
    const S = owner.lib.VERIFICATION_STATUS;
    const members = Object.values(S);
    const doc = ctx.doc(WORKFLOW);

    doc
      .slice('## 2. Read All Phase Verifications', '## 3. ')
      .has(OWNER_READ, 'step 2 must read each phase status from verification.status --pick status, stopping on a failure')
      .has(NEXT_READS[0], "step 2 must read the owner's next_action, stopping on a failure")
      .has(NEXT_READS[1], "step 2 must read the owner's next_command, stopping on a failure")
      .satisfies((text) => {
        const line = /^`VERIFICATION_STATUS` is one of ([^.\n]*)\./m.exec(text);
        if (!line) return 'no "`VERIFICATION_STATUS` is one of" line';
        return sameSet([...line[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]), members);
      }, "step 2 must list exactly the owner's closed set");

    doc.slice('### 5d. Status Determination Matrix', '### 5e.').satisfies((text) => {
      const problems = matrixProblems(matrixRows(text, table.lib), S);
      return problems.length === 0 || problems.join('; ');
    }, "the 5d matrix must key every row on the owner's closed set, with a row per member and the passed report rows");

    doc
      .lacks(RAW_STATUS_BULLET, "the workflow must not read the report's own Status line")
      .lacks(RAW_STATUS_QUERY, "the workflow must not read the report's own status field")
      .satisfies((text) => {
        // No assignment at all is step 2's finding (the owner read is gone).
        const count = (text.match(/\bVERIFICATION_STATUS=/g) || []).length;
        return count <= 1 || `VERIFICATION_STATUS is assigned ${count} times`;
      }, 'VERIFICATION_STATUS must be assigned by the owner read alone')
      .satisfies((text) => {
        const line = /^ *verification_status: "([^"\n]*)"$/m.exec(text);
        if (!line) return 'no verification_status line';
        return sameSet(line[1].split('|').map((value) => value.trim()), [...members, ORPHANED]);
      }, "the schema's verification_status must list exactly the owner's closed set and orphaned");
  };
}

module.exports = {
  id: 'audit-milestone-verification-owner',
  issue: '#6812',
  walkers: { matrixRows, matrixProblems, sameSet, buildCheck },
  check: buildCheck(),
};
