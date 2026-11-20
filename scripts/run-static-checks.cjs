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

/** @returns {{name: string, run: Function}[]} the checks in `dir`, sorted by file name */
function loadChecks(dir = DEFAULT_DIR) {
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.cjs'))
    .sort()
    .map((entry) => {
      const check = require(path.join(dir, entry));
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

function main(argv = process.argv.slice(2)) {
  const only = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only' && argv[i + 1]) only.push(argv[++i]);
  }
  let checks = loadChecks();
  if (only.length > 0) {
    const unknown = only.filter((name) => !checks.some((c) => c.name === name));
    if (unknown.length > 0) {
      process.stderr.write(`static checks: unknown check(s): ${unknown.join(', ')}\n`);
      return 2;
    }
    checks = checks.filter((c) => only.includes(c.name));
  }
  const results = runChecks(checks);
  const report = formatReport(results);
  const failed = results.some((r) => r.findings.length > 0);
  (failed ? process.stderr : process.stdout).write(`${report}\n`);
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { loadChecks, runChecks, formatReport, main };
