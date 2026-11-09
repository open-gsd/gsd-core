'use strict';
const { test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { escalationAllows } = require('../gsd-core/bin/lib/model-escalation.cjs');

test('property: a record counts for a dispatch iff either side has no session or both carry the same one', () => {
  fc.assert(fc.property(fc.constantFrom(undefined, 's1', 's2', ''), fc.constantFrom(undefined, 's1', 's2', ''), (recSession, session) => {
    const rec = { model: 'opus', written_at: 0, ...(recSession === undefined ? {} : { session: recSession }) };
    return escalationAllows(rec, 'opus', { now: 0, session }) === (session === undefined || recSession === undefined || recSession === session);
  }));
});

test('property: modelFamily maps any id carrying a catalog tier name as a token to that tier, and anything else to its lower-cased id', () => {
  const { modelFamily } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { CLAUDE_AGENT_ALIASES } = require('../gsd-core/bin/lib/model-catalog.cjs');
  const tiers = fc.constantFrom(...CLAUDE_AGENT_ALIASES);
  const pre = fc.constantFrom('', '-', '.', '_', ' ', '/', ':', '9-', 'claude-', 'anthropic/claude-', 'us.anthropic.claude-');
  const post = fc.constantFrom('', '-4-6', '-4-5-20250929', '@20250805', '4', '45', '.1', '_x', ' 2', '[1m]');
  fc.assert(fc.property(tiers, pre, post, fc.boolean(), (tier, l, r, upper) => {
    const name = `${l}${tier}${r}`;
    return modelFamily(upper ? name.toUpperCase() : name) === tier;
  }));
  fc.assert(fc.property(tiers, fc.constantFrom('a', 'z', 'x'), fc.boolean(), (tier, ch, before) => {
    const name = before ? `${ch}${tier}` : `${tier}${ch}`;
    return modelFamily(name) === name;
  }));
  fc.assert(fc.property(fc.constantFrom('gpt-5', 'o3', 'gemini-2.5-pro', 'xopus', 'sonnetx', '9opus'), (id) => modelFamily(id) === id));
});

test('property: writeEscalation leaves .gsd/.gitignore exactly as the one owner (ensureToolOwnedGsdDir) merges it, once; an absent file becomes *', (t) => {
  const { writeEscalation } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const marker = '# gsd-core model guard';
  const dir = createTempDir('gsd-esc-ignore-');
  const { ignoreAdditions } = require('../gsd-core/bin/lib/gsd-tool-dir.cjs');
  const rules = ['/model-escalation-*', '/.gitignore', '/.gitignore.tmp-*'];
  t.after(() => cleanup(dir));
  const file = path.join(dir, '.gsd', '.gitignore');
  writeEscalation(dir, 'gsd-executor', 'opus');
  if (fs.readFileSync(file, 'utf8') !== '*\n') throw new Error('an absent .gitignore must become *');
  const line = fc.constantFrom('*', '* ', '!*', 'a*', '/x', '', marker, '# gsd-core dispatch sentinel');
  fc.assert(fc.property(fc.array(line, { maxLength: 4 }), fc.constantFrom('\n', '\r\n'), fc.boolean(), (lines, eol, trailing) => {
    const before = lines.join(eol) + (trailing && lines.length ? eol : '');
    fs.writeFileSync(file, before);
    writeEscalation(dir, 'gsd-executor', 'opus');
    const once = fs.readFileSync(file, 'utf8');
    writeEscalation(dir, 'gsd-executor', 'opus');
    const want = before + ignoreAdditions(before, { marker, rules });
    return once === want && fs.readFileSync(file, 'utf8') === once;
  }));
});

test('property: escalationRoot resolves a directory at any depth inside a project to the root resolveSentinelRoot gives the hook', (t) => {
  const { escalationRoot } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { resolveSentinelRoot } = require('../hooks/lib/isolation-sentinel.js');
  const { createFixture } = require('./fixtures/index.cjs');
  const project = createFixture({ prefix: 'gsd-esc-root-', planning: true, git: true, projectDoc: false });
  t.after(() => cleanup(project));
  const root = escalationRoot(project);
  fc.assert(fc.property(fc.array(fc.constantFrom('a', 'b', 'c.d'), { maxLength: 3 }), (segs) => {
    const dir = path.join(project, ...segs);
    fs.mkdirSync(dir, { recursive: true });
    return escalationRoot(dir) === root && resolveSentinelRoot(dir) === root;
  }));
});

test('property: the CLI pin accept regex is exactly "alphanumeric first, then MODEL_ID_CHARSET_BODY" from the owner', () => {
  const { MODEL_ID_CHARSET_BODY } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { MODEL_ID_CHARSET_RE } = require('../gsd-core/bin/gsd-tools.cjs');
  const body = new RegExp(`^[${MODEL_ID_CHARSET_BODY}]*$`);
  fc.assert(fc.property(fc.string({ unit: 'binary-ascii', maxLength: 12 }), (id) =>
    MODEL_ID_CHARSET_RE.test(id) === (/^[A-Za-z0-9]/.test(id) && body.test(id))));
});

test('property: the init --ws carry round-trips a valid name per session, other sessions and an absent session read null, invalid names are never kept', (t) => {
  const store = require('../gsd-core/bin/lib/active-workstream-store.cjs');
  const { INIT_WORKSTREAM_MAX_AGE_MS: W } = store;
  const T = 1_000_000;
  const project = createTempDir('gsd-esc-carry-');
  const base = 'a'.repeat(159);
  const clearAll = () => { for (const s of ['s1', 's2', base, `${base}b`]) store.createSessionScopedPointerAdapter(project, `${store.INIT_WORKSTREAM_KEY_PREFIX}${s}`).clear(); };
  t.after(() => { clearAll(); cleanup(project); });
  fc.assert(fc.property(
    fc.constantFrom('alpha', 'b-2', 'c_3', 'd.4', '../x', 'a b', ''), fc.constantFrom('s1', 's2', undefined, ''),
    (name, session) => {
      clearAll();
      const recorded = store.recordInitWorkstream(project, session, name, T);
      const kept = Boolean(session) && store.validateWorkstreamName(name);
      const other = session === 's1' ? 's2' : 's1';
      const seen = (s) => JSON.stringify(store.peekInitWorkstream(project, s, T));
      return recorded === kept && seen(session) === JSON.stringify(kept ? [name] : null) && seen(other) === 'null';
    },
  ));
  clearAll();
  store.recordInitWorkstream(project, base, 'alpha', T);
  if (store.peekInitWorkstream(project, `${base}b`, T) !== null) throw new Error('159 chars must not read as 160');
  clearAll();
  store.recordInitWorkstream(project, `${base}b`, 'alpha', T);
  if (JSON.stringify(store.peekInitWorkstream(project, `${base}bc`, T)) !== '["alpha"]') throw new Error('161 chars cut to the 160-char token');
  clearAll();
  store.recordInitWorkstream(project, 's1', 'alpha', T);
  const at = (now) => JSON.stringify(store.peekInitWorkstream(project, 's1', now));
  if (at(T + W - 1) !== '["alpha"]' || at(T + W) !== '[]' || at(T + W + 1) !== '[]') throw new Error('a carry counts for W ms');
  store.recordInitWorkstream(project, 's1', 'alpha', T + W - 1);
  if (at(T + W + 1) !== '["alpha"]') throw new Error('a new record refreshes the carry');
});

test('recordInitWorkstream prunes this project\'s expired carries', (t) => {
  const store = require('../gsd-core/bin/lib/active-workstream-store.cjs');
  const { INIT_WORKSTREAM_PRUNE_AGE_MS: P } = store;
  const T = 1_000_000;
  const project = createTempDir('gsd-esc-prune-');
  const raw = (s) => store.createSessionScopedPointerAdapter(project, `${store.INIT_WORKSTREAM_KEY_PREFIX}${s}`);
  t.after(() => {
    for (const s of ['s1', 's2']) raw(s).clear();
    cleanup(project);
  });
  store.recordInitWorkstream(project, 's1', 'alpha', T);
  store.recordInitWorkstream(project, 's2', 'beta', T + P);
  if (raw('s1').read() !== null) throw new Error('the expired s1 carry stays');
  if (JSON.stringify(store.peekInitWorkstream(project, 's2', T + P)) !== '["beta"]') throw new Error('the s2 carry is lost');
});

test('guardApplies: false when the guard is off, the root config is unreadable, or the runtime has no native tier aliases; true for warn and deny on claude', (t) => {
  const { guardApplies } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const saved = process.env.GSD_RUNTIME;
  delete process.env.GSD_RUNTIME;
  const root = createTempDir('gsd-esc-applies-');
  t.after(() => {
    if (saved === undefined) delete process.env.GSD_RUNTIME; else process.env.GSD_RUNTIME = saved;
    cleanup(root);
  });
  const config = path.join(root, '.planning', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const at = (text) => { fs.writeFileSync(config, text); return guardApplies(root); };
  const rows = [
    [JSON.stringify({ runtime: 'claude' }), true],
    [JSON.stringify({ runtime: 'claude', hooks: { agent_model_guard: 'deny' } }), true],
    [JSON.stringify({ runtime: 'claude', hooks: { agent_model_guard: false } }), false],
    [JSON.stringify({ runtime: 'codex' }), false],
    ['{not json', false],
  ];
  for (const [text, want] of rows) {
    if (at(text) !== want) throw new Error(`guardApplies(${text}) must be ${want}`);
  }
});

test('property: readGuardMode gives skip for an absent, unparseable or over-cap root config, else hooks.agent_model_guard', (t) => {
  const { readGuardMode } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { CONFIG_MAX_BYTES } = require('../gsd-core/bin/lib/config-file-read.cjs');
  const root = createTempDir('gsd-esc-mode-');
  const config = path.join(root, '.planning', 'config.json');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.dirname(config), { recursive: true });
  if (JSON.stringify(readGuardMode(root)) !== '{"skip":true}') throw new Error('an absent config skips');
  fc.assert(fc.property(fc.constantFrom('warn', 'deny', false, true, 'off', undefined), fc.constantFrom(0, CONFIG_MAX_BYTES - 1, CONFIG_MAX_BYTES, CONFIG_MAX_BYTES + 1), (mode, size) => {
    const body = JSON.stringify({ hooks: { agent_model_guard: mode } });
    fs.writeFileSync(config, size ? body + ' '.repeat(Math.max(0, size - body.length)) : body);
    const got = readGuardMode(root);
    return size > CONFIG_MAX_BYTES ? got.skip === true : got.skip === undefined && got.mode === mode;
  }));
  fs.writeFileSync(config, '{not json');
  if (readGuardMode(root).skip !== true) throw new Error('unparseable skips');
});

test('modelFamily escapes catalog tier names', (t) => {
  const { CLAUDE_AGENT_ALIASES } = require('../gsd-core/bin/lib/model-catalog.cjs');
  const mod = require.resolve('../gsd-core/bin/lib/model-escalation.cjs');
  t.after(() => {
    CLAUDE_AGENT_ALIASES.delete('o.us');
    delete require.cache[mod];
  });
  CLAUDE_AGENT_ALIASES.add('o.us');
  delete require.cache[mod];
  const { modelFamily } = require(mod);
  if (modelFamily('claude-o.us-1') !== 'o.us') throw new Error('the tier name matches literally');
  if (modelFamily('claude-oxus-1') !== 'claude-oxus-1') throw new Error('a . in a tier name is not a wildcard');
});

test('escalationRoot degrades to the raw cwd on a resolution error, as resolveSentinelRoot does', (t) => {
  t.mock.method(require('../gsd-core/bin/lib/project-context.cjs'), 'resolveProjectContext', () => { throw new Error('git unavailable'); });
  const { escalationRoot } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { resolveSentinelRoot } = require('../hooks/lib/isolation-sentinel.js');
  const dir = createTempDir('gsd-esc-degrade-');
  t.after(() => cleanup(dir));
  if (escalationRoot(dir) !== dir || resolveSentinelRoot(dir) !== dir) throw new Error('both degrade to the cwd');
});
