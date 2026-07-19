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
// #2365 — detector false positives (first-party paths, unrelated same-line
// clauses, descriptive "API" prose) + the no-integration declaration.
// ──────────────────────────────────────────────────────────────────────────────

describe('#2365 detector false positives + no-integration declaration', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib". Underlying: ${err.message}`);
  }
  const { detectApiIntegration, parseCoverageMatrix, validateCoverageMatrix } = mod;

  // ── acceptance #1: first-party framework route paths are not integration prose
  for (const [label, scope] of [
    ['Next.js route file in prose', 'Run integration tests for src/app/api/profile/route.test.ts'],
    ['route handler path with verb', 'Wire the src/app/api/profile/route.ts handler into the settings page'],
    ['inline-code span', 'Verify the `api` helper wiring end to end'],
  ]) {
    test(`NEGATIVE path/inline-code (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `unexpected detection for [${label}]: ${scope}`);
    });
  }

  // ── acceptance #2: verb + noun in unrelated clauses of one line
  test('NEGATIVE unrelated clauses: verb and noun in different clauses do not compound', () => {
    const r = detectApiIntegration(
      'Render the page and prove label endpoint, filename, and CSV/XLSX wiring.'
    );
    assert.strictEqual(r.detected, false);
  });

  // ── acceptance #3: descriptive/local "API" prose (threat-model shape).
  //    NOTE: the detector is FAIL-CLOSED — the classes below stay clean because
  //    they are unambiguously NOT external integration (no integration verb + a
  //    named service, or a first-party-qualified surface). Prose that pairs an
  //    integration VERB with an API noun ("wire … the internal endpoint") is a
  //    fail-closed POSITIVE now (see the "#2365 review — fail-open fixes" group);
  //    a one-line COVERAGE.md declaration dismisses it if it is a false alarm.
  for (const [label, scope] of [
    ['threat-model table cell', '| Tampering | Resolver-only API rejects arbitrary caller URLs. |'],
    ['compound-modifier mid-sentence', 'The Resolver-only API rejects arbitrary caller URLs.'],
    ['clause-initial capitalized prose', 'Internal API surface stays unchanged in this phase.'],
    ['localhost URL', 'Run integration tests against https://localhost:3000/api/profile'],
    ['bare external domain, no path', 'Integrate the design tokens from https://example.com into the theme'],
    ['internal-qualified service (no verb)', 'The internal Payments API remains unchanged.'],
    ['descriptor service + unrelated URL', 'Internal API surface stays unchanged; see https://example.com/style-guide.'],
    ['Windows path', 'Wire tests for src\\app\\api\\profile\\route.ts.'],
    ['loopback shorthand URL', 'Connect tests to http://127.1:3000/api/profile.'],
    ['protocol-only surface', 'Document the REST API behavior for maintainers.'],
    ['protocol-only surface (GraphQL)', 'Review the GraphQL API schema naming conventions.'],
    ['cross-clause coordinate action', 'Wire the header, then update the endpoint docs'],
  ]) {
    test(`NEGATIVE descriptive API prose (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `unexpected detection for [${label}]: ${scope}`);
    });
  }

  // ── acceptance #4: true positives preserved (the fail-open guard — a fix that
  // silences these is strictly worse than the false positives it removes).
  for (const [label, scope] of [
    ['canonical compound', 'integrate the Stripe API'],
    ['compound with trailing prose', 'Integrate the Stripe API for payment processing'],
    ['surface rule, no verb', 'Add a Spotify API client'],
    ['widest default-suite word gap', 'Consume the billing service over gRPC'],
    ['clause-initial service + URL corroboration', 'Stripe API — docs at https://stripe.com/docs/api'],
    ['webhook compound', 'Wire up the Slack webhook for deploy notifications'],
    ['verb + API-naming URL', 'Connect the app to https://api.stripe.com/v1 for charges'],
    ['slashed noun shorthand', 'Integrate the Stripe API/SDK for payments'],
    ['long single-clause gap', "Connect our checkout to Stripe's hosted payment processing service through its v1 endpoints."],
    ['non-http URI scheme', 'Connect the realtime client to wss://api.openai.com/v1/realtime.'],
    ['versioned noun shorthand', 'Integrate Stripe API/v2 for legacy payments.'],
    ['clause-initial service + object follower', 'Stripe API client for payments.'],
    ['inline-code package corroboration', 'Stripe SDK client via `@stripe/stripe-js` for payment intents.'],
    ['inline-code package as only noun', 'Integrate `stripe-sdk` for payment intents.'],
    ['later surface after rejected first candidate', 'Internal API facade around Stripe SDK payment flows.'],
    ['later surface after rejected modifier', 'Resolver-only API facade delegates to Stripe SDK for payments.'],
  ]) {
    test(`POSITIVE still fires (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true, `true-positive regression [${label}]: ${scope}`);
    });
  }

  // ── #2365 review — fail-open fixes. Codex's second-round review found the
  //    round-2 tightening had over-corrected into FAIL-OPEN false negatives:
  //    realistic external-API prose that a BLOCKING gate silently let through.
  //    Under the fail-closed decision these MUST detect. This is the guard the
  //    handoff flagged in bold — a fix that lets these slip is strictly worse
  //    than the false positives it removes.
  for (const [label, scope] of [
    ['clause-initial service, plain follower (F1)', 'Stripe API for payment processing.'],
    ['external host that names an API vocab word (F2)', 'Connect the client to api.stripe.com/v1 for charges.'],
    ["vendor's first-party SDK (F3)", "Integrate Shopify's first-party SDK for checkout."],
    ['long single integration clause (F4)', "Integrate Stripe's hosted payment processing service into checkout using the vendor-recommended asynchronous flow for recurring subscriptions and one-time card payments through its API."],
    // Fail-closed reversal of the round-2 "internal" negatives: an integration
    // verb bound to an API noun detects even when the noun is "internal"-qualified
    // (Codex: "internal" can name the vendor's own API). Dismissed by declaration.
    ['integration verb + internal noun', 'Wire the settings form to the internal endpoint.'],
    ['coordinated integration verb + internal noun', 'Wire the form and document the internal API.'],
    ['distant same-clause verb+noun', 'Wiring the settings drawer means the profile page the sidebar and the account menu all reach the same internal endpoint'],
    // Qualification must NOT leak across a sentence/clause boundary.
    ['qualifier does not leak across a sentence', 'The cache is private. Stripe API client for payments.'],
    ['qualifier does not leak across a semicolon', 'Keep the cache private; Stripe API client for payments.'],
  ]) {
    test(`POSITIVE fail-open guard (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true, `fail-open regression [${label}]: ${scope}`);
    });
  }

  // ── #2365 review — false-positive fixes. The reviews found false positives
  //    from over-broad heuristics; these MUST stay clean.
  for (const [label, scope] of [
    ['bare external domain, no path (F6)', 'Integrate the design tokens from https://example.com, document the endpoint terminology.'],
    ['internal UI component, separate action (F7)', 'Wire the SettingsForm, then document the endpoint props.'],
    ['protocol name as service (F8)', 'Document the REST API behavior for maintainers.'],
    ['finite continuation after a period', 'Wire the settings form. Document endpoint props.'],
    ['finite continuation after a semicolon', 'Wire the settings form; document endpoint props.'],
    ['finite continuation after a comma', 'Wire the form, document endpoint props.'],
    // Round-4 review: an external asset/link URL is NOT an API endpoint.
    ['external stylesheet asset URL', 'Wire stylesheet from https://cdn.example.com/assets/theme.css into the page.'],
    ['external URL with a query string', 'Wire the login link to https://example.com?next=/dashboard.'],
    ['external docs/repo link, not an API', 'Wire the docs link to https://github.com/org/repo into the footer'],
    // Round-4 review: an "-ing"-SPELLED noun ("billing") is not a participle.
    ['-ing-spelled noun in an unrelated clause', 'Wire the new settings form component, billing endpoint terminology remains unchanged.'],
    // Round-4 review: qualification survives markdown emphasis.
    ['descriptor qualifies through markdown emphasis', 'The **internal** Payments API remains unchanged.'],
  ]) {
    test(`NEGATIVE fail-closed FP guard (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `new false positive [${label}]: ${scope}`);
    });
  }

  // ── #2365 — DOCUMENTED fail-open LIMITATIONS. Detection is same-clause only
  //    (no cross-clause binding) and an external host is evidence only when it
  //    NAMES an API vocabulary word. Catching the cases below robustly needs a
  //    vendor dictionary + coreference, which the issue rules out in principle;
  //    every lexical rule tried across four review rounds traded a false
  //    negative for a false positive. These are cheaply covered by the
  //    COVERAGE.md declaration and rare in real phase prose. The tests pin the
  //    behavior as INTENTIONAL — a future maintainer re-adding a cross-clause or
  //    every-URL heuristic would reintroduce the false positives above.
  for (const [label, scope] of [
    ['service named only in a following participial clause', 'Integrate Stripe, exposing its endpoints for payment capture.'],
    ['service named only in a following finite clause', 'Integrate Stripe; use its OAuth endpoints for checkout.'],
    ['bare external host naming no vocab word', 'Connect the client to graph.microsoft.com:443/v1.0/me.'],
  ]) {
    test(`DOCUMENTED fail-open limitation stays clean (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `limitation changed [${label}]: ${scope}`);
    });
  }

  // ── #2365 review — DOCUMENTED fail-closed tradeoffs. A clause-initial
  //    capitalized common word before "API" ("Payment API", "Search API") is
  //    treated as a service name, and a long clause pairs a verb with a distant
  //    noun. Codex judged these acceptable because the COVERAGE.md declaration
  //    is a cheap override; these tests exist so the behavior is INTENTIONAL and
  //    a future maintainer does not "fix" it back into a fail-open cap.
  for (const [label, scope] of [
    ['capitalized common word as service', 'Payment API remains unchanged in this refactor.'],
    ['capitalized common word as service (Search)', 'Search API types are generated locally.'],
    ['long clause pairs verb with distant noun', 'Wire the settings form to validation state so the designer can review field behavior and document every public API and endpoint symbol without changing runtime dependencies.'],
  ]) {
    test(`POSITIVE documented fail-closed tradeoff (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true, `expected documented fail-closed detection [${label}]: ${scope}`);
    });
  }

  // ── #2365 review finding 7: inline code spans are matched WITHIN a line by
  //    design (phase scope prose is line-oriented). A CommonMark code span that
  //    wraps a newline is NOT recognized, so its contents are treated as prose —
  //    a documented, narrow limitation (fail-closed: a stray detection is
  //    dismissed by the declaration). This test pins the current behavior.
  test('multi-line inline code span is not treated as code (documented limitation)', () => {
    const r = detectApiIntegration('Documentation example: `integrate\nStripe API` only.');
    assert.strictEqual(r.detected, true);
  });

  // ── acceptance #5: a legitimate, non-fabricated "no external API" declaration
  test('declaration-only COVERAGE.md is VALID with zero rows (none_declared)', () => {
    const md = '# API Coverage\n\nNo external API integration: UI-only phase, no third-party surface.\n';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true, `expected valid, errors: ${v.errors.join('; ')}`);
    assert.strictEqual(v.none_declared, true);
    assert.deepStrictEqual(v.counts, { surface: 0, integrate: 0, optout: 0 });
  });

  test('declaration accepts the bold/em-dash form', () => {
    const md = '**No external API integration** — resolver work is local-only.\n';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.none_declared, true);
  });

  test('declaration WITHOUT a reason is not recognized (reasoned opt-out, like OPT-OUT rows)', () => {
    const v = validateCoverageMatrix('No external API integration\n');
    assert.strictEqual(v.valid, false);
    assert.notStrictEqual(v.none_declared, true);
  });

  test('declaration PLUS coverage rows is contradictory → invalid', () => {
    const md = [
      'No external API integration: nothing external here.',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
    ].join('\n');
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /declar/i.test(e)), `errors: ${v.errors.join('; ')}`);
  });

  test('declaration inside a fenced code block is NOT recognized', () => {
    const md = '```markdown\nNo external API integration: example only.\n```\n';
    const p = parseCoverageMatrix(md);
    assert.notStrictEqual(p.declaration && p.declaration.none, true);
    const v = validateCoverageMatrix(md);
    assert.notStrictEqual(v.none_declared, true);
  });

  test('declaration inside an HTML comment is NOT recognized', () => {
    const md = '<!--\nNo external API integration: quoted example only.\n-->\n';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.notStrictEqual(v.none_declared, true);
  });

  test('blockquoted declaration is NOT recognized (quoted text is not a decision)', () => {
    const v = validateCoverageMatrix('> No external API integration: copied from the old PLAN.md.\n');
    assert.strictEqual(v.valid, false);
    assert.notStrictEqual(v.none_declared, true);
  });

  // ── A hostile line repeating one verb+noun pair thousands of times must
  //    collapse to a SINGLE signal — pairing is by distinct term, not a
  //    match×match cross product. Asserting the signal count is a deterministic
  //    proxy for that linearity (no wall-clock timing — Clock Seams rule).
  test('hostile repeated-term line dedups to one signal', () => {
    const s = 'integrate api '.repeat(10000); // 140 KB single line, 10k pairs
    const r = detectApiIntegration(s);
    assert.strictEqual(r.detected, true);
    assert.strictEqual(
      r.signals.length,
      1,
      `repeated verb+noun pair must dedup to one signal, got ${r.signals.length}`
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #2365 review — hardening-constant boundaries + parser fuzz property
// ──────────────────────────────────────────────────────────────────────────────

describe('#2365 hardening-constant boundaries + parser property', () => {
  const { detectApiIntegration, validateCoverageMatrix } = require(MODULE_PATH);

  // SERVICE_SURFACE_API_RE bounds the service token to `[A-Z][A-Za-z0-9_-]{1,40}`
  // (2..41 chars) so a hostile hyphen run cannot drive O(n^2) backtracking.
  test('surface service name at the 41-char limit still fires', () => {
    const svc = 'S' + 'a'.repeat(40); // exactly 41 chars
    assert.strictEqual(detectApiIntegration(`${svc} API`).detected, true);
  });
  test('surface service name at 42 chars is past the length bound (surface path)', () => {
    const svc = 'S' + 'a'.repeat(41); // 42 chars, no integration verb → surface-only
    assert.strictEqual(detectApiIntegration(`${svc} API`).detected, false);
  });

  // QUALIFIER_LOOKBACK (24): a first-party descriptor only suppresses the surface
  // within the bounded lookback window. Pin the EXACT constant: 8-char "internal"
  // + 16 spaces places its start at offset-24 (the window edge) → still qualifies;
  // + 17 spaces pushes its start one char outside → truncated → no longer
  // qualifies. Both would pass for any lookback in ~9..37, so use the exact pair.
  test('internal qualifier exactly at the 24-char window edge still suppresses the surface', () => {
    const atEdge = 'internal' + ' '.repeat(16) + 'Payments API'; // start at offset-24
    assert.strictEqual(detectApiIntegration(atEdge).detected, false);
  });
  test('internal qualifier one char past the 24-char window no longer qualifies (fires)', () => {
    const pastEdge = 'internal' + ' '.repeat(17) + 'Payments API'; // start at offset-25
    assert.strictEqual(detectApiIntegration(pastEdge).detected, true);
  });

  // REASON_MAX_LEN (200): the no-integration declaration reason is length-bounded.
  test('declaration reason at 200 chars is valid; 201 is rejected', () => {
    const at = 'No external API integration: ' + 'x'.repeat(200) + '\n';
    const over = 'No external API integration: ' + 'x'.repeat(201) + '\n';
    assert.strictEqual(validateCoverageMatrix(at).valid, true);
    const v = validateCoverageMatrix(over);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /exceeds 200 chars/.test(e)), `errors: ${v.errors.join('; ')}`);
  });

  // Fuzz the tokenizer / clause splitter / masking (scanLineTokens, splitClauses,
  // collectTermMatches) with adversarial tokens — slashes, backticks, URLs,
  // clause punctuation. The detector must never throw, keep its typed shape, hold
  // `detected ⇔ signals.length > 0`, and be deterministic on any input.
  test('property: parser is total, shape-stable, and deterministic on arbitrary prose', () => {
    const token = fc.oneof(
      fc.constantFrom(
        'integrate', 'connect', 'wire', 'the', 'Stripe', 'API', 'SDK', 'endpoint',
        'api', 'internal', 'Resolver-only', '/', '//', '`', 'https://api.x.com/v1',
        'src/app/api/x.ts', 'graph.microsoft.com/v1'
      ),
      fc.stringMatching(/^[A-Za-z0-9/.:`_-]{0,12}$/)
    );
    fc.assert(
      fc.property(
        fc.array(token, { maxLength: 40 }),
        fc.constantFrom(' ', ', ', '. ', '; ', ' | ', '\n'),
        (words, sep) => {
          const line = words.join(sep);
          const r = detectApiIntegration(line);
          assert.ok(typeof r.detected === 'boolean' && Array.isArray(r.signals), 'typed shape');
          assert.strictEqual(r.detected, r.signals.length > 0, 'detected ⇔ signals present');
          assert.deepStrictEqual(detectApiIntegration(line), r, 'deterministic');
          return true;
        }
      ),
      { numRuns: 300 }
    );
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

  // Decoy blocks: NON-Coverage content a document may legitimately contain
  // around the canonical matrix. Kept to two explicit, independently-readable
  // shapes rather than a generic "random markdown" generator — a combinatorial
  // but opaque generator is exactly the kind of cleverness that's unrunnable to
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

  // A CANONICAL-shaped coverage table written as a worked EXAMPLE inside a code
  // fence (#2366 re-review). It is stripped before the scan and must never be
  // parsed as real data — the project's own api-coverage-plan-pre.md fragment
  // demonstrates its format inside exactly such a fence.
  const fencedTableDecoyGen = fc
    .record({
      cap: fc.stringMatching(/^[a-z][a-z0-9 ]{0,12}$/),
      decision: fc.constantFrom('INTEGRATE', 'OPT-OUT'),
    })
    .map(
      ({ cap, decision }) =>
        '```markdown\n| Capability | Decision | Reason |\n|---|---|---|\n' +
        `| ${cap} | ${decision} | example |\n\`\`\``
    );

  // Decoys are NON-Coverage content only. A second CANONICAL-schema table is NOT
  // a decoy under #2366 — a coverage matrix may legitimately be section-split
  // across the document (the multi-table-with-summary corpus fixture expects the
  // transferred "widget" section's row to be INCLUDED, 3 rows total), so canonical
  // sections wherever they appear all contribute. A canonical-shaped table INSIDE
  // a fence, however, is a doc example and contributes NOTHING. This property
  // therefore asserts trek-e's exact request: N NON-Coverage tables (prose,
  // summary tables, AND fenced examples) around one real Coverage table → parse
  // exactly the Coverage table's rows.
  const decoyGen = fc.oneof(proseDecoyGen, summaryTableDecoyGen, fencedTableDecoyGen);

  const documentGen = fc.record({
    canonicalRows: canonicalMatrixGen,
    decoysBefore: fc.array(decoyGen, { maxLength: 2 }),
    decoysAfter: fc.array(decoyGen, { maxLength: 2 }),
  });

  // #2366 is fixed (this PR), so the invariant now HOLDS. This was the #2371
  // tripwire — a `fc.check` + `report.failed === true` characterization of the
  // bug; flipped to a real `fc.assert` exactly as that test's own comment
  // prescribed. It is also the table-scoping property requested in review: a
  // document embedding NON-Coverage decoy tables around one canonical matrix
  // parses to exactly that matrix's rows, no more/fewer, with no errors.
  test(
    'given a document containing exactly one canonical matrix plus arbitrary other content, ' +
      'the parser extracts exactly that matrix\'s rows and ignores everything else (#2366)',
    () => {
      fc.assert(
        fc.property(documentGen, ({ canonicalRows, decoysBefore, decoysAfter }) => {
          const canonicalBlock = renderCoverageMatrix(canonicalRows);
          const doc = [...decoysBefore, canonicalBlock, ...decoysAfter].join('\n\n');

          const result = parseCoverageMatrix(doc);

          // Length first — a Map keyed by capability would hide a parser that
          // emitted a duplicate row (canonicalRows are unique by capability).
          assert.strictEqual(result.rows.length, canonicalRows.length, `row count (dups/drops). doc:\n${doc}`);
          const actualByCap = new Map(result.rows.map((r) => [r.capability.toLowerCase(), r]));
          for (const expected of canonicalRows) {
            const actual = actualByCap.get(expected.capability.toLowerCase());
            assert.ok(actual, `missing capability "${expected.capability}". doc:\n${doc}`);
            assert.strictEqual(actual.decision, expected.decision, `decision for "${expected.capability}"`);
            assert.strictEqual(actual.reason, expected.reason, `reason for "${expected.capability}"`);
          }
          assert.strictEqual(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`);
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

describe('#2366 regression: the coverage matrix is ONE table, not every pipe-table in the file', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib". Underlying: ${err.message}`);
  }
  const { parseCoverageMatrix, validateCoverageMatrix, renderCoverageMatrix } = mod;

  // The headline defect. A COVERAGE.md may legitimately carry a summary table
  // ("how many did we integrate?"). Before the fix, that table's HEADER row
  // (`| tier | INTEGRATE | OPT-OUT |`) passed the decision check on cell 2 and
  // was pushed as a real capability row with NO error — inventing a covered
  // capability and inflating the INTEGRATE count while the blocking gate
  // reported success. A gate whose stated purpose is making un-built surface
  // visible must never fabricate surface; that inverts the feature.
  test('a summary table whose 2nd cell reads INTEGRATE is NOT absorbed as a capability row', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '',
      '## Coverage summary',
      '',
      '| tier | INTEGRATE | OPT-OUT |',
      '|---|---|---|',
      '| phase 8 | 12 | 6 |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['search'],
      'only the capability matrix may contribute rows');
    assert.ok(!p.rows.some((r) => r.capability === 'tier'),
      'the summary table header must never become a phantom capability row');
    assert.strictEqual(p.errors.length, 0,
      'an unrelated table is ignored outright — neither absorbed nor an error');
    assert.strictEqual(validateCoverageMatrix(md).counts.integrate, 1,
      'INTEGRATE count must reflect real capabilities only');
  });

  // Re-review defect (trek-e): the markdown-table scan ran on the RAW source, so
  // a canonical-shaped table written as a worked EXAMPLE inside a code fence — the
  // project's own api-coverage-plan-pre.md fragment does exactly this — was parsed
  // as real data with zero errors, reopening the silent-corruption class #2366
  // closed. The scan now runs on fence-stripped text.
  test('a canonical-shaped table inside a code fence is a doc example, never real data', () => {
    const md = [
      '# COVERAGE',
      '',
      'Write the matrix like this:',
      '',
      '```markdown',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| example-cap | INTEGRATE | sample |',
      '```',
      '',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows, [], 'a fenced example must contribute no rows');
    assert.strictEqual(p.errors.length, 0, 'a fenced example is ignored outright — not an error');
    assert.strictEqual(validateCoverageMatrix(md).counts.integrate, 0,
      'a fenced example must not inflate the INTEGRATE count');
  });

  // The real (unfenced) matrix still parses when a fenced example precedes it.
  test('a real matrix following a fenced example parses normally', () => {
    const md = [
      '```markdown',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| example-cap | OPT-OUT | sample |',
      '```',
      '',
      '## Actual coverage',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | real |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['search'],
      'only the unfenced matrix contributes; the fenced example is stripped');
    assert.strictEqual(p.errors.length, 0);
  });

  // A phase that splits transfers capabilities to its successor. Authors
  // section the matrix ("this phase" / "moved to 8.1"). The old single-latch
  // header check made the 2nd header parse as data -> decision "DECISION".
  test('two canonical header sections both parse, with no spurious decision error', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '',
      '## Transferred to a later phase',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| widget | OPT-OUT | deferred to 9 |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['search', 'widget']);
    assert.ok(!p.errors.some((e) => /"DECISION"/.test(e)),
      'a second canonical header is a header, not a malformed data row');
    assert.strictEqual(p.errors.length, 0);
  });

  // Bold renders correctly in every markdown viewer, so this failure was
  // invisible to anyone reading the file as rendered output.
  test('an emphasised decision parses identically to the bare value', () => {
    const bold = '| capability | decision | reason |\n|---|---|---|\n| skip | **OPT-OUT** | not needed yet |';
    const bare = '| capability | decision | reason |\n|---|---|---|\n| skip | OPT-OUT | not needed yet |';
    assert.deepStrictEqual(parseCoverageMatrix(bold).rows, parseCoverageMatrix(bare).rows);
    assert.strictEqual(parseCoverageMatrix(bold).errors.length, 0);
  });

  // Re-review minor (trek-e): the stray-delimiter check inside the rows used the
  // shared GFM `isDelimiterRow` (`-{1,}`), so an all-single-dash data row
  // (`| - | - | - |`) was misread as a second delimiter and TRUNCATED every row
  // after it. It must instead be rejected precisely (invalid decision) while the
  // rows that follow keep parsing — the check now requires a strong `-{3,}`.
  test('an all-single-dash data row is rejected precisely and does NOT truncate later rows', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | a |',
      '| - | - | - |',
      '| widget | OPT-OUT | b |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['search', 'widget'],
      'the dash row must not drop the valid row that follows it');
    assert.ok(!p.errors.some((e) => /unexpected delimiter/.test(e)),
      'a single-dash row is a malformed data row, not a delimiter');
    assert.ok(p.errors.some((e) => /decision "-"/.test(e)),
      'the dash row is surfaced as the precise invalid-decision error, not a truncation');
  });

  // Codex re-review: `isStrongDelimiterRow` must not collapse internal whitespace —
  // a SPACED-dash data row (`| - - - | … |`) is data, not a delimiter, and must not
  // truncate the rows after it (the exact class the strong-delimiter fix targets).
  test('a spaced-dash data row is not misread as a delimiter and does not truncate', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | a |',
      '| - - - | - - - | - - - |',
      '| widget | OPT-OUT | b |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['search', 'widget'],
      'a spaced-dash row must not drop the row that follows it');
    assert.ok(!p.errors.some((e) => /unexpected delimiter/.test(e)),
      'a spaced-dash row is not a delimiter');
  });

  // Codex re-review: stripping fenced lines outright would SPLICE a header to a
  // delimiter that a fence separated, fabricating a phantom table. Fence state is
  // tracked in-scan so a fence between a header and its delimiter still ends the
  // (orphan) header's table — no splice, no absorbed row.
  test('a code fence between a header and its delimiter does not splice a phantom table', () => {
    const md = [
      '| capability | decision | reason |',
      '```text',
      'barrier',
      '```',
      '|---|---|---|',
      '| ghost | INTEGRATE | spliced |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.ok(!p.rows.some((r) => r.capability === 'ghost'),
      'a fence-separated header must not glue to a later delimiter and absorb its rows');
    assert.ok(p.errors.some((e) => /not followed by a delimiter/.test(e)),
      'the orphan header (its delimiter hidden behind a fence) must error loudly');
  });

  // Codex re-review (round 2): a naive one-boolean fence toggle desyncs when a
  // ``` marker appears INSIDE a ~~~ fence — leaking the still-fenced rows and
  // dropping the real table after the true closer. The mask is built from the
  // shared CommonMark engine (`scanFencedBlocks`), which tracks delimiter char +
  // run length, so a mismatched inner marker is fence CONTENT, not a boundary.
  test('a mismatched fence marker inside a fence does not desync the scan', () => {
    const md = [
      '~~~text',
      '```literal-inside-tilde-fence',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| ghost | INTEGRATE | still fenced |',
      '~~~',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| real | INTEGRATE | after the real closer |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['real'],
      'the ~~~-fenced ghost row must stay fenced and the real table after the closer must parse');
    assert.ok(!p.rows.some((r) => r.capability === 'ghost'), 'no fenced row may leak in');
  });

  // A butted-on foreign table (its `|---|` delimiter, 3+ dashes) is still caught
  // and blocks — the strong-delimiter check must not weaken #2366's core guard.
  test('a real (3+ dash) delimiter butted on mid-rows is still caught as unexpected', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | a |',
      '|---|---|---|',
      '| ghost | INTEGRATE | absorbed? |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.ok(p.errors.some((e) => /unexpected delimiter/.test(e)),
      'a butted-on table delimiter must still be a loud error');
    assert.ok(!p.rows.some((r) => r.capability === 'ghost'),
      'the butted-on table\'s rows must not be absorbed');
  });

  // trek-e asked for a wide-row case alongside the existing 1/2-cell tests: a
  // 4-cell row is malformed (an unescaped pipe split a value, or an extra cell)
  // and must error loudly without truncating the rows after it.
  test('a wide (4-cell) row errors loudly and does not truncate following rows', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| a | INTEGRATE | r | EXTRA |',
      '| ok | OPT-OUT | z |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['ok'],
      'the wide row is rejected but the valid row after it still parses');
    assert.ok(p.errors.some((e) => /4 columns/.test(e)), 'the wide row must be a loud error');
  });

  // The template itself writes decisions backticked (`INTEGRATE`), so a user
  // copying the fragment's own example shape must not be rejected.
  test('a backticked decision (the template\'s own shape) parses', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| search | `INTEGRATE` | |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 1);
    assert.strictEqual(p.rows[0].decision, 'INTEGRATE');
    assert.strictEqual(p.errors.length, 0);
  });

  // The reporter's verbatim 15-line reproduction: expected 3 rows / 0 errors.
  test('the filed reproduction parses to exactly {search, skip, widget} with no errors', () => {
    const md = [
      '# API Coverage — demo',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| skip | **OPT-OUT** | not needed yet |',
      '',
      '## Transferred to a later phase',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| widget | OPT-OUT | deferred to 9 |',
      '',
      '## Coverage summary',
      '',
      '| tier | INTEGRATE | OPT-OUT |',
      '|---|---|---|',
      '| phase 8 | 12 | 6 |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['search', 'skip', 'widget']);
    assert.strictEqual(p.errors.length, 0);
  });

  // Boundary: a file with NO coverage table must stay "none"/empty rather than
  // scavenging rows from whatever tables happen to be present.
  test('a file with tables but no canonical header yields no rows', () => {
    const md = '| tier | INTEGRATE | OPT-OUT |\n|---|---|---|\n| phase 8 | 12 | 6 |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 0);
    assert.strictEqual(p.errors.length, 0);
  });

  // Header-case leniency predates this fix (the old check lower-cased cell 0);
  // scoping the parse to a registered schema must not silently narrow it.
  test('a capitalised header is still recognised (no regression in leniency)', () => {
    const md = '| Capability | Decision | Reason |\n|---|---|---|\n| search | INTEGRATE | |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 1, 'header matching stays case-insensitive');
    assert.strictEqual(p.format, 'table');
  });

  // ── fail-loud structural guards (Codex review of the #2366 fix) ──────────────
  // Two GFM tables with NO blank line between them are one contiguous block; the
  // second's delimiter row must END the matrix, not let its rows be absorbed —
  // otherwise the silent-corruption path #2366 closes re-opens through a
  // butted-on table. The block must fail loud, never pass with invented rows.
  test('a second delimiter row inside the block ends the matrix and errors, not silently absorbs', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '|---|---|---|',
      '| premium | OPT-OUT | not in this phase |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.ok(!p.rows.some((r) => r.capability === 'premium'),
      'a row after a second delimiter must not be absorbed as a capability');
    assert.ok(p.errors.some((e) => /delimiter/i.test(e)),
      'the malformed block must surface an error, not pass silently');
    assert.strictEqual(validateCoverageMatrix(md).valid, false);
  });

  // A GFM table does not exist without its delimiter row. A canonical header
  // followed straight by data rows used to parse those rows anyway and pass.
  test('a coverage header with no delimiter row is a loud error, not a silent pass', () => {
    const md = '| capability | decision | reason |\n| search | INTEGRATE | |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 0, 'no delimiter ⇒ no table ⇒ no rows');
    assert.ok(p.errors.some((e) => /delimiter/i.test(e)));
    assert.strictEqual(validateCoverageMatrix(md).valid, false);
  });

  // Emphasis stripping must unwrap a whole-cell wrapper WITHOUT deleting an
  // interior marker — else a malformed `INTEG_RATE` is massaged into the valid
  // `INTEGRATE` and the gate accepts a decision the author never wrote.
  test('an interior underscore is NOT stripped — a malformed decision stays malformed', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| search | INTEG_RATE | |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 0);
    assert.ok(p.errors.some((e) => /not in \{INTEGRATE, OPT-OUT\}/.test(e)));
  });

  // The legitimate counterpart: emphasis that wraps the WHOLE cell is unwrapped,
  // including nested wrappers, and underscore-italic is accepted.
  test('whole-cell wrappers (nested, underscore-italic) unwrap to the bare decision', () => {
    for (const dec of ['`OPT-OUT`', '*OPT-OUT*', '_OPT-OUT_', '**`OPT-OUT`**']) {
      const md = `| capability | decision | reason |\n|---|---|---|\n| skip | ${dec} | x |`;
      const p = parseCoverageMatrix(md);
      assert.strictEqual(p.rows.length, 1, `decision ${dec} should parse`);
      assert.strictEqual(p.rows[0].decision, 'OPT-OUT', `decision ${dec} → OPT-OUT`);
      assert.strictEqual(p.errors.length, 0, `decision ${dec} → no error`);
    }
  });

  // ── second Codex pass: three more silent-acceptance paths ────────────────────
  // A canonical header on the LAST line (file ends before its delimiter) used to
  // vanish silently whenever an earlier section had already supplied rows — an
  // incomplete matrix section must never be dropped without a trace.
  test('an orphan header after a valid section is a loud error, not silently dropped', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '',
      '| capability | decision | reason |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['search']);
    assert.ok(p.errors.some((e) => /delimiter/i.test(e)),
      'the incomplete second section must surface an error');
    assert.strictEqual(validateCoverageMatrix(md).valid, false);
  });

  // GFM requires the delimiter row to have the same column count as the header.
  // A mismatched-width delimiter is a malformed table, not a coverage matrix.
  test('a delimiter row with the wrong column count is a loud error', () => {
    const md = '| capability | decision | reason |\n|---|---|\n| search | INTEGRATE | |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 0);
    assert.ok(p.errors.some((e) => /delimiter row has \d+ columns/.test(e)));
    assert.strictEqual(validateCoverageMatrix(md).valid, false);
  });

  // `* OPT-OUT *` (marker + space) is NOT emphasis in CommonMark — it renders as
  // a literal asterisk. Unwrapping it would massage a malformed cell into a
  // valid decision, so it must stay malformed.
  test('a marker with adjacent whitespace is not unwrapped — the decision stays malformed', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| s | * OPT-OUT * | reason |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 0);
    assert.ok(p.errors.some((e) => /not in \{INTEGRATE, OPT-OUT\}/.test(e)));
  });

  // ── #2374 review B1: a row that falls OUTSIDE the table must not vanish ──────
  //
  // The parse walk left `inRows` on any table-terminating line and then skipped
  // every later piped line with a bare `continue`, so a matrix split by a blank
  // line, a prose line, or an HTML comment silently lost all rows after the
  // split — with zero errors, and `validateCoverageMatrix` still sealed it
  // `valid: true`. The dropped rows in the reporter's case were both OPT-OUTs:
  // the exact decisions this gate exists to force an author to make explicitly,
  // disappearing from the record while the gate said "pass".
  for (const [splitLabel, splitter] of [
    ['a blank line', ''],
    ['a prose line', 'Continued below:'],
    ['an HTML comment', '<!-- second half -->'],
  ]) {
    test(`${splitLabel} splitting the matrix is a loud error, not a silent drop`, () => {
      const md = [
        '# API Coverage — Stripe',
        '',
        '| capability | decision | reason |',
        '|---|---|---|',
        '| charges | INTEGRATE | core |',
        splitter,
        '| payouts | OPT-OUT | phase 2 |',
        '| disputes | OPT-OUT | phase 2 |',
      ].join('\n');
      const p = parseCoverageMatrix(md);
      // The split rows are still not absorbed (that scoping IS the #2366 fix)...
      assert.deepStrictEqual(p.rows.map((r) => r.capability), ['charges'],
        'rows outside the table must not be absorbed as data');
      // ...but their loss is now REPORTED, and each is named so the author can
      // find the split rather than hunting a mysteriously short matrix.
      assert.ok(p.errors.some((e) => /payouts.*outside a coverage table/.test(e)),
        `the dropped row must be named, got: ${JSON.stringify(p.errors)}`);
      assert.ok(p.errors.some((e) => /disputes.*outside a coverage table/.test(e)),
        `every dropped row must be named, got: ${JSON.stringify(p.errors)}`);
      // The seal must fail closed — a silently-shortened matrix passing the gate
      // is the whole defect.
      assert.strictEqual(validateCoverageMatrix(md).valid, false,
        'a split matrix must never seal as valid');
    });
  }

  // #2374 review m1 — DECISION_NORMALIZE_MAX = 64 is a parser budget, and the
  // repo tests budgets at limit-1 / limit / limit+1 (see CAPABILITY_MAX_LEN and
  // REASON_MAX_LEN). The observable effect of the bail is whether the emphasis
  // wrapper was PEELED: the rejection message reports the post-normalization
  // cell, so at or under the cap it names the inner text and over the cap it
  // names the whole `**…**` string. Asserting that, rather than validity, is what
  // isolates the budget — a decision is 7 or 9 chars, so no *valid* decision can
  // be wrapped to exactly 64 anyway (symmetric wrappers only reach odd widths).
  for (const [label, width, expectPeeled] of [
    ['limit-1 (63)', 63, true],
    ['the limit (64)', 64, true],
    ['limit+1 (65)', 65, false],
  ]) {
    test(`a ${width}-char wrapped decision ${expectPeeled ? 'is still normalized' : 'bails and reaches the enum compare unmodified'}`, () => {
      const inner = 'X'.repeat(width - 4);          // minus '**' + '**'
      const cell = `**${inner}**`;
      assert.strictEqual(cell.length, width, `fixture must be exactly ${width} chars`);
      const md = ['| capability | decision | reason |', '|---|---|---|', `| search | ${cell} | |`].join('\n');
      const errors = parseCoverageMatrix(md).errors.join(' ');
      assert.ok(/not in \{INTEGRATE, OPT-OUT\}/.test(errors), `the row must be rejected either way, got: ${errors}`);
      if (expectPeeled) {
        assert.ok(
          errors.includes(`"${inner}"`) && !errors.includes(`"${cell}"`),
          `at ${width} chars the wrapper must be peeled before the enum compare, got: ${errors}`,
        );
      } else {
        assert.ok(
          errors.includes(`"${cell}"`),
          `over the cap the cell must reach the enum compare unmodified, got: ${errors}`,
        );
      }
    });
  }

  // #2374 review n1 — a loose row WIDER than 3 cells is reported too. A row is
  // usually wide because an unescaped `|` split it; combined with being outside
  // the table, that is precisely what the author needs told.
  test('a wide (4-cell) loose row is reported, not silently ignored', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| charges | INTEGRATE | core |',
      '',
      '| payouts | OPT-OUT | deferred | phase 2 |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['charges'], 'the loose row must not be absorbed');
    assert.ok(
      p.errors.some((e) => /payouts.*outside a coverage table.*4 columns/.test(e)),
      `the wide loose row must be named with its width, got: ${JSON.stringify(p.errors)}`,
    );
    assert.strictEqual(validateCoverageMatrix(md).valid, false);
  });

  // Codex round-4 blocker on the B1 fix. A 4-space-indented line is a CommonMark
  // INDENTED CODE BLOCK (the shape an author writes to show the format inline
  // without a fence), so a pipe-shaped line there is sample text, not a row.
  // Reporting it as a split matrix INVENTS a failure on a file whose matrix is
  // complete — worse than the silent drop B1 closes, because it blocks the seal.
  test('an indented (unfenced) code sample is not reported as a split matrix', () => {
    const md = [
      '# API Coverage — Stripe',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| charges | INTEGRATE | core |',
      '| payouts | OPT-OUT | phase 2 |',
      '',
      'An indented code sample:',
      '',
      '    | example | INTEGRATE | shown only as code |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['charges', 'payouts']);
    assert.deepStrictEqual(p.errors, [], 'indented code must not read as a loose coverage row');
    assert.strictEqual(validateCoverageMatrix(md).valid, true);
  });

  // ...but an indented pipe line INSIDE the open table is a lazy continuation,
  // still parsed as a row (CommonMark: indented code cannot interrupt a table).
  test('an indented row inside the open table is still parsed', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| charges | INTEGRATE | core |',
      '    | payouts | OPT-OUT | phase 2 |',
    ].join('\n');
    assert.deepStrictEqual(parseCoverageMatrix(md).rows.map((r) => r.capability), ['charges', 'payouts']);
  });

  // The loud error must not fire on the legitimate shapes a COVERAGE.md carries.
  // A summary table's header is coverage-SHAPED (`| tier | INTEGRATE | OPT-OUT |`)
  // and is precisely the table whose row #2366 used to absorb, so "is this row
  // inside another table, or inside no table at all?" is the distinction that
  // makes the B1 error safe to raise.
  test('a summary table after the matrix stays valid (no false split error)', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| charges | INTEGRATE | core |',
      '| payouts | OPT-OUT | phase 2 |',
      '',
      '## Summary',
      '',
      '| tier | INTEGRATE | OPT-OUT |',
      '|---|---|---|',
      '| core | 1 | 1 |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['charges', 'payouts']);
    assert.deepStrictEqual(p.errors, [], 'a foreign table must not read as a split matrix');
    assert.strictEqual(validateCoverageMatrix(md).valid, true);
  });

  test('a foreign table whose data row is coverage-shaped stays valid', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| charges | INTEGRATE | core |',
      '',
      '| threat | posture | note |',
      '|---|---|---|',
      '| replay | INTEGRATE | mitigated upstream |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['charges']);
    assert.deepStrictEqual(p.errors, [], 'rows of a confirmed foreign table are correctly ignored');
  });

  // A loose row that is NOT coverage-shaped is unrelated markdown, not a split
  // matrix — reporting it would make the error meaningless noise.
  test('a loose non-coverage-shaped table is ignored without an error', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| charges | INTEGRATE | core |',
      '',
      '| a | b |',
      '| c | d |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['charges']);
    assert.deepStrictEqual(p.errors, []);
  });

  // #2374 review M2 — a header that is clearly TRYING to be the matrix (an extra
  // column, or a reordered one) is reported by name. Scoping the parse to the
  // registered schema made these tables invisible, so the author was told the
  // matrix was "empty" instead of being shown the header they actually wrote.
  for (const [label, header] of [
    ['an extended (4-column)', '| capability | decision | reason | notes |'],
    ['a reordered', '| decision | capability | reason |'],
  ]) {
    test(`${label} header is named, not reported as an empty matrix`, () => {
      const md = [header, '|---|---|---|', '| charges | INTEGRATE | core |'].join('\n');
      const v = validateCoverageMatrix(md);
      assert.strictEqual(v.valid, false, 'a non-canonical header must still block');
      assert.ok(v.errors.some((e) => /not the canonical\s+Coverage schema/.test(e)),
        `the header must be named, got: ${JSON.stringify(v.errors)}`);
      assert.ok(!v.errors.some((e) => /matrix is empty/.test(e)),
        `"matrix is empty" is the misleading diagnostic this replaces, got: ${JSON.stringify(v.errors)}`);
    });
  }

  // An unrelated table must NOT be reported — the near-miss error requires BOTH
  // canonical anchors, so it stays off summary/threat tables.
  test('an unrelated table header is not reported as a near-miss', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| charges | INTEGRATE | core |',
      '',
      '| tier | INTEGRATE | OPT-OUT |',
      '|---|---|---|',
      '| core | 1 | 0 |',
    ].join('\n');
    assert.deepStrictEqual(parseCoverageMatrix(md).errors, []);
  });

  // #2374 review m4 — an unterminated fence masks every line after it, so a
  // matrix below one vanished and surfaced as "matrix is empty": a true
  // statement about the wrong cause. scanFencedBlocks already knows.
  test('an unterminated fence is named with its line, not reported as an empty matrix', () => {
    const md = [
      '# API Coverage',
      '',
      '```markdown',
      'an example that was never closed',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| charges | INTEGRATE | core |',
    ].join('\n');
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /unterminated code fence opened at line 3/.test(e)),
      `the fence and its line must be named, got: ${JSON.stringify(v.errors)}`);
  });

  // #2374 review m7 — a correctly GFM-escaped pipe is the author doing it RIGHT.
  // `splitTableRow` unescapes `\|`, and validation then blamed them for it.
  test('a GFM-escaped pipe in a reason is accepted and round-trips', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | OPT-OUT | deferred \\| tracked in phase 8 |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.errors.length, 0, `escaped pipe must parse cleanly, got: ${JSON.stringify(p.errors)}`);
    assert.strictEqual(p.rows[0].reason, 'deferred | tracked in phase 8', 'the cell unescapes to a literal pipe');
    assert.strictEqual(validateCoverageMatrix(md).valid, true, 'correct GFM must not be rejected');
    // The render half of the bijection must re-escape, or the round-trip emits
    // a corrupt 4-column row.
    const rendered = renderCoverageMatrix(p.rows);
    assert.match(rendered, /deferred \\\| tracked/, `render must re-escape the pipe, got:\n${rendered}`);
    assert.deepStrictEqual(parseCoverageMatrix(rendered).rows, p.rows, 'render -> parse must round-trip');
  });

  // #2374 review m8 — the module normalizes CRLF before any scan, so this is a
  // coverage lock on behavior that is already correct, in a repo where the CRLF
  // class keeps recurring (#1658/#1668/#2206/#2449/#2450).
  test('a CRLF COVERAGE.md parses identically to its LF twin', () => {
    const lf = [
      '# API Coverage',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| skip | OPT-OUT | not needed yet |',
      '',
    ].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    assert.deepStrictEqual(parseCoverageMatrix(crlf).rows, parseCoverageMatrix(lf).rows);
    assert.deepStrictEqual(parseCoverageMatrix(crlf).errors, []);
    assert.strictEqual(validateCoverageMatrix(crlf).valid, true);
  });

  // ── third Codex pass: body rows must fail loud, never truncate ───────────────
  // A short (1-cell) row in the body must NOT terminate the matrix and drop the
  // real rows after it — that was a truncation regression. Both real rows survive.
  test('a one-cell row in the body does not truncate the rows that follow it', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '|',
      '| premium | OPT-OUT | later |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.deepStrictEqual(p.rows.map((r) => r.capability), ['search', 'premium'],
      'a stray short row must not hide the capabilities after it');
  });

  // A 2-cell body row (`| bogus | WRONG |`, missing the reason column) is
  // malformed and must error, not vanish while the gate reports success.
  test('a two-cell body row is a loud column-count error, not a silent drop', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| bogus | WRONG |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.ok(!p.rows.some((r) => r.capability === 'bogus'));
    assert.ok(p.errors.some((e) => /columns/.test(e)));
    assert.strictEqual(validateCoverageMatrix(md).valid, false);
  });

  // A backtick code span DOES strip one flanking space each side (CommonMark
  // §6.1), unlike `*`/`_` emphasis — so `` ` OPT-OUT ` `` is a legitimate way to
  // write the decision and must be accepted, not rejected.
  test('a backtick code span with flanking spaces is accepted (unlike * emphasis)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| search | ` OPT-OUT ` | reason |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 1);
    assert.strictEqual(p.rows[0].decision, 'OPT-OUT');
    assert.strictEqual(p.errors.length, 0);
  });

  // ── fourth Codex pass: code spans are literal and bind tighter than emphasis ──
  // `` `*OPT-OUT*` `` renders as the LITERAL text *OPT-OUT* (a code span's content
  // is not further markdown, CommonMark §6.1), so it is NOT a valid decision and
  // must not be normalised into one by stripping the interior asterisks.
  test('a code span with interior emphasis markers stays literal and malformed', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| s | `*OPT-OUT*` | x |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 0);
    assert.ok(p.errors.some((e) => /not in \{INTEGRATE, OPT-OUT\}/.test(e)));
  });

  // CommonMark strips exactly ONE space from each edge of a code span — a doubly
  // spaced span still renders with surrounding spaces, so it is not the bare enum.
  test('a doubly-spaced code span is not normalised to the bare decision', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| s | `  OPT-OUT  ` | x |';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 0);
    assert.ok(p.errors.some((e) => /not in \{INTEGRATE, OPT-OUT\}/.test(e)));
  });

  // A well-formed multi-backtick span (`` ``OPT-OUT`` ``) and an emphasis-wrapped
  // code span (`` **`OPT-OUT`** ``) are both legitimate renderings of the decision.
  test('multi-backtick and emphasis-wrapped code spans parse to the decision', () => {
    for (const dec of ['``OPT-OUT``', '**`OPT-OUT`**']) {
      const md = `| capability | decision | reason |\n|---|---|---|\n| s | ${dec} | x |`;
      const p = parseCoverageMatrix(md);
      assert.strictEqual(p.rows.length, 1, `decision ${dec} should parse`);
      assert.strictEqual(p.rows[0].decision, 'OPT-OUT');
      assert.strictEqual(p.errors.length, 0);
    }
  });

  // ── fifth Codex pass: decision-cell normalisation must be ReDoS-safe ─────────
  // A long run of opening backticks with no closing run drove the previous
  // backtracking regex super-linear (~10s at 8k chars). The deterministic edge
  // scan is O(n): this parses effectively instantly and rejects the cell. If the
  // backtracking regex is ever reintroduced, this test hangs and fails via timeout.
  test('a pathological backtick run does not stall the parser (ReDoS guard)', () => {
    const cell = '`'.repeat(50000) + 'A'.repeat(50000);
    const md = `| capability | decision | reason |\n|---|---|---|\n| s | ${cell} | x |`;
    // No wall-clock assertion (Clock Seams rule bans elapsed-time asserts): the
    // O(n) length-cap scan parses this effectively instantly, and if the
    // backtracking regex is ever reintroduced the test hangs and fails via the
    // harness timeout. The behavioural contract is that the 100k-char decision is
    // rejected LOUDLY — no row, a populated error — not silently coerced.
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 0, 'a 100k-char pathological decision is not a valid row');
    assert.ok(p.errors.length > 0, 'the rejected pathological cell must surface an error, not be silent');
  });
});
