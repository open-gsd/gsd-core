'use strict';

// The todos/done to todos/completed rename (#2491): the canonical archive dir is todos/completed, so no workflow or
// doc prose may reference the retired todos/done path, which would steer closed todos into a directory nothing in
// gsd-core reads. A line is exempt when it names the retired PACKAGE (the gsd-core predecessor) or carries a
// `gsd-allow-legacy-name` marker; installer-migrations.md is a historical record and is skipped. The package name is
// built by concatenation so the legacy-dir-name lint does not flag this file. Was tests/todos-done-rename-guard.test.cjs.

const LEGACY_PKG = 'get-shit' + '-done';

function staleTodosDoneRefs(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('done/') && !line.includes(LEGACY_PKG) && !line.includes('gsd-allow-legacy-name')) {
      found.push(`line ${i + 1}: ${line.trim()}`);
    }
  });
  return found;
}

module.exports = {
  id: 'todos-done-rename-guard',
  issue: '#2491',
  check(ctx) {
    for (const dir of ['gsd-core/workflows', 'docs']) {
      for (const rel of ctx.list(dir, '.md', 'the workflows and docs are what the rename guard scans')) {
        if (rel.endsWith('installer-migrations.md')) continue;
        ctx.doc(rel).satisfies((text) => {
          const found = staleTodosDoneRefs(text);
          return found.length === 0 || found.join('; ');
        }, 'a stale todos/done reference: the canonical archive dir is todos/completed (src/commands.cts cmdTodoComplete); fix it to completed/, or mark a genuine historical reference with a gsd-allow-legacy-name comment');
      }
    }
  },
};
