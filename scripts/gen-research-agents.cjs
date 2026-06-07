#!/usr/bin/env node
'use strict';

/**
 * gen-research-agents.cjs — profile-driven drift guard for the 7 researcher agents.
 *
 * Usage:
 *   node scripts/gen-research-agents.cjs           # same as --check
 *   node scripts/gen-research-agents.cjs --check   # assert every agent matches its profile
 *   node scripts/gen-research-agents.cjs --write   # regenerate frontmatter from profiles
 *
 * --check assertions per agent:
 *   (a) frontmatter name/description/color/tools exactly match the profile
 *   (b) every requiredInclude string is present in the body
 *   (c) every requiredSeamCall string is present in the body
 *   (d) every outputContract marker string is present in the body
 *
 * --write regenerates ONLY the opening `---\n...\n---` frontmatter block from the
 * profile, leaving the body byte-identical. After --write, --check must pass and
 * `git diff` must be empty (profiles were derived from current state).
 */

const fs = require('node:fs');
const path = require('node:path');

const { PROFILES } = require('./research-profiles.cjs');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');

// ─── Frontmatter serialization ────────────────────────────────────────────────

/**
 * Build the frontmatter block for a profile.
 *
 * The agent files have two patterns for commented hooks:
 *   - Agents with Write in tools (file-writers): include the commented hooks block
 *   - The advisor-researcher (Read-only tools, no Write): no commented hooks
 *
 * We read the CURRENT commented-hooks block from the agent file and preserve it
 * byte-for-byte; only name/description/tools/color are regenerated.
 */
function buildFrontmatter(profile, existingFrontmatter) {
  // Extract the commented hooks section from the existing frontmatter, if any.
  // The hooks block starts at `# hooks:` and runs to (but not including) the
  // closing `---`. In the committed files there is NO blank line between
  // `color:` and `# hooks:`, so we append it directly after the color line's `\n`.
  const hooksMatch = existingFrontmatter.match(/(# hooks:[\s\S]*?)(?=\n---)/);
  // hooksSuffix: if present, the block followed by a newline so `---` is on its own line;
  // if absent, empty string (the closing `---` follows directly after color's `\n`).
  const hooksSuffix = hooksMatch ? hooksMatch[1] + '\n' : '';

  return (
    '---\n' +
    'name: ' + profile.name + '\n' +
    'description: ' + profile.description + '\n' +
    'tools: ' + profile.tools + '\n' +
    'color: ' + profile.color + '\n' +
    hooksSuffix +
    '---'
  );
}

// ─── Parse agent file ─────────────────────────────────────────────────────────

/**
 * Parse a .md file and return { frontmatterRaw, body, frontmatterFields }.
 *
 * frontmatterRaw: the raw text between the first and second `---` delimiters (exclusive)
 * body: everything after the closing `---\n`
 * frontmatterFields: { name, description, color, tools }
 */
function parseAgentFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  // The frontmatter is between the first `---` line and the next `---` line.
  const lines = raw.split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) {
        start = i;
      } else {
        end = i;
        break;
      }
    }
  }

  if (start === -1 || end === -1) {
    throw new Error('No valid frontmatter delimiters found in ' + filePath);
  }

  const frontmatterLines = lines.slice(start + 1, end);
  const frontmatterRaw = frontmatterLines.join('\n');
  // body includes the closing `---` line and everything after
  const fullFrontmatter = lines.slice(start, end + 1).join('\n');
  const body = lines.slice(end + 1).join('\n');

  const fields = {};
  // Parse simple key: value pairs (not nested YAML, no multi-line values here)
  for (const line of frontmatterLines) {
    // Skip comment lines
    if (line.trimStart().startsWith('#')) continue;
    const m = line.match(/^(\w+):\s*(.*)/);
    if (m) {
      fields[m[1]] = m[2].trim();
    }
  }

  return { raw, frontmatterRaw, fullFrontmatter, body, fields };
}

// ─── Check ────────────────────────────────────────────────────────────────────

/**
 * Check one profile against its agent file.
 * Returns an array of failure strings (empty = pass).
 */
function checkAgent(profile) {
  // Validate required array fields — return a clear failure rather than throwing TypeError.
  for (const field of ['requiredIncludes', 'requiredSeamCalls', 'outputContract']) {
    if (!Array.isArray(profile[field])) {
      return ['profile ' + profile.name + ': missing required array field ' + field];
    }
  }

  const agentPath = path.join(AGENTS_DIR, profile.name + '.md');
  const failures = [];

  if (!fs.existsSync(agentPath)) {
    return ['agent file not found: ' + agentPath];
  }

  const { fields } = parseAgentFile(agentPath);
  const fullContent = fs.readFileSync(agentPath, 'utf8');

  // (a) frontmatter fields
  if (fields.name !== profile.name) {
    failures.push(
      'name mismatch: got "' + fields.name + '", want "' + profile.name + '"',
    );
  }
  if (fields.description !== profile.description) {
    failures.push(
      'description mismatch:\n  got:  "' + fields.description + '"\n  want: "' + profile.description + '"',
    );
  }
  if (fields.color !== profile.color) {
    failures.push(
      'color mismatch: got "' + fields.color + '", want "' + profile.color + '"',
    );
  }
  if (fields.tools !== profile.tools) {
    failures.push(
      'tools mismatch:\n  got:  "' + fields.tools + '"\n  want: "' + profile.tools + '"',
    );
  }

  // (b) requiredIncludes
  for (const include of profile.requiredIncludes) {
    if (!fullContent.includes(include)) {
      failures.push('missing required include: ' + include);
    }
  }

  // (c) requiredSeamCalls
  for (const seam of profile.requiredSeamCalls) {
    if (!fullContent.includes(seam)) {
      failures.push('missing required seam call: ' + seam);
    }
  }

  // (d) outputContract
  for (const marker of profile.outputContract) {
    if (!fullContent.includes(marker)) {
      failures.push('missing output contract marker: ' + marker);
    }
  }

  return failures;
}

/**
 * Run --check for all profiles. Prints pass/fail per agent.
 * Returns true if all pass, false otherwise.
 */
function runCheck() {
  let allPassed = true;

  for (const profile of PROFILES) {
    const failures = checkAgent(profile);
    if (failures.length === 0) {
      process.stdout.write('  PASS  ' + profile.name + '\n');
    } else {
      process.stdout.write('  FAIL  ' + profile.name + '\n');
      for (const f of failures) {
        process.stdout.write('        ' + f.replace(/\n/g, '\n        ') + '\n');
      }
      allPassed = false;
    }
  }

  return allPassed;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Regenerate the frontmatter block of one agent file from its profile.
 * The body (everything after the closing ---) is preserved byte-for-byte.
 */
function writeAgent(profile) {
  const agentPath = path.join(AGENTS_DIR, profile.name + '.md');
  const { fullFrontmatter, body } = parseAgentFile(agentPath);

  const newFrontmatter = buildFrontmatter(profile, fullFrontmatter);
  const newContent = newFrontmatter + '\n' + body;

  fs.writeFileSync(agentPath, newContent, 'utf8');
}

function runWrite() {
  for (const profile of PROFILES) {
    const agentPath = path.join(AGENTS_DIR, profile.name + '.md');
    if (!fs.existsSync(agentPath)) {
      throw new ExitError(1, 'ERROR: agent file not found: ' + agentPath);
    }
    writeAgent(profile);
    process.stdout.write('  wrote  ' + profile.name + '.md\n');
  }
  process.stdout.write('\nRun --check to verify:\n');
  process.stdout.write('  node scripts/gen-research-agents.cjs --check\n');
}

// ─── Exports (for tests) ──────────────────────────────────────────────────────

module.exports = { PROFILES, checkAgent, runCheck, parseAgentFile };

// ─── CLI entry point ──────────────────────────────────────────────────────────

function main() {
  const flag = process.argv[2] || '--check';

  if (flag === '--write') {
    process.stdout.write('Writing frontmatter from profiles...\n');
    runWrite();
    process.stdout.write('\nVerifying...\n');
    const ok = runCheck();
    if (!ok) {
      process.stderr.write('\nERROR: --check failed after --write. Fix serialization.\n');
      throw new ExitError(1);
    }
    process.stdout.write('\nAll agents match their profiles.\n');
  } else if (flag === '--check') {
    process.stdout.write('Checking research agent profiles...\n');
    const ok = runCheck();
    if (!ok) {
      process.stderr.write('\nSome agents do not match their profiles.\n');
      process.stdout.write(
        '\nTo regenerate frontmatter from profiles:\n' +
        '  node scripts/gen-research-agents.cjs --write\n',
      );
      throw new ExitError(1);
    }
    process.stdout.write('\nAll 7 agents match their profiles.\n');
  } else {
    throw new ExitError(1, 'Unknown flag: ' + flag + '\nUsage: node scripts/gen-research-agents.cjs [--check|--write]');
  }
}

if (require.main === module) {
  runMain(main);
}
