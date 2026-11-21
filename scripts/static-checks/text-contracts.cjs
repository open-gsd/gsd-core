'use strict';

/**
 * text-contracts: assertions on the text of runtime-loaded repo files (command and workflow
 * markdown, docs) that used to be one `*.test.cjs` each (ADR-6315 item 19, #6337).
 *
 * Each contract is a module in scripts/static-checks/text-contracts/ exporting
 *   { id: string, issue?: string, check(ctx) }
 * and `check` states what a file must and must not say through the context:
 *   ctx.doc(rel)              a document (LF-normalised text) or a finding if the file is missing
 *   doc.has(pattern, why)     pattern (RegExp or string) must appear
 *   doc.lacks(pattern, why)   pattern must not appear
 *   doc.slice(from, to)       the document between two markers (a finding if a marker is absent)
 *   doc.step(name)            the `<step name="…">` … `</step>` body of a workflow
 *   doc.before(a, b, why)     the first a precedes the first b (both appear)
 *   doc.followedBy(a, b, why) b appears somewhere after the first a
 *   ctx.fail(rel, why)        a finding of its own
 * A failed assertion is one finding naming the file and the contract. A contract that throws is
 * a finding too, and a directory with no contracts fails the run, so nothing passes by absence.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_DIR = path.join(__dirname, 'text-contracts');
// The number of shipped contracts. A test pins it to the directory's count, so deleting a contract
// file (or adding one without raising this) fails instead of passing by absence.
const MIN_CONTRACTS = 2;

const lf = (text) => text.replace(/\r\n/g, '\n');
const describePattern = (pattern) => (pattern instanceof RegExp ? String(pattern) : JSON.stringify(pattern));
const found = (text, pattern) => {
  if (!(pattern instanceof RegExp)) return text.includes(pattern);
  pattern.lastIndex = 0; // a /g or /y pattern is stateful across calls
  return pattern.test(text);
};

function makeContext(root, id, findings) {
  const report = (file, message) => findings.push({ file, line: 0, message: `${id}: ${message}` });

  // `dead` is a document a slice failed to produce: the failure is already one finding, so its
  // assertions are no-ops (they would only add noise, or pass vacuously on empty text).
  function documentOf(rel, text, dead = false) {
    const doc = {
      rel,
      text,
      has(pattern, why) {
        if (!dead && !found(text, pattern)) report(rel, `${why} (expected ${describePattern(pattern)})`);
        return doc;
      },
      lacks(pattern, why) {
        if (!dead && found(text, pattern)) report(rel, `${why} (found ${describePattern(pattern)})`);
        return doc;
      },
      slice(from, to) {
        if (dead) return doc;
        const start = text.indexOf(from);
        if (start === -1) {
          report(rel, `marker ${JSON.stringify(from)} not found`);
          return documentOf(`${rel}[missing ${JSON.stringify(from)}]`, '', true);
        }
        const end = to === undefined ? text.length : text.indexOf(to, start);
        if (end === -1) {
          report(rel, `closing marker ${JSON.stringify(to)} not found after ${JSON.stringify(from)}`);
          return documentOf(`${rel}[unterminated ${JSON.stringify(from)}]`, '', true);
        }
        return documentOf(`${rel} [${from}]`, text.slice(start, end));
      },
      step(name) {
        return doc.slice(`<step name="${name}">`, '</step>');
      },
      before(a, b, why) {
        if (dead) return doc;
        const first = text.indexOf(a);
        const second = text.indexOf(b);
        if (first === -1 || second === -1 || !(first < second)) {
          report(rel, `${why} (expected the first ${JSON.stringify(a)} before the first ${JSON.stringify(b)})`);
        }
        return doc;
      },
      followedBy(a, b, why) {
        if (dead) return doc;
        const first = text.indexOf(a);
        const second = first === -1 ? -1 : text.indexOf(b, first);
        if (first === -1 || second === -1 || !(second > first)) {
          report(rel, `${why} (expected ${JSON.stringify(b)} somewhere after ${JSON.stringify(a)})`);
        }
        return doc;
      },
    };
    return doc;
  }

  return {
    fail: report,
    doc(rel) {
      const abs = path.join(root, ...rel.split('/'));
      let text;
      try {
        text = lf(fs.readFileSync(abs, 'utf8'));
      } catch (err) {
        report(rel, `cannot read the file: ${err.code || err.message}`);
        text = '';
      }
      return documentOf(rel, text);
    },
  };
}

/** @returns {{id: string, issue?: string, check: Function}[]} */
function loadContracts(dir = CONTRACT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.cjs'))
    .sort()
    .map((entry) => {
      const contract = require(path.join(dir, entry));
      if (typeof contract.id !== 'string' || typeof contract.check !== 'function') {
        throw new TypeError(`text contract ${entry} must export { id: string, check: function }`);
      }
      return contract;
    });
}

/**
 * @param {{root: string, dir?: string, minContracts?: number, only?: string[]}} ctx `only` limits
 *   the run to the named contract ids (a test that copies the files of two contracts into a
 *   temporary root, not the whole set); an id that matches nothing is a finding.
 * @returns {{file: string, line: number|string, message: string}[]}
 */
function run({ root, dir = CONTRACT_DIR, minContracts = MIN_CONTRACTS, only }) {
  const findings = [];
  let contracts;
  try {
    contracts = loadContracts(dir);
    if (only) {
      const unknown = only.filter((id) => !contracts.some((c) => c.id === id));
      if (unknown.length > 0) throw new Error(`no such contract: ${unknown.join(', ')}`);
      contracts = contracts.filter((c) => only.includes(c.id));
    }
  } catch (err) {
    return [{ file: path.relative(root, dir).split(path.sep).join('/') || '.', line: 0, message: err.message }];
  }
  if (contracts.length < minContracts) {
    findings.push({ file: 'scripts/static-checks/text-contracts', line: 0, message: `expected at least ${minContracts} contract(s), found ${contracts.length}` });
  }
  for (const contract of contracts) {
    try {
      contract.check(makeContext(root, contract.id, findings));
    } catch (err) {
      findings.push({ file: `scripts/static-checks/text-contracts/${contract.id}.cjs`, line: 0, message: `${contract.id}: the contract threw: ${err.message}` });
    }
  }
  return findings;
}

module.exports = { name: 'text-contracts', run, loadContracts, MIN_CONTRACTS };
