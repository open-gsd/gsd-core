'use strict';

/**
 * 6510-declared-scope-comma-reject.test.cjs — a comma-joined --files/--deletions
 * value must be rejected, not recorded as one path.
 *
 * #6510: `worktree record-agent --files "a,b,c"` recorded the whole value as a
 * single manifest element and answered ok:true, silently defeating the
 * cleanup-wave scope warnings the verb promises to fail loudly about. Both
 * verbs that share the declared-scope parser must reject any token containing
 * a comma with a hint naming the whitespace separator, and write nothing;
 * whitespace-separated lists and comma-free paths keep recording exactly as
 * before. The parity row pins that record-agent and create — the parser's two
 * consumers — cannot diverge on the same input; the property row pins the two
 * separators over generated path lists.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const MANIFEST_REL = 'wave-manifest.json';
const WORKTREE_REL = 'wt-a';

function writeManifest(tmpDir) {
  const raw = `${JSON.stringify({ orchestrator_root: tmpDir, worktrees: [] }, null, 2)}\n`;
  fs.writeFileSync(path.join(tmpDir, MANIFEST_REL), raw);
  return raw;
}

function readManifest(tmpDir) {
  return fs.readFileSync(path.join(tmpDir, MANIFEST_REL), 'utf8');
}

function recordAgent(tmpDir, flag, value) {
  return runGsdTools(
    ['worktree', 'record-agent', '--manifest', MANIFEST_REL, '--agent-id', 'a1',
      '--path', WORKTREE_REL, '--branch', 'agent-6510-x', '--base', 'cafe1234',
      flag, value],
    tmpDir,
  );
}

function createVerb(tmpDir, flag, value) {
  return runGsdTools(
    ['worktree', 'create', '--manifest', MANIFEST_REL, '--agent-id', 'a1',
      '--path', WORKTREE_REL, '--branch', 'agent-6510-c', '--base',
      'cafe1234cafe1234cafe1234cafe1234cafe1234', '--root', tmpDir, flag, value],
    tmpDir,
  );
}

function recordAgentBoth(tmpDir, filesValue, deletionsValue) {
  return runGsdTools(
    ['worktree', 'record-agent', '--manifest', MANIFEST_REL, '--agent-id', 'a1',
      '--path', WORKTREE_REL, '--branch', 'agent-6510-x', '--base', 'cafe1234',
      '--files', filesValue, '--deletions', deletionsValue],
    tmpDir,
  );
}

function envelope(result) {
  return JSON.parse(result.output);
}

describe('worktree record-agent rejects comma-joined declared scope (#6510)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('6510-rec-'); writeManifest(tmpDir); });
  afterEach(() => cleanup(tmpDir));

  test('--files "a,b,c" is rejected with the separator hint and writes nothing', () => {
    const before = readManifest(tmpDir);
    const result = recordAgent(tmpDir, '--files', 'a,b,c');
    assert.equal(result.success, false, `comma-joined --files must fail: ${result.output}`);
    const env = envelope(result);
    assert.equal(env.ok, false);
    assert.equal(env.reason, 'comma_joined_scope');
    assert.match(env.hint, /--files/);
    assert.match(env.hint, /whitespace/);
    assert.match(env.hint, /a,b,c/);
    assert.equal(readManifest(tmpDir), before, 'rejected call must leave the manifest byte-identical');
  });

  test('--deletions "d,e" is rejected with the separator hint and writes nothing', () => {
    const before = readManifest(tmpDir);
    const result = recordAgent(tmpDir, '--deletions', 'd,e');
    assert.equal(result.success, false, `comma-joined --deletions must fail: ${result.output}`);
    const env = envelope(result);
    assert.equal(env.reason, 'comma_joined_scope');
    assert.match(env.hint, /--deletions/);
    assert.match(env.hint, /whitespace/);
    assert.equal(readManifest(tmpDir), before);
  });

  test('a single token containing a comma is rejected (any-comma contract)', () => {
    const result = recordAgent(tmpDir, '--files', 'a,b');
    assert.equal(result.success, false);
    assert.equal(envelope(result).reason, 'comma_joined_scope');
  });

  test('a comma in a non-first token ("a b,c") is rejected naming that token', () => {
    const before = readManifest(tmpDir);
    const result = recordAgent(tmpDir, '--files', 'a b,c');
    assert.equal(result.success, false, `comma in a later token must fail: ${result.output}`);
    const env = envelope(result);
    assert.equal(env.reason, 'comma_joined_scope');
    assert.match(env.hint, /--files/);
    assert.match(env.hint, /b,c/, `the hint must name the offending token: ${env.hint}`);
    assert.equal(readManifest(tmpDir), before, 'rejected call must leave the manifest byte-identical');
  });

  test('--files and --deletions both comma-joined: the hint names --files', () => {
    const result = recordAgentBoth(tmpDir, 'a,b', 'd,e');
    assert.equal(result.success, false);
    const env = envelope(result);
    assert.equal(env.reason, 'comma_joined_scope');
    assert.match(env.hint, /--files/, `first-flag precedence must name --files: ${env.hint}`);
    assert.doesNotMatch(env.hint, /--deletions/);
  });

  test('--files "a b c" still records three entries', () => {
    const result = recordAgent(tmpDir, '--files', 'a b c');
    assert.equal(result.success, true, `space-separated list must succeed: ${result.error}`);
    assert.deepEqual(envelope(result).entry.files_modified, ['a', 'b', 'c']);
  });

  test('a single comma-free path still records one entry', () => {
    const result = recordAgent(tmpDir, '--files', 'src/one.ts');
    assert.equal(result.success, true, `single path must succeed: ${result.error}`);
    assert.deepEqual(envelope(result).entry.files_modified, ['src/one.ts']);
  });
});

describe('worktree create rejects comma-joined declared scope before any git (#6510)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('6510-crt-'); writeManifest(tmpDir); });
  afterEach(() => cleanup(tmpDir));

  test('--files "a,b,c" is rejected; nothing is created or written', () => {
    const before = readManifest(tmpDir);
    const result = createVerb(tmpDir, '--files', 'a,b,c');
    assert.equal(result.success, false, `comma-joined --files must fail: ${result.output}`);
    const env = envelope(result);
    assert.equal(env.reason, 'comma_joined_scope');
    assert.match(env.hint, /whitespace/);
    assert.equal(readManifest(tmpDir), before, 'rejected create must leave the manifest byte-identical');
    assert.equal(fs.existsSync(path.join(tmpDir, WORKTREE_REL)), false, 'rejected create must not create the worktree path');
  });

  test('--deletions "d,e" is rejected', () => {
    const before = readManifest(tmpDir);
    const result = createVerb(tmpDir, '--deletions', 'd,e');
    assert.equal(result.success, false);
    assert.equal(envelope(result).reason, 'comma_joined_scope');
    assert.equal(readManifest(tmpDir), before, 'rejected create must leave the manifest byte-identical');
    assert.equal(fs.existsSync(path.join(tmpDir, WORKTREE_REL)), false);
  });
});

describe('both declared-scope verbs reject identically (#6510 parity)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('6510-par-'); writeManifest(tmpDir); });
  afterEach(() => cleanup(tmpDir));

  test('record-agent and create return the same reason and hint', () => {
    const rec = envelope(recordAgent(tmpDir, '--files', 'a,b,c'));
    const cre = envelope(createVerb(tmpDir, '--files', 'a,b,c'));
    assert.deepEqual(
      { reason: rec.reason, hint: rec.hint },
      { reason: cre.reason, hint: cre.hint },
      'the shared parser must not diverge between the two verbs',
    );
    assert.equal(rec.reason, 'comma_joined_scope');
  });
});

// Generated comma-free, space-free path tokens: the space separator records the
// list verbatim, the comma separator is rejected (k>=2 forms a comma-joined list).
const tokenArb = fc
  .array(fc.constantFrom('a', 'b', 'c', 'd', 'x', 'y', 'z'), { minLength: 1, maxLength: 8 })
  .map((chars) => `p${chars.join('')}`);
const listArb = fc.array(tokenArb, { minLength: 1, maxLength: 4 });

// One property iteration: the space separator records the list verbatim, the
// comma separator is rejected (k>=2 forms a comma-joined list). try/finally
// lives here, in a standalone helper with no test context, per CONTRIBUTING.md:433.
function checkSeparatorContract(tokens) {
  const tmpDir = createTempProject('6510-prop-');
  try {
    writeManifest(tmpDir);
    const spaced = recordAgent(tmpDir, '--files', tokens.join(' '));
    assert.equal(spaced.success, true, `space-joined list rejected: ${spaced.output}`);
    assert.deepEqual(envelope(spaced).entry.files_modified, tokens);

    if (tokens.length >= 2) {
      writeManifest(tmpDir);
      const joined = recordAgent(tmpDir, '--files', tokens.join(','));
      assert.equal(joined.success, false, `comma-joined list accepted: ${joined.output}`);
      assert.equal(envelope(joined).reason, 'comma_joined_scope');
    }
  } finally {
    cleanup(tmpDir);
  }
}

describe('separator property over generated path lists (#6510)', () => {
  test('space-joined lists record verbatim; comma-joined lists are rejected', () => {
    fc.assert(
      fc.property(listArb, checkSeparatorContract),
    );
  });
});
