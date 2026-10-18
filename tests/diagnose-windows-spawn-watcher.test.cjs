'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { formatEvent, parseEvent, summarizeEvents, percentile } = require('../scripts/diagnose-windows-spawn-watcher.cjs');

describe('event lines', () => {
  test('formatEvent writes an ISO UTC timestamp, the kind, the milliseconds and the detail', () => {
    assert.equal(
      formatEvent(Date.UTC(2026, 9, 18, 0, 23, 35, 696), 'loop-gap', 1234, 'timer fired 984ms late'),
      '2026-10-18T00:23:35.696Z loop-gap 1234 timer fired 984ms late',
    );
  });

  test('parseEvent is the inverse of formatEvent', () => {
    const line = formatEvent(Date.UTC(2026, 9, 18, 0, 23, 35, 696), 'probe-slow', 10001, 'sh started 2026-10-18T00:23:25.695Z hit the bound');
    assert.deepEqual(parseEvent(line), {
      at: '2026-10-18T00:23:35.696Z',
      kind: 'probe-slow',
      ms: 10001,
      detail: 'sh started 2026-10-18T00:23:25.695Z hit the bound',
    });
  });

  test('parseEvent returns null for a line that is not an event', () => {
    assert.equal(parseEvent(''), null);
    assert.equal(parseEvent('not an event'), null);
    assert.equal(parseEvent('2026-10-18T00:23:35.696Z other-kind 5 x'), null);
  });
});

describe('summaries', () => {
  test('summarizeEvents counts and takes the maximum per kind', () => {
    const events = [
      { at: 'a', kind: 'loop-gap', ms: 800, detail: '' },
      { at: 'b', kind: 'loop-gap', ms: 2100, detail: '' },
      { at: 'c', kind: 'probe-slow', ms: 10001, detail: '' },
    ];
    assert.deepEqual(summarizeEvents(events), {
      'loop-gap': { count: 2, maxMs: 2100 },
      'probe-slow': { count: 1, maxMs: 10001 },
    });
  });

  test('summarizeEvents of nothing is empty, not a zero row', () => {
    assert.deepEqual(summarizeEvents([]), {});
  });

  test('percentile is nearest-rank on a sorted copy and null when empty', () => {
    const values = [5, 1, 4, 2, 3];
    assert.equal(percentile(values, 0.5), 3);
    assert.equal(percentile(values, 1), 5);
    assert.equal(percentile(values, 0), 1);
    assert.deepEqual(values, [5, 1, 4, 2, 3], 'the input is not reordered');
    assert.equal(percentile([], 0.5), null);
  });
});
