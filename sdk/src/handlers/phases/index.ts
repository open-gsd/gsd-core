import type { QueryHandler } from '../../query/utils.js';
import { phasesList, phasesClear, phasesArchive } from '../../query/phase-lifecycle.js';

export const PHASES_FAMILY_HANDLERS: Readonly<Record<string, QueryHandler>> = {
  'phases.list': phasesList,
  'phases.clear': phasesClear,
  'phases.archive': phasesArchive,
};
