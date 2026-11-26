/**
 * Project Skills Budget rule (#5249, direction 2 of #4649): W033 names each project skill that defeats the scoped
 * read in `gsd-core/references/project-skills-discovery.md`, which opens a whole `SKILL.md` only when its
 * `description` fits the task, or when it has none. One finding per cause: (1) no non-empty string frontmatter
 * `description`; (2) more than 500 lines, the Agent Skills specification's limit (a fixed constant, not a config key).
 * It checks `.claude/skills` and `.agents/skills` under `snapshot.cwd`, names the root in every finding, and skips
 * GSD's own `gsd-*` directories. Advisory like W028/W032: WARNING, ADVISE, never repairable, exit code unchanged.
 * `SKILL.md` is read only through `capabilityLedger.readSkillFile` (#5121: a regular file of at most 256 KiB, else
 * null); any other failure degrades to no finding for that skill or root. At most ROOT_ENTRY_LIMIT entries per root
 * are scanned, and a directory name outside SAFE_SKILL_DIR is skipped so a hostile name never reaches a finding.
 * Design: .gsd/phase/feat-5249-health-project-skills-budget/40-design.md
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5249 type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');
type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5249 health-diagnostic-types.cjs is an export= CommonJS module
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
type Rule = healthDiagnosticMod.Rule;
type Diagnostic = healthDiagnosticMod.Diagnostic;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5249 capability-ledger.cjs is an export= CommonJS module
import capabilityLedger = require('../capability-ledger.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5249 frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('../frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;

/** The Agent Skills specification's limit for a main `SKILL.md`: "Keep your main SKILL.md under 500 lines". */
const SKILL_LINE_LIMIT = 500;

/** The project skill roots `project-skills-discovery.md` reads, in the posix form a finding names. */
const SKILL_ROOTS: readonly string[] = ['.claude/skills', '.agents/skills'];

/** A root holds a handful of skills; bound the directory scan the way W032 bounds its skills-dir scan. */
const ROOT_ENTRY_LIMIT = 200;

/** Skill directory names that may be rendered into a finding (the Agent Skills spec's name charset, case-lenient). */
const SAFE_SKILL_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** GSD's own skill directories (installed into `.claude/skills/` by a local install) are not the project's skills. */
const GSD_OWN_PREFIX = 'gsd-';

/**
 * Lines in `content`: newline-terminated or final-unterminated segments. A final newline ends the last line rather
 * than adding one, and CR is not a line break, so LF, CRLF and a missing final newline agree.
 */
function lineCount(content: string): number {
  if (content.length === 0) return 0;
  let newlines = 0;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) newlines += 1;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

/** True when the frontmatter carries a `description` that is a non-blank string (the spec requires a string). */
function hasDescription(content: string): boolean {
  const description = (extractFrontmatter(content) as Record<string, unknown>)['description'];
  return typeof description === 'string' && description.trim().length > 0;
}

function skillDirNames(rootPath: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!SAFE_SKILL_DIR.test(entry.name) || entry.name.startsWith(GSD_OWN_PREFIX)) continue;
    // A symlinked skill directory is followed (the discovery agent follows it); anything else that is not a
    // directory is not a skill.
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(rootPath, entry.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) names.push(entry.name);
  }
  return names.sort().slice(0, ROOT_ENTRY_LIMIT);
}

function readSkillOrNull(file: string): string | null {
  try {
    return capabilityLedger.readSkillFile(file);
  } catch {
    // An unreadable file (permissions, IO) is no finding, never a thrown exception that would break /gsd-health.
    return null;
  }
}

function checkProjectSkillsBudget(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const root of SKILL_ROOTS) {
    const rootPath = path.join(snapshot.cwd, ...root.split('/'));
    for (const name of skillDirNames(rootPath)) {
      const content = readSkillOrNull(path.join(rootPath, name, 'SKILL.md'));
      if (content === null) continue;
      const skillPath = `${root}/${name}/SKILL.md`;

      if (!hasDescription(content)) {
        diagnostics.push({
          code: 'W033',
          severity: SEVERITY.WARNING,
          message:
            `${skillPath} has no frontmatter description; project-skills discovery reads a skill with no ` +
            'description in full on every agent spawn',
          remedy: adviseRemedy(
            `Add a frontmatter description to ${skillPath} that says what the skill does and when to use it, so discovery opens the file only when the task fits`,
          ),
        });
      }

      const lines = lineCount(content);
      if (lines > SKILL_LINE_LIMIT) {
        diagnostics.push({
          code: 'W033',
          severity: SEVERITY.WARNING,
          message:
            `${skillPath} is ${lines} lines, more than the ${SKILL_LINE_LIMIT}-line limit of the Agent Skills specification; ` +
            'project-skills discovery loads all of it whenever the skill is relevant',
          remedy: adviseRemedy(
            `Move detailed reference material from ${skillPath} into files under the skill's references/ directory and keep SKILL.md under ${SKILL_LINE_LIMIT} lines`,
          ),
        });
      }
    }
  }
  return diagnostics;
}

const RULES: Rule[] = [
  {
    code: 'W033',
    severity: SEVERITY.WARNING,
    description: `A project skill has no frontmatter description or a SKILL.md over ${SKILL_LINE_LIMIT} lines, so project-skills discovery reads it in full`,
    repairable: false,
    check: checkProjectSkillsBudget,
  },
];

export = { RULES };
