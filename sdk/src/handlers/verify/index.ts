import type { QueryHandler } from '../../query/utils.js';
import {
  verifyPlanStructure, verifyPhaseCompleteness, verifyReferences,
  verifyCommits, verifyArtifacts, verifySchemaDrift,
} from '../../query/verify.js';
import { verifyKeyLinks } from '../../query/validate.js';

export const VERIFY_FAMILY_HANDLERS: Readonly<Record<string, QueryHandler>> = {
  'verify.plan-structure': verifyPlanStructure,
  'verify.phase-completeness': verifyPhaseCompleteness,
  'verify.references': verifyReferences,
  'verify.commits': verifyCommits,
  'verify.artifacts': verifyArtifacts,
  'verify.key-links': verifyKeyLinks,
  'verify.schema-drift': verifySchemaDrift,
  // 'verify.codebase-drift' intentionally omitted — out-of-seam CJS-only
  // per ADR/PRD 3524 §3 / L160. Router dispatches direct to CJS handler.
};
