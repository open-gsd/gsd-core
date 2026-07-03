// allow-test-rule: source-text-is-the-product
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['agents', 'commands', path.join('gsd-core', 'references')];

// Fix #3: broaden to catch backtick-delimited and split-quoted forms.
// Matches: node <optional-quote/backtick> ($HOME|${HOME}|~) <any non-newline chars> gsd-tools.cjs
// PREAMBLE_SKIP_RE is still applied before this to exclude preamble lines.
const HARDCODED_RE = /node\s+[`"']?(?:\$HOME|\$\{HOME\}|~)[^\n]*?gsd-tools\.cjs/;
const PREAMBLE_SKIP_RE = /_GSD_SHIM_NAME|GSD_TOOLS=|\[ -f/;

function collectMdFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function extractBashBlocks(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let inBash = false;
  let blockLines = [];
  let blockStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBash) {
      // Fix #1: match bash/sh as the language tag regardless of any trailing info string.
      if (/^```(?:bash|sh)(?:\s.*)?$/.test(line)) {
        inBash = true;
        blockLines = [];
        blockStart = i + 1;
      }
      // Plain ``` fences (no language) are ignored
    } else {
      if (/^```\s*$/.test(line)) {
        blocks.push({ lines: blockLines, startLine: blockStart });
        inBash = false;
        blockLines = [];
      } else {
        blockLines.push({ text: line, lineNum: i + 1 });
      }
    }
  }

  // Fix #2: if file ends while still inside a bash block, push the accumulated block.
  if (inBash && blockLines.length > 0) {
    blocks.push({ lines: blockLines, startLine: blockStart });
  }

  return blocks;
}

// Fix #4: scan returns per-directory block counts so we can assert each dir contributed.
function scanAll() {
  const violations = [];
  const perDirCounts = {};

  for (const dir of SCAN_DIRS) {
    const absDir = path.join(ROOT, dir);
    perDirCounts[dir] = { exists: fs.existsSync(absDir), bashBlockCount: 0 };
    if (!perDirCounts[dir].exists) continue;
    const files = collectMdFiles(absDir);
    for (const file of files) {
      const blocks = extractBashBlocks(file);
      perDirCounts[dir].bashBlockCount += blocks.length;
      const relPath = path.relative(ROOT, file).replace(/\\/g, '/');
      for (const block of blocks) {
        for (const { text, lineNum } of block.lines) {
          if (HARDCODED_RE.test(text) && !PREAMBLE_SKIP_RE.test(text)) {
            violations.push(`${relPath}:${lineNum}: ${text.trim()}`);
          }
        }
      }
    }
  }

  return { violations, perDirCounts };
}

test('no hardcoded $HOME gsd-tools.cjs in bash blocks of agents/, commands/, and gsd-core/references/', () => {
  const { violations } = scanAll();
  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} hardcoded invocation(s):\n${violations.join('\n')}`
  );
});

// Fix #4: per-directory floor — each scan dir must exist and contribute >= 1 bash block.
test('each scan dir (agents/, commands/, gsd-core/references/) exists and contains at least one bash block', () => {
  const { perDirCounts } = scanAll();
  const failures = [];
  for (const [dir, { exists, bashBlockCount }] of Object.entries(perDirCounts)) {
    if (!exists) {
      failures.push(`  ${dir}/: directory does not exist`);
    } else if (bashBlockCount < 1) {
      failures.push(`  ${dir}/: exists but contains 0 bash blocks`);
    }
  }
  assert.equal(
    failures.length,
    0,
    `Per-directory bash-block floor failed:\n${failures.join('\n')}\nCheck that each scan dir is non-empty and contains bash fences.`
  );
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-637-workflow-no-hardcoded-home-tool.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-637-workflow-no-hardcoded-home-tool (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #637)
// Workflow .md text IS what the runtime loads and the agent executes, so
// asserting on its shell invocations tests the deployed contract directly.
//
// Repo-wide regression guard for #637 (generalizes the plan-phase-only guard
// from #621): NO workflow .md may invoke gsd-tools via a hardcoded
// `node "$HOME/.../gsd-tools.cjs"` path. On a global/shim-only install with no
// project-local runtime, that path can miss a working install, so the step
// reports the tool "not found" instead of resolving it. Every invocation must
// go through the `gsd_run` launcher (defined once per file in the canonical
// preamble, which resolves RUNTIME_DIR → .claude → PATH → $HOME in order).
//
// The parity test (runtime-launcher-parity) guards the retired $GSD_SDK and
// bare /gsd-tools tokens but NOT this hardcoded-node form — which is exactly
// how it survived across plan-phase.md (#621) and three more files (#637).

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// Hardcoded direct invocation form. Distinct from the canonical preamble, which
// references $HOME only inside a `[ -f "$HOME/..." ]` probe / `GSD_TOOLS=`
// assignment and always invokes `node "$GSD_TOOLS"` — never `node "$HOME/..."`.
const HARDCODED_HOME_INVOCATION = /node\s+"\$HOME\/[^"]*gsd-tools\.cjs"/;

function collectWorkflowMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectWorkflowMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

describe('bug #637: no workflow .md hardcodes a $HOME gsd-tools invocation', () => {
  test('every gsd-core/workflows/**/*.md resolves gsd-tools via gsd_run, not a hardcoded $HOME path', () => {
    const files = collectWorkflowMarkdown(WORKFLOWS_DIR);
    assert.ok(files.length > 0, 'expected workflow markdown files to exist');

    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (HARDCODED_HOME_INVOCATION.test(line)) {
          offenders.push(`${path.relative(WORKFLOWS_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepStrictEqual(
      offenders,
      [],
      'Workflow files must invoke gsd-tools via the resolved `gsd_run` launcher, ' +
        'not a hardcoded `node "$HOME/.../gsd-tools.cjs"` path. Offenders:\n' +
        offenders.join('\n'),
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1520-workflow-mktemp-suffix-final.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1520-workflow-mktemp-suffix-final (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (#1520)
// Workflow .md text IS what the runtime loads and the agent executes, so
// asserting on its shell invocations tests the deployed contract directly.
//
// Repo-wide regression guard for #1520: NO workflow .md may invoke `mktemp`
// with a template whose `XXXXXX` run is followed by a filename suffix
// (e.g. `…-XXXXXX.json`, `…-XXXXXX.md`). BSD/macOS `mktemp` only substitutes
// the `X` run when it is the FINAL path component; a trailing suffix yields a
// literal, non-randomized path, so concurrent workflow runs collide on the same
// temp file (one run overwriting or consuming another's). The portable fix is
// `mktemp …-XXXXXX` (suffix-less) then `mv` to add the extension.
//
// This is a copy-paste-prone shell idiom — the same defect first shipped across
// five workflows before #1520 — so a prose guard is the right lock-out, mirroring
// the bug-637 hardcoded-$HOME workflow scan.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// Match `mktemp <token>` where, within the single whitespace-delimited template
// token, a maximal run of 3+ `X` is immediately followed by a filename
// character (`.`, alnum, `-`, `_`) — i.e. a suffix the BSD/macOS substitution
// can't reach.
//   - `\s+`            requires an argument (bare `mktemp` is fine — path-final
//                      is N/A — and prose like "mktemp only randomizes XXXXXX"
//                      is excluded because the X-run is in a later token).
//   - `["']?\S*?`      walks within the one quoted/unquoted template token.
//   - `X{3,}(?!X)`     anchors on the WHOLE X-run (so `XXXXXX)` does not match
//                      via a sub-run leaving a trailing `X`).
//   - `[.A-Za-z0-9_-]` the offending suffix char. A legitimate path-final form
//                      ends the token with `"`, `'`, whitespace, or `)`, none of
//                      which are in this class.
const SUFFIXED_MKTEMP_TEMPLATE = /mktemp\s+["']?\S*?X{3,}(?!X)[.A-Za-z0-9_-]/;

function collectWorkflowMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectWorkflowMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

describe('#1520: workflow mktemp templates keep XXXXXX path-final', () => {
  test('no gsd-core/workflows/**/*.md calls mktemp with a suffix after the XXXXXX run', () => {
    const files = collectWorkflowMarkdown(WORKFLOWS_DIR);
    assert.ok(files.length > 0, 'expected workflow markdown files to exist');

    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (SUFFIXED_MKTEMP_TEMPLATE.test(line)) {
          offenders.push(`${path.relative(WORKFLOWS_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepStrictEqual(
      offenders,
      [],
      'Workflow mktemp templates must keep XXXXXX as the final path component ' +
        '(create suffix-less, then `mv` to add the extension) so BSD/macOS ' +
        'randomizes the path. Offenders:\n' +
        offenders.join('\n'),
    );
  });
});
  });
}
