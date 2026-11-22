'use strict';

// The files `npm pack` would put in the tarball for a repository root, computed by reading the tree:
// no process is spawned, so a slow runner cannot fail a test whose subject is which files ship (#6498).
// It reads the tree as it is, so a built tree (npm run build:lib) is a precondition: the compiled
// gsd-core/bin/lib files are gitignored and exist only after the build. Rules (checked against npm 11):
// - an entry of `files` is a plain file or directory path (everything under it); `!dir/entry` removes
//   a path or directory from what the positive entries added;
// - a files entry that names a file packs it even when a default or a `!` rule would exclude it;
// - always included: root package.json, README*, LICENSE*, LICENCE*, COPYING*, and the main/bin files;
// - excluded at any depth, as a file or a directory: .git, .svn, .hg, CVS, .npmrc, .DS_Store, ._*,
//   *.orig, .*.swp, .wafpickle-*, .lock-wscript, npm-debug.log, archived-packages, build/config.gypi;
// - excluded at the root only: node_modules and the lock files (package-lock.json, yarn.lock,
//   pnpm-lock.yaml, bun.lockb), which npm packs when nested.
// It fails closed where npm's behaviour is not reproduced: a package.json that is not JSON or has no
// `files` array, a glob, a backslash, the root or a path leaving it in an entry, a slash-less `!` entry,
// a path both included and excluded, browser/bundleDependencies/workspaces, an unreadable directory,
// a symlink, a nested ignore file and a nested node_modules directory in a packed directory all throw.
// A file or directory name containing `*` is dropped, as npm drops it.

const fs = require('node:fs');
const path = require('node:path');

const EXCLUDED_NAMES = new Set(['.git', '.svn', '.hg', 'cvs', '.npmrc', '.ds_store', '.lock-wscript', 'npm-debug.log']);
// ASCII-only lower-casing: String.toLowerCase also folds characters such as the Kelvin sign into ASCII letters.
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const ROOT_EXCLUDED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);

// Name-based defaults, applied to a file or a directory name at any depth (a directory so named is
// pruned with its contents); the lock files are excluded at the root only.
// npm matches every name rule case-insensitively (ignore-walk sets nocase), so each is compared lower-cased.
const isExcludedName = (rawName, rawRel, isDirectory = true) => {
  const name = lower(rawName);
  const rel = lower(rawRel);
  // npm's `/archived-packages/**` matches a directory of that name only, never a file.
  return EXCLUDED_NAMES.has(name) || (isDirectory && name === 'archived-packages') || rel === 'build/config.gypi' || rel.endsWith('/build/config.gypi')
    || name.startsWith('._') || name.startsWith('.wafpickle-') || name.endsWith('.orig') || /^\.[^/]{0,255}\.swp$/.test(name);
};
// npm's strict rules (/.git, /node_modules, the lock files) are plain rules: they drop a root file or directory of that name.
const isRootExcluded = (rel) => ROOT_EXCLUDED_FILES.has(lower(rel)) || ['.git', 'node_modules'].includes(lower(rel));

// npm's '!/readme{,.*[^~$]}': the stem alone, or a dot, then at least one more character, the last not ~ or $.
const isAlwaysIncludedFile = (rel) => rel === 'package.json' || /^(README|LICEN[CS]E|COPYING)(\.[^/]{0,255}[^~$/])?$/i.test(rel);

const GLOB_CHARACTERS = /[*?[\]{}()]/;
const normalise = (entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

// The only spelling of a path this list reads: names of word characters, dots and dashes, joined by single
// slashes, with at most one leading "./". Anything else (a trailing slash, a "." or empty segment, a space)
// is read differently by npm and fs, so it throws.
const PLAIN_PATH = /^(?:\.\/)?[\w.-]{1,255}(?:\/[\w.-]{1,255}){0,40}$/;
function assertPlainPath(raw, what) {
  const segments = raw.replace(/^\.\//, '').split('/');
  if (!PLAIN_PATH.test(raw) || segments.some((s) => s === '.' || s === '..')) {
    throw new Error(`${what} is not a plain path (names of letters, digits, "_", "." and "-" joined by single slashes); this list reads those only`);
  }
}

function listPackedFiles(root) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (err) {
    throw new Error(`${root}: package.json cannot be read as JSON (${err.message})`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.every((f) => typeof f === 'string')) {
    throw new Error(`${root}: package.json has no files array of strings; this list needs one`);
  }
  for (const key of ['browser', 'bundleDependencies', 'bundledDependencies', 'workspaces', 'directories']) {
    if (manifest[key] !== undefined) throw new Error(`${root}: package.json sets "${key}", which this list does not model`);
  }
  const seen = new Set();
  const exclusionsSoFar = [];
  for (const f of manifest.files) {
    const bare = f.startsWith('!') ? f.slice(1) : f;
    // npm applies the entries by position, with repeated `!` stripped and each rule trimmed and split on
    // newlines; this list models single `!path` exclusions, none of which precedes an inclusion covering it.
    if (bare.startsWith('!') || bare !== bare.trim() || /[\r\n]/.test(bare) || bare.startsWith('#')) {
      throw new Error(`${root}: files entry "${f}" has a repeated "!", surrounding whitespace, a newline or a leading "#"; this list reads plain paths only`);
    }
    const here = normalise(bare).toLowerCase();
    if (!f.startsWith('!') && exclusionsSoFar.some((n) => n === here || n.startsWith(`${here}/`) || here.startsWith(`${n}/`))) {
      throw new Error(`${root}: files entry "${f}" follows an exclusion inside it or around it; npm applies entries by position and this list needs the inclusion first`);
    }
    if (f.startsWith('!')) exclusionsSoFar.push(here);
    if (bare.includes('\\') && !path.isAbsolute(bare)) throw new Error(`${root}: files entry "${f}" has a backslash, which npm reads differently on each platform`);
    const key = `${f.startsWith('!')}:${normalise(bare).toLowerCase()}`;
    if (seen.has(`${!f.startsWith('!')}:${normalise(bare).toLowerCase()}`)) {
      throw new Error(`${root}: files entry "${normalise(bare)}" is both included and excluded; npm resolves that by position and this list does not`);
    }
    seen.add(key);
    if (path.isAbsolute(bare) || normalise(bare).split('/').includes('..')) {
      throw new Error(`${root}: files entry "${f}" leaves the package root; this list reads paths below it only`);
    }
    if (['', '.'].includes(normalise(bare))) throw new Error(`${root}: files entry "${f}" names the package root; this list needs a path below it`);
    if (GLOB_CHARACTERS.test(bare)) throw new Error(`${root}: files entry "${f}" is a glob; this list reads plain paths only`);
    if (f.startsWith('!') && !normalise(bare).includes('/')) {
      throw new Error(`${root}: files entry "${f}" is a slash-less exclusion, which npm applies at any depth; this list needs a path`);
    }
    if (f.startsWith('!') && bare.startsWith('./')) {
      throw new Error(`${root}: files entry "${f}" is an exclusion spelled with ./, which npm does not strip; this list needs the plain path`);
    }
    assertPlainPath(bare, `files entry "${f}"`);
  }
  // npm normalises `bin` first (a string needs the package name, an array keeps one target per base name, keys
  // become base names); this list reads only the object form with plain keys.
  if (manifest.main !== undefined && typeof manifest.main !== 'string') {
    throw new Error(`${root}: package.json "main" is not a string; npm forces any truthy value as a file name and this list does not`);
  }
  if (manifest.bin !== undefined) {
    const plainKey = (k) => /^[\w.-]{1,255}$/.test(k) && k !== '.' && k !== '..';
    if (typeof manifest.bin !== 'object' || manifest.bin === null || Array.isArray(manifest.bin) || !Object.keys(manifest.bin).every(plainKey)
      || !Object.values(manifest.bin).every((v) => typeof v === 'string')) {
      throw new Error(`${root}: package.json "bin" is not an object with plain keys; this list does not model npm's normalisation of it`);
    }
  }
  for (const target of [manifest.main,...(typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin || {}))]) {
    if (typeof target === 'string' && !path.isAbsolute(target) && !normalise(target).split('/').includes('..')) {
      assertPlainPath(target, `main or bin target "${target}"`);
    }
  }
  // npm lstats each component: a symlinked directory drops what is under it, and an ignore file in an
  // ancestor directory (below the root, where npm ignores them) can exclude a nested entry. Both throw.
  const assertPlainAncestors = (rel, spelled = true) => {
    const parts = normalise(rel).split('/');
    for (let i = 0; i < parts.length; i += 1) {
      const dir = path.join(root, ...parts.slice(0, i + 1));
      let stat;
      try { stat = fs.lstatSync(dir); } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          // On a case-sensitive disk npm still packs a name spelled in another case (its rules ignore case).
          let siblings = [];
          try { siblings = fs.readdirSync(path.dirname(dir)); } catch { /* the parent is missing too */ }
          if (spelled && siblings.some((n) => lower(n) === lower(parts[i]))) {
            throw new Error(`${dir}: "${rel}" matches a name on disk only in another case; this list needs the exact spelling`);
          }
          return;
        }
        throw err;
      }
      // npm lists names as the directory spells them; on a case-insensitive disk an entry may spell one differently.
      if (spelled) {
        const siblings = fs.readdirSync(path.dirname(dir));
        if (!siblings.includes(parts[i])) {
          throw new Error(`${dir}: "${rel}" spells a name differently from the directory (a case-insensitive match); this list needs the exact spelling`);
        }
        // npm matches names case-insensitively, so on a case-sensitive disk a sibling spelled in another case is packed too.
        if (siblings.some((n) => n !== parts[i] && lower(n) === lower(parts[i]))) {
          throw new Error(`${dir}: a sibling of "${parts[i]}" differs from it only in case; npm packs both and this list does not`);
        }
      }
      if (i === parts.length - 1) return;
      if (stat.isSymbolicLink()) throw new Error(`${dir}: a symlinked directory on the path of "${rel}"; the walk does not follow links`);
      for (const ignoreFile of ['.npmignore', '.gitignore']) {
        if (fs.existsSync(path.join(dir, ignoreFile))) throw new Error(`${path.join(dir, ignoreFile)}: an ignore file above "${rel}"; this list does not apply them`);
      }
    }
  };
  const positive = manifest.files.filter((f) => !f.startsWith('!')).map(normalise);
  // A slash-less entry also matches by base name at depth, which can re-include a same-named file under a directory
  // a nested entry walks; this list models either kind of entry, not both together.
  if (positive.some((p) => p.includes('/')) && positive.some((p) => !p.includes('/'))) {
    throw new Error(`${root}: package.json files mixes nested and root entries; npm matches a root entry by base name at depth and this list does not model that`);
  }
  const negative = manifest.files.filter((f) => f.startsWith('!')).map((f) => normalise(f.slice(1)));
  // npm matches a root file entry by base name, so an exclusion of a nested file with that base name can be undone.
  const baseName = (entry) => entry.split('/').pop().toLowerCase();
  for (const entry of positive) {
    if (negative.some((n) => baseName(n) === baseName(entry) && n.toLowerCase() !== entry.toLowerCase() && !entry.includes('/'))) {
      throw new Error(`${root}: files entry "${entry}" shares a base name with an exclusion; npm resolves that by position and this list does not`);
    }
  }
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin || {});
  // npm builds its rule for `main` from the text as written, so a "./main.js" spelling is not packed by it.
  const mainFile = typeof manifest.main === 'string' && !manifest.main.startsWith('./') ? [manifest.main] : [];
  const covers = (entry, rel) => {
    const e = lower(entry);
    const r = lower(rel);
    return r === e || r.startsWith(`${e}/`);
  };
  const forced = new Set([...mainFile, ...bins].filter((f) => typeof f === 'string').map(normalise));
  for (const rel of [...mainFile, ...bins]) {
    if (typeof rel === 'string' && (path.isAbsolute(rel) || normalise(rel).split('/').includes('..'))) {
      throw new Error(`${root}: main or bin target "${rel}" leaves the package root; this list reads paths below it only`);
    }
  }
  for (const rel of forced) assertPlainAncestors(rel);
  for (const rel of negative) assertPlainAncestors(rel, false); // an exclusion names nothing in the output
  for (const rel of forced) {
    const dirs = rel.split('/').slice(0, -1);
    if (dirs.some((d, i) => isExcludedName(d, dirs.slice(0, i + 1).join('/')) || d.toLowerCase() === 'node_modules')) {
      throw new Error(`${root}: main or bin target "${rel}" is under a directory a default exclusion matches; this list does not model that`);
    }
    if (rel.includes('/') && isExcludedName(rel.split('/').pop(), rel, false)) {
      throw new Error(`${root}: main or bin target "${rel}" is nested and matches a default exclusion; this list does not model that`);
    }
    // A slash-less entry matches by base name, so under a directory no entry covers npm can re-include a same-named
    // file next to the main or bin target; this list needs every such directory to be an entry itself.
    if (rel.includes('/') && !positive.some((p) => covers(p, rel))) {
      throw new Error(`${root}: main or bin target "${rel}" is under a directory no files entry covers; this list does not model base-name matches there`);
    }
    // The forced add below skips the name rules and the `!` exclusions that apply to walked files; npm's order for
    // those is not modelled, so a target any of them could touch throws instead.
    const base = rel.split('/').pop();
    if (isRootExcluded(base) || lower(base) === '.npmrc' || isExcludedName(base, rel, false) || negative.some((n) => covers(n, rel))) {
      throw new Error(`${root}: main or bin target "${rel}" is a name a default, a lock-file rule or an exclusion could drop; this list does not model that`);
    }
    let targetStat = null;
    try { targetStat = fs.lstatSync(path.join(root, rel)); } catch (err) { if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err; }
    if (targetStat && (targetStat.isSymbolicLink() || targetStat.isDirectory())) {
      throw new Error(`${path.join(root, rel)}: a main or bin target that is a symlink or a directory; this list reads regular files only`);
    }
  }
  // An entry under a directory npm prunes (node_modules at the root, an excluded directory name) is not packed.
  const underPrunedDirectory = (rel) => {
    const parts = rel.split('/');
    return parts.slice(0, -1).some((dir, i) => (i === 0 && dir.toLowerCase() === 'node_modules')
      || isExcludedName(dir, parts.slice(0, i + 1).join('/')));
  };
  // A file named by a files entry is packed despite a default or a `!` rule, but never .npmrc.
  const requiredAllowed = (rel) => rel.split('/').pop().toLowerCase() !== '.npmrc' && !underPrunedDirectory(rel);

  const packed = new Set();
  // `required` is a files entry that names this file itself.
  const visit = (rel, isDirectory, required = false) => {
    const name = rel.split('/').pop();
    if (name.includes('*')) return; // npm drops a file or directory whose name contains `*`
    if (isRootExcluded(rel)) return;
    if (isDirectory) {
      if (rel === 'node_modules' || isExcludedName(name, rel) || negative.some((n) => covers(n, rel))) return;
      const children = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
      if (new Set(children.map((c) => lower(c.name))).size !== children.length) {
        throw new Error(`${path.join(root, rel)}: names that differ only in case; npm treats them alike and this list does not`);
      }
      for (const entry of children) {
        const where = path.join(root, rel, entry.name);
        if (entry.name === '.npmignore' || entry.name === '.gitignore') {
          throw new Error(`${where}: a nested ignore file; this list does not apply them`);
        }
        if (entry.isSymbolicLink()) throw new Error(`${where}: a symlink in a packed directory; the walk does not follow links`);
        if (lower(entry.name) === 'node_modules') throw new Error(`${where}: a nested node_modules directory; this list does not model bundled dependencies`);
        if (entry.isDirectory() || entry.isFile()) visit(`${rel}/${entry.name}`, entry.isDirectory());
      }
    } else if (isRootExcluded(rel)) {
      // npm's strict rules beat even a files entry that names the file
    } else if ((required && requiredAllowed(rel)) || (!required && !isExcludedName(name, rel, false) && !negative.some((n) => covers(n, rel)))) {
      packed.add(rel);
    }
  };

  for (const entry of positive) {
    if (entry.includes('/') && entry.split('/').some((s) => lower(s) === 'node_modules')) {
      throw new Error(`${path.join(root, entry)}: a files entry inside a nested node_modules directory; this list does not model bundled dependencies`);
    }
    // npm's package.json rules come after the root defaults, so a nested entry under a root directory a default matches
    // is packed; only /.git and /node_modules are strict rules that still prune it.
    const firstSegment = entry.split('/')[0];
    if (entry.includes('/') && lower(firstSegment) !== '.git' && (isExcludedName(firstSegment, firstSegment) || ROOT_EXCLUDED_FILES.has(lower(firstSegment)))) {
      throw new Error(`${path.join(root, entry)}: an entry under a root directory a default exclusion matches; this list does not model that`);
    }
    assertPlainAncestors(entry);
    let stat;
    try { stat = fs.lstatSync(path.join(root, entry)); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        // On a case-sensitive disk npm treats the unmatched entry as a case-insensitive base-name pattern, which can
        // still pack a differently spelled file; this list throws when the spelling differs from a sibling's.
        const parent = path.join(root, path.dirname(entry));
        let siblings = [];
        try { siblings = fs.readdirSync(parent); } catch { /* the parent is missing too: nothing can match */ }
        if (siblings.some((n) => n.toLowerCase() === path.basename(entry).toLowerCase())) {
          throw new Error(`${path.join(root, entry)}: "${entry}" matches a name on disk only in another case; this list needs the exact spelling`);
        }
        continue; // npm skips an entry that matches nothing
      }
      throw err;
    }
    if (stat.isSymbolicLink()) throw new Error(`${path.join(root, entry)}: a symlinked files entry; the walk does not follow links`);
    if (!stat.isFile() && underPrunedDirectory(entry)) continue;
    // npm's package.json rules come after the root defaults, so a root directory entry whose name a default matches is
    // packed whole (nested ones are not); this list does not model that.
    if (stat.isDirectory() && !entry.includes('/') && (isExcludedName(entry, entry) || entry.toLowerCase() === 'build')) {
      throw new Error(`${path.join(root, entry)}: a root directory entry whose name a default exclusion matches; this list does not model that`);
    }
    // npm hands a named file only to its parent directory's walker as a re-include, so a file below the root is
    // packed or not by rules (a first-level excluded name, build/config.gypi) this list does not model.
    if (stat.isFile() && entry.includes('/')) {
      throw new Error(`${path.join(root, entry)}: a files entry naming a file below the root; this list reads root file entries and directories only`);
    }
    if (stat.isDirectory() || stat.isFile()) visit(entry, stat.isDirectory(), stat.isFile());
  }
  for (const rel of fs.readdirSync(root)) {
    if (!isAlwaysIncludedFile(rel) || rel.includes('*')) continue;
    const rootStat = fs.lstatSync(path.join(root, rel));
    if (rootStat.isSymbolicLink()) throw new Error(`${path.join(root, rel)}: a symlinked root file npm always includes; the walk does not follow links`);
    if (rootStat.isDirectory()) throw new Error(`${path.join(root, rel)}: a root directory named like a file npm always includes; this list does not model that`);
    if (rootStat.isFile()) packed.add(rel);
  }
  for (const rel of forced) {
    if (fs.existsSync(path.join(root, rel)) && fs.lstatSync(path.join(root, rel)).isFile()) packed.add(rel);
  }
  return packed;
}

module.exports = { listPackedFiles };
