import type { QueryHandler } from '../../query/utils.js';
import { validateConsistency, validateHealth, validateAgents, validateContext } from '../../query/validate.js';

export const VALIDATE_FAMILY_HANDLERS: Readonly<Record<string, QueryHandler>> = {
  'validate.consistency': validateConsistency,
  'validate.health': validateHealth,
  'validate.agents': validateAgents,
  'validate.context': validateContext,
};
