'use strict';

/**
 * TDD tests for scripts/lint-retired-runtime-name.cjs.
 *
 * Mirrors tests/lint-legacy-dir-name.test.cjs's structure and conventions
 * closely: a temp git-fixture repo, driven via the process seam, with the
 * guard's REPO_ROOT overridden through GSD_LINT_RETIRED_RUNTIME_REPO_ROOT
 * (the sibling seam to that precedent's GSD_LINT_LEGACY_REPO_ROOT).
 */
// docs-guard-exempt: this file's `writeFile('docs/...', ...)` calls WRITE
// fabricated fixture content into a throwaway mkdtemp repo; none of it reads
// real shipped docs/ content. The `writeFile` callee name only incidentally
// matches lint-docs-guard-registration.cjs's reader-name heuristic (contains
// "file").

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GENERATOR_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const GUARD_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'lint-retired-runtime-name.cjs');

// scripts/lint-retired-runtime-name.cjs is exactly the shape
// GENERATOR_SCRIPT_TIMEOUT_MS describes: a single scripts/*.cjs lint script,
// spawned directly and once against a small temp fixture repo, no fan-out.
// Reuse the shared class norm (tests/helpers/timeouts.cjs) rather than
// restating its literal locally.
const GUARD_TIMEOUT_MS = GENERATOR_SCRIPT_TIMEOUT_MS;

// The guard's own anti-vacuity floor (MIN_EXPECTED_FILES in scripts/lint-retired-runtime-name.cjs).
const MIN_EXPECTED_FILES = 150;

// The retired runtime name, built via split-string concatenation so this
// test file cannot itself trip the guard (or any other regression-name
// lint) when scanned.
const RETIRED_NAME = 'Gem' + 'ini';

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-retired-runtime-test-'));
  gitOrThrow(['init', '--initial-branch=main'], { cwd: dir });
  gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: dir });
  gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function writeFile(dir, relPath, content) {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function gitAdd(dir, relPath) {
  gitOrThrow(['add', relPath], { cwd: dir });
}

function gitAddAll(dir) {
  gitOrThrow(['add', '-A'], { cwd: dir });
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup in lint test; no helpers import available
  fs.rmSync(dir, { recursive: true, force: true });
}

// Generates enough tracked, in-scan-set (docs/**/*.md) filler files to clear
// the guard's MIN_EXPECTED_FILES anti-vacuity floor, none of which mention
// the retired runtime name at all.
function seedFillerFiles(dir, count) {
  for (let i = 0; i < count; i++) {
    writeFile(dir, `docs/filler/note-${i}.md`, `# Filler note ${i}\n\nNothing retired here.\n`);
  }
}

function runGuard(cwd) {
  const r = runNode([GUARD_SCRIPT], {
    cwd,
    env: { ...process.env, GSD_LINT_RETIRED_RUNTIME_REPO_ROOT: cwd },
    timeoutMs: GUARD_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

describe('lint-retired-runtime-name — clean tree', () => {
  test('exits 0 when no tracked .md file names the retired runtime', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('0 violations'), `stdout: ${result.stdout}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — proves it can fail', () => {
  test('exits 1 with a path:line diagnostic when a bare capitalised retired name is scanned', () => {
    // Load-bearing case: a guard never observed failing is not a guard.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/guides/setup.md',
        `# Setup\n\nInstall ${RETIRED_NAME} as your runtime.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('docs/guides/setup.md:3:'),
        `stderr should carry a path:line diagnostic: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — case sensitivity is the mechanism', () => {
  test('exits 0 for every legitimate lowercase/uppercase spelling, none of which are the bare capitalised name', () => {
    // The regex is deliberately case-sensitive (no `i` flag): every
    // legitimate reference to the "gemini" string in this repo is spelled
    // differently from the bare capitalised `Gemini` token, so none of
    // these lines can match. See the guard's own module header.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/guides/config-homes.md',
        [
          '# Config homes',
          '',
          'Antigravity config lives at ~/.gemini/antigravity.',
          'It also reads ~/.gemini/config.',
          'Model id: gemini-2.5-flash-lite.',
          'Set GEMINI_CONFIG_DIR to override.',
          'See GEMINI.md for the instruction file.',
          '',
        ].join('\n'),
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — gsd-allow-retired-runtime-name marker', () => {
  test('exits 0 when the violating line also carries the inline allow marker', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/history/migration-note.md',
        `# Migration note\n\nInstall ${RETIRED_NAME} CLI for legacy testing. <!-- gsd-allow-retired-runtime-name: legacy-install note, see #1928 -->\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0 with allow marker, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — model-display versions are allowed', () => {
  test('exits 0 for a prose model list naming a version, not a runtime', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/reference/models.md',
        `# Supported models\n\nSupported model families: (o3, o4-mini, ${RETIRED_NAME} 2.5 Pro).\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — a version must NOT launder a runtime claim', () => {
  test('exits 1 when a model-display version is attached to runtime-claiming wording', () => {
    // This pins the fix for the earlier blanket `/^ \d/` ("space then a
    // digit") exclusion, which was too broad: it also matched a genuine
    // stale-runtime claim like "Gemini 2.5 CLI as a supported runtime.",
    // laundering the false positive fix into a false negative on the same
    // line. A version number must never launder a runtime claim.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/guides/runtime-claim.md',
        `# Runtimes\n\nInstall for ${RETIRED_NAME} 2.5 CLI as a supported runtime.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('docs/guides/runtime-claim.md:3:'),
        `stderr should carry a path:line diagnostic: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — -style dialect wording is allowed', () => {
  test('exits 0 for a genuine hook-dialect reference ("Gemini-style")', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/guides/hooks.md',
        `# Hooks\n\nAntigravity uses ${RETIRED_NAME}-style settings.json hooks.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — path allowlist works', () => {
  test('exits 0 when the same violating content sits under an allowlisted path (docs/adr/)', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/adr/999-retired-runtime-record.md',
        `# ADR 999\n\nInstall ${RETIRED_NAME} CLI as a supported runtime.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0 under docs/adr/, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — anti-vacuity floor', () => {
  test('refuses to report clean when far too few files are scanned', () => {
    // The guard errors out (non-zero exit) rather than silently reporting
    // "0 violations" on an empty/broken walk — see its MIN_EXPECTED_FILES check.
    const dir = createTempRepo();
    try {
      writeFile(dir, 'docs/guides/one.md', '# Just one file\n\nNothing retired here.\n');
      gitAdd(dir, 'docs/guides/one.md');

      const result = runGuard(dir);
      assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('only 1 file'),
        `stderr should explain the anti-vacuity refusal: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — root-level *.md is in the scan set', () => {
  test('exits 1 for a violating root README.md', () => {
    // Regression test for the defect that made this guard necessary AND
    // initially unable to see it: four locale READMEs advertised the retired
    // runtime as supported at README.<locale>.md:9/:24/:46 while the scan set
    // covered only docs/ gsd-core/ commands/ agents/ skills/. The repo's
    // most-read runtime-advertising surface was structurally invisible.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(dir, 'README.md', `# Project\n\nInstall ${RETIRED_NAME} CLI as your runtime.\n`);
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('README.md:3:'),
        `stderr should carry a path:line diagnostic for the root README: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — pinned occurrences are occurrence-scoped', () => {
  test('an approved line in a pinned file does NOT licence a second stale occurrence in the same file', () => {
    // This is the whole point of pinning occurrences instead of allowlisting
    // whole files. Under a file-level allowlist both lines below would pass
    // and a genuinely new stale claim would be absorbed silently.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'CONTEXT.md',
        [
          '# Context',
          '',
          `Session log: ${RETIRED_NAME} [runtime removed #1928] noted inline.`,
          `Install ${RETIRED_NAME} CLI as a supported runtime.`,
          '',
        ].join('\n'),
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('CONTEXT.md:4:'),
        `the UNAPPROVED line 4 must be reported: ${result.stderr}`,
      );
      assert.ok(
        !result.stderr.includes('CONTEXT.md:3:'),
        `the pinned line 3 must NOT be reported: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('exits 0 when a pinned file carries only its approved occurrence', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'CONTEXT.md',
        `# Context\n\nSession log: ${RETIRED_NAME} [runtime removed #1928] noted inline.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — the allowlist cannot silently rot', () => {
  test('exits 1 reporting a stale pin when an approved line no longer matches', () => {
    // An unmatched pin pre-approves a future occurrence nobody reviewed, so
    // it is reported rather than ignored.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(dir, 'CONTEXT.md', '# Context\n\nThe annotated session log line was rewritten.\n');
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('stale allowlist entr'),
        `stderr should name the stale allowlist entry: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — file-level allowlist', () => {
  test('exits 0 for violating content inside generated-and-locked CHANGELOG.md', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'CHANGELOG.md',
        `# Changelog\n\n- Removed the sunset ${RETIRED_NAME} CLI runtime — use Antigravity instead. (#1928)\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — anti-vacuity floor boundaries', () => {
  // CLAUDE.md requires limit-1 / limit / limit+1 coverage. The "limit" here
  // is how many in-scan-set files the walk actually READ.
  test(`refuses to report clean at MIN_EXPECTED_FILES-1 (${MIN_EXPECTED_FILES - 1})`, () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES - 1);
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes(`only ${MIN_EXPECTED_FILES - 1} file`),
        `stderr should state the count it refused on: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test(`reports clean exactly at MIN_EXPECTED_FILES (${MIN_EXPECTED_FILES})`, () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes(`${MIN_EXPECTED_FILES} files scanned`),
        `stdout should report the read count: ${result.stdout}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test(`reports clean at MIN_EXPECTED_FILES+1 (${MIN_EXPECTED_FILES + 1})`, () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES + 1);
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — the runtime-word veto is multilingual', () => {
  test('exits 1 when a Japanese runtime word accompanies a model-display version', () => {
    // The model-display SHAPE matches here (" 2.5 Pro"), so this is a real
    // test of the veto rather than of the shape rule failing to match.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/ja-JP/guides/runtimes.md',
        `# ランタイム\n\n${RETIRED_NAME} 2.5 Pro をランタイムとして使用します。\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
    } finally {
      cleanup(dir);
    }
  });

  test('exits 0 when "client" appears — the veto is word-anchored, so CLI must not match inside it', () => {
    // Without \b anchors, the case-insensitive "CLI" term matched inside
    // "client"/"clip", vetoing legitimate model lists.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/reference/client-models.md',
        `# Models\n\nThe client library supports these models: (o3, ${RETIRED_NAME} 2.5 Pro).\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — model display across locale punctuation', () => {
  test('exits 0 for full-width digits and CJK punctuation', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/zh-CN/reference/models.md',
        `# 模型\n\n思考类模型（o3、o4-mini、${RETIRED_NAME} ２．５ Pro）。\n`
          + `另见 ${RETIRED_NAME} 3、以及其他模型。\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — dialect marker may PRECEDE the name', () => {
  test('exits 0 for the Portuguese word order ("no estilo Gemini")', () => {
    // Measured, not assumed: pt-BR puts the qualifier before the name, so a
    // suffix-only dialect rule cannot express this locale at all.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/pt-BR/guides/hooks.md',
        `# Hooks\n\nEntradas de hook no estilo ${RETIRED_NAME} quando instalado pelo GSD.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });

  test('exits 1 when a dialect word is present but the name is still followed by a runtime word', () => {
    // "compatível com <name> CLI" is a runtime claim wearing a dialect word,
    // so the dialect exemption is refused when a runtime word sits
    // immediately after the name.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/pt-BR/guides/policy.md',
        `# Politica\n\nUsa a politica compatível com ${RETIRED_NAME} CLI e mais.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('docs/pt-BR/guides/policy.md:3:'),
        `stderr should carry a path:line diagnostic: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — a dialect marker does not survive a runtime word', () => {
  // Reviewer finding (BLOCKER): the dialect exemption originally applied only
  // an "immediately after the name" veto, while the model rule applied its
  // veto line-globally. A dialect marker anywhere in a +/-24-char window then
  // excused an occurrence on a line that literally asserted a live runtime.
  const CASES = [
    ['pt dialect word plus the literal "runtime"', 'docs/pt-BR/guides/a3.md',
      `Suportamos ${RETIRED_NAME}, no estilo padrao, como runtime de instalacao.`],
    ['zh dialect word plus 運行時', 'docs/zh-CN/guides/a4.md',
      `${RETIRED_NAME} 兼容，并且是受支持的运行时之一。`],
    ['a non-adjacent "style" that is not a dialect reference at all', 'docs/guides/a2.md',
      `${RETIRED_NAME} is style-agnostic and fully supported by the installer.`],
  ];

  for (const [label, relPath, body] of CASES) {
    test(`exits 1 — ${label}`, () => {
      const dir = createTempRepo();
      try {
        seedFillerFiles(dir, MIN_EXPECTED_FILES);
        writeFile(dir, relPath, `# t\n\n${body}\n`);
        gitAddAll(dir);

        const result = runGuard(dir);
        assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
        assert.ok(
          result.stderr.includes(`${relPath}:3:`),
          `stderr should carry a path:line diagnostic: ${result.stderr}`,
        );
      } finally {
        cleanup(dir);
      }
    });
  }
});

describe('lint-retired-runtime-name — one legitimate occurrence does not license the next', () => {
  test('exits 1 when a dialect reference and a fresh live claim share a line', () => {
    // Reviewer finding (BLOCKER): with a +/-24-char window,
    // `| Antigravity | Gemini-style hooks | Gemini support is live |` exited 0
    // — the second occurrence sat 21 chars from `style`. This is the exact
    // locale-table row shape the window was tuned for, so it was the most
    // likely real-world regression vector.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/guides/a1.md',
        `# t\n\n| Antigravity | ${RETIRED_NAME}-style hooks | ${RETIRED_NAME} support is live |\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('docs/guides/a1.md:3:'),
        `stderr should carry a path:line diagnostic: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — a version number never launders a claim', () => {
  // Reviewer finding (MAJOR): the model-display escape accepted
  // <version><punctuation> and <version><EOL> whenever no RUNTIME_WORDS term
  // happened to appear, so five unqualified live-runtime claims exited 0.
  // "Absence of a veto word" is not evidence: the rule now requires POSITIVE
  // model-axis evidence, which inverts the failure direction from silently
  // allowing to flagging.
  const CASES = [
    ['a version ending the sentence', 'docs/guides/b1.md',
      `The installer now offers ${RETIRED_NAME} 3.`],
    ['a version inside a runtime list', 'docs/guides/b2.md',
      `GSD installs cleanly on ${RETIRED_NAME} 3, Kimi, and Codex.`],
    ['a version in parentheses', 'docs/guides/b3.md',
      `Pick your coding tool (${RETIRED_NAME} 3) during setup.`],
    ['a "plugins" list — "plugin" is not a runtime word', 'docs/guides/c3.md',
      `Supported plugins: Claude Code, Codex, ${RETIRED_NAME} 3.`],
    ['an "agents" list — "agent" is deliberately not a runtime word', 'docs/guides/c4.md',
      `Supported agents include ${RETIRED_NAME} 3, Kimi, and Cursor.`],
  ];

  for (const [label, relPath, body] of CASES) {
    test(`exits 1 — ${label}`, () => {
      const dir = createTempRepo();
      try {
        seedFillerFiles(dir, MIN_EXPECTED_FILES);
        writeFile(dir, relPath, `# t\n\n${body}\n`);
        gitAddAll(dir);

        const result = runGuard(dir);
        assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
        assert.ok(
          result.stderr.includes(`${relPath}:3:`),
          `stderr should carry a path:line diagnostic: ${result.stderr}`,
        );
      } finally {
        cleanup(dir);
      }
    });
  }
});

describe('lint-retired-runtime-name — pins are span-scoped, not line-scoped', () => {
  // Reviewer finding (MAJOR): with line-level containment, a short snippet
  // anywhere on a line pre-approved a brand-new claim on that same line.
  // A pin now only ever excuses the occurrence its own text covers.
  test('exits 1 when a new claim shares a line with a short pinned snippet', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'gsd-core/workflows/settings-advanced.md',
        `# t\n\nKnown provider menu update: ${RETIRED_NAME} CLI is once again a selectable GSD runtime.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
    } finally {
      cleanup(dir);
    }
  });

  test('exits 1 when a parenthetical provider pin shares a line with a new claim', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'agents/gsd-framework-selector.md',
        `# t\n\nInstall target: Google (${RETIRED_NAME}) — choose ${RETIRED_NAME} CLI as your GSD runtime.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
    } finally {
      cleanup(dir);
    }
  });

  test('exits 0 when every occurrence falls inside a pinned span', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'agents/gsd-framework-selector.md',
        `# t\n\n{ label: "Google (${RETIRED_NAME})", description: "Committed to ${RETIRED_NAME} / Google Cloud / Vertex AI" },\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });

  test('exits 1 for a new claim added to a fully-pinned file', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'agents/gsd-framework-selector.md',
        `# t\n\n{ label: "Google (${RETIRED_NAME})", description: "Committed to ${RETIRED_NAME} / Google Cloud / Vertex AI" },\n`
          + `Install target: choose ${RETIRED_NAME} CLI as your GSD runtime.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('agents/gsd-framework-selector.md:4:'),
        `the NEW line 4 must be reported: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — the stale-pin report must never be false', () => {
  test('does not report a pin stale when its line is present but excused by another rule', () => {
    // Reviewer finding (MAJOR): `usedPins` was recorded only on the Tier-2
    // branch, and the general rules run first — so a pinned line that a
    // general rule also matched never marked its pin used, producing a
    // provably false "no line matches pinned snippet" whose printed remedy
    // told the maintainer to delete a still-needed pin.
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'CONTEXT.md',
        `# C\n\n${RETIRED_NAME}-style dialect, and ${RETIRED_NAME} [runtime removed #1928] in the log.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.ok(
        !result.stderr.includes('stale allowlist'),
        `the pin IS present on that line, so no stale report may be emitted: ${result.stderr}`,
      );
      // Guard against a vacuous pass: the run must actually have flagged the
      // unpinned dialect occurrence, not skipped the file.
      assert.ok(
        result.stderr.includes('CONTEXT.md:3:'),
        `expected the unpinned occurrence to be flagged: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('still reports a genuinely stale pin', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(dir, 'CONTEXT.md', '# C\n\nThe annotated session log line was rewritten.\n');
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes('stale allowlist entr'),
        `stderr should name the stale allowlist entry: ${result.stderr}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — the escape hatch must carry a reason', () => {
  test('exits 1 for a bare marker with no justification', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        'docs/guides/d1.md',
        `# t\n\n${RETIRED_NAME} CLI is a fully supported GSD runtime. <!-- gsd-allow-retired-runtime-name -->\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-retired-runtime-name — .changeset/ shares CHANGELOG.md\'s tier', () => {
  test('exits 0 for a changeset fragment describing the retirement', () => {
    const dir = createTempRepo();
    try {
      seedFillerFiles(dir, MIN_EXPECTED_FILES);
      writeFile(
        dir,
        '.changeset/foo.md',
        `---\ntype: Fixed\npr: 0\n---\n**Retired the ${RETIRED_NAME} CLI reviewer lane** — Google stopped serving it.\n`,
      );
      gitAddAll(dir);

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});
