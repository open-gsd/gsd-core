'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { escapeRegex } = require('../../gsd-core/bin/lib/pattern.cjs');

/**
 * #5561: pure pieces of the Pi parity matrix. A "surface" is one unit a Claude install ships
 * (command, workflow, agent role, hook). Each must be reachable on Pi or carry a recorded
 * disposition; a disposition that names a surface Claude no longer ships is stale. The matrix
 * test feeds real installed trees through these functions, and feeds synthetic trees to prove
 * they report an undisposed surface.
 */

/**
 * Workflows that Claude reaches and Pi does not, by path relative to gsd-core/workflows, with the reason.
 * `debug.md` is reached only through `/gsd-debug` and `gsd-debug-session-manager`, and the Pi
 * skill for `/gsd-debug` is the unsupported stub (`PI_UNSUPPORTED_SKILLS`).
 */
const WORKFLOW_DISPOSITIONS = Object.freeze({
  'debug.md': 'only /skill:gsd-debug runs it, and that skill is unsupported on Pi: needs nested dispatch; Pi dispatch is flat',
});

/**
 * @param {Iterable<string>} claude surface names Claude ships
 * @param {Iterable<string>} pi surface names present on Pi
 * @param {Record<string, string>} dispositions surface name -> reason it is absent on Pi
 * @returns {{ undisposed: string[], stale: string[] }}
 *   undisposed: shipped by Claude, absent on Pi, no disposition.
 *   stale: has a disposition but Claude does not ship it, or Pi has it after all.
 */
function diffSurface(claude, pi, dispositions) {
  const claudeSet = new Set(claude);
  const piSet = new Set(pi);
  const undisposed = [...claudeSet].filter((n) => !piSet.has(n) && !Object.prototype.hasOwnProperty.call(dispositions, n));
  const stale = Object.keys(dispositions).filter((n) => !claudeSet.has(n) || piSet.has(n));
  return { undisposed: undisposed.sort(), stale: stale.sort() };
}

/**
 * Workflow files named by `text`. This over-approximates reachability: any mention of a name
 * counts, including prose and a role whose own skill is unsupported on Pi.
 * A name matches only when it is not the tail of a longer
 * file name, so `plan-phase.md` is not found inside `ultraplan-phase.md`.
 * @param {string} text
 * @param {Iterable<string>} names
 */
function namedWorkflows(text, names) {
  const found = new Set();
  for (const name of names) {
    if (new RegExp(`(?<![\\w-])${escapeRegex(name)}`).test(text)) found.add(name);
  }
  return found;
}

/**
 * Every workflow reachable from the root texts, following workflow-to-workflow references.
 * @param {Iterable<string>} rootTexts command bodies and role prompts
 * @param {string[]} names all workflow file names
 * @param {(name: string) => string} readWorkflow text of one workflow
 * @returns {Set<string>}
 */
function reachableWorkflows(rootTexts, names, readWorkflow) {
  const reached = new Set();
  const queue = [];
  const visit = (text) => {
    for (const name of namedWorkflows(text, names)) {
      if (!reached.has(name)) {
        reached.add(name);
        queue.push(name);
      }
    }
  };
  for (const text of rootTexts) visit(text);
  while (queue.length > 0) visit(readWorkflow(queue.pop()));
  return reached;
}

/**
 * The (event, hook file) pairs a `hooks.json` registers.
 * @param {{ hooks: Record<string, { hooks?: { command?: string }[] }[]> }} manifest
 * @returns {{ event: string, file: string }[]}
 */
function registeredHooks(manifest) {
  const pairs = [];
  for (const [event, groups] of Object.entries(manifest.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        const match = /\/hooks\/([\w.-]+)["']?/.exec(hook.command || '');
        if (match) pairs.push({ event, file: match[1] });
      }
    }
  }
  return pairs;
}

/**
 * Workflow markdown files under `dir`, recursively, as forward-slash paths relative to `dir`
 * (`plan-phase/steps/x.md`), sorted. Directories are descended, never read as files.
 * @param {string} dir
 * @returns {string[]}
 */
function listWorkflows(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(next);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(next);
    }
  };
  walk('');
  return out.sort();
}

module.exports = { listWorkflows, WORKFLOW_DISPOSITIONS, diffSurface, namedWorkflows, reachableWorkflows, registeredHooks };
