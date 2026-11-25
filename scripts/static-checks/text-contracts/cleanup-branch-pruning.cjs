'use strict';

// /gsd-cleanup prunes local branches whose upstream is gone (#40): cleanup.md has a prune_local_branches step between
// archive_phases and commit that finds them with `git branch -vv`, deletes them with `git branch -D`, handles an empty
// list (`xargs -r`), excludes the current-branch marker and the protected names, and does not re-run `git fetch --prune`
// (show_dry_run already did, so the confirmed list and the deletion share one tracking-ref state); show_dry_run lists
// the gone-upstream branches and covers archiving and pruning in its prompt; report counts pruned branches;
// identify_completed_milestones runs no git branch; archive_phases is untouched. The shell reading of a fenced block
// (comment, `&&`/`||`/`;` split, assignment and command-substitution prefixes, trailing parentheses, whitespace words)
// is the test's regex chain as linear scans. Fenced blocks come from the sectionizer's fence rules (the test took any
// line starting with three backticks as a fence line, in both directions). Was tests/cleanup-branch-pruning.test.cjs.

const FILE = 'gsd-core/workflows/cleanup.md';
const TERMINATORS = /[\r\n\u2028\u2029]/;

const isBlank = (char) => char !== undefined && /\s/.test(char);

// The body of `<step name="X">` ... `</step>`, else of `<X>` ... `</X>`, else null.
function namedBlock(markdown, name) {
  const openStep = `<step name="${name}">`;
  let start = markdown.indexOf(openStep);
  if (start !== -1) {
    const end = markdown.indexOf('</step>', start + openStep.length);
    if (end !== -1) return markdown.slice(start + openStep.length, end);
  }
  const openBare = `<${name}>`;
  start = markdown.indexOf(openBare);
  if (start === -1) return null;
  const end = markdown.indexOf(`</${name}>`, start + openBare.length);
  return end === -1 ? null : markdown.slice(start + openBare.length, end);
}

const { loadLib } = require('./lib/load-lib.cjs');

const SECTIONIZER = 'gsd-core/bin/lib/markdown-sectionizer.cjs';
const loadSectionizer = () => require('../../../gsd-core/bin/lib/markdown-sectionizer.cjs');

// The bodies of the closed fenced blocks of a block, found by the sectionizer's fence rules over the left-trimmed lines
// (the test took a fence line at any indentation, so the lines go in without their leading blanks), or the reason the
// sectionizer cannot be loaded.
function fencedBodies(block, load = loadSectionizer) {
  const loaded = loadLib(load, SECTIONIZER);
  if (loaded.error) return { error: loaded.error };
  const lines = block.split('\n').map((line) => line.trimStart());
  return { bodies: loaded.lib.scanFencedBlocks(lines).filter((record) => record.closeLineIdx !== -1).map((record) => lines.slice(record.openLineIdx + 1, record.closeLineIdx).join('\n')) };
}

// The line without its `#` comment: the first `#` after the last line terminator (the old `#.*$` with `.` stopping at one).
function withoutComment(line) {
  let last = -1;
  for (let i = 0; i < line.length; i += 1) if (TERMINATORS.test(line[i])) last = i;
  const at = line.indexOf('#', last + 1);
  return at === -1 ? line : line.slice(0, at);
}

// The line split at `&&`, `||` and `;`.
function splitOperators(line) {
  const parts = [];
  let from = 0;
  let i = 0;
  while (i < line.length) {
    if (line.startsWith('&&', i) || line.startsWith('||', i)) {
      parts.push(line.slice(from, i));
      i += 2;
      from = i;
    } else if (line[i] === ';') {
      parts.push(line.slice(from, i));
      i += 1;
      from = i;
    } else {
      i += 1;
    }
  }
  parts.push(line.slice(from));
  return parts;
}

// `NAME=value` read as `value` (a value holding a line terminator is not read).
function afterAssignment(part) {
  if (!/[A-Za-z_]/.test(part[0] ?? '')) return part;
  let at = 1;
  while (at < part.length && /[A-Za-z0-9_]/.test(part[at])) at += 1;
  if (part[at] !== '=') return part;
  const value = part.slice(at + 1);
  return TERMINATORS.test(value) ? part : value;
}

// `$(command)` or `$(command` read as `command`.
function afterSubstitution(text) {
  if (!text.startsWith('$(')) return text;
  const rest = text.slice(2);
  const body = rest.endsWith(')') ? rest.slice(0, -1) : rest;
  return TERMINATORS.test(body) ? text : body;
}

// The text without a trailing run of `)` and the blanks after it.
function withoutTrailingParens(text) {
  let end = text.length;
  while (end > 0 && isBlank(text[end - 1])) end -= 1;
  let at = end;
  while (at > 0 && text[at - 1] === ')') at -= 1;
  return (at === end ? text : text.slice(0, at)).trim();
}

// The words of each statement of a script.
function shellStatements(script) {
  const statements = [];
  for (const raw of script.split('\n')) {
    const line = withoutComment(raw).trim();
    if (!line) continue;
    for (const part of splitOperators(line)) {
      let text = part.trim();
      if (!text) continue;
      text = afterAssignment(text);
      text = afterSubstitution(text);
      if (text.startsWith('$(')) text = text.slice(2);
      text = withoutTrailingParens(text);
      if (!text) continue;
      const words = [];
      let word = '';
      for (const char of text) {
        if (isBlank(char)) {
          if (word) words.push(word);
          word = '';
        } else {
          word += char;
        }
      }
      if (word) words.push(word);
      statements.push(words);
    }
  }
  return statements;
}

// The shell statements of the fenced blocks of a block, or the reason they cannot be read.
function statementsOf(block, load) {
  const found = fencedBodies(block, load);
  return found.error ? { error: found.error } : { statements: found.bodies.flatMap((body) => shellStatements(body)) };
}
const isFetchPrune = (cmd) => cmd[0] === 'git' && cmd[1] === 'fetch' && (cmd.includes('--prune') || cmd.includes('-p'));
const isBranchWith = (...flags) => (cmd) => cmd[0] === 'git' && cmd[1] === 'branch' && flags.some((flag) => cmd.includes(flag));
const isAnyBranch = (cmd) => cmd[0] === 'git' && cmd[1] === 'branch';


// The contract over a loader of the sectionizer: a test hands in one that throws.
const buildCheck = (load) => (ctx) => {
  // A cause shared by several assertions (a block that is missing, a library that cannot be loaded) is reported once.
  const seen = new Set();
  const once = (message) => {
    if (seen.has(message)) return true;
    seen.add(message);
    return message;
  };
  // An assertion over a named block: the block must exist and be non-empty (the test's assert.ok(block)).
  const onBlock = (name, check) => (text) => {
    const block = namedBlock(text, name);
    return block ? check(block) : once(`the <${name}> block is missing`);
  };
  // A step that is not in <process>: the same cause as a block that is missing, reported once under either message.
  const stepMissing = (name, message) => {
    const key = `the <${name}> block is missing`;
    if (seen.has(key)) return true;
    seen.add(key);
    return message;
  };
  // An assertion over the shell statements of the fenced blocks of a block.
  const withShell = (check) => (block) => {
    const found = statementsOf(block, load);
    return found.error ? once(found.error) : check(found.statements);
  };
  ctx.doc(FILE)
    .satisfies(onBlock('prune_local_branches', () => true), 'cleanup.md must contain a <prune_local_branches> step')
    .satisfies(onBlock('show_dry_run', withShell((statements) => statements.some(isFetchPrune) || 'it runs no git fetch --prune')), 'show_dry_run must run `git fetch --prune` so the candidate list matches the execution step')
    .satisfies(onBlock('prune_local_branches', withShell((statements) => !statements.some(isFetchPrune) || 'it runs git fetch --prune')), 'prune_local_branches must not re-run `git fetch --prune` (a TOCTOU window between the confirmed list and the deletion)')
    .satisfies(onBlock('prune_local_branches', withShell((statements) => statements.some(isBranchWith('-vv', '--verbose')) || 'it runs no git branch -vv')), 'prune_local_branches must run `git branch -vv` to find branches with a gone upstream')
    .satisfies(onBlock('prune_local_branches', withShell((statements) => statements.some(isBranchWith('-D', '--delete')) || 'it runs no git branch -D')), 'prune_local_branches must run `git branch -D` to delete stale local branches')
    .satisfies(onBlock('prune_local_branches', (block) => block.includes('xargs -r') || block.includes('xargs --no-run-if-empty') || 'no xargs -r'), 'prune_local_branches must use `xargs -r` to handle an empty branch list safely')
    .satisfies(onBlock('process', (block) => {
      const archive = block.indexOf('<step name="archive_phases">');
      const prune = block.indexOf('<step name="prune_local_branches">');
      const commit = block.indexOf('<step name="commit">');
      if (archive === -1) return stepMissing('archive_phases', 'the archive_phases step is missing');
      if (commit === -1) return stepMissing('commit', 'the commit step is missing');
      if (prune === -1) return stepMissing('prune_local_branches', 'the prune_local_branches step is missing');
      return (archive < prune && prune < commit) || 'the order is not archive_phases, prune_local_branches, commit';
    }), 'prune_local_branches must appear between archive_phases and commit in <process>')
    .satisfies(onBlock('show_dry_run', (block) => block.includes(': gone') || block.includes('gone]') || block.includes('upstream is gone') || 'no gone-upstream mention'), 'show_dry_run must mention gone-upstream branches in the dry-run summary')
    .satisfies(onBlock('show_dry_run', (block) => (block.includes('archive') && (block.includes('prune') || block.includes('branch'))) || 'it covers archiving and pruning'), 'the confirmation prompt must cover both phase archival and branch pruning')
    .satisfies(onBlock('report', (block) => block.includes('Pruned') || block.includes('pruned') || 'no pruned count'), 'the report step must include the pruned-branch count in the final summary')
    .satisfies(onBlock('prune_local_branches', (block) => block.includes('$1 != "*"') || block.includes('$1!="*"') || block.includes('$1 !~') || block.includes('!/^\\*/')
      || block.includes('!/^\\*') || block.includes('--format') || (block.includes('sed') && block.includes('\\*')) || 'no guard against the * marker'), 'the prune_local_branches awk must explicitly exclude the current-branch marker (`*`), so git branch -D is never passed `*`')
    .satisfies(onBlock('identify_completed_milestones', withShell((statements) => !statements.some(isAnyBranch) || 'it runs a git branch command')), 'identify_completed_milestones must not run git branch commands: branch detection belongs in show_dry_run')
    .satisfies(onBlock('prune_local_branches', (block) => block.includes('"main"') || block.includes("'main'") || block.includes('^main$') || block.includes('^main|') || 'main is not excluded'), 'the prune_local_branches awk must exclude "main" from the deletion candidates')
    .satisfies(onBlock('prune_local_branches', (block) => block.includes('"next"') || block.includes("'next'") || block.includes('^next$') || block.includes('^next|')
      || block.includes('"trunk"') || block.includes("'trunk'") || block.includes('^trunk$') || block.includes('^trunk|') || 'neither next nor trunk is excluded'), 'the prune_local_branches awk must exclude the integration branch names (next or trunk)')
    .satisfies(onBlock('archive_phases', (block) => (block.includes('mv') && (block.includes('.planning/phases/') || block.includes('phases/'))) || 'it no longer moves phase directories under .planning/phases/'), 'the original archive_phases step must still exist and move phase directories');
};

module.exports = {
  walkers: { namedBlock, shellStatements, fencedBodies },
  id: 'cleanup-branch-pruning',
  issue: '#40',
  check: buildCheck(loadSectionizer),
  withLoader: (load) => ({ id: 'cleanup-branch-pruning', issue: '#40', check: buildCheck(load) }),
};
