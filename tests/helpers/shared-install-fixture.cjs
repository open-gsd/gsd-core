'use strict';

/**
 * Installed trees shared by a whole test run, and private copies of them (#6335).
 *
 * A run made 1,553 installer calls for 187 distinct (runtime, scope, flags, env)
 * keys (ADR-6315, item 17). An install is about a second, and four fifths of it
 * is writing a thousand files, so the saving is in not installing again:
 *
 *   - `createSharedFixtureStore` keeps one installed tree per key under the
 *     run's temp root, where every test file of the run finds it.
 *   - `copyInstalledTree` gives a test that changes its tree a private copy,
 *     which stands in for a fresh install into the copy's root.
 *
 * Nothing here spawns: the installer is an argument (`install`), so the unit
 * tests of this module pass a stand-in.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Names under the run temp root that the shared store owns. scripts/run-tests.cjs
 * spares this prefix when it sweeps the root between chunks, and removes the
 * root, store included, when the run ends. Kept short: the name is part of
 * every path inside a shared tree.
 */
const SHARED_FIXTURE_PREFIX = 'gsd-fxs-';

/** The run temp root's own prefix (scripts/run-tests.cjs `RUN_TEMP_ROOT_PREFIX`). */
const RUN_TEMP_ROOT_PREFIX = 'gsd-test-run-';

/** Windows holds a file open briefly after a write (indexer, antivirus); the same budget as helpers.cleanup. */
const REMOVE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

/**
 * Remove a tree this module made, without letting a failed removal replace the
 * error that is already on its way out. What is left is under the run's temp
 * root, which the runner removes.
 */
function removeQuietly(target) {
  try {
    fs.rmSync(target, REMOVE);
  } catch { /* see above */ }
}

/** `link()` failures that mean "this filesystem has no hard links", as opposed to a real fault. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);

/**
 * A shared tree that is not as it was built. `code` says which process is
 * looking: the one that left it changed, or a later one that found it so.
 */
class SharedFixtureModifiedError extends Error {
  constructor(key, root) {
    super(
      `shared installed tree for ${key} (${root}) is not as it was built: a test file that ran earlier ` +
      'in this run wrote into it. A tree from installRuntimeFixture is read-only; a test that writes ' +
      'into its tree takes a private one from copyRuntimeFixture. The file that wrote into it failed ' +
      'at its own exit with "a shared installed tree was modified".',
    );
    this.name = 'SharedFixtureModifiedError';
    this.code = 'SHARED_FIXTURE_MODIFIED';
    this.key = key;
  }
}

/**
 * The directory a run-wide store may use, or null when this process is not
 * inside a run started by scripts/run-tests.cjs. Outside a run nothing removes
 * the directory afterwards, so nothing is shared between processes.
 *
 * @param {string} tmpdir - this process's `os.tmpdir()`.
 * @returns {string|null}
 */
function runStoreDir(tmpdir) {
  const resolved = path.resolve(tmpdir);
  return path.basename(resolved).startsWith(RUN_TEMP_ROOT_PREFIX) ? resolved : null;
}

/** The store's key for one install: order of `extraArgs` matters, order of `extraEnv` keys does not. */
function fixtureKey({ runtime, scope, extraArgs = [], extraEnv = {} }) {
  return JSON.stringify([
    runtime,
    scope,
    extraArgs,
    Object.entries(extraEnv).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}

/** Every entry under `root`, as sorted `[relativePath, lstat]` pairs with `/` separators. */
function listTree(root) {
  const out = [];
  const visit = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(full);
      out.push([relPath, stat]);
      if (stat.isDirectory()) visit(full, relPath);
    }
  };
  visit(root, '');
  return out;
}

/**
 * A digest of what is in a tree and when each entry last changed: paths,
 * kinds, permission bits, modification times, and file sizes. It does not read
 * file contents, so it costs a stat per entry. It changes when a test writes,
 * adds, removes or re-modes anything; a file added and then removed shows in
 * its directory's modification time.
 */
function treeDigest(root) {
  const hash = crypto.createHash('sha256');
  const line = (kind, relPath, stat, size) => `${kind}\0${relPath}\0${stat.mode}\0${stat.mtimeMs}\0${size}\n`;
  hash.update(line('d', '', fs.lstatSync(root), 0));
  for (const [relPath, stat] of listTree(root)) {
    // A directory's size is not portable; its entries are listed below it.
    if (stat.isDirectory()) hash.update(line('d', relPath, stat, 0));
    else hash.update(line(stat.isSymbolicLink() ? 'l' : 'f', relPath, stat, stat.size));
  }
  return hash.digest('hex');
}

/**
 * A store of installed trees under `dir`, shared by every process that names
 * the same `dir`.
 *
 * No process waits for another. A process that finds no tree for a key builds
 * one in a root of its own and then publishes a record of it with a hard link,
 * which either creates the record or fails because another process published
 * first. The loser removes its tree and uses the winner's. A reader therefore
 * sees a finished tree or none, and a builder that dies leaves no record: the
 * next process builds again under a new name.
 *
 * @param {object} deps
 * @param {string} deps.dir - an existing directory; the run temp root.
 * @param {(opts: object) => object} deps.install - `runMinimalInstall`: called
 *   with `{ runtime, scope, extraArgs, extraEnv, root }`, installs into `root`.
 * @param {string} [deps.source] - what the trees are installed from (the
 *   installer's path). Part of each tree's name, so a process of another
 *   checkout that inherits this run's temp directory does not read this one's trees.
 * @param {() => string} [deps.token] - a fresh name part for a tree's root.
 * @param {(from: string, to: string) => void} [deps.link] - `fs.linkSync`.
 * @returns {{ get: (opts: object) => object, changed: () => string[] }}
 */
function createSharedFixtureStore({
  dir,
  install,
  source = '',
  token = () => crypto.randomBytes(3).toString('hex'),
  link = fs.linkSync,
}) {
  // One spelling of the directory, so a tree's parent compares equal to it: a
  // TMPDIR with a doubled or trailing separator names the same place.
  dir = path.resolve(dir);
  const used = new Map();

  const digestOrNull = (root) => {
    try {
      return treeDigest(root);
    } catch {
      return null;
    }
  };

  /** The published record for `id`, or null. Throws on a record that does not name a tree of this store. */
  const readRecord = (recordFile, id) => {
    let text;
    try {
      text = fs.readFileSync(recordFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      record = null;
    }
    const root = record && record.result && record.result.root;
    const sound = typeof root === 'string'
      && path.dirname(root) === dir
      && path.basename(root).startsWith(`${SHARED_FIXTURE_PREFIX}${id}-`)
      && typeof record.digest === 'string'
      && typeof record.result.configDir === 'string';
    if (!sound) {
      throw Object.assign(
        new Error(`shared fixture record ${recordFile} is not a record of a tree of this store`),
        { code: 'SHARED_FIXTURE_BAD_RECORD' },
      );
    }
    return record;
  };

  /** A record read from disk, refused if its tree is no longer as it was built. */
  const intact = (key, record) => {
    if (digestOrNull(record.result.root) !== record.digest) {
      throw new SharedFixtureModifiedError(key, record.result.root);
    }
    return record;
  };

  return {
    /** The shared result for `opts`, installing it if no process has yet. */
    get(opts) {
      const key = fixtureKey(opts);
      if (used.has(key)) return used.get(key).result;

      const id = crypto.createHash('sha256').update(`${source}\0${key}`).digest('hex').slice(0, 10);
      const recordFile = path.join(dir, `${SHARED_FIXTURE_PREFIX}${id}.json`);
      let record = readRecord(recordFile, id);
      if (record === null) {
        const root = path.join(dir, `${SHARED_FIXTURE_PREFIX}${id}-${token()}`);
        fs.mkdirSync(root);
        const pending = `${root}.pending`;
        let built;
        try {
          const result = install({
            runtime: opts.runtime,
            scope: opts.scope,
            extraArgs: opts.extraArgs ?? [],
            extraEnv: opts.extraEnv ?? {},
            root,
          });
          built = { result, digest: treeDigest(root) };
          fs.writeFileSync(pending, JSON.stringify(built));
        } catch (err) {
          removeQuietly(pending);
          removeQuietly(root);
          throw err;
        }
        try {
          link(pending, recordFile);
          record = built;
        } catch (err) {
          if (err.code === 'EEXIST') {
            // Another process published first: its tree is the shared one.
            removeQuietly(root);
            record = intact(key, readRecord(recordFile, id));
          } else if (NO_HARD_LINKS.has(err.code)) {
            // Nothing can be published here, so this process keeps its tree to itself.
            record = built;
          } else {
            removeQuietly(root);
            throw err;
          }
        } finally {
          removeQuietly(pending);
        }
      } else {
        // Changed before this process touched it: an earlier file wrote into it.
        intact(key, record);
      }
      used.set(key, record);
      return record.result;
    },

    /**
     * The keys, among those this process used, whose tree no longer matches the
     * digest taken when it was built. Each was intact when this process first
     * read it (`get` checks), so a key listed here was changed while this
     * process ran.
     */
    changed() {
      const out = [];
      for (const [key, record] of used) {
        if (digestOrNull(record.result.root) !== record.digest) out.push(key);
      }
      return out;
    },
  };
}

/**
 * Copy an installed tree to `toRoot`, writing `toRoot`'s name wherever the
 * source root's name appears: in file contents, in symlink targets, and in the
 * returned strings.
 *
 * The two roots must be siblings. Then the only difference between their paths
 * is the last segment, and replacing that segment is right for every spelling
 * of the path an installer writes: native, forward-slash, JSON-escaped, or the
 * resolved form of a symlinked temp directory.
 *
 * An install manifest records a SHA-256 of each file it wrote, and a later
 * install reads a mismatch as the user's own edit. So each file whose content
 * changed here has its recorded hash replaced, in every file named
 * `manifestName`, by the hash of what was written.
 *
 * A failed copy removes what it wrote.
 *
 * @param {string} fromRoot
 * @param {string} toRoot - must not exist.
 * @param {{ manifestName?: string }} [options]
 * @returns {(text: string) => string} the same replacement, for a caller's own strings.
 */
function copyInstalledTree(fromRoot, toRoot, { manifestName = 'gsd-file-manifest.json' } = {}) {
  if (path.dirname(fromRoot) !== path.dirname(toRoot)) {
    throw new TypeError(`copyInstalledTree: ${toRoot} is not a sibling of ${fromRoot}`);
  }
  const from = path.basename(fromRoot);
  const to = path.basename(toRoot);
  if (from === to || from.includes(to) || to.includes(from)) {
    throw new TypeError(`copyInstalledTree: root names must differ and not contain each other (${from}, ${to})`);
  }
  // Contents are rewritten as latin1 text, where one character is one byte, so
  // a name that is not plain ASCII would not be found.
  // eslint-disable-next-line no-control-regex -- the ASCII range is the point
  if (/[^\x00-\x7f]/.test(from + to)) {
    throw new TypeError(`copyInstalledTree: root names must be ASCII (${from}, ${to})`);
  }
  const fromBytes = Buffer.from(from);
  const rewrite = (text) => text.split(from).join(to);
  const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const rehashed = new Map();
  const manifests = [];

  fs.mkdirSync(toRoot);
  try {
    for (const [relPath, stat] of listTree(fromRoot)) {
      const source = path.join(fromRoot, relPath);
      const target = path.join(toRoot, relPath);
      if (stat.isDirectory()) {
        fs.mkdirSync(target);
        fs.chmodSync(target, stat.mode);
      } else if (stat.isSymbolicLink()) {
        // Windows needs to be told a link is to a directory; its target may not exist yet here.
        let type;
        try {
          type = fs.statSync(source).isDirectory() ? 'dir' : 'file';
        } catch { /* a dangling link: let the platform decide */ }
        fs.symlinkSync(rewrite(fs.readlinkSync(source)), target, type);
      } else {
        const bytes = fs.readFileSync(source);
        // latin1 maps every byte to one character and back, so a file that is not
        // text is copied unchanged apart from the name.
        const out = bytes.includes(fromBytes) ? Buffer.from(rewrite(bytes.toString('latin1')), 'latin1') : bytes;
        fs.writeFileSync(target, out);
        // The mode option of a write is cut by the umask; chmod is not.
        fs.chmodSync(target, stat.mode);
        if (out !== bytes) rehashed.set(sha256(bytes), sha256(out));
        if (path.basename(relPath) === manifestName) manifests.push(target);
      }
    }
    if (rehashed.size > 0) {
      for (const file of manifests) {
        let text = fs.readFileSync(file, 'utf8');
        for (const [before, after] of rehashed) text = text.split(before).join(after);
        fs.writeFileSync(file, text);
      }
    }
  } catch (err) {
    removeQuietly(toRoot);
    throw err;
  }
  return rewrite;
}

module.exports = {
  SHARED_FIXTURE_PREFIX,
  RUN_TEMP_ROOT_PREFIX,
  SharedFixtureModifiedError,
  runStoreDir,
  fixtureKey,
  listTree,
  treeDigest,
  createSharedFixtureStore,
  copyInstalledTree,
};
