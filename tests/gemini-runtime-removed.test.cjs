/**
 * #1928 — Gemini CLI runtime removal + Antigravity redirect.
 *
 * Google sunset Gemini CLI on 2026-06-18; Antigravity CLI is the official
 * successor. GSD removes the `gemini` runtime and turns `--gemini` into an
 * explicit deprecation redirect (NOT a silent alias — Hyrum's Law, per the
 * issue's rejected alternative #2).
 *
 * Coverage:
 *   A. CLI redirect contract (spawned installer): the sunset notice, the
 *      no-silent-install failure path, clean UX (no stack trace), and that a
 *      co-selected valid runtime still installs.
 *   B. The `gemini` runtime is gone from every runtime-name-policy surface.
 *   C. Antigravity is PRESERVED everywhere it shared surface with gemini
 *      (GEMINI.md instruction file + the shared convertGeminiToolName tool
 *      vocabulary) — the shared-infra regression this change had to avoid.
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const ROOT = path.join(__dirname, '..');
const INSTALL_JS = path.join(ROOT, 'bin', 'install.js');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored + built; build it idempotently so a real install
// emits hooks (mirrors golden-install-parity / install-minimal-hooks).
before(() => {
  throwIfFailed(runNode([BUILD_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS }), `node ${BUILD_SCRIPT}`);
});

const {
  canonicalizeRuntimeName,
  getRuntimeLabel,
  getGlobalConfigHomeFragment,
  getRuntimeNewProjectCommand,
  runtimeFlags,
  getProjectInstructionFile,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'));

const registry = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));
const catalog = require(path.join(ROOT, 'gsd-core', 'bin', 'shared', 'model-catalog.json'));

const { convertClaudeAgentToAntigravityAgent } = require('../bin/install.js');

// Run the installer as a subprocess with an isolated HOME so no install can
// touch the real machine. Runtime-config env overrides are stripped so the
// child resolves config dirs strictly under the temp HOME.
function runInstaller(args, homeDir) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, GSD_TEST_MODE: '1' };
  for (const k of [
    'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'ANTIGRAVITY_CONFIG_DIR',
    'XDG_CONFIG_HOME', 'CODEX_CONFIG_DIR', 'OPENCODE_CONFIG_DIR', 'KILO_CONFIG_DIR',
  ]) delete env[k];
  return spawnSync(process.execPath, [INSTALL_JS, ...args], {
    cwd: homeDir, env, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS,
  });
}

describe('#1928 --gemini CLI deprecation redirect', () => {
  test('--gemini alone prints the sunset notice and exits non-zero without installing', (t) => {
    const home = createTempDir('gsd-1928-gemini-only-');
    t.after(() => cleanup(home));

    const r = runInstaller(['--gemini'], home);
    const out = `${r.stdout || ''}${r.stderr || ''}`;

    assert.strictEqual(r.status, 1, 'a bare --gemini must exit 1, not silently fall through to a Claude install');
    assert.match(out, /sunset by Google on 2026-06-18/, 'must cite the 2026-06-18 sunset date');
    assert.match(out, /--antigravity/, 'must redirect the user to --antigravity');
    assert.match(out, /Antigravity CLI \(the official successor\)/);
    // No silent install: nothing was written under the isolated HOME.
    assert.ok(!fs.existsSync(path.join(home, '.gemini')), 'must not create a .gemini runtime dir');
    assert.ok(!fs.existsSync(path.join(home, '.claude')), 'bare --gemini must not silently install Claude');
  });

  test('--gemini --global still exits 1 (removed flag regardless of scope)', (t) => {
    const home = createTempDir('gsd-1928-gemini-global-');
    t.after(() => cleanup(home));

    const r = runInstaller(['--gemini', '--global'], home);
    assert.strictEqual(r.status, 1);
    assert.match(`${r.stdout || ''}${r.stderr || ''}`, /sunset by Google on 2026-06-18/);
  });

  test('the redirect is a clean message — no stack trace leaks to the user', (t) => {
    const home = createTempDir('gsd-1928-gemini-clean-');
    t.after(() => cleanup(home));

    const r = runInstaller(['--gemini'], home);
    const err = r.stderr || '';
    assert.doesNotMatch(err, /^\s+at .+:\d+:\d+/m, 'no V8 stack frame in redirect output');
    assert.doesNotMatch(err, /\bError:|\bTypeError:|\bthrow\b/, 'no thrown-error prose in redirect output');
  });

  test('--gemini --help still prints usage (the redirect must not suppress help)', (t) => {
    const home = createTempDir('gsd-1928-gemini-help-');
    t.after(() => cleanup(home));

    const r = runInstaller(['--gemini', '--help'], home);
    assert.strictEqual(r.status, 0, '--help must exit 0, not the redirect error code');
    assert.match(`${r.stdout || ''}`, /Usage:/, 'the usage/help block must still print to stdout');
    assert.match(`${r.stderr || ''}`, /sunset by Google on 2026-06-18/, 'the notice also prints');
  });

  test('--gemini --uninstall guides manual cleanup and does NOT uninstall Claude', (t) => {
    const home = createTempDir('gsd-1928-gemini-uninstall-');
    t.after(() => cleanup(home));

    // Sentinel: a pre-existing Claude install that must survive. Run WITHOUT
    // GSD_TEST_MODE so the real uninstall dispatch is active — the redirect must
    // exit before it (the dispatch defaults an empty selection to 'claude').
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sentinel.txt'), 'keep me');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.GSD_TEST_MODE;
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, [INSTALL_JS, '--gemini', '--uninstall', '--global'], {
      cwd: home, env, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS,
    });

    assert.strictEqual(r.status, 1, 'must exit 1, not fall through to the uninstall dispatch');
    assert.match(`${r.stderr || ''}`, /`--gemini --uninstall` is no longer available/, 'must guide manual cleanup');
    assert.ok(fs.existsSync(path.join(home, '.claude', 'sentinel.txt')),
      'the Claude install must NOT be uninstalled (the dispatch defaults empty selection to claude)');
  });

  test('--gemini co-selected with a valid runtime prints the notice AND still installs the other runtime', (t) => {
    // Hermetic install via the repo harness (explicit --config-dir + isolated
    // HOME). `--gemini` is added alongside a valid runtime (codex): the installer
    // prints the notice but does NOT exit 1 (runMinimalInstall asserts status 0
    // internally) and installs codex.
    const { manifest, root, stderr } = runMinimalInstall({ runtime: 'codex', scope: 'global', extraArgs: ['--gemini'] });
    t.after(() => cleanup(root));

    assert.match(stderr, /sunset by Google on 2026-06-18/, 'the redirect notice still prints alongside the valid install');
    assert.match(stderr, /--antigravity/);
    assert.ok(manifest, 'the co-selected codex runtime must be installed (manifest written)');
  });

  test('control: an install WITHOUT --gemini does not print the sunset notice', (t) => {
    const { root, stderr } = runMinimalInstall({ runtime: 'codex', scope: 'global' });
    t.after(() => cleanup(root));
    assert.doesNotMatch(stderr, /sunset by Google/, 'the notice must be conditional on --gemini');
  });
});

describe('#1928 gemini removed from every runtime-name-policy surface', () => {
  test('gemini aliases no longer canonicalize', () => {
    for (const alias of ['gemini', 'gemini-cli', 'gemini-code']) {
      assert.strictEqual(canonicalizeRuntimeName(alias), null, `${alias} must not resolve to a known runtime`);
    }
  });

  test('gemini falls back on label / config-fragment / new-project surfaces', () => {
    assert.strictEqual(getRuntimeLabel('gemini'), 'Claude Code', 'label table entry removed → fail-closed default');
    assert.strictEqual(getGlobalConfigHomeFragment('gemini'), "'.claude'", 'config-home fragment removed → default');
    assert.strictEqual(getRuntimeNewProjectCommand('gemini'), '/gsd-new-project', 'new-project override removed → default');
  });

  test('runtimeFlags has no isGemini and covers exactly the non-claude, CLI-installable registry runtimes (count-agnostic)', () => {
    const flags = runtimeFlags('claude');
    assert.ok(!('isGemini' in flags), 'isGemini flag must be gone');
    // The flag set tracks the non-claude registry runtimes (one is<Runtime> per
    // id), so adding a runtime updates the count automatically — no hand-pinned
    // number that would break on the next runtime addition.
    // #2103: registry runtimes with installSurface === 'none' (e.g. vscode —
    // Marketplace/VSIX-distributed, never CLI-installed) have no --<rt> flag
    // by design (see tests/runtime-flags.test.cjs's NON_INSTALLABLE_RUNTIMES)
    // and are excluded from this count too.
    const expectedNonClaudeCount = Object.keys(registry.runtimes)
      .filter((id) => id !== 'claude' && registry.runtimes[id].runtime.installSurface !== 'none')
      .length;
    assert.strictEqual(Object.keys(flags).length, expectedNonClaudeCount,
      'flag count must equal the non-claude, CLI-installable registry runtime count');
  });

  test('gemini no longer maps to GEMINI.md (defaults to AGENTS.md)', () => {
    assert.strictEqual(getProjectInstructionFile('gemini'), 'AGENTS.md');
  });
});

describe('#1928 Antigravity preserved (shared surface with the removed gemini runtime)', () => {
  test('antigravity still resolves and keeps its GEMINI.md instruction file', () => {
    assert.strictEqual(canonicalizeRuntimeName('antigravity'), 'antigravity');
    assert.strictEqual(canonicalizeRuntimeName('antigravity-cli'), 'antigravity');
    assert.strictEqual(getProjectInstructionFile('antigravity'), 'GEMINI.md',
      'Antigravity CLI reads GEMINI.md as its contextFileName — this mapping must survive gemini removal');
    assert.strictEqual(getRuntimeLabel('antigravity'), 'Antigravity');
  });

  test('the shared Gemini-backend tool vocabulary still powers Antigravity agent conversion', () => {
    const input = ['---', 'name: gsd-x', 'description: d', 'tools: Read, Write, WebFetch, Skill', '---', '', 'body'].join('\n');
    const toolsLine = convertClaudeAgentToAntigravityAgent(input).split('\n').find((l) => l.startsWith('tools:')) || '';
    assert.ok(toolsLine.includes('read_file'), 'Read → read_file via the retained convertGeminiToolName');
    assert.ok(toolsLine.includes('write_file'), 'Write → write_file');
    assert.ok(toolsLine.includes('web_fetch'), 'WebFetch → web_fetch');
    assert.ok(!/\bskill\b/.test(toolsLine), 'Skill is still excluded (would be an invalid backend tool name)');
  });
});

/**
 * #4709 — the #1928 removal reached the installer and the runtime enum, but runtime-loaded
 * workflow text kept MINTING the retired id: `RUNTIME="gemini"` from `$GEMINI_CONFIG_DIR`, a
 * runtime selection menu offering "Gemini CLI.", a runtime->model-tier table row keyed `gemini`,
 * and `config-set runtime gemini` examples.
 *
 * The name policy's unknown-id fallbacks are DELIBERATE and stay unchanged — see the
 * 'gemini no longer maps to GEMINI.md (defaults to AGENTS.md)' test above, and
 * src/runtime-name-policy.cts:220-222, which calls the label default "the always-safe default,
 * fail-closed". This block removes the REACHABILITY instead: nothing shipped may mint an id the
 * policy does not recognize.
 *
 * Every assertion is STRUCTURAL (the literal must be canonical / the runtime must exist as a
 * catalog key), never "the string gemini is absent" — that string is load-bearing across
 * Antigravity's real on-disk contract, which the final test pins.
 */
describe('#4709 no shipped surface mints a retired runtime id', () => {
  /** Recursively collect every `.md` file under `dir` (missing dir -> []). */
  function markdownFilesUnder(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...markdownFilesUnder(full));
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
    return out;
  }

  /**
   * The shipped, runtime-loaded markdown corpus this block governs. `agents/` is included
   * deliberately: it ships runtime-loaded markdown too, including `.compact.md` variants, and
   * leaving it out was a coverage gap an adversarial review caught.
   */
  function shippedMarkdown() {
    return [
      ...markdownFilesUnder(path.join(ROOT, 'gsd-core', 'workflows')),
      ...markdownFilesUnder(path.join(ROOT, 'commands')),
      ...markdownFilesUnder(path.join(ROOT, 'skills')),
      ...markdownFilesUnder(path.join(ROOT, 'agents')),
    ];
  }

  const relPath = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const linesOf = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/);

  const SETTINGS_ADVANCED = path.join(ROOT, 'gsd-core', 'workflows', 'settings-advanced.md');

  test('every RUNTIME= assignment in workflow text names a canonical runtime', () => {
    // Bare-literal assignments only: RUNTIME=codex / RUNTIME="codex". A `$VAR`, `$(cmd)` or
    // `<placeholder>` assignment is resolved at runtime and carries no id to validate here.
    const ASSIGN = /\bRUNTIME=("?)([a-z][a-z0-9-]*)\1(?![\w-])/g;
    const offenders = [];

    for (const file of shippedMarkdown()) {
      linesOf(file).forEach((line, i) => {
        for (const m of line.matchAll(ASSIGN)) {
          if (canonicalizeRuntimeName(m[2]) === null) {
            offenders.push(`${relPath(file)}:${i + 1} mints RUNTIME=${m[2]}`);
          }
        }
      });
    }

    assert.deepStrictEqual(offenders, [],
      'shipped workflow text assigns a runtime id the name policy does not recognize. A '
        + 'non-canonical id does not fail loudly — it resolves to Claude Code defaults, so the '
        + `wrong config dir and instruction file are used silently. Offenders:\n  ${offenders.join('\n  ')}`);
  });

  test('the runtime tier table names only runtimes the model catalog defines', () => {
    const known = new Set(Object.keys(catalog.runtimeTierDefaults));
    const offenders = [];

    // Rows of the runtime -> model-tier table: | `<id>` | `<opus>` | `<sonnet>` | `<haiku>` |
    const ROW = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|/;
    linesOf(SETTINGS_ADVANCED).forEach((line, i) => {
      const m = ROW.exec(line);
      if (m && !known.has(m[1])) {
        offenders.push(`${relPath(SETTINGS_ADVANCED)}:${i + 1} tables runtime \`${m[1]}\``);
      }
    });

    assert.deepStrictEqual(offenders, [],
      'the runtime->model-tier table documents built-in defaults for a runtime the model catalog '
        + 'has no entry for, so `config-set runtime <id>` would be ignored. The retired `gemini` '
        + 'row carried the three model IDs of the `google` PROVIDER preset — a provider axis '
        + `rendered as a runtime axis. Offenders:\n  ${offenders.join('\n  ')}`);
  });

  test('the runtime selection menu offers only canonical runtimes', () => {
    const offenders = [];

    // Scoped to RUNTIME menus by tracking the nearest preceding `question:`. The same file also
    // carries a provider menu (anthropic / openai) and a budget menu (high / medium / low) whose
    // labels are single lowercase tokens too; neither names a runtime, so validating those
    // against the runtime policy would be a false positive, not extra rigor.
    const QUESTION = /^\s*question:\s*"(.*)"\s*,?\s*$/;
    const OPTION = /\{\s*label:\s*"([a-z][a-z0-9-]*)"\s*,\s*description:/;
    let inRuntimeMenu = false;

    linesOf(SETTINGS_ADVANCED).forEach((line, i) => {
      const q = QUESTION.exec(line);
      if (q) {
        inRuntimeMenu = /runtime/i.test(q[1]);
        return;
      }
      if (!inRuntimeMenu) return;
      const m = OPTION.exec(line);
      if (m && canonicalizeRuntimeName(m[1]) === null) {
        offenders.push(`${relPath(SETTINGS_ADVANCED)}:${i + 1} offers \`${m[1]}\``);
      }
    });

    assert.deepStrictEqual(offenders, [],
      'a runtime selection menu offers a runtime GSD does not support — selecting it writes a '
        + `config value that silently resolves to Claude Code. Offenders:\n  ${offenders.join('\n  ')}`);
  });

  test('documented config examples name only canonical runtimes', () => {
    const offenders = [];
    const SET_RUNTIME = /config-set\s+runtime\s+([a-z][a-z0-9-]*)/g;
    const OVERRIDE = /model_profile_overrides\.([a-z][a-z0-9-]*)\./g;

    for (const file of shippedMarkdown()) {
      linesOf(file).forEach((line, i) => {
        for (const m of line.matchAll(SET_RUNTIME)) {
          if (canonicalizeRuntimeName(m[1]) === null) {
            offenders.push(`${relPath(file)}:${i + 1} \`config-set runtime ${m[1]}\``);
          }
        }
        for (const m of line.matchAll(OVERRIDE)) {
          if (canonicalizeRuntimeName(m[1]) === null) {
            offenders.push(`${relPath(file)}:${i + 1} \`model_profile_overrides.${m[1]}\``);
          }
        }
      });
    }

    assert.deepStrictEqual(offenders, [],
      'a documented example sets a runtime id the name policy does not recognize; a user who '
        + `copies it lands on Claude Code defaults. Offenders:\n  ${offenders.join('\n  ')}`);
  });

  test("Antigravity's Gemini-family descriptor contract is preserved", () => {
    // Negative space for every test above: Antigravity's real on-disk contract IS Google's
    // Gemini surface, so an over-broad gemini -> antigravity replacement must fail HERE rather
    // than ship. Asserted against the DESCRIPTOR, never a resolved path — getGlobalConfigDir()
    // reads $ANTIGRAVITY_CONFIG_DIR and the real $HOME, which is the #4312 defect class.
    const agy = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'capabilities', 'antigravity', 'capability.json'), 'utf8'),
    );
    assert.strictEqual(agy.runtime.configHome.parent, '.gemini',
      "Antigravity's config home is nested under ~/.gemini");
    assert.strictEqual(agy.runtime.configHome.name, 'antigravity');
    assert.strictEqual(agy.runtime.hookEvents, 'gemini',
      'Antigravity speaks the Gemini hook-event dialect');
    assert.strictEqual(agy.runtime.hostBehaviors.projectInstructionFile, 'GEMINI.md');
    for (const kind of agy.runtime.artifactLayout.global) {
      assert.strictEqual(kind.home, '.gemini/config',
        'global skills/agents install to ~/.gemini/config, the dir agy scans (#3738)');
    }

    assert.ok(Object.prototype.hasOwnProperty.call(catalog.runtimeTierDefaults, 'antigravity'),
      'antigravity must remain a model-catalog runtime');

    // The three model IDs the stale `gemini` table row carried belong to the google PROVIDER
    // preset and must survive — they name real Google models, not a GSD runtime.
    const google = JSON.stringify(catalog.providerPresets.google);
    for (const model of ['gemini-3.1-pro-preview', 'gemini-3-flash', 'gemini-2.5-flash-lite']) {
      assert.ok(google.includes(model), `google provider preset must still offer ${model}`);
    }
  });

  test('PR template runtime checklists name only supported runtimes', () => {
    // #1928's follow-up dropped Gemini CLI from .github/ISSUE_TEMPLATE/*.yml but missed the PR
    // templates, which kept offering it under "Runtimes tested" -- a contributor-facing surface
    // still advertising a retired runtime two releases later. Labels here are DISPLAY names
    // ("Claude Code", not "claude"), so they are checked against the label table, not the id set.
    const labels = new Set(
      Object.keys(registry.runtimes).map((id) => getRuntimeLabel(id)),
    );
    // Non-runtime checklist entries that legitimately appear in the same list.
    const NON_RUNTIME = /^(Other:|N\/A\b)/;
    const offenders = [];

    const templateDir = path.join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE');
    for (const name of fs.readdirSync(templateDir).filter((f) => f.endsWith('.md'))) {
      const file = path.join(templateDir, name);
      const fileLines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      let inRuntimeSection = false;
      fileLines.forEach((line, i) => {
        if (/^#+\s*Runtimes tested/i.test(line)) {
          inRuntimeSection = true;
          return;
        }
        // The section ends at the next heading or horizontal rule.
        if (inRuntimeSection && /^(#+\s|---\s*$)/.test(line)) {
          inRuntimeSection = false;
          return;
        }
        if (!inRuntimeSection) return;
        const m = /^\s*-\s*\[\s*\]\s*(.+?)\s*$/.exec(line);
        if (!m) return;
        const label = m[1];
        if (NON_RUNTIME.test(label)) return;
        if (!labels.has(label)) {
          offenders.push(`.github/PULL_REQUEST_TEMPLATE/${name}:${i + 1} offers "${label}"`);
        }
      });
    }

    assert.deepStrictEqual(offenders, [],
      'a PR template asks contributors which runtime they tested and lists one GSD does not '
        + 'support. Labels must match the runtime label table (src/runtime-name-policy.cts '
        + `RUNTIME_LABELS), so a retired runtime cannot linger here. Offenders:\n  ${offenders.join('\n  ')}`);
  });

/**
 * #4709 Phase 3 — the Gemini CLI reviewer lane is retired.
 *
 * #1928 removed the gemini RUNTIME in 1.8.0 after Google sunset Gemini CLI on 2026-06-18. The
 * reviewer lane was re-created afterwards by the reviewer-lane-as-manifest-data work (6a9babda69,
 * #2798/#2837) — per the maintainer that re-creation was an error in that buildout, not a
 * decision, so retiring it corrects a mistake and needs no ADR-2782 amendment.
 *
 * The lane spawned `gemini {{model}} -p -`, a binary Google no longer serves for the
 * free/Pro/Ultra tiers that ARE GSD's audience.
 *
 * Every assertion below is STRUCTURAL — a declared lane, an owned config key, a capability count.
 * None asserts that the string "gemini" is absent, because that string is load-bearing across
 * Antigravity's real on-disk contract (~/.gemini/antigravity, ~/.gemini/config, hookEvents
 * "gemini", GEMINI.md) and across Google's own model IDs. The Antigravity block below is the
 * negative space that keeps this removal from overreaching.
 */
describe('#4709 the Gemini CLI reviewer lane is retired', () => {
  const reviewerIds = () => Object.keys(registry.capabilities)
    .filter((id) => registry.capabilities[id] && registry.capabilities[id].reviewer);

  test('capabilities/gemini/ no longer exists', () => {
    assert.strictEqual(
      fs.existsSync(path.join(ROOT, 'capabilities', 'gemini')),
      false,
      'the gemini capability directory must be deleted, not emptied',
    );
  });

  test('no capability declares a gemini reviewer lane', () => {
    const offenders = reviewerIds().filter((id) => {
      const rev = registry.capabilities[id].reviewer;
      return id === 'gemini' || rev.slug === 'gemini' || (rev.flags || []).includes('--gemini');
    });
    assert.deepStrictEqual(
      offenders,
      [],
      'a reviewer lane still resolves for the retired Gemini CLI; --gemini would spawn a binary '
        + `Google stopped serving on 2026-06-18. Offenders: ${offenders.join(', ')}`,
    );
  });

  test('no config key is owned for the retired lane', () => {
    const offenders = Object.keys(registry.configKeys).filter((k) => /\.gemini$/.test(k));
    assert.deepStrictEqual(
      offenders,
      [],
      'the retired lane still owns config keys, so `gsd config-set` would accept settings for a '
        + `lane that cannot run. Offenders:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('exactly 11 reviewer lanes remain', () => {
    // Counted from the registry, not hardcoded per-name, so adding a 12th lane later cannot
    // silently re-admit gemini under cover of the count still "looking right".
    const ids = reviewerIds().sort();
    assert.strictEqual(
      ids.length,
      11,
      `expected 11 reviewer lanes after retiring gemini, got ${ids.length}: ${ids.join(', ')}`,
    );
    assert.ok(!ids.includes('gemini'), 'gemini must not be among them');
  });

  test("Antigravity's reviewer lane is untouched (negative space)", () => {
    const agy = registry.capabilities.antigravity;
    assert.ok(agy && agy.reviewer, 'antigravity must still declare a reviewer lane');
    assert.strictEqual(agy.reviewer.slug, 'antigravity');
    for (const flag of ['--antigravity', '--agy']) {
      assert.ok(
        (agy.reviewer.flags || []).includes(flag),
        `antigravity must keep its ${flag} flag`,
      );
    }
    // Its own keys survive, including the deliberately `agy`-suffixed model key.
    for (const key of [
      'review.models.agy',
      'review.timeouts.antigravity',
      'review.max_prompt_tokens_per_reviewer.antigravity',
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(registry.configKeys, key),
        `antigravity must still own ${key}`,
      );
    }
  });

  test('the other ten lanes are untouched (negative space)', () => {
    const expected = [
      'antigravity', 'claude', 'coderabbit', 'codex', 'cursor',
      'kimi-code', 'llama-cpp', 'lm-studio', 'ollama', 'opencode', 'qwen',
    ];
    assert.deepStrictEqual(
      reviewerIds().sort(),
      expected,
      'retiring gemini must remove exactly one lane and disturb no other',
    );
  });
});
});
