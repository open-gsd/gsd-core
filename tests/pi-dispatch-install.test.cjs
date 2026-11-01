'use strict';

/**
 * #5569 — Pi agent-role dispatch: install layout, role converter, and `Agent(...)` projection
 * (ADR-5559 acceptance 4–6). The runtime half (the `gsd_dispatch` tool) is tests/pi-dispatch.test.cjs.
 *
 * Covered here:
 *  - the installed Pi `agents/` set equals the non-compact shipped roles, in both scopes;
 *  - `convertClaudeAgentToPiAgent` maps tools to Pi names and records what it drops;
 *  - workflows installed for Pi dispatch through `gsd_dispatch(role=…, task=…)` and name only
 *    installed roles; an unshipped role fails the install projection;
 *  - the Hermes projection is byte-identical to its pre-#5569 output;
 *  - `/gsd-debug` is recorded unsupported on Pi and prints its reason;
 *  - the Pi descriptor's host dispatch axes are unchanged.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { cleanup, installSpawnEnv } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { _internals } = require('../pi/gsd.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const installBin = require('../bin/install.js');
const {
  convertClaudeAgentToPiAgent,
  convertClaudeCommandToPiSkill,
  mapClaudeToolsToPi,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const REPO = path.join(__dirname, '..');
const SHIPPED_AGENTS = path.join(REPO, 'agents');

const shippedRoles = () =>
  fs.readdirSync(SHIPPED_AGENTS)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.compact.md'))
    .sort();

// Roles a workflow names that are not GSD roles: gsd_dispatch refuses them (role-unresolved), which
// is the fail-closed outcome. discuss-phase-assumptions asks for the host's generic agent.
const NON_GSD_ROLES = new Set(['general-purpose']);

const PI_DISPATCH = { namedDispatch: false, nested: false, maxDepth: 0, background: false };
const piConfig = (roles) =>
  Object.assign({}, installBin.PI_DISPATCH_TOOL_CONFIG, { availableRoles: new Set(roles), runtime: 'pi' });

describe('#5569: Pi agents install layout', () => {
  for (const scope of ['global', 'local']) {
    test(`${scope}: installed roles equal the non-compact shipped roles; no compact variant`, (t) => {
      const { configDir, root } = runMinimalInstall({ runtime: 'pi', scope });
      t.after(() => cleanup(root));
      const installed = fs.readdirSync(path.join(configDir, 'agents')).sort();
      assert.deepEqual(installed, shippedRoles());
      assert.ok(installed.length > 0, 'vacuous: no roles installed');
      assert.equal(installed.filter((f) => f.endsWith('.compact.md')).length, 0);
    });
  }

  test('an installed role is Pi-shaped: name, quoted description, lowercase tools', (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'pi', scope: 'global' });
    t.after(() => cleanup(root));
    const text = fs.readFileSync(path.join(configDir, 'agents', 'gsd-planner.md'), 'utf8');
    assert.match(text, /^---\r?\nname: gsd-planner\r?\n/);
    assert.match(text, /^tools: [a-z, ]+$/m);
    assert.doesNotMatch(text, /^tools: .*\b(Read|Write|Bash)\b/m);
  });
});

describe('#5569: convertClaudeAgentToPiAgent', () => {
  const SOURCE = [
    '---',
    'name: gsd-sample',
    'description: Does a thing',
    'tools: Read, Write, Edit, Bash, Grep, Glob, WebSearch, mcp__ctx__query',
    'color: blue',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');

  test('maps tools to Pi names and records the dropped ones', () => {
    const out = convertClaudeAgentToPiAgent(SOURCE);
    assert.match(out, /^tools: read, write, edit, bash, grep, find$/m);
    assert.match(out, /^# tools with no Pi equivalent, dropped: WebSearch, mcp__ctx__query$/m);
    assert.match(out, /\nBody\.\n$/);
    assert.doesNotMatch(out, /color:/);
  });

  test('no tools line when the role lists none; no model key', () => {
    const out = convertClaudeAgentToPiAgent('---\nname: gsd-x\ndescription: d\n---\nB\n');
    assert.doesNotMatch(out, /^tools:/m);
    assert.doesNotMatch(out, /^model:/m);
  });

  test('content without frontmatter passes through', () => {
    assert.equal(typeof convertClaudeAgentToPiAgent('just text'), 'string');
  });

  test('a role that declares only unmappable tools falls back to read-only, never to Pi defaults', () => {
    const out = convertClaudeAgentToPiAgent('---\nname: gsd-x\ndescription: d\ntools: WebSearch, Task\n---\nB\n');
    assert.match(out, /^tools: read$/m);
    assert.match(out, /^# tools with no Pi equivalent, dropped: WebSearch, Task$/m);
  });

  test('a multi-line tools list is mapped like the inline form', () => {
    const out = convertClaudeAgentToPiAgent('---\nname: gsd-x\ndescription: d\ntools:\n  - Read\n  - Bash\n  - Skill\n---\nB\n');
    assert.match(out, /^tools: read, bash$/m);
  });

  test('property: mapped is the de-duplicated table image of the input, dropped the de-duplicated rest', () => {
    const TABLE = { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash', Grep: 'grep', Glob: 'find' };
    const uniq = (xs) => [...new Set(xs)];
    fc.assert(
      fc.property(fc.array(fc.constantFrom('Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task', 'WebSearch', 'mcp__a__b', 'Skill')), (tools) => {
        const { mapped, dropped } = mapClaudeToolsToPi(tools);
        assert.deepEqual(mapped, uniq(tools.filter((t) => TABLE[t]).map((t) => TABLE[t])));
        assert.deepEqual(dropped, uniq(tools.filter((t) => !TABLE[t])));
      }),
      { seed: 5569, numRuns: 200 },
    );
  });

  test('mapClaudeToolsToPi maps the six host tools and drops the rest, without duplicates', () => {
    const { mapped, dropped } = mapClaudeToolsToPi(['Read', 'Read', 'Glob', 'Task']);
    assert.deepEqual(mapped, ['read', 'find']);
    assert.deepEqual(dropped, ['Task']);
  });
});

describe('#5569: Agent(...) projection onto gsd_dispatch', () => {
  const MULTILINE = [
    'Agent(',
    '  prompt="do it",',
    '  subagent_type="gsd-planner",',
    '  model="{planner_model}",',
    '  description="Plan {phase}"',
    ')',
  ].join('\n');

  test('multi-line call: role and task kept, model/description dropped', () => {
    const out = installBin.projectNamedDispatchToStructuralDelegate(MULTILINE, PI_DISPATCH, piConfig(['gsd-planner']));
    assert.match(out, /^gsd_dispatch\(/);
    assert.match(out, /task="do it"/);
    assert.match(out, /role="gsd-planner"/);
    assert.doesNotMatch(out, /Agent|subagent_type|model|description|prompt=|gsd_role|delegate_task/);
  });

  test('single-line object-literal call', () => {
    const out = installBin.projectNamedDispatchToStructuralDelegate(
      'Agent({subagent_type: "gsd-planner", prompt: "x", description: "d"})', PI_DISPATCH, piConfig(['gsd-planner']));
    assert.match(out, /^gsd_dispatch\(role="gsd-planner", task: "x"\)$/);
  });

  test('a dynamic role expression is projected without a static check', () => {
    const out = installBin.projectNamedDispatchToStructuralDelegate(
      'Agent(prompt=frag, subagent_type=ref.agent)', PI_DISPATCH, piConfig(['gsd-planner']));
    assert.match(out, /^gsd_dispatch\(task=frag, role=ref\.agent\)$/);
  });

  test('a role the install does not ship fails the projection', () => {
    assert.throws(
      () => installBin.projectNamedDispatchToStructuralDelegate(
        MULTILINE.replace('gsd-planner', 'gsd-nonexistent'), PI_DISPATCH, piConfig(['gsd-planner'])),
      /no matching agents\/gsd-nonexistent\.md/,
    );
  });

  test('an unresolvable shipped-agents directory fails closed', () => {
    assert.throws(
      () => installBin.projectNamedDispatchToStructuralDelegate(MULTILINE, PI_DISPATCH, Object.assign(piConfig([]), { availableRoles: null })),
      /could not resolve the shipped agents\//,
    );
  });

  test('the host-has-an-Agent-tool assertion becomes the gsd_dispatch contract', () => {
    const out = installBin.projectNamedDispatchToStructuralDelegate(
      'The Agent tool IS available in a top-level Pi session. Always spawn gsd-planner as separate Agent() calls.',
      PI_DISPATCH, piConfig(['gsd-planner']));
    assert.match(out, /`gsd_dispatch` tool IS available/);
    assert.match(out, /cannot dispatch further/);
    assert.match(out, /FAIL CLOSED/);
  });

  test('installed workflows dispatch only through gsd_dispatch and name only installed roles', (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'pi', scope: 'global' });
    t.after(() => cleanup(root));
    const roles = new Set(shippedRoles().map((f) => f.replace(/\.md$/, '')));
    const dir = path.join(configDir, 'gsd-core', 'workflows');
    let calls = 0;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(text, /\bAgent\(|\bsubagent_type\s*[=:]/, `${file} still dispatches through Agent(`);
      // One segment per call: from a `gsd_dispatch(` to the next one.
      for (const segment of text.split('gsd_dispatch(').slice(1)) {
        calls += 1;
        const m = /\brole\s*[=:]\s*"([^"{}\n]{1,100})"/.exec(segment);
        if (m) assert.ok(roles.has(m[1]) || NON_GSD_ROLES.has(m[1]), `${file} dispatches unknown role ${m[1]}`);
      }
    }
    assert.ok(calls > 0, 'vacuous: no gsd_dispatch call found in the installed workflows');
  });

  test('Hermes projection is byte-identical to its pre-#5569 output', () => {
    const input = [
      'Always spawn gsd-planner as separate Agent() calls.',
      '```',
      MULTILINE,
      '```',
      'Agent({subagent_type: "gsd-planner", prompt: "x", description: "d"})',
    ].join('\n');
    const expected =
      'Always spawn gsd-planner as separate delegate_task() calls.\n```\ndelegate_task(\n  prompt="do it",\n  gsd_role="gsd-planner",\n' +
      '  gsd_role_prompt=<resolve "gsd-planner" against the active install\'s gsd-* role prompts and load its contents; FAIL CLOSED with an explicit error if unresolved — never execute the role inline>,\n' +
      '  role="leaf",  # nested delegation is unavailable at this dispatch depth/toolkit\n  description="Plan {phase}"\n)\n```\n' +
      'delegate_task(gsd_role="gsd-planner", gsd_role_prompt=<resolve "gsd-planner" against the active install\'s gsd-* role prompts and load its contents; FAIL CLOSED with an explicit error if unresolved — never execute the role inline>, role="leaf", prompt: "x", description: "d")';
    const cfg = Object.assign({}, installBin.HERMES_DISPATCH_TOOL_CONFIG, { availableRoles: new Set(['gsd-planner']), runtime: 'hermes' });
    assert.equal(installBin.projectNamedDispatchToStructuralDelegate(input, PI_DISPATCH, cfg), expected);
  });
});

describe('#5569, #5630, #5638: /gsd-debug on Pi', () => {
  const COMMAND = '---\nname: gsd:debug\ndescription: Debug an issue\n---\n<execution_context>\n@~/.claude/gsd-core/workflows/debug.md\n</execution_context>\n';
  const COMMAND_WITHOUT_CONTEXT = '---\nname: gsd:debug\ndescription: Debug an issue\n---\nbody\n';

  test('with a workflow to read, the converted skill runs the checkpoint loop: it names the workflow and dispatches only gsd-debugger', () => {
    const out = convertClaudeCommandToPiSkill(COMMAND, 'gsd-debug');
    assert.match(out, /^---\r?\nname: gsd-debug\r?\n/);
    assert.match(out, /gsd_dispatch\(role="gsd-debugger"/);
    assert.match(out, /Never dispatch `gsd-debug-session-manager`/);
    assert.match(out, /debug\.md/);
    assert.doesNotMatch(out, /is unsupported on Pi:/);
    assert.doesNotMatch(out, /Partly supported on Pi/);
  });

  test('with no workflow to read, the converted skill is the full stub and does not carry a workflow include', () => {
    const out = convertClaudeCommandToPiSkill(COMMAND_WITHOUT_CONTEXT, 'gsd-debug');
    assert.match(out, /^---\r?\nname: gsd-debug\r?\n/);
    assert.match(out, /unsupported on Pi: needs nested dispatch; Pi dispatch is flat/);
    assert.match(out, /Do not start the workflow/);
    assert.doesNotMatch(out, /execution_context|debug\.md/);
  });

  test('any other command keeps its workflow include and the dispatch contract', () => {
    const out = convertClaudeCommandToPiSkill(COMMAND.replace('gsd:debug', 'gsd:plan-phase'), 'gsd-plan-phase');
    assert.doesNotMatch(out, /unsupported on Pi/);
    assert.match(out, /execution_context/);
    assert.match(out, /\*\*Pi dispatch \(fail closed\)\.\*\*/);
  });

  test('the installed gsd-debug skill is the loop skill', (t) => {
    const { configDir, root } = runMinimalInstall({ runtime: 'pi', scope: 'global' });
    t.after(() => cleanup(root));
    const skill = fs.readFileSync(path.join(configDir, 'skills', 'gsd-debug', 'SKILL.md'), 'utf8');
    assert.match(skill, /gsd_dispatch\(role="gsd-debugger"/);
    assert.match(skill, /`## Session Loop`/);
  });
});

describe('#5569: Pi package ships the converted roles', () => {
  const PKG_ROLES = path.join(REPO, 'pi', 'package-agents');

  test('pi/package-agents holds exactly the converted non-compact roles, byte-identical to an install', (t) => {
    // Installed outside HOME so the installer prints absolute paths, as the generator's temp install does.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-roles-'));
    t.after(() => cleanup(parent));
    const configDir = path.join(parent, 'cfg');
    fs.mkdirSync(configDir);
    const res = spawnSync(process.execPath, [path.join(REPO, 'bin', 'install.js'), '--pi', '--global', '--config-dir', configDir], {
      cwd: REPO, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS, windowsHide: true, env: installSpawnEnv({ PI_CODING_AGENT_DIR: configDir }),
    });
    assert.equal(res.status, 0, `installer failed: ${(res.stderr || res.stdout || '').slice(-600)}`);
    const shipped = fs.readdirSync(PKG_ROLES).filter((f) => f !== 'manifest.json').sort();
    assert.deepEqual(shipped, shippedRoles());
    for (const f of shipped) {
      // A package role is the installer's output with the engine root as a token; rendering it for
      // the install's own root must reproduce the installed role byte for byte.
      const rendered = fs.readFileSync(path.join(PKG_ROLES, f), 'utf8').split('__GSD_PI_ENGINE_ROOT__').join(configDir.replace(/\\/g, '/'));
      assert.equal(rendered, fs.readFileSync(path.join(configDir, 'agents', f), 'utf8'), f);
    }
  });

  test('its manifest.json lists the sha256 of every role, and the dispatcher accepts each one', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROLES, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.files).sort(), shippedRoles());
    for (const [f, hash] of Object.entries(manifest.files)) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(PKG_ROLES, f))).digest('hex'), hash, f);
      const resolved = _internals.resolveDispatchRole(f.replace(/\.md$/, ''), path.join(REPO, 'pi'));
      assert.equal(resolved.ok, true, `${f}: ${resolved.message}`);
      assert.ok(!resolved.bytes.toString('utf8').includes('__GSD_PI_ENGINE_ROOT__'), `${f}: the engine root token was not rendered`);
    }
  });

  test('every shipped role id matches the dispatcher role pattern (installer/extension parity)', () => {
    for (const f of shippedRoles()) assert.match(f.replace(/\.md$/, ''), _internals.DISPATCH.ROLE_RE, f);
  });
});

describe('#5569: Pi descriptor dispatch axes are unchanged', () => {
  test('host-level dispatch stays namedDispatch:false, maxDepth:0 (gsd_dispatch is GSD-provided)', () => {
    const cap = JSON.parse(fs.readFileSync(path.join(REPO, 'capabilities', 'pi', 'capability.json'), 'utf8'));
    const d = cap.runtime.hostIntegration.dispatch;
    assert.equal(d.namedDispatch, false);
    assert.equal(d.nested, false);
    assert.equal(d.maxDepth, 0);
  });

  test('both agents layout entries exclude exactly the compact variants', () => {
    const cap = JSON.parse(fs.readFileSync(path.join(REPO, 'capabilities', 'pi', 'capability.json'), 'utf8'));
    for (const scope of ['global', 'local']) {
      const agents = cap.runtime.artifactLayout[scope].filter((k) => k.kind === 'agents');
      assert.equal(agents.length, 1);
      assert.deepEqual(agents[0].excludeSuffixes, ['.compact.md']);
    }
  });
});

describe('#5569: excludeSuffixes descriptor validation', () => {
  const { validateArtifactLayout } = require('../gsd-core/bin/lib/capability-validator.cjs');
  const entry = (extra) => Object.assign({
    kind: 'agents', destSubpath: 'agents', prefix: 'gsd-', nesting: 'flat', recursive: false, converter: null,
  }, extra);
  const check = (extra) => validateArtifactLayout('t', { global: [entry(extra)], local: [] });

  test('absent and well-formed values are accepted', () => {
    assert.deepEqual(check({}), []);
    assert.deepEqual(check({ excludeSuffixes: ['.compact.md'] }), []);
    assert.deepEqual(check({ excludeSuffixes: [] }), []);
  });

  for (const bad of ['.compact.md', {}, [''], [1], ['a/b'], ['a\\b'], [null]]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.ok(check({ excludeSuffixes: bad }).some((e) => /excludeSuffixes/.test(e)));
    });
  }
});
