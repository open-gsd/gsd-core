'use strict';

/**
 * #6033 (epic #4635 Phase 1) — the single owner of child-env isolation for tests.
 *
 * A child process that inherits the developer's environment is not isolated: it
 * reads the real HOME, the real config-location variables, a PATH carrying a
 * globally installed `gsd_run`, and the runner's own control variables. This
 * module builds the env (and the PATH) a test hands to a child, so the platform
 * reasoning behind each step lives here once instead of in every suite.
 *
 * Built ON the `testEnvBase()` set (helpers.cjs `TEST_ENV_BASE`), which is DERIVED from the
 * capability registry (#2665): the config-location and session-identity keys are
 * never hand-listed here. This module adds only what that set cannot supply:
 *  - a required, absolute HOME/USERPROFILE (a helper that inherits the real home
 *    isolates nothing — #4411),
 *  - prefix-stripping of `GSD_*` / `RUN_TESTS_*` and the exact runner variables,
 *  - the two bash re-injection hazards (`BASH_ENV`, `CLAUDE_ENV_FILE`),
 *  - Windows key-case canonicalization,
 *  - an `override` route to opt a stripped variable back in.
 *
 * In-process isolation stays with `scrubConfigLocationEnv()`; this covers the env
 * handed to a CHILD only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// helpers.cjs requires THIS module at load (it builds its own HOME/USERPROFILE pairs with
// homePair, #6639), so helpers.cjs is read at call time, never at module scope: a
// top-level require here would cycle and hand back a half-built exports object.
const helpers = () => require('../helpers.cjs');

// helpers.cjs exports the derived set as a LAZY getter (TEST_ENV_BASE), not as the
// testEnvBase() function: reading it at module scope would make an unbuilt tree
// throw during require. Read it only when an env is actually built.
const testEnvBase = () => helpers().TEST_ENV_BASE;

// Variables stripped by PREFIX (case-insensitive). GSD_* is the product's own
// namespace; RUN_TESTS_* are the runner's control variables (#4070's
// RUN_TESTS_SHARD_RESERVE shape). A key that merely CONTAINS the prefix
// mid-name (MY_GSD_X) is not stripped.
const STRIPPED_PREFIXES = ['GSD_', 'RUN_TESTS_'];

// Variables stripped by exact name (case-insensitive).
//  - NODE_TEST_CONTEXT: tells a spawned `node --test` it is already a child of a
//    runner, which changes how it reports.
//  - CLAUDE_ENV_FILE: a WRITE sink, not a read path. Left ambient, every fixture
//    that exits 0 appends `export PATH='<temp dir>'` to the developer's real env
//    file, each line naming a /tmp dir the fixture has already deleted.
//  - BASH_ENV: sourced by non-interactive bash BEFORE the script, which is after
//    this scrub is applied — so one inherited var re-injects any of the others.
//    Measured: a BASH_ENV exporting CODEX_HOME turned the launcher (H) fixture red.
const STRIPPED_NAMES = new Set(['NODE_TEST_CONTEXT', 'BASH_ENV', 'CLAUDE_ENV_FILE']);

function isStripped(key) {
  const upper = key.toUpperCase();
  return STRIPPED_NAMES.has(upper) || STRIPPED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Build the env a test hands to a child process.
 *
 * Build order: copy `base`, dropping every stripped key -> overlay `testEnvBase()`
 * -> overlay home / path / claudeConfigDir -> overlay `override` -> canonicalize
 * key casing.
 *
 * The stripping holds only when the result reaches the child verbatim (runNode,
 * runHook, spawn). runGsdTools*, installSpawnEnv and installerEnv start from
 * `{ ...process.env, ...testEnvBase() }` and spread what they are handed over it,
 * so a stripped key (ambient GSD_*, BASH_ENV, CLAUDE_ENV_FILE, ...) returns there.
 * Through them the result still sets home, path, `override` and the blanks.
 *
 * @param {object} opts
 * @param {string} opts.home Absolute dir written to BOTH `HOME` and `USERPROFILE`.
 *   Missing or relative throws `TypeError`.
 * @param {string} [opts.userProfile] Absolute dir written to `USERPROFILE` instead of
 *   `home`. Only for a test whose subject is `HOME` and `USERPROFILE` pointing at
 *   different directories (a HOME-only seed that leaks through USERPROFILE on win32,
 *   #5276). Omitted: `USERPROFILE` is `home`. Relative throws `TypeError`.
 * @param {string} [opts.path] Written to `PATH` verbatim. Omitted: the inherited
 *   PATH is kept (inheriting PATH is allowed; hand-filtering it is not).
 * @param {string} [opts.claudeConfigDir] Written to `CLAUDE_CONFIG_DIR`; omitted:
 *   blanked by `testEnvBase()`.
 * @param {object} [opts.override] Applied LAST; the only route to opt a stripped
 *   variable (`RUN_TESTS_*`, `NODE_TEST_CONTEXT`, a specific `GSD_*`) back in.
 * @param {object} [opts.base] The inherited env. Default `process.env`; injectable
 *   so tests never mutate it.
 * @returns {Record<string, string>}
 */
function isolatedEnv(opts) {
  const { home, userProfile, path: pathValue, claudeConfigDir, override, base = process.env } = opts ?? {};
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new TypeError(
      `isolatedEnv: home must be an absolute path (received ${JSON.stringify(home)}). ` +
        'A helper that inherits the real home isolates nothing.',
    );
  }
  if (userProfile !== undefined && (typeof userProfile !== 'string' || !path.isAbsolute(userProfile))) {
    throw new TypeError(
      `isolatedEnv: userProfile must be an absolute path when given (received ${JSON.stringify(userProfile)}).`,
    );
  }

  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isStripped(key)) env[key] = value;
  }
  Object.assign(env, testEnvBase());

  const set = { HOME: home, USERPROFILE: userProfile ?? home };
  if (pathValue !== undefined) set.PATH = pathValue;
  if (claudeConfigDir !== undefined) set.CLAUDE_CONFIG_DIR = claudeConfigDir;
  Object.assign(env, set, override);

  // Windows env vars are case-insensitive; a spread of process.env is not. The
  // host PATH enumerates as `Path` there, so `{ ...process.env, PATH: x }`
  // yields BOTH keys — and libuv's make_program_env sorts the child's block
  // case-insensitively but never drops duplicates, so the ambient twin of
  // anything scrubbed here still reaches the child and defeats the isolation.
  // Every key this function sets wins over any other casing of itself; keys it
  // does not set are left alone, so a caller that passes no PATH still gets the
  // host PATH.
  const canonical = new Map(
    [...Object.keys(testEnvBase()), ...Object.keys(set), ...Object.keys(override ?? {})]
      .map((key) => [key.toUpperCase(), key]),
  );
  for (const key of Object.keys(env)) {
    const owner = canonical.get(key.toUpperCase());
    if (owner !== undefined && owner !== key) delete env[key];
  }
  return env;
}

/**
 * Put an executable link to this interpreter in `dir` under `name`, and return
 * `dir` so a caller can prepend it to a PATH.
 *
 * Windows symlinks need elevation, so a hard link is used there instead: it
 * needs no privilege, but it cannot cross volumes, hence the copy fallback.
 */
function linkExecutable(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  if (process.platform !== 'win32') {
    fs.symlinkSync(process.execPath, target);
    return dir;
  }
  try {
    fs.linkSync(process.execPath, target);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(process.execPath, target);
  }
  return dir;
}

const NODE_BIN = process.platform === 'win32' ? 'node.exe' : 'node';

// Every filename a bare `<name>` could resolve to under bash.
//
// The lookup runs under bash, so this models bash's rule, not cmd.exe's. The
// Cygwin/msys rule is that `.exe` may be omitted from a command while ".bat and
// .com ... you cannot omit the extension" — so `<name>.exe` is reachable for a
// bare `<name>` and `<name>.cmd`/`.ps1` are not, whatever PATHEXT says.
//
// Matching PATHEXT instead would drop more directories than bash can reach, and
// that is not free: isolatedPath() restores node to the isolated PATH but
// nothing restores bash, which the fixtures spawn by name. A wider drop set is
// a wider chance of removing the directory bash itself lives in and failing the
// fixture with ENOENT instead of an assertion.
function reachableNames(name) {
  return process.platform === 'win32' ? [name, `${name}.exe`] : [name];
}

/** True when `dir` holds an executable a bare lookup of any `without` name could resolve. */
function holdsAny(dir, without) {
  return without.some((name) => reachableNames(name).some((candidate) => {
    try {
      fs.accessSync(path.join(dir, candidate), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

/**
 * Build a PATH no lookup of any `without` name can resolve from, while a bare
 * `node` lookup still succeeds.
 *
 * Directories holding a resolvable `without` tool are dropped, then a dedicated
 * dir carrying only node is prepended. The prepend is unconditional because
 * dropping the directory node itself lives in is a normal outcome, not an exotic
 * one: fnm, nvm, Homebrew and Windows global installs all co-locate node with
 * global tools.
 *
 * The caller cleans up `nodeBinDir` (pass it to `cleanup()` in a `t.after` or
 * `finally` block).
 *
 * @param {object} opts
 * @param {string[]} opts.without Tool names to remove. Required and non-empty.
 * @param {string} [opts.basePath] PATH to filter. Default `process.env.PATH`.
 *   Callers planting a leaked tool pass their own string rather than mutating
 *   `process.env.PATH`.
 * @returns {{ path: string, nodeBinDir: string }}
 */
function isolatedPath(opts) {
  const { without, basePath = process.env.PATH } = opts ?? {};
  if (!Array.isArray(without) || without.length === 0 || !without.every((n) => typeof n === 'string' && n !== '')) {
    throw new TypeError('isolatedPath: without must be a non-empty array of tool names');
  }

  // Only absolute directories survive. An empty element means "the current
  // directory" to a POSIX shell and `.` says so explicitly, so either one puts
  // the child's cwd on PATH — and holdsAny cannot see what it would admit,
  // since `path.join('.', name)` probes the *runner's* cwd instead of the
  // child's. Joining the survivors (rather than the filtered string) also keeps
  // a fully-filtered PATH from ending in a delimiter, which means the same
  // thing. Dropping a relative entry can only tighten the isolation, never
  // loosen it.
  const filteredDirs = (basePath ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && !holdsAny(entry, without));

  const nodeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-node-'));
  try {
    linkExecutable(nodeBinDir, NODE_BIN);
  } catch (err) {
    helpers().cleanup(nodeBinDir);
    throw err;
  }

  return { path: [nodeBinDir, ...filteredDirs].join(path.delimiter), nodeBinDir };
}

/**
 * Create a fixture root that stops the `.planning/config.json` ancestor walk
 * (`_findAncestorGsdConfigPath`, src/install-effort-resolver.cts, 8 levels, first
 * hit wins) inside the fixture. An empty `{}` carries no `agent_tools` or effort
 * keys, so it is neutral to the agent-tools and effort resolvers. A test that
 * needs its own `.planning/config.json` at the root overwrites it.
 *
 * Opt-in: `isolatedEnv` never applies it, so a "not a GSD project" fixture is
 * not turned into one for tests that do not ask for it.
 *
 * @param {string} prefix mkdtemp prefix.
 * @param {{ parent?: string }} [opts] `parent` defaults to `os.tmpdir()`.
 * @returns {string} absolute path of the new root.
 */
function createHermeticRoot(prefix, { parent } = {}) {
  const root = fs.mkdtempSync(path.join(path.resolve(parent ?? os.tmpdir()), prefix));
  fs.mkdirSync(path.join(root, '.planning'));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}');
  return root;
}

/**
 * The HOME / USERPROFILE pair that points a process at `dir`, as a NEW object each call.
 *
 * The one place a test spells the pair. `isolatedEnv({ home })` is the route for an env handed
 * to a child; `homePair` is for the sites that cannot build a full env: the in-process route
 * (`homeSandboxEnv`, `withEnv`), the spawn helpers in tests/helpers.cjs that sit below
 * `isolatedEnv` (`installSpawnEnv`, the npm envs), an env object handed to code in-process,
 * and a deliberately hostile env that must keep ambient keys `isolatedEnv` would strip.
 * Spread it into the larger literal. `os.homedir()` reads HOME on POSIX and USERPROFILE on
 * Windows, so a `{ HOME }` alone is not hermetic there.
 *
 * @param {string} dir directory to use as the home; used as given (not required to be absolute).
 * @returns {{ HOME: string, USERPROFILE: string }}
 */
function homePair(dir) {
  return { HOME: dir, USERPROFILE: dir };
}

// Per test context: the value each variable had before the FIRST setEnvForTest call on that
// context. A second call on the same context must not snapshot what the first call set, or the
// restore hooks (run in whatever order the runner picks) would leave the first call's value behind.
const ENV_BEFORE = new WeakMap();

/**
 * Set `vars` on process.env for the life of the test `t`, then put each variable back, or delete
 * it if it was unset. Calls on one `t` stack: the restore is to the value from before the first.
 * A value of `undefined` unsets the variable for the test; any other non-string is a TypeError
 * (process.env would store the string "undefined", or "[object Object]"), and so is a name that
 * is empty or holds `=` or NUL, or a value that holds NUL. The whole object is validated before any variable changes.
 *
 * The test-context counterpart of `isolatedEnv`, for a test that calls the product in-process.
 * Several test files keep their own callback-scoped `withEnv(vars, fn)`; this one is scoped to
 * the test's lifetime instead, so it carries a different name.
 *
 * @param {{ after: (fn: () => void) => void }} t node:test context (anything with `after`).
 * @param {Record<string, string | undefined>} vars
 */
function setEnvForTest(t, vars) {
  // Validate every entry before the first mutation, so a rejected call changes nothing.
  for (const [name, value] of Object.entries(vars)) {
    if (name === '' || /[=\0]/.test(name)) {
      throw new TypeError(`setEnvForTest: ${JSON.stringify(name)} is not a variable name`);
    }
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError(`setEnvForTest: ${name} must be a string or undefined, got ${typeof value}`);
    }
    if (typeof value === 'string' && value.includes('\0')) {
      throw new TypeError(`setEnvForTest: the value of ${name} holds a NUL, which the environment truncates`);
    }
  }
  let before = ENV_BEFORE.get(t);
  if (!before) {
    before = new Map();
    ENV_BEFORE.set(t, before);
    t.after(() => {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      ENV_BEFORE.delete(t);
    });
  }
  for (const [name, value] of Object.entries(vars)) {
    if (!before.has(name)) before.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Make `dir` this process's home for the life of the test `t` (see setEnvForTest).
 *
 * The runner's sandbox HOME/USERPROFILE (#4635) no longer sits above `os.tmpdir()`, and on
 * Windows the filesystem git-layout reader answers only for a repository inside the home
 * (`ownedByThisUser`, src/project-context.cts). A test whose fixtures are such repositories
 * declares them as the home with this.
 *
 * @param {{ after: (fn: () => void) => void }} t node:test context (anything with `after`).
 * @param {string} dir directory to use as the home.
 */
function withHome(t, dir) {
  setEnvForTest(t, homePair(dir));
}

module.exports = { isolatedEnv, isolatedPath, createHermeticRoot, linkExecutable, homePair, setEnvForTest, withHome };
