/**
 * External-descriptor trust gate (ADR-1239 Phase C-2, #1681).
 *
 * Load-time `configHome` write-confinement for installed third-party host-plugin
 * descriptors. The opt-in loader (`loadRegistry({includeInstalled:true})`) already
 * applies schema validation + consent + first-party-wins + fail-closed gates;
 * this adds defense-in-depth: **before** a third-party descriptor's install plan
 * is ever executed, assert every destSubpath it declares resolves within the
 * user-approved `configHome`. A path-escaping or malformed descriptor is
 * rejected fail-closed.
 *
 * This is the load-time twin of Phase 2's install-time gate
 * (`assertDestWithinConfigHome` in runtime-artifact-install-plan.cts, #1679 AC3).
 * The two are defense-in-depth: load-time rejects malformed descriptors early
 * (before consent even matters); install-time bounds the actual writes.
 *
 * Do NOT conflate with ADR-1577's prompt-injection circuit-breaker — separate
 * concern sharing the word "trust".
 */
'use strict';

import path from 'node:path';

/**
 * Pure path-containment check (cross-platform). `target` is confined to `root`
 * iff resolving it relative to `root` yields a path equal to or under `root`.
 * Absolute paths outside `root` and `..`-escapes return false.
 */
export function isPathConfined(target: string, root: string): boolean {
  if (typeof target !== 'string' || typeof root !== 'string' || target.length === 0 || root.length === 0) {
    return false;
  }
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(root, target);
  const prefix = rootResolved + path.sep;
  return targetResolved === rootResolved || targetResolved.startsWith(prefix);
}

export interface DescriptorArtifactKind {
  destSubpath?: unknown;
}
export interface DescriptorArtifactLayout {
  global?: DescriptorArtifactKind[];
  local?: DescriptorArtifactKind[];
}
export interface DescriptorRuntimeBlock {
  artifactLayout?: DescriptorArtifactLayout;
}
export interface DescriptorLike {
  id?: string;
  runtime?: DescriptorRuntimeBlock;
}

/**
 * Assert every destSubpath the descriptor declares (global + local artifact
 * layout) resolves within `configHome`. Throws fail-closed naming the offending
 * descriptor + path on the first escape. A descriptor with no artifact layout
 * passes (nothing to confine).
 */
export function assertDescriptorConfined(descriptor: DescriptorLike, configHome: string): void {
  if (!descriptor || typeof descriptor !== 'object') return;
  const id = typeof descriptor.id === 'string' ? descriptor.id : '<unknown>';
  const layout = descriptor.runtime?.artifactLayout;
  if (!layout || typeof layout !== 'object') return;

  const check = (scope: 'global' | 'local', kinds: DescriptorArtifactKind[] | undefined) => {
    if (!Array.isArray(kinds)) return;
    for (const kind of kinds) {
      const dest = kind?.destSubpath;
      if (typeof dest !== 'string' || dest.length === 0) continue;
      if (!isPathConfined(dest, configHome)) {
        throw new Error(
          `external-descriptor-trust: descriptor '${id}' declares an unconfined ${scope} destSubpath ` +
          `${JSON.stringify(dest)} (resolves outside configHome ${JSON.stringify(configHome)}) — rejected fail-closed.`,
        );
      }
    }
  };

  check('global', layout.global);
  check('local', layout.local);
}
