'use strict';

/**
 * #6205 — a shipped reference must not present a closed-not-planned upstream tracker as pending.
 *
 * The advisor section of gsd-core/references/model-profiles.md said per-agent advisor control "is tracked upstream at
 * anthropics/claude-code#73072" after that issue had been closed as not planned, so readers waited for a switch that is
 * not coming. The ledger below names each upstream tracker the shipped docs link that is known to be closed without a
 * fix; a doc line that links one must say it was closed as not planned.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// repo#number → how the upstream issue ended (checked against GitHub when added)
const CLOSED_NOT_PLANNED = {
  'anthropics/claude-code#73072': 'closed as not planned on 2026-09-15 (per-subagent advisor field)',
};

const SCANNED_ROOTS = ['gsd-core/references', 'gsd-core/workflows', 'docs/guides', 'docs/how-to', 'docs/reference', 'docs/explanation'];
const SKIPPED = (file) => file.split(path.sep).includes('node_modules');

function markdownFiles(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  const out = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (SKIPPED(rel)) continue;
    if (entry.isDirectory()) out.push(...markdownFiles(rel));
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** Lines of `text` that link a ledgered tracker without saying it is closed. */
function pendingClaims(text, ledger = CLOSED_NOT_PLANNED) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const key of Object.keys(ledger)) {
      const [repo, number] = key.split('#');
      const linksIt = [`github.com/${repo}/issues/${number}`, `${repo}#${number}`].some((ref) => {
        const at = line.indexOf(ref);
        return at !== -1 && !/\d/.test(line[at + ref.length] ?? '');
      });
      if (linksIt && !/\bclosed as not planned\b/i.test(line)) found.push({ line: index + 1, key });
    }
  });
  return found;
}

describe('shipped docs do not present a closed-not-planned upstream tracker as pending (#6205)', () => {
  test('no scanned doc links a ledgered tracker without saying it is closed', () => {
    const offenders = [];
    for (const dir of SCANNED_ROOTS) {
      for (const file of markdownFiles(dir)) {
        for (const claim of pendingClaims(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
          offenders.push(`${file}:${claim.line} links ${claim.key} (${CLOSED_NOT_PLANNED[claim.key]}) without saying it is closed`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('the detector flags a pending claim and accepts a closed one, and not a bare `closed` or `not closed`', () => {
    const url = 'https://github.com/anthropics/claude-code/issues/73072';
    assert.equal(pendingClaims(`Per-agent control is tracked upstream at [x](${url}); until it lands, pick one.`).length, 1);
    assert.equal(pendingClaims('tracked upstream at anthropics/claude-code#73072').length, 1);
    assert.equal(pendingClaims(`Requested upstream ([x](${url})), but closed as not planned, so none is coming.`).length, 0);
    assert.equal(pendingClaims(`Still tracked upstream, not closed: ${url}`).length, 1);
    assert.equal(pendingClaims(`Requested upstream, now closed: ${url}`).length, 1, 'closed alone does not say the request was declined');
    assert.equal(pendingClaims('A line that links no tracker.').length, 0);
    assert.equal(pendingClaims(`${url}1`).length, 0, 'a longer issue number is a different issue');
    assert.equal(pendingClaims(`${url}.`).length, 1, 'a trailing period still names the tracker');
  });

  test('the ledger names at least one tracker and every entry is repo#number', () => {
    const keys = Object.keys(CLOSED_NOT_PLANNED);
    assert.ok(keys.length > 0);
    for (const key of keys) assert.match(key, /^[\w.-]+\/[\w.-]+#\d+$/);
  });
});
