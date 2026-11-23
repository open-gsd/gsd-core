'use strict';

/**
 * text-contracts: assertions on the text of runtime-loaded repo files that used to be one test
 * each (ADR-6315 item 19, #6337). A contract is a module in scripts/static-checks/text-contracts/
 * exporting { id, issue?, check(ctx) }; `check` states, through the context:
 *   ctx.doc(rel)              a document (LF-normalised text) or a finding if the file is missing
 *   ctx.docs([rel…])          one document that is the union of several files (each must load)
 *   ctx.exists/absent(rel, why)  the file is / is not in the tree
 *   ctx.list(dir, suffix, why)   the sorted repo-relative files under dir ending in suffix (none is a finding)
 *   doc.has/lacks(pattern, why)  pattern (RegExp or string) must / must not appear
 *   doc.slice(from, to)       the document between two markers; `to` may list several, earliest wins
 *   doc.step(name)            the `<step name="…">` … `</step>` body of a workflow
 *   doc.frontmatter()         the closed YAML frontmatter block (a finding if there is none)
 *   doc.before(a, b, why)     the first a precedes the first b; doc.followedBy(a, b, why): b after a
 *   doc.shorterThan(n, why)   the text is under n characters
 *   doc.satisfies(fn, why)    fn(text) returns true, or a string naming the violation (a count, a loop)
 *   ctx.fail(rel, why)        a finding of its own
 * A failed assertion is one finding naming the file and the contract. A contract that throws is
 * a finding too, and a directory with no contracts fails the run, so nothing passes by absence.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_DIR = path.join(__dirname, 'text-contracts');
// The number of shipped contracts. A test pins it to the directory's count, so deleting a contract
// file (or adding one without raising this) fails instead of passing by absence.
const MIN_CONTRACTS = 87;

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
        // Closing markers are searched after the opening one, so an end marker that begins like the
        // start marker (`**If ` … `**If `) ends the slice at the next one, not at the start itself.
        const ends = to === undefined ? [] : [].concat(to);
        if (to !== undefined && (ends.length === 0 || ends.includes(''))) {
          report(rel, `the closing markers of ${JSON.stringify(from)} must be a non-empty list of non-empty markers`);
          return documentOf(`${rel}[bad closing markers ${JSON.stringify(from)}]`, '', true);
        }
        const hits = ends.map((marker) => text.indexOf(marker, start + from.length)).filter((at) => at !== -1);
        if (ends.length > 0 && hits.length === 0) {
          report(rel, `closing marker ${JSON.stringify(to)} not found after ${JSON.stringify(from)}`);
          return documentOf(`${rel}[unterminated ${JSON.stringify(from)}]`, '', true);
        }
        const end = ends.length === 0 ? text.length : Math.min(...hits);
        return documentOf(`${rel} [${from}]`, text.slice(start, end));
      },
      frontmatter() {
        if (dead) return doc;
        // The fence rules (BOM, byte-0 opening fence, whole-line closing fence) have one owner.
        const { locateFrontmatterFence } = require('../../gsd-core/bin/lib/frontmatter-fence.cjs');
        const fence = locateFrontmatterFence(text);
        if (!fence || !fence.closed) {
          report(rel, 'no closed YAML frontmatter block');
          return documentOf(`${rel}[no frontmatter]`, '', true);
        }
        return documentOf(`${rel} [frontmatter]`, text.slice(fence.openEnd, fence.bodyEnd));
      },
      shorterThan(limit, why) {
        assertions += 1;
        if (!dead && !(text.length < limit)) report(rel, `${why} (${text.length} characters, expected fewer than ${limit})`);
        return doc;
      },
      // A computed assertion for what no pattern states (a count, a per-section loop, a number read
      // out of a block). `predicate(text)` returns true to pass, a string naming the violation, or false.
      satisfies(predicate, why) {
        assertions += 1;
        if (dead) return doc;
        const verdict = predicate(text);
        if (verdict !== true) report(rel, typeof verdict === 'string' ? `${why} (${verdict})` : why);
        return doc;
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

  // A repo-relative path inside the repository, or the reason it is not one.
  function locate(rel) {
    const abs = path.resolve(root, ...String(rel).split('/'));
    const inside = path.relative(path.resolve(root), abs);
    if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || inside.startsWith('..') || path.isAbsolute(inside)) {
      return { ok: false, message: 'the path is not a repo-relative path inside the repository' };
    }
    // lstat on the last component does not stop a symlinked directory earlier in the path from
    // redirecting the read out of the tree, so the parent directory is resolved and re-checked.
    // The realpath-resolved containment check has one owner (src/security.cts).
    const parent = path.posix.dirname(String(rel).split(path.sep).join('/'));
    if (parent !== '.') {
      const { tryWithinRoot } = require('../../gsd-core/bin/lib/security.cjs');
      if (tryWithinRoot(parent, root) === null) {
        return { ok: false, message: 'the path resolves outside the repository through a symlinked directory' };
      }
    }
    return { ok: true, abs };
  }

  // The LF text of one file, or `dead` with the finding already reported.
  function load(rel) {
    const at = locate(rel);
    if (!at.ok) {
      report(String(rel), at.message);
      return { rel: String(rel), dead: true };
    }
    let text;
    try {
      // A contract reads a regular file the repository owns: a symlink (which could point anywhere)
      // and a directory are refused, and an empty file is a finding (nothing could fail on it).
      const stat = fs.lstatSync(at.abs);
      if (!stat.isFile()) {
        report(rel, `not a regular file (${stat.isSymbolicLink() ? 'a symlink' : 'not a file'})`);
        return { rel, dead: true };
      }
      text = lf(fs.readFileSync(at.abs, 'utf8'));
    } catch (err) {
      report(rel, `cannot read the file: ${err.code || err.message}`);
      return { rel, dead: true };
    }
    if (text.trim() === '') {
      report(rel, 'the file is empty');
      return { rel, dead: true };
    }
    return { rel, text, dead: false };
  }

  return {
    fail(file, message) {
      assertions += 1;
      report(file, message);
    },
    assertionCount: () => assertions,
    doc(rel) {
      const loaded = load(rel);
      return loaded.dead ? documentOf(loaded.rel, '', true) : documentOf(loaded.rel, loaded.text);
    },
    // One document that is the union of several files (a workflow split across a main file and
    // its step files): every file must load, and an assertion sees their LF text joined by `\n`.
    docs(rels) {
      const list = [].concat(rels);
      if (list.length === 0) {
        report('(no files)', 'docs() needs at least one repo-relative path');
        return documentOf('(no files)', '', true);
      }
      const loaded = list.map(load);
      const label = loaded.map((entry) => entry.rel).join(' + ');
      if (loaded.some((entry) => entry.dead)) return documentOf(label, '', true);
      return documentOf(label, loaded.map((entry) => entry.text).join('\n'));
    },
    // The file is present as a regular file / is absent from the tree.
    exists(rel, why) {
      assertions += 1;
      const at = locate(rel);
      if (!at.ok) return report(String(rel), at.message);
      let stat = null;
      try { stat = fs.lstatSync(at.abs); } catch { /* absent */ }
      if (!stat || !stat.isFile()) report(rel, `${why} (expected a regular file at ${rel})`);
    },
    absent(rel, why) {
      assertions += 1;
      const at = locate(rel);
      if (!at.ok) return report(String(rel), at.message);
      let present = true;
      try { fs.lstatSync(at.abs); } catch (err) { present = err.code !== 'ENOENT'; }
      if (present) report(rel, `${why} (expected no file at ${rel})`);
    },
    // The repo-relative paths (sorted) of the regular files under a directory, recursively, whose name ends with
    // `suffix`; read each with ctx.doc. A directory that is missing, or holds none, is a finding (a scan over nothing
    // would pass). A symlink is not followed.
    list(relDir, suffix, why) {
      assertions += 1;
      const at = locate(relDir);
      if (!at.ok) {
        report(String(relDir), at.message);
        return [];
      }
      const base = String(relDir).split('/').filter(Boolean).join('/');
      // The directory itself is not a symlink: readdir would follow it out of the tree.
      let top = null;
      try { top = fs.lstatSync(at.abs); } catch { /* reported by the walk below */ }
      if (top && !top.isDirectory()) {
        report(base, `${why} (${base} is ${top.isSymbolicLink() ? 'a symlink' : 'not a directory'}, expected a directory)`);
        return [];
      }
      const files = [];
      let unreadable = false;
      const walk = (abs, rel) => {
        let entries;
        try {
          entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch (err) {
          unreadable = true;
          report(rel, `cannot read the directory: ${err.code || err.message}`);
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) walk(path.join(abs, entry.name), `${rel}/${entry.name}`);
          else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(`${rel}/${entry.name}`);
        }
      };
      walk(at.abs, base);
      if (files.length === 0 && !unreadable) report(base, `${why} (no ${suffix} file under ${base})`);
      return files.sort();
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
