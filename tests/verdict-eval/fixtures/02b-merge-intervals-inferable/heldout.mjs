import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { mergeIntervals } = await import(pathToFileURL(process.env.GSD_SUT).href);

// The STATED (inferable) rule: output sorted by start. An unsorted-input case exposes the defect.
test('output is sorted by start', () =>
  assert.deepEqual(mergeIntervals([[5, 6], [1, 2]]), [[1, 2], [5, 6]]));
