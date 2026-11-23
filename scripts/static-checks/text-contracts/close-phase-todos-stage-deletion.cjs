'use strict';

// execute-phase's close_phase_todos step stages the pending/ deletion alongside the completed/ destination (#2415)
// and, since #4208, names each moved todo instead of passing the two directories to --files: destinations ride the
// ADDED array under --files and the source-side deletions the REMOVED array under --files-removed (a --files entry
// alone cannot record a deletion, #2014). The step moves with plain `mv`, not `git mv`, so untracked todos and
// non-git .planning dirs still work. cleanup.md routes its moved-away archive directories through --files-removed,
// not --files, while the destinations and STATE.md stay under --files. Was tests/close-phase-todos-stage-deletion.test.cjs.

// The `gsd_run query commit ... --files <list>` capture of a step body.
const filesListOf = (stepBody) => /gsd_run\s{1,20}query\s{1,20}commit\b[^\n]{0,2000}--files\s{1,20}([^\n]{1,2000})/.exec(stepBody);

// The step body with bash comment lines removed, so a rationale comment naming `git mv` does not count.
const withoutComments = (stepBody) => stepBody.replace(/^[ \t]{0,200}#[^\n]{0,2000}$/gm, '');

// `git mv` as two consecutive words, however much whitespace (spaces, tabs, newlines) lies between them: a linear
// walk over the words, so a long gap cannot hide the command. `git` and `mv` keep the word boundaries of `\bgit` and `mv\b`.
function hasGitMv(text) {
  const isWord = (ch) => ch !== undefined && /\w/.test(ch);
  const words = [];
  let current = '';
  for (const ch of text) {
    if (/\s/.test(ch)) { // any whitespace (non-breaking space, U+2028, U+3000 included), as the old `\s` was
      if (current !== '') words.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') words.push(current);
  for (let i = 0; i + 1 < words.length; i++) {
    const git = words[i];
    const mv = words[i + 1];
    if (git.endsWith('git') && !isWord(git[git.length - 4]) && mv.startsWith('mv') && !isWord(mv[2])) return true;
  }
  return false;
}

// The cleanup.md archive commit line, split into the --files half and the --files-removed half.
function archiveCommit(text) {
  const line = text.split('\n').find((l) => /gsd_run\s{1,20}query\s{1,20}commit\b/.test(l) && l.includes('--files-removed'));
  if (!line) return { error: 'cleanup.md must commit the archive via gsd_run query commit ... --files-removed' };
  const [added, removed] = line.split('--files-removed');
  return { line, added, removed };
}

const onArchive = (check) => (text) => {
  const archive = archiveCommit(text);
  return archive.error || check(archive);
};

module.exports = {
  id: 'close-phase-todos-stage-deletion',
  issue: '#2415',
  check(ctx) {
    const step = ctx.doc('gsd-core/workflows/execute-phase.md').step('close_phase_todos');
    step
      .satisfies((body) => {
        const match = filesListOf(body);
        if (!match) return 'no gsd_run query commit ... --files invocation';
        const list = match[1];
        if (!/"\$\{ADDED\[@\]\}"/.test(list)) return 'commit --files does not carry the ADDED array';
        if (!/--files-removed\s{1,20}"\$\{REMOVED\[@\]\}"/.test(list)) return 'no --files-removed "${REMOVED[@]}"';
        return /\{state_path\}/.test(list) || 'no {state_path} placeholder';
      }, 'close_phase_todos must stage the completed/ destinations (ADDED under --files), the pending/ deletions (REMOVED under --files-removed) and the {state_path} STATE.md placeholder')
      .has(/ADDED\+=\("\$COMPLETED_DIR\/\$f"\)/, 'ADDED must be built from $COMPLETED_DIR, the destination of the move')
      .has(/REMOVED\+=\("\$PENDING_DIR\/\$f"\)/, 'REMOVED must be built from $PENDING_DIR, the source whose deletion #2415 requires')
      .satisfies((body) => /\bmv\s{1,20}"\$TODO_FILE"\s{1,20}"\$COMPLETED_DIR\/"/.test(withoutComments(body)) || 'no plain mv of $TODO_FILE', 'close_phase_todos must use plain shell mv to move the file')
      .satisfies((body) => !hasGitMv(withoutComments(body)) || 'a git mv command', 'close_phase_todos must NOT use git mv as the move command: it fails on untracked todos and on non-git .planning dirs');

    ctx.doc('gsd-core/workflows/cleanup.md')
      .satisfies(onArchive((archive) => {
        for (const dir of ['${PLANNING_ROOT}/phases/', '${PLANNING_ROOT}/quick/']) {
          if (!archive.removed.includes(dir)) return `${dir} is not under --files-removed`;
          if (archive.added.includes(dir)) return `${dir} is under --files`;
        }
        return true;
      }), 'the archive commit must route the moved-away directories through --files-removed, not --files (a directory under --files sweeps in concurrent writes)')
      .satisfies(onArchive((archive) => {
        if (!/--files\s/.test(archive.added)) return 'the additive half does not carry --files';
        if (!archive.added.includes('${PLANNING_ROOT}/milestones/')) return 'the milestones destination is not under --files';
        return archive.added.includes('${PLANNING_ROOT}/STATE.md') || 'STATE.md is not under --files';
      }), 'the destinations and STATE.md must stay under --files, which cannot record a deletion');
  },
};
