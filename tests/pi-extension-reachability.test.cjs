'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');


const gsdPiExtension = require('../pi/gsd.cjs');
const { _internals } = gsdPiExtension;
const { installOmpSkills } = require('../pi/install-omp-skills.cjs');
const { version: packageVersion } = require('../package.json');

function mockZod() {
  const chain = () => ({ default: () => chain(), optional: () => chain() });
  return {
    object: () => chain(),
    string: chain,
    array: () => chain(),
    boolean: chain,
  };
}

function mockPi() {
  const recorded = { commands: {}, tools: {}, events: {}, messages: [], sessionName: undefined, sessionNameUpdates: [] };
  return {
    zod: mockZod(),
    registerCommand(name, definition) { recorded.commands[name] = definition; },
    registerTool(definition) { recorded.tools[definition.name] = definition; },
    on(event, handler) { recorded.events[event] = handler; },
    async sendMessage(message, options) { recorded.messages.push({ message, options }); },
    getSessionName() { return recorded.sessionName; },
    async setSessionName(name) {
      recorded.sessionName = name;
      recorded.sessionNameUpdates.push(name);
    },
    _recorded: recorded,
  };
}

const ANSI_ESCAPE = String.fromCharCode(27);

function stripAnsi(text) {
  return text.replace(new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g'), '');
}

test('the OMP bridge registers command, tool, and lifecycle hooks', () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  assert.equal(typeof pi._recorded.commands.gsd.handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-status'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-execute-phase'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-next'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-discuss-phase'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-plan-phase'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-verify-work'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-new-project'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-new-milestone'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-ship'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-progress'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-resume-work'].handler, 'function');
  assert.equal(typeof pi._recorded.tools.gsd_invoke.execute, 'function');
  assert.equal(typeof pi._recorded.events.session_start, 'function');
  assert.equal(typeof pi._recorded.events.tool_call, 'function');
  assert.equal(typeof pi._recorded.events.tool_result, 'function');
  assert.equal(typeof pi._recorded.events.turn_end, 'function');
  assert.equal(typeof pi._recorded.events.session_switch, 'function');
  assert.equal(typeof pi._recorded.events.session_branch, 'function');
  assert.equal(typeof pi._recorded.events.session_tree, 'function');
  assert.equal(typeof pi._recorded.events.session_compact, 'function');
  assert.equal(typeof pi._recorded.commands.gsd.getArgumentCompletions, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-execute-phase'].getArgumentCompletions, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-discuss-phase'].getArgumentCompletions, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-plan-phase'].getArgumentCompletions, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-verify-work'].getArgumentCompletions, 'function');
  assert.equal(typeof pi._recorded.events.session_shutdown, 'function');
});

test('the /gsd command dispatches through the GSD CLI', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  await pi._recorded.commands.gsd.handler('query phase.next-decimal 01', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.length, 1);
  assert.equal(pi._recorded.messages[0].message.customType, 'gsd-command-result');
  assert.match(pi._recorded.messages[0].message.content, /^✓ GSD command completed/);
  assert.match(pi._recorded.messages[0].message.content, /"next"\s*:\s*"01\.1"/);
  assert.doesNotMatch(pi._recorded.messages[0].message.content, /gsd-progress --next/);
});

test('the /gsd command completes command families and defaults to CLI help', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  assert.deepEqual(pi._recorded.commands.gsd.getArgumentCompletions('prog'), [{ label: 'progress', value: 'progress' }]);
  assert.deepEqual(pi._recorded.commands.gsd.getArgumentCompletions('agent-'), [{ label: 'agent-skills', value: 'agent-skills' }]);
  assert.deepEqual(pi._recorded.commands.gsd.getArgumentCompletions('verify-'), [
    { label: 'verify-path-exists', value: 'verify-path-exists' },
    { label: 'verify-summary', value: 'verify-summary' },
  ]);
  assert.equal(pi._recorded.commands.gsd.getArgumentCompletions('progress '), null);

  await pi._recorded.commands.gsd.handler('', { cwd: path.resolve(__dirname, '..') });
  assert.match(pi._recorded.messages.at(-1).message.content, /^✓ GSD command completed/);
  assert.match(pi._recorded.messages.at(-1).message.content, /Usage: gsd-tools/);
});

test('native lifecycle commands preserve workflow gates and session ownership', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-lifecycle-'));
  try {
    const pi = mockPi();
    gsdPiExtension(pi);

    await pi._recorded.commands['gsd-new-project'].handler('--auto', { cwd });
    assert.equal(pi._recorded.sessionName, 'GSD · New Project');
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-new-project');
    assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, true);
    assert.match(pi._recorded.messages.at(-1).message.content, /gsd-new-project workflow --auto/);
    assert.match(pi._recorded.messages.at(-1).message.content, /native `ask` tool/);

    pi._recorded.sessionName = undefined;
    await pi._recorded.commands['gsd-new-milestone'].handler('v2 Notifications', { cwd });
    assert.equal(pi._recorded.sessionName, 'GSD · New Milestone');
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-new-milestone');
    assert.match(pi._recorded.messages.at(-1).message.content, /Requested milestone: `v2 Notifications`/);
    assert.match(pi._recorded.messages.at(-1).message.content, /continue phase numbering/);

    pi._recorded.sessionName = 'User-defined session';
    await pi._recorded.commands['gsd-ship'].handler('05', { cwd });
    assert.equal(pi._recorded.sessionName, 'User-defined session');
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-ship');
    assert.match(pi._recorded.messages.at(-1).message.content, /Ship `05` end-to-end/);
    assert.match(pi._recorded.messages.at(-1).message.content, /Do not push, open a pull request, or claim readiness/);

    pi._recorded.sessionName = undefined;
    await pi._recorded.commands['gsd-resume-work'].handler('', { cwd });
    assert.equal(pi._recorded.sessionName, 'GSD · Resume Work');
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-resume-work');
    assert.match(pi._recorded.messages.at(-1).message.content, /gsd-resume-work workflow/);


    await pi._recorded.commands['gsd-new-project'].handler('invalid', { cwd });
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-new-project-input-error');
    assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, false);
  } finally {
    cleanup(cwd);
  }
});

test('native progress delegates next-step routing to the canonical workflow', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  await pi._recorded.commands['gsd-progress'].handler('--next', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-progress');
  assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, true);
  assert.match(pi._recorded.messages.at(-1).message.content, /gsd-progress workflow --next/);
  assert.match(pi._recorded.messages.at(-1).message.content, /Gates 1–3 and Route 0/);
  assert.match(pi._recorded.messages.at(-1).message.content, /Do not call `gsd_invoke`/);
  assert.match(pi._recorded.messages.at(-1).message.content, /`family: "gsd"` is invalid/);

  await pi._recorded.commands['gsd-progress'].handler('--auto', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-progress-input-error');
  assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, false);
});

test('the native phase command injects a task-based execution contract', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  await pi._recorded.commands['gsd-execute-phase'].handler('05 --wave 4', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.length, 1);
  assert.equal(pi._recorded.messages[0].message.customType, 'gsd-native-execute-phase');
  assert.equal(pi._recorded.messages[0].options.triggerTurn, true);
  assert.match(pi._recorded.messages[0].message.content, /Execute GSD phase `05 --wave 4`/);
  assert.match(pi._recorded.messages[0].message.content, /Use native `task`/);
  assert.match(pi._recorded.messages[0].message.content, /takes precedence over runtime-specific `Agent\(\.\.\.\)` or `isolation="worktree"` directions/);
  assert.match(pi._recorded.messages[0].message.content, /isolated: true/);
  assert.match(pi._recorded.messages[0].message.content, /top-level `agent: "gsd-executor"`, a shared `context`, and `tasks`/);
  assert.match(pi._recorded.messages[0].message.content, /agent: "gsd-executor"/);
  assert.match(pi._recorded.messages[0].message.content, /id: "Phase05Plan\{PLAN_COMPACT\}Executor"/);
  assert.match(pi._recorded.messages[0].message.content, /never invent `name` or per-item `agent`\/`task` fields/);
  assert.match(pi._recorded.messages[0].message.content, /never fall back to main-checkout writes or manual `git worktree` commands/i);
  assert.match(pi._recorded.messages[0].message.content, /uncommitted handoff/);
  assert.match(pi._recorded.messages[0].message.content, /create the plan's required commit in the parent checkout/);
  assert.match(pi._recorded.messages[0].message.content, /Never use `irc wait` for task completion/);
  assert.match(pi._recorded.messages[0].message.content, /Use `job poll`/);
  assert.match(pi._recorded.messages[0].message.content, /spawned native runtime IDs/);


  await pi._recorded.commands['gsd-execute-phase'].handler('five', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-execute-input-error');
  assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, false);

  await pi._recorded.commands['gsd-execute-phase'].handler('05 --wave 2 --cross-ai --no-transition', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-execute-phase');
  assert.match(pi._recorded.messages.at(-1).message.content, /`05 --wave 2 --cross-ai --no-transition`/);
  await pi._recorded.commands['gsd-execute-phase'].handler('05 --wave 0', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-execute-input-error');
});

test('native phase entry points name only unnamed GSD sessions', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-session-label-'));
  try {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
    const pi = mockPi();
    gsdPiExtension(pi);
    const ctx = { cwd };
    for (const [command, input, expected] of [
      ['gsd-execute-phase', '05 --wave 2', 'GSD · Phase 05 · Execute'],
      ['gsd-discuss-phase', '03', 'GSD · Phase 03 · Discuss'],
      ['gsd-plan-phase', '02 --auto', 'GSD · Phase 02 · Plan'],
      ['gsd-verify-work', '04', 'GSD · Phase 04 · Verify'],
    ]) {
      pi._recorded.sessionName = undefined;
      await pi._recorded.commands[command].handler(input, ctx);
      assert.equal(pi._recorded.sessionName, expected);
    }

    pi._recorded.sessionName = 'User-defined session';
    const updates = pi._recorded.sessionNameUpdates.length;
    await pi._recorded.commands['gsd-execute-phase'].handler('05', ctx);
    assert.equal(pi._recorded.sessionName, 'User-defined session');
    assert.equal(pi._recorded.sessionNameUpdates.length, updates);
  } finally {
    cleanup(cwd);
  }
});

test('native phase commands complete only the current command phase argument', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-phase-completions-'));
  const previousCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), [
      '- [ ] **Phase 1: Execute** - Incomplete plans.',
      '- [ ] **Phase 2: Plan** - No plans yet.',
      '- [x] **Phase 3: Verify** - Completed plans.',
    ].join('\n'));
    fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-execute'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.planning', 'phases', '03-verify'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'phases', '01-execute', '01-01-PLAN.md'), 'plan');
    fs.writeFileSync(path.join(cwd, '.planning', 'phases', '03-verify', '03-01-PLAN.md'), 'plan');
    fs.writeFileSync(path.join(cwd, '.planning', 'phases', '03-verify', '03-01-SUMMARY.md'), 'summary');
    process.chdir(cwd);
    const pi = mockPi();
    gsdPiExtension(pi);

    assert.deepEqual(pi._recorded.commands['gsd-execute-phase'].getArgumentCompletions(''), [{
      label: 'Phase 1: Execute', value: '01', description: '0/1 plans complete',
    }]);
    assert.deepEqual(pi._recorded.commands['gsd-plan-phase'].getArgumentCompletions(''), [{
      label: 'Phase 2: Plan', value: '02', description: 'CONTEXT missing · RESEARCH missing · no plans',
    }]);
    assert.deepEqual(pi._recorded.commands['gsd-verify-work'].getArgumentCompletions(''), [{
      label: 'Phase 3: Verify', value: '03', description: '1/1 plans complete · UAT pending',
    }]);
    assert.deepEqual(pi._recorded.commands['gsd-discuss-phase'].getArgumentCompletions('03'), [{
      label: 'Phase 3: Verify', value: '03', description: 'Discuss this phase',
    }]);
    assert.equal(pi._recorded.commands['gsd-execute-phase'].getArgumentCompletions('01 '), null);
  } finally {
    process.chdir(previousCwd);
    cleanup(cwd);
  }
});

test('session navigation refreshes the native GSD widget', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-session-navigation-'));
  try {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
    const pi = mockPi();
    gsdPiExtension(pi);
    const widgets = [];
    const ctx = { cwd, hasUI: true, ui: { setWidget: (key, lines, options) => widgets.push({ key, lines, options }) } };
    await pi._recorded.events.session_switch({}, ctx);
    await pi._recorded.events.session_branch({}, ctx);
    await pi._recorded.events.session_tree({}, ctx);
    await pi._recorded.events.session_compact({}, ctx);

    assert.equal(widgets.length, 4);
    assert.ok(widgets.every(({ key, options }) => key === 'gsd' && options.placement === 'aboveEditor'));
  } finally {
    cleanup(cwd);
  }
});

test('the execute command selects an unfinished phase and rejects an empty execution queue', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-phase-picker-'));
  const phaseDirectory = path.join(cwd, '.planning', 'phases', '02-analysis');
  fs.mkdirSync(phaseDirectory, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), '- [ ] **Phase 2: Analysis** - Build auditable reports.\n');
  fs.writeFileSync(path.join(phaseDirectory, '02-01-PLAN.md'), 'plan');
  const pi = mockPi();
  gsdPiExtension(pi);
  const menus = [];
  await pi._recorded.commands['gsd-execute-phase'].handler('', { cwd, hasUI: true, ui: {
    select: async (_title, options) => {
      menus.push(options);
      return options[0];
    },
  } });
  assert.deepEqual(menus[0], [{
    phase: '02',
    label: 'Phase 2: Analysis',
    description: '0/1 plans complete',
  }]);
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-execute-phase');
  assert.match(pi._recorded.messages.at(-1).message.content, /Execute GSD phase `02`/);

  fs.writeFileSync(path.join(phaseDirectory, '02-01-SUMMARY.md'), 'summary');
  await pi._recorded.commands['gsd-execute-phase'].handler('', { cwd, hasUI: true, ui: { select: async () => { throw new Error('must not prompt'); } } });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-execute-no-runnable-phase');
});

test('the native discussion command requires OMP question controls by default', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  await pi._recorded.commands['gsd-discuss-phase'].handler('03', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-discuss-phase');
  assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, true);
  assert.match(pi._recorded.messages.at(-1).message.content, /native `ask` tool/);
  assert.match(pi._recorded.messages.at(-1).message.content, /multi: true/);
  assert.match(pi._recorded.messages.at(-1).message.content, /--text.*plain-text fallback/);

  await pi._recorded.commands['gsd-discuss-phase'].handler('03 --assumptions', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-discuss-phase');
  assert.match(pi._recorded.messages.at(-1).message.content, /`03 --assumptions`/);

  await pi._recorded.commands['gsd-discuss-phase'].handler('three', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-discuss-input-error');
});

test('the plan command selects an unplanned phase and preserves planning workflow controls', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-plan-picker-'));
  const plannedPhase = path.join(cwd, '.planning', 'phases', '03-existing');
  const plannablePhase = path.join(cwd, '.planning', 'phases', '02-analysis');
  fs.mkdirSync(plannablePhase, { recursive: true });
  fs.mkdirSync(plannedPhase, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), '- [ ] **Phase 2: Analysis** - Build auditable reports.\n- [ ] **Phase 3: Existing** - Do not replan.\n');
  fs.writeFileSync(path.join(plannablePhase, 'CONTEXT.md'), 'context');
  fs.writeFileSync(path.join(plannablePhase, 'RESEARCH.md'), 'research');
  fs.writeFileSync(path.join(plannedPhase, '03-01-PLAN.md'), 'plan');
  const pi = mockPi();
  gsdPiExtension(pi);
  const menus = [];
  await pi._recorded.commands['gsd-plan-phase'].handler('', { cwd, hasUI: true, ui: {
    select: async (_title, options) => {
      menus.push(options);
      return options[0];
    },
  } });
  assert.deepEqual(menus[0], [{
    phase: '02',
    label: 'Phase 2: Analysis',
    description: 'CONTEXT ready · RESEARCH ready · no plans',
  }]);
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-plan-phase');
  assert.match(pi._recorded.messages.at(-1).message.content, /Execute GSD phase planning `02`/);
  assert.match(pi._recorded.messages.at(-1).message.content, /native `ask` tool/);
  assert.match(pi._recorded.messages.at(-1).message.content, /Preserve existing artifacts/);

  await pi._recorded.commands['gsd-plan-phase'].handler('03 --skip-research --ingest docs/decisions --ingest-format madr --reviews', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-plan-phase');
  assert.match(pi._recorded.messages.at(-1).message.content, /`03 --skip-research --ingest docs\/decisions --ingest-format madr --reviews`/);

  fs.writeFileSync(path.join(plannablePhase, '02-01-PLAN.md'), 'plan');
  await pi._recorded.commands['gsd-plan-phase'].handler('', { cwd, hasUI: true, ui: { select: async () => { throw new Error('must not prompt'); } } });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-plan-no-plannable-phase');

  await pi._recorded.commands['gsd-plan-phase'].handler('03 --ingest-format yaml', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-plan-input-error');

  await pi._recorded.commands['gsd-plan-phase'].handler('2.1 --skip-ui --bounce --chunked --granularity fine --force', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-plan-phase');
  assert.match(pi._recorded.messages.at(-1).message.content, /`2\.1 --skip-ui --bounce --chunked --granularity fine --force`/);
  await pi._recorded.commands['gsd-plan-phase'].handler('2.1 --granularity narrow', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-plan-input-error');

  await pi._recorded.commands['gsd-plan-phase'].handler('03 --prd --auto', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-plan-input-error');
  await pi._recorded.commands['gsd-plan-phase'].handler('03 --ingest --reviews', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-plan-input-error');
});

test('the verification command selects completed phases and resumes incomplete UAT', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-verify-picker-'));
  const readyPhase = path.join(cwd, '.planning', 'phases', '02-ready');
  const incompletePhase = path.join(cwd, '.planning', 'phases', '03-running');
  const verifiedPhase = path.join(cwd, '.planning', 'phases', '04-verified');
  fs.mkdirSync(readyPhase, { recursive: true });
  fs.mkdirSync(incompletePhase, { recursive: true });
  fs.mkdirSync(verifiedPhase, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), '- [ ] **Phase 2: Ready** - Verify me.\n- [ ] **Phase 3: Running** - Finish execution first.\n- [x] **Phase 4: Verified** - Already accepted.\n');
  fs.writeFileSync(path.join(readyPhase, '02-01-PLAN.md'), 'plan');
  fs.writeFileSync(path.join(readyPhase, '02-01-SUMMARY.md'), 'summary');
  fs.writeFileSync(path.join(readyPhase, '02-UAT.md'), '---\nstatus: testing\n---\n');
  fs.writeFileSync(path.join(incompletePhase, '03-01-PLAN.md'), 'plan');
  fs.writeFileSync(path.join(verifiedPhase, '04-01-PLAN.md'), 'plan');
  fs.writeFileSync(path.join(verifiedPhase, '04-01-SUMMARY.md'), 'summary');
  fs.writeFileSync(path.join(verifiedPhase, '04-UAT.md'), '---\nstatus: complete\n---\n');
  const pi = mockPi();
  gsdPiExtension(pi);
  const menus = [];
  await pi._recorded.commands['gsd-verify-work'].handler('', { cwd, hasUI: true, ui: {
    select: async (_title, options) => {
      menus.push(options);
      return options[0];
    },
  } });
  assert.deepEqual(menus[0], [{
    phase: '02',
    label: 'Phase 2: Ready',
    description: '1/1 plans complete · UAT testing',
  }]);
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-verify-work');
  assert.match(pi._recorded.messages.at(-1).message.content, /Execute GSD phase verification `02`/);
  assert.match(pi._recorded.messages.at(-1).message.content, /Resume an existing incomplete UAT session/);
  assert.match(pi._recorded.messages.at(-1).message.content, /exactly one observable user-acceptance test at a time/);

  await pi._recorded.commands['gsd-verify-work'].handler('02 --ws qa-session', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-native-verify-work');
  assert.match(pi._recorded.messages.at(-1).message.content, /`02 --ws qa-session`/);

  fs.writeFileSync(path.join(readyPhase, '02-UAT.md'), '---\nstatus: complete\n---\n');
  await pi._recorded.commands['gsd-verify-work'].handler('', { cwd, hasUI: true, ui: { select: async () => { throw new Error('must not prompt'); } } });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-verify-no-ready-phase');

  await pi._recorded.commands['gsd-verify-work'].handler('02 --ws', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-verify-input-error');

  await pi._recorded.commands['gsd-verify-work'].handler('02 --ws --auto', { cwd });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-verify-input-error');
});

test('native commands follow one phase from discussion through UAT readiness', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-lifecycle-'));
  const phaseDirectory = path.join(cwd, '.planning', 'phases', '02-lifecycle');
  fs.mkdirSync(phaseDirectory, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), '- [ ] **Phase 2: Lifecycle** - Exercise the native path.\n');
  const pi = mockPi();
  gsdPiExtension(pi);
  const ctx = { cwd, hasUI: true, ui: { select: async (_title, options) => options[0] } };

  await pi._recorded.commands['gsd-discuss-phase'].handler('02', ctx);
  await pi._recorded.commands['gsd-plan-phase'].handler('', ctx);
  fs.writeFileSync(path.join(phaseDirectory, '02-01-PLAN.md'), 'plan');
  await pi._recorded.commands['gsd-execute-phase'].handler('', ctx);
  fs.writeFileSync(path.join(phaseDirectory, '02-01-SUMMARY.md'), 'summary');
  await pi._recorded.commands['gsd-verify-work'].handler('', ctx);

  assert.deepEqual(pi._recorded.messages.map(({ message }) => message.customType), [
    'gsd-native-discuss-phase',
    'gsd-native-plan-phase',
    'gsd-native-execute-phase',
    'gsd-native-verify-work',
  ]);
});

test('the native phase command blocks parent-checkout source writes', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-native-phase-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const pi = mockPi();
  gsdPiExtension(pi);
  await pi._recorded.commands['gsd-execute-phase'].handler('01', { cwd });

  const blocked = await pi._recorded.events.tool_call({
    toolName: 'write',
    input: { path: 'src/proof.ts' },
  }, { cwd });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /isolated gsd-executor task/);
  assert.equal(await pi._recorded.events.tool_call({
    toolName: 'write',
    input: { path: '.planning/STATE.md' },
  }, { cwd }), undefined);
});

test('a failed native phase launch releases the parent-checkout write guard', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-native-launch-failure-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const pi = mockPi();
  pi.sendMessage = async () => { throw new Error('native dispatch unavailable'); };
  gsdPiExtension(pi);

  await assert.rejects(pi._recorded.commands['gsd-execute-phase'].handler('01', { cwd }), /native dispatch unavailable/);
  assert.equal(await pi._recorded.events.tool_call({
    toolName: 'write',
    input: { path: 'src/proof.ts' },
  }, { cwd }), undefined);
});

test('session shutdown releases native GSD task and phase guards', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-session-shutdown-'));
  try {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
    const pi = mockPi();
    gsdPiExtension(pi);
    const ctx = { cwd };
    await pi._recorded.events.tool_call({
      toolName: 'write', input: { path: 'src/advised.ts' },
    }, ctx);
    assert.equal(pi._recorded.messages.filter(({ message }) => message.customType === 'gsd-workflow-advisory').length, 1);
    await pi._recorded.commands['gsd-execute-phase'].handler('01', ctx);
    await pi._recorded.events.tool_result({
      toolName: 'task',
      content: [],
      details: { progress: [{ id: 'Phase01Plan01Executor', agent: 'gsd-executor', status: 'running' }] },
    }, ctx);
    assert.equal((await pi._recorded.events.tool_call({
      toolName: 'irc', input: { op: 'wait', from: 'Phase01Plan01Executor' },
    }, ctx)).block, true);
    assert.equal((await pi._recorded.events.tool_call({
      toolName: 'write', input: { path: 'src/proof.ts' },
    }, ctx)).block, true);

    await pi._recorded.events.session_shutdown({}, ctx);

    assert.equal(await pi._recorded.events.tool_call({
      toolName: 'irc', input: { op: 'wait', from: 'Phase01Plan01Executor' },
    }, ctx), undefined);
    assert.equal(await pi._recorded.events.tool_call({
      toolName: 'write', input: { path: 'src/proof.ts' },
    }, ctx), undefined);
    assert.equal(pi._recorded.messages.filter(({ message }) => message.customType === 'gsd-workflow-advisory').length, 2);
    await pi._recorded.events.tool_call({
      toolName: 'write', input: { path: 'src/advised.ts' },
    }, ctx);
    assert.equal(pi._recorded.messages.filter(({ message }) => message.customType === 'gsd-workflow-advisory').length, 3);
  } finally {
    cleanup(cwd);
  }
});

test('the OMP bridge blocks IRC waits for native GSD task runtime IDs', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-task-guard-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const ctx = { cwd };

  await pi._recorded.events.tool_result({
    toolName: 'task',
    content: [],
    details: { progress: [{ id: 'FixPhase02ReviewFindings-2', agent: 'gsd-code-fixer', status: 'running' }] },
  }, ctx);

  const blocked = await pi._recorded.events.tool_call({
    toolName: 'irc',
    input: { op: 'wait', from: 'FixPhase02ReviewFindings-2' },
  }, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Do not wait for task completion through IRC/);
  assert.match(blocked.reason, /job poll/);

  await pi._recorded.events.tool_result({
    toolName: 'task',
    content: [],
    details: { progress: [{ id: 'FixPhase02ReviewFindings-2', agent: 'gsd-code-fixer', status: 'completed' }] },
  }, ctx);
  assert.equal(await pi._recorded.events.tool_call({
    toolName: 'irc',
    input: { op: 'wait', from: 'FixPhase02ReviewFindings-2' },
  }, ctx), undefined);
});

test('the OMP task wait guard is scoped to the GSD project', async () => {
  const firstCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-task-guard-first-'));
  const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-task-guard-second-'));
  for (const cwd of [firstCwd, secondCwd]) {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  }
  const pi = mockPi();
  gsdPiExtension(pi);
  const task = {
    toolName: 'task',
    content: [],
    details: { progress: [{ id: 'Phase01Plan0101Executor', agent: 'gsd-executor' }] },
  };
  const wait = {
    toolName: 'irc',
    input: { op: 'wait', from: 'Phase01Plan0101Executor' },
  };

  await pi._recorded.events.tool_result(task, { cwd: firstCwd });
  assert.equal((await pi._recorded.events.tool_call(wait, { cwd: firstCwd })).block, true);
  assert.equal(await pi._recorded.events.tool_call(wait, { cwd: secondCwd }), undefined);
});

test('the gsd_invoke tool returns the hub result in OMP tool shape', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const result = await pi._recorded.tools.gsd_invoke.execute(
    'tool-1',
    { family: 'query', subcommand: 'phase.next-decimal', args: ['01'] },
    undefined,
    undefined,
    { cwd: path.resolve(__dirname, '..') },
  );
  assert.equal(result.content[0].type, 'text');
  assert.equal(JSON.parse(result.content[0].text).next, '01.1');
});

test('the cancellable GSD tool reports progress and stops on abort', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const controller = new AbortController();
  controller.abort();
  const updates = [];
  const result = await pi._recorded.tools.gsd_invoke.execute(
    'tool-cancel',
    { family: 'query', subcommand: 'phase.next-decimal', args: ['01'] },
    controller.signal,
    (update) => updates.push(update),
    { cwd: path.resolve(__dirname, '..') },
  );
  assert.equal(result.content[0].text, 'GSD command cancelled.');
  assert.match(updates[0].content[0].text, /GSD · query phase.next-decimal/);
});

test('the OMP agent installer projects native task and isolation guidance', () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-agents-'));
  const installer = path.resolve(__dirname, '..', 'pi', 'install-omp-agents.cjs');
  const result = spawnSync(process.execPath, [installer, destination], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const executor = fs.readFileSync(path.join(destination, 'gsd-executor.md'), 'utf8');
  assert.match(executor, /OMP native orchestration/);
  assert.match(executor, /isolated: true/);
  assert.match(executor, /Never run git worktree yourself/);
  assert.match(executor, /OMP executor result protocol/);
  assert.match(executor, /Never use `irc wait` for task completion/);
  assert.match(executor, /top-level `agent`, shared `context`, and `tasks\[\]`/);
  assert.match(executor, /stable `id`/);
  assert.match(executor, /never invent `name` or per-item `agent`\/`task` fields/);
  assert.match(executor, /task ID assigned by the orchestrator/);
  assert.match(executor, /Do not call a hidden yield tool/);
  assert.match(executor, /IRC status request/);
  assert.match(executor, /\[gsd-task-result\] phase \{PHASE\}/);
  const extensionDestination = path.join(destination, 'extensions', 'gsd-omp.ts');
  const extensionInstaller = path.resolve(__dirname, '..', 'pi', 'install-omp-extension.cjs');
  const extensionResult = spawnSync(process.execPath, [extensionInstaller, extensionDestination], { encoding: 'utf8' });
  assert.equal(extensionResult.status, 0, extensionResult.stderr);
  const extensionEntry = fs.readFileSync(extensionDestination, 'utf8');
  assert.match(extensionEntry, /import gsdPiExtension from/);
  assert.match(extensionEntry, /pi\/gsd\.cjs/);
});

test('the OMP development installer projects every GSD skill with runtime paths', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-skills-'));
  const skillsDir = path.join(runtimeRoot, 'skills');
  try {
    const sourceSkillsDir = path.resolve(__dirname, '..', 'skills');
    const expectedCount = fs.readdirSync(sourceSkillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('gsd-') && fs.existsSync(path.join(sourceSkillsDir, entry.name, 'SKILL.md')))
      .length;
    const installed = installOmpSkills(skillsDir, sourceSkillsDir);
    assert.equal(installed.length, expectedCount);

    const planSkill = fs.readFileSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md'), 'utf8');
    const runtimeWorkflow = path.join(runtimeRoot, 'gsd-core', 'workflows', 'plan-phase.md').split(path.sep).join('/');
    assert.ok(planSkill.includes(`@${runtimeWorkflow}`));
    assert.doesNotMatch(planSkill, /~\/\.claude\/gsd-core/);
    const executeSkill = fs.readFileSync(path.join(skillsDir, 'gsd-execute-phase', 'SKILL.md'), 'utf8');
    assert.match(executeSkill, /<omp_native_execution>/);
    assert.match(executeSkill, /use `job poll`/);
    assert.match(executeSkill, /Never use `irc wait`/);
    assert.match(executeSkill, /top-level `agent: "gsd-executor"`, shared `context`, and `tasks\[\]`/);
    assert.match(executeSkill, /stable `id` such as `Phase\{PHASE\}Plan\{PLAN_COMPACT\}Executor`/);
    assert.match(executeSkill, /Do not invent `name` or per-item `agent`\/`task` fields/);
    assert.match(executeSkill, /Do not call a hidden yield tool/);
    assert.match(executeSkill, /native runtime ID/);
  } finally {
    cleanup(runtimeRoot);
  }
});

test('the generic installer creates a self-contained OMP runtime', () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-runtime-'));
  try {
    const installer = path.resolve(__dirname, '..', 'bin', 'install.js');
    const result = spawnSync(process.execPath, [installer, '--omp', '--global', '--config-dir', destination], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(stripAnsi(result.stdout), /Installing for Oh My Pi/);
    assert.equal(fs.readFileSync(path.join(destination, 'extensions', 'gsd-omp.ts'), 'utf8'), 'import gsdPiExtension from "./gsd-omp.cjs";\n\nexport default gsdPiExtension;\n');
    assert.ok(fs.existsSync(path.join(destination, 'extensions', 'gsd-omp.cjs')));
    assert.ok(fs.existsSync(path.join(destination, 'gsd-core', 'bin', 'gsd-tools.cjs')));
    const executor = fs.readFileSync(path.join(destination, 'agents', 'gsd-executor.md'), 'utf8');
    assert.match(executor, /OMP native orchestration/);
    assert.doesNotMatch(executor, /~\/\.claude\//);
    const executeSkill = fs.readFileSync(path.join(destination, 'skills', 'gsd-execute-phase', 'SKILL.md'), 'utf8');
    assert.match(executeSkill, /<omp_native_execution>/);
    assert.match(executeSkill, /Native `task` is the executor primitive/);
    const progressSkill = fs.readFileSync(path.join(destination, 'skills', 'gsd-progress', 'SKILL.md'), 'utf8');
    assert.match(progressSkill, /<omp_artifact_handling>/);
    assert.match(progressSkill, /truncated summary glob may supply recent-work examples only/);
    const { extensionEventSurfaceFor } = require('../gsd-core/bin/lib/host-integration.cjs');
    assert.deepEqual(extensionEventSurfaceFor('pi'), [
      'session_start', 'project_trust', 'resources_discover', 'input',
      'before_agent_start', 'agent_start', 'message_start', 'message_update',
      'message_end', 'turn_start', 'context', 'before_provider_request',
      'after_provider_response', 'tool_execution_start', 'tool_execution_update',
      'tool_execution_end', 'tool_call', 'tool_result', 'turn_end', 'agent_end',
      'session_before_switch', 'session_shutdown', 'session_before_fork',
      'session_info_changed', 'session_before_compact', 'session_compact',
      'session_before_tree', 'session_tree', 'thinking_level_select', 'model_select',
    ]);
    const { loadUpdateContext } = require('../gsd-core/bin/lib/update-context.cjs');
    assert.deepEqual(loadUpdateContext({ env: { PI_CODING_AGENT_DIR: destination }, preferredConfigDir: destination, preferredRuntime: 'omp' }), {
      installedVersion: packageVersion, scope: 'GLOBAL', runtime: 'omp', gsdDir: destination,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'gsd-file-manifest.json'), 'utf8'));
    assert.ok(manifest.files['extensions/gsd-omp.ts']);
    assert.ok(manifest.files['extensions/gsd-omp.cjs']);
    assert.ok(manifest.files['gsd-core/OMP-SOURCE.json']);
    const minimalResult = spawnSync(process.execPath, [installer, '--omp', '--global', '--minimal', '--config-dir', destination], { encoding: 'utf8' });
    assert.equal(minimalResult.status, 0, minimalResult.stderr);
    assert.equal(fs.existsSync(path.join(destination, 'agents', 'gsd-executor.md')), false);
    const uninstallResult = spawnSync(process.execPath, [installer, '--omp', '--global', '--uninstall', '--config-dir', destination], { encoding: 'utf8' });
    assert.equal(uninstallResult.status, 0, uninstallResult.stderr);
    assert.equal(fs.existsSync(path.join(destination, 'extensions', 'gsd-omp.ts')), false);
    assert.equal(fs.existsSync(path.join(destination, 'extensions', 'gsd-omp.cjs')), false);
  } finally {
    cleanup(destination);
  }
});

test('the real OMP host loads the extension and serves native commands over RPC', (t) => {
  const omp = process.env.OMP_BIN || 'omp';
  const probe = spawnSync(omp, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip(`OMP host unavailable: ${probe.error?.message || `exit ${probe.status}`}`);
    return;
  }

  const cwd = path.resolve(__dirname, '..');
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-host-runtime-'));
  try {
    const installer = path.join(cwd, 'bin', 'install.js');
    const install = spawnSync(process.execPath, [installer, '--omp', '--global', '--config-dir', runtimeRoot], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const input = [
      JSON.stringify({ id: 'commands', type: 'get_available_commands' }),
      JSON.stringify({ id: 'status', type: 'prompt', message: '/gsd-status' }),
    ].join('\n') + '\n';
    const result = spawnSync(omp, [
      '--mode', 'rpc',
      '--no-session',
      '--no-skills',
      '--no-rules',
      '--extension', runtimeRoot,
      '--cwd', cwd,
    ], {
      cwd,
      encoding: 'utf8',
      input,
      timeout: 30000,
    });
    if (result.status !== 0 && /No models available/.test(result.stderr || '')) {
      t.skip('OMP host has no configured model');
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const commands = frames.find((frame) => frame.id === 'commands' && frame.command === 'get_available_commands');
    assert.ok(commands?.success, `Missing successful commands response: ${result.stdout}`);
    const names = commands.data.commands.map(({ name }) => name);
    for (const name of ['gsd', 'gsd-status', 'gsd-progress', 'gsd-new-project', 'gsd-resume-work']) {
      assert.ok(names.includes(name), `Missing native OMP command: ${name}`);
    }
    const status = frames.find((frame) => frame.id === 'status' && frame.command === 'prompt');
    assert.ok(status?.success, `Native /gsd-status did not complete: ${result.stdout}`);
  } finally {
    cleanup(runtimeRoot);
  }
});

test('the adapter persists checkpoints without adding a footer status', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const checkpoint = gsdPiExtension._internals.extractCheckpoint('[checkpoint] phase 05 wave 4/10 plan 05-08 complete (7/23 plans done)');
  assert.deepEqual(checkpoint, { phase: 5, wave: 4, waveTotal: 10, plan: '05-08', plansDone: 7, plansTotal: 23 });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-checkpoint-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: executing\n---\n');
  const statuses = [];
  const ctx = { cwd, hasUI: true, ui: { setStatus: (key, text) => statuses.push({ key, text }) } };
  await pi._recorded.events.tool_result({ content: [{ type: 'text', text: '[checkpoint] phase 05 wave 4/10 plan 05-08 complete (7/23 plans done)' }] }, ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.planning', '.omp-checkpoint.json'), 'utf8')), checkpoint);
  await pi._recorded.events.session_start({}, ctx);
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: ready_for_verification\n---\n');
  await pi._recorded.events.turn_end({}, ctx);
  assert.deepEqual(statuses, []);
});

test('the adapter leaves native task activity to OMP', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-native-tasks-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "04"\nstatus: executing\n---\n');
  const statuses = [];
  const widgets = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      setStatus: (key, text) => statuses.push({ key, text }),
      setWidget: (key, lines, options) => widgets.push({ key, lines: lines.map(stripAnsi), options }),
    },
  };

  await pi._recorded.commands['gsd-execute-phase'].handler('04', ctx);
  const result = await pi._recorded.events.tool_call({
    toolName: 'task',
    input: { tasks: [{ id: 'Phase04Plan0401Executor', role: 'GSD plan executor', description: 'Execute plan', assignment: 'Execute 04-01', isolated: true }] },
  }, ctx);
  assert.equal(result, undefined);
  assert.deepEqual(statuses, []);
  assert.deepEqual(widgets, []);
});

test('the OMP adapter persists native executor task results', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const result = gsdPiExtension._internals.extractTaskResult('[gsd-task-result] phase 05 plan 05-08 task Phase05Plan0508Executor completed');
  assert.deepEqual(result, { phase: 5, plan: '05-08', task: 'Phase05Plan0508Executor', status: 'completed' });
  assert.deepEqual(
    gsdPiExtension._internals.extractTaskResult('{"message":"[gsd-task-result] phase 05 plan 05-08 task Phase05Plan0508Executor failed"}'),
    { ...result, status: 'failed' },
  );

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-results-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: executing\n---\n');
  await pi._recorded.events.tool_result({ content: [{ type: 'text', text: '[gsd-task-result] phase 05 plan 05-08 task Phase05Plan0508Executor completed' }] }, { cwd });
  await pi._recorded.events.tool_result({
    toolName: 'job',
    content: [{ type: 'text', text: '## Completed\n<output>{"message":"[gsd-task-result] phase 05 plan 05-08 task Phase05Plan0508Executor failed"}</output>' }],
  }, { cwd });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.planning', '.omp-task-results.json'), 'utf8')), [{ ...result, status: 'failed' }]);

  fs.unlinkSync(path.join(cwd, '.planning', '.omp-task-results.json'));
  await pi._recorded.events.tool_result({
    toolName: 'task',
    content: [],
    details: { progress: [{ id: 'Phase05Plan0508Executor', agent: 'gsd-executor', status: 'failed' }] },
  }, { cwd });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.planning', '.omp-task-results.json'), 'utf8')), [{ ...result, status: 'failed' }]);

  fs.unlinkSync(path.join(cwd, '.planning', '.omp-task-results.json'));
  await pi._recorded.events.tool_result({
    toolName: 'task',
    content: [],
    details: { progress: [{ id: 'Phase100Plan10001Executor', agent: 'gsd-executor', status: 'aborted' }] },
  }, { cwd });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.planning', '.omp-task-results.json'), 'utf8')), [{
    phase: 100,
    plan: '100-01',
    task: 'Phase100Plan10001Executor',
    status: 'cancelled',
  }]);
});


test('the state hook and /gsd-status localize progress and blockers', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-state-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ response_language: 'Simplified Chinese', mode: 'interactive', hooks: { workflow_guard: true } }));
  const state = (completedPlans) => `---
current_phase: "01"
current_phase_name: execution-foundation
status: executing
progress:
  total_plans: 5
  completed_plans: ${completedPlans}
---

## Current Position

Status: Ready for 01-05-PLAN.md

## Blockers/Concerns

- Verify gateway capability
- Verify secret storage

## Deferred Items
`;
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), state(3));

  const pi = mockPi();
  gsdPiExtension(pi);
  const notices = [];
  const statuses = [];
  const widgets = [];
  const ctx = { cwd, hasUI: true, ui: {
    notify: (message, level) => notices.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }),
    setWidget: (key, lines, options) => widgets.push({ key, lines, options }),
  } };
  await pi._recorded.events.session_start({}, ctx);
  assert.match(notices[0].message, /Project State Reminder/);
  assert.deepEqual(statuses, []);
  assert.deepEqual({
    ...widgets[0],
    lines: widgets[0].lines.map(stripAnsi),
  }, {
    key: 'gsd',
    lines: ['GSD · 需要关注', '└─ ⚠ 2 关注'],
    options: { placement: 'aboveEditor' },
  });
  assert.ok(widgets[0].lines[0].includes(`${ANSI_ESCAPE}[33m`));

  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  const chineseSummary = pi._recorded.messages.at(-1);
  assert.equal(chineseSummary.message.customType, 'gsd-status-summary');
  assert.match(chineseSummary.message.content, /阶段：01 \/ execution-foundation/);
  assert.match(chineseSummary.message.content, /风险：⚠ 2 关注/);

  fs.writeFileSync(configPath, JSON.stringify({ response_language: 'English', hooks: { workflow_guard: true } }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), state(4));
  await pi._recorded.events.turn_end({}, ctx);
  assert.deepEqual(statuses, []);

  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  const englishSummary = pi._recorded.messages.at(-1);
  assert.match(englishSummary.message.content, /GSD Project Status/);
  assert.match(englishSummary.message.content, /Risks: ⚠ 2 concerns/);
});

test('status and next surface native task recovery until completion', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-task-recovery-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: executing\n---\n\n## Current Position\n\nStatus: Continue execution\n');
  const failed = { phase: 5, plan: '05-08', task: 'Phase05Plan0508Executor', status: 'failed' };
  fs.writeFileSync(path.join(cwd, '.planning', '.omp-task-results.json'), JSON.stringify([failed]));
  fs.writeFileSync(path.join(cwd, '.planning', '.omp-next-action.json'), JSON.stringify({
    label: 'Stale verification continuation',
    command: '/gsd-verify-work 05',
    requiresFreshContext: false,
  }));
  const pi = mockPi();
  gsdPiExtension(pi);

  const widgets = [];
  await pi._recorded.events.session_start({}, {
    cwd,
    hasUI: true,
    ui: { setWidget: (key, lines, options) => widgets.push({ key, lines, options }) },
  });
  assert.deepEqual(widgets[0].lines.map(stripAnsi), [
    'GSD · Recovery needed',
    '└─ ⛔ Native task recovery: 1 failed',
    '   /gsd-execute-phase 05',
  ]);

  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  assert.match(pi._recorded.messages.at(-1).message.content, /Native task recovery: Phase 05 \/ plan 05-08 \/ task Phase05Plan0508Executor: failed/);
  assert.match(pi._recorded.messages.at(-1).message.content, /Recovery command: \/gsd-execute-phase 05/);

  const selections = [];
  let editorText;
  await pi._recorded.commands['gsd-next'].handler('', {
    cwd,
    hasUI: true,
    ui: {
      select: async (_title, choices) => {
        selections.push(choices);
        return choices[0].label;
      },
      setEditorText: (text) => { editorText = text; },
    },
  });
  assert.match(selections[0][0].label, /Recover native task for Phase 05/);
  assert.equal(editorText, '/gsd-execute-phase 05');

  fs.writeFileSync(path.join(cwd, '.planning', '.omp-task-results.json'), JSON.stringify([{ ...failed, status: 'completed' }]));
  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  assert.doesNotMatch(pi._recorded.messages.at(-1).message.content, /Native task recovery/);
});

test('the widget and status summary surface resumable checkpoints', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-checkpoint-status-'));
  try {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: executing\n---\n');
    fs.writeFileSync(path.join(cwd, '.planning', '.omp-checkpoint.json'), JSON.stringify({ phase: 5, wave: 4, waveTotal: 10, plan: '05-08', plansDone: 7, plansTotal: 23 }));
    const pi = mockPi();
    gsdPiExtension(pi);
    const widgets = [];
    await pi._recorded.events.session_start({}, {
      cwd,
      hasUI: true,
      ui: { setWidget: (_key, lines) => widgets.push(lines.map(stripAnsi)) },
    });
    assert.deepEqual(widgets[0], [
      'GSD · Resume available',
      '└─ ↻ Resume Phase 05: 7/23 plans complete',
      '   /gsd-resume-work',
    ]);

    await pi._recorded.commands['gsd-status'].handler('', { cwd });
    assert.match(pi._recorded.messages.at(-1).message.content, /Checkpoint recovery: Phase 05 \/ plan 05-08 \/ wave 4\/10 \/ 7\/23 plans complete/);
    assert.match(pi._recorded.messages.at(-1).message.content, /Resume command: \/gsd-resume-work/);
  } finally {
    cleanup(cwd);
  }
});

test('the GSD console localizes verification-ready state and instruction', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-verification-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'Simplified Chinese' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: ready_for_verification\nprogress:\n total_plans: 5\n completed_plans: 4\n---\n\n## Current Position\n\nStatus: Ready for phase verification\n');

  const pi = mockPi();
  gsdPiExtension(pi);
  const statuses = [];
  const widgets = [];
  const ctx = { cwd, hasUI: true, ui: {
    setStatus: (key, text) => statuses.push({ key, text }),
    setWidget: (key, lines, options) => widgets.push({ key, lines, options }),
  } };
  await pi._recorded.events.session_start({}, ctx);
  assert.deepEqual(statuses, []);
  assert.deepEqual(widgets[0].lines, []);
});

test('the GSD status summary prefers exact phase artifacts over roadmap totals', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-artifacts-'));
  const phaseDirectory = path.join(cwd, '.planning', 'phases', '01-execution-foundation');
  fs.mkdirSync(phaseDirectory, { recursive: true });
  for (const plan of ['01', '02', '03', '04']) {
    fs.writeFileSync(path.join(phaseDirectory, `01-${plan}-PLAN.md`), 'plan');
    fs.writeFileSync(path.join(phaseDirectory, `01-${plan}-SUMMARY.md`), 'summary');
  }
  fs.writeFileSync(path.join(phaseDirectory, '01-PLAN-REVIEW.md'), 'review');
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'Simplified Chinese' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: ready_for_verification\nprogress:\n total_plans: 5\n completed_plans: 4\n---\n');
  const statuses = [];
  await pi._recorded.events.session_start({}, { cwd, hasUI: true, ui: { setStatus: (key, text) => statuses.push({ key, text }) } });
  assert.deepEqual(statuses, []);
  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  assert.match(pi._recorded.messages.at(-1).message.content, /计划：阶段计划 4 \/ 4 已完成/);
});

test('the GSD status summary counts only summaries matching a phase plan', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-matched-artifacts-'));
  const phaseDirectory = path.join(cwd, '.planning', 'phases', '01-execution-foundation');
  fs.mkdirSync(phaseDirectory, { recursive: true });
  for (const plan of ['01', '02']) fs.writeFileSync(path.join(phaseDirectory, `01-${plan}-PLAN.md`), 'plan');
  fs.writeFileSync(path.join(phaseDirectory, '01-01-SUMMARY.md'), 'summary');
  fs.writeFileSync(path.join(phaseDirectory, '01-99-SUMMARY.md'), 'orphan summary');
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\nprogress:\n total_plans: 2\n completed_plans: 2\n---\n');
  const statuses = [];
  await pi._recorded.events.session_start({}, { cwd, hasUI: true, ui: { setStatus: (key, text) => statuses.push({ key, text }) } });
  assert.deepEqual(statuses, []);
  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  assert.match(pi._recorded.messages.at(-1).message.content, /Plans: Phase plans 1 \/ 2 complete/);

});
test('the first interactive GSD session persists language and interaction preferences once', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-onboarding-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ hooks: { workflow_guard: true } }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');

  const pi = mockPi();
  gsdPiExtension(pi);
  const selections = ['简体中文', '终端文本式'];
  const prompts = [];
  const statuses = [];
  const notices = [];
  const ctx = { cwd, hasUI: true, ui: {
    select: async (title, options) => {
      prompts.push({ title, labels: options.map(({ label }) => label) });
      return selections.shift();
    },
    notify: (message, level) => notices.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }),
  } };
  await pi._recorded.events.session_start({}, ctx);
  await new Promise(setImmediate);
  await pi._recorded.events.session_start({}, ctx);
  await new Promise(setImmediate);

  assert.deepEqual(prompts, [
    { title: 'GSD language / GSD 界面语言', labels: ['简体中文', 'English'] },
    { title: 'GSD 交互方式', labels: ['OMP 交互式（推荐）', '终端文本式'] },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    hooks: { workflow_guard: true },
    response_language: 'Simplified Chinese',
    workflow: { text_mode: true },
  });
  assert.deepEqual(statuses, []);
  assert.ok(notices.some(({ message }) => message === 'GSD language set to Simplified Chinese'));
  assert.ok(notices.some(({ message }) => message === 'GSD interaction set to terminal text'));
});

test('the onboarding prompt is deduplicated across equivalent project paths', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-onboarding-canonical-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  fs.writeFileSync(configPath, JSON.stringify({}));
  const pi = mockPi();
  gsdPiExtension(pi);
  const prompts = [];
  const selections = ['English', 'OMP interactive (recommended)'];
  const ui = {
    select: async (title) => {
      prompts.push(title);
      return selections.shift();
    },
  };

  pi._recorded.events.session_start({}, { cwd, hasUI: true, ui });
  pi._recorded.events.session_start({}, { cwd: path.relative(process.cwd(), cwd), hasUI: true, ui });
  await new Promise(setImmediate);

  assert.deepEqual(prompts, ['GSD language / GSD 界面语言', 'GSD interaction style']);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).response_language, 'English');
});

test('the onboarding preserves an explicit interaction preference', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-onboarding-explicit-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ workflow: { text_mode: false } }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const pi = mockPi();
  gsdPiExtension(pi);
  const prompts = [];
  await pi._recorded.events.session_start({}, { cwd, hasUI: true, ui: {
    select: async (title) => { prompts.push(title); return 'English'; },
  } });
  await new Promise(setImmediate);

  assert.deepEqual(prompts, ['GSD language / GSD 界面语言']);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    workflow: { text_mode: false },
    response_language: 'English',
  });
});

test('the onboarding retries after cancellation and tolerates a minimal UI', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-onboarding-retry-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const pi = mockPi();
  gsdPiExtension(pi);
  const selections = [undefined, 'English', 'OMP interactive (recommended)'];
  const ctx = { cwd, hasUI: true, ui: { select: async () => selections.shift() } };
  await pi._recorded.events.session_start({}, ctx);
  await new Promise(setImmediate);
  await pi._recorded.events.session_start({}, ctx);
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    response_language: 'English',
    workflow: { text_mode: false },
  });
  const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-second-onboarding-'));
  fs.mkdirSync(path.join(secondCwd, '.planning'));
  const secondConfigPath = path.join(secondCwd, '.planning', 'config.json');
  fs.writeFileSync(secondConfigPath, JSON.stringify({}));
  fs.writeFileSync(path.join(secondCwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const secondSelections = ['简体中文', 'OMP 交互式（推荐）'];
  await pi._recorded.events.session_start({}, { cwd: secondCwd, hasUI: true, ui: { select: async () => secondSelections.shift() } });
  await new Promise(setImmediate);
  assert.equal(JSON.parse(fs.readFileSync(secondConfigPath, 'utf8')).response_language, 'Simplified Chinese');
  const minimalCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-minimal-ui-'));
  fs.mkdirSync(path.join(minimalCwd, '.planning'));
  fs.writeFileSync(path.join(minimalCwd, '.planning', 'config.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(minimalCwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const minimalPi = mockPi();
  gsdPiExtension(minimalPi);
  await minimalPi._recorded.events.session_start({}, { cwd: minimalCwd, hasUI: true, ui: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(minimalCwd, '.planning', 'config.json'), 'utf8')), {});
});

test('the language selector skips directories that are not GSD projects', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-not-project-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}));
  const pi = mockPi();
  gsdPiExtension(pi);
  let selectCount = 0;
  await pi._recorded.events.session_start({}, {
    cwd,
    hasUI: true,
    ui: { select: async () => { selectCount += 1; return 'English'; } },
  });
  await new Promise(setImmediate);
  assert.equal(selectCount, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {});
});

test('the adapter lifecycle stays inert outside a GSD project', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-lifecycle-gate-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
  const pi = mockPi();
  gsdPiExtension(pi);
  const statuses = [];
  const widgets = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      setStatus: (key, text) => statuses.push({ key, text }),
      setWidget: (key, lines) => widgets.push({ key, lines }),
    },
  };

  await pi._recorded.events.session_start({}, ctx);
  await pi._recorded.events.turn_end({}, ctx);
  const advisory = await pi._recorded.events.tool_call({ toolName: 'edit', input: { path: 'src/app.ts' } }, ctx);
  await pi._recorded.events.tool_result({ content: [{ type: 'text', text: '[checkpoint] phase 01 wave 1/1 plan 01-01 complete (1/1 plans done)' }] }, ctx);

  assert.equal(advisory, undefined);
  assert.deepEqual(statuses, []);
  assert.deepEqual(widgets, []);
  assert.equal(pi._recorded.messages.length, 0);
  assert.equal(fs.existsSync(path.join(cwd, '.planning', '.omp-checkpoint.json')), false);
});

test('an unresolved language dialog never blocks the session-start handler', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-language-timeout-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const pi = mockPi();
  gsdPiExtension(pi);
  let resolveSelection;
  const selection = new Promise((resolve) => { resolveSelection = resolve; });
  let promptCount = 0;
  let sessionStartResolved = false;
  const sessionStart = Promise.resolve(pi._recorded.events.session_start({}, {
    cwd,
    hasUI: true,
    ui: { select: () => (++promptCount === 1 ? selection : 'OMP interactive (recommended)') },
  })).then(() => { sessionStartResolved = true; });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessionStartResolved, true);
  resolveSelection('English');
  await sessionStart;
  await new Promise(setImmediate);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).response_language, 'English');
});

test('the GSD next menu delegates in-project advancement to canonical progress', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-console-'));
  try {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), `---
current_phase: "02"
current_phase_name: order-workflow
status: executing
---

## Current Position

Status: Review 02-03-PLAN.md

## Blockers

- Credential-store strategy unresolved
`);
    const pi = mockPi();
    gsdPiExtension(pi);
    const editor = [];
    const menus = [];
    const ctx = { cwd, hasUI: true, ui: {
      select: async (_title, options) => {
        menus.push(options.map(({ label }) => label));
        return options[0];
      },
      setEditorText: (text) => editor.push(text),
    } };
    await pi._recorded.commands['gsd-next'].handler('', ctx);
    assert.deepEqual(editor, ['/gsd-progress --next']);
    assert.deepEqual(menus[0], ['Advance safely through GSD progress', 'View project overview', 'Later']);

    await pi._recorded.commands['gsd-next'].handler('', { cwd });
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-progress-next');
    assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, false);
    assert.match(pi._recorded.messages.at(-1).message.content, /gsd-progress --next/);
  } finally {
    cleanup(cwd);
  }
});

test('the GSD next action prepares project initialization only in a new workspace', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-new-workspace-'));
  try {
    const pi = mockPi();
    gsdPiExtension(pi);
    const menus = [];
    const editor = [];
    await pi._recorded.commands['gsd-next'].handler('', {
      cwd,
      hasUI: true,
      ui: {
        select: async (_title, choices) => {
          menus.push(choices.map(({ label }) => label));
          return choices[0];
        },
        setEditorText: (text) => editor.push(text),
      },
    });
    assert.deepEqual(menus, [['Start a GSD project', 'Later']]);
    assert.deepEqual(editor, ['/gsd-new-project']);

    await pi._recorded.commands['gsd-next'].handler('', { cwd });
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-start-project');
    assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, false);
    assert.match(pi._recorded.messages.at(-1).message.content, /Start with \/gsd-new-project/);

    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'PROJECT.md'), '# Existing project\n');
    await pi._recorded.commands['gsd-next'].handler('', { cwd });
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-next-step');
  } finally {
    cleanup(cwd);
  }
});

test('the GSD next action prepares shipping only after UAT completion', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-shipping-ready-'));
  try {
    fs.mkdirSync(path.join(cwd, '.planning', 'phases', '05-release'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: completed\n---\n');
    fs.writeFileSync(path.join(cwd, '.planning', 'phases', '05-release', '05-UAT.md'), '---\nstatus: complete\n---\n');
    const pi = mockPi();
    gsdPiExtension(pi);
    const menus = [];
    const editor = [];
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        select: async (_title, choices) => {
          menus.push(choices.map(({ label }) => label));
          return choices[0];
        },
        setEditorText: (text) => editor.push(text),
      },
    };
    await pi._recorded.commands['gsd-next'].handler('', ctx);
    assert.deepEqual(menus, [['Prepare shipping for Phase 05', 'View project overview', 'Later']]);
    assert.deepEqual(editor, ['/gsd-ship 05']);

    await pi._recorded.commands['gsd-next'].handler('', { cwd });
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-ship-ready');
    assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, false);
    assert.match(pi._recorded.messages.at(-1).message.content, /Command: \/gsd-ship 05/);

    fs.writeFileSync(path.join(cwd, '.planning', 'phases', '05-release', '05-UAT.md'), '---\nstatus: in progress\n---\n');
    await pi._recorded.commands['gsd-next'].handler('', ctx);
    assert.ok(!menus.at(-1).some((label) => label.includes('shipping')));
  } finally {
    cleanup(cwd);
  }
});

test('the GSD next action prepares checkpoint recovery only for active matching work', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-checkpoint-next-'));
  try {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: executing\n---\n');
    fs.writeFileSync(path.join(cwd, '.planning', '.omp-checkpoint.json'), JSON.stringify({ phase: 5, wave: 4, waveTotal: 10, plan: '05-08', plansDone: 7, plansTotal: 23 }));
    const pi = mockPi();
    gsdPiExtension(pi);
    const menus = [];
    const editor = [];
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        select: async (_title, choices) => {
          menus.push(choices.map(({ label }) => label));
          return choices[0];
        },
        setEditorText: (text) => editor.push(text),
      },
    };
    await pi._recorded.commands['gsd-next'].handler('', ctx);
    assert.deepEqual(menus, [['Resume Phase 05 execution context', 'View project overview', 'Later']]);
    assert.deepEqual(editor, ['/gsd-resume-work']);

    await pi._recorded.commands['gsd-next'].handler('', { cwd });
    assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-resume-ready');
    assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, false);

    fs.writeFileSync(path.join(cwd, '.planning', '.omp-next-action.json'), JSON.stringify({
      label: 'Review final evidence',
      command: '/gsd-plan-phase 05',
      requiresFreshContext: false,
    }));
    await pi._recorded.commands['gsd-next'].handler('', ctx);
    assert.equal(menus.at(-1)[0], 'Continue: Review final evidence');
    fs.unlinkSync(path.join(cwd, '.planning', '.omp-next-action.json'));

    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "06"\nstatus: executing\n---\n');
    await pi._recorded.commands['gsd-next'].handler('', ctx);
    assert.ok(!menus.at(-1).some((label) => label.includes('Resume Phase')));
  } finally {
    cleanup(cwd);
  }
});

test('the adapter turns a completed GSD Next Up block into a prepared continuation', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const output = `
────────────────────────────────────────────────────────────────────────────────

 ▶ Next Up

 Phase 1 gap closure — plan the metadata-refresh-before-validation boundary.

 /clear then:

 /gsd:plan-phase 01 --gaps

 ────────────────────────────────────────────────────────────────────────────────
`;
  const action = gsdPiExtension._internals.extractNextAction(output);
  assert.deepEqual(action, {
    label: 'Phase 1 gap closure — plan the metadata-refresh-before-validation boundary.',
    command: '/gsd:plan-phase 01 --gaps',
    requiresFreshContext: true,
  });
  assert.deepEqual(gsdPiExtension._internals.extractNextAction(output.replace('/gsd:plan-phase', '/gsd-plan-phase')), {
    ...action,
    command: '/gsd-plan-phase 01 --gaps',
  });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-continuation-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: completed\n---\n');
  fs.writeFileSync(path.join(cwd, '.planning', '.omp-next-action.json'), JSON.stringify(action));

  const widgets = [];
  const editor = [];
  const ctx = { cwd, hasUI: true, ui: {
    select: async (_title, options) => options[0],
    setEditorText: (text) => editor.push(text),
    setWidget: (key, lines, options) => widgets.push({ key, lines, options }),
  } };
  await pi._recorded.events.session_start({}, ctx);
  assert.deepEqual(widgets[0].lines.map(stripAnsi), [
    'GSD · Next Up',
    '└─ Phase 1 gap closure — plan the metadata-refresh-before-validation boundary.',
    '   /gsd:plan-phase 01 --gaps',
  ]);

  await pi._recorded.commands['gsd-next'].handler('', ctx);
  assert.deepEqual(editor, ['/new\n/gsd:plan-phase 01 --gaps']);
});


test('the workflow guard queues one non-blocking advisory per edited file', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-guard-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');

  const pi = mockPi();
  gsdPiExtension(pi);
  const event = { toolName: 'edit', input: { path: 'src/app.ts' } };
  assert.equal(await pi._recorded.events.tool_call(event, { cwd }), undefined);
  assert.equal(await pi._recorded.events.tool_call(event, { cwd }), undefined);
  assert.equal(pi._recorded.messages.length, 1);
  assert.equal(pi._recorded.messages[0].message.customType, 'gsd-workflow-advisory');
  assert.equal(pi._recorded.messages[0].options.deliverAs, 'nextTurn');
});

test('the workflow guard does not suppress advisories in another GSD project', async () => {
  const firstCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-guard-first-'));
  const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-guard-second-'));
  for (const cwd of [firstCwd, secondCwd]) {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  }
  const pi = mockPi();
  gsdPiExtension(pi);
  const event = { toolName: 'edit', input: { path: 'src/app.ts' } };

  await pi._recorded.events.tool_call(event, { cwd: firstCwd });
  await pi._recorded.events.tool_call(event, { cwd: secondCwd });
  await pi._recorded.events.tool_call(event, { cwd: firstCwd });

  assert.equal(pi._recorded.messages.length, 2);
});

test('gsdPiExtension rejects a missing ExtensionAPI', () => {
  assert.throws(() => gsdPiExtension(null), /ExtensionAPI is required/);
});
