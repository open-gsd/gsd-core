'use strict';

// Focused unit tests for the path-separator helpers on shell-command-projection
// (toPosixPath / toNativePath / posixNormalize). These are drop-in replacements
// for open-coded `.replace(/\\/g, '/')` and
// `process.platform === 'win32' ? x.replace(/\//g, '\\') : x`
// call sites — see shell-command-projection.cts for the platform-relative contract.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');

const { toPosixPath, toNativePath, posixNormalize } = require('../gsd-core/bin/lib/shell-command-projection.cjs');

describe('toPosixPath', () => {
  test('plain relative path: already-POSIX segments pass through unchanged', () => {
    assert.equal(toPosixPath('a/b/c'), 'a/b/c');
  });

  test('plain relative path built with the native separator normalizes to POSIX segments', () => {
    const native = path.join('alpha', 'beta', 'gamma');
    assert.equal(toPosixPath(native), ['alpha', 'beta', 'gamma'].join('/'));
  });

  test('absolute path: segment list matches the native path split on path.sep', () => {
    const abs = path.resolve('alpha', 'beta');
    assert.equal(toPosixPath(abs), abs.split(path.sep).join('/'));
  });

  test('idempotency: applying twice equals applying once', () => {
    const native = path.join('alpha', 'beta', 'gamma');
    const once = toPosixPath(native);
    const twice = toPosixPath(once);
    assert.equal(once, twice);
  });

  test('empty string in, empty string out', () => {
    assert.equal(toPosixPath(''), '');
  });

  test('does not corrupt a POSIX-style input containing a literal backslash-free path', () => {
    // A string that already uses only '/' as its separator and contains no
    // occurrence of path.sep-as-backslash must survive unchanged regardless of
    // the host platform's path.sep (no-op on POSIX; nothing to split on Windows
    // either, since there is no backslash present).
    const alreadyPosix = 'already/posix/style/path';
    assert.equal(toPosixPath(alreadyPosix), alreadyPosix);
  });

  test('property: toPosixPath output never contains path.sep when path.sep differs from "/"', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]+$/), { minLength: 1, maxLength: 5 }), (segments) => {
        const native = segments.join(path.sep);
        const posix = toPosixPath(native);
        if (path.sep !== '/') {
          assert.ok(!posix.includes(path.sep));
        }
        assert.equal(posix, segments.join('/'));
      }),
    );
  });
});

describe('toNativePath', () => {
  test('plain relative path: already-native segments pass through unchanged', () => {
    const native = path.join('alpha', 'beta', 'gamma');
    assert.equal(toNativePath(native), native);
  });

  test('POSIX-style relative path converts to native segments', () => {
    const posix = 'alpha/beta/gamma';
    assert.equal(toNativePath(posix), ['alpha', 'beta', 'gamma'].join(path.sep));
  });

  test('absolute path: round-trips back to the original POSIX form via split/join', () => {
    const posixAbs = path.posix.resolve('/', 'alpha', 'beta');
    const native = toNativePath(posixAbs);
    assert.equal(native.split(path.sep).join('/'), posixAbs);
  });

  test('idempotency: applying twice equals applying once', () => {
    const posix = 'alpha/beta/gamma';
    const once = toNativePath(posix);
    const twice = toNativePath(once);
    assert.equal(once, twice);
  });

  test('empty string in, empty string out', () => {
    assert.equal(toNativePath(''), '');
  });

  test('does not corrupt an already-native-style input containing no POSIX separator', () => {
    // A string that already uses only path.sep as its separator (and contains
    // no '/' occurrence) must survive unchanged: no-op on POSIX (path.sep is
    // '/', so it IS the separator being normalized to); on Windows there is no
    // '/' present to split on, so the single-element join reproduces the input.
    const alreadyNative = ['already', 'native', 'style', 'path'].join(path.sep);
    assert.equal(toNativePath(alreadyNative), alreadyNative);
  });

  test('property: toPosixPath and toNativePath round-trip a POSIX-style path through both conversions', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]+$/), { minLength: 1, maxLength: 5 }), (segments) => {
        const posix = segments.join('/');
        assert.equal(toPosixPath(toNativePath(posix)), posix);
      }),
    );
  });
});

describe('posixNormalize', () => {
  test('unconditional conversion: literal backslashes always become forward slashes, regardless of host platform', () => {
    // Unlike toPosixPath (which splits on path.sep — a no-op on POSIX hosts),
    // posixNormalize must convert backslashes even when running on a POSIX
    // host, because the input represents a TARGET platform's path, not this
    // machine's filesystem path.
    assert.equal(posixNormalize('alpha\\beta\\gamma'), 'alpha/beta/gamma');
  });

  test('mixed separators: only backslashes are converted, forward slashes are left alone', () => {
    assert.equal(posixNormalize('alpha\\beta/gamma\\delta'), 'alpha/beta/gamma/delta');
  });

  test('already-POSIX input with no backslash passes through unchanged', () => {
    const alreadyPosix = 'already/posix/style/path';
    assert.equal(posixNormalize(alreadyPosix), alreadyPosix);
  });

  test('idempotency: applying twice equals applying once', () => {
    const once = posixNormalize('alpha\\beta\\gamma');
    const twice = posixNormalize(once);
    assert.equal(once, twice);
  });

  test('empty string in, empty string out', () => {
    assert.equal(posixNormalize(''), '');
  });

  test('property: posixNormalize output never contains a backslash', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const normalized = posixNormalize(input);
        assert.ok(!normalized.includes('\\'));
      }),
    );
  });
});
