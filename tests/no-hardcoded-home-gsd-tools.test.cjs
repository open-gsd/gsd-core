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
