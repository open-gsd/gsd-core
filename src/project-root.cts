/**
 * Project-Root Resolution Module — resolves a project root from a starting
 * directory by walking the ancestor chain and applying five heuristics:
 *   (0) own .planning/ guard (#1362)
 *   (1) parent .planning/config.json sub_repos
 *   (2) legacy multiRepo: true + ancestor .git
 *   (3) .git heuristic with parent .planning/
 *   (4) nearest ancestor .planning/ (#1414, Resolution Provenance P1)
 * Bounded by FIND_PROJECT_ROOT_MAX_DEPTH ancestors. Sync I/O.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/project-root.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { walkUpForPlanning } from './project-context.cjs';

/**
 * #6043 (ADR-4908): the ancestor walk moved verbatim to `project-context.cts`
 * (`walkUpForPlanning`), which the resolver also owns. #6820 (Phase 2a) moved
 * every `src/` and `gsd-tools` consumer onto `resolveProjectContext` and deleted
 * the `--project-dir` module global (`setExplicitProjectRoot` / `resolveProjectRoot`:
 * the context carries `source: 'explicit'` instead). What is left is a one-line
 * delegate for `consentProjectRoot` below and for hooks/lib/isolation-sentinel.js,
 * which Phase 5 (#6047) retires under the lint ratchet. It never spawns git.
 */
export function findProjectRoot(startDir: string): string {
  return walkUpForPlanning(startDir).root;
}

/**
 * #1459 (IC-01 / CB-4): THE single canonical derivation of the PROJECT ROOT used to bind/lookup a
 * project-scope consent record. Install (the CLI/lifecycle RECORD site), the loader (the LOOKUP
 * site), and `trust revoke` (CB-4) MUST all derive the consent root through this one helper so the
 * recorded key always matches the looked-up key — otherwise installing from a SUBDIR records consent
 * at `realpath(subdir)` while the loader looks it up at `realpath(findProjectRoot)` and the freshly
 * installed cap is immediately INACTIVE (install-then-inactive).
 *
 * The rule: `realpath(findProjectRoot(cwd))` (findProjectRoot is total — it returns `cwd` itself when
 * no project root is found, so there is no null branch), falling back to `path.resolve(cwd)` when the
 * resolved root cannot be realpath'd (e.g. it does not exist yet). The consent store realpaths
 * whatever it is given, so passing the SAME logical root from every site is what guarantees the match.
 */
export function consentProjectRoot(cwd: string): string {
  const root = findProjectRoot(cwd);
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}
