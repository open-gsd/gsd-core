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

test('property: writeEscalation keeps a .gitignore with a bare * or its marker, else appends marker and rules once; an absent file becomes *', () => {
  const { writeEscalation } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const marker = '# gsd-core model guard';
  const dir = createTempDir('gsd-esc-ignore-');
  try {
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
      const covered = /^\*\r?$/m.test(before) || before.includes(marker);
      const want = covered ? before : `${before}${before.endsWith('\n') ? '' : '\n'}${marker}\n/model-escalation-*\n/.gitignore.tmp-*\n`;
      return once === want && fs.readFileSync(file, 'utf8') === once;
    }));
  } finally {
    cleanup(dir);
  }
});

test('property: escalationRoot resolves a directory at any depth inside a project to the root resolveSentinelRoot gives the hook', () => {
  const { escalationRoot } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { resolveSentinelRoot } = require('../hooks/lib/isolation-sentinel.js');
  const { createFixture } = require('./fixtures/index.cjs');
  const project = createFixture({ prefix: 'gsd-esc-root-', planning: true, git: true, projectDoc: false });
  try {
    const root = escalationRoot(project);
    fc.assert(fc.property(fc.array(fc.constantFrom('a', 'b', 'c.d'), { maxLength: 3 }), (segs) => {
      const dir = path.join(project, ...segs);
      fs.mkdirSync(dir, { recursive: true });
      return escalationRoot(dir) === root && resolveSentinelRoot(dir) === root;
    }));
  } finally {
    cleanup(project);
  }
});

test('property: the CLI pin accept regex is exactly "alphanumeric first, then MODEL_ID_CHARSET_BODY" from the owner', () => {
  const { MODEL_ID_CHARSET_BODY } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { MODEL_ID_CHARSET_RE } = require('../gsd-core/bin/gsd-tools.cjs');
  const body = new RegExp(`^[${MODEL_ID_CHARSET_BODY}]*$`);
  fc.assert(fc.property(fc.string({ unit: 'binary-ascii', maxLength: 12 }), (id) =>
    MODEL_ID_CHARSET_RE.test(id) === (/^[A-Za-z0-9]/.test(id) && body.test(id))));
});

test('property: readGuardMode gives skip for an absent, unparseable or over-cap root config, else hooks.agent_model_guard', () => {
  const { readGuardMode, MAX_READ_BYTES } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const root = createTempDir('gsd-esc-mode-');
  const config = path.join(root, '.planning', 'config.json');
  try {
    fs.mkdirSync(path.dirname(config), { recursive: true });
    if (JSON.stringify(readGuardMode(root)) !== '{"skip":true}') throw new Error('an absent config skips');
    fc.assert(fc.property(fc.constantFrom('warn', 'deny', false, true, 'off', undefined), fc.constantFrom(0, MAX_READ_BYTES - 1, MAX_READ_BYTES, MAX_READ_BYTES + 1), (mode, size) => {
      const body = JSON.stringify({ hooks: { agent_model_guard: mode } });
      fs.writeFileSync(config, size ? body + ' '.repeat(Math.max(0, size - body.length)) : body);
      const got = readGuardMode(root);
      return size > MAX_READ_BYTES ? got.skip === true : got.skip === undefined && got.mode === mode;
    }));
    fs.writeFileSync(config, '{not json');
    if (readGuardMode(root).skip !== true) throw new Error('unparseable skips');
  } finally {
    cleanup(root);
  }
});

test('modelFamily escapes catalog tier names', () => {
  const { CLAUDE_AGENT_ALIASES } = require('../gsd-core/bin/lib/model-catalog.cjs');
  const mod = require.resolve('../gsd-core/bin/lib/model-escalation.cjs');
  CLAUDE_AGENT_ALIASES.add('o.us');
  delete require.cache[mod];
  try {
    const { modelFamily } = require(mod);
    if (modelFamily('claude-o.us-1') !== 'o.us') throw new Error('the tier name matches literally');
    if (modelFamily('claude-oxus-1') !== 'claude-oxus-1') throw new Error('a . in a tier name is not a wildcard');
  } finally {
    CLAUDE_AGENT_ALIASES.delete('o.us');
    delete require.cache[mod];
  }
});

