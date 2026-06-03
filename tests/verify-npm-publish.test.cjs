'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-npm-publish.cjs');
const { verifyPublish, REASON } = require(SCRIPT);

// ---- Helpers -----------------------------------------------------------------

function makeFetchVersion(sequence) {
  let i = 0;
  return () => sequence[Math.min(i++, sequence.length - 1)];
}

function makeSleepSpy() {
  let sleeps = 0;
  const sleep = async () => { sleeps++; };
  const count = () => sleeps;
  return { sleep, count };
}

// ---- Tests -------------------------------------------------------------------

describe('verifyPublish', () => {
  test('returns OK on first attempt when version is already live', async () => {
    const { sleep, count } = makeSleepSpy();
    const fetchVersion = makeFetchVersion(['1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion([null]);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, REASON.OK_VERSION_LIVE);
    assert.equal(result.attempts, 1);
    assert.equal(count(), 0);
  });

  test('retries through propagation lag and succeeds once the version appears', async () => {
    const { sleep, count } = makeSleepSpy();
    const fetchVersion = makeFetchVersion([null, null, '1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion([null]);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(count(), 2);
  });

  test('fails after exhausting maxAttempts when version never appears', async () => {
    const { sleep, count } = makeSleepSpy();
    const fetchVersion = makeFetchVersion([null]);
    const fetchDistTag = makeFetchVersion([null]);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      maxAttempts: 4,
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.FAIL_VERSION_NOT_FOUND);
    assert.equal(result.attempts, 4);
    assert.equal(count(), 3);
  });

  test('reports dist-tag pointer informationally without affecting ok', async () => {
    const { sleep, count } = makeSleepSpy();
    const fetchVersion = makeFetchVersion(['1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion(['1.3.0-rc.1']);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      distTag: 'next',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.distTag, {
      name: 'next',
      points_to: '1.3.0-rc.1',
      matches: true,
    });
    void count;
  });

  test('dist-tag mismatch is a warning, not a failure', async () => {
    const { sleep } = makeSleepSpy();
    const fetchVersion = makeFetchVersion(['1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion(['1.2.0']);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      distTag: 'latest',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.distTag.matches, false);
    assert.equal(result.distTag.points_to, '1.2.0');
  });

  test('no dist-tag requested yields null distTag', async () => {
    const { sleep } = makeSleepSpy();
    const fetchVersion = makeFetchVersion(['1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion([null]);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.distTag, null);
  });
});
