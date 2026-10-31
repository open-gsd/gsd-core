// gsd-hook-version: {{GSD_VERSION}}
// Project exemptions for the secret-read guard (#4432).
//
// A project lists repo-relative files under `hooks.secret_read_exempt` in the
// ROOT `.planning/config.json`. A listed file stays readable only when it is
// BOTH a regular file in the working tree (lstat, so a symlink never counts)
// AND a regular blob (100644/100755) in the commit HEAD names. Config alone is
// not the key: an agent that can write the config must not be able to unlock a
// real secret that was never committed.
//
// The committed-file check reads `.git` directly (./git-head-tree.js): no
// subprocess and no timer, so the verdict depends only on the repository's
// bytes. Every failure means "not exempt"; nothing in this module throws.
//
// Standalone on purpose: hooks are installed as loose files and cannot require
// `src/`. The entry rules are duplicated in `src/config.cts`
// (`normalizeSecretReadExemptEntry`, used by config-set); tests/
// secret-read-exemptions.test.cjs drives one corpus through both so they
// cannot diverge.

'use strict';

const fs = require('fs');
const path = require('path');
const { headTreeEntry } = require('./git-head-tree.js');

const REGULAR_BLOB_MODES = new Set(['100644', '100755']);

/**
 * Normalize one config entry to a POSIX repo-relative file path, or null.
 * `\` becomes `/` unconditionally; nothing is trimmed (whitespace is part of a
 * name). Rejected: non-strings, absolute and UNC paths, drive prefixes, NUL, any
 * `..` segment, a directory (trailing `/`), and `.`.
 * @param {unknown} entry
 * @returns {string | null}
 */
function normalizeExemptEntry(entry) {
  if (typeof entry !== 'string') return null;
  let s = entry.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s === '' || s === '.') return null;
  if (s.startsWith('/') || s.endsWith('/')) return null;
  if (/^[A-Za-z]:/.test(s)) return null;
  if (s.includes('\0')) return null;
  if (s.split('/').includes('..')) return null;
  return s;
}

/**
 * The normalized, de-duplicated `hooks.secret_read_exempt` entries of
 * `<root>/.planning/config.json`. Anything unreadable or malformed yields [].
 * @param {string} root
 * @param {{ readFile?: (file: string, encoding: string) => string }} [deps]
 * @returns {string[]}
 */
function readExemptEntries(root, { readFile = fs.readFileSync } = {}) {
  let config;
  try {
    config = JSON.parse(readFile(path.join(root, '.planning', 'config.json'), 'utf8'));
  } catch {
    return [];
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return [];
  const hooks = config.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const list = hooks.secret_read_exempt;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const entry = normalizeExemptEntry(raw);
    if (entry !== null && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * True when HEAD holds `entry` (relative to `root`) as a regular blob.
 * @param {string} root
 * @param {string} entry
 * @returns {boolean}
 */
function isCommittedBlob(root, entry) {
  const found = headTreeEntry(root, entry);
  return found !== null && REGULAR_BLOB_MODES.has(found.mode);
}

/**
 * True when `abs` is a regular file (lstat: a symlink is not).
 * @param {string} abs
 * @returns {boolean}
 */
function isRegularFile(abs) {
  try {
    return fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Build the per-invocation checker. Pure apart from the two injected probes,
 * which are memoized per entry. A probe that throws means "not exempt".
 * @returns {(token: unknown) => boolean}
 */
function createExemptionChecker({
  root,
  entries,
  allowRelative = false,
  platform = process.platform,
  isCommittedBlob: committed = isCommittedBlob,
  isRegularFile: regular = isRegularFile,
}) {
  const fold = platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const targets = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry === 'string' && entry !== '') targets.push({ entry, target: fold(path.resolve(root, entry)) });
  }
  const verdicts = new Map();

  function verdictFor(entry) {
    if (verdicts.has(entry)) return verdicts.get(entry);
    let ok = false;
    try {
      ok = regular(path.resolve(root, entry)) === true && committed(root, entry) === true;
    } catch {
      ok = false;
    }
    verdicts.set(entry, ok);
    return ok;
  }

  return function isExempt(token) {
    if (typeof token !== 'string' || token === '' || targets.length === 0) return false;
    if (!allowRelative && !path.isAbsolute(token)) return false;
    const resolved = fold(path.resolve(root, token));
    for (const { entry, target } of targets) {
      if (resolved === target) return verdictFor(entry);
    }
    return false;
  };
}

module.exports = {
  normalizeExemptEntry,
  readExemptEntries,
  createExemptionChecker,
  isCommittedBlob,
  isRegularFile,
};
