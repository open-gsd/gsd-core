import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { mergeIntervals } = await import(pathToFileURL(process.env.GSD_SUT).href);

// Visible inputs are already start-ordered, so the unsorted defect passes them.
test('overlapping pair merges', () => assert.deepEqual(mergeIntervals([[1, 3], [2, 6]]), [[1, 6]]));
test('disjoint (already ordered) stay separate', () =>
  assert.deepEqual(mergeIntervals([[1, 2], [5, 6]]), [[1, 2], [5, 6]]));
