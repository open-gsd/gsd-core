import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { mergeIntervals } = await import(pathToFileURL(process.env.GSD_SUT).href);

// The non-inferable edge: intervals that TOUCH at an endpoint merge (treated as overlapping).
test('touching pair merges', () => assert.deepEqual(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]));
test('chain of touching intervals merges', () =>
  assert.deepEqual(mergeIntervals([[1, 5], [5, 8], [8, 10]]), [[1, 10]]));
