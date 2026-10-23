'use strict';

/**
 * #5558 — the Pi-native package (`pi install npm:@opengsd/gsd-core`).
 *
 * The package loads pi/gsd.cjs straight out of the npm tarball and renders the
 * committed skill templates (pi/package-skills, generated from the installer's
 * own output) for the package's real location. These tests pin that the two
 * distribution paths cannot diverge: rendered templates equal what the
 * installer writes, the extension bytes are the same file, and the package-mode
 * logic degrades without throwing.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fc = require('fast-check');
const { createTempDir, cleanup, installSpawnEnv } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS, GENERATOR_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO = path.resolve(__dirname, '..');
const INSTALLER = path.join(REPO, 'bin', 'install.js');
const ext = require(path.join(REPO, 'pi', 'gsd.cjs'));
const internals = ext._internals;
const {
  PI_ENGINE_ROOT_TOKEN, tokenizeSkill, renderSkillTemplate,
} = require(path.join(REPO, 'scripts', 'gen-pi-package-skills.cjs'));

function tmp(prefix) {
  return createTempDir(prefix);
}

/** A minimal package-layout tree: engine entry point plus N skill templates. */
function makePackage(skills = { 'gsd-alpha': `read @${PI_ENGINE_ROOT_TOKEN}/gsd-core/workflows/alpha.md\n` }) {
  const root = tmp('gsd-pi-pkg-');
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// stub\n');
  for (const [name, body] of Object.entries(skills)) {
    fs.mkdirSync(path.join(root, 'pi', 'package-skills', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'pi', 'package-skills', name, 'SKILL.md'), body);
  }
  return root;
}

function fakePi() {
  const handlers = new Map();
  const commands = [];
  const tools = [];
  const commandDefs = new Map();
  return {
    handlers,
    commands,
    commandDefs,
    tools,
    sent: [],
    sendUserMessage(message) { this.sent.push(message); },
    registerCommand: (name, def) => { commands.push(name); commandDefs.set(name, def); },
    registerTool: (def) => tools.push(def.name),
    on: (event, fn) => handlers.set(event, fn),
  };
}

function installForPi(configDir) {
  const res = spawnSync(process.execPath, [INSTALLER, '--pi', '--global', '--config-dir', configDir], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true,
    // sandboxed HOME: the installer writes GSD's global defaults store under $HOME/.gsd
    // The templates ship canonical, so the installer output they are compared with is unstamped (#5637).
    env: installSpawnEnv({ PI_CODING_AGENT_DIR: configDir, GSD_ARGS_NONCE_OFF: '1' }),
  });
  assert.equal(res.status, 0, `installer failed: ${(res.stderr || res.stdout || '').slice(-600)}`);
}

function listSkillNames(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'))
    .map((e) => e.name)
    .sort();
}

describe('Pi package: template/installer parity (#5558)', () => {
  const dirs = [];
  after(() => { for (const d of dirs) cleanup(d); });

  function parityFor(rootBase) {
    const parent = tmp('gsd-pi-parity-');
    dirs.push(parent);
    const root = path.join(parent, rootBase);
    fs.mkdirSync(root, { recursive: true });
    installForPi(root);
    const installed = listSkillNames(path.join(root, 'skills'));
    const templateDir = path.join(REPO, 'pi', 'package-skills');
    assert.deepEqual(listSkillNames(templateDir), installed, 'template set equals installed skill set');
    assert.ok(installed.length > 0);
    for (const name of installed) {
      const template = fs.readFileSync(path.join(templateDir, name, 'SKILL.md'), 'utf8');
      // Only the engine root is normalized (Windows may emit it with backslashes); every
      // other byte, including regex backslashes in the skill text, is compared as written.
      const expected = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8').split(root).join(root.replace(/\\/g, '/'));
      assert.equal(renderSkillTemplate(template, root), expected, `${name} renders to the installer output`);
    }
    return { root, installed };
  }

  it('rendered templates equal the installer skills for the same root', () => {
    parityFor('agent');
  });

  it('stays byte-identical for a root with spaces and a dollar sign', () => {
    parityFor('pi agent $dir');
  });

  it('leaves no token or generator temp path in a rendered skill', () => {
    const { root } = parityFor('residue');
    const templateDir = path.join(REPO, 'pi', 'package-skills');
    for (const name of listSkillNames(templateDir)) {
      const rendered = renderSkillTemplate(fs.readFileSync(path.join(templateDir, name, 'SKILL.md'), 'utf8'), root);
      assert.ok(!rendered.includes(PI_ENGINE_ROOT_TOKEN), `${name} has no token after render`);
      assert.ok(!rendered.includes('gsd-pi-skills-'), `${name} has no generator temp path`);
    }
  });

  it('the installer copy of the extension is the package extension file', () => {
    const parent = tmp('gsd-pi-ext-');
    dirs.push(parent);
    installForPi(parent);
    assert.equal(
      fs.readFileSync(path.join(parent, 'extensions', 'gsd.js'), 'utf8'),
      fs.readFileSync(path.join(REPO, 'pi', 'gsd.cjs'), 'utf8'),
    );
  });
});

describe('Pi package: manifest and tarball (#5558)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

  it('names the shipped extension in the pi manifest', () => {
    assert.ok(pkg.keywords.includes('pi-package'));
    assert.deepEqual(pkg.pi.extensions, ['./pi/gsd.cjs']);
    assert.ok(fs.statSync(path.join(REPO, pkg.pi.extensions[0])).isFile());
    assert.ok(pkg.files.includes('pi'));
  });

  it('ships the extension and the skill templates in the npm tarball', () => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npmCmd, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: REPO,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: GENERATOR_SCRIPT_TIMEOUT_MS,
      env: { ...process.env, npm_config_loglevel: 'error' },
    });
    assert.equal(res.status, 0, res.stderr);
    const files = JSON.parse(res.stdout)[0].files.map((f) => f.path.replace(/\\/g, '/'));
    assert.ok(files.includes('pi/gsd.cjs'));
    assert.ok(files.includes('pi/package-skills/gsd-new-project/SKILL.md'));
    assert.ok(files.includes('gsd-core/bin/gsd_run'));
  });
});

describe('Pi package: layout detection and agent dir (#5558)', () => {
  const made = [];
  after(() => { for (const d of made) cleanup(d); });

  it('is the package layout in the repo and in a complete package tree', () => {
    assert.equal(internals.isPackageLayout(REPO), true);
    const root = makePackage();
    made.push(root);
    assert.equal(internals.isPackageLayout(root), true);
  });

  it('is not the package layout for an installer tree, templates alone, or the engine alone', () => {
    const installer = tmp('gsd-pi-inst-');
    made.push(installer);
    installForPi(installer);
    assert.equal(internals.isPackageLayout(installer), false);

    const templatesOnly = tmp('gsd-pi-tonly-');
    made.push(templatesOnly);
    fs.mkdirSync(path.join(templatesOnly, 'pi', 'package-skills'), { recursive: true });
    assert.equal(internals.isPackageLayout(templatesOnly), false);

    const engineOnly = tmp('gsd-pi-eonly-');
    made.push(engineOnly);
    fs.mkdirSync(path.join(engineOnly, 'gsd-core', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(engineOnly, 'gsd-core', 'bin', 'gsd-tools.cjs'), '');
    assert.equal(internals.isPackageLayout(engineOnly), false);
  });

  it('resolves the agent dir from PI_CODING_AGENT_DIR, else ~/.pi/agent', () => {
    const home = path.join(os.tmpdir(), 'home-x');
    assert.equal(internals.piAgentDir({ PI_CODING_AGENT_DIR: '/custom/agent' }, home), path.resolve('/custom/agent'));
    assert.equal(internals.piAgentDir({}, home), path.join(home, '.pi', 'agent'));
    assert.equal(internals.piAgentDir({ PI_CODING_AGENT_DIR: '' }, home), path.join(home, '.pi', 'agent'));
  });

  it('hasWorkflowSkill reads the templates in the package layout, not the root skills dir', () => {
    const root = makePackage({ 'gsd-alpha': 'x' });
    made.push(root);
    fs.mkdirSync(path.join(root, 'skills', 'gsd-beta'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'gsd-beta', 'SKILL.md'), 'claude plugin skill');
    assert.equal(internals.hasWorkflowSkill('alpha', root), true);
    assert.equal(internals.hasWorkflowSkill('beta', root), false);
  });
});

describe('Pi package: renderPackageSkills (#5558)', () => {
  const made = [];
  after(() => { for (const d of made) cleanup(d); });

  it('renders every template with the forward-slash root and reuses a complete directory', () => {
    const root = makePackage({
      'gsd-alpha': `@${PI_ENGINE_ROOT_TOKEN}/a ${PI_ENGINE_ROOT_TOKEN}/b\n`,
      'gsd-beta': 'plain\n',
    });
    const cache = tmp('gsd-pi-cache-');
    made.push(root, cache);
    const dir = internals.renderPackageSkills(root, cache);
    assert.deepEqual(listSkillNames(dir), ['gsd-alpha', 'gsd-beta']);
    const slashRoot = root.replace(/\\/g, '/');
    assert.equal(fs.readFileSync(path.join(dir, 'gsd-alpha', 'SKILL.md'), 'utf8'), `@${slashRoot}/a ${slashRoot}/b\n`);
    const firstWrite = fs.statSync(path.join(dir, 'gsd-alpha', 'SKILL.md')).mtimeMs;
    const again = internals.renderPackageSkills(root, cache);
    assert.equal(again, dir);
    assert.equal(fs.statSync(path.join(again, 'gsd-alpha', 'SKILL.md')).mtimeMs, firstWrite);
    assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith('.tmp-')), []);
  });

  it('gives a changed template or a moved root its own directory', () => {
    const root = makePackage({ 'gsd-alpha': `@${PI_ENGINE_ROOT_TOKEN}/a\n` });
    const moved = makePackage({ 'gsd-alpha': `@${PI_ENGINE_ROOT_TOKEN}/a\n` });
    const cache = tmp('gsd-pi-cache-');
    made.push(root, moved, cache);
    const first = internals.renderPackageSkills(root, cache);
    fs.writeFileSync(path.join(root, 'pi', 'package-skills', 'gsd-alpha', 'SKILL.md'), `@${PI_ENGINE_ROOT_TOKEN}/changed\n`);
    const second = internals.renderPackageSkills(root, cache);
    const third = internals.renderPackageSkills(moved, cache);
    assert.equal(new Set([first, second, third]).size, 3);
    assert.ok(fs.existsSync(path.join(first, 'gsd-alpha', 'SKILL.md')), 'the earlier directory is left in place');
  });

  it('throws and leaves no temp directory when writing fails', () => {
    const root = makePackage();
    const cache = tmp('gsd-pi-cache-');
    made.push(root, cache);
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('disk full'); };
    try {
      assert.throws(() => internals.renderPackageSkills(root, cache), /disk full/);
    } finally {
      fs.writeFileSync = realWrite;
    }
    assert.deepEqual(fs.readdirSync(cache), []);
  });

  it('refuses to write a package location with shell or prompt metacharacters into skill text', (t) => {
    if (process.platform === 'win32') { t.skip('these characters are not valid in Windows path segments'); return; }
    const parent = tmp('gsd-pi-unsafe-');
    const cache = tmp('gsd-pi-cache-');
    made.push(parent, cache);
    for (const [i, name] of ['a$(touch x)', 'a"b', 'a`b`', 'a\nsecond line', 'a;b', "a'b", 'a$HOME', 'a&b'].entries()) {
      const root = path.join(parent, String(i), name);
      fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gsd-core', 'bin', 'gsd-tools.cjs'), '');
      fs.mkdirSync(path.join(root, 'pi', 'package-skills', 'gsd-alpha'), { recursive: true });
      fs.writeFileSync(path.join(root, 'pi', 'package-skills', 'gsd-alpha', 'SKILL.md'), `@${PI_ENGINE_ROOT_TOKEN}/x\n`);
      assert.throws(() => internals.renderPackageSkills(root, cache), /will not write into skill text/, JSON.stringify(name));
    }
    assert.deepEqual(fs.readdirSync(cache), []);
  });

  it('renders for ordinary locations: spaces, parentheses, non-ASCII letters, scoped-package paths', (t) => {
    if (process.platform === 'win32') { t.skip('parentheses and non-ASCII names are covered by the POSIX run'); return; }
    const parent = tmp('gsd-pi-ok-');
    const cache = tmp('gsd-pi-cache-');
    made.push(parent, cache);
    for (const [i, name] of ['Program Files (x86)', 'José Müller', 'node_modules/@opengsd/gsd-core', 'a+b~c.d'].entries()) {
      const root = path.join(parent, String(i), name);
      fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gsd-core', 'bin', 'gsd-tools.cjs'), '');
      fs.mkdirSync(path.join(root, 'pi', 'package-skills', 'gsd-alpha'), { recursive: true });
      fs.writeFileSync(path.join(root, 'pi', 'package-skills', 'gsd-alpha', 'SKILL.md'), `@${PI_ENGINE_ROOT_TOKEN}/x\n`);
      const dir = internals.renderPackageSkills(root, cache);
      assert.equal(fs.readFileSync(path.join(dir, 'gsd-alpha', 'SKILL.md'), 'utf8'), `@${root.replace(/\\/g, '/')}/x\n`, name);
    }
  });

  it('rewrites a cache entry that was edited, truncated or replaced by a symlink', (t) => {
    const root = makePackage({ 'gsd-alpha': `@${PI_ENGINE_ROOT_TOKEN}/a\n` });
    const cache = tmp('gsd-pi-cache-');
    made.push(root, cache);
    const dir = internals.renderPackageSkills(root, cache);
    const file = path.join(dir, 'gsd-alpha', 'SKILL.md');
    const good = fs.readFileSync(file, 'utf8');

    fs.writeFileSync(file, 'tampered\n');
    assert.equal(internals.renderPackageSkills(root, cache), dir);
    assert.equal(fs.readFileSync(file, 'utf8'), good);

    fs.writeFileSync(file, '');
    internals.renderPackageSkills(root, cache);
    assert.equal(fs.readFileSync(file, 'utf8'), good);

    if (process.platform === 'win32') { t.skip('symlink creation needs privileges on Windows'); return; }
    const outside = path.join(cache, 'outside.md');
    fs.writeFileSync(outside, good);
    fs.rmSync(file); // eslint-disable-line local/no-raw-rmsync-in-tests -- single file inside the test's own temp dir, no Windows EBUSY exposure
    fs.symlinkSync(outside, file);
    internals.renderPackageSkills(root, cache);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(file, 'utf8'), good);
  });

  it('returns the complete directory when a concurrent session wins the rename', () => {
    const root = makePackage();
    const cacheA = tmp('gsd-pi-cache-');
    const cacheB = tmp('gsd-pi-cache-');
    made.push(root, cacheA, cacheB);
    const winner = internals.renderPackageSkills(root, cacheA);
    const key = path.basename(path.dirname(winner));
    const realRename = fs.renameSync;
    fs.renameSync = () => {
      fs.cpSync(path.join(cacheA, key), path.join(cacheB, key), { recursive: true });
      throw new Error('EEXIST: rename lost the race');
    };
    let got;
    try {
      got = internals.renderPackageSkills(root, cacheB);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(got, path.join(cacheB, key, 'skills'));
    assert.deepEqual(fs.readdirSync(cacheB).filter((n) => n.startsWith('.tmp-')), []);
  });
});

describe('Pi package: activatePackageEnv (#5558)', () => {
  it('puts gsd-core/bin first once and reports whether PATH changed', () => {
    const root = path.join(os.tmpdir(), 'engine');
    const bin = path.join(root, 'gsd-core', 'bin');
    const env = { PATH: ['/usr/bin', '/bin'].join(path.delimiter) };
    assert.equal(internals.activatePackageEnv(env, root), true);
    assert.deepEqual(env.PATH.split(path.delimiter), [bin, '/usr/bin', '/bin']);
    assert.equal(internals.activatePackageEnv(env, root), false);
    assert.deepEqual(env.PATH.split(path.delimiter), [bin, '/usr/bin', '/bin']);
  });

  it('handles a missing PATH', () => {
    const root = path.join(os.tmpdir(), 'engine');
    const env = {};
    assert.equal(internals.activatePackageEnv(env, root), true);
    assert.equal(env.PATH, path.join(root, 'gsd-core', 'bin'));
  });
});

describe('Pi package: extension modes (#5558)', () => {
  const made = [];
  after(() => { for (const d of made) cleanup(d); });

  function setup() {
    const root = makePackage({ 'gsd-alpha': `@${PI_ENGINE_ROOT_TOKEN}/x\n`, 'gsd-beta': 'b\n' });
    const home = tmp('gsd-pi-home-');
    made.push(root, home);
    return { root, home, env: { PATH: '/usr/bin', HOME: home } };
  }

  it('registers resources_discover with the rendered skills and activates PATH in the package layout', () => {
    const { root, home, env } = setup();
    const pi = fakePi();
    ext(pi, { env, engineRoot: root, home });
    assert.ok(pi.commands.includes('gsd'));
    const result = pi.handlers.get('resources_discover')();
    assert.equal(result.skillPaths.length, 1);
    assert.deepEqual(listSkillNames(result.skillPaths[0]), ['gsd-alpha', 'gsd-beta']);
    assert.ok(result.skillPaths[0].startsWith(path.join(home, '.pi', 'agent', 'gsd-package-cache')));
    assert.equal(env.PATH.split(path.delimiter)[0], path.join(root, 'gsd-core', 'bin'));
  });

  it('stands down with one warning when the installer copy is also installed', async () => {
    const { root, home, env } = setup();
    fs.mkdirSync(path.join(home, '.pi', 'agent', 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'extensions', 'gsd.js'), '// installer copy\n');
    const pi = fakePi();
    ext(pi, { env, engineRoot: root, home });
    assert.deepEqual(pi.commands, []);
    assert.deepEqual(pi.tools, []);
    assert.equal(pi.handlers.has('resources_discover'), false);
    assert.equal(env.PATH, '/usr/bin');
    const notes = [];
    await pi.handlers.get('session_start')({}, { ui: { notify: (m, t) => notes.push([m, t]) } });
    assert.equal(notes.length, 1);
    assert.equal(notes[0][1], 'warning');
    assert.match(notes[0][0], /both as a Pi package and by the gsd-core installer/);
  });

  it('leaves PATH and resources alone in the installer layout', () => {
    const installer = tmp('gsd-pi-inst-');
    const home = tmp('gsd-pi-home-');
    made.push(installer, home);
    installForPi(installer);
    const env = { PATH: '/usr/bin' };
    const pi = fakePi();
    ext(pi, { env, engineRoot: installer, home });
    assert.equal(pi.handlers.has('resources_discover'), false);
    assert.equal(env.PATH, '/usr/bin');
    assert.ok(pi.commands.includes('gsd'));
  });

  it('returns nothing from resources_discover and reports at session_start when rendering fails', async () => {
    const { root, home, env } = setup();
    const pi = fakePi();
    ext(pi, { env, engineRoot: root, home });
    const realMkdir = fs.mkdirSync;
    fs.mkdirSync = () => { throw new Error('read-only file system'); };
    let result;
    try {
      result = pi.handlers.get('resources_discover')();
    } finally {
      fs.mkdirSync = realMkdir;
    }
    assert.equal(result, undefined);
    const notes = [];
    await pi.handlers.get('session_start')({}, { cwd: root, ui: { notify: (m, t) => notes.push([m, t]) } });
    assert.equal(notes.length, 1);
    assert.equal(notes[0][1], 'error');
    assert.match(notes[0][0], /could not be prepared: read-only file system/);
  });
});

describe('Pi package: render failure handling (#5558)', () => {
  const made = [];
  after(() => { for (const d of made) cleanup(d); });

  function failingSetup() {
    const root = makePackage({ 'gsd-alpha': 'a\n' });
    const home = tmp('gsd-pi-home-');
    made.push(root, home);
    const pi = fakePi();
    ext(pi, { env: { PATH: '/usr/bin' }, engineRoot: root, home });
    return { pi, root, home };
  }

  function discoverFailing(pi) {
    const realMkdir = fs.mkdirSync;
    fs.mkdirSync = () => { throw new Error('read-only file system'); };
    try {
      return pi.handlers.get('resources_discover')();
    } finally {
      fs.mkdirSync = realMkdir;
    }
  }

  it('reports the error once when resources_discover fires after session_start', async () => {
    const { pi, root } = failingSetup();
    const notes = [];
    await pi.handlers.get('session_start')({}, { cwd: root, ui: { notify: (m, t) => notes.push([m, t]) } });
    assert.deepEqual(notes, []);
    assert.equal(discoverFailing(pi), undefined);
    assert.equal(discoverFailing(pi), undefined);
    assert.equal(notes.length, 1);
    assert.equal(notes[0][1], 'error');
    assert.match(notes[0][0], /could not be prepared: read-only file system/);
  });

  it('does not hand /gsd <workflow> off to a skill that was never registered', async () => {
    const { pi } = failingSetup();
    discoverFailing(pi);
    const notes = [];
    await pi.commandDefs.get('gsd').handler('alpha', { cwd: os.tmpdir(), ui: { notify: (m, t) => notes.push([m, t]) } });
    assert.deepEqual(pi.sent, []);
    assert.equal(notes.length, 1);
    assert.equal(notes[0][1], 'error');
    assert.match(notes[0][0], /gsd-alpha is unavailable: GSD skills could not be prepared \(read-only file system\)/);
  });

  it('hands /gsd <workflow> off when rendering succeeded', async () => {
    const { pi } = failingSetup();
    assert.equal(pi.commandDefs.get('gsd') !== undefined, true);
    pi.handlers.get('resources_discover')();
    await pi.commandDefs.get('gsd').handler('alpha now', { cwd: os.tmpdir(), ui: { notify: () => {} } });
    assert.deepEqual(pi.sent, ['/skill:gsd-alpha now']);
  });
});

describe('Pi package: cache pruning (#5558)', () => {
  const made = [];
  after(() => { for (const d of made) cleanup(d); });

  it('keeps the current directory plus the newest others, up to the limit, and stale temp dirs go', () => {
    const cache = tmp('gsd-pi-prune-');
    made.push(cache);
    const keys = ['a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16), 'd'.repeat(16), 'e'.repeat(16)];
    keys.forEach((k, i) => {
      fs.mkdirSync(path.join(cache, k));
      const when = new Date(2026, 0, 1 + i);
      fs.utimesSync(path.join(cache, k), when, when);
    });
    fs.mkdirSync(path.join(cache, '.tmp-old'));
    const old = new Date(2020, 0, 1);
    fs.utimesSync(path.join(cache, '.tmp-old'), old, old);
    fs.mkdirSync(path.join(cache, '.tmp-fresh'));
    fs.mkdirSync(path.join(cache, 'not-a-hash'));
    internals.pruneRenderCache(cache, keys[0]);
    // current ('a', oldest mtime) is kept; limit 3 keeps it plus the 2 newest others ('e', 'd')
    assert.deepEqual(fs.readdirSync(cache).sort(), ['.tmp-fresh', 'a'.repeat(16), 'd'.repeat(16), 'e'.repeat(16), 'not-a-hash']);
    assert.equal(internals.RENDER_CACHE_KEEP, 3);
  });

  it('is a no-op on a missing cache root', () => {
    assert.doesNotThrow(() => internals.pruneRenderCache(path.join(os.tmpdir(), 'gsd-pi-missing-cache'), 'f'.repeat(16)));
  });
});

describe('Pi package: token substitution (#5558)', () => {
  it('render inverts tokenize for any text without the token and any non-empty slash-form root', () => {
    const text = fc.array(fc.constantFrom('text ', '\n', '/gsd-core/x ', '@', '`', 'C:/Users/a b/'), { maxLength: 12 })
      .map((parts) => parts.join(''));
    const root = fc.stringMatching(/^[A-Za-z0-9 $_./-]{1,24}$/);
    fc.assert(
      fc.property(text, root, (body, r) => {
        assert.equal(renderSkillTemplate(tokenizeSkill(body, r), r), body);
      }),
      { seed: 5558, numRuns: 100 },
    );
  });

  it('tokenizes and renders a backslash root in its forward-slash form', () => {
    const root = 'C:\\Users\\me\\.pi\\agent';
    const body = 'read @C:/Users/me/.pi/agent/gsd-core/a.md and C:\\Users\\me\\.pi\\agent\\gsd-core\\b.md';
    const template = tokenizeSkill(body, root);
    assert.equal(template, `read @${PI_ENGINE_ROOT_TOKEN}/gsd-core/a.md and ${PI_ENGINE_ROOT_TOKEN}\\gsd-core\\b.md`);
    assert.equal(renderSkillTemplate(template, root), 'read @C:/Users/me/.pi/agent/gsd-core/a.md and C:/Users/me/.pi/agent\\gsd-core\\b.md');
  });
});
