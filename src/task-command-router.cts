/**
 * Task command router — is-behavior-adding subcommand handler.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/task-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON } = ioMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BehaviorAddingChecks {
  tdd_true: boolean;
  has_behavior_block: boolean;
  has_source_files: boolean;
}

interface BehaviorAddingResult {
  is_behavior_adding: boolean;
  checks: BehaviorAddingChecks;
  reason: string | null;
}

interface RouteTaskCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function isBehaviorAddingTaskContent(content: string): BehaviorAddingResult {
  const tddTrue = /\btdd\s*=\s*["']true["']/i.test(content);

  const behaviorMatch = content.match(/<behavior>([\s\S]*?)<\/behavior>/i);
  const hasBehaviorBlock = Boolean(behaviorMatch && behaviorMatch[1].trim().length > 0);

  const filesMatch = content.match(/<files>([\s\S]*?)<\/files>/i);
  let hasSourceFiles = false;
  if (filesMatch) {
    const fileLines = filesMatch[1]
      .split(/[\n,]/)
      .map((line) => line.trim().replace(/^[-*]\s*/, ''))
      .filter(Boolean);
    hasSourceFiles = fileLines.some((file) =>
      !/\.md$/i.test(file) &&
      !/\.json$/i.test(file) &&
      !/\.test\.[^.]+$/i.test(file) &&
      !/\.spec\.[^.]+$/i.test(file) &&
      !/(^|[\\/])tests?[\\/]/i.test(file) &&
      !/\.(yml|yaml|toml|ini|cfg|conf|properties)$/i.test(file) &&
      !/(^|[\\/])\.env(\..+)?$/i.test(file)
    );
  }

  const isBehaviorAdding = tddTrue && hasBehaviorBlock && hasSourceFiles;
  const missing: string[] = [];
  if (!tddTrue) missing.push('tdd="true" frontmatter absent');
  if (!hasBehaviorBlock) missing.push('<behavior> block missing or empty');
  if (!hasSourceFiles) missing.push('<files> has no non-test source file');

  return {
    is_behavior_adding: isBehaviorAdding,
    checks: {
      tdd_true: tddTrue,
      has_behavior_block: hasBehaviorBlock,
      has_source_files: hasSourceFiles,
    },
    reason: isBehaviorAdding ? null : `Not behavior-adding: ${missing.join('; ')}`,
  };
}

function routeTaskCommand({ args, cwd, raw }: RouteTaskCommandOptions): void {
  const subcommand = args[1];
  if (subcommand !== 'is-behavior-adding') {
    error('Unknown task subcommand. Available: is-behavior-adding', ERROR_REASON.SDK_UNKNOWN_COMMAND);
  }

  let content: string | null = null;
  if (args[2] === '--task-content') {
    content = args[3] || null;
  } else if (args[2]) {
    const projectRoot = path.resolve(cwd || process.cwd());
    const requestedPath = args[2];
    const resolvedTaskPath = path.resolve(projectRoot, requestedPath);
    const rel = path.relative(projectRoot, resolvedTaskPath);
    if (rel === '..' || rel.startsWith(`..${path.sep}`)) {
      error(`Task file is outside project scope: ${requestedPath}`, ERROR_REASON.USAGE);
    }
    if (!fs.existsSync(resolvedTaskPath)) {
      error(`Task file not found: ${requestedPath}`, ERROR_REASON.USAGE);
    }
    content = fs.readFileSync(resolvedTaskPath, 'utf-8');
  }

  if (!content) {
    error('Usage: task.is-behavior-adding <plan-file-path> | --task-content "<xml>"', ERROR_REASON.USAGE);
  }

  output(isBehaviorAddingTaskContent(content as string), raw, undefined);
}

export = {
  isBehaviorAddingTaskContent,
  routeTaskCommand,
};
