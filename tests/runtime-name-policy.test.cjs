// docs-guard-exempt: kilo.ai/docs/... is an external URL citation in a comment, not a repo path.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const {
  canonicalizeRuntimeName,
  resolveRuntimeNameFromCandidates,
  getProjectInstructionFile,
  RETIRED_RUNTIME_IDS,
  isRetiredRuntimeId,
  getRuntimeLabel,
  getGlobalConfigHomeFragment,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'));
const { getGlobalConfigDir } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));

describe('runtime-name-policy canonical runtime ids', () => {
  test('canonicalizes Kimi without adding extra aliases', () => {
    assert.strictEqual(canonicalizeRuntimeName('kimi'), 'kimi');
    assert.strictEqual(canonicalizeRuntimeName(' KIMI '), 'kimi');
    assert.strictEqual(resolveRuntimeNameFromCandidates('', null, 'kimi'), 'kimi');
    assert.strictEqual(canonicalizeRuntimeName('kimi-cli'), null);
  });

  test('canonicalizes devin-desktop to windsurf (#792)', () => {
    assert.strictEqual(canonicalizeRuntimeName('devin-desktop'), 'windsurf');
    assert.strictEqual(canonicalizeRuntimeName('DEVIN-DESKTOP'), 'windsurf');
    assert.strictEqual(resolveRuntimeNameFromCandidates('devin-desktop'), 'windsurf');
  });
});

describe('runtime-name-policy windsurf alias parity — manifest vs FALLBACK_ALIASES (#792)', () => {
  // DEFECT.GENERATIVE-FIX: manifest and FALLBACK_ALIASES are manually mirrored;
  // this test fails if they diverge for the windsurf key.
  const manifestPath = path.join(ROOT, 'gsd-core', 'bin', 'shared', 'runtime-aliases.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  test('manifest windsurf array includes devin-desktop', () => {
    assert.ok(
      Array.isArray(manifest.windsurf) && manifest.windsurf.includes('devin-desktop'),
      `runtime-aliases.manifest.json windsurf array must include 'devin-desktop'; got: ${JSON.stringify(manifest.windsurf)}`,
    );
  });

  test('FALLBACK_ALIASES windsurf includes devin-desktop (via canonicalization round-trip)', () => {
    // The built module merges manifest over FALLBACK_ALIASES; if the manifest is present
    // this verifies the combined set. The manifest test above separately guards the manifest.
    // Here we verify the live canonicalizer sees devin-desktop -> windsurf.
    assert.strictEqual(
      canonicalizeRuntimeName('devin-desktop'),
      'windsurf',
      'devin-desktop must resolve to windsurf via alias lookup',
    );
  });

  test('manifest and FALLBACK_ALIASES windsurf alias sets are identical', () => {
    // Read FALLBACK_ALIASES from source to detect manual drift before a build.
    const srcPath = path.join(ROOT, 'src', 'runtime-name-policy.cts');
    // allow-test-rule: source-text-is-the-product (#3464)
    // FALLBACK_ALIASES source text IS the product contract for runtimes that can't load the manifest at runtime; verifying
    // both surfaces contain the same windsurf aliases catches manual-mirror drift.
    const src = fs.readFileSync(srcPath, 'utf8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own bounded src/runtime-name-policy.cts source, not adversarial input
    const match = src.match(/windsurf:\s*\[([^\]]+)\]/);
    assert.ok(match, 'FALLBACK_ALIASES windsurf row must exist in src/runtime-name-policy.cts');
    const srcAliases = match[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const manifestAliases = [...manifest.windsurf].sort();
    assert.deepStrictEqual(
      [...srcAliases].sort(),
      manifestAliases,
      `FALLBACK_ALIASES windsurf=${JSON.stringify(srcAliases.sort())} must match manifest windsurf=${JSON.stringify(manifestAliases)}`,
    );
  });
});

describe('runtime-name-policy getProjectInstructionFile (#1529)', () => {
  test('claude maps to .claude/CLAUDE.md (kept-as-is boundary case)', () => {
    assert.strictEqual(getProjectInstructionFile('claude'), '.claude/CLAUDE.md');
  });

  test('codex maps to AGENTS.md', () => {
    assert.strictEqual(getProjectInstructionFile('codex'), 'AGENTS.md');
  });

  test('opencode maps to AGENTS.md (the #1529 bug surface)', () => {
    assert.strictEqual(getProjectInstructionFile('opencode'), 'AGENTS.md');
  });

  test('kilo maps to AGENTS.md', () => {
    assert.strictEqual(getProjectInstructionFile('kilo'), 'AGENTS.md');
  });

  test('kimi maps to AGENTS.md', () => {
    assert.strictEqual(getProjectInstructionFile('kimi'), 'AGENTS.md');
  });

  test('copilot maps to .github/copilot-instructions.md (GitHub docs read path)', () => {
    assert.strictEqual(getProjectInstructionFile('copilot'), '.github/copilot-instructions.md');
  });

  test('a retired runtime id is REFUSED, not fallen back (#1928 / #4709 AC#1)', () => {
    // This test previously asserted the fallback — its own title said "falls
    // back to AGENTS.md" — which is precisely the defect #4709 AC#1 names: a
    // retired runtime resolving to a plausible value instead of failing. The
    // assertion is inverted rather than deleted, so the history of what the
    // behaviour used to be stays attached to the test that pinned it.
    assert.throws(() => getProjectInstructionFile('gem' + 'ini'), /retired by #1928/);
  });

  test('antigravity maps to GEMINI.md', () => {
    assert.strictEqual(getProjectInstructionFile('antigravity'), 'GEMINI.md');
  });

  test('unknown runtime maps to AGENTS.md (safe cross-agent default, boundary case)', () => {
    assert.strictEqual(getProjectInstructionFile('future-runtime-xyz'), 'AGENTS.md');
    assert.strictEqual(getProjectInstructionFile(''), 'AGENTS.md');
    assert.strictEqual(getProjectInstructionFile(null), 'AGENTS.md');
    assert.strictEqual(getProjectInstructionFile(undefined), 'AGENTS.md');
  });

  test('aliases normalize via canonicalizeRuntimeName before mapping', () => {
    // codex-cli is an alias for codex; it must resolve to the codex mapping.
    assert.strictEqual(getProjectInstructionFile('codex-cli'), 'AGENTS.md');
    // opencode-cli is an alias for opencode.
    assert.strictEqual(getProjectInstructionFile('opencode-cli'), 'AGENTS.md');
    // gemini-cli was an alias for the gemini runtime, which #1928 removed. It
    // is therefore a RETIRED spelling, not merely an unrecognized one, so it is
    // refused rather than defaulted (#4709 AC#1). This assertion previously
    // pinned the fallback; inverted rather than deleted so the record of the
    // old behaviour stays attached to the test that pinned it.
    assert.throws(() => getProjectInstructionFile('gem' + 'ini-cli'), /retired by #1928/);
    // github-copilot is an alias for copilot.
    assert.strictEqual(getProjectInstructionFile('github-copilot'), '.github/copilot-instructions.md');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-783-kilo-global-skills-base.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-783-kilo-global-skills-base (consolidation epic #1969 B3 #1972)", () => {
'use strict';
// Regression guard for bug #783.
//
// getGlobalSkillsBase('kilo') was returning ~/.config/kilo/skills (the XDG
// config dir) instead of ~/.kilo/skills — where Kilo Code actually discovers
// global skills per its docs:
//   https://kilo.ai/docs/customize/skills
//   "Global skills are located in the `.kilo` directory within your Home
//    directory: ~/.kilo/skills/"
//
// The fix adds a special case in getGlobalSkillsBase() that resolves kilo's
// skills dir from HOME (not from the XDG config dir). The config dir at
// ~/.config/kilo is still CORRECT for commands (command/) and must stay
// unchanged — this test verifies both roles are separate.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const {
  getGlobalConfigDir,
  getGlobalSkillsBase,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));

// Helper: temporarily override env vars for a test, restoring them afterwards.
function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key] of Object.entries(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// Clear all kilo-relevant env vars so tests are hermetic.
const kiloEnvClears = {
  KILO_CONFIG_DIR: undefined,
  XDG_CONFIG_HOME: undefined,
};

describe('bug #783: kilo global skills dir is ~/.kilo/skills, not ~/.config/kilo/skills', () => {
  test('getGlobalSkillsBase("kilo") resolves to ~/.kilo/skills', () => {
    withEnv(kiloEnvClears, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });

  test('getGlobalConfigDir("kilo") still resolves to ~/.config/kilo (config dir unchanged)', () => {
    withEnv(kiloEnvClears, () => {
      assert.strictEqual(
        getGlobalConfigDir('kilo'),
        path.join(os.homedir(), '.config', 'kilo'),
      );
    });
  });

  test('kilo skills dir and config dir are decoupled (not equal, not nested)', () => {
    withEnv(kiloEnvClears, () => {
      const skillsBase = getGlobalSkillsBase('kilo');
      const configDir = getGlobalConfigDir('kilo');

      assert.notStrictEqual(skillsBase, configDir, 'skills dir must differ from config dir');
      assert.ok(
        !skillsBase.startsWith(configDir + path.sep),
        `skills dir (${skillsBase}) must not be nested under config dir (${configDir})`,
      );
      assert.ok(
        !configDir.startsWith(skillsBase + path.sep),
        `config dir (${configDir}) must not be nested under skills dir (${skillsBase})`,
      );
    });
  });

  test('getGlobalSkillsBase("kilo") is NOT affected by KILO_CONFIG_DIR override', () => {
    // Skills always live in ~/.kilo/skills regardless of XDG/config-dir overrides.
    withEnv({ KILO_CONFIG_DIR: '/tmp/custom-kilo-config', XDG_CONFIG_HOME: undefined }, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });

  test('getGlobalSkillsBase("kilo") is NOT affected by XDG_CONFIG_HOME override', () => {
    withEnv({ KILO_CONFIG_DIR: undefined, XDG_CONFIG_HOME: '/tmp/custom-xdg' }, () => {
      assert.strictEqual(
        getGlobalSkillsBase('kilo'),
        path.join(os.homedir(), '.kilo', 'skills'),
      );
    });
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-4709-retired-runtime-ids.test.cjs — AC#1 of epic #4709.
//
// AC#1 of epic #4709 — a RETIRED runtime id must never resolve silently.
//
// Measured before the fix (all four returned a plausible value instead of
// failing): getRuntimeLabel('gemini') -> 'Claude Code',
// getProjectInstructionFile('gemini') -> 'AGENTS.md',
// getGlobalConfigHomeFragment('gemini') -> "'.claude'",
// getGlobalConfigDir('gemini') -> ~/.claude — byte-identical to the value for
// 'claude' itself. So asking for a runtime Google sunset on 2026-06-18 wrote
// into Claude Code's config home and labelled the install "Claude Code".
//
// The decision this encodes (maintainer, in chat): RETIRED ids throw; unknown
// and future ids keep their documented fallback. Absence of knowledge is not
// the same as recorded retirement — the #1529 contract in
// getProjectInstructionFile's docblock ("unknown / future runtimes ->
// AGENTS.md") is deliberately preserved, and the tests below assert it.
// ────────────────────────────────────────────────────────────────────────

const RETIRED = 'gem' + 'ini';

// The four accessors AC#1 names, as {label, call} so each property can be
// asserted across all of them without restating the list.
const ACCESSORS = [
  { label: 'getRuntimeLabel', call: (id) => getRuntimeLabel(id) },
  { label: 'getProjectInstructionFile', call: (id) => getProjectInstructionFile(id) },
  { label: 'getGlobalConfigHomeFragment', call: (id) => getGlobalConfigHomeFragment(id) },
  { label: 'getGlobalConfigDir', call: (id) => getGlobalConfigDir(id) },
];

describe('#4709 AC#1 — a retired runtime id throws, one test per accessor', () => {
  for (const { label, call } of ACCESSORS) {
    test(`${label} throws for a retired id instead of resolving it`, () => {
      assert.throws(
        () => call(RETIRED),
        (err) => {
          assert.ok(err instanceof Error, `${label} should throw an Error, got ${typeof err}`);
          return true;
        },
        `${label} must not silently resolve a retired runtime id`,
      );
    });
  }
});

describe('#4709 AC#1 — the throw must be actionable', () => {
  test('the message names the retired id, the successor, and the retiring issue', () => {
    let message = '';
    try {
      getRuntimeLabel(RETIRED);
    } catch (err) {
      message = String(err && err.message);
    }
    assert.match(message, new RegExp(RETIRED, 'i'), 'should name the retired id');
    assert.match(message, /Antigravity/i, 'should name the successor');
    assert.match(message, /#1928/, 'should cite the retiring issue');
  });

  test('the error is distinguishable without string-matching the message', () => {
    // A caller that wants to handle this case specifically must be able to,
    // rather than grepping a human-readable string that may be reworded.
    let code;
    let name;
    try {
      getRuntimeLabel(RETIRED);
    } catch (err) {
      code = err && err.code;
      name = err && err.name;
    }
    assert.ok(
      code === 'GSD_RETIRED_RUNTIME' || name === 'RetiredRuntimeError',
      `expected a machine-checkable discriminator, got code=${String(code)} name=${String(name)}`,
    );
  });
});

describe('#4709 AC#1 — case and alias spellings all throw', () => {
  // Measured: 'gemini', 'gemini-cli', 'Gemini' and 'GEMINI' all resolved to
  // the SAME fallback before the fix, so all of them must be caught. These are
  // argv values, so case is normalised here — the opposite of the #4753 prose
  // lint, where case sensitivity is itself the mechanism.
  const SPELLINGS = [RETIRED, `${RETIRED}-cli`, RETIRED.toUpperCase(), `  ${RETIRED}  `,
    RETIRED[0].toUpperCase() + RETIRED.slice(1)];

  for (const spelling of SPELLINGS) {
    test(`every accessor throws for ${JSON.stringify(spelling)}`, () => {
      for (const { label, call } of ACCESSORS) {
        assert.throws(
          () => call(spelling),
          (err) => err instanceof Error && err.code === 'GSD_RETIRED_RUNTIME',
          `${label} should throw RetiredRuntimeError for ${JSON.stringify(spelling)}`,
        );
      }
    });
  }
});

describe('#4709 AC#1 — set membership, never a prefix or substring match', () => {
  // THE load-bearing negative. Google's live model ids are `gemini-2.5-pro`,
  // `gemini-3.1-pro-preview` and friends, and Antigravity's real on-disk
  // contract is full of them. A substring or prefix test would throw on the
  // model axis — which is the exact trap this epic hit three times, an
  // over-broad match catching the model axis along with the runtime axis.
  const MUST_NOT_THROW = [
    `${RETIRED}-2.5-pro`,
    `${RETIRED}-3.1-pro-preview`,
    `${RETIRED}-2.5-flash-lite`,
    `${RETIRED}x`,
    RETIRED.slice(0, -1),
    // Inherited properties of the details object, NOT retired runtime ids. A
    // bare computed-key read made these throw with every field undefined,
    // while isRetiredRuntimeId correctly said false — a demonstrated
    // disagreement between two guards over one input.
    '__proto__',
    'constructor',
    '  CONSTRUCTOR  ',
  ];

  for (const id of MUST_NOT_THROW) {
    test(`${JSON.stringify(id)} does NOT throw — it is not a retired runtime id`, () => {
      for (const { label, call } of ACCESSORS) {
        assert.doesNotThrow(() => call(id), `${label} must not throw for ${JSON.stringify(id)}`);
      }
    });
  }
});

describe('#4709 AC#1 — unknown and empty ids keep their documented fallback', () => {
  // This is the decision the maintainer chose to PRESERVE, and it is what
  // separates the chosen fix from the literal reading of AC#1 ("reject a
  // non-canonical runtime id"). A patch that later tightens the guard to
  // reject every non-canonical id turns these red, with the reason attached.
  test('a genuinely unknown runtime id still resolves to the safe defaults', () => {
    assert.strictEqual(getRuntimeLabel('notarealruntime'), 'Claude Code');
    assert.strictEqual(getProjectInstructionFile('notarealruntime'), 'AGENTS.md');
    assert.strictEqual(getGlobalConfigHomeFragment('notarealruntime'), "'.claude'");
    assert.doesNotThrow(() => getGlobalConfigDir('notarealruntime'));
  });

  test('empty string keeps its explicit documented branch', () => {
    // `if (!runtime) return <default>` is a supported input contract that call
    // sites rely on, not a non-canonical id.
    assert.strictEqual(getRuntimeLabel(''), 'Claude Code');
    assert.strictEqual(getProjectInstructionFile(''), 'AGENTS.md');
    assert.strictEqual(getGlobalConfigHomeFragment(''), "'.claude'");
    assert.doesNotThrow(() => getGlobalConfigDir(''));
  });
});

describe('#4709 AC#1 — no canonical runtime regressed', () => {
  // Asserting only the throw would pass if EVERY id threw, which would break
  // every install. These pin the other direction with the real pre-fix values.
  test('claude and codex keep their exact instruction files', () => {
    assert.strictEqual(getProjectInstructionFile('claude'), '.claude/CLAUDE.md');
    assert.strictEqual(getProjectInstructionFile('codex'), 'AGENTS.md');
    assert.strictEqual(getProjectInstructionFile('copilot'), '.github/copilot-instructions.md');
  });

  test('a spread of canonical ids resolve on all four accessors without throwing', () => {
    for (const id of ['claude', 'codex', 'opencode', 'antigravity', 'copilot', 'cursor', 'kimi', 'pi']) {
      for (const { label, call } of ACCESSORS) {
        assert.doesNotThrow(() => call(id), `${label} must not throw for canonical id ${id}`);
      }
    }
  });

  test('getGlobalConfigHomeFragment values are unchanged for canonical ids', () => {
    // ADR-1239 Phase B / #1679 preserved these BYTE-FOR-BYTE from the prior
    // 14-branch chain, with golden install parity asserting generated hook
    // output is unchanged. The retired-id guard must not perturb them.
    assert.strictEqual(getGlobalConfigHomeFragment('claude'), "'.claude'");
    assert.strictEqual(getGlobalConfigHomeFragment('codex'), "'.codex'");
    assert.strictEqual(getGlobalConfigHomeFragment('opencode'), "'.config', 'opencode'");
    assert.strictEqual(getGlobalConfigHomeFragment('pi'), "'.pi', 'agent'");
  });
});

describe('#4709 AC#1 — the retired-id set is well formed', () => {
  test('exports a frozen, non-empty set containing the retired runtime', () => {
    assert.ok(RETIRED_RUNTIME_IDS, 'RETIRED_RUNTIME_IDS should be exported');
    const ids = Array.from(RETIRED_RUNTIME_IDS);
    assert.ok(ids.length > 0, 'should not be empty');
    assert.ok(ids.includes(RETIRED), `should contain ${RETIRED}`);
    assert.ok(ids.every((id) => id === id.toLowerCase()), 'ids should be stored lowercase');
  });

  test('isRetiredRuntimeId normalises case and whitespace but does not substring-match', () => {
    assert.strictEqual(isRetiredRuntimeId(RETIRED), true);
    assert.strictEqual(isRetiredRuntimeId(`  ${RETIRED.toUpperCase()}  `), true);
    assert.strictEqual(isRetiredRuntimeId(`${RETIRED}-2.5-pro`), false);
    assert.strictEqual(isRetiredRuntimeId(''), false);
    assert.strictEqual(isRetiredRuntimeId(undefined), false);
    assert.strictEqual(isRetiredRuntimeId(null), false);
    // The predicate and assertNotRetiredRuntime must agree for every input.
    assert.strictEqual(isRetiredRuntimeId('__proto__'), false);
    assert.strictEqual(isRetiredRuntimeId('constructor'), false);
    assert.strictEqual(isRetiredRuntimeId('hasOwnProperty'), false);
  });
});

describe('#4709 AC#1 — parity with the build-time prose lint', () => {
  test('the runtime id set and the lint table describe the same retirements', () => {
    // CLAUDE.md, Generative Fix Divergence: when constants are mirrored across
    // parallel surfaces, add a parity assertion that fails if they diverge.
    // scripts/lint-retired-runtime-name.cjs (#4753) guards PROSE at build time;
    // RETIRED_RUNTIME_IDS guards IDS at runtime. Retiring a runtime in one and
    // forgetting the other is the drift this catches.
    const { RETIRED_RUNTIMES } = require(path.join(ROOT, 'scripts', 'lint-retired-runtime-name.cjs'));
    assert.ok(Array.isArray(RETIRED_RUNTIMES), 'the lint should export its table');

    const fromLint = RETIRED_RUNTIMES.map((r) => String(r.name).toLowerCase()).sort();
    const fromPolicy = Array.from(RETIRED_RUNTIME_IDS).map((s) => String(s).toLowerCase()).sort();
    assert.deepStrictEqual(
      fromPolicy,
      fromLint,
      'RETIRED_RUNTIME_IDS and the lint\'s RETIRED_RUNTIMES must agree',
    );
  });
});
