'use strict';

// Atomic write usage (#1972): milestone.cjs, phase.cjs and frontmatter.cjs (built into gsd-core/bin/lib) contain no
// bare fs.writeFileSync call targeting .planning/ files; every such write goes through platformWriteSync, the
// shell-projection seam's atomic writer, so a crash cannot leave a partial planning artifact. Allowed exceptions are
// writes to .gitkeep (empty files) and to archive directories (new files, not read-modify-write). Each file imports
// from shell-command-projection.cjs and calls platformWriteSync at least once. This is structural: only source
// inspection tells platformWriteSync from a bare fs.writeFileSync. Was tests/atomic-write-coverage.test.cjs.

const FILES = ['milestone.cjs', 'phase.cjs', 'frontmatter.cjs'];

// The disallowed bare writes of a file: `fs.writeFileSync(` lines that are not a .gitkeep or archiveDir write.
function disallowedBareWrites(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (/\bfs\.writeFileSync\s{0,20}\(/.test(line) && !/\.gitkeep/.test(line) && !/archiveDir/.test(line)) {
      found.push(`line ${i + 1}: ${line.trim()}`);
    }
  });
  return found;
}

module.exports = {
  id: 'atomic-write-coverage',
  issue: '#1972',
  check(ctx) {
    for (const file of FILES) {
      ctx.doc(`gsd-core/bin/lib/${file}`)
        .satisfies((text) => {
          const found = disallowedBareWrites(text);
          return found.length === 0 || found.join('; ');
        }, `${file} must not contain a bare fs.writeFileSync targeting planning files (use platformWriteSync)`)
        // The hand-written destructure form and the tsc-compiled namespace form both require this module.
        .has(/require\(['"]\.\/shell-command-projection\.cjs['"]\)/, `${file} must import from shell-command-projection.cjs`)
        // The hand-written call `platformWriteSync(path, content)` and the tsc-compiled `(0, x.platformWriteSync)(path, content)`.
        .has(/platformWriteSync[\s)]{0,50}\(/, `${file} must contain at least one platformWriteSync call`);
    }
  },
};
