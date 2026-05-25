import { STATE_COMMAND_MANIFEST } from '../query/command-manifest.state.js';
import { VERIFY_COMMAND_MANIFEST } from '../query/command-manifest.verify.js';
import { INIT_COMMAND_MANIFEST } from '../query/command-manifest.init.js';
import { PHASE_COMMAND_MANIFEST } from '../query/command-manifest.phase.js';
import { PHASES_COMMAND_MANIFEST } from '../query/command-manifest.phases.js';
import { VALIDATE_COMMAND_MANIFEST } from '../query/command-manifest.validate.js';
import { ROADMAP_COMMAND_MANIFEST } from '../query/command-manifest.roadmap.js';

export const COMMAND_MANIFEST = [
  ...STATE_COMMAND_MANIFEST,
  ...VERIFY_COMMAND_MANIFEST,
  ...INIT_COMMAND_MANIFEST,
  ...PHASE_COMMAND_MANIFEST,
  ...PHASES_COMMAND_MANIFEST,
  ...VALIDATE_COMMAND_MANIFEST,
  ...ROADMAP_COMMAND_MANIFEST,
] as const;
