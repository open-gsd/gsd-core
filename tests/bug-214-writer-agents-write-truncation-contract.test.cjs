// allow-test-rule: source-text-is-the-product
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Every agent that writes a large file in a single Write call must carry the
// same truncation-resilient write contract added for bug #214. OpenCode shares
// OUTPUT_TOKEN_MAX=32000 with the thinking budget (upstream opencode#18108), so
// an oversized single `write` tool call is truncated mid-payload, yielding
// `JSON Parse error: Expected '}'`, and OpenCode then doom-loops. gsd-phase-researcher
// is locked by its own bug-214 test; this locks the other large-file writers.
const WRITER_AGENTS = [
  'gsd-research-synthesizer',
  'gsd-planner',
  'gsd-executor',
  'gsd-domain-researcher',
  'gsd-project-researcher',
  'gsd-ui-researcher',
];

function readAgent(name) {
  return fs.readFileSync(path.join(REPO_ROOT, 'agents', `${name}.md`), 'utf8');
}

describe('bug #214: large-file writer agents must survive write-tool truncation', () => {
  for (const name of WRITER_AGENTS) {
    describe(name, () => {
      const prompt = readAgent(name);

      test('keeps single-Write as the default path', () => {
        assert.match(
          prompt,
          /in a single `Write` call/i,
          `${name}: must keep single-Write as the default (no regression for non-truncating runtimes).`
        );
      });

      test('names the truncation failure mode', () => {
        assert.match(prompt, /truncat/i, `${name}: must name the truncation failure mode.`);
      });

      test('instructs incremental construction on large files', () => {
        assert.match(
          prompt,
          /incrementa/i,
          `${name}: must instruct incremental construction on large files.`
        );
      });

      test('defines the continuation sentinel', () => {
        assert.match(
          prompt,
          /<!-- gsd:write-continue -->/,
          `${name}: must define the continuation sentinel for incremental writes.`
        );
      });

      test('forbids identical retry of the oversized write (doom-loop guard)', () => {
        assert.match(
          prompt,
          /do NOT retry the same oversized call/i,
          `${name}: must forbid identical retry of the oversized write.`
        );
      });

      test('requires Read before Edit', () => {
        assert.match(
          prompt,
          /`Read` the file, then `Edit`/i,
          `${name}: must require Read before Edit (OpenCode edit requires a prior Read).`
        );
      });

      test('instructs removing the sentinel on the final section', () => {
        assert.match(
          prompt,
          /no trailing sentinel/i,
          `${name}: must instruct removing the sentinel on the final section.`
        );
      });

      test('forbids silent fallback to returning content', () => {
        assert.match(
          prompt,
          /do NOT silently fall back to returning content/i,
          `${name}: must forbid silent fallback to returning content.`
        );
      });
    });
  }
});
