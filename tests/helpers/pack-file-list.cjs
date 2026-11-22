'use strict';

// The files `npm pack` would put in the tarball for a repository root, computed by reading the tree:
// no process is spawned, so a slow runner cannot fail a test whose subject is which files ship (#6498).
// It reads the tree as it is, so a built tree (npm run build:lib) is a precondition: the compiled
// gsd-core/bin/lib files are gitignored and exist only after the build. Rules (verified against npm 11):
// - an entry of `files` is a plain file or directory path (everything under it); `!dir/entry` removes
//   a path or directory from what the positive entries added;
// - always included: root package.json, README*, LICENSE*, LICENCE*, COPYING*, and the main/bin files;
// - excluded at any depth: .git, .svn, .hg, CVS, .npmrc, .DS_Store, ._*, *.orig, .*.swp, .wafpickle-*,
//   .lock-wscript, npm-debug.log; excluded at the root only: node_modules and the lock files
//   (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb), which npm packs when nested.
// It fails closed where npm's behaviour is not reproduced: a package.json that is not JSON or has no
// `files` array, a glob in an entry or a slash-less `!` entry, an unreadable directory, a symlink, a
// nested ignore file and a nested node_modules directory in a packed directory all throw.

const fs = require('node:fs');
const path = require('node:path');

const ALWAYS_EXCLUDED_DIRS = new Set(['.git', '.svn', '.hg', 'CVS']);
const ALWAYS_EXCLUDED_FILES = new Set(['.npmrc', '.DS_Store', '.lock-wscript', 'npm-debug.log']);
const ROOT_EXCLUDED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);

const isExcludedFile = (name, rel) =>
  ALWAYS_EXCLUDED_FILES.has(name) || name.startsWith('._') || name.startsWith('.wafpickle-')
  || name.endsWith('.orig') || /^\.[^/]{1,255}\.swp$/.test(name)
  || (!rel.includes('/') && ROOT_EXCLUDED_FILES.has(name));

const isAlwaysIncludedFile = (rel) => rel === 'package.json' || /^(README|LICEN[CS]E|COPYING)(\.[^/]{0,255})?$/i.test(rel);

const GLOB_CHARACTERS = /[*?[\]{}()]/;
const normalise = (entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

function listPackedFiles(root) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (err) {
    throw new Error(`${root}: package.json cannot be read as JSON (${err.message})`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.every((f) => typeof f === 'string')) {
    throw new Error(`${root}: package.json has no files array of strings; this list needs one`);
  }
  for (const f of manifest.files) {
    const bare = f.startsWith('!') ? f.slice(1) : f;
    if (GLOB_CHARACTERS.test(bare)) throw new Error(`${root}: files entry "${f}" is a glob; this list reads plain paths only`);
    if (f.startsWith('!') && !normalise(bare).includes('/')) {
      throw new Error(`${root}: files entry "${f}" is a slash-less exclusion, which npm applies at any depth; this list needs a path`);
    }
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
      if (rel === 'node_modules' || ALWAYS_EXCLUDED_DIRS.has(name) || negative.some((n) => covers(n, rel))) return;
      for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const where = path.join(root, rel, entry.name);
        if (entry.name === '.npmignore' || entry.name === '.gitignore') {
          throw new Error(`${where}: a nested ignore file; this list does not apply them`);
        }
        if (entry.isSymbolicLink()) throw new Error(`${where}: a symlink in a packed directory; the walk does not follow links`);
        if (entry.name === 'node_modules') throw new Error(`${where}: a nested node_modules directory; this list does not model bundled dependencies`);
        visit(`${rel}/${entry.name}`, entry.isDirectory());
      }
    } else if (!isExcludedFile(name, rel) && !negative.some((n) => covers(n, rel))) {
      packed.add(rel);
    }
  };

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
