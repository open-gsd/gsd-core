'use strict';

// #6027 — ADR-4630 Phase 3: the dispatch-identity / dispatch-isolation drift
// lint. Every row drives the lint over a temp-dir fixture tree (or text) and
// asserts on the findings it returns; nothing here reads the lint's or the
// hooks' own source text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  findTemplateDrift,
  findParserDrift,
  findProducerSites,
  scanDispatchIdentityDrift,
} = require('../scripts/lint-dispatch-identity-drift.cjs');
const owner = require('../hooks/lib/dispatch-identity.js');

const REPO = path.join(__dirname, '..');
const LINT = path.join(REPO, 'scripts', 'lint-dispatch-identity-drift.cjs');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'did-drift-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

const PRODUCER = 'gsd_run query dispatch-isolation --raw --force-isolation none >/dev/null 2>&1 || true';

test('owner exports the parse sources the lint compares against, and they rebuild the owner regexes', () => {
  const s = owner.DISPATCH_PARSE_SOURCES;
  assert.ok(Object.isFrozen(s), 'frozen');
  assert.equal(typeof s.marker, 'string');
  assert.equal(typeof s.prose, 'string');
  // allow-adhoc-regex-escape: the sources are the owner's own regex sources, already regex syntax
  const marker = new RegExp(s.marker, s.markerFlags);
  assert.deepEqual(owner.parseDispatchIdentity('[gsd:dispatch phase="01" plan="01-02"]'), { phase: '01', plan: '01-02', source: 'marker' });
  assert.match('[gsd:dispatch phase="01"]', marker);
  // allow-adhoc-regex-escape: the sources are the owner's own regex sources, already regex syntax
  const prose = new RegExp(s.prose, s.proseFlags);
  assert.match('Execute plan 02 of phase 01-auth.', prose);
});

test('templates: the marker the owner renders passes, in every key combination and with CRLF', () => {
  const both = owner.renderDispatchIdentityMarker({ phase: '{phase_number}', plan: '{plan_id}' });
  const phaseOnly = owner.renderDispatchIdentityMarker({ phase: '{phase_number}' });
  const planOnly = owner.renderDispatchIdentityMarker({ plan: '{plan_id}' });
  const text = ['x', `  ${both}`, `${phaseOnly} and ${planOnly}`, ''].join('\r\n');
  assert.deepEqual(findTemplateDrift(text), []);
});

test('templates: near-miss spellings fail with the line number', () => {
  for (const bad of [
    '[gsd-dispatch phase="1" plan="2"]',
    '[gsd dispatch phase="1" plan="2"]',
    '[gsd:dispatch plan="2" phase="1"]',
    '[gsd:dispatch phase=\'1\' plan=\'2\']',
    '[gsd:dispatch phase="1" plan="2" run="3"]',
    '[gsd:dispatch phase="1" plan="2"',
  ]) {
    const found = findTemplateDrift(`ok line\n${bad}\n`);
    assert.equal(found.length, 1, bad);
    assert.equal(found[0].kind, 'template-drift');
    assert.equal(found[0].line, 2);
  }
});

test('parsers: a verbatim copy of the owner prose regex is drift and says so', () => {
  const copy = `const RE = new RegExp(${JSON.stringify(owner.DISPATCH_PARSE_SOURCES.prose)}, 'i');`;
  const found = findParserDrift(`${copy}\n`, owner.DISPATCH_PARSE_SOURCES);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'parser-drift');
  assert.equal(found[0].variant, 'verbatim-copy');
});

test('parsers: the #4594 greedy prose parser is drift (divergent parser)', () => {
  const found = findParserDrift('const m = /execute\\s+plan\\s+\\S+\\s+of\\s+phase\\s+(\\S+)/i.exec(text);\n', owner.DISPATCH_PARSE_SOURCES);
  assert.equal(found.length, 1);
  assert.equal(found[0].variant, 'divergent-parser');
});

test('parsers: a hook regex naming the marker is drift too', () => {
  const found = findParserDrift('const m = /\\[gsd:dispatch phase="([^"]+)"/.exec(t);\n', owner.DISPATCH_PARSE_SOURCES);
  assert.equal(found.length, 1);
});

test('parsers: a dedicated sanction line directly above exempts the regex', () => {
  const text = [
    '// dispatch-identity-owner: the cold-load mirror, pinned by the parity test',
    'const m = /execute\\s+plan\\s+\\S+\\s+of\\s+phase\\s+(\\S+)/i;',
  ].join('\n');
  assert.deepEqual(findParserDrift(text, owner.DISPATCH_PARSE_SOURCES), []);
});

test('parsers: a line-level escape does not exempt (same-line sanction, or a call to the owner on the line)', () => {
  const sameLine = 'const m = /execute\\s+plan\\s+\\S+\\s+of\\s+phase\\s+(\\S+)/i; // dispatch-identity-owner: because';
  assert.equal(findParserDrift(sameLine, owner.DISPATCH_PARSE_SOURCES).length, 1);
  const callsOwner = 'const m = parseDispatchIdentity(t) || /execute\\s+plan\\s+\\S+\\s+of\\s+phase\\s+(\\S+)/i.exec(t);';
  assert.equal(findParserDrift(callsOwner, owner.DISPATCH_PARSE_SOURCES).length, 1);
});

test('producers: only a command line is a site; prose naming the flag is not', () => {
  assert.deepEqual(findProducerSites('`--force-isolation` pushes the final value through the write path.\n'), []);
  const found = findProducerSites(`text\n  ${PRODUCER}\n`);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
  assert.equal(found[0].sanctioned, false);
});

test('producers: a dedicated site-sanction comment above marks the site sanctioned', () => {
  const found = findProducerSites(`<!-- dispatch-isolation-site: documentation example, not a producer -->\n${PRODUCER}\n`);
  assert.equal(found.length, 1);
  assert.equal(found[0].sanctioned, true);
});

test('scan: a ninth hand-written producer site fails as unlisted', () => {
  const root = fixture({
    'gsd-core/workflows/a.md': `${PRODUCER}\n`,
    'gsd-core/workflows/b.md': `${PRODUCER}\n`,
  });
  const findings = scanDispatchIdentityDrift({ root, membership: ['gsd-core/workflows/a.md'] });
  assert.deepEqual(findings.map((f) => [f.kind, f.file]), [['unlisted-producer-site', 'gsd-core/workflows/b.md']]);
});

test('scan: a membership entry with no producer left is stale', () => {
  const root = fixture({ 'gsd-core/workflows/a.md': 'no producer here\n' });
  const findings = scanDispatchIdentityDrift({ root, membership: ['gsd-core/workflows/a.md'] });
  assert.deepEqual(findings.map((f) => f.kind), ['stale-membership-entry']);
});

test('scan: template drift in a reference and parser drift in a hook are both reported; the owner file is not scanned', () => {
  const root = fixture({
    'gsd-core/references/r.md': '[gsd-dispatch phase="1"]\n',
    'hooks/g.js': 'const m = /execute\\s+plan\\s+\\S+\\s+of\\s+phase\\s+(\\S+)/i;\n',
    'hooks/lib/dispatch-identity.js': 'const m = /execute\\s+plan\\s+\\S+\\s+of\\s+phase\\s+(\\S+)/i;\n',
  });
  const findings = scanDispatchIdentityDrift({ root, membership: [] });
  assert.deepEqual(findings.map((f) => [f.kind, f.file]).sort(), [
    ['parser-drift', 'hooks/g.js'],
    ['template-drift', 'gsd-core/references/r.md'],
  ]);
});

test('scan: a missing scan root degrades to no findings without throwing', () => {
  const root = fixture({ 'unrelated.txt': 'x' });
  assert.deepEqual(scanDispatchIdentityDrift({ root, membership: [] }), []);
});

test('the real tree is clean: the lint exits 0 with no args (the shape lint:ci uses)', () => {
  const r = spawnSync(process.execPath, [LINT], { cwd: REPO, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok dispatch-identity-drift/);
});

test('the CLI exits 1 and names each finding on a drifted root', () => {
  const root = fixture({ 'gsd-core/workflows/a.md': `${PRODUCER}\n[gsd-dispatch phase="1"]\n` });
  const r = spawnSync(process.execPath, [LINT, '--root', root], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /template-drift/);
  assert.match(r.stderr, /unlisted-producer-site/);
});
