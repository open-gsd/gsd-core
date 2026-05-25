import type { QueryHandler } from '../../query/utils.js';
import { stateProjectLoad } from '../../query/state-project-load.js';
import { stateJson, stateGet } from '../../query/state.js';
import {
  stateUpdate, statePatch, stateBeginPhase, stateAdvancePlan,
  stateRecordMetric, stateUpdateProgress, stateAddDecision,
  stateAddBlocker, stateResolveBlocker, stateRecordSession,
  stateSignalWaiting, stateSignalResume, statePlannedPhase,
  stateValidate, stateSync, statePrune, stateMilestoneSwitch,
  stateAddRoadmapEvolution,
} from '../../query/state-mutation.js';

export const STATE_FAMILY_HANDLERS: Readonly<Record<string, QueryHandler>> = {
  'state.load': stateProjectLoad,
  'state.json': stateJson,
  'state.get': stateGet,
  'state.update': stateUpdate,
  'state.patch': statePatch,
  'state.begin-phase': stateBeginPhase,
  'state.advance-plan': stateAdvancePlan,
  'state.record-metric': stateRecordMetric,
  'state.update-progress': stateUpdateProgress,
  'state.add-decision': stateAddDecision,
  'state.add-blocker': stateAddBlocker,
  'state.resolve-blocker': stateResolveBlocker,
  'state.record-session': stateRecordSession,
  'state.signal-waiting': stateSignalWaiting,
  'state.signal-resume': stateSignalResume,
  'state.planned-phase': statePlannedPhase,
  'state.validate': stateValidate,
  'state.sync': stateSync,
  'state.prune': statePrune,
  'state.milestone-switch': stateMilestoneSwitch,
  'state.add-roadmap-evolution': stateAddRoadmapEvolution,
};
