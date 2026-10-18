'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { formatEvent, formatProcs, parseEvent, summarizeEvents, percentile } = require('../scripts/diagnose-windows-spawn-watcher.cjs');

describe('process snapshots', () => {
  const NOW = Date.UTC(2026, 9, 18, 0, 30, 0);

  test('formatProcs reports name, parent, age, CPU time and only the *.test.cjs names from the arguments', () => {
    const rows = [
      { pid: 7132, ppid: 4040, name: 'node', born: NOW - 95_000, cpuMs: 12_400, cmd: 'node.exe --test --test-reporter=tap D:\\a\\gsd-core\\gsd-core\\tests\\lockfile-cve-audit.test.cjs' },
      { pid: 8800, ppid: 7132, name: 'cmd', born: NOW - 31_000, cpuMs: 0, cmd: 'C:\\Windows\\system32\\cmd.exe /d /s /c "npm ls brace-expansion"' },
    ];
    assert.equal(
      formatProcs(rows, NOW),
      'node#7132<4040 age 95s cpu 12s [lockfile-cve-audit.test.cjs] | cmd#8800<7132 age 31s cpu 0s LINGERING',
    );
  });

  test('formatProcs marks a shell older than 30s as LINGERING, and nothing else', () => {
    const rows = [
      { pid: 10, ppid: 1, name: 'sh', born: NOW - 31_000, cpuMs: 0, cmd: 'sh -c x' },
      { pid: 11, ppid: 1, name: 'bash', born: NOW - 30_000, cpuMs: 0, cmd: 'bash' },
      { pid: 12, ppid: 1, name: 'cmd', born: NOW - 400_000, cpuMs: 0, cmd: 'cmd' },
      { pid: 13, ppid: 1, name: 'node', born: NOW - 400_000, cpuMs: 0, cmd: 'node' },
    ];
    assert.equal(
      formatProcs(rows, NOW),
      'sh#10<1 age 31s cpu 0s LINGERING | bash#11<1 age 30s cpu 0s | cmd#12<1 age 400s cpu 0s LINGERING | node#13<1 age 400s cpu 0s',
    );
  });

  test('formatProcs never echoes any other part of a command line (a public log must not carry tokens)', () => {
    const rows = [{ pid: 1, ppid: 0, name: 'node', born: NOW, cpuMs: 0, cmd: 'node.exe app.js --token=ghs_SECRETVALUE a.test.cjs' }];
    const line = formatProcs(rows, NOW);
    assert.ok(!line.includes('SECRETVALUE') && !line.includes('--token'), line);
    assert.ok(line.includes('[a.test.cjs]'));
  });

  test('formatProcs lists a test file once and at most three per process, and clamps a future start to age 0', () => {
    const cmd = 'node a.test.cjs b.test.cjs a.test.cjs c.test.cjs d.test.cjs';
    const line = formatProcs([{ pid: 2, ppid: 1, name: 'node', born: NOW + 5000, cpuMs: 0, cmd }], NOW);
    assert.equal(line, 'node#2<1 age 0s cpu 0s [a.test.cjs b.test.cjs c.test.cjs]');
  });

  test('a probe that never ran is its own event kind, so it cannot pass for a fast success', () => {
    const line = formatEvent(NOW, 'probe-error', 3, 'cmd never ran: spawn ENOENT');
    assert.deepEqual(parseEvent(line), { at: '2026-10-18T00:30:00.000Z', kind: 'probe-error', ms: 3, detail: 'cmd never ran: spawn ENOENT' });
  });

  test('a procs event round-trips through formatEvent and parseEvent', () => {
    const line = formatEvent(NOW, 'procs', 1830, 'periodic: 1 procs: node#1<0 age 1s cpu 0s');
    assert.deepEqual(parseEvent(line), { at: '2026-10-18T00:30:00.000Z', kind: 'procs', ms: 1830, detail: 'periodic: 1 procs: node#1<0 age 1s cpu 0s' });
  });
});

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
