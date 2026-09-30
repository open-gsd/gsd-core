'use strict';

/**
 * #5004 — gsd-verifier must define gsd_run in every mode.
 *
 * Re-verification mode skips Step 1, so a resolver that lives only in Step 1
 * leaves Steps 4/5 with no gsd_run and the agent falls back to a disk-wide
 * `find /`. The resolver include must sit in a mode-independent preamble that
 * precedes Step 0.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENT = path.join(__dirname, '..', 'agents', 'gsd-verifier.md');
const RESOLVER_REF = 'references/gsd-run-resolver.md';

function readAgent() {
  return fs.readFileSync(AGENT, 'utf8').replace(/\r\n/g, '\n');
}

function sectionBody(content, headingPrefix) {
  const start = content.indexOf(headingPrefix);
  assert.ok(start >= 0, `heading "${headingPrefix}" must exist`);
  const next = content.indexOf('\n## ', start + headingPrefix.length);
  return content.slice(start, next === -1 ? content.length : next);
}

describe('gsd-verifier defines gsd_run in every mode (#5004)', () => {
  test('resolver include is defined before Step 0 so every mode has gsd_run', () => {
    const content = readAgent();
    const includeIdx = content.indexOf(RESOLVER_REF);
    const step0Idx = content.indexOf('## Step 0:');
    assert.ok(includeIdx >= 0, 'agent must include the shared resolver reference');
    assert.ok(step0Idx >= 0, 'Step 0 heading must exist');
    assert.ok(includeIdx < step0Idx, 'resolver include must precede Step 0 (re-verification skips Step 1)');
  });

  test('exactly one resolver include', () => {
    const content = readAgent();
    assert.equal(content.split(RESOLVER_REF).length - 1, 1);
  });

  test('Step 1 does not carry the resolver', () => {
    const step1 = sectionBody(readAgent(), '## Step 1:');
    assert.ok(!step1.includes(RESOLVER_REF), 'Step 1 is initial-mode only and must not be the resolver definition site');
  });

  test('no gsd_run call precedes the resolver', () => {
    const content = readAgent();
    const includeIdx = content.indexOf(RESOLVER_REF);
    const firstUse = content.search(/\bgsd_run\s+(query|run-with-timeout|loop)\b/);
    assert.ok(firstUse > includeIdx, 'first gsd_run invocation must come after the resolver include');
  });

  test('preamble forbids filesystem search and requires the resolver per Bash call', () => {
    const pre = sectionBody(readAgent(), '## Resolver Bootstrap');
    assert.ok(pre.includes(RESOLVER_REF), 'preamble must hold the resolver include');
    assert.match(pre, /every Bash call/i);
    assert.match(pre, /never search the filesystem/i);
    assert.ok(pre.includes('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/gsd-tools.cjs'));
  });
});
