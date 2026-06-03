'use strict';
// allow-test-rule: runtime-contract-is-the-product
// The ship.md verification gate is LLM-executed prose; its routing message text
// IS the user-facing product surface (RULESET.TESTS.no-source-grep.exemption:
// "reserved for tests where the file content IS the product surface ... agent .md").
// The behavioral tests below additionally EXECUTE the gate's own bash extraction
// pipeline (parsed out of ship.md) against fixture reports, so the extraction
// contract is verified, not just asserted as text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const helpers = require('./helpers.cjs');

const SHIP_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');
const ship = fs.readFileSync(SHIP_MD, 'utf8');

const start = ship.indexOf('**Verification passed?**');
const end = ship.indexOf('**Clean working tree?**');
assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate the verification gate block');
const gate = ship.slice(start, end);

// ---- content assertions (the routing message IS the product surface) ----

test('gate captures the status value with a single first-match grep', () => {
  assert.match(gate, /grep -m1 "\^status:"/, 'gate must extract status via grep -m1 "^status:"');
});

test('gate scopes status extraction to the YAML frontmatter only', () => {
  assert.match(gate, /sed -n '\/\^---\$\/,\/\^---\$\/p'/, 'gate must restrict extraction to the frontmatter block');
});

test('gate routes gaps_found to /gsd:plan-phase --gaps', () => {
  assert.match(gate, /gaps_found/);
  assert.match(gate, /\/gsd:plan-phase[^\n]*--gaps/);
});

test('gate routes human_needed to the UAT manual-test step', () => {
  assert.match(gate, /human_needed/);
  assert.match(gate, /UAT\.md/);
});

test('gate routes a missing VERIFICATION.md to re-running execute-phase', () => {
  assert.match(gate, /\/gsd:execute-phase/);
});

test('gate still blocks with PHASE_VERIFICATION_INCOMPLETE', () => {
  assert.match(gate, /PHASE_VERIFICATION_INCOMPLETE/);
});

test('the dead `pass` status arm is gone — only `passed` is accepted', () => {
  assert.doesNotMatch(gate, /status:\s*pass(?!ed)/i, 'no bare `status: pass` arm may remain');
  assert.doesNotMatch(gate, /`pass`\s*\/\s*`passed`/, 'the `pass` / `passed` either-arm must be removed');
  assert.match(gate, /passed/);
});

// ---- behavioral tests: run the gate's OWN bash pipeline against fixtures ----

const bashBlock = (() => {
  // `\r?\n` (not a literal `\n`) so the fence matches on Windows CRLF checkouts;
  // normalize the captured block to LF before handing it to bash.
  const m = gate.match(/```bash\r?\n([\s\S]*?)```/);
  assert.ok(m, 'gate must contain a bash block');
  return m[1].replace(/\r\n/g, '\n');
})();

const hasBash = (() => {
  try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

function runGateExtraction(verificationContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship586-'));
  try {
    if (verificationContents !== null) {
      fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), verificationContents);
    }
    const script = `PHASE_DIR='${dir}'\n${bashBlock}\nprintf '%s' "$STATUS"`;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  } finally {
    helpers.cleanup(dir);
  }
}

const FM = (status) =>
  `---\nphase: 01-demo\nverified: 2026-01-01T00:00:00Z\nstatus: ${status}\nscore: 3/3 must-haves verified\n---\n\n# Verification\n`;

test('extraction yields passed for a passing frontmatter', { skip: !hasBash && 'bash unavailable' }, () => {
  assert.strictEqual(runGateExtraction(FM('passed')), 'passed');
});

test('extraction yields gaps_found / human_needed verbatim', { skip: !hasBash && 'bash unavailable' }, () => {
  assert.strictEqual(runGateExtraction(FM('gaps_found')), 'gaps_found');
  assert.strictEqual(runGateExtraction(FM('human_needed')), 'human_needed');
});

test('REGRESSION: a body `status:` line does not corrupt a passing report (Codex PR #650 finding)', { skip: !hasBash && 'bash unavailable' }, () => {
  const withBodyStatus = FM('passed') +
    '\n## Example\n\n```yaml\nstatus: gaps_found\n```\n\nstatus: human_needed\n';
  assert.strictEqual(runGateExtraction(withBodyStatus), 'passed');
});

test('extraction yields empty when no VERIFICATION.md exists', { skip: !hasBash && 'bash unavailable' }, () => {
  assert.strictEqual(runGateExtraction(null), '');
});
