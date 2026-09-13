'use strict';

/**
 * Tests for the (not-yet-created) `hooks/lib/dispatch-identity.js` — the one
 * canonical owner of the `[gsd:dispatch phase="…" plan="…"]` marker format
 * and its prose fallback (#4594, epic #4630 Phase 1).
 *
 * See `.gsd/phase/fix-4594-dispatch-identity-seam/40-design.md` (behavior
 * table + negative space) and `50-test-matrix.md` (row -> test-name mapping)
 * for the full rationale. This file intentionally covers matrix rows 1-27
 * and 33-34 only; rows 28-32 are guard end-to-end rows that belong in
 * `tests/gsd-agent-isolation-guard.test.cjs` / `tests/cursor-subagent-isolation.test.cjs`.
 *
 * RED BY DESIGN: `hooks/lib/dispatch-identity.js` does not exist yet. This
 * whole file fails to load with MODULE_NOT_FOUND until that module is
 * written — that failure is the expected, correct state of this commit.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fc = require('fast-check');
const { GENERATOR_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  DISPATCH_PHASE_TOKEN_SOURCE,
  renderDispatchIdentityMarker,
  parseDispatchIdentity,
} = require('../hooks/lib/dispatch-identity.js');

const {
  extractDispatchIdentifiers,
  sentinelAppliesToDispatch,
} = require('../hooks/lib/isolation-sentinel.js');

const REPO_ROOT = path.resolve(__dirname, '..');

// Measured production shapes (40-design.md): the sentinel's own {phase, plan}
// as recorded by a real `phase-plan-index` run in this worktree, and the two
// verbatim dispatch-prose templates that embed the phase/plan numbers.
const MEASURED_SENTINEL = { phase: '03', plan: '03-02-hardening' };
const DESCRIPTION_FORM = 'Execute plan 02 of phase 03';
const PROMPT_BODY_FORM = 'Execute plan 02 of phase 03-auth.';

/**
 * Row 33's cold-tree probe: a single `node -e` script, spawned directly (no
 * fan-out), doing an in-process require plus two synchronous calls against a
 * small fixture path. Reuses `GENERATOR_SCRIPT_TIMEOUT_MS` (30000ms) rather
 * than declaring a new literal — that constant's own doc comment describes
 * "a single ... script, spawned directly ... against a small temp fixture
 * repo -- no fan-out", which is this call shape as well, even though the
 * spawned script here is an inline `-e` probe rather than a `scripts/*.cjs`
 * file.
 */
const COLD_TREE_PROBE_TIMEOUT_MS = GENERATOR_SCRIPT_TIMEOUT_MS;

describe('hooks/lib/dispatch-identity.js', () => {
  describe('marker format grammar', () => {
    test('marker: parses both identifiers', () => {
      const result = parseDispatchIdentity('[gsd:dispatch phase="03" plan="03-02-hardening"]');
      assert.deepEqual(result, { phase: '03', plan: '03-02-hardening', source: 'marker' });
    });

    test('marker: found anywhere in a large prompt', () => {
      const text = `some preamble\n\nmore lines here\n[gsd:dispatch phase="03" plan="03-02-hardening"]\n\ntrailing text`;
      const result = parseDispatchIdentity(text);
      assert.equal(result.phase, '03');
      assert.equal(result.plan, '03-02-hardening');
      assert.equal(result.source, 'marker');
    });

    test('render → parse round-trips', () => {
      const marker = renderDispatchIdentityMarker({ phase: '03', plan: '03-02-hardening' });
      assert.equal(marker, '[gsd:dispatch phase="03" plan="03-02-hardening"]');
      const parsed = parseDispatchIdentity(marker);
      assert.deepEqual(parsed, { phase: '03', plan: '03-02-hardening', source: 'marker' });
    });

    test('property: render/parse is a bijection on valid tokens', () => {
      // Only values a real producer could emit: filesystem-derived phase/plan
      // identifiers, so no quotes, brackets, or newlines (those are exactly
      // the hostile-value case covered separately by row 21).
      const safeToken = fc
        .stringMatching(/^[A-Za-z0-9._-]+$/)
        .filter((s) => s.length > 0 && s.length <= 64);

      fc.assert(
        fc.property(safeToken, safeToken, (phase, plan) => {
          const marker = renderDispatchIdentityMarker({ phase, plan });
          const parsed = parseDispatchIdentity(marker);
          assert.equal(parsed.phase, phase);
          assert.equal(parsed.plan, plan);
          assert.equal(parsed.source, 'marker');
        }),
        { seed: 4594, numRuns: 300 },
      );
    });
  });

  describe('prose fallback', () => {
    test('prose: bare phase number, plan deliberately null', () => {
      const result = parseDispatchIdentity(DESCRIPTION_FORM);
      assert.deepEqual(result, { phase: '03', plan: null, source: 'prose' });
    });

    test('prose: slug suffix and trailing period are not part of the token', () => {
      const result = parseDispatchIdentity(PROMPT_BODY_FORM);
      assert.deepEqual(result, { phase: '03', plan: null, source: 'prose' });
    });

    test('prose: decimal sub-phase', () => {
      const result = parseDispatchIdentity('Execute plan 02 of phase 3.2-thing.');
      assert.equal(result.phase, '3.2');
      assert.equal(result.plan, null);
    });

    test('prose: variant-letter phase', () => {
      const result = parseDispatchIdentity('Execute plan 02 of phase 12A-thing.');
      assert.equal(result.phase, '12A');
      assert.equal(result.plan, null);
    });

    test('prose: multi-segment sub-phase', () => {
      const result = parseDispatchIdentity('Execute plan 02 of phase 3.2.1');
      assert.equal(result.phase, '3.2.1');
      assert.equal(result.plan, null);
    });

    test('prose: token at end of input', () => {
      const result = parseDispatchIdentity('Execute plan 02 of phase 03');
      assert.equal(result.phase, '03');
    });

    test('prose: requires the full execute-plan-of-phase frame', () => {
      const lookalikes = [
        'run phase-plan-index for this project',
        'we are still in this phase 03 of the rollout',
        'the phase_dir helper resolves the directory',
      ];
      for (const text of lookalikes) {
        assert.deepEqual(
          parseDispatchIdentity(text),
          { phase: null, plan: null, source: null },
          `unexpected match for lookalike: ${text}`,
        );
      }
    });

    test('prose: anchors on the first frame only', () => {
      const text = 'Execute plan 02 of phase 03-auth. Note: wait until after plan 03-01 completes.';
      const result = parseDispatchIdentity(text);
      assert.equal(result.phase, '03');
      assert.equal(result.plan, null);
    });
  });

  describe('precedence and malformed markers', () => {
    test('marker takes precedence over prose', () => {
      const text = 'Execute plan 02 of phase 03-auth. [gsd:dispatch phase="04" plan="04-01-setup"]';
      const result = parseDispatchIdentity(text);
      assert.equal(result.phase, '04');
      assert.equal(result.plan, '04-01-setup');
      assert.equal(result.source, 'marker');
    });

    test('marker: unquoted value is not accepted', () => {
      const result = parseDispatchIdentity('[gsd:dispatch phase=03]');
      // Never a partial wrong value: either falls back to null/null (no
      // prose present here) or, if this text also had prose, to the prose
      // result — but never a phase of '03' read out of the malformed marker.
      assert.notEqual(result.source, 'marker');
      assert.deepEqual(result, { phase: null, plan: null, source: null });
    });

    test('marker: unknown keys are ignored', () => {
      const result = parseDispatchIdentity('[gsd:dispatch phase="03" plan="03-02-hardening" run="abc"]');
      assert.equal(result.phase, '03');
      assert.equal(result.plan, '03-02-hardening');
      assert.equal(result.source, 'marker');
    });

    test('marker: key order does not matter', () => {
      const result = parseDispatchIdentity('[gsd:dispatch plan="03-02-hardening" phase="03"]');
      assert.equal(result.phase, '03');
      assert.equal(result.plan, '03-02-hardening');
    });

    test('marker: phase-only is valid', () => {
      const result = parseDispatchIdentity('[gsd:dispatch phase="03"]');
      assert.deepEqual(result, { phase: '03', plan: null, source: 'marker' });
    });
  });

  describe('hostile and edge inputs', () => {
    test('parse: non-string and empty inputs', () => {
      const hostileInputs = [undefined, null, '', 0, 42, true, false, [], {}, NaN];
      for (const input of hostileInputs) {
        assert.doesNotThrow(() => parseDispatchIdentity(input));
        assert.deepEqual(
          parseDispatchIdentity(input),
          { phase: null, plan: null, source: null },
          `unexpected result for hostile input: ${String(input)}`,
        );
      }
      // Zero-argument call must also never throw and yield the same empty shape.
      assert.doesNotThrow(() => parseDispatchIdentity());
      assert.deepEqual(parseDispatchIdentity(), { phase: null, plan: null, source: null });
    });

    test('parse: unrelated prose', () => {
      const result = parseDispatchIdentity('this text has nothing to do with any dispatch');
      assert.deepEqual(result, { phase: null, plan: null, source: null });
    });

    test('CRLF variants parse identically', () => {
      const lf = parseDispatchIdentity('preamble\n[gsd:dispatch phase="03" plan="03-02-hardening"]\ntrailer');
      const crlf = parseDispatchIdentity('preamble\r\n[gsd:dispatch phase="03" plan="03-02-hardening"]\r\ntrailer');
      assert.deepEqual(crlf, lf);

      const lfProse = parseDispatchIdentity('Execute plan 02 of phase 03-auth.\nmore text');
      const crlfProse = parseDispatchIdentity('Execute plan 02 of phase 03-auth.\r\nmore text');
      assert.deepEqual(crlfProse, lfProse);
    });

    test('marker: quote/bracket in a value cannot forge a field', () => {
      // A value containing '"' or ']' is unusable per the render contract; a
      // hand-crafted malicious marker string attempting the same must not
      // let the parser manufacture a second, forged identifier either.
      const hostileMarker = '[gsd:dispatch phase="03" plan="03-02"]" phase="99"]';
      const result = parseDispatchIdentity(hostileMarker);
      assert.notEqual(result.phase, '99');
    });

    test('parse: large prompt terminates', (t) => {
      const filler = 'x'.repeat(100 * 1024);
      const text = `${filler}[gsd:dispatch phase="03" plan="03-02-hardening"]`;
      const result = parseDispatchIdentity(text);
      assert.equal(result.phase, '03');
      assert.equal(result.plan, '03-02-hardening');
      // Backstop against catastrophic backtracking, not a timing assertion:
      // this test's own node:test timeout is the enforcement mechanism.
      t.diagnostic('parse completed within the test timeout on a 100KB input');
    });

    test('parse: scans every supplied text in order', () => {
      const result = parseDispatchIdentity('', '[gsd:dispatch phase="03" plan="03-02-hardening"]');
      assert.equal(result.phase, '03');
      assert.equal(result.plan, '03-02-hardening');
      assert.equal(result.source, 'marker');
    });
  });

  describe('render: omission rules', () => {
    test('render: unusable values (quote or bracket) are omitted', () => {
      assert.equal(renderDispatchIdentityMarker({ phase: '03', plan: 'has"quote' }), '[gsd:dispatch phase="03"]');
      assert.equal(renderDispatchIdentityMarker({ phase: '03', plan: 'has]bracket' }), '[gsd:dispatch phase="03"]');
      assert.equal(renderDispatchIdentityMarker({ phase: 'ba"d', plan: '03-02' }), '[gsd:dispatch plan="03-02"]');
    });

    test('render: absent or empty values are omitted, and both-absent renders empty string', () => {
      assert.equal(renderDispatchIdentityMarker({ phase: '03' }), '[gsd:dispatch phase="03"]');
      assert.equal(renderDispatchIdentityMarker({ plan: '03-02-hardening' }), '[gsd:dispatch plan="03-02-hardening"]');
      assert.equal(renderDispatchIdentityMarker({ phase: '', plan: '' }), '');
      assert.equal(renderDispatchIdentityMarker({}), '');
    });
  });

  describe('sentinelAppliesToDispatch end-state behavior (hooks/lib/isolation-sentinel.js)', () => {
    test('applies: prose dispatch no longer false-mismatches on plan', () => {
      // THE regression, #4594 rows 2/4: a fresh sentinel carrying the
      // phase-prefixed, slugged plan id must still apply to a dispatch whose
      // only identity source is the prose prompt-body form.
      const dispatchIds = extractDispatchIdentifiers(PROMPT_BODY_FORM);
      assert.equal(sentinelAppliesToDispatch(MEASURED_SENTINEL, dispatchIds), true);
    });

    test('applies: marker for another plan is rejected', () => {
      const dispatchIds = parseDispatchIdentity('[gsd:dispatch phase="03" plan="03-01-setup"]');
      assert.equal(sentinelAppliesToDispatch(MEASURED_SENTINEL, dispatchIds), false);
    });

    test('applies: marker for another phase is rejected', () => {
      const dispatchIds = parseDispatchIdentity('[gsd:dispatch phase="04" plan="03-02-hardening"]');
      assert.equal(sentinelAppliesToDispatch(MEASURED_SENTINEL, dispatchIds), false);
    });

    test('applies: a missing value is never a mismatch', () => {
      assert.equal(sentinelAppliesToDispatch(MEASURED_SENTINEL, { phase: null, plan: null }), true);
      assert.equal(sentinelAppliesToDispatch({ phase: '03', plan: null }, { phase: '03', plan: '03-02-hardening' }), true);
      assert.equal(sentinelAppliesToDispatch({ phase: null, plan: '03-02-hardening' }, { phase: '99', plan: null }), true);
    });

    test('extractDispatchIdentifiers still returns exactly {plan, phase}', () => {
      const result = extractDispatchIdentifiers(DESCRIPTION_FORM);
      assert.deepEqual(Object.keys(result).sort(), ['phase', 'plan']);
    });
  });

  describe('cold-tree load (#3582-style standing constraint)', () => {
    test('cold tree: the owner module has no compiled-lib dependency', () => {
      const probe = `
        const Module = require('module');
        const originalLoad = Module._load;
        Module._load = function patchedLoad(request, parent, isMain) {
          if (typeof request === 'string' && (
            request.includes('gsd-core/bin/lib') ||
            request.includes('ensure-runtime-build')
          )) {
            throw new Error('FORBIDDEN cold-tree require: ' + request);
          }
          return originalLoad.call(this, request, parent, isMain);
        };
        const owner = require(${JSON.stringify(path.join(REPO_ROOT, 'hooks', 'lib', 'dispatch-identity.js'))});
        const marker = owner.renderDispatchIdentityMarker({ phase: '03', plan: '03-02-hardening' });
        const parsed = owner.parseDispatchIdentity(marker);
        if (parsed.phase !== '03' || parsed.plan !== '03-02-hardening') {
          throw new Error('cold-tree round-trip failed: ' + JSON.stringify(parsed));
        }
        process.stdout.write('OK');
      `;

      const output = execFileSync(process.execPath, ['-e', probe], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: COLD_TREE_PROBE_TIMEOUT_MS,
      });
      assert.equal(output, 'OK');
    });
  });

  describe('producer/consumer parity', () => {
    test('templates: every producer\'s marker parses', () => {
      // Rendered with the same measured shell values the sentinel records
      // ($PHASE_NUMBER, $plan_id) — see 40-design.md's "Ground truth" section.
      const rendered = renderDispatchIdentityMarker(MEASURED_SENTINEL);
      const parsed = parseDispatchIdentity(rendered);
      assert.deepEqual(parsed, { phase: MEASURED_SENTINEL.phase, plan: MEASURED_SENTINEL.plan, source: 'marker' });
    });

    test('templates: prose token source matches the case-flexible phase-id grammar', () => {
      // Parity guard, matrix row 34: DISPATCH_PHASE_TOKEN_SOURCE is a hand
      // mirror of gsd-core/bin/lib/phase-id.cjs's
      // CASE_FLEXIBLE_PHASE_NUMBER_TOKEN_SOURCE. The mirror exists because
      // hooks/lib/dispatch-identity.js must load on a cold tree with no
      // compiled `gsd-core/bin/lib/` present (see the cold-tree test above),
      // so it cannot `require()` the compiled module directly — it restates
      // the same regex source string instead. A hand-edited grammar change
      // on one side that is not mirrored on the other does NOT fail loudly:
      // both sides remain independently valid regex sources, so the failure
      // mode is a silent, invisible non-match (a dispatch whose phase token
      // the two owners now parse differently), not a thrown error. Pinning
      // this equality is the only thing that turns that drift into a loud,
      // in-CI failure. Loaded only here, not at module scope, so this
      // file's own MODULE_NOT_FOUND failure mode (before
      // hooks/lib/dispatch-identity.js exists) is not masked by a require
      // ordering accident.
      const { CASE_FLEXIBLE_PHASE_NUMBER_TOKEN_SOURCE } = require(
        path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'phase-id.cjs'),
      );
      assert.equal(DISPATCH_PHASE_TOKEN_SOURCE, CASE_FLEXIBLE_PHASE_NUMBER_TOKEN_SOURCE);
    });
  });
});
