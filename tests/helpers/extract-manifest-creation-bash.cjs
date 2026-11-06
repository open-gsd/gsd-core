'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanFencedBlocks } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');

const STEP_PATH = path.join(
  __dirname,
  '..',
  '..',
  'gsd-core',
  'workflows',
  'execute-phase',
  'steps',
  'executor-isolation-dispatch.md',
);

/**
 * The durable-manifest creation script has one copy, in
 * executor-isolation-dispatch.md. execute-phase.md and
 * workflow-backend-dispatch.md both point at that block: the host workflow is
 * under the ADR-857 byte ceiling, and two inlined copies drifted.
 *
 * The markdown is the runtime-loaded instruction, so tests execute this text
 * rather than a rewritten stand-in.
 */
function extractManifestCreationBash() {
  const content = fs.readFileSync(STEP_PATH, 'utf8');
  const marker = '## Durable wave manifest';
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`extractManifestCreationBash: could not find "${marker}" in ${STEP_PATH}`);
  }
  const afterMarker = content.slice(markerIdx + marker.length);
  const lines = splitLines(afterMarker);
  const fence = scanFencedBlocks(lines).find(
    (b) => b.closeLineIdx !== -1 && ['bash', 'sh'].includes((b.infoString || '').trim()),
  );
  if (!fence) {
    throw new Error(`extractManifestCreationBash: could not find a bash fence after "${marker}"`);
  }
  const block = lines.slice(fence.openLineIdx + 1, fence.closeLineIdx).join('\n');
  const ifIdx = block.indexOf('if [ "${USE_WORKTREES');
  if (ifIdx === -1) {
    throw new Error('extractManifestCreationBash: could not find if [ "${USE_WORKTREES in block');
  }
  return block.slice(ifIdx).trim();
}

module.exports = {
  STEP_PATH,
  extractManifestCreationBash,
};
