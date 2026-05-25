import type { QueryHandler } from '../../query/utils.js';
import { phaseListPlans, phaseListArtifacts } from '../../query/phase-list-queries.js';
import { phaseUatPassed } from '../../query/phase-uat-passed.js';
import {
  phaseAdd, phaseAddBatch, phaseInsert, phaseRemove, phaseComplete,
  phaseScaffold, phaseNextDecimal,
} from '../../query/phase-lifecycle.js';

export const PHASE_FAMILY_HANDLERS: Readonly<Record<string, QueryHandler>> = {
  'phase.list-plans': phaseListPlans,
  'phase.list-artifacts': phaseListArtifacts,
  'phase.uat-passed': phaseUatPassed,
  'phase.add': phaseAdd,
  'phase.add-batch': phaseAddBatch,
  'phase.insert': phaseInsert,
  'phase.remove': phaseRemove,
  'phase.complete': phaseComplete,
  'phase.scaffold': phaseScaffold,
  'phase.next-decimal': phaseNextDecimal,
};
