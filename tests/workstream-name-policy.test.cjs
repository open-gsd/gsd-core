const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWorkstreamNameInput,
  validateActiveWorkstreamName,
  assertValidActiveWorkstreamName,
  isValidActiveWorkstreamName,
  toWorkstreamSlug,
  INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE,
} = require('../gsd-core/bin/lib/workstream-name-policy.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

describe('workstream-name-policy', () => {
  test('normalizeWorkstreamNameInput trims and nulls empty input', () => {
    assert.equal(normalizeWorkstreamNameInput('  alpha  '), 'alpha');
    assert.equal(normalizeWorkstreamNameInput('   '), null);
    assert.equal(normalizeWorkstreamNameInput(null), null);
  });

  test('validateActiveWorkstreamName returns structured validation', () => {
    assert.deepEqual(
      validateActiveWorkstreamName('alpha_1'),
      { ok: true, reason: null, value: 'alpha_1' }
    );
    assert.deepEqual(
      validateActiveWorkstreamName('alpha beta'),
      { ok: false, reason: 'invalid', value: 'alpha beta' }
    );
    assert.deepEqual(
      validateActiveWorkstreamName('../alpha'),
      { ok: false, reason: 'invalid', value: '../alpha' }
    );
    assert.deepEqual(
      validateActiveWorkstreamName('  '),
      { ok: false, reason: 'empty', value: null }
    );
  });

  test('assertValidActiveWorkstreamName returns normalized value and throws canonical error', () => {
    assert.equal(assertValidActiveWorkstreamName('  alpha  '), 'alpha');
    assert.throws(
      () => assertValidActiveWorkstreamName('alpha/beta'),
      new RegExp(escapeRegex(INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE))
    );
  });

  test('isValidActiveWorkstreamName accepts canonical and rejects invalid names', () => {
    assert.equal(isValidActiveWorkstreamName('alpha-1'), true);
    assert.equal(isValidActiveWorkstreamName('ws..traversal'), false);
    assert.equal(isValidActiveWorkstreamName('alpha beta'), false);
  });

  // #3883 regression: the slug consolidation (01cc283da) routed
  // toWorkstreamSlug through generateSlugInternal's hard-coded 60-char cap,
  // which this site never had. Two distinct >60-char names collapsed onto
  // the identical slug, so `workstream create` on the second name silently
  // wrote into (or reported already_exists for) the first name's directory.
  test('toWorkstreamSlug does not truncate — distinct long names stay distinct', () => {
    const nameA = `${'a'.repeat(60)}alpha`;
    const nameB = `${'a'.repeat(60)}beta`;
    const slugA = toWorkstreamSlug(nameA);
    const slugB = toWorkstreamSlug(nameB);
    assert.notEqual(slugA, slugB, 'distinct >60-char workstream names must not collide on slug');
    assert.equal(slugA, `${'a'.repeat(60)}alpha`);
    assert.equal(slugB, `${'a'.repeat(60)}beta`);
  });
});

// ─── #4772: `none` is a reserved workstream name ───────────────────────────
describe('regressions: reserved workstream names (#4772)', () => {
  const fc = require('fast-check');
  const {
    RESERVED_WORKSTREAM_NAMES,
    isReservedWorkstreamName,
    reservedWorkstreamNameMessage,
  } = require('../gsd-core/bin/lib/workstream-name-policy.cjs');

  test('the reserved list is exactly [none] and cannot be mutated by a consumer', () => {
    assert.deepEqual([...RESERVED_WORKSTREAM_NAMES], ['none']);
    assert.ok(Object.isFrozen(RESERVED_WORKSTREAM_NAMES));
  });

  test('none is reserved regardless of case and surrounding whitespace', () => {
    for (const name of ['none', 'None', 'NONE', '  none  ', 'nOnE']) {
      assert.equal(isReservedWorkstreamName(name), true, name);
    }
  });

  test('near-misses at limit-1 / limit / limit+1 of the reserved name stay usable', () => {
    assert.equal(isReservedWorkstreamName('non'), false);
    assert.equal(isReservedWorkstreamName('none'), true);
    for (const name of ['nonee', 'none1', 'nonexistent', 'no-ne', 'no_ne', 'none.1', 'anone', '_none']) {
      assert.equal(isReservedWorkstreamName(name), false, name);
    }
    for (const name of ['non', 'nonee', 'none1', 'nonexistent']) {
      assert.equal(isValidActiveWorkstreamName(name), true, name);
    }
  });

  test('empty, null and undefined are not reserved (they are invalid, a different rule)', () => {
    for (const name of ['', '   ', null, undefined]) {
      assert.equal(isReservedWorkstreamName(name), false);
    }
  });

  test('the charset rule is unchanged: a reserved name is still charset-valid', () => {
    assert.deepEqual(validateActiveWorkstreamName('none'), { ok: true, reason: null, value: 'none' });
  });

  test('the shared message names the offending value and the flat-mode remedy', () => {
    const message = reservedWorkstreamNameMessage('None');
    assert.match(message, /'None' is reserved/);
    assert.match(message, /omit --ws for flat mode/);
  });

  test('the remedy follows where the name came from, and never advises a command the bootstrap would also reject', () => {
    assert.match(reservedWorkstreamNameMessage('none', 'env'), /unset GSD_WORKSTREAM/);
    assert.match(reservedWorkstreamNameMessage('none', 'store'), /pointer/);
    assert.match(reservedWorkstreamNameMessage('none', 'cli'), /omit --ws/);
    for (const source of ['cli', 'env', 'store', null]) {
      assert.doesNotMatch(reservedWorkstreamNameMessage('none', source), /set --clear/);
    }
  });

  test('property: every case/whitespace variant of a reserved word is reserved', () => {
    const variant = fc.tuple(
      fc.constantFrom(...RESERVED_WORKSTREAM_NAMES),
      fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      fc.constantFrom('', ' ', '\t'),
    ).map(([word, flips, pad]) => pad + [...word].map((ch, i) => (flips[i % flips.length] ? ch.toUpperCase() : ch)).join('') + pad);
    fc.assert(fc.property(variant, (name) => { assert.equal(isReservedWorkstreamName(name), true); }), { numRuns: 100 });
  });

  test('property: any charset-valid name that is not a reserved word is never reserved', () => {
    const validName = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,20}$/);
    fc.assert(fc.property(validName, (name) => {
      const expected = RESERVED_WORKSTREAM_NAMES.includes(name.toLowerCase());
      assert.equal(isReservedWorkstreamName(name), expected);
    }), { numRuns: 200 });
  });
});
