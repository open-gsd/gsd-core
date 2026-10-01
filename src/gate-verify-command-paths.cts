/**
 * `check verify-command-paths` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet,
 * #2401): it returns a `GateResult`; the command router formats it. Imports no io module and
 * performs no direct console/stdout/stderr write (ESLint-enforced).
 *
 * Probes every `<automated>` verify command declared in a phase's `-PLAN.md` files against the
 * filesystem WITHOUT executing anything — see `verify-command-grounding.cts` for the recognizer
 * contract.
 *
 * Argv after the verb: `<phase>` | `--dir <plan-dir>`.
 *
 * `--dir` (#4767) names a directory holding `-PLAN.md` files directly, for plans that live outside
 * `.planning/phases/` (quick mode's `.planning/quick/<id>/`). It is resolved against the project
 * root AND CONTAINED WITHIN IT — an absolute or climbing `--dir` that lands outside the root is
 * `unresolvable`, never read — then probed exactly as a phase directory is; `projectRoot` stays the
 * project root in both forms. `--dir <value>` is the only accepted spelling: `--dir=<value>`
 * yields no `dir` flag and falls through to the no-argument arm, as does an empty value (both are
 * `partitionPredicateArgs` behaviour, inherited and unchanged).
 *
 * When the phase cannot be resolved (or `--dir` escapes the root, or neither is given) the gate
 * returns a non-throwing degraded payload (status/commands/counts zeroed, `readError` populated)
 * rather than a usage failure — the plan-checker parses this result and must be able to tell
 * "nothing to report" from "could not look", which a thrown error would collapse.
 *
 * Containment is decided on the resolved target (ADR-4650: the probe's reads follow symlinks).
 * RESIDUAL, stated rather than left to be rediscovered: this is check-then-use, so a symlink
 * planted at the resolved path BETWEEN the containment check and the reads inside the probe would
 * be followed. A link already in place when the command runs IS refused. Closing the window needs
 * O_NOFOLLOW/dirfd semantics inside the ADR-4650 predicate — a wider change than this gate.
 */

import { gateVerdict, gateUnreadable, isGateUsageFailure } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { partitionPredicateArgs } from './gate-args.cjs';
import { resolveContainedPath, resolvePhaseDir, unresolvableProbeVerdict as unresolvable } from './gate-phase-context.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verifyCommandGroundingMod = require('./verify-command-grounding.cjs');
const { probePhaseVerifyCommands } = verifyCommandGroundingMod;

export function evaluateVerifyCommandPaths(input: { projectDir: string; args: readonly string[] }): GateResult {
  const { projectDir } = input;
  const { flags, positionals } = partitionPredicateArgs(input.args);
  const dirFlag = typeof flags['dir'] === 'string' ? flags['dir'] : '';
  // First non-flag positional: `--raw` (valueless) lands in positionals too, and its position
  // relative to the phase argument is the caller's choice.
  const phase = positionals.find(p => !p.startsWith('--')) ?? '';
  if (!phase && !dirFlag) {
    return unresolvable('verify-command-paths requires a phase argument or --dir: check verify-command-paths <phase> | --dir <plan-dir>');
  }

  let phaseDir = '';
  if (dirFlag) {
    // `--dir` is CALLER-SUPPLIED: contain it before it reaches the reads in the probe. Read the
    // value the predicate RETURNED; never re-derive the path. An escape degrades to the same
    // non-throwing payload the unresolvable-phase arm emits.
    const contained = resolveContainedPath(dirFlag, projectDir);
    if (isGateUsageFailure(contained)) {
      return unresolvable(`--dir resolves outside the project root: ${dirFlag}`);
    }
    phaseDir = contained;
  } else {
    const located = resolvePhaseDir(projectDir, phase);
    if (located.kind === 'unreadable') {
      return unresolvable(`could not read the phase directory for phase ${phase}: ${located.reason}`);
    }
    if (located.kind === 'found') phaseDir = located.value;
  }

  if (!phaseDir) {
    return unresolvable(`could not resolve phase directory for phase ${phase}`);
  }

  const probed = probePhaseVerifyCommands({ phaseDir, projectRoot: projectDir });
  const blocked = probed.counts.blocker > 0;
  // A probe that could not look (`unresolvable`) is `unreadable`: never a pass, exit UNAVAILABLE (#5170).
  if (!blocked && probed.status === 'unresolvable') return gateUnreadable(false, { ...probed });
  return gateVerdict(blocked ? 'block' : 'pass', blocked, { ...probed });
}
