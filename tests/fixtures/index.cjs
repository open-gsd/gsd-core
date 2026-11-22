const fs = require('fs');
const os = require('os');
const path = require('path');
const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('../helpers/git-fixture.cjs');
const { runStoreDir, createSharedFixtureStore } = require('../helpers/shared-install-fixture.cjs');

// ─── Git fixtures are copies of a template (#6336) ─────────────────────────
//
// A git fixture used to cost six `git` processes: init, three config calls,
// add, commit. Each of the four shapes a caller can ask for (with or without
// `.planning/phases`, with or without PROJECT.md) is now built once, and a
// fixture is `fs.cpSync` of that template: no process at all.
//
// Inside a run started by scripts/run-tests.cjs the templates live under the
// run's temp root and every test file shares them (the store #6335 added for
// installed trees). Anywhere else a process builds its own and removes them at
// exit. A template is read-only: a test gets a copy and never the template.

/** Passed by the template builder to make createFixture run git, into a given directory. */
const BUILD_INTO = Symbol('createFixture: build the git template into this directory');

const TEMPLATE_VARIANTS = Object.freeze({
  bare: { planning: false, projectDoc: false },
  planning: { planning: true, projectDoc: false },
  doc: { planning: false, projectDoc: true },
  'planning+doc': { planning: true, projectDoc: true },
});

function variantName({ planning, projectDoc }) {
  return Object.keys(TEMPLATE_VARIANTS).find((name) => (
    TEMPLATE_VARIANTS[name].planning === Boolean(planning) && TEMPLATE_VARIANTS[name].projectDoc === Boolean(projectDoc)
  ));
}

/**
 * The environment a template is built in. It must not depend on the machine or
 * on which test file happens to build it:
 *
 *   - no inherited GIT_* variable that shapes a repository (a file may have
 *     pointed GIT_CONFIG_GLOBAL or GIT_DIR somewhere of its own). GIT_EXEC_PATH
 *     says where git's own programs are and is kept;
 *   - no system config, and an empty global config;
 *   - an empty init template. `git init` otherwise copies the installation's
 *     default template, whose `info/exclude` a developer's git can carry
 *     `.planning` in (#5470) and whose sample hooks differ between versions.
 */
function templateBuildEnv({ globalConfig, templateDir }, base = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith('GIT_') || upper === 'GIT_EXEC_PATH') env[name] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = globalConfig;
  env.GIT_TEMPLATE_DIR = templateDir;
  return env;
}

/** The two things a template build keeps beside the template: an empty global config and an empty init template. */
const templateSiblings = (root) => ({ globalConfig: `${root}.gitconfig`, templateDir: `${root}.init-template` });

function removeTemplate(root) {
  const { globalConfig, templateDir } = templateSiblings(root);
  for (const target of [root, templateDir]) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* best-effort teardown */ }
  }
  try {
    fs.rmSync(globalConfig, { force: true });
  } catch { /* best-effort teardown */ }
}

/**
 * Build one template into `root`, an existing empty directory. Returns the
 * record the shared store keeps: it wants a `configDir`, which for a
 * repository is the root itself.
 */
function buildGitTemplate({ scope, root }) {
  if (!Object.hasOwn(TEMPLATE_VARIANTS, scope)) throw new TypeError(`buildGitTemplate: unknown variant ${String(scope)}`);
  createFixture({ ...TEMPLATE_VARIANTS[scope], git: true, [BUILD_INTO]: root });
  return { root, configDir: root };
}

const runTemplateStore = (() => {
  const dir = runStoreDir(os.tmpdir());
  return dir === null ? null : createSharedFixtureStore({ dir, install: buildGitTemplate, source: __filename });
})();
const ownTemplates = new Map();
let templateExitHook = false;

/**
 * The template directory for a shape, building it if no process of the run has.
 * @param {{planning: boolean, projectDoc: boolean}} shape
 * @returns {string}
 */
function gitTemplateRoot(shape) {
  const scope = variantName(shape);
  if (!templateExitHook) {
    templateExitHook = true;
    process.once('exit', () => settleGitTemplates());
  }
  if (runTemplateStore !== null) return runTemplateStore.get({ runtime: 'git-fixture', scope }).root;
  if (!ownTemplates.has(scope)) {
    const root = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'gsd-git-template-'));
    try {
      buildGitTemplate({ scope, root });
    } catch (err) {
      removeTemplate(root);
      throw err;
    }
    ownTemplates.set(scope, root);
  }
  return ownTemplates.get(scope);
}

/**
 * At exit: remove this process's own templates, and fail the process if a
 * run-shared template it used was changed. Fixtures are copies, so only a test
 * that reached for the template itself can do that.
 */
function settleGitTemplates({ store = runTemplateStore, own = ownTemplates, proc = process } = {}) {
  for (const root of own.values()) removeTemplate(root);
  own.clear();
  const changed = store === null ? [] : store.changed();
  if (changed.length > 0) {
    proc.stderr.write(`createFixture: a shared git fixture template was modified while ${proc.argv[1]} ran: ${changed.join(', ')}\n`);
    proc.exitCode = 1;
  }
  return changed;
}

/**
 * Create a temp test fixture directory with canonical planning layout.
 *
 * @param {object} [options]
 * @param {string} [options.prefix='gsd-test-']
 * @param {boolean} [options.git=false] - initialize git repo with initial commit
 * @param {boolean} [options.planning=true] - create .planning/phases layout
 * @param {boolean} [options.projectDoc=true] - write .planning/PROJECT.md
 * @returns {string} absolute fixture directory path
 */
function createFixture(options = {}) {
  const {
    prefix = 'gsd-test-',
    git = false,
    planning = true,
    projectDoc = git,
  } = options;

  const building = options[BUILD_INTO];
  const tmpDir = building ?? fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), prefix));

  if (git && building === undefined) {
    // preserveTimestamps: git compares a file's modification time with the one
    // its index recorded. The template's config (below) makes that and the size
    // the whole comparison, so a copy reads as clean without a refresh.
    fs.cpSync(gitTemplateRoot({ planning, projectDoc }), tmpDir, { recursive: true, preserveTimestamps: true });
    return tmpDir;
  }

  if (planning) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  }

  if (projectDoc) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\nTest project.\n'
    );
  }

  if (git) {
    // Construction calls (init/config/add/commit), a heavier class than a
    // plumbing read — each of `init`/`commit` writes dozens of files, and on
    // Windows every spawn is Defender-scanned (#3323).
    const gitOpts = { cwd: tmpDir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS };
    const siblings = templateSiblings(tmpDir);
    fs.writeFileSync(siblings.globalConfig, '');
    fs.mkdirSync(siblings.templateDir, { recursive: true });
    gitOpts.env = templateBuildEnv(siblings);
    // #5913: pin the initial branch. A plain `git init` follows the host's
    // `init.defaultBranch` (Apple's Command Line Tools git sets `main` system-wide), so a test that
    // asks about `master` failed locally and passed on CI, where the setting is unset and git reads
    // it as `master`. `master` is what every fixture user already sees on CI.
    gitOrThrow(['init', '--initial-branch=master'], gitOpts);
    gitOrThrow(['config', 'user.email', 'test@test.com'], gitOpts);
    gitOrThrow(['config', 'user.name', 'Test'], gitOpts);
    gitOrThrow(['config', 'commit.gpgsign', 'false'], gitOpts);
    gitOrThrow(['add', '-A'], gitOpts);
    // `--allow-empty`: a fixture with `git: true, planning: false,
    // projectDoc: false` (e.g. a "greenfield" starting world) stages nothing,
    // so a plain `git commit` would fail with "nothing to commit" and the
    // caller would never get a usable repo (there'd be no HEAD at all).
    gitOrThrow(['commit', '--allow-empty', '-m', 'initial commit'], gitOpts);
    // A copy of a repository has new inode numbers and change times, which git
    // reads as "every tracked file may have changed": `git diff-files` and
    // `git diff-index` then report a clean copy as dirty until something
    // refreshes the index. These two settings limit the comparison to the
    // modification time and size, which a copy keeps.
    gitOrThrow(['config', 'core.trustctime', 'false'], gitOpts);
    gitOrThrow(['config', 'core.checkStat', 'minimal'], gitOpts);
    // The empty init template leaves no `hooks` and no `info` directory. Tests
    // write a hook or an exclude file into them, so both are there, empty.
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
  }

  return tmpDir;
}

/**
 * Seed a canonical phase directory with files.
 * @param {string} tmpDir
 * @param {string} phaseSlug e.g. "03-api"
 * @param {Record<string,string>} files map of filename->content
 * @returns {string} phase directory path
 */
function seedPhase(tmpDir, phaseSlug, files = {}) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(phaseDir, name), content);
  }
  return phaseDir;
}

/**
 * Seed a canonical workstream tree and optionally set active pointer.
 * @param {string} tmpDir
 * @param {{name:string, state?:string, roadmap?:string, active?:boolean}} options
 * @returns {string} workstream directory path
 */
function seedWorkstream(tmpDir, options) {
  const { name, state = '', roadmap = '', active = false } = options || {};
  if (!name || /[^a-zA-Z0-9._-]/.test(name) || name.includes('..')) {
    throw new Error(`seedWorkstream: invalid name "${name}"`);
  }
  const wsDir = path.join(tmpDir, '.planning', 'workstreams', name);
  fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
  if (state) fs.writeFileSync(path.join(wsDir, 'STATE.md'), state);
  if (roadmap) fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), roadmap);
  if (active) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), `${name}\n`);
  }
  return wsDir;
}

/**
 * Write STATE.md in canonical location.
 * @param {string} tmpDir
 * @param {string} content
 * @returns {string} file path
 */
function writeState(tmpDir, content) {
  const statePath = path.join(tmpDir, '.planning', 'STATE.md');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, content);
  return statePath;
}

module.exports = {
  createFixture, seedPhase, seedWorkstream, writeState,
  TEMPLATE_VARIANTS, gitTemplateRoot, buildGitTemplate, settleGitTemplates, templateBuildEnv,
};
