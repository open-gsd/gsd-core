'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
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
  assert.equal(fs.readFileSync(file, 'utf8'), '*\n', 'an absent .gitignore must become *');
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
  const { MODEL_ID_CHARSET_BODY } = require('../gsd-core/bin/lib/model-catalog.cjs');
  const { MODEL_ID_CHARSET_RE } = require('../gsd-core/bin/gsd-tools.cjs');
  const body = new RegExp(`^[${MODEL_ID_CHARSET_BODY}]*$`);
  fc.assert(fc.property(fc.string({ unit: 'binary-ascii', maxLength: 12 }), (id) =>
    MODEL_ID_CHARSET_RE.test(id) === (/^[A-Za-z0-9]/.test(id) && body.test(id))));
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
    assert.equal(at(text), want, `guardApplies(${text})`);
  }
});

test('property: readGuardMode gives skip for an absent, unparseable or over-cap root config, else hooks.agent_model_guard', (t) => {
  const { readGuardMode } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { CONFIG_MAX_BYTES } = require('../gsd-core/bin/lib/config-file-read.cjs');
  const root = createTempDir('gsd-esc-mode-');
  const config = path.join(root, '.planning', 'config.json');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.dirname(config), { recursive: true });
  assert.deepEqual(readGuardMode(root), { skip: true }, 'an absent config skips');
  fc.assert(fc.property(fc.constantFrom('warn', 'deny', false, true, 'off', undefined), fc.constantFrom(0, CONFIG_MAX_BYTES - 1, CONFIG_MAX_BYTES, CONFIG_MAX_BYTES + 1), (mode, size) => {
    const body = JSON.stringify({ hooks: { agent_model_guard: mode } });
    fs.writeFileSync(config, size ? body + ' '.repeat(Math.max(0, size - body.length)) : body);
    const got = readGuardMode(root);
    return size > CONFIG_MAX_BYTES ? got.skip === true : got.skip === undefined && got.mode === mode;
  }));
  fs.writeFileSync(config, '{not json');
  assert.equal(readGuardMode(root).skip, true, 'unparseable skips');
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
  assert.equal(modelFamily('claude-o.us-1'), 'o.us', 'the tier name matches literally');
  assert.equal(modelFamily('claude-oxus-1'), 'claude-oxus-1', 'a . in a tier name is not a wildcard');
});

test('escalationRoot degrades to the raw cwd on a resolution error, as resolveSentinelRoot does', (t) => {
  const mock = t.mock.method(require('../gsd-core/bin/lib/project-context.cjs'), 'resolveProjectContext', () => { throw new Error('git unavailable'); });
  const { escalationRoot } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { resolveSentinelRoot } = require('../hooks/lib/isolation-sentinel.js');
  const root = createTempDir('gsd-esc-degrade-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, '.planning'));
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  assert.equal(escalationRoot(sub), sub, 'escalationRoot degrades to the cwd');
  assert.equal(resolveSentinelRoot(sub), sub, 'resolveSentinelRoot degrades to the cwd');
  assert.ok(mock.mock.callCount() > 0, 'the degrade branch ran');
  mock.mock.restore();
  assert.notEqual(escalationRoot(sub), sub, 'positive control: without the error the project root wins');
});

test('property: both guard warnings print one line whatever the workstream name, reason or model holds', () => {
  const { formatNotWritten, formatNotRecorded } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const broken = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  // the class's boundary characters: line separators, NEL, bidi override, zero-width space, NUL
  const boundary = ['\u2028', '\u2029', '\u0085', '\u202e', '\u200b', '\0'];
  const text = fc.oneof(fc.string({ unit: 'binary', maxLength: 200 }), fc.array(fc.constantFrom(...boundary, 'a'), { maxLength: 40 }).map((cs) => cs.join('')));
  fc.assert(fc.property(text, text, (a, b) => {
    return [formatNotRecorded(a), formatNotRecorded(a, b), formatNotWritten(a, b)].every((line) => !broken.test(line));
  }), { examples: boundary.map((c) => [`a${c}b`, `a${c}b`]) });
});
