#!/usr/bin/env node
'use strict';

/**
 * lint-portable-timeout.cjs — ban hardcoded GNU-`timeout` in gsd
 * workflow / agent / reference / command markdown (#2351).
 *
 * ## Why
 *
 * `timeout` and `gtimeout` are GNU coreutils. Stock macOS ships NEITHER
 * (`brew install coreutils` only provides `gtimeout`, and only if installed).
 * A hardcoded `timeout <n> <cmd>` inside an executable workflow snippet exits
 * 127 ("command not found") on such a host, and the gate that runs it — which
 * only distinguishes 0 (pass) / 124 (timeout) / other (fail) — misreports a
 * perfectly good build or test command as a FAILURE (#2351).
 *
 * The portable, coreutils-independent replacement is the
 * `gsd_run run-with-timeout <secs> [--] <cmd…>` verb (gsd-core/bin/gsd-tools.cjs):
 * a Node-based wall-clock cap that keeps GNU `timeout`'s exit-code contract
 * (124 on timeout) on every platform. The resolution lives there ONCE and is
 * reused by every call site instead of a per-file `command -v timeout` probe.
 *
 * This ratchet fails the build if a NEW bare `timeout`/`gtimeout` execution
 * slips into any of these surfaces.
 *
 * ## What PASSES
 *
 * - `gsd_run run-with-timeout 300 -- bash -c "$CMD"` — the approved verb.
 * - `command -v timeout` / `command -v gtimeout` / `which timeout` capability
 *   PROBES — portable: they detect the binary, they do not unconditionally
 *   execute it (see gsd-core/workflows/review.md's `_AGY_KILLER` fallback).
 * - Prose ("timed out after 5 minutes"), config keys
 *   (`workflow.test_gate_timeout`), CI `timeout-minutes:`, the agy
 *   `--print-timeout` flag, `$TIMEOUT`-style variable names — none of which is
 *   a bare timeout command invocation.
 *
 * ## What FAILS
 *
 * A bare `timeout <duration> …` / `gtimeout <duration> …` command invocation,
 * where `<duration>` is a number, a `"$VAR"`, or a `${VAR}` (optionally with a
 * leading `-k`/`-s` option).
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');

// Surfaces whose markdown carries agent-executed bash. Kept broad so the guard
// catches a regression anywhere a workflow snippet could bound a command.
const DEFAULT_ROOTS = ['gsd-core/workflows', 'gsd-core/references', 'agents', 'commands'];

// Capability probes to strip BEFORE testing for an invocation, so a portable
// `command -v timeout` on the same line is never mistaken for a bare execution.
const PROBE_RE = /command\s+-v\s+g?timeout|which\s+g?timeout/g;

// A `timeout`/`gtimeout` token INVOKED AS A COMMAND with a duration argument.
// Anchored to a command position — line start or right after `| & ; ( ` {` — so
// prose ("increase the timeout 30 seconds") and the `--print-timeout` flag / the
// approved `run-with-timeout` verb (no separator before "timeout") never match.
// Between the token and the duration, allow any number of leading options in
// short OR long form (`-k5`, `-k 5`, `--kill-after=5`, `--foreground`,
// `--signal=KILL`). The duration is a digit, `$((arith))`, a `$VAR`, or `${VAR}`.
const EXEC_RE = /(?:^|[|&;(`{])[ \t]*g?timeout[ \t]+(?:-{1,2}[\w-]+(?:=\S+)?[ \t]+)*["']?(?:\$\{?[A-Za-z_]|\$\(\(|\d)/;

/**
 * Locate bare `timeout`/`gtimeout` invocations in a block of text.
 *
 * Pure (no I/O): callers pass the file contents; the caller reads files. Returns
 * structured findings so tests assert on typed values, never on grepped text.
 *
 * @param {string} text  file contents
 * @returns {{ line: number, snippet: string }[]}  findings (empty array = clean)
 */
function findRawTimeoutInvocations(text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].replace(PROBE_RE, '');
    if (EXEC_RE.test(stripped)) findings.push({ line: i + 1, snippet: lines[i].trim() });
  }
  return findings;
}

function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a missing root is not an error — some surfaces are optional
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Scan the given roots (repo-relative) for bare timeout invocations.
 * @param {string[]} roots
 * @returns {{ file: string, line: number, snippet: string }[]}
 */
function scan(roots = DEFAULT_ROOTS) {
  const offenders = [];
  for (const rel of roots) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    for (const file of walkMarkdown(abs)) {
      const findings = findRawTimeoutInvocations(fs.readFileSync(file, 'utf8'));
      for (const f of findings) {
        offenders.push({ file: path.relative(ROOT, file), line: f.line, snippet: f.snippet });
      }
    }
  }
  return offenders;
}

function main() {
  const rootsEnv = process.env.GSD_LINT_PORTABLE_TIMEOUT_ROOTS;
  const roots = rootsEnv ? rootsEnv.split(path.delimiter).filter(Boolean) : DEFAULT_ROOTS;
  const offenders = scan(roots);
  if (offenders.length > 0) {
    const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`).join('\n');
    throw new ExitError(
      1,
      'lint-portable-timeout: hardcoded `timeout`/`gtimeout` is not portable — stock\n' +
        'macOS ships no coreutils, so these exit 127 and misreport a passing command as a\n' +
        'failure. Use `gsd_run run-with-timeout <secs> [--] <cmd…>` instead (#2351):\n' +
        detail,
    );
  }
  console.log(`ok lint-portable-timeout: no hardcoded timeout invocations in ${roots.length} root(s)`);
}

module.exports = { findRawTimeoutInvocations, scan, DEFAULT_ROOTS };

if (require.main === module) runMain(main);
