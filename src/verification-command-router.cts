/**
 * Verification-status subcommand router.
 * Routes `verification.status <phaseDir>` to verification.cmdVerificationStatus.
 *
 * Note: `verification` (reads verifier-emitted status) is distinct from `verify`
 * (runs verification checks like plan-structure/artifacts). Keep them separate.
 *
 * ADR-457 build-at-publish: source in src/verification-command-router.cts,
 * compiled to gsd-core/bin/lib/verification-command-router.cjs (gitignored).
 */

import type { ProjectContext } from './project-context.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;

// ─── Types ────────────────────────────────────────────────────────────────────

interface VerificationModule {
  cmdVerificationStatus(ctx: ProjectContext, phaseDirArg: string | undefined, raw: boolean): void;
  cmdVerificationAllSummarized(ctx: ProjectContext, phaseDirArg: string | undefined, tokens: string[], raw: boolean): void;
  cmdVerificationResolveFile(ctx: ProjectContext, phaseDirArg: string | undefined, raw: boolean): void;
  cmdVerificationFingerprint(ctx: ProjectContext, phaseDirArg: string | undefined, files: string[], raw: boolean): void;
  cmdVerificationAppendAudit(ctx: ProjectContext, fileArg: string | undefined, argTokens: string[], raw: boolean): void;
}

interface RouteVerificationCommandOptions {
  verification: VerificationModule;
  args: string[];
  cwd: string;
  /** #6820: the ProjectContext the dispatcher resolved once for this process. */
  ctx: ProjectContext;
  raw: boolean;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const VERIFICATION_SUBCOMMANDS = ['status', 'all-summarized', 'resolve-file', 'fingerprint', 'append-audit'];

function routeVerificationCommand({
  verification,
  args,
  ctx,
  raw,
  error,
}: RouteVerificationCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: VERIFICATION_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown verification subcommand. Available: ${available.join(', ')}`,
    handlers: {
      status: () => verification.cmdVerificationStatus(ctx, args[2], raw),
      'all-summarized': () => verification.cmdVerificationAllSummarized(ctx, args[2], args.slice(3), raw),
      'resolve-file': () => verification.cmdVerificationResolveFile(ctx, args[2], raw),
      fingerprint: () => verification.cmdVerificationFingerprint(ctx, args[2], args.slice(3), raw),
      'append-audit': () => verification.cmdVerificationAppendAudit(ctx, args[2], args.slice(3), raw),
    },
  });
}

export = {
  routeVerificationCommand,
};
