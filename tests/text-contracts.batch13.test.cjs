'use strict';

/**
 * The text contracts added after batch 12, one describe block each.
 *
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

/**
 * #6812: the `audit-milestone-verification-owner` text contract. /gsd-audit-milestone step 2 reads each phase's status
 * and the owner's next step from `verification.status`, each with a hard stop on a failure, and lists exactly the
 * owner's closed set; nothing in the workflow reads the report's own status, and `VERIFICATION_STATUS` is assigned
 * once. The 5d matrix keys every row on that set, with a row per member, satisfied from `passed` rows alone and, under
 * `passed`, rows for a `? NEEDS HUMAN` and a `✗ BLOCKED` requirement that no catch-all `passed` row above them
 * shadows; the schema lists the same set plus `orphaned`.
 * The real workflow passes; each edit below breaks one rule and must be a finding.
 */
describe('audit-milestone-verification-owner (#6812)', () => {
  const OWNER_CONTRACT = 'audit-milestone-verification-owner';
  const CONTRACT_PATH = path.join(ROOT, 'scripts', 'static-checks', 'text-contracts', `${OWNER_CONTRACT}.cjs`);
  const WORKFLOW = 'gsd-core/workflows/audit-milestone.md';
  const OWNER = 'gsd-core/bin/lib/verification.cjs';
  const TABLE = 'gsd-core/bin/lib/markdown-table.cjs';
  const { VERIFICATION_STATUS } = require('../gsd-core/bin/lib/verification.cjs');
  const MEMBERS = Object.values(VERIFICATION_STATUS);
  const SHIPPED_TEXT = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8');

  // The workflow, edited, in a temporary root; the real contract directory runs against it.
  function findingsFor(t, edit) {
    const root = createTempDir('gsd-audit-owner-contract-');
    t.after(() => cleanup(root));
    const abs = path.join(root, ...WORKFLOW.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (edit !== null) fs.writeFileSync(abs, edit(SHIPPED_TEXT));
    return textContracts.run({ root, only: [OWNER_CONTRACT], minContracts: 1 });
  }

  // An edit that must change the text (so a reworded workflow cannot make a row pass vacuously).
  const edited = (label, fn) => (text) => {
    const out = fn(text);
    assert.notEqual(out, text, `${label}: the edit must apply to the shipped workflow`);
    return out;
  };
  const replaceLine = (pattern, to) => (text) => text.replace(pattern, to);
  const ownerLine = (field) => new RegExp(`^([A-Z_]+=\\$\\(gsd_run query verification\\.status "[^"]+" --pick ${field}\\)) \\|\\| \\{.*\\}$`, 'm');
  const afterOwnerRead = (line) => replaceLine(/^(VERIFICATION_STATUS=\$\(gsd_run query verification\.status.*\n)/m, `$1${line}\n`);
  const matrixRow = (status) => new RegExp(`^\\| ${status} +\\|.*\\n`, 'gm');
  const reportRow = (row) => new RegExp(`^(\\| passed +\\| \`${row.replace(/[?]/g, '\\?')}\` *\\|.*)\\*\\*[a-z]+\\*\\*(.*)$`, 'm');
  const aboveReportRows = (line) => replaceLine(/^(\| passed +\| `\? NEEDS HUMAN`)/m, `${line}\n$1`);
  const listLine = /^`VERIFICATION_STATUS` is one of [^\n]*$/m;
  const schemaLine = /^( *verification_status: ")([^"\n]*)("$)/m;
  const dropFromList = (member) => replaceLine(listLine, (line) => line.replace(`\`${member}\`, `, '').replace(`, \`${member}\`.`, '.'));
  const dropFromSchema = (value) => replaceLine(schemaLine, (_, a, list, b) => a + list.split(' | ').filter((v) => v !== value).join(' | ') + b);
  const verdictIn = (status, to) => replaceLine(new RegExp(`^(\\| ${status} +\\|.*)\\*\\*[a-z]+\\*\\*`, 'm'), `$1**${to}**`);

  // A finding names the part of the workflow it is about: step 2, the 5d matrix, or the whole file.
  const STEP2 = `${WORKFLOW} [## 2. Read All Phase Verifications]`;
  const MATRIX = `${WORKFLOW} [### 5d. Status Determination Matrix]`;
  const DOC = WORKFLOW;
  const SCOPE_NAMES = { [STEP2]: 'step 2', [MATRIX]: 'the 5d matrix', [DOC]: 'the whole workflow' };

  const MUTATIONS = [
    ['the owner call is removed', replaceLine(/^VERIFICATION_STATUS=\$\(gsd_run query verification\.status.*\n/m, ''), STEP2],
    ['the hard stop on a refusal is removed', replaceLine(ownerLine('status'), '$1'), STEP2],
    ['the hard stop on the next_action read is removed', replaceLine(ownerLine('next_action'), '$1'), STEP2],
    ['the hard stop on the next_command read is removed', replaceLine(ownerLine('next_command'), '$1'), STEP2],
    ['the next_action read is removed', replaceLine(/^NEXT_ACTION=.*\n/m, ''), STEP2],
    ['the next_command read is removed', replaceLine(/^NEXT_COMMAND=.*\n/m, ''), STEP2],
    ...MEMBERS.map((m) => [`${m} is dropped from the step 2 list`, dropFromList(m), STEP2]),
    ['a value outside the set is added to the step 2 list', replaceLine(listLine, (line) => line.replace('`phase_dir_not_found`.', '`phase_dir_not_found`, `verified`.')), STEP2],
    ['the raw **Status:** passed | gaps_found read is restored in step 2', replaceLine('- **Critical gaps:**', '- **Status:** passed | gaps_found\n- **Critical gaps:**'), DOC],
    ['the raw **Status:** read is added to step 5b', replaceLine('- Map each entry back to its REQ-ID', '- **Status:** passed | gaps_found\n- Map each entry back to its REQ-ID'), DOC],
    ['an unbolded Status: passed | gaps_found read is restored', replaceLine('- **Critical gaps:**', '- Status: passed | gaps_found\n- **Critical gaps:**'), DOC],
    ['a backticked **Status:** `passed` | `gaps_found` read is restored', replaceLine('- **Critical gaps:**', '- **Status:** `passed` | `gaps_found`\n- **Critical gaps:**'), DOC],
    ['the report status is read with frontmatter.get', afterOwnerRead('REPORT_STATUS=$(gsd_run query frontmatter.get "${VERIFY_DIR}"/*-VERIFICATION.md --field status)'), DOC],
    ["the owner's answer is overwritten", afterOwnerRead('VERIFICATION_STATUS=passed'), DOC],
    ...MEMBERS.map((m) => [`the matrix rows for ${m} are removed`, replaceLine(matrixRow(m), ''), MATRIX]),
    ['the stale row gives satisfied', verdictIn('stale', 'satisfied'), MATRIX],
    ['the human_needed row gives satisfied', verdictIn('human_needed', 'satisfied'), MATRIX],
    ['the gaps_found row gives partial', verdictIn('gaps_found', 'partial'), MATRIX],
    ['the unparseable row gives partial', verdictIn('unparseable', 'partial'), MATRIX],
    ['the phase_dir_not_found row gives partial', verdictIn('phase_dir_not_found', 'partial'), MATRIX],
    ['a missing row gives satisfied', verdictIn('missing', 'satisfied'), MATRIX],
    ['a matrix row is keyed on a status outside the set', replaceLine(/^(\| phase_dir_not_found .*\n)/m, '$1| verified | any | any | any | **satisfied** |\n'), MATRIX],
    ['the ? NEEDS HUMAN row is removed', replaceLine(/^\| passed +\| `\? NEEDS HUMAN`.*\n/m, ''), MATRIX],
    ['the ? NEEDS HUMAN row gives satisfied', replaceLine(reportRow('? NEEDS HUMAN'), '$1**satisfied**$2'), MATRIX],
    ['the ? NEEDS HUMAN row is keyed on stale instead of passed', replaceLine(/^\| passed( +\| `\? NEEDS HUMAN`)/m, '| stale $1'), MATRIX],
    ['the ✗ BLOCKED row is removed', replaceLine(/^\| passed +\| `✗ BLOCKED`.*\n/m, ''), MATRIX],
    ['the ✗ BLOCKED row gives partial', replaceLine(reportRow('✗ BLOCKED'), '$1**partial**$2'), MATRIX],
    ['a passed row for any report row comes first', aboveReportRows('| passed | any | any | any | **satisfied** |'), MATRIX],
    ['a passed row for any other report row comes first', aboveReportRows('| passed | other | listed | any | **satisfied** |'), MATRIX],
    ...MEMBERS.map((m) => [`${m} is dropped from the schema`, dropFromSchema(m), DOC]),
    ['orphaned is dropped from the schema', dropFromSchema('orphaned'), DOC],
    ['a value outside the set is added to the schema', replaceLine(schemaLine, (_, a, list, b) => `${a}${list} | verified${b}`), DOC],
  ];

  test('theShippedWorkflowPasses', () => {
    assert.deepEqual(textContracts.run({ root: ROOT, only: [OWNER_CONTRACT], minContracts: 1 }), []);
  });

  test('anUnchangedCopyPasses: the temporary root alone is no finding', (t) => {
    assert.deepEqual(findingsFor(t, (text) => text), []);
  });

  for (const [label, fn, scope] of MUTATIONS) {
    test(`anEditIsAFindingInItsScope: ${label} (${SCOPE_NAMES[scope]})`, (t) => {
      const findings = findingsFor(t, edited(label, fn));
      assert.ok(findings.length > 0, label);
      assert.deepEqual([...new Set(findings.map((f) => f.file))], [scope]);
    });
  }

  test('aRemovedWorkflowIsExactlyOneFindingForIt', (t) => {
    const findings = findingsFor(t, null);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, WORKFLOW);
  });

  // The contract with a loader that throws, run through the engine from a directory of its own, in a root without the
  // workflow: the one finding names the library, so the workflow was not read.
  for (const [loader, lib] of [['loadOwner', OWNER], ['loadTable', TABLE]]) {
    test(`aLibraryThatCannotBeLoadedIsOneFindingForIt: ${lib}`, (t) => {
      const root = createTempDir('gsd-audit-owner-loader-');
      t.after(() => cleanup(root));
      const dir = path.join(root, 'contracts');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, `${OWNER_CONTRACT}.cjs`),
        `const real = require(${JSON.stringify(CONTRACT_PATH)});\n` +
          `module.exports = { ...real, check: real.walkers.buildCheck({ ${loader}: () => { throw new Error('boom'); } }) };\n`,
      );
      const findings = textContracts.run({ root, dir, only: [OWNER_CONTRACT], minContracts: 1 });
      assert.deepEqual(findings.map((f) => f.file), [lib]);
    });
  }
});
