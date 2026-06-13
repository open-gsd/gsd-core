/**
 * Capability activation helpers.
 *
 * Shared by the Capability State Resolver and Loop Resolver so config-key
 * activation uses one precedence chain and one prototype-pollution guard.
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir, planningRoot } = planningWorkspaceMod;

function _getNestedConfigValue(
  config: Record<string, unknown>,
  dotKey: string,
): { found: boolean; value: unknown } {
  const segments = dotKey.split('.');
  let current: unknown = config;
  for (const seg of segments) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
      return { found: false, value: undefined };
    }
    if (typeof current !== 'object' || current === null) {
      return { found: false, value: undefined };
    }
    const cur = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { found: false, value: undefined };
    }
    current = cur[seg];
  }
  return { found: true, value: current };
}

const _warnedRawConfigPaths = new Set<string>();

function _readRawConfigKey(
  filePath: string,
  dotKey: string,
): { found: boolean; value: unknown } {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      if (!_warnedRawConfigPaths.has(filePath)) {
        _warnedRawConfigPaths.add(filePath);
        try {
          process.stderr.write(
            `gsd-tools: warning: failed to parse ${filePath} as JSON — skipping for activation resolution\n`,
          );
        } catch { /* stderr might be closed */ }
      }
      return { found: false, value: undefined };
    }
    return _getNestedConfigValue(parsed, dotKey);
  } catch {
    return { found: false, value: undefined };
  }
}

function _resolveActivationValue(
  dotKey: string,
  config: Record<string, unknown>,
  cwd: string | undefined,
  registry: Record<string, unknown>,
): boolean {
  const fromConfig = _getNestedConfigValue(config, dotKey);
  if (fromConfig.found) return Boolean(fromConfig.value);

  if (cwd) {
    const wsConfigPath = path.join(planningDir(cwd), 'config.json');
    const rootConfigPath = path.join(planningRoot(cwd), 'config.json');

    const fromWs = _readRawConfigKey(wsConfigPath, dotKey);
    if (fromWs.found) return Boolean(fromWs.value);

    if (wsConfigPath !== rootConfigPath) {
      const fromRoot = _readRawConfigKey(rootConfigPath, dotKey);
      if (fromRoot.found) return Boolean(fromRoot.value);
    }
  }

  const schemaEntry = (registry['configSchema'] as Record<string, unknown> | undefined)?.[dotKey];
  if (schemaEntry && typeof schemaEntry === 'object' && schemaEntry !== null) {
    const def = (schemaEntry as Record<string, unknown>)['default'];
    if (def !== undefined) return Boolean(def);
  }

  return false;
}

export = {
  _getNestedConfigValue,
  _readRawConfigKey,
  _resolveActivationValue,
};
