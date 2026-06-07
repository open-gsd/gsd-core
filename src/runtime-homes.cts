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
 *   cline   — Rules-based; commands are embedded in .clinerules. Cline does
 *             not use a skills/ directory. getGlobalSkillDir() returns null
 *             for cline so the caller can emit an appropriate warning.
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

/**
 * Resolve Antigravity global config dir across 1.x and 2.x layouts.
 */
export function resolveAntigravityGlobalDir(opts: ResolveAntigravityOpts = {}): string {
  const env: Record<string, string | undefined> = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const existsSyncFn = opts.existsSync ?? fs.existsSync;

  if (env['ANTIGRAVITY_CONFIG_DIR']) return expandTilde(env['ANTIGRAVITY_CONFIG_DIR']);

  const base = path.join(home, '.gemini');
  const candidates = [
    path.join(base, 'antigravity'),
    path.join(base, 'antigravity-ide'),
    path.join(base, 'antigravity-cli'),
  ];
  for (const candidate of candidates) {
    if (existsSyncFn(candidate)) return candidate;
  }

  return path.join(base, 'antigravity');
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

  const home = os.homedir();
  const env = process.env as Record<string, string | undefined>;

  switch (runtime) {
    // ── Claude Code ──────────────────────────────────────────────────────────
    case 'claude':
      return env['CLAUDE_CONFIG_DIR'] ? expandTilde(env['CLAUDE_CONFIG_DIR']) : path.join(home, '.claude');

    // ── Cursor ───────────────────────────────────────────────────────────────
    case 'cursor':
      return env['CURSOR_CONFIG_DIR'] ? expandTilde(env['CURSOR_CONFIG_DIR']) : path.join(home, '.cursor');

    // ── Gemini CLI ───────────────────────────────────────────────────────────
    case 'gemini':
      return env['GEMINI_CONFIG_DIR'] ? expandTilde(env['GEMINI_CONFIG_DIR']) : path.join(home, '.gemini');

    // ── Codex ────────────────────────────────────────────────────────────────
    case 'codex':
      return env['CODEX_HOME'] ? expandTilde(env['CODEX_HOME']) : path.join(home, '.codex');

    // ── Grok Build ───────────────────────────────────────────────────────────
    case 'grok':
      return env['GROK_AGENTS_HOME'] ? expandTilde(env['GROK_AGENTS_HOME']) : path.join(home, '.agents');

    // ── Copilot (VS Code) ────────────────────────────────────────────────────
    case 'copilot':
      if (env['COPILOT_CONFIG_DIR']) return expandTilde(env['COPILOT_CONFIG_DIR']);
      if (env['COPILOT_HOME']) return expandTilde(env['COPILOT_HOME']);
      return path.join(home, '.copilot');

    // ── Antigravity ──────────────────────────────────────────────────────────
    case 'antigravity':
      return resolveAntigravityGlobalDir({ env, home });

    // ── Windsurf ─────────────────────────────────────────────────────────────
    case 'windsurf':
      return env['WINDSURF_CONFIG_DIR']
        ? expandTilde(env['WINDSURF_CONFIG_DIR'])
        : path.join(home, '.codeium', 'windsurf');

    // ── Augment ──────────────────────────────────────────────────────────────
    case 'augment':
      return env['AUGMENT_CONFIG_DIR'] ? expandTilde(env['AUGMENT_CONFIG_DIR']) : path.join(home, '.augment');

    // ── Trae ─────────────────────────────────────────────────────────────────
    case 'trae':
      return env['TRAE_CONFIG_DIR'] ? expandTilde(env['TRAE_CONFIG_DIR']) : path.join(home, '.trae');

    // ── Qwen Code ────────────────────────────────────────────────────────────
    case 'qwen':
      return env['QWEN_CONFIG_DIR'] ? expandTilde(env['QWEN_CONFIG_DIR']) : path.join(home, '.qwen');

    // ── Hermes Agent ─────────────────────────────────────────────────────────
    case 'hermes':
      return env['HERMES_HOME'] ? expandTilde(env['HERMES_HOME']) : path.join(home, '.hermes');

    // ── CodeBuddy ────────────────────────────────────────────────────────────
    case 'codebuddy':
      return env['CODEBUDDY_CONFIG_DIR'] ? expandTilde(env['CODEBUDDY_CONFIG_DIR']) : path.join(home, '.codebuddy');

    // ── Cline ────────────────────────────────────────────────────────────────
    case 'cline':
      return env['CLINE_CONFIG_DIR'] ? expandTilde(env['CLINE_CONFIG_DIR']) : path.join(home, '.cline');

    // ── OpenCode (XDG) ───────────────────────────────────────────────────────
    case 'opencode': {
      if (env['OPENCODE_CONFIG_DIR']) return expandTilde(env['OPENCODE_CONFIG_DIR']);
      if (env['OPENCODE_CONFIG']) return path.dirname(expandTilde(env['OPENCODE_CONFIG']));
      if (env['XDG_CONFIG_HOME']) return path.join(expandTilde(env['XDG_CONFIG_HOME']), 'opencode');
      return path.join(home, '.config', 'opencode');
    }

    // ── Kilo (XDG) ───────────────────────────────────────────────────────────
    case 'kilo': {
      if (env['KILO_CONFIG_DIR']) return expandTilde(env['KILO_CONFIG_DIR']);
      if (env['KILO_CONFIG']) return path.dirname(expandTilde(env['KILO_CONFIG']));
      if (env['XDG_CONFIG_HOME']) return path.join(expandTilde(env['XDG_CONFIG_HOME']), 'kilo');
      return path.join(home, '.config', 'kilo');
    }

    // ── Default (Claude fallback) ─────────────────────────────────────────────
    default:
      return env['CLAUDE_CONFIG_DIR'] ? expandTilde(env['CLAUDE_CONFIG_DIR']) : path.join(home, '.claude');
  }
}

/**
 * Return the global skills base directory for the given runtime.
 * Most runtimes: <configDir>/skills
 * Hermes: <configDir>/skills/gsd  (nested category layout — #2841)
 * Cline:  null (rules-based, no skills directory)
 */
export function getGlobalSkillsBase(runtime: string): string | null {
  if (runtime === 'cline') return null;
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
 * Returns null for runtimes that don't use a skills directory (cline).
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
