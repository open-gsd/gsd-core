'use strict';

/**
 * text-contracts: assertions on the text of runtime-loaded repo files that used to be one test
 * each (ADR-6315 item 19, #6337). A contract is a module in scripts/static-checks/text-contracts/
 * exporting { id, issue?, check(ctx) }; `check` states, through the context:
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
  let assertions = 0;

  // `dead` is a document a slice failed to produce: the failure is already one finding, so its
  // assertions are no-ops (they would only add noise, or pass vacuously on empty text).
  function documentOf(rel, text, dead = false) {
    const doc = {
      rel,
      text,
      has(pattern, why) {
        assertions += 1;
        if (!dead && !found(text, pattern)) report(rel, `${why} (expected ${describePattern(pattern)})`);
        return doc;
      },
      lacks(pattern, why) {
        assertions += 1;
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
        assertions += 1;
        if (dead) return doc;
        const first = text.indexOf(a);
        const second = text.indexOf(b);
        if (first === -1 || second === -1 || !(first < second)) {
          report(rel, `${why} (expected the first ${JSON.stringify(a)} before the first ${JSON.stringify(b)})`);
        }
        return doc;
      },
      followedBy(a, b, why) {
        assertions += 1;
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
    fail(file, message) {
      assertions += 1;
      report(file, message);
    },
    assertionCount: () => assertions,
    doc(rel) {
      const abs = path.resolve(root, ...String(rel).split('/'));
      const inside = path.relative(path.resolve(root), abs);
      let text = '';
      if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || inside.startsWith('..') || path.isAbsolute(inside)) {
        report(String(rel), 'the path is not a repo-relative path inside the repository');
        return documentOf(String(rel), '', true);
      }
      try {
        // A contract reads a regular file the repository owns: a symlink (which could point anywhere)
        // and a directory are refused, and an empty file is a finding (nothing could fail on it).
        const stat = fs.lstatSync(abs);
        if (!stat.isFile()) {
          report(rel, `not a regular file (${stat.isSymbolicLink() ? 'a symlink' : 'not a file'})`);
          return documentOf(rel, '', true);
        }
        text = lf(fs.readFileSync(abs, 'utf8'));
      } catch (err) {
        report(rel, `cannot read the file: ${err.code || err.message}`);
        return documentOf(rel, '', true);
      }
      if (text.trim() === '') {
        report(rel, 'the file is empty');
        return documentOf(rel, '', true);
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
      const ctx = makeContext(root, contract.id, findings);
      const returned = contract.check(ctx);
      // An async check would be dropped: its findings after the first await are never collected.
      if (returned && typeof returned.then === 'function') {
        findings.push({ file: `scripts/static-checks/text-contracts/${contract.id}.cjs`, line: 0, message: `${contract.id}: check must be synchronous` });
      } else if (ctx.assertionCount() === 0) {
        findings.push({ file: `scripts/static-checks/text-contracts/${contract.id}.cjs`, line: 0, message: `${contract.id}: the contract made no assertion` });
      }
    } catch (err) {
      findings.push({ file: `scripts/static-checks/text-contracts/${contract.id}.cjs`, line: 0, message: `${contract.id}: the contract threw: ${err.message}` });
    }
  }
  return findings;
}

module.exports = { name: 'text-contracts', run, loadContracts, MIN_CONTRACTS };
