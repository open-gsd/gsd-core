#!/usr/bin/env node
'use strict';

/**
 * gen-pi-package-skills.cjs — generates pi/package-skills/gsd-<stem>/SKILL.md,
 * the Pi skill templates the Pi package (`pi install npm:@opengsd/gsd-core`)
 * renders at session start.
 *
 * Usage:
 *   node scripts/gen-pi-package-skills.cjs            # print summary
 *   node scripts/gen-pi-package-skills.cjs --write    # write pi/package-skills/
 *   node scripts/gen-pi-package-skills.cjs --check    # exit 1 if committed templates are stale
 *
 * #5558 (Phase 1b of epic #5556). Pi skill bodies embed the absolute path of the
 * engine tree they `@`-include, and a package's install location is unknown at
 * build time. So the templates are produced by running the real installer
 * (`bin/install.js --pi --global --config-dir <tmp>`), then replacing the temp
 * config dir with PI_ENGINE_ROOT_TOKEN. Rendering a template with a root R
 * (`renderSkillTemplate`, exported for the parity test; pi/gsd.cjs carries the
 * same two-line substitution) is therefore byte-identical to what the installer
 * writes for config dir R.
 *
 * Depends on a built lib (`npm run build:lib`); must run after it in the build chain.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'pi', 'package-skills');
const INSTALLER = path.join(ROOT, 'bin', 'install.js');
const PI_ENGINE_ROOT_TOKEN = '__GSD_PI_ENGINE_ROOT__';
const INSTALL_BOUND_MS = 30000;

/** Forward-slash form of a path; the installer emits either form depending on platform. */
function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Replace every occurrence of `root` (raw and forward-slash forms) with the token.
 * @param {string} content
 * @param {string} root
 */
function tokenizeSkill(content, root) {
  const forms = [...new Set([root, toSlash(root)])].sort((a, b) => b.length - a.length);
  let out = content;
  for (const form of forms) out = out.split(form).join(PI_ENGINE_ROOT_TOKEN);
  return out;
}

/**
 * Render a template for an engine root. The root is substituted in its
 * forward-slash form, which is what the installer writes for the Pi skills.
 * @param {string} template
 * @param {string} engineRoot
 */
function renderSkillTemplate(template, engineRoot) {
  return template.split(PI_ENGINE_ROOT_TOKEN).join(toSlash(engineRoot));
}

/**
 * Run the installer for Pi into a fresh temp dir and return that dir. The run
 * gets a separate throwaway HOME (removed straight after): the two must differ,
 * because the installer writes a config dir that equals or sits under HOME as
 * `~`/`$HOME`-relative paths.
 */
function installIntoTemp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-skills-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-home-'));
  const res = spawnSync(process.execPath, [INSTALLER, '--pi', '--global', '--config-dir', tmp], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: INSTALL_BOUND_MS,
    windowsHide: true,
    // HOME is redirected too: the installer writes GSD's global defaults store under
    // $HOME/.gsd, and a generator run must not touch the developer's real one.
    env: { ...process.env, PI_CODING_AGENT_DIR: tmp, HOME: home, USERPROFILE: home, GSD_HOME: home },
  });
  fs.rmSync(home, { recursive: true, force: true });
  if (res.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new ExitError(
      1,
      `gen-pi-package-skills: installer failed (${res.error ? res.error.message : `exit ${res.status}`}).\n` +
      `${(res.stderr || res.stdout || '').slice(-1500)}\nRun \`npm run build:lib\` first.`,
    );
  }
  return tmp;
}

/** @returns {{ skillName: string, content: string }[]} sorted by skill name */
function generateTemplates() {
  const tmp = installIntoTemp();
  try {
    const skillsDir = path.join(tmp, 'skills');
    const names = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'))
      .map((e) => e.name)
      .sort();
    return names.map((skillName) => ({
      skillName,
      content: tokenizeSkill(fs.readFileSync(path.join(skillsDir, skillName, 'SKILL.md'), 'utf8'), tmp),
    }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const results = generateTemplates();

  if (args.has('--write')) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    for (const { skillName, content } of results) {
      fs.mkdirSync(path.join(OUT_DIR, skillName), { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, skillName, 'SKILL.md'), content);
    }
    process.stdout.write(`gen-pi-package-skills: wrote ${results.length} templates to ${path.relative(ROOT, OUT_DIR)}/\n`);
    return 0;
  }

  if (args.has('--check')) {
    if (!fs.existsSync(OUT_DIR)) {
      throw new ExitError(1, 'gen-pi-package-skills: pi/package-skills/ missing. Run: npm run gen:pi-package-skills');
    }
    let stale = 0;
    const expected = new Set(results.map((r) => r.skillName));
    for (const { skillName, content } of results) {
      const file = path.join(OUT_DIR, skillName, 'SKILL.md');
      if (!fs.existsSync(file)) {
        process.stderr.write(`gen-pi-package-skills: missing ${path.relative(ROOT, file)}\n`);
        stale++;
      } else if (fs.readFileSync(file, 'utf8') !== content) {
        process.stderr.write(`gen-pi-package-skills: stale ${path.relative(ROOT, file)}\n`);
        stale++;
      }
    }
    for (const e of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && !expected.has(e.name)) {
        process.stderr.write(`gen-pi-package-skills: stale (no source) ${path.relative(ROOT, path.join(OUT_DIR, e.name))}\n`);
        stale++;
      }
    }
    if (stale > 0) {
      throw new ExitError(1, `gen-pi-package-skills: ${stale} stale template(s). Run: npm run gen:pi-package-skills`);
    }
    process.stdout.write(`gen-pi-package-skills: ${results.length} templates up to date\n`);
    return 0;
  }

  process.stdout.write(
    `gen-pi-package-skills: would write ${results.length} templates to ${path.relative(ROOT, OUT_DIR)}/\n` +
    '  (use --write to generate, --check to verify staleness)\n',
  );
  return 0;
}

module.exports = { PI_ENGINE_ROOT_TOKEN, tokenizeSkill, renderSkillTemplate, toSlash, generateTemplates };

if (require.main === module) runMain(main);
