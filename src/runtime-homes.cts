/**
 * runtime-homes.cts — canonical runtime → global config/skills directory mapping.
 *
 * Single source of truth for resolving the global config base directory and
 * the correct global skills directory for every GSD-supported runtime.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/runtime-homes.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 *
 * Runtime-specific notes:
 *   hermes  — GSD skills nest under skills/gsd/<skillName>/ (not the flat
 *             skills/<skillName>/ layout used by all other runtimes).
 *   cline   — Skills-capable since v3.48.0 (#782). SKILL.md files live at
 *             ~/.cline/skills/<skillName>/SKILL.md (same flat layout as cursor/codex).
 *             .clinerules is also emitted (rules-based compatibility layer).
 *   kimi    — Agent Skills are discovered from Kimi's generic user roots:
 *             ~/.config/agents/skills (recommended) then ~/.agents/skills,
 *             with Kimi selecting the first existing generic skills directory.
 *             ~/.kimi-code/skills is brand-specific and can be selected as a
 *             GSD write target with --config-dir or KIMI_CONFIG_DIR.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Expand a leading ~ to os.homedir().
 */
function expandTilde(p: string): string {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') return path.join(os.homedir(), p.slice(1));
  return p;
}

export interface ResolveAntigravityOpts {
  env?: Record<string, string | undefined>;
  home?: string;
  existsSync?: (p: string) => boolean;
}

export interface ResolveKimiOpts {
  env?: Record<string, string | undefined>;
  home?: string;
  existsSync?: (p: string) => boolean;
}

export interface ResolveConfigHomeOpts {
  env?: Record<string, string | undefined>;
  home?: string;
  existsSync?: (p: string) => boolean;
}

// ── Descriptor shapes (mirroring the registry types) ──────────────────────

interface DotHomeDescriptor {
  kind: 'dot-home';
  name: string;
  env: string[];
}

interface DotHomeNestedDescriptor {
  kind: 'dot-home-nested';
  name: string;
  parent: string;
  env: string[];
  probe?: string[];
}

interface XdgDescriptor {
  kind: 'xdg';
  name: string;
  env: string[];
  skillsHome?: unknown;
}

interface GenericAgentsRootDescriptor {
  kind: 'generic-agents-root';
  name: string;
  env: string[];
  probe: string[];
  probeExists: string;
}

type ConfigHomeDescriptor =
  | DotHomeDescriptor
  | DotHomeNestedDescriptor
  | XdgDescriptor
  | GenericAgentsRootDescriptor;

/**
 * Resolve a configHome descriptor to an absolute directory path.
 *
 * Implements the four descriptor kinds:
 *   - dot-home:           env-override → path.join(home, name)
 *   - dot-home-nested:    env-override → probed subdir of path.join(home, parent)
 *   - xdg:                env[0] → env[1](dirname) → env[2](XDG subdir) → ~/.config/<name>
 *   - generic-agents-root:env[0] → first probe where probeExists exists → probe[0]
 */
export function resolveConfigHomeFromDescriptor(
  configHome: ConfigHomeDescriptor,
  opts: ResolveConfigHomeOpts = {},
): string {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const existsSyncFn = opts.existsSync ?? fs.existsSync;

  switch (configHome.kind) {
    case 'dot-home': {
      // First env var that is set wins
      for (const varName of configHome.env) {
        const val = env[varName];
        if (val) return expandTilde(val);
      }
      return path.join(home, configHome.name);
    }

    case 'dot-home-nested': {
      // env override
      const nestedEnv0Val = env[configHome.env[0]];
      if (configHome.env[0] && nestedEnv0Val) {
        return expandTilde(nestedEnv0Val);
      }
      const base = path.join(home, configHome.parent);
      if (configHome.probe && configHome.probe.length > 0) {
        // probe each candidate under base; return first that exists
        for (const candidate of configHome.probe) {
          const resolved = path.join(base, candidate);
          if (existsSyncFn(resolved)) return resolved;
        }
        // fallback: first probe candidate
        return path.join(base, configHome.probe[0]);
      }
      // no probe (e.g. windsurf): always name under parent
      return path.join(base, configHome.name);
    }

    case 'xdg': {
      // env[0]: direct override dir
      const xdgEnv0Val = env[configHome.env[0]];
      if (configHome.env[0] && xdgEnv0Val) {
        return expandTilde(xdgEnv0Val);
      }
      // env[1]: FILE path → dirname
      const xdgEnv1Val = env[configHome.env[1]];
      if (configHome.env[1] && xdgEnv1Val) {
        return path.dirname(expandTilde(xdgEnv1Val));
      }
      // env[2]: XDG_CONFIG_HOME → subdir
      const xdgEnv2Val = env[configHome.env[2]];
      if (configHome.env[2] && xdgEnv2Val) {
        return path.join(expandTilde(xdgEnv2Val), configHome.name);
      }
      return path.join(home, '.config', configHome.name);
    }

    case 'generic-agents-root': {
      // env override
      const garEnv0Val = env[configHome.env[0]];
      if (configHome.env[0] && garEnv0Val) {
        return expandTilde(garEnv0Val);
      }
      // probe each candidate; return first where probeExists subpath exists
      for (const candidate of configHome.probe) {
        const resolved = expandTildeWithHome(candidate, home);
        if (existsSyncFn(path.join(resolved, configHome.probeExists))) {
          return resolved;
        }
      }
      // fallback: first probe candidate
      return expandTildeWithHome(configHome.probe[0], home);
    }
  }
}

/**
 * Expand ~ using an explicit home directory (for hermetic testing).
 */
function expandTildeWithHome(p: string, home: string): string {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') return path.join(home, p.slice(1));
  return p;
}

/**
 * Resolve Antigravity global config dir across 1.x and 2.x layouts.
 *
 * Thin wrapper delegating to resolveConfigHomeFromDescriptor with the
 * antigravity descriptor shape. Preserved for external callers and tests.
 */
export function resolveAntigravityGlobalDir(opts: ResolveAntigravityOpts = {}): string {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const existsSyncFn = opts.existsSync ?? fs.existsSync;
  return resolveConfigHomeFromDescriptor(
    {
      kind: 'dot-home-nested',
      name: 'antigravity',
      parent: '.gemini',
      env: ['ANTIGRAVITY_CONFIG_DIR'],
      probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
    },
    { env, home, existsSync: existsSyncFn },
  );
}

/**
 * Resolve Kimi's generic user root using Kimi CLI's documented first-existing
 * generic skills directory policy:
 *
 *   1. ~/.config/agents/skills  (recommended)
 *   2. ~/.agents/skills
 *
 * If neither generic skills directory exists yet, install to the recommended
 * ~/.config/agents root so the generated skills become the first generic
 * candidate Kimi discovers.
 *
 * KIMI_CONFIG_DIR is a GSD installer write-location override. It is not Kimi's
 * upstream data-root variable, and arbitrary roots are discoverable by Kimi only
 * when the user also configures Kimi --skills-dir or extra_skill_dirs.
 *
 * Thin wrapper delegating to resolveConfigHomeFromDescriptor with the
 * kimi descriptor shape. Preserved for external callers and tests.
 */
export function resolveKimiGlobalDir(opts: ResolveKimiOpts = {}): string {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const existsSyncFn = opts.existsSync ?? fs.existsSync;
  return resolveConfigHomeFromDescriptor(
    {
      kind: 'generic-agents-root',
      name: 'agents',
      env: ['KIMI_CONFIG_DIR'],
      probe: ['~/.config/agents', '~/.agents'],
      probeExists: 'skills',
    },
    { env, home, existsSync: existsSyncFn },
  );
}

/**
 * Return the global config base directory for the given runtime.
 * Respects the same env-var overrides as bin/install.js getGlobalDir().
 *
 * @param runtime   - The runtime identifier (e.g. 'claude', 'opencode').
 * @param explicitDir - If provided and non-empty, returned immediately after
 *   tilde-expansion, overriding all env-var and default logic. This matches
 *   the behaviour of bin/install.js getGlobalDir(runtime, explicitDir).
 */
export function getGlobalConfigDir(runtime: string, explicitDir?: string | null): string {
  if (explicitDir) return expandTilde(explicitDir);

  // ── Grok: not in the registry — hardcoded branch ─────────────────────────
  if (runtime === 'grok') {
    const env = process.env as Record<string, string | undefined>;
    return env['GROK_AGENTS_HOME'] ? expandTilde(env['GROK_AGENTS_HOME']) : path.join(os.homedir(), '.agents');
  }

  // ── Descriptor-driven: look up in capability-registry ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runtimes } = require('./capability-registry.cjs') as {
    runtimes: Record<string, { runtime?: { configHome: ConfigHomeDescriptor } }>;
  };

  const runtimeEntry = runtimes[runtime];
  if (runtimeEntry?.runtime?.configHome) {
    return resolveConfigHomeFromDescriptor(runtimeEntry.runtime.configHome, {
      env: process.env,
      home: os.homedir(),
      existsSync: fs.existsSync,
    });
  }

  // ── Default (unknown runtime → Claude fallback) ───────────────────────────
  const env = process.env as Record<string, string | undefined>;
  return env['CLAUDE_CONFIG_DIR'] ? expandTilde(env['CLAUDE_CONFIG_DIR']) : path.join(os.homedir(), '.claude');
}

/**
 * Return the global skills base directory for the given runtime.
 * Most runtimes: <configDir>/skills
 * Hermes: <configDir>/skills/gsd  (nested category layout — #2841)
 * Cline ≥ v3.48.0: <configDir>/skills  (SKILL.md-based global skills — #782)
 */
export function getGlobalSkillsBase(runtime: string): string | null {
  if (runtime === 'hermes') {
    const configDir = getGlobalConfigDir(runtime);
    return path.join(configDir, 'skills', 'gsd');
  }
  // Kilo Code discovers global skills from ~/.kilo/skills/ (HOME-relative),
  // independent of the XDG-based config dir (~/.config/kilo) used for commands.
  // See: https://kilo.ai/docs/customize/skills
  // "Global skills are located in the `.kilo` directory within your Home
  //  directory: ~/.kilo/skills/"
  if (runtime === 'kilo') return path.join(os.homedir(), '.kilo', 'skills');
  const configDir = getGlobalConfigDir(runtime);
  return path.join(configDir, 'skills');
}

/**
 * Return the full path to a specific skill's directory for the given runtime.
 */
export function getGlobalSkillDir(runtime: string, skillName: string): string | null {
  const base = getGlobalSkillsBase(runtime);
  if (base === null) return null;
  return path.join(base, skillName);
}

/**
 * Return a human-readable display path for a global skill (for log messages).
 */
export function getGlobalSkillDisplayPath(runtime: string, skillName: string): string {
  const dir = getGlobalSkillDir(runtime, skillName);
  if (!dir) return `(${runtime} does not use a skills directory)`;
  // Replace homedir prefix with ~ for readability
  const home = os.homedir();
  return dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
}
