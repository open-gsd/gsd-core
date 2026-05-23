'use strict';

// allow-test-rule: structural-regression-guard

/**
 * Slash-command namespace invariant (#3443) — SCOPED ACTIVE VARIANT.
 *
 * History:
 *   #3443 re-establishes `/gsd:<cmd>` as canonical in Claude-facing source text.
 *   The source repo is authored for Claude command registration under
 *   `.claude/commands/gsd/` (namespaced slash commands), while non-Claude runtimes
 *   perform install-time conversion (for example `/gsd:<cmd>` -> `/gsd-<cmd>`).
 *
 * Two-tier model (current — see CONTEXT.md § "Slash-command form: directory-level matrix"):
 *   • Claude-facing SOURCE TEXT (commands/, agents/, workflows/, references/,
 *     templates/, hooks/, .clinerules): uses `/gsd:<cmd>` (colon).
 *     THIS test enforces the colon invariant over those directories.
 *   • Runtime-emitter contexts (runtime-slash.cjs, phase-lifecycle-policy.ts,
 *     *.generated.cjs, bug-3584 test file): use `/gsd-<cmd>` (hyphen) per
 *     bug-3584's contract. Those files are EXCLUDED from this scan.
 *
 * Scoped invariant enforced here:
 *   No `/gsd-<cmd>` pattern in Claude-facing source files, EXCLUDING the
 *   runtime-emitter contexts listed in RUNTIME_EMITTER_EXCLUDES below.
 *
 * Canonical reference for the runtime-emitter (hyphen-form) contract:
 *   tests/bug-3584-runtime-slash-emitters.test.cjs
 *
 * DO NOT expand RUNTIME_EMITTER_EXCLUDES without also updating the bug-3584
 * test and CONTEXT.md § "Slash-command form: directory-level matrix".
 *
 * See also: PR #154 first-pass incident (agent applied outdated invariant,
 * broke bug-3584 contract); PR #164 Codex adversarial review (surfaced the
 * need to re-activate this test with explicit exclusions).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

// Runtime-emitter contexts: these files intentionally emit `/gsd-<cmd>` (hyphen)
// as part of the bug-3584 runtime contract. They must NOT be scanned by this
// invariant — doing so caused PR #154 first-pass to revert correct hyphen form
// to colon form, breaking bug-3584-runtime-slash-emitters.test.cjs.
//
// Expand this list only if a new runtime-emitter module is introduced AND the
// bug-3584 test is updated to cover it.
const RUNTIME_EMITTER_EXCLUDES = new Set([
  // Primary runtime-slash emitter (bug-3584 canonical contract):
  path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'runtime-slash.cjs'),
  // phase-lifecycle-policy.ts emits runtime-persisted slash references (bug-3584):
  path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'phase-lifecycle-policy.ts'),
  // Generated CJS files match the TS source's emitted form — never hand-edited:
  // (matched below by .generated.cjs extension — see collectFiles exclusion)
]);

const SEARCH_DIRS = [
  // NOTE: get-shit-done/bin/lib is intentionally EXCLUDED from SEARCH_DIRS.
  // runtime-slash.cjs and *.generated.cjs live there and use the hyphen form
  // per bug-3584's runtime-emitter contract. The full bin/lib tree is
  // runtime-emitter territory — scanning it would cause false positives.
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

  // SCOPED ACTIVE INVARIANT (2026-05-23 re-activation after Codex adversarial review of PR #164).
  //
  // Scan is scoped to Claude-facing source directories only (SEARCH_DIRS above).
  // get-shit-done/bin/lib/ is excluded entirely — runtime-slash.cjs and
  // *.generated.cjs there use hyphen form per bug-3584's runtime-emitter contract.
  //
  // If this test fails: check CONTEXT.md § "Slash-command form: directory-level matrix"
  // before deciding whether to update the file or add to RUNTIME_EMITTER_EXCLUDES.
  test('no /gsd-<cmd> retired syntax in Claude-facing source files (scoped — excludes runtime-emitter contexts)', () => {
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
