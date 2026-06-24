import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { roundTo } = await import(pathToFileURL(process.env.GSD_SUT).href);

test('rounds down when strictly closer (2dp)', () => assert.equal(roundTo(1.234, 2), 1.23));
test('rounds up when strictly closer (2dp)', () => assert.equal(roundTo(1.236, 2), 1.24));
test('rounds down to integer', () => assert.equal(roundTo(2.4), 2));
test('rounds up to integer', () => assert.equal(roundTo(2.6), 3));
