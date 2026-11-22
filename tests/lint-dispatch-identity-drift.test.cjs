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
const fc = require('fast-check');
const { runNode } = require('./helpers/process-seam.cjs');

const {
  findTemplateDrift,
  findParserDrift,
  findProducerSites,
  scanDispatchIdentityDrift,
} = require('../scripts/lint-dispatch-identity-drift.cjs');
const owner = require('../hooks/lib/dispatch-identity.js');

const REPO = path.join(__dirname, '..');
const LINT = path.join(REPO, 'scripts', 'lint-dispatch-identity-drift.cjs');

// The minimal tree the lint expects: both markdown roots and the hook owner.
// `bare: true` leaves it out, to test a missing scan root.
const SKELETON = {
  'gsd-core/workflows/_.md': 'x\n',
  'gsd-core/references/_.md': 'x\n',
  'hooks/lib/dispatch-identity.js': '// owner\n',
};

function fixture(files, { bare = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'did-drift-'));
  for (const [rel, text] of Object.entries({ ...(bare ? {} : SKELETON), ...files })) {
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

test('scan: a missing scan root is a finding, not a silent pass, and never throws', () => {
  const root = fixture({ 'unrelated.txt': 'x' }, { bare: true });
  const findings = scanDispatchIdentityDrift({ root, membership: [] });
  assert.deepEqual(
    findings.map((f) => [f.kind, f.file]).sort(),
    [
      ['scan-root-missing', 'gsd-core/references'],
      ['scan-root-missing', 'gsd-core/workflows'],
      ['scan-root-missing', 'hooks'],
    ],
  );
});

test('scan: a build copy of the hooks under hooks/dist is not a second parser', () => {
  const copy = 'const R = new RegExp("\\\\[gsd:dispatch", "g");\n';
  const root = fixture({ 'hooks/dist/lib/dispatch-identity.js': copy, 'hooks/dist/g.js': copy });
  assert.deepEqual(scanDispatchIdentityDrift({ root, membership: [] }), []);
});

test('scan: a hooks tree without the owner file is a finding', () => {
  const root = fixture({ 'hooks/g.js': 'const x = 1;\n' }, { bare: true });
  for (const dir of ['gsd-core/workflows', 'gsd-core/references']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const findings = scanDispatchIdentityDrift({ root, membership: [] });
  assert.deepEqual(findings.map((f) => [f.kind, f.file]), [['scan-root-missing', 'hooks/lib/dispatch-identity.js']]);
});

test('producers: every wrapper or runner around the command is still a site', () => {
  for (const line of [
    'R=$(gsd-tools query dispatch-isolation --force-isolation x)',
    'ISO="$(gsd_run query dispatch-isolation --force-isolation x)"',
    'if ! ISO=$(gsd_run query dispatch-isolation --force-isolation x); then',
    'export ISO=$(gsd_run query dispatch-isolation --force-isolation x)',
    'cd x && gsd_run query dispatch-isolation --force-isolation x',
    '>/dev/null gsd_run query dispatch-isolation --force-isolation x',
    'node gsd-tools.cjs query dispatch-isolation --force-isolation x',
  ]) {
    assert.equal(findProducerSites(`${line}\n`).length, 1, line);
  }
});

test('producers: a backslash continuation joins the flag; prose in backticks and shell comments are not sites', () => {
  assert.equal(findProducerSites('gsd_run query dispatch-isolation --raw \\\n  --force-isolation none\n').length, 1);
  assert.equal(findProducerSites('Run `gsd_run query dispatch-isolation --force-isolation none` to record it.\n').length, 0);
  assert.equal(findProducerSites('# gsd_run query dispatch-isolation --force-isolation none\n').length, 0);
});

test('producers: the site sanction is one comment, not a line holding two', () => {
  const two = `<!-- a --> text <!-- dispatch-isolation-site: reason -->\n${PRODUCER}\n`;
  assert.equal(findProducerSites(two)[0].sanctioned, false);
});

test('parsers: a regex built from fragments, a literal-space frame, or a multi-line RegExp call is still drift', () => {
  for (const code of [
    "const A = 'gsd:dispatch'; const r = new RegExp(A + '\\\\s+phase');",
    "const r = new RegExp('\\\\[gsd:' + 'dispatch');",
    'const r = /execute plan (\\d+)/;',
    'const r = /execute[ ]plan/;',
    "const r = new RegExp(\n  '\\\\[gsd:dispatch phase'\n);",
  ]) {
    const found = findParserDrift(`${code}\n`, owner.DISPATCH_PARSE_SOURCES);
    assert.equal(found.length, 1, code);
    assert.equal(found[0].kind, 'parser-drift');
  }
});

test('parsers: comments naming the marker are not drift, and the owner source with other flags is named as such', () => {
  assert.deepEqual(findParserDrift('// the marker is [gsd:dispatch phase="1"]\n/* of phase and execute plan */\n', owner.DISPATCH_PARSE_SOURCES), []);
  const s = owner.DISPATCH_PARSE_SOURCES;
  const found = findParserDrift(`const r = new RegExp(${JSON.stringify(s.prose)}, 'g');\n`, s);
  assert.equal(found[0].variant, 'verbatim-source-other-flags');
  const same = findParserDrift(`const r = new RegExp(${JSON.stringify(s.prose)}, ${JSON.stringify(s.proseFlags)});\n`, s);
  assert.equal(same[0].variant, 'verbatim-copy');
});

test('templates: a marker whose word is assembled by a format placeholder is drift', () => {
  assert.equal(findTemplateDrift('printf "[gsd:%s phase=%s plan=%s]" dispatch 1 2\n').length, 1);
  assert.equal(findTemplateDrift('echo "[gsd:${WORD} phase=1]"\n').length, 1);
});

test('property: any marker the owner renders is canonical to the lint (render, then lint, is empty)', () => {
  const value = fc.stringMatching(/^[A-Za-z0-9._{}-]{1,40}$/);
  fc.assert(
    fc.property(value, value, (phase, plan) => {
      const marker = owner.renderDispatchIdentityMarker({ phase, plan });
      return findTemplateDrift(`  ${marker}\n`).length === 0;
    }),
    { seed: 6027, numRuns: 200 },
  );
});

test('the real tree is clean: the lint exits 0 with no args (the shape lint:ci uses)', () => {
  const r = runNode([LINT], { cwd: REPO });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /ok dispatch-identity-drift/);
});

test('the CLI exits 1 and names each finding on a drifted root', () => {
  const root = fixture({ 'gsd-core/workflows/a.md': `${PRODUCER}\n[gsd-dispatch phase="1"]\n` });
  const r = runNode([LINT, '--root', root]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /template-drift/);
  assert.match(r.stderr, /unlisted-producer-site/);
});
