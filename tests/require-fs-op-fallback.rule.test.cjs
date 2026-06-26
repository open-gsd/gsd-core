'use strict';

/**
 * require-fs-op-fallback.rule.test.cjs
 *
 * RuleTester unit tests for the local/require-fs-op-fallback ESLint rule.
 *
 * Rule: flag a bare fs.rename / fs.renameSync call (the atomic-publish
 * primitive named first in DEFECT.WINDOWS-FS-OPS.symptom) that is NOT either:
 *   (a) inside a try/catch (the NEAREST catching try) whose catch handler BOTH
 *       references a transient errno ('EPERM' / 'EBUSY' / 'EACCES', literally
 *       or via a *RETRY_ERRNOS set) AND carries a retry signal (a loop
 *       `continue` backedge or a `return <call>` delegation — NOT a bare
 *       rethrow: the cure is retry, not just errno recognition), OR
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
 *  - fs.renameSync inside try/catch whose catch checks errno but only RETHROWS
 *    (HIGH-1 from codex review: errno reference alone is insufficient — no retry)
 *  - fs.renameSync inside an INNER try whose catch swallows, even with an OUTER
 *    try whose catch handles EPERM (HIGH-2: outer catch is unreachable)
 *
 * VALID (no violation):
 *  - fs.renameSync inside a retry loop whose catch checks errno + `continue`
 *  - fs.renameSync inside try/catch whose catch references RENAME_RETRY_ERRNOS set
 *  - fs.renameSync inside try/catch with switch(err.code) + return retry() (delegation)
 *  - fs.renameSync inside if (process.platform !== 'win32') { ... }
 *  - fs.renameSync after early-return guard / hoisted isWindows boolean
 *  - fs.renameSync inside a try-finally, protected by the NEXT enclosing catching try
 *  - fs.copyFileSync / fs.unlinkSync — NOT flagged (out of scope — fallback primitives)
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

  test('invalid: fs.renameSync inside try/catch whose catch checks errno but only RETHROWS (no retry)', () => {
    // HIGH-1 (codex review): referencing the errno is not enough — the defect's
    // cure is retry/fallback, not just recognition. A catch that checks the
    // errno and rethrows (no continue / no delegation) still fails on Windows
    // transient locks, so it is a violation.
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [],
      invalid: [
        {
          code: `function publish(tmp, target) {
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    if (e.code === 'EPERM') throw e;
    throw e;
  }
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
  test('valid: fs.renameSync inside a retry loop whose catch checks err.code === "EPERM" and continues', () => {
    // The minimal compliant shape: errno check + loop backedge (continue).
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function publish(tmp, target) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      if (e.code === 'EPERM') { backoff(); continue; }
      throw e;
    }
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

  test('valid: fs.renameSync inside try/catch with switch(err.code) casing EBUSY and EACCES, delegating via return retry()', () => {
    // The `return retry()` is a ReturnStatement-with-CallExpression — a retry
    // signal (delegation to a helper that performs its own bounded retry).
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

  test('invalid: fs.renameSync inside an INNER try whose catch swallows, with an OUTER try whose catch handles EPERM (HIGH-2)', () => {
    // HIGH-2 (codex review): the inner catch intercepts the rename error
    // (swallows it), so the outer errno-handling catch is UNREACHABLE for that
    // failure. Walking the full ancestor chain and treating the outer catch as
    // protective was a false negative. The nearest catching try's handler is
    // authoritative; since it swallows without retry, this is a violation.
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [],
      invalid: [
        {
          code: `function publish(tmp, target) {
  try {
    try {
      fs.renameSync(tmp, target);
    } catch (inner) {
      // inner cleanup, swallows the rename error — no retry
    }
  } catch (e) {
    if (e.code === 'EPERM') { return retry(); }
  }
}`,
          errors: [{ messageId: 'requireFsOpFallback' }],
        },
      ],
    });
  });

  test('valid: try-finally (no catch) is skipped — rename protected by the NEXT enclosing catching try', () => {
    // A try with only a finally does not intercept the rename error, so the
    // climb continues to the next enclosing TryStatement with a handler.
    ruleTester.run('require-fs-op-fallback', requireFsOpFallback, {
      valid: [
        `function publish(tmp, target) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      try {
        fs.renameSync(tmp, target);
      } finally {
        meter.tick();
      }
      return;
    } catch (e) {
      if (e.code === 'EPERM') { continue; }
      throw e;
    }
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
