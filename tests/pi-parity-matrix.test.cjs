'use strict';

/**
 * #5561 (epic #5556, Phase 4): the Pi parity matrix.
 *
 * Every surface a Claude install ships — command, workflow, agent role, hook — must be reachable
 * on Pi or carry a recorded disposition, and a disposition for something that is no longer true
 * must go. The real trees are an isolated `--pi --global` install against the shipped sources; the
 * synthetic cases prove the check goes red when a Claude surface is added without a Pi disposition.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const {
  listWorkflows,
  WORKFLOW_DISPOSITIONS,
  diffSurface,
  namedWorkflows,
  reachableWorkflows,
  registeredHooks,
} = require('./helpers/pi-parity.cjs');
const { _internals } = require('../pi/gsd.cjs');
const { PI_UNSUPPORTED_SKILLS, PI_PARTIAL_SKILLS } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const { PI_HOOK_DISPOSITIONS, PI_PRE_TOOL_HOOKS, PI_POST_TOOL_HOOKS } = _internals;
const REPO = path.join(__dirname, '..');
const PARITY_DOC = path.join(REPO, 'docs', 'reference', 'pi-parity-matrix.md');
const STUB_MARKER = 'is unsupported on Pi:';
const HOOK_FILE = /\.(js|sh)$/;
const HOOK_STATUSES = new Set(['bridged', 'unsupported', 'not-applicable', 'internal']);

const listDir = (dir) => fs.readdirSync(dir).sort();
/** Regular files of a directory; a subdirectory is skipped, never read as a file. */
const listFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

describe('#5561: diffSurface goes red on an undisposed Claude surface', () => {
  test('a Claude surface with no Pi counterpart and no disposition is undisposed', () => {
    assert.deepEqual(diffSurface(['a', 'b'], ['a'], {}), { undisposed: ['b'], stale: [] });
  });

  test('a disposition removes it from undisposed', () => {
    assert.deepEqual(diffSurface(['a', 'b'], ['a'], { b: 'no Pi equivalent' }), { undisposed: [], stale: [] });
  });

  test('a disposition for a surface Claude no longer ships is stale', () => {
    assert.deepEqual(diffSurface(['a'], ['a'], { gone: 'x' }), { undisposed: [], stale: ['gone'] });
  });

  test('a disposition for a surface Pi has after all is stale', () => {
    assert.deepEqual(diffSurface(['a', 'b'], ['a', 'b'], { b: 'x' }), { undisposed: [], stale: ['b'] });
  });

  test('0, 1 and 2 undisposed surfaces are each reported exactly', () => {
    assert.deepEqual(diffSurface(['a'], ['a'], {}).undisposed, []);
    assert.deepEqual(diffSurface(['a', 'z'], ['a'], {}).undisposed, ['z']);
    assert.deepEqual(diffSurface(['a', 'z', 'y'], ['a'], {}).undisposed, ['y', 'z']);
  });

  test('property: any surface added to Claude alone is undisposed', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 6 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (shared, added) => {
          fc.pre(!shared.includes(added));
          const { undisposed } = diffSurface([...shared, added], shared, {});
          return undisposed.length === 1 && undisposed[0] === added;
        },
      ),
    );
  });

  test('a disposition keyed on an inherited property name is not honoured', () => {
    assert.deepEqual(diffSurface(['constructor'], [], {}).undisposed, ['constructor']);
  });
});

describe('#5561: workflow reachability helpers', () => {
  test('a name is not found inside a longer file name', () => {
    const found = namedWorkflows('run ultraplan-phase.md now', ['plan-phase.md', 'ultraplan-phase.md']);
    assert.deepEqual([...found], ['ultraplan-phase.md']);
  });

  test('a workflow named only by another workflow is reachable', () => {
    const files = { 'a.md': 'see b.md', 'b.md': 'see c.md', 'c.md': '', 'd.md': '' };
    const reached = reachableWorkflows(['start a.md'], Object.keys(files), (n) => files[n]);
    assert.deepEqual([...reached].sort(), ['a.md', 'b.md', 'c.md']);
  });

  test('cyclic references terminate', () => {
    const files = { 'a.md': 'b.md', 'b.md': 'a.md' };
    const reached = reachableWorkflows(['a.md'], Object.keys(files), (n) => files[n]);
    assert.deepEqual([...reached].sort(), ['a.md', 'b.md']);
  });

  test('registeredHooks reads event and hook file from a hooks.json manifest', () => {
    const pairs = registeredHooks({
      hooks: { PreToolUse: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/gsd-x.js"' }] }] },
    });
    assert.deepEqual(pairs, [{ event: 'PreToolUse', file: 'gsd-x.js' }]);
  });
});

describe('#5561: Pi parity over the shipped surface', () => {
  let root;
  let configDir;

  before(() => {
    ({ root, configDir } = runMinimalInstall({ runtime: 'pi', scope: 'global' }));
  });
  after(() => cleanup(root));

  const claudeCommands = () =>
    listDir(path.join(REPO, 'commands', 'gsd')).filter((f) => f.endsWith('.md')).map((f) => `gsd-${f.slice(0, -3)}`);
  const piSkills = () => listDir(path.join(configDir, 'skills')).filter((n) => n.startsWith('gsd-'));
  const skillBody = (name) => read(configDir, 'skills', name, 'SKILL.md');
  const isStub = (name) => skillBody(name).includes(STUB_MARKER);

  test('every Claude command has a Pi skill; the stubs are exactly the recorded unsupported skills', () => {
    const commands = claudeCommands();
    assert.ok(commands.length > 0, 'vacuous: no commands shipped');
    const skills = piSkills();
    const stubs = skills.filter(isStub).sort();
    assert.deepEqual(stubs, Object.keys(PI_UNSUPPORTED_SKILLS).sort());
    const { undisposed, stale } = diffSurface(
      commands,
      skills.filter((n) => !isStub(n)),
      PI_UNSUPPORTED_SKILLS,
    );
    assert.deepEqual(undisposed, [], 'Claude commands with no Pi skill and no unsupported-on-pi disposition');
    assert.deepEqual(stale, [], 'unsupported-on-pi dispositions that name no shipped command or a working skill');
    assert.deepEqual(skills.filter((n) => !commands.includes(n)), [], 'Pi skills with no Claude command');
  });

  test('the real-tree checks go red when a Claude surface is added without a Pi disposition', () => {
    assert.ok(PI_UNSUPPORTED_SKILLS && typeof PI_UNSUPPORTED_SKILLS === 'object', 'run `npm run build:lib` first');
    const skills = piSkills().filter((n) => !isStub(n));
    assert.deepEqual(
      diffSurface([...claudeCommands(), 'gsd-brand-new'], skills, PI_UNSUPPORTED_SKILLS).undisposed,
      ['gsd-brand-new'],
    );
    const roles = listDir(path.join(configDir, 'agents'));
    assert.deepEqual(diffSurface([...roles, 'gsd-brand-new.md'], roles, {}).undisposed, ['gsd-brand-new.md']);
    assert.deepEqual(
      diffSurface(['brand-new.md'], [], WORKFLOW_DISPOSITIONS).undisposed,
      ['brand-new.md'],
    );
    const hookFiles = listFiles(path.join(REPO, 'hooks')).filter((f) => HOOK_FILE.test(f));
    assert.deepEqual(
      diffSurface([...hookFiles, 'gsd-new-hook.js'], Object.keys(PI_HOOK_DISPOSITIONS), {}).undisposed,
      ['gsd-new-hook.js'],
    );
  });

  test('every unsupported or partial Pi skill states its reason', () => {
    for (const [name, reason] of Object.entries(PI_UNSUPPORTED_SKILLS)) {
      assert.ok(reason.length > 0, name);
      assert.ok(skillBody(name).includes(reason), `${name} does not print its reason`);
    }
    assert.ok(Object.keys(PI_PARTIAL_SKILLS).length > 0, 'vacuous: no partial skill recorded');
    for (const [name, { reason, subcommands }] of Object.entries(PI_PARTIAL_SKILLS)) {
      assert.ok(reason.length > 0 && subcommands.length > 0, name);
      assert.equal(isStub(name), false, `${name} is partial, not a stub`);
      assert.ok(skillBody(name).includes(reason), `${name} does not print its reason`);
      for (const sub of subcommands) assert.ok(skillBody(name).includes(`\`${sub}`), `${name} does not name ${sub}`);
    }
  });

  test('every shipped workflow is installed and reachable from a runnable Pi skill or role', () => {
    const shipped = listWorkflows(path.join(REPO, 'gsd-core', 'workflows'));
    assert.ok(shipped.length > 0, 'vacuous: no workflows shipped');
    assert.ok(shipped.some((f) => f.includes('/')), 'vacuous: no workflow in a subdirectory');
    const installedDir = path.join(configDir, 'gsd-core', 'workflows');
    assert.deepEqual(shipped.filter((f) => !fs.existsSync(path.join(installedDir, ...f.split('/')))), []);

    const mdFiles = (dir) => listFiles(dir).filter((f) => f.endsWith('.md'));
    const claudeRoots = [
      ...mdFiles(path.join(REPO, 'commands', 'gsd')).map((f) => read(REPO, 'commands', 'gsd', f)),
      ...mdFiles(path.join(REPO, 'agents')).map((f) => read(REPO, 'agents', f)),
    ];
    const piRoots = [
      ...piSkills().filter((n) => !isStub(n)).map(skillBody),
      ...mdFiles(path.join(configDir, 'agents')).map((f) => read(configDir, 'agents', f)),
    ];
    const readWorkflow = (name) => read(REPO, 'gsd-core', 'workflows', ...name.split('/'));
    const onClaude = reachableWorkflows(claudeRoots, shipped, readWorkflow);
    const onPi = reachableWorkflows(piRoots, shipped, readWorkflow);
    assert.ok(onClaude.size > 0 && onPi.size > 0, 'vacuous: nothing reachable');
    const { undisposed, stale } = diffSurface(onClaude, onPi, WORKFLOW_DISPOSITIONS);
    assert.deepEqual(undisposed, [], 'workflows Claude reaches, Pi does not, with no disposition');
    assert.deepEqual(stale, [], 'workflow dispositions that are no longer true');
  });

  test('every non-compact Claude role is installed on Pi and no compact variant is', () => {
    const shipped = listDir(path.join(REPO, 'agents')).filter((f) => f.endsWith('.md'));
    const wanted = shipped.filter((f) => !f.endsWith('.compact.md'));
    const installed = listDir(path.join(configDir, 'agents'));
    assert.ok(wanted.length > 0, 'vacuous: no roles shipped');
    assert.deepEqual(diffSurface(wanted, installed, {}), { undisposed: [], stale: [] });
    assert.deepEqual(installed.filter((f) => f.endsWith('.compact.md')), []);
  });

  test('every hook file and every hooks.json event/hook pair has a Pi disposition', () => {
    const hookFiles = listDir(path.join(REPO, 'hooks')).filter((f) => HOOK_FILE.test(f));
    assert.ok(hookFiles.length > 0, 'vacuous: no hooks shipped');
    assert.deepEqual(diffSurface(hookFiles, Object.keys(PI_HOOK_DISPOSITIONS), {}).undisposed, []);
    assert.deepEqual(Object.keys(PI_HOOK_DISPOSITIONS).filter((f) => !hookFiles.includes(f)), []);
    const manifest = JSON.parse(read(REPO, 'hooks', 'hooks.json'));
    const pairs = registeredHooks(manifest);
    assert.ok(pairs.length > 0, 'vacuous: no registered hooks');
    for (const { event, file } of pairs) {
      const entries = PI_HOOK_DISPOSITIONS[file] || [];
      assert.ok(entries.some((e) => e.claude === event), `${file} on ${event} has no Pi disposition`);
    }
    const preFiles = new Set(PI_PRE_TOOL_HOOKS.map((h) => h[0]));
    const postFiles = new Set(PI_POST_TOOL_HOOKS.map((h) => h[0]));
    for (const [file, entries] of Object.entries(PI_HOOK_DISPOSITIONS)) {
      for (const e of entries) {
        assert.ok(HOOK_STATUSES.has(e.status), `${file}: unknown status ${e.status}`);
        if (e.status === 'bridged' && e.pi.startsWith('tool_call')) assert.ok(preFiles.has(file), `${file}: bridged on tool_call but not in the bridge`);
        if (e.status === 'bridged' && e.pi.startsWith('tool_result')) assert.ok(postFiles.has(file), `${file}: bridged on tool_result but not in the bridge`);
        if (e.status !== 'bridged') assert.ok(e.reason && e.reason.length > 0, `${file}: no reason`);
      }
    }
  });

  test('the reference page lists every unsupported skill, ledgered workflow and non-bridged hook', () => {
    const doc = read(PARITY_DOC);
    for (const [name, reason] of Object.entries(PI_UNSUPPORTED_SKILLS)) {
      assert.ok(doc.includes(`/skill:${name}`), `${name} missing from the page`);
      assert.ok(doc.includes(reason), `${name} reason missing from the page`);
    }
    for (const [name, { reason }] of Object.entries(PI_PARTIAL_SKILLS)) {
      assert.ok(doc.includes(`/skill:${name}`), `${name} missing from the page`);
      assert.ok(doc.includes(reason), `${name} reason missing from the page`);
    }
    for (const [file, entries] of Object.entries(PI_HOOK_DISPOSITIONS)) {
      // Cursor and Windsurf hooks are named by family prefix on the page, not one by one.
      if (entries.every((e) => e.status === 'bridged' || e.status === 'not-applicable')) continue;
      assert.ok(doc.includes(file), `${file} missing from the page`);
    }
    for (const file of Object.keys(WORKFLOW_DISPOSITIONS)) assert.ok(doc.includes(file), `${file} missing`);
  });
});
