'use strict';

/**
 * cli-skew-check.cts — CLI version-skew detection (#1754).
 *
 * Pure function: compares the resolved gsd-tools.cjs path to the project root.
 * If the resolved CLI is OUTSIDE the project root while a project-local install
 * EXISTS, returns a warning string (the caller writes it to stderr). Non-blocking.
 *
 * Catches the shadowing scenario from #1748: a stale global canary CLI (e.g.
 * from the retired @gsd-build/sdk) shadowing the project-local GSD install.
 *
 * The function is PURE (no I/O) — the caller provides the resolved path, the
 * project root, and whether a project-local install exists. This makes it
 * trivially testable without filesystem setup.
 */

import path from 'node:path';

/**
 * Check for CLI version skew.
 *
 * @param opts.resolvedPath - The absolute path of the running gsd-tools.cjs (__filename).
 * @param opts.projectRoot - The project root (from findProjectRoot), or null if no project.
 * @param opts.projectLocalExists - Whether a project-local gsd-tools.cjs exists.
 * @returns A warning string if skew is detected, or null if no skew.
 */
export function checkCliSkew(opts: {
  resolvedPath: string;
  projectRoot: string | null;
  projectLocalExists: boolean;
}): string | null {
  const { resolvedPath, projectRoot, projectLocalExists } = opts;

  // No project context or no project-local install → no skew possible.
  if (!projectRoot || !projectLocalExists) return null;

  // If the resolved CLI is under the project root, it IS a project-local install.
  const rel = path.relative(projectRoot, resolvedPath);
  if (!rel.startsWith('..')) return null;

  // Resolved CLI is outside project root while a project-local install exists → SKEW.
  const hint = resolvedPath.includes('@gsd-build')
    ? ' If @gsd-build/sdk: npm uninstall -g @gsd-build/sdk'
    : '';
  return `⚠ GSD: ${resolvedPath} may shadow project-local GSD.${hint}`;
}
