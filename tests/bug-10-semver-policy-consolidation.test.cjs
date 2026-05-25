'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  compareSemverCore,
  isStableTripletSemver,
} = require('../get-shit-done/bin/lib/semver-compare.cjs');
const { isInstalledAheadOfLatest } = require('../hooks/gsd-statusline.js');

describe('bug #10: semver policy consolidation', () => {
  test('shared comparator treats prerelease patch increment as newer than previous stable', () => {
    assert.ok(compareSemverCore('1.2.1-beta.1', '1.2.0') > 0);
  });

  test('shared comparator ignores prerelease suffix for equal base versions', () => {
    assert.equal(compareSemverCore('1.2.0-rc.1', '1.2.0'), 0);
  });

  test('stable-triplet validator excludes prerelease tags', () => {
    assert.equal(isStableTripletSemver('1.2.0-rc.1'), false);
    assert.equal(isStableTripletSemver('1.2.0'), true);
  });

  test('statusline dev-install detection uses shared comparator semantics', () => {
    assert.equal(isInstalledAheadOfLatest('1.2.1-beta.1', '1.2.0'), true);
    assert.equal(isInstalledAheadOfLatest('1.2.0-rc.1', '1.2.0'), false);
  });
});
