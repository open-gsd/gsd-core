'use strict';
/**
 * Shared helpers for the namespace nested-skill install-layout tests (#69).
 *
 * Single source of truth for the concrete-skill → namespace-router map and the
 * nested SKILL.md path layout. The map is DERIVED at require-time by parsing
 * each commands/gsd/ns-*.md router's `requires:` frontmatter list with the
 * production parser (install-profiles.parseRequires) — never hand-maintained.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parseRequires } = require('../../gsd-core/bin/lib/install-profiles.cjs');

const COMMANDS_GSD = path.join(__dirname, '..', '..', 'commands', 'gsd');

// Router stems (ns-*.md basenames), discovered from disk and sorted.
const ROUTER_STEMS = fs
  .readdirSync(COMMANDS_GSD)
  .filter((f) => f.startsWith('ns-') && f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort();

/**
 * Read a router's `requires:` child list from commands/gsd/<routerStem>.md
 * using the production frontmatter parser.
 */
function routerChildren(routerStem) {
  const srcFile = path.join(COMMANDS_GSD, `${routerStem}.md`);
  return parseRequires(fs.readFileSync(srcFile, 'utf8'));
}

// concrete-skill stem -> router stem (e.g. 'plan-phase' -> 'ns-workflow').
// A few skills are intentionally multi-owner (e.g. 'spec-phase' is required by
// both ns-ideate and ns-workflow). ROUTER_STEMS is sorted, so the
// alphabetically-last owner wins — which reproduces the prior hand-maintained
// maps (spec-phase -> ns-workflow). The enh-2792 router-completeness tests
// guard the requires: lists themselves.
const CHILD_ROUTER = {};
for (const routerStem of ROUTER_STEMS) {
  for (const child of routerChildren(routerStem)) {
    CHILD_ROUTER[child] = routerStem;
  }
}

/**
 * Nested SKILL.md path for a concrete skill stem:
 *   <skillsRoot>/<prefix><router>/skills/<stem>/SKILL.md
 * prefix is '' for runtimes that nest under a skills/gsd parent dir (hermes),
 * or 'gsd-' for flat-prefixed runtimes (claude, cline, qwen, …).
 */
function nestedSkillPath(skillsRoot, prefix, stem) {
  const router = CHILD_ROUTER[stem];
  if (!router) throw new Error(`No router mapping for stem: ${stem}`);
  return path.join(skillsRoot, prefix + router, 'skills', stem, 'SKILL.md');
}

module.exports = {
  COMMANDS_GSD,
  ROUTER_STEMS,
  CHILD_ROUTER,
  routerChildren,
  nestedSkillPath,
  parseRequires,
};
