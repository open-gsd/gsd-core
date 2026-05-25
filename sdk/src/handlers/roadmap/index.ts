import type { QueryHandler } from '../../query/utils.js';
import { roadmapAnalyze, roadmapGetPhase, roadmapAnnotateDependencies } from '../../query/roadmap.js';
import { roadmapUpdatePlanProgress } from '../../query/roadmap-update-plan-progress.js';

export const ROADMAP_FAMILY_HANDLERS: Readonly<Record<string, QueryHandler>> = {
  'roadmap.analyze': roadmapAnalyze,
  'roadmap.get-phase': roadmapGetPhase,
  'roadmap.update-plan-progress': roadmapUpdatePlanProgress,
  'roadmap.annotate-dependencies': roadmapAnnotateDependencies,
};
