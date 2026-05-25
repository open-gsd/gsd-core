import type { QueryHandler } from './utils.js';

import { STATE_FAMILY_HANDLERS } from '../handlers/state/index.js';
import { ROADMAP_FAMILY_HANDLERS } from '../handlers/roadmap/index.js';
import { VERIFY_FAMILY_HANDLERS } from '../handlers/verify/index.js';
import { VALIDATE_FAMILY_HANDLERS } from '../handlers/validate/index.js';
import { PHASE_FAMILY_HANDLERS } from '../handlers/phase/index.js';
import { PHASES_FAMILY_HANDLERS } from '../handlers/phases/index.js';
import { INIT_FAMILY_HANDLERS } from '../handlers/init/index.js';

export const FAMILY_HANDLERS: Record<string, Readonly<Record<string, QueryHandler>>> = {
  state: STATE_FAMILY_HANDLERS,
  roadmap: ROADMAP_FAMILY_HANDLERS,
  verify: VERIFY_FAMILY_HANDLERS,
  validate: VALIDATE_FAMILY_HANDLERS,
  phase: PHASE_FAMILY_HANDLERS,
  phases: PHASES_FAMILY_HANDLERS,
  init: INIT_FAMILY_HANDLERS,
};
