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
 * #4995: commands/gsd/*.md still instruct bare command-position `gsd-tools
 * <verb>` calls in 4 files (workstreams.md, quick.md, review-backlog.md,
 * config.md), which fail with "command not found" on a shim-only install.
 * That source can't be normalized to `gsd_run` directly the way #2751 did for
 * agents/*.md and gsd-core/workflows/*.md: tests/gsd-tools-path-refs.test.cjs
 * (#1766) pins commands/gsd/workstreams.md to the literal string
 * `gsd-tools query workstream.list`, and bringing commands/ under the #2751
 * guard was tried and reverted for unrelated load-bearing reasons (11ad7881ed
 * / d286e54163). So this generator rewrites bare gsd-tools -> gsd_run in its
 * OWN output — the same shape of fix #725 already established for the Codex
 * conversion pipeline (rewrite the generated artifact, not the shared
 * source) — reusing the exact `gsd_run` resolver preamble #2751 established
 * (scripts/sync-runtime-launcher.cjs's transformFile) rather than inventing a
 * new resolution mechanism.
 *
 * Depends on: gsd-core/bin/lib/runtime-artifact-conversion.cjs (compiled from
 * src/runtime-artifact-conversion.cts by `npm run build:lib`). Must run AFTER
 * build:lib in the build chain.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { transformFile, loadPreamble } = require('./sync-runtime-launcher.cjs');

const ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');
const SKILLS_DIR = path.join(ROOT, 'skills');
const CONVERSION_MODULE = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-conversion.cjs');
const PREFIX = 'gsd-';
const RUNTIME = 'claude';

// #4995: the 4 commands/gsd/*.md stems (census taken by the issue) that carry
// command-position bare `gsd-tools <verb>` calls. Deliberately an explicit
// allowlist, NOT a blanket regex applied to every generated skill: several
// other skills (e.g. gsd-graphify) merely NAME `gsd-tools`/`gsd_run`
// descriptively (prose, "DO NOT use ..." warnings) in ways a command-position
// regex cannot safely tell apart from a real instruction without per-site
// human review -- exactly the ambiguity tests/no-bare-gsd-tools-command-
// position.test.cjs's PROSE_ALLOWLIST exists to resolve by hand for #2751/
// #3809. gsd-graphify also carries 5 deliberately-separate per-block
// preambles (tests/graphify-visualization.test.cjs extracts and runs each
// fenced Step-3 block standalone); running every skill through
// transformFile's "collapse to one preamble per file" behavior would
// reproduce the exact regression d286e54163 already found and reverted for
// commands/gsd/graphify.md. Restricting the rewrite to the 4 files the
// census in #4995 actually names avoids all of that.
const BARE_GSD_TOOLS_STEMS = new Set(['workstreams', 'quick', 'review-backlog', 'config']);

// #4995: command-position bare `gsd-tools` -> `gsd_run` token swap. Mirrors 3
// of the 4 command-position shapes rewriteBareGsdToolsCommandsForCodex
// (src/runtime-artifact-conversion.cts) already covers for the Codex
// pipeline: start-of-line, inside `$( ... )`, and immediately after a
// backtick (inline "Run: `gsd-tools verb args`" prose). Deliberately DROPS
// that function's 4th shape -- a bare, unescaped `|` counted as a shell
// pipe separator -- because a Markdown table row (`| col | gsd-tools verb
// arg |`) also starts a cell with `| gsd-tools`, and none of the 11 sites in
// #4995's census need it: config.md's own routing TABLE names `gsd-tools
// query config-set-model-profile` descriptively in a `|`-delimited cell one
// row above the real operative site, and rewriting that cell too would be a
// change nobody asked for. (`&&`/`;` are kept: two-character or dedicated
// separators, not also a Markdown table delimiter.) Only applied to
// BARE_GSD_TOOLS_STEMS files (see above) -- within those 4 files every
// command-position match under this narrower pattern is a real operative
// call (verified against the issue's own 11-site census).
function rewriteBareGsdToolsCommandsToGsdRun(content) {
  return content
    .replace(/(^[ \t]*)gsd-tools(?=\s)/gm, '$1gsd_run')
    .replace(/(\$\(\s*)gsd-tools(?=\s)/g, '$1gsd_run')
    .replace(/(`\s*)gsd-tools(?=\s)/g, '$1gsd_run')
    .replace(/((?:&&|;)\s*)gsd-tools(?=\s)/g, '$1gsd_run');
}

// #4995: after the token swap, any fenced bash/sh/shell block that now calls
// `gsd_run` needs the resolver preamble that defines it -- reuse
// sync-runtime-launcher.cjs's transformFile verbatim (the same mechanism
// applied to agents/*.md and gsd-core/workflows/*.md) rather than
// reimplementing preamble placement here. Inline (non-fenced) "Run: `gsd_run
// verb args`" prose has no fenced block to anchor a preamble to; per the
// precedent already set for this exact shape (commands/gsd/workstreams.md
// and config.md in 11ad7881ed), it is left as a bare `gsd_run` token --
// `gsd_run` is itself a shipped npm bin name, so it resolves identically to
// how the pre-fix `gsd-tools` form resolved once PATH carries it (e.g. via
// the CLAUDE_ENV_FILE export in an earlier-run preamble in the same
// session), without regressing anything that worked before.
function rewriteSkillContent(content) {
  const swapped = rewriteBareGsdToolsCommandsToGsdRun(content);
  const preamble = loadPreamble();
  const withPreamble = transformFile(swapped, preamble);
  return withPreamble === null ? swapped : withPreamble;
}

function generateSkills(conversion) {
  const cmdNames = conversion.readGsdCommandNames();
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  const results = [];
  for (const file of files) {
    const stem = file.slice(0, -3);
    const skillName = PREFIX + stem;
    const src = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
    let converted = conversion.convertClaudeCommandToClaudeSkill(src, skillName, RUNTIME, cmdNames, true);
    if (BARE_GSD_TOOLS_STEMS.has(stem)) {
      converted = rewriteSkillContent(converted);
    }
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
