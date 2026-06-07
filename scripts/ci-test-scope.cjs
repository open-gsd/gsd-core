#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const { existsSync, readdirSync, appendFileSync } = require('fs');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const RULES = [
  {
    name: 'workflow automation',
    match: path => path.startsWith('.github/workflows/') || path.startsWith('.github/rulesets/'),
    fullMatrix: true,
    tests: [
      'tests/workflow-shell-pinning.test.cjs',
      'tests/release-tarball-smoke-workflow.test.cjs',
      'tests/lint-pr-check-project-dir.test.cjs',
      'tests/pr-template-policy.test.cjs',
    ],
  },
  {
    name: 'test harness',
    match: path => path === 'scripts/run-tests.cjs',
    fullMatrix: true,
    tests: [
      'tests/run-tests-harness.test.cjs',
      'tests/workflow-shell-pinning.test.cjs',
    ],
  },
  {
    name: 'environment and dependency gates',
    match: path => [
      'scripts/check-env.cjs',
      'scripts/check-npm-integrity.cjs',
      'package.json',
      'package-lock.json',
    ].includes(path),
    fullMatrix: true,
    tests: [
      'tests/check-env.test.cjs',
      'tests/npm-integrity-gate.test.cjs',
      'tests/package-manifest.test.cjs',
      'tests/bug-3588-npm-audit-clean.test.cjs',
    ],
  },
  {
    name: 'TS runtime sources (ADR-457 build-at-publish)',
    // src/*.cts compiles into gsd-core/bin/lib/*.cjs; a source-only edit must
    // still trigger the migrated module's tests (otherwise CI silently skips them).
    match: path => path.startsWith('src/') || path === 'tsconfig.build.json',
    tests: [
      'tests/semver-compare.test.cjs',
      'tests/bug-10-semver-policy-consolidation.test.cjs',
    ],
  },
  {
    name: 'installer and package layout',
    match: path => path.startsWith('bin/') ||
      path.startsWith('gsd-core/bin/') ||
      path.includes('install') ||
      path.includes('release-tarball-smoke'),
    fullMatrix: true,
    tests: [
      'tests/install.test.cjs',
      'tests/install-regressions.test.cjs',
      'tests/install-runtime-artifacts.test.cjs',
      'tests/install-path-detection.test.cjs',
      'tests/release-tarball-smoke.install.test.cjs',
      'tests/runtime-artifact-layout.test.cjs',
    ],
  },
  {
    name: 'hooks',
    match: path => path.startsWith('hooks/'),
    fullMatrix: true,
    tests: [
      'tests/hook-validation.test.cjs',
      'tests/managed-hooks.test.cjs',
      'tests/hooks-opt-in.test.cjs',
      'tests/sh-hook-paths.test.cjs',
      'tests/precommit-alias-drift-hook.test.cjs',
      'tests/prepush-enterprise-email-hook.test.cjs',
    ],
  },
  {
    name: 'changeset tooling',
    match: path => path.startsWith('scripts/changeset/') || path.startsWith('.changeset/'),
    tests: [
      'tests/changeset-cli.test.cjs',
      'tests/changeset-lint.test.cjs',
      'tests/changeset-new.test.cjs',
      'tests/changeset-parse.test.cjs',
      'tests/changeset-render.test.cjs',
      'tests/changeset-serialize.test.cjs',
      'tests/changeset-github-release-notes.test.cjs',
    ],
  },
  {
    name: 'security scanners',
    match: path => path.includes('secret-scan') ||
      path.includes('base64-scan') ||
      path.includes('prompt-injection-scan') ||
      path.startsWith('tests/fixtures/adversarial/security/'),
    tests: [
      'tests/secret-scan-lint.test.cjs',
      'tests/prompt-injection-scan.test.cjs',
      'tests/security-prompt-injection.test.cjs',
      'tests/read-injection-scanner.test.cjs',
      'tests/security-scan.test.cjs',
    ],
  },
  {
    name: 'command definitions',
    match: path => path.startsWith('commands/'),
    tests: [
      'tests/command-contract.test.cjs',
      'tests/command-routing-hub.test.cjs',
      'tests/commands.test.cjs',
      'tests/docs-parity-live-registry.test.cjs',
      'tests/phase-command-router.test.cjs',
      'tests/roadmap-command-router.test.cjs',
    ],
  },
  {
    name: 'workflow prompts',
    match: path => path.startsWith('gsd-core/workflows/'),
    tests: [
      'tests/workflow-compat.test.cjs',
      'tests/workflow-size-budget.test.cjs',
      'tests/workflow-guard-registration.test.cjs',
      'tests/commands.test.cjs',
      'tests/bug-3683-workflow-colon-namespace-leak.test.cjs',
    ],
  },
  {
    name: 'agent prompts',
    match: path => path.startsWith('agents/'),
    tests: [
      'tests/agent-frontmatter.test.cjs',
      'tests/agent-size-budget.test.cjs',
      'tests/agent-skills.test.cjs',
      'tests/agent-skills-awareness.test.cjs',
      'tests/agent-required-reading-consistency.test.cjs',
      'tests/docs-parity-live-registry.test.cjs',
    ],
  },
  {
    name: 'docs content',
    match: path => path.startsWith('docs/'),
    fullMatrix: false,
    tests: [
      'tests/docs-parity-live-registry.test.cjs',
    ],
  },
  {
    name: 'configuration',
    match: path => ['config', 'configuration', 'model-catalog', 'model-profile'].some(k => path.includes(k)),
    tests: [
      'tests/config.test.cjs',
      'tests/config-get-default.test.cjs',
      'tests/configuration-migrate-config.test.cjs',
      'tests/model-catalog-runtime-defaults.test.cjs',
      'tests/model-profiles.test.cjs',
    ],
  },
];

function usage() {
  return [
    'Usage:',
    '  node scripts/ci-test-scope.cjs --base <sha> --head <sha>',
    '  node scripts/ci-test-scope.cjs --files <path-list>',
    '',
    'Prints JSON by default. With GITHUB_OUTPUT set, also writes workflow outputs.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { base: null, head: null, files: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      out.base = argv[++i];
      if (!out.base || out.base.startsWith('--')) throw new Error('--base requires a value');
    } else if (arg.startsWith('--base=')) {
      out.base = arg.slice('--base='.length);
      if (!out.base) throw new Error('--base requires a value');
    } else if (arg === '--head') {
      out.head = argv[++i];
      if (!out.head || out.head.startsWith('--')) throw new Error('--head requires a value');
    } else if (arg.startsWith('--head=')) {
      out.head = arg.slice('--head='.length);
      if (!out.head) throw new Error('--head requires a value');
    } else if (arg === '--files') {
      out.files = argv[++i];
      if (!out.files || out.files.startsWith('--')) throw new Error('--files requires a value');
    } else if (arg.startsWith('--files=')) {
      out.files = arg.slice('--files='.length);
      if (!out.files) throw new Error('--files requires a value');
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      throw new ExitError(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function splitFiles(value) {
  if (!value) return [];
  const SEPARATORS = new Set([',', ' ', '\t', '\n', '\r', '\f', '\v']);
  const tokens = [];
  let current = '';
  for (const ch of value) {
    if (SEPARATORS.has(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens.map(v => v.trim()).filter(Boolean);
}

function changedFiles(args) {
  if (args.files) return splitFiles(args.files);
  if (!args.base || !args.head) {
    throw new Error('--base/--head or --files is required');
  }
  const stdout = execFileSync('git', ['diff', '--name-only', args.base, args.head], {
    encoding: 'utf8',
  });
  return splitFiles(stdout);
}

function existingTests(files) {
  const all = new Set(readdirSync('tests').filter(f => f.endsWith('.test.cjs')).map(f => `tests/${f}`));
  return files.filter(file => all.has(file) && existsSync(file));
}

function addAll(set, values) {
  for (const value of values) set.add(value);
}

const WINDOWS_HINTS = ['windows', 'path', 'shell', 'workflow', 'install', 'hook'];
const isWindowsHint = s => WINDOWS_HINTS.some(k => s.toLowerCase().includes(k));

function classify(files) {
  const targeted = new Set();
  const windows = new Set();
  const reasons = [];
  let codeChanged = false;
  let fullMatrix = false;

  for (const file of files) {
    if (['bin/', 'gsd-core/', 'agents/', 'commands/', 'docs/', 'hooks/', 'tests/', 'scripts/'].some(p => file.startsWith(p)) ||
      file === 'package.json' || file === 'package-lock.json' ||
      (file.startsWith('tsconfig') && file.endsWith('.json')) ||
      file.startsWith('.github/workflows/') ||
      file.startsWith('.github/rulesets/')) {
      codeChanged = true;
    }

    if (file.startsWith('tests/') && file.endsWith('.test.cjs')) {
      targeted.add(file);
      fullMatrix = true;
      if (isWindowsHint(file)) {
        windows.add(file);
      }
    }

    for (const rule of RULES) {
      if (rule.match(file)) {
        addAll(targeted, rule.tests);
        reasons.push(`${file}: ${rule.name}`);
        if (rule.fullMatrix) fullMatrix = true;
      }
    }
  }

  const targetedTests = existingTests([...targeted].sort());

  // When code changed but no rule matched any changed file, fall back to the
  // unit suite so the targeted lane always runs something meaningful (#408).
  if (codeChanged && targetedTests.length === 0) {
    targetedTests.push('unit');
  }

  const windowsTests = existingTests([...new Set([...windows, ...targetedTests.filter(isWindowsHint)])].sort());

  return {
    code_changed: codeChanged,
    full_matrix: fullMatrix,
    targeted_tests: targetedTests,
    windows_tests: windowsTests,
    reasons: [...new Set(reasons)].sort(),
  };
}

function writeOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `code_changed=${result.code_changed}`,
    `full_matrix=${result.full_matrix}`,
    `targeted_tests=${result.targeted_tests.join(' ')}`,
    `windows_tests=${result.windows_tests.join(' ')}`,
  ];
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const files = changedFiles(args);
    const result = classify(files);
    result.changed_files = files;
    writeOutputs(result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof ExitError) throw error;
    console.error(`ci-test-scope: ${error.message}`);
    console.error(usage());
    throw new ExitError(2);
  }
}

runMain(main);
