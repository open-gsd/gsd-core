// allow-test-rule: runtime-contract-is-the-product — the must_haves.prohibitions: block is the
// runtime plan-contract surface; this pins its parse/round-trip/projection bijection to the code.
//
// RED-first schema contract for the `must_haves.prohibitions:` SIBLING block (ADR-550 Decision 3 —
// NOT a `polarity` field on `truths`; Decision 2 leaves `truths` untouched). Mirrors the round-trip
// discipline of tests/probe-core.test.cjs and the frontmatter callers. The parser under assertion is
// the block-name-generic parseMustHavesBlock @ src/frontmatter.cts:207 (built to gsd-core/bin/lib/
// frontmatter.cjs by `npm run build:lib`) and spliceFrontmatter @ src/frontmatter.cts:198.
//
// EXPECTED RED until plan 01-02 builds the schema callers + projectProhibitions and plan 01-04 adds
// the test-tier fail-closed disposition. No `polarity` key appears anywhere. No LLM judgment is
// asserted (ADR-550 Decision 5) — only parse / round-trip / projection determinism.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FRONTMATTER_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'frontmatter.cjs');
const PROBE_CORE_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs');

// A must_haves block carrying a prohibitions: sibling list. ADR-550 D7a axes:
// status ∈ {resolved, dismissed, unresolved}; verification ∈ {test, judgment} (NOT the retired
// covered/backstop enum). Dismissed items carry a non-empty reason.
const CONTENT_WITH_PROHIBITIONS = `---
phase: 01-x
plan: 01
must_haves:
  truths:
    - "User sees a daily reminder"
  artifacts:
    - path: "src/reminders.ts"
      provides: "scheduleReminders"
  prohibitions:
    - statement: "MUST NOT use shaming/guilt/negative-streak framing"
      status: resolved
      verification: judgment
    - statement: "MUST NOT store raw SSN in the audit log"
      status: dismissed
      verification: test
      reason: "Out of scope for this phase; tracked in PRIV-02"
  key_links:
    - from: "src/reminders.ts"
      to: "src/notify.ts"
      via: "import"
---

Body text unchanged.
`;

// A must_haves block with NO prohibitions: sibling — the backward-compat case.
const CONTENT_NO_PROHIBITIONS = `---
phase: 01-x
plan: 01
must_haves:
  truths:
    - "User sees a daily reminder"
  artifacts:
    - path: "src/reminders.ts"
      provides: "scheduleReminders"
  key_links:
    - from: "src/reminders.ts"
      to: "src/notify.ts"
      via: "import"
---

Body text unchanged.
`;

describe('prohibition-probe schema: must_haves.prohibitions round-trip (PROB-07)', () => {
  const fm = require(FRONTMATTER_LIB);

  test('a prohibitions: list survives parse -> splice -> re-parse unchanged', () => {
    assert.equal(typeof fm.parseMustHavesBlock, 'function', 'parseMustHavesBlock must be exported from the built lib');
    assert.equal(typeof fm.spliceFrontmatter, 'function', 'spliceFrontmatter must be exported from the built lib');
    assert.equal(typeof fm.parseFrontmatter, 'function', 'parseFrontmatter must be exported from the built lib');

    const prohibitions = fm.parseMustHavesBlock(CONTENT_WITH_PROHIBITIONS, 'prohibitions');
    assert.equal(prohibitions.length, 2, 'two prohibition items must parse out of the must_haves block');

    const resolved = prohibitions[0];
    assert.equal(resolved.statement, 'MUST NOT use shaming/guilt/negative-streak framing');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.verification, 'judgment');

    const dismissed = prohibitions[1];
    assert.equal(dismissed.status, 'dismissed');
    assert.equal(dismissed.verification, 'test');
    assert.ok(typeof dismissed.reason === 'string' && dismissed.reason.trim().length > 0,
      'a dismissed prohibition must carry a non-empty reason (ADR-550 Decision 2/3)');

    // Round-trip: parse full frontmatter, splice it back, re-parse — prohibitions are stable.
    const parsed = fm.parseFrontmatter(CONTENT_WITH_PROHIBITIONS);
    const spliced = fm.spliceFrontmatter(CONTENT_WITH_PROHIBITIONS, parsed.frontmatter ?? parsed);
    const reparsed = fm.parseMustHavesBlock(spliced, 'prohibitions');
    assert.deepEqual(reparsed, prohibitions, 'prohibitions must survive a splice/re-parse round-trip unchanged');
  });

  test('no polarity key is present on any prohibition item (ADR-550 Decision 2/3)', () => {
    const prohibitions = fm.parseMustHavesBlock(CONTENT_WITH_PROHIBITIONS, 'prohibitions');
    for (const item of prohibitions) {
      assert.ok(!Object.prototype.hasOwnProperty.call(item, 'polarity'),
        'prohibition items must NOT carry a polarity key — the prohibitions: sibling block replaces it');
    }
  });
});

describe('prohibition-probe schema: backward-compat byte-stability (PROB-08)', () => {
  const fm = require(FRONTMATTER_LIB);

  test('a must_haves with no prohibitions: is byte-unchanged through the round-trip', () => {
    const parsed = fm.parseFrontmatter(CONTENT_NO_PROHIBITIONS);
    const spliced = fm.spliceFrontmatter(CONTENT_NO_PROHIBITIONS, parsed.frontmatter ?? parsed);
    assert.equal(spliced, CONTENT_NO_PROHIBITIONS,
      'a prohibitions-less must_haves must round-trip byte-for-byte (backward compatibility)');
  });

  test('parseMustHavesBlock(content, "prohibitions") returns [] when absent', () => {
    const prohibitions = fm.parseMustHavesBlock(CONTENT_NO_PROHIBITIONS, 'prohibitions');
    assert.deepEqual(prohibitions, [], 'absent prohibitions: block must parse to an empty list, not throw');
  });
});

describe('prohibition-probe schema: deterministic projectProhibitions round-trip (PROB-14)', () => {
  // ADR-550 Decision 5(c): the DEFECT.GENERATIVE-FIX parity assertion across template <-> parser <->
  // planner is grounded on a deterministic projectProhibitions() in probe-core rather than a prompt.
  // The function does not exist yet (plan 01-02 adds it) — assert its expected signature so this is RED.
  test('probe-core exports a deterministic projectProhibitions(items) function', () => {
    const pc = require(PROBE_CORE_LIB);
    assert.equal(typeof pc.projectProhibitions, 'function',
      'probe-core must export projectProhibitions() — the deterministic SPEC<->must_haves projection (ADR-550 D5c)');

    const items = [
      { requirement_id: 'R1', category: 'values', status: 'resolved', verification: 'judgment', resolution: null, reason: null, statement: 'MUST NOT shame the user' },
    ];
    const once = pc.projectProhibitions(items);
    const twice = pc.projectProhibitions(items);
    assert.deepEqual(once, twice, 'projectProhibitions must be deterministic (same input -> identical output)');
    assert.ok(Array.isArray(once), 'projectProhibitions must return an array of prohibition entries');
  });
});
