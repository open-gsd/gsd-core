/**
 * Project Skills Index rule (#4649, direction 2).
 *
 * One code, W030, flagging a project skill whose SKILL.md costs context on
 * every spawn of the project-skills discovery agents
 * (`gsd-core/references/project-skills-discovery.md`):
 *
 *   - no frontmatter `description`: the discovery's relevance filter needs the
 *     description, so such a SKILL.md is read in full on every spawn;
 *   - more than 500 lines: the Agent Skills specification's guideline for
 *     SKILL.md ("Keep your main SKILL.md under 500 lines. Move detailed
 *     reference material to separate files."). A fixed constant, not a config
 *     key.
 *
 * Reaches OUTSIDE the planning snapshot the same way `install-surface-
 * shadowing.cts` does for W028: `snapshot.cwd` is the project directory, and
 * `buildSkillManifest(cwd)` (`init.cts`) scans the project roots of the skill
 * discovery contract (`docs/skills/discovery-contract.md`). Only
 * `scope: 'project'` entries count; GSD's own `gsd-*` skills (a local install
 * places them in the same roots) are skipped, as the contract's project
 * section does.
 *
 * Advisory: any unexpected failure degrades to `[]`, never a thrown exception
 * that would break `/gsd-health` itself.
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/project-skills-index.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/project-skills-index.cjs
 * (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');
type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
type Rule = healthDiagnosticMod.Rule;
type Diagnostic = healthDiagnosticMod.Diagnostic;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import initMod = require('../init.cjs');
const { buildSkillManifest } = initMod;

import { splitLines } from '../text-lines.cjs';

/** Agent Skills specification guideline for the main SKILL.md. */
const SKILL_MD_LINE_GUIDELINE = 500;

function countLines(content: string): number {
  const lines = splitLines(content);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function checkProjectSkillsIndex(snapshot: PlanningSnapshot): Diagnostic[] {
  let skills: ReturnType<typeof buildSkillManifest>['skills'];
  try {
    skills = buildSkillManifest(snapshot.cwd).skills;
  } catch {
    // Advisory rule: an unscannable skill root degrades to "no finding",
    // never an exception that breaks /gsd-health itself.
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  for (const skill of skills) {
    if (skill.scope !== 'project' || skill.name.startsWith('gsd-')) continue;
    const relPath = `${skill.root}/${skill.file_path}`;
    if (!skill.description) {
      diagnostics.push({
        code: 'W030',
        severity: SEVERITY.WARNING,
        message: `${relPath} has no frontmatter \`description\`, so project-skills discovery reads it in full on every spawn of a discovery agent.`,
        remedy: adviseRemedy(`Add a \`description\` that says what the skill does and when to use it to the frontmatter of ${relPath}`),
      });
    }
    let lineCount: number;
    try {
      lineCount = countLines(fs.readFileSync(path.join(snapshot.cwd, skill.root, skill.file_path), 'utf8'));
    } catch {
      continue; // unreadable since the manifest scan: skip this skill, keep the others
    }
    if (lineCount > SKILL_MD_LINE_GUIDELINE) {
      diagnostics.push({
        code: 'W030',
        severity: SEVERITY.WARNING,
        message: `${relPath} has ${lineCount} lines, above the Agent Skills ${SKILL_MD_LINE_GUIDELINE}-line guideline for SKILL.md; discovery agents read the whole file whenever the skill is relevant.`,
        remedy: adviseRemedy(`Move detailed material from ${relPath} into files it references (for example under references/)`),
      });
    }
  }
  return diagnostics;
}

const RULES: Rule[] = [
  {
    code: 'W030',
    severity: SEVERITY.WARNING,
    description: 'Project skill SKILL.md has no frontmatter description or exceeds the Agent Skills 500-line guideline',
    repairable: false,
    check: checkProjectSkillsIndex,
  },
];

export = { RULES };
