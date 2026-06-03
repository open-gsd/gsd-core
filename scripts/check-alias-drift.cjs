'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const aliasesPath = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'command-aliases.cjs');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function ensureArray(value, name) {
  if (!Array.isArray(value)) {
    fail(`check:alias-drift: expected ${name} to be an array`);
  }
}

function assertNoDuplicates(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      fail(`check:alias-drift: duplicate ${label} value "${value}"`);
    }
    seen.add(value);
  }
}

if (!fs.existsSync(aliasesPath)) {
  fail(`check:alias-drift: missing ${path.relative(ROOT, aliasesPath)}`);
}

const aliases = require(aliasesPath);

const families = [
  {
    commandAliases: 'STATE_COMMAND_ALIASES',
    subcommands: 'STATE_SUBCOMMANDS',
    routerPath: path.join(ROOT, 'gsd-core', 'bin', 'lib', 'state-command-router.cjs'),
  },
  {
    commandAliases: 'VERIFY_COMMAND_ALIASES',
    subcommands: 'VERIFY_SUBCOMMANDS',
    routerPath: path.join(ROOT, 'gsd-core', 'bin', 'lib', 'verify-command-router.cjs'),
  },
  {
    commandAliases: 'INIT_COMMAND_ALIASES',
    subcommands: 'INIT_SUBCOMMANDS',
    routerPath: path.join(ROOT, 'gsd-core', 'bin', 'lib', 'init-command-router.cjs'),
  },
  {
    commandAliases: 'PHASE_COMMAND_ALIASES',
    subcommands: 'PHASE_SUBCOMMANDS',
    routerPath: path.join(ROOT, 'gsd-core', 'bin', 'lib', 'phase-command-router.cjs'),
  },
  {
    commandAliases: 'PHASES_COMMAND_ALIASES',
    subcommands: 'PHASES_SUBCOMMANDS',
    routerPath: path.join(ROOT, 'gsd-core', 'bin', 'lib', 'phases-command-router.cjs'),
  },
  {
    commandAliases: 'VALIDATE_COMMAND_ALIASES',
    subcommands: 'VALIDATE_SUBCOMMANDS',
    routerPath: path.join(ROOT, 'gsd-core', 'bin', 'lib', 'validate-command-router.cjs'),
  },
  {
    commandAliases: 'ROADMAP_COMMAND_ALIASES',
    subcommands: 'ROADMAP_SUBCOMMANDS',
    routerPath: path.join(ROOT, 'gsd-core', 'bin', 'lib', 'roadmap-command-router.cjs'),
  },
];

for (const family of families) {
  const commandAliases = aliases[family.commandAliases];
  const subcommands = aliases[family.subcommands];

  ensureArray(commandAliases, family.commandAliases);
  ensureArray(subcommands, family.subcommands);

  const derivedSubcommands = commandAliases.map((entry) => entry && entry.subcommand);
  assertNoDuplicates(derivedSubcommands, `${family.commandAliases}.subcommand`);

  if (derivedSubcommands.length !== subcommands.length) {
    fail(
      `check:alias-drift: ${family.subcommands} length ${subcommands.length} does not match ` +
      `${family.commandAliases} length ${derivedSubcommands.length}`,
    );
  }

  for (let i = 0; i < derivedSubcommands.length; i++) {
    if (derivedSubcommands[i] !== subcommands[i]) {
      fail(
        `check:alias-drift: ${family.subcommands}[${i}] = "${subcommands[i]}" ` +
        `does not match ${family.commandAliases}[${i}].subcommand = "${derivedSubcommands[i]}"`,
      );
    }
  }

  const routerSource = fs.readFileSync(family.routerPath, 'utf8');
  if (!routerSource.includes(family.subcommands)) {
    fail(
      `check:alias-drift: ${path.relative(ROOT, family.routerPath)} does not reference ${family.subcommands}`,
    );
  }
}

process.stdout.write('check:alias-drift ok\n');
