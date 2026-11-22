'use strict';

// The files `npm pack` would put in the tarball for a repository root, computed by reading the tree:
// no process is spawned, so a slow runner cannot fail a test whose subject is which files ship (#6498).
// Rules replicated from npm-packlist for a package with a `files` array and no nested ignore files:
// - an entry of `files` is a file or a directory (everything under it); `!entry` removes a path or a
//   directory from what the positive entries added;
// - always included: package.json, README*, LICENSE/LICENCE*, and the `main` and `bin` files;
// - always excluded: .git, .svn, .hg, CVS, node_modules, .DS_Store, ._*, *.orig, *.swp,
//   package-lock.json, yarn.lock, pnpm-lock.yaml, .npmrc, .lock-wscript, npm-debug.log.
// It fails closed: a package.json that is not JSON or has no `files` array, an unreadable directory
// and a symlink inside a packed directory all throw rather than shrink or change the list. A
// `.npmignore` or `.gitignore` below the root is not honoured, so one in a packed directory throws.

const fs = require('node:fs');
const path = require('node:path');

const ALWAYS_EXCLUDED_DIRS = new Set(['.git', '.svn', '.hg', 'CVS', 'node_modules']);
const ALWAYS_EXCLUDED_FILES = new Set([
  '.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.npmrc', '.lock-wscript', 'npm-debug.log',
]);

const isAlwaysExcludedFile = (name) =>
  ALWAYS_EXCLUDED_FILES.has(name) || name.startsWith('._') || name.endsWith('.orig') || name.endsWith('.swp');

const isAlwaysIncludedFile = (rel) =>
  rel === 'package.json' || /^(README|LICEN[CS]E)(\.[^/]*)?$/i.test(rel);

const normalise = (entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

function listPackedFiles(root) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (err) {
    throw new Error(`${root}: package.json cannot be read as JSON (${err.message})`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.every((f) => typeof f === 'string')) {
    throw new Error(`${root}: package.json has no files array of strings; this list needs one`);
  }
  const positive = manifest.files.filter((f) => !f.startsWith('!')).map(normalise);
  const negative = manifest.files.filter((f) => f.startsWith('!')).map((f) => normalise(f.slice(1)));
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin || {});
  const forced = new Set([manifest.main, ...bins].filter((f) => typeof f === 'string').map(normalise));
  const covers = (entry, rel) => rel === entry || rel.startsWith(`${entry}/`);

  const packed = new Set();
  const visit = (rel, isDirectory) => {
    const name = rel.split('/').pop();
    if (isDirectory) {
      if (ALWAYS_EXCLUDED_DIRS.has(name) || negative.some((n) => covers(n, rel))) return;
      for (const entry of readDir(path.join(root, rel))) {
        if (entry.name === '.npmignore' || entry.name === '.gitignore') {
          throw new Error(`${path.join(root, rel, entry.name)}: a nested ignore file; this list does not apply them`);
        }
        if (entry.isSymbolicLink()) {
          throw new Error(`${path.join(root, rel, entry.name)}: a symlink in a packed directory; the walk does not follow links`);
        }
        visit(`${rel}/${entry.name}`, entry.isDirectory());
      }
    } else if (!isAlwaysExcludedFile(name) && !negative.some((n) => covers(n, rel))) {
      packed.add(rel);
    }
  };
  const readDir = (dir) => fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of positive) {
    let stat;
    try { stat = fs.lstatSync(path.join(root, entry)); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue; // npm skips an entry that matches nothing
      throw err;
    }
    if (stat.isSymbolicLink()) throw new Error(`${path.join(root, entry)}: a symlinked files entry; the walk does not follow links`);
    visit(entry, stat.isDirectory());
  }
  for (const rel of fs.readdirSync(root)) {
    if (isAlwaysIncludedFile(rel) && fs.lstatSync(path.join(root, rel)).isFile()) packed.add(rel);
  }
  for (const rel of forced) {
    if (fs.existsSync(path.join(root, rel)) && fs.lstatSync(path.join(root, rel)).isFile()) packed.add(rel);
  }
  return packed;
}

module.exports = { listPackedFiles };
