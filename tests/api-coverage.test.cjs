/**
 * Tests for the API-coverage detector + matrix validator (#1562).
 *
 * Two pure functions under test, both returning typed IR (asserted, never
 * text-matched on prose):
 *   - detectApiIntegration(text) -> { detected, signals, terms }
 *   - validateCoverageMatrix(text) -> { valid, errors, counts }
 *
 * Acceptance-criterion mapping:
 *   #2 (opt-out needs reason; un-enumerated blocks) → validateCoverageMatrix suite
 *   #4 (non-API phases unaffected, low false-positive) → false-positive suite
 *   Matrix parse/render bijectivity → fast-check property
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fc = require('fast-check');

const MODULE_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'api-coverage.cjs');

// Shared row-shape generators for the coverage-matrix property tests below
// (the parse/render bijection and the #2371 document-shaped property both
// build matrices from the same canonical row shape — a single declaration
// here means the two properties can't silently desync).
const capabilityGen = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/);
const rowGen = fc.record({
  capability: capabilityGen,
  decision: fc.constantFrom('INTEGRATE', 'OPT-OUT'),
  // Reasons are short prose (e.g. "not needed yet"). The matrix is a
  // markdown table, so cell text is format-safe: no pipes / newlines.
  reason: fc.stringMatching(/^[a-z0-9 ,.\-!?]{0,20}$/),
});
// OPT-OUT rows must carry a non-empty reason for the round-trip to validate.
const validRowGen = rowGen.map((r) =>
  r.decision === 'OPT-OUT' && r.reason.trim() === ''
    ? { ...r, reason: 'because' }
    : { ...r, reason: r.reason.trim() }
);

describe('detectApiIntegration — pure detector (#1562)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(
      `Could not require ${MODULE_PATH}. Run "npm run build:lib" first. Underlying: ${err.message}`
    );
  }
  const { detectApiIntegration, DEFAULT_API_COVERAGE_TERMS } = mod;

  test('result shape — always carries detected, signals[], terms', () => {
    const r = detectApiIntegration('refactor the login function');
    assert.strictEqual(r.detected, false);
    assert(Array.isArray(r.signals));
    assert.strictEqual(r.signals.length, 0);
    assert.ok(r.terms && Array.isArray(r.terms.verbs));
    assert.ok(Array.isArray(r.terms.nouns));
  });

  test('non-string input degrades to {detected:false} without throwing', () => {
    assert.strictEqual(detectApiIntegration(undefined).detected, false);
    assert.strictEqual(detectApiIntegration(null).detected, false);
    assert.strictEqual(detectApiIntegration(42).detected, false);
    assert.strictEqual(detectApiIntegration({}).detected, false);
  });

  test('empty / whitespace-only input does not fire', () => {
    assert.strictEqual(detectApiIntegration('').detected, false);
    assert.strictEqual(detectApiIntegration('   \n\t  ').detected, false);
  });

  test('terms echo is the effective set actually used', () => {
    const r = detectApiIntegration('nothing relevant here');
    assert.deepStrictEqual(r.terms.verbs, [...DEFAULT_API_COVERAGE_TERMS.verbs]);
    assert.deepStrictEqual(r.terms.nouns, [...DEFAULT_API_COVERAGE_TERMS.nouns]);
  });

  test('terms override — explicit verbs+nouns replace defaults', () => {
    const r = detectApiIntegration('xyzzy the frobninator', { verbs: ['xyzzy'], nouns: ['frobninator'] });
    assert.deepStrictEqual(r.terms.verbs, ['xyzzy']);
    assert.deepStrictEqual(r.terms.nouns, ['frobninator']);
    assert.strictEqual(r.detected, true);
  });

  // ── Positive: compound verb+noun (acceptance #1 trigger) ─────────────────
  for (const scope of [
    'Integrate the Stripe API for payment processing',
    'Wrap the GitHub GraphQL API for issue triage',
    'Connect to the SendGrid REST endpoint for transactional email',
    'Consume the billing service over gRPC',
    'Wire up the Slack webhook for deploy notifications',
    'Onboard the Twilio SDK for SMS',
    'integrate oauth for login',
  ]) {
    test(`POSITIVE fires on: "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true, `expected detection for: ${scope}`);
      assert.ok(r.signals.length > 0);
      assert.ok(r.signals.every((s) => s.snippet.length > 0));
    });
  }

  // ── Positive: explicit <Service> API|SDK surface (no verb needed) ────────
  for (const scope of ['Add a Spotify API client', 'Ship the Notion SDK helper']) {
    test(`POSITIVE (surface) fires on: "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true);
      assert.ok(r.signals.some((s) => s.verb === '(surface)'));
    });
  }

  // ── Negative: false-positive guards (acceptance #4 — the crux) ───────────
  // Each of these is a phase that is NOT an external-API integration. The
  // detector must stay silent. The "public API of UserController" case is the
  // canonical FP trap: "api" is present but there is no integration verb.
  for (const [label, scope] of [
    ['internal API mention', 'The public API of the UserController should accept pagination params'],
    ['refactor', 'Refactor the authentication module to use bcrypt'],
    ['feature toggle', 'Add a dark mode toggle to the settings page'],
    ['bug fix', 'Fix the off-by-one error in the pagination helper'],
    ['docs', 'Update the README to document the config options'],
    ['internal client code', 'Add a client-side helper to debounce input'],
    ['bare noun no verb', 'We expose a REST-ish JSON shape already'],
    ['bare verb no noun', 'We will integrate the new design system tokens'],
  ]) {
    test(`NEGATIVE does not fire (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `unexpected detection for [${label}]: ${scope}`);
    });
  }

  test('fenced code blocks are stripped — trigger inside a code fence does not fire', () => {
    const scope = [
      'Refactor the helpers.',
      '',
      '```bash',
      '# integrate the Stripe API (example command in docs)',
      '```',
      '',
      'No integration in this phase.',
    ].join('\n');
    assert.strictEqual(detectApiIntegration(scope).detected, false);
  });

  // ── H1 fix (#1562 code review): capitalized sentence starters must not fire
  // the <Service> API/SDK surface rule. These are common English, not services.
  for (const [label, scope] of [
    ['The API', 'The API documentation needs updating.'],
    ['An SDK', 'An SDK is already present in the repo.'],
    ['Our REST', 'Our REST endpoints return JSON.'],
    ['This GraphQL', 'This GraphQL schema is internal.'],
    ['New API', 'New API surface was added by the refactor.'],
  ]) {
    test(`NEGATIVE (stopword) does not fire (${label}): "${scope}"`, () => {
      assert.strictEqual(detectApiIntegration(scope).detected, false);
    });
  }

  test('compound signal fires when verb and noun are on the same line only', () => {
    const sameLine = 'Phase A integrates things.\nLater we mention an api.';
    const splitLine = 'Phase A integrates things.\nLater we mention an api here too.';
    assert.strictEqual(detectApiIntegration(sameLine).detected, false);
    assert.strictEqual(detectApiIntegration(splitLine).detected, false);
    assert.strictEqual(detectApiIntegration('integrates the api').detected, true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Matrix parse / validate / render
// ──────────────────────────────────────────────────────────────────────────────

describe('coverage matrix — parse / validate (#1562 acceptance #2)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib". Underlying: ${err.message}`);
  }
  const { parseCoverageMatrix, validateCoverageMatrix, renderCoverageMatrix } = mod;

  test('parse markdown table — header + 2 rows', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| playlists | OPT-OUT | not needed yet |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.format, 'table');
    assert.strictEqual(p.rows.length, 2);
    assert.strictEqual(p.rows[0].capability, 'search');
    assert.strictEqual(p.rows[0].decision, 'INTEGRATE');
    assert.strictEqual(p.rows[1].decision, 'OPT-OUT');
    assert.strictEqual(p.rows[1].reason, 'not needed yet');
    assert.strictEqual(p.errors.length, 0);
  });

  test('parse fenced ```coverage JSON block', () => {
    const md = [
      'Some prose.',
      '',
      '```coverage',
      '[{"capability":"search","decision":"INTEGRATE","reason":""},',
      ' {"capability":"skip","decision":"OPT-OUT","reason":"out of scope"}]',
      '```',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.format, 'json');
    assert.strictEqual(p.rows.length, 2);
    assert.strictEqual(p.errors.length, 0);
  });

  test('parse empty / non-matrix input → format none, no rows, no errors', () => {
    const p = parseCoverageMatrix('# Notes\n\nNothing here.');
    assert.strictEqual(p.format, 'none');
    assert.strictEqual(p.rows.length, 0);
    assert.strictEqual(p.errors.length, 0);
  });

  test('parse non-string → empty result, no throw', () => {
    const p = parseCoverageMatrix(undefined);
    assert.strictEqual(p.rows.length, 0);
  });

  test('parse rejects malformed fenced JSON with an error', () => {
    const md = '```coverage\n{not json}\n```';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.format, 'json');
    assert.ok(p.errors.length > 0);
    assert.strictEqual(p.rows.length, 0);
  });

  // ── validate: boundaries 0 / 1 / 2 rows (limit-1, limit, limit+1) ────────
  test('validate — empty matrix is invalid (acceptance #1: surface must be enumerated)', () => {
    const v = validateCoverageMatrix('| capability | decision | reason |\n|---|---|---|');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /empty/i.test(e)));
    assert.strictEqual(v.counts.surface, 0);
  });

  test('validate — single INTEGRATE row is valid (limit)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| search | INTEGRATE | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.counts.surface, 1);
    assert.strictEqual(v.counts.integrate, 1);
    assert.strictEqual(v.counts.optout, 0);
  });

  test('validate — two rows valid (limit+1)', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| playlists | OPT-OUT | not needed |',
    ].join('\n');
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.counts.surface, 2);
    assert.strictEqual(v.counts.optout, 1);
  });

  // ── acceptance #2: every OPT-OUT must carry a reason ─────────────────────
  test('validate — OPT-OUT without reason is INVALID (acceptance #2)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| skip | OPT-OUT | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /missing reason/i.test(e)));
  });

  test('validate — OPT-OUT with one-char reason is valid (boundary)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| skip | OPT-OUT | x |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true);
  });

  test('validate — duplicate capability is invalid (matrix is a set of decisions)', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| Search | OPT-OUT | dup |',
    ].join('\n');
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /duplicate/i.test(e)));
  });

  test('validate — empty capability name is invalid', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n|  | INTEGRATE | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /empty capability/i.test(e)));
  });

  // ── review-fix coverage: parser robustness (#1562 code review M1/M2/L1/L2) ──
  test('validate — invalid decision cell in a table row is an error, not silently dropped (M1)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| x | INTEGRAT | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /not in \{INTEGRATE, OPT-OUT\}/i.test(e)));
  });

  test('validate — a pipe in a cell adds extra columns → invalid (M2)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| x | OPT-OUT | a|b |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /columns|pipe/i.test(e)));
  });

  test('validate — a pipe in a JSON-fence reason → invalid (M2)', () => {
    const md = '```coverage\n[{"capability":"x","decision":"OPT-OUT","reason":"a|b"}]\n```';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
  });

  test('validate — capability over the length cap → invalid (S3 bound)', () => {
    const longCap = 'x'.repeat(81);
    const md = `| capability | decision | reason |\n|---|---|---|\n| ${longCap} | INTEGRATE | |`;
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /exceeds/i.test(e)));
  });

  test('parse — case-insensitive ```Coverage fence is accepted (L1)', () => {
    const md = '```Coverage\n[{"capability":"a","decision":"INTEGRATE","reason":""}]\n```';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.format, 'json');
    assert.strictEqual(p.rows.length, 1);
  });

  test('parse — a single-dash cell is not mistaken for a separator (L2)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| - | INTEGRATE | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.counts.surface, 1);
    assert.ok(v.valid, 'a capability named "-" is legal');
  });

  // ── render round-trip (manual) ───────────────────────────────────────────
  test('render → parse round-trips a valid matrix', () => {
    const rows = [
      { capability: 'search', decision: 'INTEGRATE', reason: '' },
      { capability: 'playlists', decision: 'OPT-OUT', reason: 'not needed yet' },
    ];
    const rendered = renderCoverageMatrix(rows);
    const v = validateCoverageMatrix(rendered);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.counts.surface, 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Property test: parse/render bijectivity (RULESET.TESTS property-based)
// ──────────────────────────────────────────────────────────────────────────────

describe('coverage matrix — parse/render bijection (fast-check)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib". Underlying: ${err.message}`);
  }
  const { renderCoverageMatrix, validateCoverageMatrix } = mod;

  test('any valid row set renders and re-validates to the same counts', () => {
    const matrixGen = fc.uniqueArray(validRowGen, {
      minLength: 1,
      maxLength: 8,
      selector: (r) => r.capability.toLowerCase(),
    });
    fc.assert(
      fc.property(matrixGen, (rows) => {
        const rendered = renderCoverageMatrix(rows);
        const v = validateCoverageMatrix(rendered);
        // Injected reason guarantees validity; any invalid result is a parser bug.
        assert.strictEqual(v.valid, true);
        assert.strictEqual(v.counts.surface, rows.length);
        return true;
      }),
      { numRuns: 100 }
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Document-shaped property (#2371): the bijection test above generates ROWS and
// renders them through the writer, so the document shape is a constant — it
// cannot generate a second table, a decoy table, or surrounding prose, and so
// cannot fail against #2366's bugs. This property generates the DOCUMENT
// space instead: a canonical matrix interleaved with content a real
// COVERAGE.md may legitimately contain that is NOT the matrix. See
// tests/fixtures/representative/README.md and CONTRIBUTING.md's "Fixture
// provenance" section for the full rationale.
// ──────────────────────────────────────────────────────────────────────────────

describe('coverage matrix — document-shaped fast-check (extract-exactly-canonical, #2371)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib" first. Underlying: ${err.message}`);
  }
  const { parseCoverageMatrix, renderCoverageMatrix } = mod;

  // Uses the shared capabilityGen/rowGen/validRowGen declared at module scope
  // above (same generators the bijection test uses), so the two properties
  // exercise the same canonical-row space and can't silently desync.
  const canonicalMatrixGen = fc.uniqueArray(validRowGen, {
    minLength: 1,
    maxLength: 5,
    selector: (r) => r.capability.toLowerCase(),
  });

  // Decoy blocks: content a document may legitimately contain that is NOT the
  // canonical matrix. Kept to three explicit, independently-readable shapes
  // rather than a generic "random markdown" generator — a combinatorial but
  // opaque generator is exactly the kind of cleverness that's unrunnable to
  // debug when it fails (Kernighan's Law).
  const proseDecoyGen = fc.constantFrom(
    '## Notes\n\nSee the ADR for background.',
    'This phase also touches the auth helper.',
    '## Risks\n\n- Rollout risk is low.',
  );

  const summaryTableDecoyGen = fc
    .record({
      label: fc.stringMatching(/^[a-z][a-z0-9 ]{0,10}$/),
      integrateCount: fc.nat({ max: 50 }),
      optoutCount: fc.nat({ max: 50 }),
    })
    .map(
      ({ label, integrateCount, optoutCount }) =>
        `## Coverage summary\n\n| tier | INTEGRATE | OPT-OUT |\n|---|---|---|\n` +
        `| ${label} | ${integrateCount} | ${optoutCount} |`
    );

  const secondSectionMatrixGen = fc
    .uniqueArray(validRowGen, { minLength: 1, maxLength: 3, selector: (r) => r.capability.toLowerCase() })
    .map((rows) => `## Transferred to a later phase\n\n${renderCoverageMatrix(rows)}`);

  const decoyGen = fc.oneof(proseDecoyGen, summaryTableDecoyGen, secondSectionMatrixGen);

  const documentGen = fc.record({
    canonicalRows: canonicalMatrixGen,
    decoysBefore: fc.array(decoyGen, { maxLength: 2 }),
    decoysAfter: fc.array(decoyGen, { maxLength: 2 }),
  });

  test(
    'given a document containing exactly one canonical matrix plus arbitrary other content, ' +
      'the parser extracts exactly that matrix\'s rows and ignores everything else',
    {
      todo:
        '#2366 — parseCoverageMatrix scans every |-prefixed line file-wide with no table scoping; ' +
        'a decoy summary table or a second canonical-schema section corrupts the result or spuriously ' +
        'errors. Remove this todo once #2366 lands — a still-red result after removal means the fix ' +
        'did not cover this case.',
    },
    () => {
      fc.assert(
        fc.property(documentGen, ({ canonicalRows, decoysBefore, decoysAfter }) => {
          const canonicalBlock = renderCoverageMatrix(canonicalRows);
          const doc = [...decoysBefore, canonicalBlock, ...decoysAfter].join('\n\n');

          const result = parseCoverageMatrix(doc);

          const expectedByCap = new Map(canonicalRows.map((r) => [r.capability.toLowerCase(), r]));
          const actualByCap = new Map(result.rows.map((r) => [r.capability.toLowerCase(), r]));

          assert.strictEqual(
            actualByCap.size,
            expectedByCap.size,
            `expected exactly ${expectedByCap.size} row(s), got ${actualByCap.size}: ${JSON.stringify(result.rows)}`
          );
          for (const [cap, expected] of expectedByCap) {
            const actual = actualByCap.get(cap);
            assert.ok(actual, `canonical capability "${cap}" missing from parsed rows`);
            assert.strictEqual(actual.decision, expected.decision);
          }
          assert.strictEqual(
            result.errors.length,
            0,
            `decoy content must be ignored, not error: ${JSON.stringify(result.errors)}`
          );
          return true;
        }),
        { numRuns: 100 }
      );
    }
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point (STDIN → exit codes mirror grep, like assumption-delta)
// ──────────────────────────────────────────────────────────────────────────────

describe('api-coverage CLI — STDIN + exit codes', () => {
  const CLI = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'api-coverage.cjs');

  function runCli(stdin) {
    const r = spawnSync(process.execPath, [CLI, '--json'], {
      input: stdin,
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test('exit 0 + JSON IR when integration detected', () => {
    const r = runCli('Integrate the Stripe API for payments');
    assert.strictEqual(r.exitCode, 0);
    const body = JSON.parse(r.stdout);
    assert.strictEqual(body.detected, true);
    assert.ok(Array.isArray(body.signals));
  });

  test('exit 1 when no integration', () => {
    const r = runCli('Refactor the login helper');
    assert.strictEqual(r.exitCode, 1);
  });
});
