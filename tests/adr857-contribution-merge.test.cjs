'use strict';

/**
 * adr857-contribution-merge.test.cjs — behavioral tests for ADR-857 deliverable J:
 * "Contribution merge" — multiple contributions at one point compose by ordered
 * concatenation in produces/consumes topological order (capId tiebreak), each
 * wrapped in <contribution from="<capability-id>">...</contribution>.
 *
 * Tests use synthetic registries built in-test plus the real
 * resolveLoopHooks/renderLoopHooks pure functions.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveLoopHooks,
  renderLoopHooks,
} = require('../gsd-core/bin/lib/loop-resolver.cjs');

const {
  buildRegistry,
} = require('../scripts/gen-capability-registry.cjs');

// ─── Synthetic registry builder helpers ──────────────────────────────────────

/**
 * Build a capability map entry for use with buildRegistry().
 * Minimal valid shape mirroring the cycle-test fixtures in capability-registry.test.cjs.
 */
function makeCapEntry(id, contributions) {
  return {
    id,
    role: 'feature',
    title: id,
    tier: 'full',
    requires: [],
    skills: [],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions,
    gates: [],
  };
}

/**
 * Build a compiled registry via buildRegistry() from a list of simple contribution
 * descriptors. Each descriptor: { capId, fragment, produces, consumes, into }.
 * buildRegistry applies the produces/consumes topo sort + capId tiebreak so the
 * resulting registry.byLoopPoint['plan:pre'].contributions are already sorted.
 */
function makeContribRegistry(contribs) {
  const capMap = new Map(contribs.map(c => [
    c.capId,
    makeCapEntry(c.capId, [{
      point: 'plan:pre',
      into: c.into ?? 'planner',
      fragment: c.fragment ?? { inline: `Content from ${c.capId}.` },
      produces: c.produces ?? [],
      consumes: c.consumes ?? [],
      onError: 'skip',
    }]),
  ]));
  return buildRegistry(capMap);
}

// ─── 1. Happy path: topological ordering (produces → consumes dependency) ─────

describe('ADR-857 deliverable J: contribution merge ordering', () => {
  test(
    '[happy] two contributions at plan:pre where cap-a produces and cap-b consumes: ' +
    'resolveLoopHooks orders cap-a before cap-b',
    () => {
      // cap-b consumes what cap-a produces → cap-a must come first
      const registry = makeContribRegistry([
        // Deliberately listed in reverse dependency order to prove sorting happens
        { capId: 'cap-b', produces: [], consumes: ['A.md'], fragment: { inline: 'Consume A.md here.' } },
        { capId: 'cap-a', produces: ['A.md'], consumes: [], fragment: { inline: 'Produce A.md here.' } },
      ]);

      const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });

      assert.strictEqual(resolved.activeHooks.length, 2, 'Both contributions must be active');

      const capIds = resolved.activeHooks.map(h => h.capId);
      assert.strictEqual(capIds[0], 'cap-a', 'cap-a (producer) must appear first');
      assert.strictEqual(capIds[1], 'cap-b', 'cap-b (consumer) must appear second');

      // Both must be kind=contribution
      for (const hook of resolved.activeHooks) {
        assert.strictEqual(hook.kind, 'contribution', 'Every active hook must have kind=contribution');
      }
    },
  );

  test(
    '[happy] renderLoopHooks produces TWO separate <contribution from=...> blocks, ' +
    'cap-a block before cap-b block, each independently opened and closed',
    () => {
      const registry = makeContribRegistry([
        { capId: 'cap-b', produces: [], consumes: ['A.md'], fragment: { inline: 'Consumer block body.' } },
        { capId: 'cap-a', produces: ['A.md'], consumes: [], fragment: { inline: 'Producer block body.' } },
      ]);

      const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
      const rendered = renderLoopHooks(resolved);

      // Two separate opening tags must be present
      const openA = `<contribution from="cap-a"`;
      const openB = `<contribution from="cap-b"`;
      assert.ok(rendered.includes(openA), `rendered must contain opening tag for cap-a. Got:\n${rendered}`);
      assert.ok(rendered.includes(openB), `rendered must contain opening tag for cap-b. Got:\n${rendered}`);

      // Two separate closing tags
      const closes = rendered.split('</contribution>');
      // splitting by </contribution> gives N+1 parts for N occurrences
      assert.ok(closes.length >= 3, `rendered must contain at least two </contribution> close tags. Got:\n${rendered}`);

      // cap-a's block must appear before cap-b's block in document order
      const posA = rendered.indexOf(openA);
      const posB = rendered.indexOf(openB);
      assert.ok(posA < posB, `cap-a opening tag must appear before cap-b opening tag. posA=${posA}, posB=${posB}`);

      // No merged or nested blocks — each cap's open tag must be closed before the other cap's open tag
      // i.e. the first close tag must appear after posA and before posB
      const firstClose = rendered.indexOf('</contribution>');
      assert.ok(
        firstClose > posA && firstClose < posB,
        `First </contribution> must close cap-a before cap-b opens. firstClose=${firstClose}, posA=${posA}, posB=${posB}`,
      );

      // Fragment body content appears inside respective blocks
      assert.ok(rendered.includes('Producer block body.'), 'cap-a fragment body must appear in rendered output');
      assert.ok(rendered.includes('Consumer block body.'), 'cap-b fragment body must appear in rendered output');
    },
  );
});

// ─── 2. BVA: no produces/consumes dependency → capId tiebreak ────────────────

describe('ADR-857 deliverable J: capId tiebreak ordering', () => {
  test(
    '[BVA] two contributions with NO produces/consumes dependency: ' +
    'capId alphabetical tiebreak ensures a-contrib renders before z-contrib',
    () => {
      // Neither cap produces/consumes anything → tiebreak by capId
      const registry = makeContribRegistry([
        // Reverse alpha order in input to prove sort is applied
        { capId: 'z-contrib', produces: [], consumes: [], fragment: { inline: 'Z content.' } },
        { capId: 'a-contrib', produces: [], consumes: [], fragment: { inline: 'A content.' } },
      ]);

      const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });

      assert.strictEqual(resolved.activeHooks.length, 2, 'Both contributions must be active');

      const capIds = resolved.activeHooks.map(h => h.capId);
      assert.strictEqual(capIds[0], 'a-contrib', 'a-contrib must appear first (alphabetical tiebreak)');
      assert.strictEqual(capIds[1], 'z-contrib', 'z-contrib must appear second (alphabetical tiebreak)');

      // Render and confirm document order matches sort order
      const rendered = renderLoopHooks(resolved);
      const posA = rendered.indexOf('<contribution from="a-contrib"');
      const posZ = rendered.indexOf('<contribution from="z-contrib"');
      assert.ok(posA >= 0, 'a-contrib opening tag must be present in rendered output');
      assert.ok(posZ >= 0, 'z-contrib opening tag must be present in rendered output');
      assert.ok(posA < posZ, `a-contrib must render before z-contrib. posA=${posA}, posZ=${posZ}`);
    },
  );
});

// ─── 3. Happy path: provenance — each block's from= matches its capId ─────────

describe('ADR-857 deliverable J: contribution provenance', () => {
  test(
    '[happy] each block from= attribute matches its capId; the two from= values differ',
    () => {
      const registry = makeContribRegistry([
        { capId: 'feature-alpha', produces: ['ALPHA.md'], consumes: [], fragment: { inline: 'Alpha content.' } },
        { capId: 'feature-beta', produces: [], consumes: ['ALPHA.md'], fragment: { inline: 'Beta content.' } },
      ]);

      const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
      const rendered = renderLoopHooks(resolved);

      // Both capIds appear as from= values
      assert.ok(
        rendered.includes('from="feature-alpha"'),
        'rendered must contain from="feature-alpha"',
      );
      assert.ok(
        rendered.includes('from="feature-beta"'),
        'rendered must contain from="feature-beta"',
      );

      // The two from= values are distinct (they differ from each other)
      const fromAlpha = 'from="feature-alpha"';
      const fromBeta = 'from="feature-beta"';
      assert.notEqual(fromAlpha, fromBeta, 'the two from= attribute strings must differ');

      // activeHooks provenance: each hook's capId matches what it will render as
      const [first, second] = resolved.activeHooks;
      assert.strictEqual(first.capId, 'feature-alpha', 'first hook capId must be feature-alpha');
      assert.strictEqual(second.capId, 'feature-beta', 'second hook capId must be feature-beta');
      assert.notEqual(first.capId, second.capId, 'the two capIds must differ from each other');
    },
  );
});

// ─── 4. Negative: produces/consumes cycle → buildRegistry throws ──────────────

describe('ADR-857 deliverable J: contribution cycle detection', () => {
  test(
    '[negative] a produces/consumes cycle among contributions at one point ' +
    'causes buildRegistry to throw an error mentioning "cycle"',
    () => {
      // cap-a produces A.md and consumes B.md
      // cap-b produces B.md and consumes A.md
      // → mutual dependency cycle
      const capMap = new Map([
        ['cap-a', makeCapEntry('cap-a', [{
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 'A fragment.' },
          produces: ['A.md'],
          consumes: ['B.md'],
          onError: 'skip',
        }])],
        ['cap-b', makeCapEntry('cap-b', [{
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 'B fragment.' },
          produces: ['B.md'],
          consumes: ['A.md'],
          onError: 'skip',
        }])],
      ]);

      assert.throws(
        () => buildRegistry(capMap),
        (err) => {
          assert.ok(err instanceof Error, `Expected Error, got: ${Object.prototype.toString.call(err)}`);
          assert.match(
            err.message,
            /cycle/i,
            `Error message must mention "cycle". Got: "${err.message}"`,
          );
          // Must also reference contributions (not just steps)
          assert.match(
            err.message,
            /contribution/i,
            `Error message must mention "contribution". Got: "${err.message}"`,
          );
          return true;
        },
      );
    },
  );
});
