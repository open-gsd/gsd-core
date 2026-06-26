'use strict';

/**
 * require-fs-op-fallback.rule.test.cjs
 *
 * RuleTester unit tests for the local/require-fs-op-fallback ESLint rule.
 *
 * Rule: flag a bare fs.rename / fs.renameSync call (the atomic-publish
 * primitive named first in DEFECT.WINDOWS-FS-OPS.symptom) that is NOT either:
 *   (a) inside a try/catch whose catch handler references a transient errno
 *       ('EPERM' / 'EBUSY' / 'EACCES', literally or via a *RETRY_ERRNOS set),
 *       OR
 *   (b) control-dependent on a Windows platform guard
 *       (process.platform !== 'win32' / early-return — isWindowsExcludedNode).
 *
 * copyFile / unlink are deliberately NOT flagged: per the defect's own
 * .fix-forward ("catch EPERM/EBUSY/EACCES, fall back to copy + unlink with
 * retry") they are the FALLBACK PRIMITIVES, not separate defect sites, and
 * unlink has ~30 intentional best-effort try/catch-swallow cleanup sites that
 * would be a FP minefield. See the issue #1740 scope note.
 *
 * DEFECT category: DEFECT.WINDOWS-FS-OPS
 *
 * INVALID (violation expected):
 *  - bare fs.renameSync(tmp, target) — no try/catch, no guard
 *  - fs.renameSync inside try/catch (e) {} — silent swallow, no errno ref
 *  - fs.renameSync inside try/catch that cleans up + rethrows, no errno ref
 *    (the atomicWriteFileSync / atomicWriteInstallState shape — the real bug)
 *  - bare fs.rename(...) async
 *
 * VALID (no violation):
 *  - fs.renameSync inside try/catch whose catch checks err.code === 'EPERM'
 *  - fs.renameSync inside try/catch whose catch references RENAME_RETRY_ERRNOS
 *  - fs.renameSync inside try/catch with switch(err.code) case 'EBUSY'
 *  - fs.renameSync inside if (process.platform !== 'win32') { ... }
 *  - fs.renameSync after if (process.platform === 'win32') return; guard
 *  - fs.copyFileSync / fs.unlinkSync — NOT flagged (out of scope)
 *  - fs.readFileSync / fs.writeFileSync — NOT flagged (not rename)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const requireFsOpFallback = require('../eslint-rules/require-fs-op-fallback.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('require-fs-op-fallback rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof requireFsOpFallback.meta, 'object');
    assert.strictEqual(typeof requireFsOpFallback.create, 'function');
    assert.strictEqual(requireFsOpFallback.meta.type, 'problem');
    assert.ok(requireFsOpFallback.meta.messages.requireFsOpFallback);
  });
});

// ─── INVALID cases (violation expected) ───────────────────────────────────────

describe('require-fs-op-fallback invalid cases', () => {
  test('invalid: bare fs.renameSync with no try/catch and no guard', () => {
    // The canonical atomic-publish defect: a reader holding the target open
    // makes renameSync throw EPERM/EBUSY on Windows, which propagates unhandled.
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [],
      invalid: [
        {
          code: `function publish(tmp, target) {
  fs.renameSync(tmp, target);
}`,
          errors: [{ messageId: 'requireFsOpFallback' }],
        },
      ],
    });
  });

  test('invalid: fs.renameSync inside try/catch (e) {} — silent swallow, no errno ref', () => {
    // "never silently swallow" — the defect fix-forward explicitly forbids this.
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [],
      invalid: [
        {
          code: `function publish(tmp, target) {
  try { fs.renameSync(tmp, target); } catch (e) {}
}`,
          errors: [{ messageId: 'requireFsOpFallback' }],
        },
      ],
    });
  });

  test('invalid: fs.renameSync inside try/catch that cleans up + rethrows, no errno ref (atomicWriteFileSync shape)', () => {
    // This is the real production bug: the catch handles a write-failure cleanup
    // path but does NOT retry the transient Windows lock — EPERM/EBUSY throws
    // immediately without the established RENAME_RETRY_ERRNOS backoff.
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [],
      invalid: [
        {
          code: `function atomicWriteFileSync(target, data) {
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}`,
          errors: [{ messageId: 'requireFsOpFallback' }],
        },
      ],
    });
  });

  test('invalid: bare fs.rename(...) async', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [],
      invalid: [
        {
          code: `function publishAsync(tmp, target, cb) {
  fs.rename(tmp, target, cb);
}`,
          errors: [{ messageId: 'requireFsOpFallback' }],
        },
      ],
    });
  });

  test('invalid: fs.renameSync inside try/catch whose catch references an UNRELATED errno (ENOENT) only', () => {
    // A catch handling ENOENT does NOT protect against the EPERM/EBUSY/EACCES
    // transient-lock family — still a violation.
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [],
      invalid: [
        {
          code: `function publish(tmp, target) {
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
}`,
          errors: [{ messageId: 'requireFsOpFallback' }],
        },
      ],
    });
  });
});

// ─── VALID cases (no violation) ───────────────────────────────────────────────

describe('require-fs-op-fallback valid cases', () => {
  test('valid: fs.renameSync inside try/catch whose catch checks err.code === "EPERM"', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function publish(tmp, target) {
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    if (e.code === 'EPERM') { /* retry logic */ }
  }
}`,
      ],
      invalid: [],
    });
  });

  test('valid: fs.renameSync inside try/catch whose catch references RENAME_RETRY_ERRNOS set (canonical pattern)', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
function atomicRenameWithRetry(tmpPath, filePath) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return null;
    } catch (err) {
      if (attempt < 3 && RENAME_RETRY_ERRNOS.has(err.code)) {
        backoff();
        continue;
      }
      break;
    }
  }
}`,
      ],
      invalid: [],
    });
  });

  test('valid: fs.renameSync inside try/catch with switch(err.code) casing EBUSY and EACCES', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function publish(tmp, target) {
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    switch (e.code) {
      case 'EBUSY':
      case 'EACCES':
        return retry();
    }
    throw e;
  }
}`,
      ],
      invalid: [],
    });
  });

  test('valid: fs.renameSync inside if (process.platform !== "win32") block (platform guard)', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function publish(tmp, target) {
  if (process.platform !== 'win32') {
    fs.renameSync(tmp, target);
  }
}`,
      ],
      invalid: [],
    });
  });

  test('valid: fs.renameSync after early-return Windows guard', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function publish(tmp, target) {
  if (process.platform === 'win32') return;
  fs.renameSync(tmp, target);
}`,
      ],
      invalid: [],
    });
  });

  test('valid: fs.copyFileSync and fs.unlinkSync are NOT flagged (out of scope — fallback primitives)', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function stage(src, dest) { fs.copyFileSync(src, dest); }`,
        `function cleanup(p) { fs.unlinkSync(p); }`,
        `function cleanupSwallow(p) { try { fs.unlinkSync(p); } catch (_) {} }`,
      ],
      invalid: [],
    });
  });

  test('valid: fs.readFileSync / fs.writeFileSync are NOT flagged (not rename)', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function read(p) { return fs.readFileSync(p, 'utf8'); }`,
        `function write(p, d) { fs.writeFileSync(p, d); }`,
      ],
      invalid: [],
    });
  });

  test('valid: fs.renameSync inside a try nested in an OUTER try whose catch handles EPERM', () => {
    // The rename is protected by the outer errno-handling catch even though
    // the immediate (inner) try's catch is bare. Walking the full ancestor
    // chain avoids a false positive here.
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function publish(tmp, target) {
  try {
    try {
      fs.renameSync(tmp, target);
    } catch (inner) {
      // inner cleanup, no errno
    }
  } catch (e) {
    if (e.code === 'EPERM') { /* outer handles it */ }
  }
}`,
      ],
      invalid: [],
    });
  });

  test('valid: hoisted isWindows boolean guard consumed by if (!isWindows)', () => {
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function publish(tmp, target) {
  const isWindows = process.platform === 'win32';
  if (!isWindows) {
    fs.renameSync(tmp, target);
  }
}`,
      ],
      invalid: [],
    });
  });
});
