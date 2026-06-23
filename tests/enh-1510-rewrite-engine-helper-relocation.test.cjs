'use strict';

// Enhancement #1510 (epic #1507, ADR-1508 Phase 1): behavior-preserving
// relocation of pure rewrite-engine helpers out of hand-authored bin/install.js.
//   - getDirName            -> gsd-core/bin/lib/runtime-name-policy.cjs
//   - processAttribution    -> gsd-core/bin/lib/runtime-artifact-conversion.cjs
// getCommitAttribution stays in install.js (impure install-time config I/O); the
// convertClaudeToAugmentMarkdown duplicate dedup is deferred to Phase 2's cleanup
// (entangled converter cluster; not required to unblock Phase 2).
// These tests exercise the REAL relocated functions at their new home (the
// generated .cjs) and assert install.js re-exports the SAME references
// (Hyrum: existing consumers import these names from bin/install.js).

const { test, describe } = require('node:test');
const assert = require('node:assert');

const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const installer = require('../bin/install.js');

// ── Slice A: getDirName relocated to runtime-name-policy ──────────────────────
describe('getDirName (relocated to runtime-name-policy)', () => {
  const EXPECTED = {
    claude: '.claude',
    copilot: '.github',
    opencode: '.opencode',
    gemini: '.gemini',
    kilo: '.kilo',
    codex: '.codex',
    antigravity: '.agents',
    cursor: '.cursor',
    windsurf: '.windsurf',
    augment: '.augment',
    trae: '.trae',
    qwen: '.qwen',
    hermes: '.hermes',
    kimi: '.kimi-code',
    codebuddy: '.codebuddy',
    cline: '.cline',
  };

  for (const [runtime, dir] of Object.entries(EXPECTED)) {
    test(`maps '${runtime}' to '${dir}'`, () => {
      assert.strictEqual(runtimeNamePolicy.getDirName(runtime), dir);
    });
  }

  test('falls back to .claude for an unknown runtime', () => {
    assert.strictEqual(runtimeNamePolicy.getDirName('definitely-not-a-runtime'), '.claude');
  });

  test('falls back to .claude for empty input', () => {
    assert.strictEqual(runtimeNamePolicy.getDirName(''), '.claude');
  });

  test('bin/install.js re-exports the SAME getDirName reference (no drift)', () => {
    assert.strictEqual(installer.getDirName, runtimeNamePolicy.getDirName);
  });
});

// ── Slice B: processAttribution relocated to runtime-artifact-conversion ───────
describe('processAttribution (relocated to runtime-artifact-conversion)', () => {
  test('null removes the Co-Authored-By line and its preceding blank line', () => {
    const input = 'Commit body line.\n\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, null), 'Commit body line.');
  });

  test('undefined leaves content unchanged', () => {
    const input = 'Commit body.\n\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, undefined), input);
  });

  test('a string replaces the attribution value', () => {
    const input = 'Body\n\nCo-Authored-By: Old Name <old@example.com>';
    assert.strictEqual(
      conversion.processAttribution(input, 'New Name <new@example.com>'),
      'Body\n\nCo-Authored-By: New Name <new@example.com>',
    );
  });

  test('escapes $ in the attribution to prevent backreference injection', () => {
    const input = 'Body\n\nCo-Authored-By: x';
    // "$1" must survive literally, not be interpreted as a regex backreference.
    assert.strictEqual(
      conversion.processAttribution(input, 'A $1 B'),
      'Body\n\nCo-Authored-By: A $1 B',
    );
  });

  test('handles CRLF when removing (null)', () => {
    const input = 'Body\r\n\r\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, null), 'Body');
  });

  test('replaces every Co-Authored-By line (global)', () => {
    const input = 'Body\nCo-Authored-By: A <a@x>\nCo-Authored-By: B <b@x>';
    assert.strictEqual(
      conversion.processAttribution(input, 'Z <z@x>'),
      'Body\nCo-Authored-By: Z <z@x>\nCo-Authored-By: Z <z@x>',
    );
  });

  test('bin/install.js re-exports the SAME processAttribution reference (no drift)', () => {
    // processAttribution remains an explicit installer compatibility relay, so
    // the export must keep pointing at the conversion module's implementation.
    assert.strictEqual(installer.processAttribution, conversion.processAttribution);
  });
});
