import type { QueryHandler } from '../../query/utils.js';
import {
  initExecutePhase, initPlanPhase, initNewMilestone, initQuick,
  initIngestDocs, initResume, initVerifyWork, initPhaseOp, initTodos,
  initMilestoneOp, initMapCodebase, initNewWorkspace,
  initListWorkspaces, initRemoveWorkspace,
} from './composer.js';
import { initNewProject, initProgress, initManager } from './complex.js';

export const INIT_FAMILY_HANDLERS: Readonly<Record<string, QueryHandler>> = {
  'init.execute-phase': initExecutePhase,
  'init.plan-phase': initPlanPhase,
  'init.new-project': initNewProject,
  'init.new-milestone': initNewMilestone,
  'init.quick': initQuick,
  'init.ingest-docs': initIngestDocs,
  'init.resume': initResume,
  'init.verify-work': initVerifyWork,
  'init.phase-op': initPhaseOp,
  'init.todos': initTodos,
  'init.milestone-op': initMilestoneOp,
  'init.map-codebase': initMapCodebase,
  'init.progress': initProgress,
  'init.manager': initManager,
  'init.new-workspace': initNewWorkspace,
  'init.list-workspaces': initListWorkspaces,
  'init.remove-workspace': initRemoveWorkspace,
};
