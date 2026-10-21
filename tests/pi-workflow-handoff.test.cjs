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
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// Stable markers that open the two blocks every Pi skill carries; asserted as literals so
// the tests do not import the constants they are checking.
const CONTRACT_MARKER = '**Pi host constraint (fail closed).**';
const INCLUDE_MARKER = '**Pi includes.**';

// pi 1.3.0 skills documentation: "descriptions can contain at most 1024".
const PI_DESCRIPTION_MAX = 1024;

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
    assert.equal(out.split(CONTRACT_MARKER).length - 1, 1);
    assert.match(out, /Pi has no subagent dispatch API/);
    assert.match(out, /Never execute the role's work inline as a substitute/);
    assert.match(out, /issues\/5559/);
  });

  test('the contract names every way a workflow spawns an agent, and handles optional steps', () => {
    for (const phrase of [/Agent\(\.\.\.\)/, /subagent_type/, /subagent spawns/, /named `gsd-\*` role/]) {
      assert.match(out, phrase);
    }
    assert.match(out, /optional.*offer to skip it and continue/);
    assert.match(out, /required, stop the run/);
  });

  test('tells the agent to read the execution_context files itself, exactly once', () => {
    assert.equal(out.split(INCLUDE_MARKER).length - 1, 1);
    assert.match(out, /does not expand `@path`/);
    assert.match(out, /every file listed under `<execution_context>`/);
  });

  test('keeps the workflow include in the body', () => {
    assert.match(out, /workflows\/plan-phase\.md/);
  });

  test('caps the description at Pi\'s 1024-character limit', () => {
    const long = 'x'.repeat(PI_DESCRIPTION_MAX + 500);
    const skill = convertClaudeCommandToPiSkill(`---\nname: gsd:x\ndescription: ${long}\n---\nbody\n`, 'gsd-x', 'pi', ['x']);
    const line = skill.split(/\r?\n/).find((l) => l.startsWith('description: '));
    assert.ok(JSON.parse(line.slice('description: '.length)).length <= PI_DESCRIPTION_MAX);
  });

  // Boundary: limit-1, limit, limit+1 (the cap is Pi's, 1024 characters).
  function descriptionOf(skill) {
    const line = skill.split(/\r?\n/).find((l) => l.startsWith('description: '));
    return JSON.parse(line.slice('description: '.length));
  }
  function convertWithDescription(description) {
    return convertClaudeCommandToPiSkill(`---\nname: gsd:x\ndescription: ${description}\n---\nbody\n`, 'gsd-x', 'pi', ['x']);
  }

  for (const [label, length, expected] of [['limit-1', PI_DESCRIPTION_MAX - 1, PI_DESCRIPTION_MAX - 1], ['limit', PI_DESCRIPTION_MAX, PI_DESCRIPTION_MAX], ['limit+1', PI_DESCRIPTION_MAX + 1, PI_DESCRIPTION_MAX]]) {
    test(`description boundary ${label}: ${length} characters in, ${expected} out, nothing else changed`, () => {
      const description = 'a'.repeat(length);
      const out = descriptionOf(convertWithDescription(description));
      assert.equal(out.length, expected);
      assert.equal(out, description.slice(0, expected));
    });
  }

  test('a 4-byte character straddling the limit is dropped whole, never split into a lone surrogate', () => {
    const description = `${'a'.repeat(PI_DESCRIPTION_MAX - 1)}😀tail`;
    const out = descriptionOf(convertWithDescription(description));
    assert.ok(out.length <= PI_DESCRIPTION_MAX);
    assert.equal(out, 'a'.repeat(PI_DESCRIPTION_MAX - 1), 'the emoji does not fit, so it goes entirely');
    assert.doesNotMatch(out, /[\ud800-\udbff]$/, 'ends on a lone high surrogate');
  });

  test('property: any description yields a single-line description within the cap and a well-formed string', () => {
    // 'grapheme' draws valid code points (astral characters included), so a lone
    // surrogate in the OUTPUT can only come from the cap, never from the input.
    fc.assert(fc.property(fc.string({ unit: 'grapheme', minLength: 900, maxLength: 3000 }), (raw) => {
      const description = raw.replace(/[\r\n]/g, ' ').replace(/^\s+|\s+$/g, '');
      if (description === '') return true; // an empty description falls back to a generated one
      const skill = convertWithDescription(JSON.stringify(description));
      const out = descriptionOf(skill);
      return out.length <= PI_DESCRIPTION_MAX
        && !/[\r\n]/.test(out)
        && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)
        && !/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out);
    }), { numRuns: 200 });
  });

  test('property: $ARGUMENTS outside a fence is replaced, inside a fence it is untouched', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }).filter((s) => !/[`~\r\n]/.test(s)), (filler) => {
      const body = `before ${filler} $ARGUMENTS ${filler}\n\`\`\`\necho $ARGUMENTS ${filler}\n\`\`\`\n`;
      const skill = convertClaudeCommandToPiSkill(`---\nname: gsd:x\ndescription: d\n---\n${body}`, 'gsd-x', 'pi', ['x']);
      const [outside, inside] = skill.split('```\n');
      const stripped = outside.replace(/\(the text typed after the skill name\)/g, '');
      return !/\$ARGUMENTS(?![A-Za-z0-9_])/.test(stripped.slice(stripped.indexOf('before ')))
        && inside.includes(`echo $ARGUMENTS ${filler}`);
    }), { numRuns: 100 });
  });

  test('every shipped command converts to a skill within Pi\'s name and description limits', () => {
    const dir = path.join(__dirname, '..', 'commands', 'gsd');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const stem = file.slice(0, -3);
      const skill = convertClaudeCommandToPiSkill(fs.readFileSync(path.join(dir, file), 'utf8'), `gsd-${stem}`, 'pi', [stem]);
      const name = /^name: (.+)$/m.exec(skill)[1];
      assert.equal(name, `gsd-${stem}`);
      assert.ok(name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name), `${name} breaks Pi's name rules`);
      const desc = /^description: (.+)$/m.exec(skill)[1];
      assert.ok(JSON.parse(desc).length <= PI_DESCRIPTION_MAX, `${stem}: description too long`);
    }
  });

  test('no shipped command leaves a /gsd:<cmd> colon-form reference in its skill, description included', () => {
    const dir = path.join(__dirname, '..', 'commands', 'gsd');
    const stems = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    const left = [];
    for (const stem of stems) {
      const skill = convertClaudeCommandToPiSkill(fs.readFileSync(path.join(dir, `${stem}.md`), 'utf8'), `gsd-${stem}`, 'pi', stems);
      skill.split(/\r?\n/).forEach((line, i) => { if (/(?<![\w/])\/?gsd:[a-z]/.test(line)) left.push(`${stem}:${i + 1}: ${line.trim().slice(0, 80)}`); });
    }
    assert.deepEqual(left, []);
  });

  test('replaces the $ARGUMENTS placeholder outside code fences only, as a whole word', () => {
    const src = '---\nname: gsd:x\ndescription: d\n---\nUse $ARGUMENTS here and $ARGUMENTS_FOO there.\n```\necho $ARGUMENTS\n```\n';
    const skill = convertClaudeCommandToPiSkill(src, 'gsd-x', 'pi', ['x']);
    assert.match(skill, /Use \(the text typed after the skill name\) here and \$ARGUMENTS_FOO there\./);
    assert.match(skill, /echo \$ARGUMENTS/);
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

  test('property: a hand-off only ever names an installed skill whose stem is a plain lowercase token', (t) => {
    const root = engineWithSkills(t, ['new-project', 'plan-phase', 'help']);
    const installed = new Set(['new-project', 'plan-phase', 'help']);
    fc.assert(fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 20 }), (first, rest) => {
      const handoff = _internals.resolveWorkflowHandoff(`${first} ${rest}`, root);
      if (handoff === null) return true;
      const stem = handoff.skill.replace(/^gsd-/, '');
      return installed.has(stem) && /^[a-z0-9][a-z0-9-]*$/.test(stem) && handoff.message.startsWith(`/skill:gsd-${stem}`);
    }), { numRuns: 300 });
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
    assert.match(_internals.nextStepFor({ family: 'init', subcommand: 'new-project', args: [] }, root), /Next: run \/gsd new-project \(or \/skill:gsd-new-project\)/);
    assert.equal(_internals.nextStepFor({ family: 'init', subcommand: 'plan-phase', args: [] }, root), '', 'no skill, no hint');
    assert.equal(_internals.nextStepFor({ family: 'state', subcommand: 'new-project', args: [] }, root), '', 'only init is a workflow-init call');
    assert.equal(_internals.nextStepFor({ family: 'init', subcommand: undefined, args: [] }, root), '');
  });

  test('nextStepFor maps init workflows whose skill has a different name', (t) => {
    const root = engineWithSkills(t, ['resume-work', 'workspace', 'discuss-phase']);
    assert.match(_internals.nextStepFor({ family: 'init', subcommand: 'resume', args: [] }, root), /Next: run \/gsd resume-work \(or \/skill:gsd-resume-work\)/);
    assert.match(_internals.nextStepFor({ family: 'init', subcommand: 'new-workspace', args: [] }, root), /\/skill:gsd-workspace\)/);
    assert.match(_internals.nextStepFor({ family: 'init', subcommand: 'discuss-phase-assumptions', args: [] }, root), /\/skill:gsd-discuss-phase\)/);
  });

  test('every hinted init workflow points at a real command file', () => {
    const hinted = _internals.PI_WORKFLOW_INIT_COMMANDS;
    assert.ok(Object.keys(hinted).length > 0);
    for (const [init, command] of Object.entries(hinted)) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'commands', 'gsd', `${command}.md`)), `${init} -> ${command} has no command file`);
    }
  });

  test('every gsd-tools init workflow is hinted or has a recorded no-skill reason', () => {
    // These init workflows back no user-facing command of the same purpose.
    const NO_SKILL = ['phase-op', 'todos', 'milestone-op', 'transition', 'list-workspaces', 'remove-workspace'];
    const r = runNode([path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'), 'init'], { timeoutMs: PROBE_TIMEOUT_MS });
    const listed = /Available: (.+)/.exec(`${r.stdout}\n${r.stderr}`);
    assert.ok(listed, `could not read the init workflow list (exit ${r.exitCode}, outcome ${r.outcome})\n${r.stderr}`);
    const inits = listed[1].split(',').map((x) => x.trim());
    for (const init of inits) {
      const covered = Object.prototype.hasOwnProperty.call(_internals.PI_WORKFLOW_INIT_COMMANDS, init) || NO_SKILL.includes(init);
      assert.ok(covered, `init workflow '${init}' has no Pi hint and no recorded no-skill reason`);
    }
    for (const init of NO_SKILL) assert.ok(inits.includes(init), `stale no-skill entry '${init}'`);
  });

  test('nextStepFor carries positional arguments and drops flags', (t) => {
    const root = engineWithSkills(t, ['execute-phase']);
    const hint = _internals.nextStepFor({ family: 'init', subcommand: 'execute-phase', args: ['3', '--raw', '--json-errors'] }, root);
    assert.match(hint, /Next: run \/gsd execute-phase 3 \(or \/skill:gsd-execute-phase 3\) to start/);
    assert.doesNotMatch(hint, /--raw|--json-errors/);
    assert.doesNotMatch(_internals.nextStepFor({ family: 'init', subcommand: 'execute-phase', args: undefined }, root), /execute-phase undefined/);
  });
});

describe('#5547: the installed Pi extension', () => {
  function installedExtension(t) {
    const { configDir, root } = runMinimalInstall({ runtime: 'pi', scope: 'global' });
    t.after(() => cleanup(root));
    const extPath = path.join(configDir, 'extensions', 'gsd.js');
    const ext = require(extPath);
    const recorded = { commands: {}, sent: [], tools: {} };
    const pi = {
      registerCommand(name, def) { recorded.commands[name] = def; },
      registerTool(def) { recorded.tools[def.name] = def; },
      on() {},
      sendUserMessage(content, options) { recorded.sent.push({ content, options }); },
    };
    ext(pi);
    const notifications = [];
    const ctx = { cwd: root, ui: { notify(message, type) { notifications.push({ message, type }); } } };
    return { configDir, handler: recorded.commands.gsd.handler, tools: recorded.tools, sent: recorded.sent, notifications, ctx };
  }

  test('gsd_invoke output is scripted data and never carries the next-step hint', async (t) => {
    const { tools, ctx } = installedExtension(t);
    const out = await tools.gsd_invoke.execute('call-1', { family: 'init', subcommand: 'new-project' }, null, null, ctx);
    assert.ok(Array.isArray(out.content) && out.content.length === 1);
    assert.doesNotMatch(out.content[0].text, /Next: run \/gsd|\/skill:gsd-/);
  });

  test('installs a SKILL.md per command, carrying the dispatch contract', (t) => {
    const { configDir } = installedExtension(t);
    const skill = fs.readFileSync(path.join(configDir, 'skills', 'gsd-new-project', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\r?\nname: gsd-new-project\r?\n/);
    assert.ok(skill.includes(CONTRACT_MARKER) && skill.includes(INCLUDE_MARKER));
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

  // The bare forms (`~/.claude`, `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`) live in the
  // gsd-surface skill; the slash-only claude profile leaves them, so pi uses a
  // profile with the lookahead bare rewrites plus the `@~` restore.
  test('no installed skill points a ~/.claude or $HOME/.claude path at the wrong host', (t) => {
    const { configDir } = installedExtension(t);
    const leaks = [];
    for (const dir of fs.readdirSync(path.join(configDir, 'skills'))) {
      const body = fs.readFileSync(path.join(configDir, 'skills', dir, 'SKILL.md'), 'utf8');
      if (/(?:~|\$HOME)\/\.claude\b/.test(body)) leaks.push(dir);
    }
    assert.deepEqual(leaks, []);
    const surface = fs.readFileSync(path.join(configDir, 'skills', 'gsd-surface', 'SKILL.md'), 'utf8');
    assert.match(surface, /RUNTIME_CONFIG_DIR="\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.pi\/agent\}"/);
  });

  test('a pi install reports no unreplaced-path warning', () => {
    const r = runMinimalInstall({ runtime: 'pi', scope: 'global' });
    try {
      assert.doesNotMatch(`${r.stderr}\n${r.stdout}`, /unreplaced \.claude path reference/);
    } finally {
      cleanup(r.root);
    }
  });

  // The canonical corpus (gsd-core/commands, gsd-core/agents) is kept byte-identical
  // to the package so a refresh can restore it; counting its source-form paths as
  // leaks made every skills-runtime install warn about files nothing reads.
  test('the source-form corpus is not reported as leaked paths for a skills runtime', () => {
    const r = runMinimalInstall({ runtime: 'hermes', scope: 'global' });
    try {
      assert.doesNotMatch(`${r.stderr}\n${r.stdout}`, /unreplaced \.claude path reference/);
    } finally {
      cleanup(r.root);
    }
  });

  test('windsurf keeps its delegation bodies in the leak scan (they are host-read)', () => {
    const { hostBehaviorsFor } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
    assert.equal(hostBehaviorsFor('windsurf').installsCommandBodiesForWorkflowDelegation, true);
    assert.notEqual(hostBehaviorsFor('pi').installsCommandBodiesForWorkflowDelegation, true);
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
