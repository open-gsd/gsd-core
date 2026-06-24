import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { roundTo } = await import(pathToFileURL(process.env.GSD_SUT).href);

// The non-inferable edge: exact .5 ties round to nearest EVEN (banker's), NOT half-up.
// Distinguishing inputs (half-up would give 1, 3, 5):
test('0.5 ties to even (0)', () => assert.equal(roundTo(0.5), 0));
test('2.5 ties to even (2)', () => assert.equal(roundTo(2.5), 2));
test('4.5 ties to even (4)', () => assert.equal(roundTo(4.5), 4));
