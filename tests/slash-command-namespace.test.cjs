'use strict';

// Slash / colon command-namespace invariant tests.
//
// Consolidated home for the namespace-leak regression suites (epic #1969, batch
// B6 #1975). Each block below is folded verbatim from its origin issue-named
// file and carries its origin issue number for provenance. These tests share no
// production module — they assert the cross-surface invariant that GSD command,
// agent, and workflow bodies use the hyphen form (`gsd-<cmd>`) and never leak the
// deprecated colon/slash namespace after install/conversion.


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2543-gsd-slash-namespace.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2543-gsd-slash-namespace (consolidation epic #1969 B6 #1975)", () => {
'use strict';

// allow-test-rule: structural-regression-guard (see #2543)

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

const SEARCH_DIRS = [
  // NOTE: gsd-core/bin/lib is intentionally EXCLUDED from SEARCH_DIRS.
  // runtime-slash.cjs and *.generated.cjs live there and use the hyphen form
  // per bug-3584's runtime-emitter contract. The full bin/lib tree is
  // runtime-emitter territory — scanning it would cause false positives.
  path.join(ROOT, 'gsd-core', 'workflows'),
  path.join(ROOT, 'gsd-core', 'references'),
  path.join(ROOT, 'gsd-core', 'templates'),
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
  // gsd-core/bin/lib/ is excluded entirely — runtime-slash.cjs and
  // *.generated.cjs there use hyphen form per bug-3584's runtime-emitter contract.
  //
  // If this test fails: check CONTEXT.md § "Slash-command form: directory-level matrix"
  // before deciding whether to update the file or add to RUNTIME_EMITTER_EXCLUDES.
  test('no /gsd-<cmd> retired syntax in Claude-facing source files (scoped — excludes runtime-emitter contexts)', () => {
    const violations = [];
    for (const file of allUserFacingFiles) {
      const src = fs.readFileSync(file, 'utf-8');
      const lines = src.split(/\r?\n/);
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
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3677-agent-colon-namespace-leak.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3677-agent-colon-namespace-leak (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #3677)
// Tests A1/A2/B inspect agent / installed `.md` bodies whose deployed text IS
// the runtime contract. Tests C exercises the install.js exported pure helper
// `shouldNormalizeHyphenNamespaceInAgentBody` directly — purely behavioral.

/**
 * Regression for #3677 — installed agent bodies leak `/gsd:<cmd>` colon refs
 * for Claude / Qwen / Hermes (unroutable since #2808).
 *
 * Root cause: `bin/install.js` agent install loop (around line 8350-8447)
 * reads each agent .md, runs runtime-specific transforms via
 * `convertClaudeAgentToXAgent()`, then writes the result. For:
 *   - Self-converting runtimes (Copilot/Codex/Cursor/Windsurf/Augment/Trae/
 *     Codebuddy/Cline/Antigravity/Opencode/Kilo): their converters handle
 *     namespace themselves.
 *   - Gemini: intentionally uses colon namespace.
 *   - Claude-default / Qwen / Hermes: register hyphen-form `name:` (#2808)
 *     but copy bodies verbatim (Qwen/Hermes do branding-only swaps; Claude
 *     does no namespace work). The retired `/gsd:<cmd>` colon refs leak.
 *
 * Sibling fixes #3583 (SKILL.md, via #3629) and #3584 (runtime emissions, via
 * #3606) covered the other two surfaces. This is the agent-body surface.
 *
 * Fix surface:
 *   1. `bin/install.js` exports a pure predicate
 *      `shouldNormalizeHyphenNamespaceInAgentBody(runtime)` plus a helper
 *      `normalizeAgentBodyForRuntime(content, runtime, cmdNames)` that
 *      conditionally applies `transformContentToHyphen` from
 *      scripts/fix-slash-commands.cjs.
 *   2. The agent install loop calls the helper after all runtime-specific
 *      conversions but before writeFileSync.
 *   3. This regression test guards both the predicate and the integration.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Single `..` traversal matches the existing tests/helpers.cjs convention
// (TOOLS_PATH at tests/helpers.cjs:21). Avoids `..` chains per CLAUDE.md and
// works in the docker mirror at /work/tests (which has no `.git` to anchor on).
const REPO_ROOT = path.resolve(__dirname, '..');

const install = require(path.join(REPO_ROOT, 'bin', 'install.js'));
const { transformContentToHyphen } = require(path.join(REPO_ROOT, 'scripts', 'fix-slash-commands.cjs'));

// Snapshot of all runtime IDs in the layout table at the time of this fix.
// Keep these two sets covering: any runtime listed in
// runtime-artifact-layout.cjs MUST appear in exactly one bucket.
const HYPHEN_NAME_AGENT_RUNTIMES = ['claude', 'qwen', 'hermes'];
const SELF_CONVERTING_OR_COLON_RUNTIMES = [
  'codex', 'copilot', 'antigravity', 'cursor', 'windsurf', 'augment',
  'trae', 'codebuddy', 'cline',
  'opencode', 'kilo',
];

describe('bug #3677 — agent body colon-namespace leak (Claude / Qwen / Hermes)', () => {

  describe('A — install.js exports the pure predicate + helper', () => {
    test('A1: shouldNormalizeHyphenNamespaceInAgentBody is an exported function', () => {
      assert.strictEqual(
        typeof install.shouldNormalizeHyphenNamespaceInAgentBody,
        'function',
        'bin/install.js must export shouldNormalizeHyphenNamespaceInAgentBody as the runtime predicate (regression seam for #3677)',
      );
    });

    test('A2: normalizeAgentBodyForRuntime is an exported function', () => {
      assert.strictEqual(
        typeof install.normalizeAgentBodyForRuntime,
        'function',
        'bin/install.js must export normalizeAgentBodyForRuntime as the wired helper called by the agent install loop',
      );
    });
  });

  describe('B — predicate returns true for hyphen-`name:` runtimes and false otherwise', () => {
    const { shouldNormalizeHyphenNamespaceInAgentBody } = install;

    for (const runtime of HYPHEN_NAME_AGENT_RUNTIMES) {
      test(`B+ '${runtime}': normalize hyphen namespace (true)`, () => {
        assert.strictEqual(
          shouldNormalizeHyphenNamespaceInAgentBody(runtime),
          true,
          `${runtime} registers hyphen-form 'name:' (#2808) and copies agent bodies verbatim — must normalize`,
        );
      });
    }

    for (const runtime of SELF_CONVERTING_OR_COLON_RUNTIMES) {
      test(`B- '${runtime}': skip normalization (false)`, () => {
        assert.strictEqual(
          shouldNormalizeHyphenNamespaceInAgentBody(runtime),
          false,
          `${runtime} either self-converts via convertClaudeAgentToXAgent or intentionally uses colon — must NOT re-rewrite`,
        );
      });
    }

    test('B?: unknown runtime defaults to false (conservative)', () => {
      assert.strictEqual(
        shouldNormalizeHyphenNamespaceInAgentBody('bogus-runtime-id'),
        false,
        'unknown runtimes must not be normalized — better to leak than to mangle',
      );
    });
  });

  describe('C — normalizeAgentBodyForRuntime applies transformContentToHyphen iff predicate is true', () => {
    const { normalizeAgentBodyForRuntime } = install;
    // Sample agent body with colon refs that #2808 retired.
    const inputBody = [
      '# Agent prose',
      '',
      'Run `/gsd:execute-phase 1 --tdd` to execute the phase.',
      'Then `/gsd:verify-work 1` to verify.',
      'Reference unchanged: `gsd-sdk query commit` (this is a CLI binary, not a slash command).',
    ].join('\n');
    // Only known commands from commands/gsd/*.md should be rewritten; gsd-sdk
    // (a binary) must stay untouched.
    const cmdNames = ['execute-phase', 'verify-work', 'plan-phase'];

    test('C1: claude — rewrites both colon refs to hyphen', () => {
      const out = normalizeAgentBodyForRuntime(inputBody, 'claude', cmdNames);
      assert.ok(out.includes('/gsd-execute-phase'), 'execute-phase must be rewritten to hyphen form');
      assert.ok(out.includes('/gsd-verify-work'), 'verify-work must be rewritten to hyphen form');
      assert.ok(!out.includes('/gsd:execute-phase'), 'colon form for execute-phase must be gone');
      assert.ok(!out.includes('/gsd:verify-work'), 'colon form for verify-work must be gone');
      assert.ok(out.includes('gsd-sdk query commit'), 'gsd-sdk (CLI binary) must not be touched');
    });

    test('C2: qwen — same transform applies', () => {
      const out = normalizeAgentBodyForRuntime(inputBody, 'qwen', cmdNames);
      assert.ok(out.includes('/gsd-execute-phase'));
      assert.ok(!out.includes('/gsd:execute-phase'));
    });

    test('C3: hermes — same transform applies', () => {
      const out = normalizeAgentBodyForRuntime(inputBody, 'hermes', cmdNames);
      assert.ok(out.includes('/gsd-execute-phase'));
      assert.ok(!out.includes('/gsd:execute-phase'));
    });

    test('C5: self-converting runtime (copilot) — body returned unchanged at this layer', () => {
      const out = normalizeAgentBodyForRuntime(inputBody, 'copilot', cmdNames);
      // Copilot has its own convertClaudeAgentToCopilotAgent that handles
      // namespace — the normalize layer is a no-op for it.
      assert.strictEqual(out, inputBody);
    });
  });

  describe('D — sanity check: the underlying transform actually works against real cmd names', () => {
    test('D1: transformContentToHyphen rewrites /gsd:<cmd> to /gsd-<cmd> for known cmds only', () => {
      const out = transformContentToHyphen(
        'A /gsd:execute-phase B /gsd:unknown-cmd C /gsd-sdk D',
        ['execute-phase'],
      );
      assert.ok(out.includes('/gsd-execute-phase'), 'known cmd rewritten');
      assert.ok(out.includes('/gsd:unknown-cmd'), 'unknown cmd preserved (longest-first matcher only rewrites registered names)');
      assert.ok(out.includes('/gsd-sdk'), 'gsd-sdk (binary, not slash command) preserved');
    });
  });

  // ---------------------------------------------------------------------------
  // E — Behavioral coverage ported from PR #3681 (johnzilla / John Turner).
  //
  // #3681 proposed the same allow-list fix independently and was closed by its
  // author in favor of this PR. Its test file contributed two coverage angles
  // worth keeping: real-source efficacy against every `agents/gsd-*.md` (the
  // shape of bug that pure-function tests miss) and idempotence-via-fixpoint
  // (guards against double-rewrite on reinstall). Credit: johnzilla.
  // ---------------------------------------------------------------------------
  describe('E — real-source efficacy + idempotence (ported from #3681, credit: johnzilla)', () => {
    const fs = require('node:fs');
    const { readCmdNames } = require(path.join(REPO_ROOT, 'scripts', 'fix-slash-commands.cjs'));
    const cmdNames = readCmdNames();

    // Roster regex matches any registered command in `gsd:<cmd>` form with a
    // negative lookbehind (so `mygsd:foo` is ignored) and a non-word lookahead
    // (so `plan-phase-extra` is not a false match for `plan-phase`).
    const roster = () => new RegExp(
      `(?<![a-zA-Z0-9_-])gsd:(${[...cmdNames].sort((a, b) => b.length - a.length).join('|')})(?=[^a-zA-Z0-9_-]|$)`,
    );

    test('E0: command roster is populated and contains the symptom commands', () => {
      assert.ok(cmdNames.length > 0, 'command roster must be populated');
      assert.ok(cmdNames.includes('execute-phase'));
      assert.ok(cmdNames.includes('plan-phase'));
    });

    test('E1: every agents/gsd-*.md transforms clean — no roster colon refs survive', () => {
      const agentsDir = path.join(REPO_ROOT, 'agents');
      const offenders = [];
      // Not the shared listAgentFiles() helper: this needs full `.md` filenames
      // (not stripped basenames) to readFileSync + transform each agent body.
      for (const f of fs.readdirSync(agentsDir)) {
        if (!f.startsWith('gsd-') || !f.endsWith('.md')) continue;
        const src = fs.readFileSync(path.join(agentsDir, f), 'utf-8');
        const out = transformContentToHyphen(src, cmdNames);
        if (roster().test(out)) offenders.push(f);
      }
      assert.deepEqual(
        offenders,
        [],
        `agents still carry roster colon refs after transform: ${offenders.join(', ')}`,
      );
    });

    test('E2: idempotent — transform of already-hyphenated input is a no-op', () => {
      const input = 'use /gsd-plan-phase next, then /gsd-execute-phase';
      assert.strictEqual(
        transformContentToHyphen(input, cmdNames),
        input,
        'reinstalls re-run the transform; double application must not mangle the body',
      );
    });

    test('E3: word boundary — /gsd:plan-phase-extra is not a roster match', () => {
      assert.strictEqual(
        transformContentToHyphen('/gsd:plan-phase-extra', cmdNames),
        '/gsd:plan-phase-extra',
      );
    });

    test('E4: rewrites bare `gsd:<cmd>` shorthand (no leading slash)', () => {
      const out = transformContentToHyphen(
        'Spawned by the gsd:execute-phase orchestrator.',
        cmdNames,
      );
      assert.strictEqual(out, 'Spawned by the gsd-execute-phase orchestrator.');
    });
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3683-command-colon-namespace-leak.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3683-command-colon-namespace-leak (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #3683)
// Command `.md` files — their staged text IS the runtime contract loaded by
// Claude Code. Asserting that staged bodies lack `/gsd:<cmd>` colon refs is
// a behavioral test of the install transform, not source-grep theater.

/**
 * Regression for #3683 — installed command bodies leak `/gsd:<cmd>` colon refs
 * for Claude Code local installs.
 *
 * Root cause: `bin/install.js` command install path (`copyWithPathReplacement`,
 * around line 8296 in the `else` branch) copies each command `.md` body without
 * applying the hyphen-namespace normalizer that the agent install loop gained in
 * PR #3677. Static prose in `commands/gsd/*.md` (e.g. plan-phase.md referencing
 * `/gsd:execute-phase`) therefore reaches the model verbatim, causing the model
 * to echo the retired colon form at workflow boundaries.
 *
 * Fix surface:
 *   Call `normalizeAgentBodyForRuntime` (or an equivalent helper) in the command
 *   staging path after all other rewrites but before writeFileSync, mirroring
 *   the agent install loop fix from #3677.
 *
 * This test guards the behavioral integration: run a real local claude install
 * into a temp dir, then assert that no staged command body contains a
 * `/gsd:<known-cmd>` colon ref.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_PATH = path.join(REPO_ROOT, 'bin', 'install.js');

const install = require(INSTALL_PATH);
const { readCmdNames } = require(path.join(REPO_ROOT, 'scripts', 'fix-slash-commands.cjs'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `node install.js --claude --local --no-sdk` in tmpDir.
 * GSD_TEST_MODE must be cleared so the install() main block executes.
 */
function runClaudeLocalInstall(cwd) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  const r = runNode([INSTALL_PATH, '--claude', '--local', '--no-sdk'], {
    cwd,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  throwIfFailed(r, `node ${INSTALL_PATH} --claude --local --no-sdk`);
}

/**
 * Build the roster regex that matches `/gsd:<known-cmd>` or `gsd:<known-cmd>`
 * (with appropriate word boundaries). Mirrors the pattern used in bug-3677.
 */
function buildRosterRegex(cmdNames) {
  const sorted = [...cmdNames].sort((a, b) => b.length - a.length);
  return new RegExp(
    `(?<![a-zA-Z0-9_-])gsd:(${sorted.join('|')})(?=[^a-zA-Z0-9_-]|$)`,
  );
}

// ---------------------------------------------------------------------------
// Suite A — export surface: normalizeAgentBodyForRuntime must be exported
// (same seam used for command bodies)
// ---------------------------------------------------------------------------
describe('bug #3683 — command body colon-namespace leak (Claude local install)', () => {

  describe('A — install.js exports the normalizer seam', () => {
    test('A1: normalizeAgentBodyForRuntime is exported (reused for command bodies)', () => {
      assert.strictEqual(
        typeof install.normalizeAgentBodyForRuntime,
        'function',
        'bin/install.js must export normalizeAgentBodyForRuntime — the seam used for both agent and command body normalization',
      );
    });

    test('A2: shouldNormalizeHyphenNamespaceInAgentBody is exported and true for claude', () => {
      assert.strictEqual(
        typeof install.shouldNormalizeHyphenNamespaceInAgentBody,
        'function',
      );
      assert.strictEqual(
        install.shouldNormalizeHyphenNamespaceInAgentBody('claude'),
        true,
        'claude must normalize hyphen namespace — it is in the allow-list from #2808',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // B — pure-function coverage: normalizer rewrites command body colon refs
  // ---------------------------------------------------------------------------
  describe('B — normalizeAgentBodyForRuntime rewrites colon refs in command-body prose', () => {
    const { normalizeAgentBodyForRuntime } = install;
    const cmdNames = readCmdNames();

    test('B0: command roster is populated and includes symptom commands', () => {
      assert.ok(cmdNames.length > 0, 'readCmdNames() must return a non-empty list');
      assert.ok(cmdNames.includes('execute-phase'), 'roster must include execute-phase');
      assert.ok(cmdNames.includes('plan-phase'), 'roster must include plan-phase');
    });

    test('B1: claude — rewrites /gsd:<cmd> colon refs in command-body prose to hyphen form', () => {
      const input = [
        '## After planning',
        '',
        'Run `/gsd:execute-phase 1 --tdd` to begin execution.',
        'Then use `/gsd:verify-work 1` when done.',
      ].join('\n');
      const out = normalizeAgentBodyForRuntime(input, 'claude', cmdNames);
      assert.ok(out.includes('/gsd-execute-phase'), 'execute-phase must be rewritten to hyphen form');
      assert.ok(out.includes('/gsd-verify-work'), 'verify-work must be rewritten to hyphen form');
      assert.ok(!out.includes('/gsd:execute-phase'), 'colon form for execute-phase must be absent');
      assert.ok(!out.includes('/gsd:verify-work'), 'colon form for verify-work must be absent');
    });

    test('B2: gemini — colon refs preserved (Gemini intentionally uses colon namespace)', () => {
      const input = 'Run `/gsd:execute-phase 1` to begin.';
      const out = normalizeAgentBodyForRuntime(input, 'gemini', cmdNames);
      assert.ok(out.includes('/gsd:execute-phase'), 'Gemini must keep colon form');
      assert.ok(!out.includes('/gsd-execute-phase'), 'Gemini must not have hyphen form injected');
    });
  });

  // ---------------------------------------------------------------------------
  // E — Integration: real local claude install produces clean command bodies
  // ---------------------------------------------------------------------------
  // E — integration: flat gsd-*.md layout + clean bodies (#1367 fix)
  //
  // Prior to #1367: commands wrote to commands/gsd/<cmd>.md (bare names in a
  // subdir), causing Claude Code to namespace them as /gsd:<cmd> (colon form).
  // After #1367: commands write flat gsd-<cmd>.md at commands/ level so Claude
  // Code registers them as /gsd-<cmd> (hyphen form, matching all framework refs).
  // ---------------------------------------------------------------------------
  describe('E — integration: staged gsd-*.md flat commands contain no colon-namespace refs', () => {
    let tmpDir;
    const cmdNames = readCmdNames();
    const rosterRegex = buildRosterRegex(cmdNames);

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3683-'));
      runClaudeLocalInstall(tmpDir);
    });

    after(() => {
      cleanup(tmpDir);
    });

    test('E0: staged commands/ directory has flat gsd-*.md files after install (#1367)', () => {
      // After #1367 fix: commands land at .claude/commands/gsd-<cmd>.md (flat,
      // hyphen-prefixed). The old .claude/commands/gsd/<cmd>.md subdirectory
      // layout must NOT be created.
      const commandsDir = path.join(tmpDir, '.claude', 'commands');
      assert.ok(
        fs.existsSync(commandsDir),
        `commands/ must be created by local claude install at ${commandsDir}`,
      );
      const flatFiles = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
      assert.ok(
        flatFiles.length > 0,
        `commands/ must contain flat gsd-*.md files (e.g. gsd-help.md). ` +
        `Found none — install may still be using the old commands/gsd/<cmd>.md subdirectory layout.`,
      );
      // The old subdirectory must NOT exist (it caused /gsd:<cmd> colon namespace)
      const oldSubdir = path.join(commandsDir, 'gsd');
      assert.ok(
        !fs.existsSync(oldSubdir),
        `commands/gsd/ subdir must NOT exist after install (it causes /gsd:<cmd> colon namespace in Claude Code). ` +
        `#1367 fix: use flat gsd-<cmd>.md at commands/ level instead.`,
      );
    });

    test('E1: no staged command body contains /gsd:<known-cmd> colon refs', () => {
      const commandsDir = path.join(tmpDir, '.claude', 'commands');
      assert.ok(fs.existsSync(commandsDir), 'commands/ must exist for this check to be meaningful');

      const offenders = [];

      for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (!entry.name.startsWith('gsd-')) continue;
        const fullPath = path.join(commandsDir, entry.name);
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (rosterRegex.test(content)) {
          offenders.push(path.relative(tmpDir, fullPath));
        }
      }

      assert.deepEqual(
        offenders,
        [],
        `Staged command bodies still contain roster colon refs (e.g. /gsd:execute-phase). ` +
        `Install must normalize these to /gsd-<cmd> for claude runtime. Offenders: ${offenders.join(', ')}`,
      );
    });

    test('E2: idempotent — re-running install does not double-mangle already-hyphenated refs', () => {
      // Run install a second time; if the normalizer double-applies it would
      // produce garbled output like /gsd--execute-phase. Verify the commands
      // still pass the same cleanliness check after a second install.
      runClaudeLocalInstall(tmpDir);

      const commandsDir = path.join(tmpDir, '.claude', 'commands');
      const doubleRewriteRegex = /\/gsd--[a-z]/;
      const garbled = [];

      for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (!entry.name.startsWith('gsd-')) continue;
        const content = fs.readFileSync(path.join(commandsDir, entry.name), 'utf-8');
        if (doubleRewriteRegex.test(content)) {
          garbled.push(entry.name);
        }
      }

      assert.deepEqual(
        garbled,
        [],
        `Re-install produced double-hyphen artifacts (/gsd--cmd) — normalizer is not idempotent. Garbled files: ${garbled.join(', ')}`,
      );
    });
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3683-workflow-colon-namespace-leak.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3683-workflow-colon-namespace-leak (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #3683)
// Workflow and reference `.md` files are deployed verbatim as part of the
// gsd-core skill payload — their staged text IS the runtime contract
// loaded by Claude Code. Asserting that staged bodies lack `/gsd:<cmd>`
// colon refs is a behavioral test of the install transform, not
// source-grep theater.

/**
 * Regression for #3683 — installed workflow/reference bodies leak `/gsd:<cmd>`
 * colon refs for Claude Code local installs.
 *
 * Root cause: `copyWithPathReplacement` in `bin/install.js` guarded the
 * `normalizeAgentBodyForRuntime` call behind `if (isCommand)`, so the
 * `gsd-core/` directory (workflows, references — all `isCommand=false`)
 * was copied without applying the hyphen-namespace normalizer. Static prose
 * in `gsd-core/workflows/*.md` and `gsd-core/references/*.md`
 * (e.g. discuss-phase.md referencing `/gsd:plan-phase`) therefore reached
 * the model verbatim, causing it to echo the retired colon form.
 *
 * Fix surface:
 *   Remove the `if (isCommand)` guard so `normalizeAgentBodyForRuntime` is
 *   called unconditionally in `copyWithPathReplacement`. The function
 *   self-gates on `shouldNormalizeHyphenNamespaceInAgentBody(runtime)` and
 *   is a no-op for colon-canonical runtimes (Gemini, Codex, etc.).
 *
 * User repro path: `/gsd-discuss-phase` output ends with `/gsd:nextcommand`
 * because discuss-phase.md (7 colon refs) is not normalized at install time.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_PATH = path.join(REPO_ROOT, 'bin', 'install.js');

require(INSTALL_PATH);
const { readCmdNames } = require(path.join(REPO_ROOT, 'scripts', 'fix-slash-commands.cjs'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `node install.js --claude --local --no-sdk` in tmpDir.
 * GSD_TEST_MODE must be cleared so the install() main block executes.
 */
function runClaudeLocalInstall(cwd) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  const r = runNode([INSTALL_PATH, '--claude', '--local', '--no-sdk'], {
    cwd,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  throwIfFailed(r, `node ${INSTALL_PATH} --claude --local --no-sdk`);
}

/**
 * Build the roster regex that matches `gsd:<known-cmd>` references.
 * Mirrors the pattern used by the Cycle 1 command test.
 */
function buildRosterRegex(cmdNames) {
  const sorted = [...cmdNames].sort((a, b) => b.length - a.length);
  return new RegExp(
    `(?<![a-zA-Z0-9_-])gsd:(${sorted.join('|')})(?=[^a-zA-Z0-9_-]|$)`,
  );
}

/**
 * Walk a directory recursively and collect .md files whose body matches regex.
 */
function collectOffenders(dir, regex) {
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (regex.test(content)) {
          offenders.push(fullPath);
        }
      }
    }
  };
  walk(dir);
  return offenders;
}

// ---------------------------------------------------------------------------
// Suite — integration: staged gsd-core/workflows/ and references/ must
// have no colon-namespace refs for claude.
// ---------------------------------------------------------------------------
describe('bug #3683 — workflow/reference colon-namespace leak (Claude local install)', () => {

  // Shared Claude local install used by W and R suites.
  // Consolidating to a single install halves disk I/O for this file and
  // reduces concurrent load on CI runners — preventing timing interference
  // with concurrently-running tests (e.g. the TOCTOU barrier tests in
  // locking-bugs-1909-1916-1925-1927.test.cjs).
  let claudeTmpDir;
  const cmdNames = readCmdNames();
  const rosterRegex = buildRosterRegex(cmdNames);

  // Shared claude local install — used by W (workflow/reference clean-slate) and
  // R (routing-block positive assertion) sub-suites.
  before(() => {
    claudeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3683-claude-'));
    runClaudeLocalInstall(claudeTmpDir);
  });

  after(() => {
    cleanup(claudeTmpDir);
  });

  // -------------------------------------------------------------------------
  // W — real local claude install: workflow + reference bodies are clean
  // -------------------------------------------------------------------------
  describe('W — integration: staged workflows and references contain no colon-namespace refs', () => {

    test('W0: staged gsd-core/workflows/ directory exists after install', () => {
      const workflowsDir = path.join(claudeTmpDir, '.claude', 'gsd-core', 'workflows');
      assert.ok(
        fs.existsSync(workflowsDir),
        `gsd-core/workflows/ must be created by local claude install at ${workflowsDir}`,
      );
    });

    test('W1: staged gsd-core/references/ directory exists after install', () => {
      const refsDir = path.join(claudeTmpDir, '.claude', 'gsd-core', 'references');
      assert.ok(
        fs.existsSync(refsDir),
        `gsd-core/references/ must be created by local claude install at ${refsDir}`,
      );
    });

    test('W2: focused repro — staged discuss-phase.md has zero /gsd: colon refs', () => {
      // User-reported repro: /gsd-discuss-phase output ends with /gsd:nextcommand
      // because discuss-phase.md ships 7 colon refs that were not normalized.
      const stagedFile = path.join(
        claudeTmpDir, '.claude', 'gsd-core', 'workflows', 'discuss-phase.md',
      );
      assert.ok(
        fs.existsSync(stagedFile),
        `discuss-phase.md must exist in staged gsd-core/workflows/`,
      );
      const content = fs.readFileSync(stagedFile, 'utf-8');
      const colonMatches = content.match(/gsd:[a-z][a-z0-9-]*/g) || [];
      // Filter to known-command refs only
      const knownColonRefs = colonMatches.filter(m => {
        const cmd = m.slice(4); // strip 'gsd:'
        return cmdNames.includes(cmd);
      });
      assert.deepEqual(
        knownColonRefs,
        [],
        `discuss-phase.md still contains colon-namespace refs that install must normalize: ${knownColonRefs.join(', ')}`,
      );
    });

    test('W3: no staged workflow body contains /gsd:<known-cmd> colon refs', () => {
      const workflowsDir = path.join(claudeTmpDir, '.claude', 'gsd-core', 'workflows');
      assert.ok(fs.existsSync(workflowsDir), 'workflows/ must exist for this check to be meaningful');

      const offenders = collectOffenders(workflowsDir, rosterRegex);
      const relOffenders = offenders.map(f => path.relative(claudeTmpDir, f));

      assert.deepEqual(
        relOffenders,
        [],
        `Staged workflow bodies still contain roster colon refs (e.g. /gsd:plan-phase). ` +
        `Install must normalize these to /gsd-<cmd> for claude runtime. Offenders: ${relOffenders.join(', ')}`,
      );
    });

    test('W4: no staged reference body contains /gsd:<known-cmd> colon refs', () => {
      const refsDir = path.join(claudeTmpDir, '.claude', 'gsd-core', 'references');
      assert.ok(fs.existsSync(refsDir), 'references/ must exist for this check to be meaningful');

      const offenders = collectOffenders(refsDir, rosterRegex);
      const relOffenders = offenders.map(f => path.relative(claudeTmpDir, f));

      assert.deepEqual(
        relOffenders,
        [],
        `Staged reference bodies still contain roster colon refs. ` +
        `Install must normalize these to /gsd-<cmd> for claude runtime. Offenders: ${relOffenders.join(', ')}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // R — #3646 routing-block positive assertion: ▶-prefixed lines use hyphen
  //
  // User repro: workflow output ends with "▶ /gsd:validate-phase {N}" (colon
  // form) which does not resolve in Claude Code — the installed skill is
  // /gsd-validate-phase (hyphen). Workflows emit routing blocks verbatim, so
  // the colon form reaches the model and is echoed to the user unchanged.
  //
  // This suite checks the POSITIVE invariant: lines starting with ▶ that
  // reference a GSD slash command must use /gsd-<cmd> (hyphen) in the staged
  // output. This is a stricter assertion than W3 (which only checks absence
  // of colon globally) because it confirms the routing-position strings were
  // NOT omitted — they must be present AND use the correct form.
  //
  // Source files with known ▶-prefixed routing-block colon refs (#3646):
  //   - gsd-core/workflows/validate-phase.md:151 ▶ Next: /gsd:audit-milestone
  //   - gsd-core/workflows/validate-phase.md:158 ▶ Retry: /gsd:validate-phase
  //   - gsd-core/workflows/secure-phase.md:140   ▶ Fix mitigations: /gsd:secure-phase
  //   - gsd-core/workflows/secure-phase.md:158   ▶ /gsd:validate-phase
  //   - gsd-core/workflows/secure-phase.md:159   ▶ /gsd:verify-work
  // -------------------------------------------------------------------------
  describe('R — #3646 routing-block: ▶-prefixed lines use hyphen form in staged claude install', () => {
    // Uses the shared claudeTmpDir from the parent describe block — no separate install needed.

    /**
     * Collect all lines starting with the ▶ routing marker from a file.
     * Returns an array of { lineNo, text } objects.
     */
    function collectRoutingLines(filePath) {
      if (!fs.existsSync(filePath)) return [];
      return fs.readFileSync(filePath, 'utf-8')
        .split(/\r?\n/)
        .map((text, i) => ({ lineNo: i + 1, text }))
        .filter(({ text }) => text.startsWith('▶'));
    }

    test('R1: staged validate-phase.md routing block uses /gsd-<cmd> hyphen form', () => {
      const stagedFile = path.join(
        claudeTmpDir, '.claude', 'gsd-core', 'workflows', 'validate-phase.md',
      );
      assert.ok(
        fs.existsSync(stagedFile),
        `validate-phase.md must exist in staged gsd-core/workflows/`,
      );
      const routingLines = collectRoutingLines(stagedFile);
      // Exactly two known routing lines (▶ Next / ▶ Retry).
      const gsdRoutingLines = routingLines.filter(({ text }) => /\/gsd[-:]/.test(text));
      assert.strictEqual(
        gsdRoutingLines.length,
        2,
        `validate-phase.md must have exactly 2 ▶-routing lines referencing a /gsd- command — ` +
        `found ${gsdRoutingLines.length}: ${JSON.stringify(gsdRoutingLines)}`,
      );
      // Positive: every routing line that references gsd must use the hyphen form.
      for (const { lineNo, text } of gsdRoutingLines) {
        assert.ok(
          /\/gsd-[a-z]/.test(text),
          `validate-phase.md line ${lineNo}: ▶-routing line must use /gsd-<cmd> hyphen form, got: ${JSON.stringify(text)}`,
        );
        // Negative: must not contain the colon form.
        assert.ok(
          !/\/gsd:[a-z]/.test(text),
          `validate-phase.md line ${lineNo}: ▶-routing line must not contain /gsd:<cmd> colon form, got: ${JSON.stringify(text)}`,
        );
        // Token-level: extract real command tokens (/gsd-<cmd> starting with a
        // lowercase letter) and assert none contain an embedded colon.
        // Skips documentation placeholder tokens like /gsd-[command].
        const rawTokens = text.match(/\/gsd[^\s]*/g) || [];
        for (const token of rawTokens) {
          assert.ok(
            !token.includes(':'),
            `validate-phase.md line ${lineNo}: /gsd token "${token}" must not contain a colon — embedded colon detected (e.g. /gsd-validate:phase), got: ${JSON.stringify(text)}`,
          );
        }
      }
    });

    test('R2: staged secure-phase.md routing block uses /gsd-<cmd> hyphen form', () => {
      const stagedFile = path.join(
        claudeTmpDir, '.claude', 'gsd-core', 'workflows', 'secure-phase.md',
      );
      assert.ok(
        fs.existsSync(stagedFile),
        `secure-phase.md must exist in staged gsd-core/workflows/`,
      );
      const routingLines = collectRoutingLines(stagedFile);
      // Exactly three known routing lines (fix-mitigations, validate-phase, verify-work).
      const gsdRoutingLines = routingLines.filter(({ text }) => /\/gsd[-:]/.test(text));
      assert.strictEqual(
        gsdRoutingLines.length,
        3,
        `secure-phase.md must have exactly 3 ▶-routing lines referencing a /gsd- command — ` +
        `found ${gsdRoutingLines.length}: ${JSON.stringify(gsdRoutingLines)}`,
      );
      for (const { lineNo, text } of gsdRoutingLines) {
        assert.ok(
          /\/gsd-[a-z]/.test(text),
          `secure-phase.md line ${lineNo}: ▶-routing line must use /gsd-<cmd> hyphen form, got: ${JSON.stringify(text)}`,
        );
        assert.ok(
          !/\/gsd:[a-z]/.test(text),
          `secure-phase.md line ${lineNo}: ▶-routing line must not contain /gsd:<cmd> colon form, got: ${JSON.stringify(text)}`,
        );
        // Token-level: extract all /gsd... tokens and assert none contain an
        // embedded colon (catches /gsd-validate:phase etc).
        // Skips documentation placeholder tokens like /gsd-[command].
        const rawTokens = text.match(/\/gsd[^\s]*/g) || [];
        for (const token of rawTokens) {
          assert.ok(
            !token.includes(':'),
            `secure-phase.md line ${lineNo}: /gsd token "${token}" must not contain a colon — embedded colon detected (e.g. /gsd-validate:phase), got: ${JSON.stringify(text)}`,
          );
        }
      }
    });

    test('R3: all staged workflow routing blocks use hyphen form (cross-file sweep)', () => {
      // R3 unique value vs W3:
      //   W3 catches overt /gsd:<cmd> at file level (any line).
      //   R3 adds:
      //     (a) ▶-line-scoped assertion (catches drift specifically in routing-block context)
      //     (b) embedded-colon token check (e.g. /gsd-validate:phase partial-conversion artifacts)
      //         not detectable by W3's file-level regex
      // Sweeps both workflows/ and references/ so routing blocks in reference files
      // are covered alongside workflow files.
      const gsdDir = path.join(claudeTmpDir, '.claude', 'gsd-core');
      const workflowsDir = path.join(gsdDir, 'workflows');
      assert.ok(fs.existsSync(workflowsDir), 'workflows/ must exist for R3 to be meaningful');

      const colonOffenders = [];
      const embeddedColonOffenders = [];
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) { walk(fullPath); continue; }
          if (!entry.name.endsWith('.md')) continue;
          const lines = fs.readFileSync(fullPath, 'utf-8').split(/\r?\n/);
          const rel = path.relative(claudeTmpDir, fullPath);
          lines.forEach((text, i) => {
            if (!text.startsWith('▶')) return;
            // Negative: must not contain overt /gsd:<cmd> colon form.
            if (/\/gsd:[a-z]/.test(text)) {
              colonOffenders.push(`${rel}:${i + 1}: ${text.trim()}`);
            }
            // Token-level: check each /gsd... token for an embedded colon.
            // Catches cases like /gsd-validate:phase where normalizer half-converted.
            // Documentation placeholder tokens like /gsd-[command] are skipped
            // because their tokens will not contain a colon.
            const tokens = text.match(/\/gsd[^\s]*/g) || [];
            for (const token of tokens) {
              if (token.includes(':')) {
                embeddedColonOffenders.push(`${rel}:${i + 1}: token "${token}" in "${text.trim()}"`);
              }
            }
          });
        }
      };
      // Walk both workflows/ and references/ — routing blocks can appear in either.
      walk(workflowsDir);
      const refsDir = path.join(gsdDir, 'references');
      if (fs.existsSync(refsDir)) walk(refsDir);

      assert.deepEqual(
        colonOffenders,
        [],
        `Staged workflows contain ▶-routing lines with /gsd:<cmd> colon form — ` +
        `these must resolve to /gsd-<cmd> for Claude Code skills-based install. ` +
        `Offenders:\n  ${colonOffenders.join('\n  ')}`,
      );
      assert.deepEqual(
        embeddedColonOffenders,
        [],
        `Staged workflows contain ▶-routing lines with /gsd tokens that have an embedded ` +
        `colon (e.g. /gsd-validate:phase) — normalizer may have partially converted a token. ` +
        `Offenders:\n  ${embeddedColonOffenders.join('\n  ')}`,
      );
    });
  });

});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #4324 — colon tokens the install transform CANNOT convert leak to users
// ────────────────────────────────────────────────────────────────────────
//
// Companion to the `#3443` invariant above, and deliberately its mirror image.
// That one asserts the source stays COLON. This one asserts every colon token
// in the source is one the installer can actually turn into hyphen form.
//
// The install rewrite (`transformContentToHyphen`) is gated on an exact match
// against the `commands/gsd/*.md` stem list, so a `/gsd:<token>` whose token is
// not a registered stem survives the install untouched and reaches the user as
// the deprecated colon form. #4324 reported this as "all auto-suggestions are
// still using the outdated /gsd:".
//
// That gate is load-bearing and must NOT be widened: it is the only thing
// protecting the workflow DSL marker family (`gsd:section`, `gsd:protected`,
// `gsd:loop-host`, `gsd:guard`, `gsd:dispatch`, `gsd:plan-revision-conflicts`),
// which is parsed as a literal — `src/workflow-fragments.cts` pins
// `CLOSE_TAG = '/gsd:section'`. The fix therefore belongs in the shipped text,
// and this suite is what keeps it there.
{
  const { describe, test } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  const ROOT = path.join(__dirname, '..');
  const FIXER = path.join(ROOT, 'scripts', 'fix-slash-commands.cjs');
  // Drive the REAL production transform with the REAL roster. A roster invented
  // here could only confirm what this test's author already believed about the
  // gate (fixture-provenance rule, #2371).
  const {
    transformContentToHyphen,
    buildColonPattern,
    readCmdNames,
    SKIP_DIRS,
  } = require(FIXER);

  const cmdNames = readCmdNames();

  // Shipped surfaces whose text the runtime loads and shows the user.
  //
  // `skills/` is included even though the #3443 colon-invariant scan omits it —
  // but not for the reason that scan omits it. skills/<name>/SKILL.md is
  // GENERATED by scripts/gen-plugin-skills.cjs and is already emitted in hyphen
  // form, so it is runtime-emitter output rather than colon source. Scanning it
  // is a cheap belt-and-braces check that the generator never emits a colon
  // token the installer could not convert; it currently contributes zero
  // tokens, and that is the expected steady state.
  const SCAN_DIRS = [
    path.join(ROOT, 'commands', 'gsd'),
    path.join(ROOT, 'agents'),
    path.join(ROOT, 'gsd-core', 'workflows'),
    path.join(ROOT, 'gsd-core', 'references'),
    path.join(ROOT, 'gsd-core', 'templates'),
    path.join(ROOT, 'skills'),
  ];

  // Structural markers that legitimately use `gsd:` and are NOT slash commands.
  // Enumerated BY FAMILY, never by "it sits in a comment": a blanket
  // comment-context waiver would also wave through a genuinely broken command
  // reference that merely happens to be commented out, e.g.
  // `<!-- see /gsd:typo-cmd -->`, which is exactly the leak this guard exists
  // to catch.
  const COMMENT_MARKER_TOKENS = new Set([
    'section',                  // <!-- gsd:section id="…" when="…" --> / <!-- /gsd:section -->
    'protected',                // <!-- gsd:protected:start --> / :end
    'loop-host',                // <!-- gsd:loop-host … -->
    'plan-revision-conflicts',  // <!-- gsd:plan-revision-conflicts:begin --> / :end
    'live-dom-families',        // <!-- gsd:live-dom-families -->
    'write-continue',           // <!-- gsd:write-continue … -->
  ]);
  const BARE_MARKER_TOKENS = new Set([
    'guard',      // `# gsd:guard=orchestrator-cwd-drift`
    'dispatch',   // `[gsd:dispatch phase="…" plan="…"]`
  ]);
  const IN_HTML_COMMENT = /<!--[^>]*gsd:/;
  // `<!-- gsd: no compact sibling … -->` — the compact-content disclosure
  // banner. Its token is empty, so it is matched by shape rather than by name.
  const COMPACT_DISCLOSURE = /<!--\s*gsd:\s/;

  function collect(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        collect(full, out);
      } else if (e.name.endsWith('.md')) {
        out.push(full);
      }
    }
    return out;
  }

  const shippedFiles = SCAN_DIRS.flatMap((d) => collect(d));

  // Same lookbehind as buildColonPattern, so match indices from the two regexes
  // are directly comparable.
  const ANY_COLON_TOKEN = /(?<![a-zA-Z0-9_-])gsd:([a-zA-Z0-9_-]*)/g;

  describe('install-convertibility of colon tokens (#4324)', () => {
    test('the scan corpus and the real roster are both populated', () => {
      assert.ok(cmdNames.length > 0, 'commands/gsd/ must yield a non-empty roster');
      assert.ok(shippedFiles.length > 0, 'SCAN_DIRS must yield shipped .md files');
      assert.ok(cmdNames.includes('quick'), 'quick must be a registered command stem');
    });

    // ROW 1 — the failing-first regression test for #4324.
    test('every gsd: token in user-facing source is convertible or a declared structural marker', () => {
      const colonPattern = buildColonPattern(cmdNames);
      assert.ok(colonPattern, 'buildColonPattern must compile for a non-empty roster');

      const violations = [];
      for (const file of shippedFiles) {
        // allow-test-rule: source-text-is-the-product (#4324)
        // These are shipped command/agent/workflow/skill bodies — their text IS
        // what the runtime loads and renders, so the deployed text is the contract.
        const src = fs.readFileSync(file, 'utf-8');
        if (!src.includes('gsd:')) continue;

        const convertibleAt = new Set(
          [...src.matchAll(new RegExp(colonPattern.source, 'g'))].map((m) => m.index),
        );
        const lines = src.split(/\r?\n/);

        for (const m of src.matchAll(ANY_COLON_TOKEN)) {
          if (convertibleAt.has(m.index)) continue;           // installer handles it
          const lineNo = src.slice(0, m.index).split(/\r?\n/).length;
          const line = lines[lineNo - 1] || '';
          if (BARE_MARKER_TOKENS.has(m[1])) continue;          // structural marker
          const inComment = IN_HTML_COMMENT.test(line);
          if (inComment && COMMENT_MARKER_TOKENS.has(m[1])) continue;
          if (inComment && m[1] === '' && COMPACT_DISCLOSURE.test(line)) continue;
          violations.push(
            `${path.relative(ROOT, file)}:${lineNo}: "${m[0]}" in "${line.trim().slice(0, 90)}"`,
          );
        }
      }

      assert.deepEqual(
        violations,
        [],
        `Found ${violations.length} colon token(s) the install transform cannot convert — ` +
        `they reach the user as the deprecated /gsd: form (#4324).\n` +
        `Fix the SHIPPED TEXT, not the transform: the command-stem gate protects the ` +
        `gsd:section / gsd:protected / gsd:loop-host marker family.\n` +
        `Either close the command token at a boundary ("\`/gsd:quick\`-shaped", not ` +
        `"/gsd:quick-shaped"), stop rendering a non-command as a slash command, or ` +
        `declare a new structural marker in BARE_MARKER_TOKENS.\n` +
        `Offenders:\n  ${violations.join('\n  ')}`,
      );
    });

    // ROW 2 — the reported symptom, asserted at the surface the user sees AND
    // through the code that actually produces it.
    //
    // The first version of this test called `transformContentToHyphen` on the
    // description line directly and passed — while a real install still shipped
    // the colon form, because both hyphen-namespace skill converters rebuild
    // `description:` from the raw frontmatter field and never run the transform
    // on it. That is the difference between asserting the identity and asserting
    // a proxy for it: drive the converter, or the next converter that forgets to
    // normalise a field ships the same bug again (#4324).
    test('installed skill descriptions carry no colon form', () => {
      // allow-test-rule: integration-test-input (#4324)
      // The command files are passed to the converters as DATA — real fixture
      // input to the transformation under test — and the assertion is on the
      // converter's emitted frontmatter, which is the text the host's skill
      // picker renders and therefore the deployed contract itself.
      const {
        convertClaudeCommandToClaudeSkill,
        convertClaudeCommandToClineSkill,
      } = require(path.join(ROOT, 'bin', 'install.js'));

      const converters = [
        ['claude', convertClaudeCommandToClaudeSkill],
        ['cline', convertClaudeCommandToClineSkill],
      ];

      const offenders = [];
      let checked = 0;
      for (const stem of cmdNames) {
        const file = path.join(ROOT, 'commands', 'gsd', `${stem}.md`);
        if (!fs.existsSync(file)) continue;
        const src = fs.readFileSync(file, 'utf-8');
        for (const [label, convert] of converters) {
          const emitted = convert(src, `gsd-${stem}`, null, cmdNames);
          const descLine = emitted
            .split(/\r?\n/)
            .find((l) => l.startsWith('description:'));
          if (!descLine) continue;
          checked += 1;
          if (/gsd:/.test(descLine)) {
            offenders.push(
              `${label} · commands/gsd/${stem}.md → ${descLine.trim().slice(0, 110)}`,
            );
          }
        }
      }

      // Guard against the whole loop silently doing nothing.
      assert.ok(
        checked >= cmdNames.length,
        `expected at least one emitted description per command per converter; checked ${checked}`,
      );
      assert.deepEqual(
        offenders,
        [],
        `A converter emitted a skill description still carrying the /gsd: colon ` +
        `form. This is the picker text #4324 reported, and it reaches the user on ` +
        `every install.\n  ${offenders.join('\n  ')}`,
      );
    });

    // ROW 3 — cross-surface parity, across BOTH served reference variants.
    // topic.md tells the model which bold signature line to extract AND where
    // that line's one-line summary sits. Two things can go wrong, and both did:
    //   1. a literal prefix baked into the rule can never match the installed
    //      reference, which is converted to hyphen form at install time; and
    //   2. the two served variants put the summary in DIFFERENT places —
    //      full.md on the following line, full.compact.md trailing an em-dash on
    //      the signature line itself. A rule that knows only one shape emits the
    //      following `Usage:` line as if it were the summary.
    test('help topic-mode rule covers every served reference variant', () => {
      const modes = path.join(ROOT, 'gsd-core', 'workflows', 'help', 'modes');
      const topicPath = path.join(modes, 'topic.md');
      assert.ok(fs.existsSync(topicPath), 'help/modes/topic.md must exist');

      const variants = ['full.md', 'full.compact.md']
        .map((name) => ({ name, file: path.join(modes, name) }))
        .filter((v) => fs.existsSync(v.file));
      assert.equal(variants.length, 2, 'both full.md and full.compact.md must ship');

      const shapes = new Set();
      for (const variant of variants) {
        // allow-test-rule: source-text-is-the-product (#4324)
        // The installed reference text IS what the model reads; its rendered
        // shape is the contract topic.md's extraction rule is written against.
        const converted = transformContentToHyphen(
          fs.readFileSync(variant.file, 'utf-8'), cmdNames,
        );
        const lines = converted.split(/\r?\n/);
        const signatureLines = lines.filter((l) => /^\*\*`\/gsd[-:]/.test(l));
        assert.ok(
          signatureLines.length > 0,
          `${variant.name} must contain command-signature bold lines`,
        );

        const prefixes = new Set(
          signatureLines.map((l) => l.match(/^\*\*`(\/gsd[-:])/)[1]),
        );
        assert.deepEqual(
          [...prefixes], ['/gsd-'],
          `${variant.name} must ship only the hyphen signature prefix after install conversion`,
        );

        for (const l of signatureLines) {
          shapes.add(/\*\*\s+—\s+\S/.test(l) ? 'same-line' : 'next-line');
        }
      }

      // The variants genuinely disagree. This is WHY topic.md's rule must branch,
      // and it is asserted rather than assumed: if the corpus ever collapses to a
      // single placement, the two-case rule can be simplified — deliberately.
      assert.deepEqual(
        [...shapes].sort(), ['next-line', 'same-line'],
        'the served variants must between them use both summary placements',
      );

      // allow-test-rule: source-text-is-the-product (#4324)
      // topic.md is shipped workflow text the runtime loads; its wording is the
      // deployed contract, so the wording is what must be asserted.
      const topic = fs.readFileSync(topicPath, 'utf-8');
      const topicConverted = transformContentToHyphen(topic, cmdNames);

      // (a) no literal command prefix baked into a bold-signature instruction —
      //     such a prefix can never match the converted reference.
      const instructed = [...topicConverted.matchAll(/\*\*`(\/gsd[-:])/g)].map((m) => m[1]);
      assert.deepEqual(
        instructed, [],
        `topic.md bakes the literal prefix(es) ${JSON.stringify(instructed)} into a ` +
        `bold-signature instruction, but the installed reference ships '/gsd-' after ` +
        `conversion — the match can never succeed and --brief silently falls back to ` +
        `"heading + first paragraph" on every topic (#4324).`,
      );

      // (b) the rule must actually COVER both placements. Without this, (a) is
      //     vacuous: any rewording that merely avoids spelling a literal prefix
      //     would pass, including one that handles only a single variant.
      for (const [needle, why] of [
        [/Locating the summary/, 'a named sub-rule that says where the summary sits'],
        [/em-dash/, 'the full.compact.md case — summary trailing an em-dash on the signature line'],
        [/single non-blank line immediately after/, 'the full.md case — summary on the following line'],
        [/`Usage:` line is never a summary/, 'the guard against emitting a Usage: line as the summary'],
      ]) {
        assert.match(
          topic, needle,
          `topic.md must retain ${why}; without it the compact variant emits the ` +
          `following "Usage:" line as if it were the one-line summary (#4324).`,
        );
      }
    });
  });

  // The gate's own boundary behaviour. These characterize WHY the residuals above
  // escape, so a future editor cannot "fix" #4324 by widening the gate without
  // reding the marker guard directly below.
  describe('colon-gate boundary behaviour (#4324)', () => {
    test('a command stem at a token boundary converts', () => {
      for (const input of ['/gsd:quick ', '`/gsd:quick`', '/gsd:quick.', '/gsd:quick']) {
        assert.match(
          transformContentToHyphen(input, cmdNames),
          /gsd-quick/,
          `expected ${JSON.stringify(input)} to convert`,
        );
      }
    });

    test('a command stem followed by a hyphen is not a command token', () => {
      // `quick` is a stem, but `quick-shaped` is not, and the right-hand lookahead
      // rejects the following `-`. Nothing matches — this is the #4324 mechanism.
      assert.equal(transformContentToHyphen('/gsd:quick-shaped', cmdNames), '/gsd:quick-shaped');
    });

    test('longest-stem-first ordering is preserved', () => {
      assert.equal(transformContentToHyphen('/gsd:quick-batch', cmdNames), '/gsd-quick-batch');
    });

    test('an empty roster converts nothing', () => {
      assert.equal(buildColonPattern([]), null);
      assert.equal(transformContentToHyphen('/gsd:quick', []), '/gsd:quick');
    });

    test('non-command gsd- identifiers are left alone', () => {
      for (const input of ['/gsd-sdk', '/gsd-tools']) {
        assert.equal(transformContentToHyphen(input, cmdNames), input);
      }
    });

    // NEGATIVE SPACE — the guard that makes "just un-gate the regex" fail loudly.
    test('structural markers survive the install transform unchanged', () => {
      const markers = [
        '<!-- gsd:section id="converge-loop" when="state:plan-strategy-converge" -->',
        '<!-- /gsd:section -->',
        '<!-- gsd:protected:start -->',
        '<!-- gsd:protected:end -->',
        '<!-- gsd:loop-host',
        '<!-- gsd:plan-revision-conflicts:begin -->',
        '<!-- gsd:plan-revision-conflicts:end -->',
        '# gsd:guard=orchestrator-cwd-drift',
        '[gsd:dispatch phase="{phase_number}" plan="{plan_id}"]',
        '<!-- gsd:live-dom-families -->',
      ];
      for (const marker of markers) {
        assert.equal(
          transformContentToHyphen(marker, cmdNames),
          marker,
          `structural marker must survive byte-identical: ${marker}`,
        );
        // CRLF variant — same verdict.
        assert.equal(
          transformContentToHyphen(`${marker}\r\n`, cmdNames),
          `${marker}\r\n`,
          `structural marker must survive byte-identical under CRLF: ${marker}`,
        );
      }
    });
  });
}
