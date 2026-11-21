#!/usr/bin/env node
'use strict';

/**
 * run-static-checks.cjs: runs every static check in one process and reports
 * every finding (ADR-6315 item 19, #6337).
 *
 * A static check is a module in scripts/static-checks/ that exports
 *   { name: string, run({ root }) => { file, line, message }[] }
 * and reads repo content. It is not a test: it runs once, here, on Linux, and
 * a red check never hides another, because the runner does not stop at the
 * first failure. A check that throws is a finding of its own (fail closed).
 *
 * Usage: node scripts/run-static-checks.cjs [--only <name>]...
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, 'static-checks');
const DEFAULT_ROOT = path.join(__dirname, '..');

/**
 * The checks in `dir`, sorted by file name. A module that cannot be loaded
 * (a syntax error, a missing dependency) becomes a check whose run reports
 * that, so one broken module never hides the findings of the others. A module
 * that loads but lacks `name` and `run` is a programming error and throws.
 * @returns {{name: string, run: Function}[]}
 */
function loadChecks(dir = DEFAULT_DIR) {
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.cjs'))
    .sort()
    .map((entry) => {
      let check;
      try {
        check = require(path.join(dir, entry));
      } catch (err) {
        const message = `could not load: ${err && err.message ? err.message : String(err)}`;
        return { name: entry, run: () => [{ file: entry, line: 0, message }] };
      }
      if (typeof check.name !== 'string' || typeof check.run !== 'function') {
        throw new TypeError(`static check ${entry} must export { name: string, run: function }`);
      }
      return check;
    });
}

/**
 * Run `checks` against `root`. Returns one result per check, in order.
 * @param {{name: string, run: Function}[]} checks
 * @param {{root?: string}} [options]
 * @returns {{name: string, findings: {file: string, line: number|string, message: string}[]}[]}
 */
function runChecks(checks, { root = DEFAULT_ROOT } = {}) {
  return checks.map((check) => {
    let findings;
    try {
      findings = check.run({ root });
      if (!Array.isArray(findings)) throw new TypeError('run() must return an array of findings');
      const malformed = findings.findIndex((f) => f === null || typeof f !== 'object' || typeof f.message !== 'string');
      if (malformed !== -1) throw new TypeError(`finding ${malformed} must be an object with a string message`);
    } catch (err) {
      findings = [{ file: '(check)', line: 0, message: `the check threw: ${err && err.message ? err.message : String(err)}` }];
    }
    return { name: check.name, findings };
  });
}

/** @returns {string} the report: every finding, then one summary line */
function formatReport(results) {
  const lines = [];
  let total = 0;
  for (const { name, findings } of results) {
    for (const f of findings) {
      total += 1;
      lines.push(`${name}: ${f.file}:${f.line}: ${f.message}`);
    }
  }
  const failed = results.filter((r) => r.findings.length > 0).length;
  lines.push(total === 0
    ? `static checks: ${results.length} passed`
    : `static checks: ${total} finding(s) in ${failed} of ${results.length} check(s)`);
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @param {{dir?: string, root?: string, stdout?: {write: Function}, stderr?: {write: Function}}} [io]
 * @returns {number} the exit code: 0 clean, 1 findings, 2 bad usage
 */
function main(argv = process.argv.slice(2), { dir = DEFAULT_DIR, root = DEFAULT_ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  const only = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--only') {
      stderr.write(`static checks: unknown argument: ${argv[i]}\n`);
      return 2;
    }
    if (!argv[i + 1]) {
      stderr.write('static checks: --only needs a check name\n');
      return 2;
    }
    only.push(argv[++i]);
  }
  let checks = loadChecks(dir);
  if (checks.length === 0) {
    stderr.write(`static checks: no checks found in ${dir}; an empty runner would pass everything\n`);
    return 1;
  }
  if (only.length > 0) {
    const unknown = only.filter((name) => !checks.some((c) => c.name === name));
    if (unknown.length > 0) {
      stderr.write(`static checks: unknown check(s): ${unknown.join(', ')}\n`);
      return 2;
    }
    checks = checks.filter((c) => only.includes(c.name));
  }
  const results = runChecks(checks, { root });
  const report = formatReport(results);
  const failed = results.some((r) => r.findings.length > 0);
  (failed ? stderr : stdout).write(`${report}\n`);
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { loadChecks, runChecks, formatReport, main };
