/**
 * #5330 — per-spawn effort argument.
 *
 * A runtime descriptor may declare `runtime.spawnEffortParam` (claude: `effort`).
 * `resolveEffortArgInternal` renders `<param>="<effort>"` from the resolved effort
 * cascade for a host that declares one, and `''` for every other host. Init
 * payloads carry it as `<role>_effort_arg` beside `<role>_model`, `resolve-model`
 * as `effort_arg`, and workflows substitute it as `{<role>_effort_arg}` in the
 * spawn call; the agent's installed `effort:` frontmatter stays the fallback.
 *
 * Interim gate (until #4633's single config resolver): the argument is emitted
 * only when the loaded config carries an `effort` block, because under a project
 * config the loader drops ~/.gsd/defaults.json while the installer bakes it into
 * the frontmatter.
 *
 * Isolation follows tests/model-resolver.test.cjs § "#492 manifest effort
 * fallback": a per-test GSD_HOME holding its own defaults.json, and GSD_RUNTIME
 * set per test so the per-install runtime marker never decides the host.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib');
const {
  resolveEffortArgInternal,
  resolveEffortInternal,
  VALID_EFFORTS,
} = require(path.join(LIB, 'model-resolver.cjs'));
const { spawnEffortParamFor } = require(path.join(LIB, 'runtime-name-policy.cjs'));
const { validateRuntimeBody } = require(path.join(LIB, 'capability-validator.cjs'));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A GSD_HOME whose defaults.json carries `effort` (or no defaults.json at all). */
function gsdHome(effort) {
  const home = tmpDir('gsd-home-');
  if (effort !== undefined) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ effort }));
  }
  return home;
}

/** A project dir; `config` undefined → bare dir with no .planning/ at all. */
function project(config) {
  const dir = tmpDir('gsd-test-');
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config));
  }
  return dir;
}

/** Point the resolver at `home` and `runtime` for one test, restoring both after. */
function useEnv(t, { home, runtime }) {
  const saved = { GSD_HOME: process.env.GSD_HOME, GSD_RUNTIME: process.env.GSD_RUNTIME };
  process.env.GSD_HOME = home;
  process.env.GSD_RUNTIME = runtime;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const MAPPER = 'gsd-codebase-mapper';
const GLOBAL_OVERRIDE = { agent_overrides: { [MAPPER]: 'max' } };

describe('#5330 resolveEffortArgInternal — the interim gate', () => {
  test('project config without an effort block: no argument, so the baked frontmatter holds', (t) => {
    const home = gsdHome(GLOBAL_OVERRIDE);
    const dir = project({ model_profile: 'balanced' });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    // The reason for the gate: the runtime cascade has dropped defaults.json here,
    // so it disagrees with the `max` the installer bakes from that same file.
    assert.notEqual(resolveEffortInternal(dir, MAPPER), 'max');
    assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
  });

  test('project config with its own effort block: the argument carries the resolved cascade', (t) => {
    const home = gsdHome(GLOBAL_OVERRIDE);
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'xhigh' } } });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), 'effort="xhigh"');
  });

  test('a project effort block without an entry for the agent still passes the cascade result', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { default: 'medium' } });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), `effort="${resolveEffortInternal(dir, MAPPER)}"`);
  });

  test('no project config: defaults.json is the loaded config, so its effort is passed', (t) => {
    const home = gsdHome(GLOBAL_OVERRIDE);
    const dir = project();
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), 'effort="max"');
  });

  test('no config anywhere: no argument', (t) => {
    const home = gsdHome();
    const dir = project();
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
  });

  test('effort: null in the project config is no block', (t) => {
    const home = gsdHome(GLOBAL_OVERRIDE);
    const dir = project({ effort: null });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
  });
});

describe('#5330 resolveEffortArgInternal — descriptor-driven, never host-coded', () => {
  for (const runtime of ['codex', 'opencode', 'cursor', 'not-a-runtime']) {
    test(`${runtime}: no argument even when the project sets effort`, (t) => {
      const home = gsdHome();
      const dir = project({ effort: { agent_overrides: { [MAPPER]: 'xhigh' } } });
      useEnv(t, { home, runtime });
      t.after(() => { cleanup(dir); cleanup(home); });

      assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
    });
  }

  test('inherit renders no argument: it is never a wire level', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'inherit' } } });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortInternal(dir, MAPPER), 'inherit');
    assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
  });

  test('the host clamp applies: claude has no minimal, so it renders low', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'minimal' } } });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), 'effort="low"');
  });

  test('property: on claude the argument is the cascade value a project names, after the host clamp', (t) => {
    const home = gsdHome();
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => cleanup(home));

    fc.assert(
      fc.property(fc.constantFrom(...VALID_EFFORTS), (effort) => {
        const dir = project({ effort: { agent_overrides: { [MAPPER]: effort } } });
        const arg = resolveEffortArgInternal(dir, MAPPER);
        cleanup(dir);
        return arg === `effort="${effort === 'minimal' ? 'low' : effort}"`;
      }),
      { numRuns: VALID_EFFORTS.length * 3 },
    );
  });
});

describe('#5330 spawnEffortParamFor', () => {
  test('reads the shipped claude descriptor', () => {
    assert.equal(spawnEffortParamFor('claude'), 'effort');
  });

  test('a registered runtime that declares nothing has no parameter', () => {
    assert.equal(spawnEffortParamFor('codex'), null);
  });

  test('absent, unknown and prototype-key ids have no parameter', () => {
    for (const id of ['', undefined, 42, 'not-a-runtime', '__proto__', 'constructor']) {
      assert.equal(spawnEffortParamFor(id), null, String(id));
    }
  });

  test('a registry that failed to load yields no parameter, not Claude Code\'s', () => {
    assert.equal(spawnEffortParamFor('claude', null), null);
  });

  test('a declared value that is not an identifier is not rendered', () => {
    const reg = (v) => ({ runtimes: { x: { runtime: { spawnEffortParam: v } } } });
    assert.equal(spawnEffortParamFor('x', reg('reasoning_effort')), 'reasoning_effort');
    for (const bad of ['effort="high"', 'a b', '', '1x', 7]) {
      assert.equal(spawnEffortParamFor('x', reg(bad)), null, JSON.stringify(bad));
    }
  });
});

describe('#5330 capability validator: runtime.spawnEffortParam', () => {
  function claudeDescriptorWith(value) {
    const cap = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'claude', 'capability.json'), 'utf8'));
    if (value === undefined) delete cap.runtime.spawnEffortParam;
    else cap.runtime.spawnEffortParam = value;
    return cap;
  }
  const fieldErrors = (cap) => validateRuntimeBody(cap).filter((e) => e.includes('spawnEffortParam'));

  test('the shipped value and an absent field are both valid', () => {
    assert.deepEqual(fieldErrors(claudeDescriptorWith('effort')), []);
    assert.deepEqual(fieldErrors(claudeDescriptorWith(undefined)), []);
  });

  test('a non-identifier value is rejected', () => {
    for (const bad of ['', 'effort="high"', 'a b', 42, null, ['effort']]) {
      assert.equal(fieldErrors(claudeDescriptorWith(bad)).length, 1, JSON.stringify(bad));
    }
  });
});

describe('#5330 resolve-model CLI', () => {
  test('emits effort_arg beside effort, and --pick effort_arg prints the bare token', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'xhigh' } } });
    t.after(() => { cleanup(dir); cleanup(home); });
    const env = { GSD_HOME: home, GSD_RUNTIME: 'claude' };

    const full = runGsdTools(['query', 'resolve-model', MAPPER], dir, env);
    assert.ok(full.success, full.error);
    const parsed = JSON.parse(full.output);
    assert.equal(parsed.effort, 'xhigh');
    assert.equal(parsed.effort_arg, 'effort="xhigh"');

    const picked = runGsdTools(['query', 'resolve-model', MAPPER, '--pick', 'effort_arg'], dir, env);
    assert.ok(picked.success, picked.error);
    assert.equal(picked.output.trim(), 'effort="xhigh"');
  });

  test('effort_arg is empty on a host with no per-spawn effort channel', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'xhigh' } } });
    t.after(() => { cleanup(dir); cleanup(home); });

    const res = runGsdTools(['query', 'resolve-model', MAPPER], dir, { GSD_HOME: home, GSD_RUNTIME: 'codex' });
    assert.ok(res.success, res.error);
    assert.equal(JSON.parse(res.output).effort_arg, '');
  });
});

// ---------------------------------------------------------------------------
// Census: every spawn site that passes a resolved model also passes the effort
// argument resolved for the same agent, and every effort placeholder has a
// binding its workflow declares.
//
// The domain is the set of `model=` arguments that carry a resolved field —
// `model="{X}"`, `model: "{X}"` and the prose `model \`X\`` — with X ending in
// `_model`/`_MODEL`. The pairing is by name: `{x_model}` pairs with
// `{x_effort_arg}`, `{X_MODEL}` with `{X_EFFORT_ARG}`, and the effort placeholder
// must sit on the model argument's line or an adjacent one, so each site carries
// its own. A literal tier (`model="haiku"`) is a value, not a resolution, and is
// out of the domain, as are spawns that pass no model at all.
// ---------------------------------------------------------------------------

const SHIPPED_MD_ROOTS = [
  path.join(REPO_ROOT, 'gsd-core', 'workflows'),
  path.join(REPO_ROOT, 'gsd-core', 'references'),
  path.join(REPO_ROOT, 'agents'),
];
const WORKFLOWS = SHIPPED_MD_ROOTS[0];

function listMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(p));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function effortNameFor(modelName) {
  return modelName.endsWith('_model')
    ? `${modelName.slice(0, -'_model'.length)}_effort_arg`
    : `${modelName.slice(0, -'_MODEL'.length)}_EFFORT_ARG`;
}

const MODEL_SITE_RE = /model\s*[=:]\s*"\{([A-Za-z_]+_(?:model|MODEL))\}"|model `([A-Z_]+_MODEL)`|model\s*=\s*([a-z_]+_model)\b/g;
const EFFORT_PLACEHOLDER_RE = /\{([A-Za-z_]+_(?:effort_arg|EFFORT_ARG))\}/g;

/** The effort name for the agent a literal `subagent_type="gsd-…"` spawns: gsd-debug-session-manager → debug_session_manager_effort_arg. */
function effortNameForAgent(window) {
  const m = /subagent_type[=:]\s*"gsd-([a-z0-9-]+)"/.exec(window);
  return m ? `${m[1].replace(/-/g, '_')}_effort_arg` : null;
}

/**
 * `{ line, model, effort }` for each resolved-model site whose effort argument is missing or wrong.
 * A site pairs with `{<role>_effort_arg}` (its model's role) or with the effort resolved for the agent
 * it literally spawns; a bare `model=x_model` pairs with a bare `x_effort_arg`. A spawn of a
 * capability hook's `ref.agent` cannot be resolved statically: it takes no effort argument (the hook
 * agent's frontmatter applies) unless one is bound for that agent, and never another role's init field.
 */
function unpairedSites(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(MODEL_SITE_RE)) {
      const model = m[1] || m[2] || m[3];
      const effort = effortNameFor(model);
      // Within two lines either side: the placeholder sits next to the model line, or above
      // `subagent_type` where a test pins `subagent_type` and `model` adjacent (quick.md).
      const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      const block = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
      if (/\bref\.agent\b/.test(block)) {
        const roleField = [...window.matchAll(EFFORT_PLACEHOLDER_RE)].map((x) => x[1]).find((e) => /_effort_arg$/.test(e));
        if (roleField) out.push({ line: i + 1, model, effort: `none (hook agent; got {${roleField}})` });
        continue;
      }
      if (m[3]) {
        if (!new RegExp(`\\b${effort}\\b`).test(window)) out.push({ line: i + 1, model, effort });
        continue;
      }
      const byAgent = effortNameForAgent(block);
      if (window.includes(`{${effort}}`) || (byAgent && window.includes(`{${byAgent}}`))) continue;
      out.push({ line: i + 1, model, effort });
    }
  });
  return out;
}

function countModelSites(content) {
  return [...content.matchAll(MODEL_SITE_RE)].length;
}

const DECLARATION_RE =
  /^.*(?:Parse JSON for|Parse from init JSON|Extract from init JSON|Parse `\$INIT` for|Use models from init|From it:).*$/gim;

/** Effort placeholders in `content` with no shell assignment, declaration-line mention or bullet. */
function unboundEffortPlaceholders(content) {
  const text = content.replace(/\r\n/g, '\n');
  const declared = new Set();
  for (const line of text.match(DECLARATION_RE) || []) {
    for (const m of line.matchAll(/`([A-Za-z0-9_]+)`/g)) declared.add(m[1]);
  }
  for (const m of text.matchAll(/^[ \t]*-[ \t]+`([A-Za-z0-9_]+)`/gm)) declared.add(m[1]);
  for (const m of text.matchAll(/^[ \t]*([A-Za-z0-9_]+)=\$\(/gm)) declared.add(m[1]);
  // verify-phase-goal.md lists its inputs on the line after "From it:".
  for (const m of text.matchAll(/From it:[^\n]*\n([^\n]*)/g)) {
    for (const b of m[1].matchAll(/`([A-Za-z0-9_]+)`/g)) declared.add(b[1]);
  }
  const used = new Set([...text.matchAll(/\{([A-Za-z_]+_(?:effort_arg|EFFORT_ARG))\}/g)].map((m) => m[1]));
  return [...used].filter((e) => !declared.has(e));
}

/** A workflow and every fragment under workflows/<stem>/, read as one body. */
function workflowFamilies() {
  return fs.readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const stem = f.slice(0, -3);
      const sub = path.join(WORKFLOWS, stem);
      const files = [path.join(WORKFLOWS, f), ...(fs.existsSync(sub) ? listMarkdown(sub) : [])];
      return { name: f, content: files.map((p) => fs.readFileSync(p, 'utf8')).join('\n') };
    });
}

describe('#5330 census: spawn sites pass the effort argument beside the model', () => {
  test('every resolved model= argument has its paired effort placeholder', () => {
    const findings = [];
    let sites = 0;
    let files = 0;
    for (const root of SHIPPED_MD_ROOTS) {
      for (const file of listMarkdown(root)) {
        const content = fs.readFileSync(file, 'utf8');
        const n = countModelSites(content);
        if (n === 0) continue;
        files += 1;
        sites += n;
        for (const u of unpairedSites(content)) {
          findings.push(`${path.relative(REPO_ROOT, file)}:${u.line}: model {${u.model}} without {${u.effort}}`);
        }
      }
    }
    // Non-vacuity: a site regex that silently stops matching must fail, not pass.
    assert.ok(files >= 40, `expected >=40 files with resolved model= sites, found ${files}`);
    assert.ok(sites >= 80, `expected >=80 resolved model= sites, found ${sites}`);
    assert.deepEqual(findings, [], `spawn sites missing the effort argument (#5330):\n  ${findings.join('\n  ')}`);
  });

  test('every effort placeholder is bound by its workflow family or file', () => {
    const findings = [];
    let checked = 0;
    for (const fam of workflowFamilies()) {
      if (!/_(?:effort_arg|EFFORT_ARG)\}/.test(fam.content)) continue;
      checked += 1;
      for (const e of unboundEffortPlaceholders(fam.content)) findings.push(`${fam.name}: {${e}}`);
    }
    for (const file of listMarkdown(SHIPPED_MD_ROOTS[2])) {
      const content = fs.readFileSync(file, 'utf8');
      for (const e of unboundEffortPlaceholders(content)) findings.push(`${path.relative(REPO_ROOT, file)}: {${e}}`);
    }
    assert.ok(checked >= 25, `expected >=25 workflow families with effort placeholders, found ${checked}`);
    assert.deepEqual(findings, [], `effort placeholders with no binding:\n  ${findings.join('\n  ')}`);
  });

  test('every init surface that emits <role>_model also emits <role>_effort_arg', () => {
    const surfaces = ['init.map-codebase', 'init.new-project', 'init.new-milestone', 'init.quick',
      'init.quick-batch', 'docs-init', 'init.debug', 'init.progress'];
    const findings = [];
    let read = 0;
    for (const s of surfaces) {
      const res = runGsdTools(['query', s], REPO_ROOT);
      if (!res.success) continue;
      read += 1;
      const keys = Object.keys(JSON.parse(res.output));
      for (const k of keys.filter((key) => key.endsWith('_model'))) {
        if (!keys.includes(effortNameFor(k))) findings.push(`${s}: ${k} without ${effortNameFor(k)}`);
      }
    }
    assert.ok(read >= 6, `expected >=6 init surfaces to answer with no arguments, ${read} did`);
    assert.deepEqual(findings, []);
  });

  test('the model-profile reference states the empty and rejected-argument rules', () => {
    const ref = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core', 'references', 'model-profile-resolution.md'), 'utf8');
    assert.match(ref, /`\{<role>_effort_arg\}`/);
    assert.match(ref, /When it is empty, drop it/);
    assert.match(ref, /rejects the effort argument[\s\S]{0,120}without it/);
  });
});

// The agent each init-payload effort field is resolved for (src/init.cts and src/docs.cts
// pass the agent id to resolveEffortArgInternal beside the same role's model). A role the
// workflows use that is missing here fails the agent check below, so the table cannot go
// stale silently.
const INIT_ROLE_AGENTS = Object.freeze({
  executor_effort_arg: ['gsd-executor'],
  verifier_effort_arg: ['gsd-verifier'],
  researcher_effort_arg: ['gsd-phase-researcher', 'gsd-project-researcher'],
  planner_effort_arg: ['gsd-planner'],
  checker_effort_arg: ['gsd-plan-checker'],
  synthesizer_effort_arg: ['gsd-research-synthesizer'],
  roadmapper_effort_arg: ['gsd-roadmapper'],
  reviewer_effort_arg: ['gsd-code-reviewer'],
  mapper_effort_arg: ['gsd-codebase-mapper'],
  debugger_effort_arg: ['gsd-debugger'],
  debug_session_manager_effort_arg: ['gsd-debug-session-manager'],
  doc_writer_effort_arg: ['gsd-doc-writer'],
});

/** Effort names bound in shell by `NAME=$(gsd_run query resolve-model <agent> …)`, mapped to that agent. */
function shellEffortBindings(content) {
  const map = new Map();
  const re = /^[ \t]*([A-Za-z_]+_(?:effort_arg|EFFORT_ARG))=\$\(gsd_run query resolve-model "?([^\s"]+)"?/gm;
  for (const m of content.matchAll(re)) map.set(m[1], m[2]);
  return map;
}

/**
 * `{ line, effort, spawned, resolvedFor }` for each effort placeholder next to a literal
 * `subagent_type="gsd-…"` whose resolved agent is a different one. Dynamic spawns
 * (`subagent_type="{EXECUTOR_TYPE}"`, a hook's `ref.agent`) have no literal and are judged
 * by the pairing rules instead.
 */
function wrongAgentEffort(content, bindings = shellEffortBindings(content)) {
  const lines = content.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(EFFORT_PLACEHOLDER_RE)) {
      const effort = m[1];
      let spawned = null;
      let best = Infinity;
      for (let j = Math.max(0, i - 6); j < Math.min(lines.length, i + 7); j += 1) {
        const sm = /subagent_type[=:]\s*"(gsd-[a-z0-9-]+)"/.exec(lines[j]);
        if (sm && Math.abs(j - i) < best) { best = Math.abs(j - i); spawned = sm[1]; }
      }
      if (!spawned) continue;
      const shellAgent = bindings.get(effort);
      const resolvedFor = shellAgent ? [shellAgent] : (INIT_ROLE_AGENTS[effort] || []);
      if (!resolvedFor.includes(spawned)) out.push({ line: i + 1, effort, spawned, resolvedFor });
    }
  });
  return out;
}

describe('#5330 census: the effort is resolved for the agent spawned', () => {
  test('no placeholder next to a literal subagent_type is resolved for a different agent', () => {
    const findings = [];
    let checked = 0;
    const judge = (name, content) => {
      const bindings = shellEffortBindings(content);
      for (const f of wrongAgentEffort(content, bindings)) {
        findings.push(`${name}:${f.line}: {${f.effort}} is resolved for ${f.resolvedFor.join('|') || 'an unknown agent'} but spawns ${f.spawned}`);
      }
      checked += [...content.matchAll(EFFORT_PLACEHOLDER_RE)].length;
    };
    for (const fam of workflowFamilies()) judge(fam.name, fam.content);
    for (const file of listMarkdown(SHIPPED_MD_ROOTS[2])) judge(path.relative(REPO_ROOT, file), fs.readFileSync(file, 'utf8'));
    assert.ok(checked >= 70, `expected >=70 effort placeholders, found ${checked}`);
    assert.deepEqual(findings, [], `effort resolved for the wrong agent (#5330):\n  ${findings.join('\n  ')}`);
  });

  test('detector: the round-1 debug shape is caught, the corrected one is not', () => {
    const wrong = 'Agent(\n  subagent_type="gsd-debug-session-manager",\n  model="{debugger_model}",\n  {debugger_effort_arg},\n)';
    assert.equal(wrongAgentEffort(wrong).length, 1);
    assert.deepEqual(wrongAgentEffort(wrong.replace('{debugger_effort_arg}', '{debug_session_manager_effort_arg}')), []);
  });

  test('detector: a shell binding decides the agent; an unknown role is a finding', () => {
    const bound = 'X_EFFORT_ARG=$(gsd_run query resolve-model gsd-ui-checker --pick effort_arg 2>/dev/null || true)\nAgent(subagent_type="gsd-ui-checker", model="{X_MODEL}", {X_EFFORT_ARG})';
    assert.deepEqual(wrongAgentEffort(bound), []);
    assert.equal(wrongAgentEffort(bound.replace('subagent_type="gsd-ui-checker"', 'subagent_type="gsd-planner"')).length, 1);
    assert.equal(wrongAgentEffort('Agent(subagent_type="gsd-planner", {novel_role_effort_arg})').length, 1);
  });
});

describe('#5330 census detectors', () => {
  test('an unpaired site is reported, a paired one is not (both adjacency directions)', () => {
    const bare = 'Agent(\n  subagent_type="gsd-planner",\n  model="{planner_model}",\n  prompt="x"\n)';
    assert.deepEqual(unpairedSites(bare).map((u) => u.effort), ['planner_effort_arg']);
    const after = bare.replace('  model="{planner_model}",\n', '  model="{planner_model}",\n  {planner_effort_arg},\n');
    assert.deepEqual(unpairedSites(after), []);
    const before = bare.replace('  model="{planner_model}",\n', '  {planner_effort_arg},\n  model="{planner_model}",\n');
    assert.deepEqual(unpairedSites(before), []);
  });

  test('a site pairs with the effort of the agent it spawns; a hook ref.agent takes none', () => {
    const debug = 'Agent(\n  subagent_type="gsd-debug-session-manager",\n  model="{debugger_model}",\n  {debug_session_manager_effort_arg},\n)';
    assert.deepEqual(unpairedSites(debug), []);
    const hookBare = 'Agent(\n  subagent_type=research_hook.ref.agent,\n  model="{researcher_model}",\n  prompt="x"\n)';
    assert.deepEqual(unpairedSites(hookBare), []);
    const hookRole = hookBare.replace('  prompt="x"', '  {researcher_effort_arg},\n  prompt="x"');
    assert.equal(unpairedSites(hookRole).length, 1, 'a hook agent must not get another role\'s effort');
    const hookBound = 'Agent(subagent_type=ref.agent, model="{HOOK_AGENT_MODEL}", {HOOK_AGENT_EFFORT_ARG})';
    assert.deepEqual(unpairedSites(hookBound), []);
  });

  test('the bare form pairs with a bare effort name', () => {
    assert.equal(unpairedSites('spawn Agent(subagent_type="gsd-executor", model=executor_model) with').length, 1);
    assert.deepEqual(unpairedSites('spawn Agent(subagent_type="gsd-executor", model=executor_model, executor_effort_arg) with'), []);
  });

  test('a mismatched role does not pair', () => {
    const body = 'Agent(model="{planner_model}", {checker_effort_arg}, prompt="x")';
    assert.deepEqual(unpairedSites(body).map((u) => u.effort), ['planner_effort_arg']);
  });

  test('uppercase shell vars, the colon form and prose sites are in the domain', () => {
    assert.equal(unpairedSites('  model: "{CHECKER_MODEL}",').length, 1);
    assert.equal(unpairedSites('Spawn as Task with model `AUDITOR_MODEL`.').length, 1);
    assert.equal(unpairedSites('Spawn as Task with model `AUDITOR_MODEL` and `{AUDITOR_EFFORT_ARG}`.').length, 0);
    assert.equal(unpairedSites('model="haiku"').length, 0, 'a literal tier is not a resolved site');
  });

  test('detection is CRLF-safe', () => {
    const lf = 'x\n  model="{mapper_model}",\n  {mapper_effort_arg},\ny';
    assert.deepEqual(unpairedSites(lf.replace(/\n/g, '\r\n')), []);
    const unbound = 'Agent(\n  {mapper_effort_arg},\n)';
    assert.deepEqual(unboundEffortPlaceholders(unbound.replace(/\n/g, '\r\n')), ['mapper_effort_arg']);
  });

  test('a placeholder is bound by a parse line, a bullet or a shell assignment, and only then', () => {
    const use = '\nAgent({X_EFFORT_ARG}, {x_effort_arg})\n';
    assert.deepEqual(unboundEffortPlaceholders(use).sort(), ['X_EFFORT_ARG', 'x_effort_arg']);
    assert.deepEqual(unboundEffortPlaceholders('Parse JSON for: `x_effort_arg`\n' + 'X_EFFORT_ARG=$(gsd_run q)' + use), []);
    assert.deepEqual(unboundEffortPlaceholders('- `x_effort_arg` — the arg\n- `X_EFFORT_ARG` — the arg' + use), []);
  });
});

// ---------------------------------------------------------------------------
// Hosts whose dispatch primitive is projected from `Agent(...)` (Hermes
// `delegate_task`, Pi `gsd_dispatch`) have no per-call effort parameter, so the
// projection removes the placeholder the way it removes `model=`.
// ---------------------------------------------------------------------------

describe('#5330 dispatch projection strips the effort placeholder (Hermes, Pi)', () => {
  const installBin = require('../bin/install.js');
  const { runMinimalInstall } = require('./helpers/install-shared.cjs');
  const DISPATCH = { namedDispatch: false, nested: false, maxDepth: 0, background: false };
  const configs = {
    pi: () => Object.assign({}, installBin.PI_DISPATCH_TOOL_CONFIG, { availableRoles: new Set(['gsd-planner']), runtime: 'pi' }),
    hermes: () => Object.assign({}, installBin.HERMES_DISPATCH_TOOL_CONFIG, { availableRoles: new Set(['gsd-planner']), runtime: 'hermes' }),
  };
  const project = (src, cfg) => installBin.projectNamedDispatchToStructuralDelegate(src, DISPATCH, cfg);

  for (const [name, cfg] of Object.entries(configs)) {
    test(`${name}: own-line, inline-middle and inline-last placeholders are removed with their commas`, () => {
      const ownLine = 'Agent(\n  prompt="do it",\n  subagent_type="gsd-planner",\n  model="{planner_model}",\n  {planner_effort_arg},\n  description="d"\n)';
      const middle = 'Agent(subagent_type="gsd-planner", model="{planner_model}", {planner_effort_arg}, prompt="x")';
      const last = 'Agent(prompt="x", subagent_type="gsd-planner", model="{planner_model}", {planner_effort_arg})';
      const without = (src) => src.replace(/\n {2}\{planner_effort_arg\},/, '').replace(/, \{planner_effort_arg\}/, '');
      for (const src of [ownLine, middle, last]) {
        const out = project(src, cfg());
        assert.doesNotMatch(out, /effort_arg/, out);
        // The placeholder leaves no trace: identical to projecting the call without it.
        assert.equal(out, project(without(src), cfg()));
      }
    });

    test(`${name}: the prose form "and \`{x}\` (omitted when empty)" is removed`, () => {
      const out = project('Use Agent with `model="{mapper_model}"` and `{mapper_effort_arg}` (omitted when empty), and more.', cfg());
      assert.doesNotMatch(out, /effort_arg/);
    });
  }

  test('a placeholder inside a quoted value or a comment is text: kept, and no refusal', () => {
    for (const cfg of Object.values(configs)) {
      const quoted = project('Agent(subagent_type="gsd-planner", prompt="pass {planner_effort_arg} on")', cfg());
      assert.match(quoted, /prompt="pass \{planner_effort_arg\} on"|task="pass \{planner_effort_arg\} on"/);
      const commented = project('Agent(\n  subagent_type="gsd-planner",\n  # {planner_effort_arg} is empty off Claude\n  prompt="x"\n)', cfg());
      assert.match(commented, /# \{planner_effort_arg\} is empty off Claude/);
    }
  });

  test('negative control: a host that declares a per-call effort parameter keeps the placeholder', () => {
    const cfg = Object.assign(configs.pi(), { supportsPerCallEffort: true });
    const out = project('Agent(subagent_type="gsd-planner", model="{planner_model}", {planner_effort_arg}, prompt="x")', cfg);
    assert.match(out, /\{planner_effort_arg\}/);
  });

  for (const runtime of ['hermes', 'pi']) {
    test(`${runtime}: a real global install leaves no effort placeholder in any installed workflow`, (t) => {
      // Workflows are where Agent(...) is projected onto the host primitive. Installed agent
      // files keep their Agent(...) text, model= included, so they are out of this assertion.
      const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
      t.after(() => cleanup(root));
      const hits = [];
      let scanned = 0;
      for (const file of listMarkdown(path.join(configDir, 'gsd-core', 'workflows'))) {
        scanned += 1;
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(EFFORT_PLACEHOLDER_RE)) hits.push(`${path.relative(configDir, file)}: ${m[0]}`);
      }
      assert.ok(scanned >= 40, `vacuous: scanned ${scanned} installed markdown files`);
      assert.deepEqual(hits, []);
    });
  }
});
