'use strict';

/**
 * #5547 — Pi has an entry point from a GSD command to its workflow.
 *
 * Before: Pi installed one extension file and no command/skill artifacts, so
 * `/gsd init new-project` printed the init JSON and stopped. The installer now
 * writes every GSD command as a Pi skill (`skills/gsd-<name>/SKILL.md`, invoked
 * `/skill:gsd-<name>`), and `/gsd <command>` hands off to it.
 *
 * Covered here:
 *  - the Pi skill converter (invocation hint, command-reference rewrite, and the
 *    fail-closed dispatch contract every Pi skill carries);
 *  - the descriptor declares a skills-only layout (no commands/agents kind);
 *  - the hand-off decision (`resolveWorkflowHandoff`) and next-step hint;
 *  - the real installed extension: `/gsd new-project` sends `/skill:gsd-new-project`,
 *    `/gsd init new-project` keeps its data but names the next step, and a data
 *    family keeps its data semantics.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { _internals } = require('../pi/gsd.cjs');
const {
  convertClaudeCommandToPiSkill,
  PI_DISPATCH_CONTRACT,
  PI_INCLUDE_NOTE,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');

const SAMPLE_COMMAND = [
  '---',
  'name: gsd:plan-phase',
  'description: Plan a phase, then run /gsd:execute-phase',
  'argument-hint: "[phase]"',
  '---',
  '',
  '<execution_context>',
  '@~/.claude/gsd-core/workflows/plan-phase.md',
  '</execution_context>',
  '',
  'When planning is done, continue with /gsd-execute-phase.',
  '',
].join('\n');

describe('#5547: convertClaudeCommandToPiSkill', () => {
  const out = convertClaudeCommandToPiSkill(SAMPLE_COMMAND, 'gsd-plan-phase', 'pi', ['plan-phase', 'execute-phase']);

  test('emits Agent Skills frontmatter named for the skill directory', () => {
    assert.match(out, /^---\r?\nname: gsd-plan-phase\r?\n/);
    assert.match(out, /\ndescription: /);
    assert.doesNotMatch(out, /argument-hint:/, 'Pi skills carry only name + description');
  });

  test('tells the reader to invoke it as a Pi skill, not a Kimi one', () => {
    assert.match(out, /Invoke this Pi skill with `\/skill:gsd-plan-phase`\./);
    assert.doesNotMatch(out, /Kimi/);
  });

  test('rewrites GSD command references to /skill: invocations', () => {
    assert.match(out, /continue with \/skill:gsd-execute-phase\./);
    assert.doesNotMatch(out, /\/gsd-execute-phase/);
  });

  test('carries the fail-closed dispatch contract exactly once', () => {
    assert.equal(out.split(PI_DISPATCH_CONTRACT).length - 1, 1);
    assert.match(PI_DISPATCH_CONTRACT, /Pi has no subagent dispatch API/);
    assert.match(PI_DISPATCH_CONTRACT, /Never execute the role's work inline as a substitute/);
    assert.match(PI_DISPATCH_CONTRACT, /issues\/5559/);
  });

  test('the contract names every way a workflow spawns an agent, and handles optional steps', () => {
    for (const phrase of [/Agent\(\.\.\.\)/, /subagent_type/, /subagent spawns/, /named `gsd-\*` role/]) {
      assert.match(PI_DISPATCH_CONTRACT, phrase);
    }
    assert.match(PI_DISPATCH_CONTRACT, /optional.*offer to skip it and continue/);
    assert.match(PI_DISPATCH_CONTRACT, /required, stop the run/);
  });

  test('tells the agent to read the execution_context files itself, exactly once', () => {
    assert.equal(out.split(PI_INCLUDE_NOTE).length - 1, 1);
    assert.match(PI_INCLUDE_NOTE, /does not expand `@path`/);
    assert.match(PI_INCLUDE_NOTE, /every file listed under `<execution_context>`/);
  });

  test('keeps the workflow include in the body', () => {
    assert.match(out, /workflows\/plan-phase\.md/);
  });
});

describe('#5547: pi descriptor layout', () => {
  const cap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'pi', 'capability.json'), 'utf8'));
  const layout = cap.runtime.artifactLayout;

  for (const scope of ['global', 'local']) {
    test(`${scope}: exactly one skills kind, converted for Pi`, () => {
      assert.deepEqual(layout[scope].map((k) => k.kind), ['skills']);
      assert.equal(layout[scope][0].converter, 'convertClaudeCommandToPiSkill');
      assert.equal(layout[scope][0].prefix, 'gsd-');
      assert.equal(layout[scope][0].destSubpath, 'skills');
    });
  }

  test('still has no agent dispatch (the fail-closed contract depends on it)', () => {
    assert.equal(cap.runtime.hostIntegration.dispatch.namedDispatch, false);
  });
});

describe('#5547: workflow hand-off decision', () => {
  function engineWithSkills(t, names) {
    const root = createTempDir('gsd-pi-handoff-');
    t.after(() => cleanup(root));
    for (const n of names) {
      fs.mkdirSync(path.join(root, 'skills', `gsd-${n}`), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills', `gsd-${n}`, 'SKILL.md'), '---\nname: x\n---\n');
    }
    return root;
  }

  test('hasWorkflowSkill is true only for an installed skill file', (t) => {
    const root = engineWithSkills(t, ['new-project']);
    assert.equal(_internals.hasWorkflowSkill('new-project', root), true);
    assert.equal(_internals.hasWorkflowSkill('plan-phase', root), false);
  });

  test('hasWorkflowSkill rejects names that could escape skills/', (t) => {
    const root = engineWithSkills(t, ['new-project']);
    for (const hostile of ['../new-project', 'new-project/..', '', 'NEW', '-x', 'a b', undefined, null, 5]) {
      assert.equal(_internals.hasWorkflowSkill(hostile, root), false, String(hostile));
    }
  });

  test('a workflow command hands off to its skill with its arguments verbatim', (t) => {
    const root = engineWithSkills(t, ['new-project', 'plan-phase']);
    assert.deepEqual(_internals.resolveWorkflowHandoff('new-project', root), {
      skill: 'gsd-new-project',
      message: '/skill:gsd-new-project',
    });
    assert.deepEqual(_internals.resolveWorkflowHandoff('plan-phase 3 --research "two words"', root), {
      skill: 'gsd-plan-phase',
      message: '/skill:gsd-plan-phase 3 --research "two words"',
    });
  });

  test('a data family keeps data semantics even when a same-named skill exists', (t) => {
    const root = engineWithSkills(t, ['phase', 'progress', 'init']);
    for (const family of ['phase list', 'progress json', 'init new-project']) {
      assert.equal(_internals.resolveWorkflowHandoff(family, root), null, family);
    }
  });

  test('an unknown command and empty args do not hand off', (t) => {
    const root = engineWithSkills(t, ['new-project']);
    assert.equal(_internals.resolveWorkflowHandoff('no-such-command', root), null);
    assert.equal(_internals.resolveWorkflowHandoff('', root), null);
  });

  test('nextStepFor names the workflow only for `init <installed workflow>`', (t) => {
    const root = engineWithSkills(t, ['new-project']);
    assert.match(_internals.nextStepFor('init', 'new-project', [], root), /Next: run \/gsd new-project \(or \/skill:gsd-new-project\)/);
    assert.equal(_internals.nextStepFor('init', 'plan-phase', [], root), '', 'no skill, no hint');
    assert.equal(_internals.nextStepFor('state', 'new-project', [], root), '', 'only init is a workflow-init call');
    assert.equal(_internals.nextStepFor('init', undefined, [], root), '');
  });

  test('nextStepFor carries positional arguments and drops flags', (t) => {
    const root = engineWithSkills(t, ['execute-phase']);
    const hint = _internals.nextStepFor('init', 'execute-phase', ['3', '--raw', '--json-errors'], root);
    assert.match(hint, /Next: run \/gsd execute-phase 3 \(or \/skill:gsd-execute-phase 3\) to start/);
    assert.doesNotMatch(hint, /--raw|--json-errors/);
    assert.doesNotMatch(_internals.nextStepFor('init', 'execute-phase', undefined, root), /execute-phase undefined/);
  });
});

describe('#5547: the installed Pi extension', () => {
  function installedExtension(t) {
    const { configDir, root } = runMinimalInstall({ runtime: 'pi', scope: 'global' });
    t.after(() => cleanup(root));
    const extPath = path.join(configDir, 'extensions', 'gsd.js');
    const ext = require(extPath);
    const recorded = { commands: {}, sent: [] };
    const pi = {
      registerCommand(name, def) { recorded.commands[name] = def; },
      registerTool() {},
      on() {},
      sendUserMessage(content, options) { recorded.sent.push({ content, options }); },
    };
    ext(pi);
    const notifications = [];
    const ctx = { cwd: root, ui: { notify(message, type) { notifications.push({ message, type }); } } };
    return { configDir, handler: recorded.commands.gsd.handler, sent: recorded.sent, notifications, ctx };
  }

  test('installs a SKILL.md per command, carrying the dispatch contract', (t) => {
    const { configDir } = installedExtension(t);
    const skill = fs.readFileSync(path.join(configDir, 'skills', 'gsd-new-project', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\r?\nname: gsd-new-project\r?\n/);
    assert.ok(skill.includes(PI_DISPATCH_CONTRACT));
  });

  // pi's file tools strip a leading `@` and expand `~` (path-utils.js
  // `resolveToCwd`, stripAtPrefix + resolvePath), but never expand `$HOME` — so
  // the workflow include must be the tilde form, pointed at pi's own config home.
  test('installed skill bodies point at the pi config home, not ~/.claude', (t) => {
    const { configDir } = installedExtension(t);
    for (const stem of ['new-project', 'plan-phase', 'execute-phase']) {
      const skill = fs.readFileSync(path.join(configDir, 'skills', `gsd-${stem}`, 'SKILL.md'), 'utf8');
      assert.doesNotMatch(skill, /\.claude\//, `gsd-${stem} still references ~/.claude`);
      assert.match(skill, new RegExp(`@~/\\.pi/agent/gsd-core/workflows/${stem}\\.md`), `gsd-${stem} include`);
    }
  });

  test('/gsd new-project starts the workflow instead of printing data', async (t) => {
    const { handler, sent, notifications, ctx } = installedExtension(t);
    await handler('new-project', ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, '/skill:gsd-new-project');
    assert.equal(sent[0].options.expandPromptTemplates, true, 'Pi must expand the /skill: command');
    assert.equal(notifications.length, 0, 'no data dump');
  });

  test('/gsd init new-project still returns its data and names the next step', async (t) => {
    const { handler, sent, notifications, ctx } = installedExtension(t);
    await handler('init new-project', ctx);
    assert.equal(sent.length, 0, 'init is a data call, not a hand-off');
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /Next: run \/gsd new-project \(or \/skill:gsd-new-project\)/);
  });

  test('a data family is not handed off', async (t) => {
    const { handler, sent, notifications, ctx } = installedExtension(t);
    await handler('phase list', ctx);
    assert.equal(sent.length, 0);
    assert.equal(notifications.length, 1);
  });

  test('uninstall removes the gsd skills and leaves a user-owned skill alone', (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'pi', scope: 'global' });
    t.after(() => cleanup(root));
    const own = path.join(configDir, 'skills', 'my-own-skill');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'SKILL.md'), '---\nname: my-own-skill\ndescription: x\n---\n');

    // Same helper, same sandbox root, `--uninstall` appended: it asserts the
    // installer exited 0 and uses the sanitized installer env.
    runMinimalInstall({ runtime: 'pi', scope: 'global', root, extraArgs: ['--uninstall'] });
    assert.deepEqual(fs.readdirSync(path.join(configDir, 'skills')), ['my-own-skill']);
  });

  test('without sendUserMessage the command tells the user how to start the skill by hand', async (t) => {
    const { configDir, root } = (() => {
      const r = runMinimalInstall({ runtime: 'pi', scope: 'global' });
      t.after(() => cleanup(r.root));
      return r;
    })();
    const ext = require(path.join(configDir, 'extensions', 'gsd.js'));
    const commands = {};
    ext({ registerCommand(n, d) { commands[n] = d; }, registerTool() {}, on() {} });
    const notifications = [];
    await commands.gsd.handler('new-project', { cwd: root, ui: { notify(m, ty) { notifications.push({ m, ty }); } } });
    assert.equal(notifications.length, 1, 'says how to start the workflow rather than doing nothing');
    assert.match(notifications[0].m, /Run \/skill:gsd-new-project to start/, 'names the skill command, not a data dump');
    assert.equal(notifications[0].ty, 'info');
  });
});
