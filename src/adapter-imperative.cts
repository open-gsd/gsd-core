/**
 * Imperative embedding adapter (ADR-1239 Phase C-1, AC2 / #1680).
 *
 * The engine-as-library path: an in-process host plugin calls
 * `createImperativeAdapter({runtime})`, which composes the capability registry
 * via `loadRegistry({includeInstalled:true})` (first-party-wins + consent +
 * fail-closed gates) and binds the engine surface behind the SAME
 * `HostIntegrationInterface` the declarative adapter satisfies. The adapter
 * stays thin — it does NOT reimplement the loop resolver; it delegates to the
 * engine + exposes the composed registry so a host (Phase 5) can bind its
 * primitives (command/dispatch/model/hooks/state/artifact) to the registry's
 * declared capability set.
 *
 * Concrete host binding (OpenCode/VS Code/pi) is deferred to Phase 5 (#1682,
 * D15/D18). This slice ships the adapter + the composed-registry seam.
 *
 * Minimal interface (per ADR-1239 open wire-shape question): satisfies the
 * same `{kind, runtime, install, uninstall}` shape as the declarative adapter,
 * plus an imperative-specific `registry` accessor (the composed loadRegistry
 * result). The full 6-point binding surface grows when a real host consumer
 * fixes the shape.
 */
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import installEngine = require('./install-engine.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityLoader = require('./capability-loader.cjs');
import type { HostIntegrationInterface, AdapterInstallIntent, AdapterUninstallIntent } from './embedding-adapter.cjs';

/**
 * The imperative adapter: the shared contract PLUS the composed capability
 * registry an in-process host binds its primitives to.
 */
export interface ImperativeAdapter extends HostIntegrationInterface {
  readonly kind: 'imperative';
  /** The composed capability registry (loadRegistry({includeInstalled:true})). */
  readonly registry: ReturnType<typeof capabilityLoader.loadRegistry>;
}

export interface CreateImperativeAdapterOptions {
  /** Optional overrides forwarded to loadRegistry (cwd, gsdHome, hostVersion). */
  loadOptions?: Record<string, unknown>;
}

export function createImperativeAdapter(
  { runtime }: { runtime: string },
  options: CreateImperativeAdapterOptions = {},
): ImperativeAdapter {
  if (!runtime || typeof runtime !== 'string') {
    throw new TypeError('createImperativeAdapter: runtime is required (non-empty string)');
  }
  // Compose first-party ∪ installed capability overlays with the SAME
  // precedence, consent, and fail-closed-gate guarantees the CLI enforces —
  // an in-process host gets identical trust semantics, not a parallel path.
  const registry = capabilityLoader.loadRegistry({
    includeInstalled: true,
    ...(options.loadOptions ?? {}),
  });
  return Object.freeze({
    kind: 'imperative' as const,
    runtime,
    registry,
    install(intent: AdapterInstallIntent): void {
      installEngine.installRuntimeArtifacts(
        runtime,
        intent.configDir,
        intent.scope,
        intent.resolvedProfile,
        intent.resolveAttribution,
      );
    },
    uninstall(intent: AdapterUninstallIntent): void {
      installEngine.uninstallRuntimeArtifacts(runtime, intent.configDir, intent.scope);
    },
  });
}
