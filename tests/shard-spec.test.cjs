'use strict';

/**
 * The shard-spec helper (tests/helpers/shard-spec.cjs) parses and checks the `N/M` shard entries of a CI matrix: a spec
 * is exact at its boundaries, and a shard set is complete only when it shares one denominator and holds every numerator
 * once (#4335). The release.yml wiring that uses it is the release-shard-lane-sharding text contract; its subject is
 * workflow text, while this file's subject is the helper's own code, so these cases stay a test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const { parseShardSpec, isCompleteShardSet } = require('./helpers/shard-spec.cjs');
const contract = require('../scripts/static-checks/text-contracts/release-shard-lane-sharding.cjs');

// The release-shard-lane-sharding contract ships, so it cannot require this helper (tests/ does not ship) and carries its own copy of
// the shard-spec grammar. The runner (scripts/run-tests.cjs, through the helper) is the owner: this property fails if the copy diverges.
test('property: the contract copy of isCompleteShardSet agrees with the helper on any list of specs (#4335)', () => {
  const spec = fc.oneof(
    fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 7 })).map(([i, n]) => `${i}/${n}`),
    fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 7 })).map(([i, n]) => `0${i}/${n}`),
    fc.constantFrom('', '1', '1/', '/3', 'a/3', '1/b', ' 1/3', '1/3 ', '1 /3', '1/3\n', '1/3/4', '-1/3', '1/-3', '1.5/3', `${'9'.repeat(400)}/${'9'.repeat(400)}`, '1/' + '9'.repeat(400)),
    fc.string(),
  );
  fc.assert(fc.property(fc.array(spec, { maxLength: 9 }), (specs) => {
    assert.equal(contract.isCompleteShardSet(specs), isCompleteShardSet(specs), JSON.stringify(specs));
  }));
  fc.assert(fc.property(fc.integer({ min: 1, max: 9 }), fc.nat(), fc.nat(), (total, a, b) => {
    const specs = Array.from({ length: total }, (_, i) => `${i + 1}/${total}`);
    assert.equal(contract.isCompleteShardSet(specs), true);
    assert.equal(isCompleteShardSet(specs), true);
    specs[a % total] = specs[b % total];
    assert.equal(contract.isCompleteShardSet(specs), isCompleteShardSet(specs));
  }));
});

test('shard-spec parsing is exact at its boundaries (#4335)', () => {
  assert.deepEqual(parseShardSpec('1/3'), { index: 1, total: 3 });
  assert.deepEqual(parseShardSpec('3/3'), { index: 3, total: 3 });
  assert.equal(parseShardSpec('0/3'), null);
  assert.equal(parseShardSpec('4/3'), null);
  assert.equal(parseShardSpec('a/3'), null);
  assert.equal(parseShardSpec('1/0'), null, 'a zero denominator');
  assert.equal(parseShardSpec(' 1/3'), null, 'leading whitespace');
  assert.equal(parseShardSpec('1/3 '), null, 'trailing whitespace');
  assert.equal(parseShardSpec('1 /3'), null, 'whitespace before the slash');
  assert.equal(parseShardSpec('1/ 3'), null, 'whitespace after the slash');
  assert.equal(parseShardSpec('1/3\n'), null, 'a trailing newline');
  assert.equal(parseShardSpec(''), null, 'the empty string');
  assert.equal(parseShardSpec(undefined), null, 'a missing spec');

  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/3']), true);
  assert.equal(isCompleteShardSet(['1/3', '2/3']), false, 'missing numerator');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '2/3']), false, 'duplicate numerator');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/4']), false, 'mixed denominator');
  assert.equal(isCompleteShardSet([]), false, 'empty set');
  assert.equal(isCompleteShardSet(['1/1']), true, 'a single whole-suite shard');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/3', '4/3']), false, 'a numerator past the denominator');
});

// Specs of one shard set: every numerator 1..total once, in the order given by `order`.
const completeSet = (total, order) => order.map((i) => `${i}/${total}`);
const setArbitrary = fc.integer({ min: 1, max: 20 }).chain((total) => fc.shuffledSubarray(Array.from({ length: total }, (_, i) => i + 1), { minLength: total, maxLength: total }).map((order) => ({ total, order })));

test('property: only the digits-slash-digits grammar parses, and only inside 1..total (#4335)', () => {
  const grammar = /^\d+\/\d+$/;
  fc.assert(fc.property(fc.string(), (text) => {
    if (!grammar.test(text)) assert.equal(parseShardSpec(text), null, `${JSON.stringify(text)} is outside the grammar`);
  }));
  fc.assert(fc.property(fc.string(), fc.string(), (left, right) => {
    const text = `${left}/${right}`;
    if (!grammar.test(text)) assert.equal(parseShardSpec(text), null);
  }));
  const digits = fc.integer({ min: 0, max: 999 });
  fc.assert(fc.property(digits, digits, (index, total) => {
    const parsed = parseShardSpec(`${index}/${total}`);
    if (total >= 1 && index >= 1 && index <= total) assert.deepEqual(parsed, { index, total });
    else assert.equal(parsed, null);
  }));
});

test('property: a spec round-trips and a shard set is complete exactly when it holds every numerator once (#4335)', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 40 }), (index, total) => {
    const parsed = parseShardSpec(`${index}/${total}`);
    if (index <= total) assert.deepEqual(parsed, { index, total });
    else assert.equal(parsed, null);
  }));

  fc.assert(fc.property(setArbitrary, ({ total, order }) => {
    assert.equal(isCompleteShardSet(completeSet(total, order)), true, 'every numerator once, in any order');
  }));

  fc.assert(fc.property(setArbitrary, fc.nat(), ({ total, order }, pick) => {
    const at = pick % order.length;
    assert.equal(isCompleteShardSet(completeSet(total, order.filter((_, i) => i !== at))), false, 'one numerator missing');
    if (order.length > 1) {
      const duplicated = order.slice();
      duplicated[at] = duplicated[(at + 1) % duplicated.length];
      assert.equal(isCompleteShardSet(completeSet(total, duplicated)), false, 'one numerator duplicated in place of another');
    }
    const mixed = completeSet(total, order);
    mixed[at] = `${order[at]}/${total + 1}`;
    assert.equal(isCompleteShardSet(mixed), false, 'one entry with another denominator');
  }));
});
