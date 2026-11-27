'use strict';

/**
 * #6797: the `handoff-grammar-readers-registered` text contract. A file under hooks/ or src/ that parses the per-session
 * handoff filename grammar must be registered as a follower in tests/fixtures/session-handoff-cases.json; a registered
 * follower file must exist. The shipped tree passes; each rule below fails when its condition is broken.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const textContracts = require('../scripts/static-checks/text-contracts.cjs');

const ROOT = path.join(__dirname, '..');
const CONTRACT = 'handoff-grammar-readers-registered';
const PARSER = "function f(name) { return name.startsWith('HANDOFF.'); }\n";

function makeTree(t, { registry, files }) {
  const root = createTempDir('gsd-handoff-contract-');
  t.after(() => cleanup(root));
  const dir = path.join(root, 'contracts');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'static-checks', 'text-contracts', `${CONTRACT}.cjs`), path.join(dir, `${CONTRACT}.cjs`));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('tests/fixtures/session-handoff-cases.json', JSON.stringify(registry));
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  return { root, dir };
}

// A temporary tree holds just this contract, so the engine's shipped-count minimum is lowered to that one.
const messages = (tree) => textContracts.run({ ...tree, minContracts: 1 }).map((f) => f.message);

describe('handoff-grammar-readers-registered (#6797)', () => {
  test('theShippedTreePasses: every reader of the grammar in the real repo is registered', () => {
    assert.deepEqual(textContracts.run({ root: ROOT, only: [CONTRACT], minContracts: 1 }), []);
  });

  test('aRegisteredFollowerPasses', (t) => {
    const tree = makeTree(t, {
      registry: { followers: [{ file: 'hooks/a.js' }] },
      files: { 'hooks/a.js': PARSER, 'src/x.cts': 'export const x = 1;\n' },
    });
    assert.deepEqual(messages(tree), []);
  });

  test('anUnregisteredReaderInHooksIsReportedByName', (t) => {
    const tree = makeTree(t, {
      registry: { followers: [{ file: 'hooks/a.js' }] },
      files: { 'hooks/a.js': PARSER, 'hooks/b.js': PARSER, 'src/x.cts': 'export const x = 1;\n' },
    });
    const found = messages(tree);
    assert.equal(found.length, 1);
    assert.match(found[0], /hooks\/b\.js parses the handoff filename grammar but is not a registered follower/);
  });

  test('anUnregisteredReaderInSrcIsReported', (t) => {
    const tree = makeTree(t, {
      registry: { followers: [{ file: 'hooks/a.js' }] },
      files: { 'hooks/a.js': PARSER, 'src/y.cts': "const n = 'HANDOFF.latest.' + role;\n" },
    });
    assert.match(messages(tree).join('\n'), /src\/y\.cts parses the handoff filename grammar/);
  });

  test('theOwnerIsExempt: src/session-store.cts may parse the grammar without a registry row', (t) => {
    const tree = makeTree(t, {
      registry: { followers: [{ file: 'hooks/a.js' }] },
      files: { 'hooks/a.js': PARSER, 'src/session-store.cts': PARSER },
    });
    assert.deepEqual(messages(tree), []);
  });

  test('aRegistryRowForAMissingFileIsReported', (t) => {
    const tree = makeTree(t, {
      registry: { followers: [{ file: 'hooks/a.js' }, { file: 'hooks/gone.js' }] },
      files: { 'hooks/a.js': PARSER, 'src/x.cts': 'export const x = 1;\n' },
    });
    assert.match(messages(tree).join('\n'), /hooks\/gone\.js/);
  });

  test('aMalformedRegistryIsReported: not JSON, no followers array, a follower without a file', (t) => {
    for (const registry of ['{nope', '{}', '{"followers":[{}]}']) {
      const tree = makeTree(t, { registry, files: { 'hooks/a.js': PARSER, 'src/x.cts': 'export const x = 1;\n' } });
      fs.writeFileSync(path.join(tree.root, 'tests', 'fixtures', 'session-handoff-cases.json'), registry);
      assert.ok(messages(tree).length > 0, registry);
    }
  });

  test('aGeneratedCopyUnderHooksDistIsNotAReader: the build copy of a registered hook does not need its own row', (t) => {
    const tree = makeTree(t, {
      registry: { followers: [{ file: 'hooks/a.js' }] },
      files: { 'hooks/a.js': PARSER, 'hooks/dist/a.js': PARSER, 'src/x.cts': 'export const x = 1;\n' },
    });
    assert.deepEqual(messages(tree), []);
  });

  test('aFileThatOnlyMentionsHandoffIsNotAReader: prose and unrelated names do not trip it', (t) => {
    const tree = makeTree(t, {
      registry: { followers: [{ file: 'hooks/a.js' }] },
      files: { 'hooks/a.js': PARSER, 'hooks/c.js': "// HANDOFF.json is written by pause-work\nconst x = 'handoff';\n", 'src/x.cts': 'export const x = 1;\n' },
    });
    assert.deepEqual(messages(tree), []);
  });
});
