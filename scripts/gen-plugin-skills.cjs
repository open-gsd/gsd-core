#!/usr/bin/env node
'use strict';

/**
 * gen-plugin-skills.cjs — generates skills/gsd-<stem>/SKILL.md from
 * commands/gsd/*.md using convertClaudeCommandToClaudeSkill.
 *
 * Usage:
 *   node scripts/gen-plugin-skills.cjs              # print summary to stdout
 *   node scripts/gen-plugin-skills.cjs --write      # write skills/ dir
 *   node scripts/gen-plugin-skills.cjs --check      # exit 1 if committed skills/ is stale
 *
 * #1596 Phase B-provide. The Claude Code plugin contract discovers skills from
 * a skills/ directory (plugins-reference). GSD's source-of-truth commands live
 * in commands/gsd/*.md (command frontmatter); this script converts each to
 * skill format using the same convertClaudeCommandToClaudeSkill the file-copy
 * installer uses, producing a build-generated skills/ dir that ships in the
 * npm package and serves plugin-only installs.
 *
 * Depends on: gsd-core/bin/lib/runtime-artifact-conversion.cjs (compiled from
 * src/runtime-artifact-conversion.cts by `npm run build:lib`). Must run AFTER
 * build:lib in the build chain.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');
const SKILLS_DIR = path.join(ROOT, 'skills');
const CONVERSION_MODULE = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-conversion.cjs');
const PREFIX = 'gsd-';
const RUNTIME = 'claude';

function generateSkills(conversion) {
  const cmdNames = conversion.readGsdCommandNames();
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  const results = [];
  for (const file of files) {
    const stem = file.slice(0, -3);
    const skillName = PREFIX + stem;
    const src = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
    const converted = conversion.convertClaudeCommandToClaudeSkill(src, skillName, RUNTIME, cmdNames, true);
    results.push({ skillName, content: converted });
  }
  return results;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const WRITE = args.has('--write');
  const CHECK = args.has('--check');

  if (!fs.existsSync(CONVERSION_MODULE)) {
    throw new ExitError(
      1,
      `gen-plugin-skills: ${path.relative(ROOT, CONVERSION_MODULE)} not found.\n` +
      'Run `npm run build:lib` first (this script depends on the compiled converter).'
    );
  }
  const conversion = require(CONVERSION_MODULE);
  const results = generateSkills(conversion);

  if (WRITE) {
    fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    for (const { skillName, content } of results) {
      const skillDir = path.join(SKILLS_DIR, skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    }
    process.stdout.write(`gen-plugin-skills: wrote ${results.length} skills to ${path.relative(ROOT, SKILLS_DIR)}/\n`);
    return 0;
  }

  if (CHECK) {
    if (!fs.existsSync(SKILLS_DIR)) {
      throw new ExitError(1, 'gen-plugin-skills: skills/ missing. Run: npm run gen:plugin-skills -- --write');
    }
    let stale = 0;
    const expectedNames = new Set(results.map(r => r.skillName));
    for (const { skillName, content } of results) {
      const skillMd = path.join(SKILLS_DIR, skillName, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        process.stderr.write(`gen-plugin-skills: missing ${path.relative(ROOT, skillMd)}\n`);
        stale++;
        continue;
      }
      if (fs.readFileSync(skillMd, 'utf8') !== content) {
        process.stderr.write(`gen-plugin-skills: stale ${path.relative(ROOT, skillMd)}\n`);
        stale++;
      }
    }
    const existingDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(PREFIX));
    for (const dir of existingDirs) {
      if (!expectedNames.has(dir.name)) {
        process.stderr.write(`gen-plugin-skills: stale (no source) ${path.relative(ROOT, path.join(SKILLS_DIR, dir.name))}\n`);
        stale++;
      }
    }
    if (stale > 0) {
      throw new ExitError(1, `gen-plugin-skills: ${stale} stale skill(s). Run: npm run gen:plugin-skills -- --write`);
    }
    process.stdout.write(`gen-plugin-skills: ${results.length} skills up to date\n`);
    return 0;
  }

  process.stdout.write(
    `gen-plugin-skills: would write ${results.length} skills to ${path.relative(ROOT, SKILLS_DIR)}/\n` +
    '  (use --write to generate, --check to verify staleness)\n'
  );
  return 0;
}

runMain(main);
