'use strict';

// allow-test-rule: structural-regression-guard

/**
 * Slash-command namespace invariant (#3443).
 *
 * History:
 *   #3443 re-establishes `/gsd:<cmd>` as canonical in Claude-facing source text.
 *   The source repo is authored for Claude command registration under
 *   `.claude/commands/gsd/` (namespaced slash commands), while non-Claude runtimes
 *   perform install-time conversion (for example `/gsd:<cmd>` -> `/gsd-<cmd>`).
 *
 * Invariant enforced here:
 *   No `/gsd-<cmd>` pattern in Claude-facing source text.
 *
 * Exceptions:
 *   - CHANGELOG.md: historical entries document commands under their original names.
 *   - gsd-sdk / gsd-tools identifiers: never rewritten (not slash commands).
 *
 * ── PARTIAL INVALIDATION NOTICE (2026-05-23) ─────────────────────────────────
 *
 * The "no /gsd-<cmd> in source files" invariant (test below) is OUTDATED for
 * the runtime-emitter layer introduced by bug-3584 (2026-05-15).
 *
 * Two-tier model now in effect:
 *   • Claude-facing SOURCE TEXT (commands/, agents/, workflows/, references/,
 *     templates/, hooks/, .clinerules): still uses `/gsd:<cmd>` (colon) —
 *     THIS test's SEARCH_DIRS covered these correctly.
 *   • Runtime-emitted STRINGS persisted to ROADMAP.md, STATE.md,
 *     recommended_actions, fix hints, etc.: MUST use `/gsd-<cmd>` (hyphen) so
 *     that pasting a suggestion into Claude Code routes correctly.
 *     See `get-shit-done/bin/lib/runtime-slash.cjs:53` and the
 *     `tests/bug-3584-runtime-slash-emitters.test.cjs` canonical contract.
 *
 * The SEARCH_DIRS below include `get-shit-done/bin/lib/` where runtime-slash.cjs
 * lives. That file intentionally emits `/gsd-${token}` — which is correct —
 * but would be flagged as a "retired" reference by this test. Running this test
 * as-is caused PR #154 first-pass agent to revert the correct hyphen form to
 * colon form, breaking bug-3584's runtime contract. A 2nd-pass agent reverted.
 *
 * Resolution: the "no /gsd-<cmd>" scan is skipped (test.skip) to prevent
 * further agent misdirection. The transformer behavior tests (below) remain
 * active — they test the fix-slash-commands.cjs pure transform functions which
 * are still valid and unaffected by this two-tier model.
 *
 * Canonical reference for the CORRECT invariant:
 *   tests/bug-3584-runtime-slash-emitters.test.cjs
 *
 * DO NOT REVIVE the skipped test without first reading:
 *   - CONTEXT.md § "Slash-command form: /gsd-<cmd> (current) vs /gsd:<cmd> (legacy)"
 *   - docs/ARCHITECTURE.md § runtime install-time conversion
 *   - The PR #154 first-pass incident
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

const SEARCH_DIRS = [
  path.join(ROOT, 'get-shit-done', 'bin', 'lib'),
  path.join(ROOT, 'get-shit-done', 'workflows'),
  path.join(ROOT, 'get-shit-done', 'references'),
  path.join(ROOT, 'get-shit-done', 'templates'),
  COMMANDS_DIR,
  path.join(ROOT, 'agents'),
  path.join(ROOT, 'hooks'),
];

const TOP_LEVEL_FILES = [
  path.join(ROOT, '.clinerules'),
];

// Re-use SKIP_DIRS from the production script so the test's directory walker
// stays in lockstep with the fixer's. EXTENSIONS legitimately diverges (the
// guard scans only `.md`/`.cjs`/`.js` per the no-source-grep standard, while
// the fixer also rewrites `.ts`/`.tsx`), so it is not shared.
const { SKIP_DIRS } = require(path.join(ROOT, 'scripts', 'fix-slash-commands.cjs'));

const EXTENSIONS = new Set(['.md', '.cjs', '.js']);

function collectFiles(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectFiles(full, results);
    }
    else if (EXTENSIONS.has(path.extname(e.name))) results.push(full);
  }
  return results;
}

const cmdNames = fs.readdirSync(COMMANDS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => f.replace(/\.md$/, ''))
  .sort((a, b) => b.length - a.length);

const retiredPattern = new RegExp(`/gsd-(${cmdNames.join('|')})(?=[^a-zA-Z0-9_-]|$)`);

const allFiles = SEARCH_DIRS.flatMap(d => collectFiles(d));
const topLevelFiles = TOP_LEVEL_FILES.filter((file) => fs.existsSync(file));
const allUserFacingFiles = allFiles.concat(topLevelFiles);

describe('slash-command namespace invariant (#3443)', () => {
  test('commands/gsd/ directory contains known command files', () => {
    assert.ok(cmdNames.length > 0, 'commands/gsd/ must contain .md files');
    assert.ok(cmdNames.includes('plan-phase'), 'plan-phase must be a known command');
    assert.ok(cmdNames.includes('execute-phase'), 'execute-phase must be a known command');
  });

  // INVALIDATED 2026-05-23 — DO NOT REVIVE without reading the banner comment at
  // the top of this file and CONTEXT.md § "Slash-command form: /gsd-<cmd> vs /gsd:<cmd>".
  //
  // This invariant ("no /gsd-<cmd> in source files") was OUTDATED after bug-3584
  // introduced runtime-slash.cjs (2026-05-15), which intentionally emits the
  // hyphen form in runtime-persisted output. Running this test caused PR #154
  // first-pass to revert the correct hyphen form to colon form, breaking
  // tests/bug-3584-runtime-slash-emitters.test.cjs. See the header comment for full
  // context. The canonical active invariant lives in bug-3584-runtime-slash-emitters.
  test.skip('no /gsd-<cmd> retired syntax in Claude-facing source files [INVALIDATED — see header]', () => {
    const violations = [];
    for (const file of allUserFacingFiles) {
      const src = fs.readFileSync(file, 'utf-8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (retiredPattern.test(lines[i])) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${lines[i].trim().slice(0, 80)}`);
        }
      }
    }
    assert.strictEqual(
      violations.length,
      0,
      `Found ${violations.length} retired /gsd-<cmd> reference(s) — use /gsd:<cmd> instead:\n${violations.slice(0, 10).join('\n')}`,
    );
  });

  test('command filenames use canonical hyphenated command slugs', () => {
    const underscoreFiles = fs.readdirSync(COMMANDS_DIR)
      .filter((f) => f.endsWith('.md') && f.includes('_'));
    assert.deepStrictEqual(
      underscoreFiles,
      [],
      'command filenames feed generated skill/autocomplete names and must not contain underscores',
    );
  });

  describe('fix-slash-commands transformer behavior', () => {
    const { transformContent } = require(path.join(ROOT, 'scripts', 'fix-slash-commands.cjs'));
    // Use the live command names so the transformer matches the same surface
    // the production CLI rewrites.
    const liveCmdNames = cmdNames;

    test('rewrites /gsd-<cmd> to /gsd:<cmd>', () => {
      const out = transformContent('See /gsd-plan-phase for details.', liveCmdNames);
      assert.ok(out.includes('/gsd:plan-phase'), `expected /gsd:plan-phase, got: ${out}`);
      assert.ok(!out.includes('/gsd-plan-phase'), `dash form must not survive, got: ${out}`);
    });

    test('rewrites multiple occurrences in one pass', () => {
      const out = transformContent('Run /gsd-plan-phase then /gsd-execute-phase.', liveCmdNames);
      assert.ok(out.includes('/gsd:plan-phase'));
      assert.ok(out.includes('/gsd:execute-phase'));
      assert.ok(!out.match(/\/gsd-[a-z]/), `no dash form may remain, got: ${out}`);
    });

    test('does not rewrite canonical colon form (idempotent)', () => {
      const input = '/gsd:plan-phase is the canonical name.';
      assert.strictEqual(transformContent(input, liveCmdNames), input,
        'transformer must be a no-op when input is already canonical');
    });

    test('does not rewrite gsd-sdk or gsd-tools (not slash commands)', () => {
      const input = 'Run /gsd-sdk query and /gsd-tools init.';
      assert.strictEqual(transformContent(input, liveCmdNames), input,
        'transformer must leave non-command identifiers alone');
    });

    test('respects word boundary — does not rewrite /gsd-plan-phase-extra', () => {
      const out = transformContent('/gsd-plan-phase-extra', liveCmdNames);
      assert.strictEqual(out, '/gsd-plan-phase-extra',
        'word-boundary lookahead must prevent partial matches');
    });
  });

  test('transformer leaves non-command identifiers untouched', () => {
    const { transformContent } = require(path.join(ROOT, 'scripts', 'fix-slash-commands.cjs'));
    const sample = 'Use /gsd-sdk query and node bin/gsd-tools.cjs';
    assert.strictEqual(
      transformContent(sample, cmdNames),
      sample,
      'gsd-sdk and gsd-tools are not slash commands and must remain untouched'
    );
  });
});
