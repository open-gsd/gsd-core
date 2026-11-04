/**
 * #5831: the shell-projection seam's no-fallback atomic write
 * (`platformWriteSync(..., { atomic: true })`), byte-exact restore
 * (`platformRestoreFileSync`) and byte read (`platformReadBytesSync`).
 *
 * The default `platformWriteSync` falls back to a direct write when the temp
 * file cannot be written or atomically renamed; that direct write truncates
 * the destination before it can fail. The atomic mode never touches the
 * destination except by rename, and removes its temp file on every failure.
 */

'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup, mockPartialWriteThenThrow } = require('./helpers.cjs');
const scp = require('../gsd-core/bin/lib/shell-command-projection.cjs');

describe('#5831: atomic write, restore and byte read in the shell-projection seam', () => {
  const PREVIOUS = '# Archive\n\nEarlier entries that exist nowhere else.\n';
  let dir;
  let target;

  beforeEach(() => {
    dir = createTempDir('gsd-atomic-write-');
    target = path.join(dir, 'ARCHIVE.md');
  });

  afterEach(() => {
    mock.restoreAll();
    cleanup(dir);
  });

  function siblings() {
    return fs.readdirSync(dir).sort();
  }

  function errno(code) {
    return Object.assign(new Error(`${code}: simulated`), { code });
  }

  // ── platformWriteSync { atomic: true } ─────────────────────────────────

  test('an atomic write publishes the same normalized content as a default write', () => {
    const other = path.join(dir, 'OTHER.md');
    const content = '# Title\r\n\r\n\r\n\r\nbody';
    scp.platformWriteSync(target, content, { atomic: true });
    scp.platformWriteSync(other, content);
    assert.deepStrictEqual(fs.readFileSync(target), fs.readFileSync(other));
    assert.deepStrictEqual(siblings(), ['ARCHIVE.md', 'OTHER.md'], 'no temp file is left');
  });

  for (const destination of ['present', 'absent']) {
    test(`a temp-file write that fails partway never falls back to a direct write (destination ${destination})`, () => {
      if (destination === 'present') fs.writeFileSync(target, PREVIOUS);
      const before = destination === 'present' ? fs.readFileSync(target) : null;
      // The temp write lands some bytes, then fails; every write to the
      // destination itself truncates it first and then fails — the
      // direct-write fallback on a full disk.
      const restore = mockPartialWriteThenThrow(fs, (p) => typeof p === 'string' && p.startsWith(target), 3);
      try {
        assert.throws(() => scp.platformWriteSync(target, '# New\n', { atomic: true }), (err) => err.code === 'ENOSPC');
      } finally {
        restore();
      }
      if (before === null) assert.strictEqual(fs.existsSync(target), false, 'the destination stays absent');
      else assert.deepStrictEqual(fs.readFileSync(target), before, 'the destination keeps its previous bytes');
      assert.deepStrictEqual(siblings(), destination === 'present' ? ['ARCHIVE.md'] : [], 'the partial temp file is removed');
    });
  }

  test('the same failure under a default write truncates the destination (the fallback the atomic mode removes)', () => {
    fs.writeFileSync(target, PREVIOUS);
    const restore = mockPartialWriteThenThrow(fs, (p) => typeof p === 'string' && p.startsWith(target), 3);
    try {
      assert.throws(() => scp.platformWriteSync(target, '# New\n'), (err) => err.code === 'ENOSPC');
    } finally {
      restore();
    }
    assert.notDeepStrictEqual(fs.readFileSync(target), Buffer.from(PREVIOUS), 'the direct-write fallback damaged it');
  });

  test('a rename that cannot be atomic (EXDEV) throws and leaves the destination and no temp file', () => {
    fs.writeFileSync(target, PREVIOUS);
    mock.method(fs, 'renameSync', () => { throw errno('EXDEV'); });
    assert.throws(() => scp.platformWriteSync(target, '# New\n', { atomic: true }), (err) => err.code === 'EXDEV');
    mock.restoreAll();
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), PREVIOUS);
    assert.deepStrictEqual(siblings(), ['ARCHIVE.md']);
  });

  // ── platformRestoreFileSync ────────────────────────────────────────────

  test('a restore puts back the exact bytes, unnormalized', () => {
    const bytes = Buffer.concat([Buffer.from('# A\r\n\r\n\r\n\r\nno trailing newline'), Buffer.from([0xff, 0xfe])]);
    fs.writeFileSync(target, 'something else\n');
    scp.platformRestoreFileSync(target, bytes);
    assert.deepStrictEqual(fs.readFileSync(target), bytes);
    assert.deepStrictEqual(siblings(), ['ARCHIVE.md']);
  });

  test('restoring "absent" removes the file, and is a no-op when it is already gone', () => {
    fs.writeFileSync(target, PREVIOUS);
    scp.platformRestoreFileSync(target, null);
    assert.strictEqual(fs.existsSync(target), false);
    scp.platformRestoreFileSync(target, null);
    assert.deepStrictEqual(siblings(), []);
  });

  test('a restore whose temp write creates the file and then fails leaves no temp file and the destination as it was', () => {
    fs.writeFileSync(target, 'published block\n');
    const before = fs.readFileSync(target);
    const restore = mockPartialWriteThenThrow(fs, (p) => typeof p === 'string' && p.startsWith(target + '.restore.'), 2);
    try {
      assert.throws(() => scp.platformRestoreFileSync(target, Buffer.from(PREVIOUS)), (err) => err.code === 'ENOSPC');
    } finally {
      restore();
    }
    assert.deepStrictEqual(fs.readFileSync(target), before);
    assert.deepStrictEqual(siblings(), ['ARCHIVE.md'], 'the partial restore temp file is removed');
  });

  // ── platformReadBytesSync ──────────────────────────────────────────────

  test('a byte read returns the exact bytes, null when absent, and throws on other errors', () => {
    const bytes = Buffer.from([0x23, 0x0d, 0x0a, 0xff]);
    fs.writeFileSync(target, bytes);
    assert.deepStrictEqual(scp.platformReadBytesSync(target), bytes);
    assert.strictEqual(scp.platformReadBytesSync(path.join(dir, 'missing.md')), null);
    assert.throws(() => scp.platformReadBytesSync(dir), (err) => err.code === 'EISDIR');
  });
});
