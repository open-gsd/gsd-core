/**
 * Runtime name policy — alias resolution and canonicalization for GSD runtime
 * identifiers (ADR-457 build-at-publish: the hand-written
 * bin/lib/runtime-name-policy.cjs collapsed to a TypeScript source of truth).
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
 *
 * Group C cross-import candidate: no bin/lib sibling dependencies; only
 * node:fs and node:path. Once this module is migrated, runtime-slash.cjs
 * (which imports runtime-name-policy.cjs) becomes the first true cross-import
 * proof candidate.
 */

import fs from 'node:fs';
import path from 'node:path';

const FALLBACK_ALIASES: Readonly<Record<string, string[]>> = {
  claude: ['claude', 'claude-code', 'claude-cli'],
  opencode: ['opencode', 'open-code', 'opencode-cli'],
  kilo: ['kilo', 'kilo-cli'],
  gemini: ['gemini', 'gemini-cli', 'gemini-code'],
  codex: ['codex', 'codex-app', 'codex-cli', 'codex_desktop', 'codex-desktop'],
  copilot: ['copilot', 'copilot-cli', 'github-copilot'],
  antigravity: ['antigravity', 'antigravity-cli', 'antigravity-agent'],
  cursor: ['cursor', 'cursor-cli', 'cursor-nightly'],
  windsurf: ['windsurf', 'windsurf-cli', 'windsurf-next', 'devin-desktop'],
  augment: ['augment', 'augment-code', 'augment-cli'],
  trae: ['trae', 'trae-cli'],
  qwen: ['qwen', 'qwen-code', 'qwen-cli'],
  hermes: ['hermes', 'hermes-agent', 'hermes-cli'],
  kimi: ['kimi'],
  codebuddy: ['codebuddy', 'codebuddy-cli'],
  cline: ['cline', 'cline-cli'],
};

function normalizeRuntimeToken(value: string): string {
  return String(value).trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function loadAliasManifest(): Record<string, string[]> {
  const manifestCandidates = [
    path.resolve(__dirname, '..', 'shared', 'runtime-aliases.manifest.json'),
    path.resolve(__dirname, '../../../sdk/shared/runtime-aliases.manifest.json'),
  ];
  for (const manifestPath of manifestCandidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string[]>;
    } catch {
      // Try next candidate.
    }
  }
  return { ...FALLBACK_ALIASES };
}

const aliasManifest = loadAliasManifest();
const aliasToCanonical = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(aliasManifest)) {
  if (typeof canonical !== 'string' || !Array.isArray(aliases)) continue;
  aliasToCanonical.set(normalizeRuntimeToken(canonical), normalizeRuntimeToken(canonical));
  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    aliasToCanonical.set(normalizeRuntimeToken(alias), normalizeRuntimeToken(canonical));
  }
}

export function canonicalizeRuntimeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return aliasToCanonical.get(normalizeRuntimeToken(value)) || null;
}

/**
 * Resolve runtime from a precedence list of candidate values.
 *
 * - First non-empty string candidate wins.
 * - Known aliases are canonicalized (codex-cli -> codex).
 * - Unknown values are normalized and returned (future-runtime tolerance).
 *
 * @param candidates - string candidates in precedence order
 * @returns the resolved runtime name, or null if no valid candidate
 */
export function resolveRuntimeNameFromCandidates(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeRuntimeToken(candidate);
    if (!normalized) continue;
    return canonicalizeRuntimeName(normalized) || normalized;
  }
  return null;
}

/**
 * Map a runtime id to its project instruction file path (relative to project
 * root). Bug #1529: this is the SINGLE source of truth shared by both
 * consumption surfaces —
 *   (A) the Node surface: profile-output.cjs (generate-claude-md handler)
 *   (B) the bash surface: `gsd-tools query project-instruction-file --runtime <r>`,
 *       consumed by gsd-core/workflows/new-project.md to set $INSTRUCTION_FILE
 *
 * Mapping table (per the #1529 issue contract):
 *
 *   claude                      → .claude/CLAUDE.md
 *   codex, opencode, kilo, kimi → AGENTS.md
 *   copilot                     → .github/copilot-instructions.md
 *   antigravity, gemini         → GEMINI.md
 *   unknown / future runtimes   → AGENTS.md (safe cross-agent default)
 *
 * Source-of-truth references for each runtime's read path:
 *   - copilot: GitHub Docs — repository-wide custom instructions are read ONLY
 *     from `.github/copilot-instructions.md`; a root `copilot-instructions.md`
 *     is not a read path. `AGENTS.md` is also read (agent instructions).
 *     https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
 *     (Installer parity: runtime-config-adapter-registry.cts installSurface
 *     'copilot-instructions' writes the same `.github/copilot-instructions.md`.)
 *   - codex/opencode/kilo/kimi: AGENTS.md is the documented cross-agent
 *     instruction file (agentsmd/agents.md convention).
 *   - antigravity/gemini: GEMINI.md is Gemini CLI's contextFileName.
 *
 * Aliases are normalized via `canonicalizeRuntimeName` first, so inputs like
 * `codex-cli` resolve to `codex` → `AGENTS.md`. Replaces the prior codex-only
 * override in profile-output.cjs (#3163) which left AGENTS-native runtimes
 * (opencode/kilo/kimi) incorrectly emitting `.claude/CLAUDE.md`. Pure: no I/O.
 */
export function getProjectInstructionFile(runtime: unknown): string {
  const canonical = canonicalizeRuntimeName(runtime);
  if (canonical === 'claude') return '.claude/CLAUDE.md';
  if (canonical === 'copilot') return '.github/copilot-instructions.md';
  if (canonical === 'antigravity' || canonical === 'gemini') return 'GEMINI.md';
  // codex, opencode, kilo, kimi, AND unknown/future runtimes all default to
  // root AGENTS.md (the safe cross-agent instruction file).
  return 'AGENTS.md';
}

/**
 * Map a canonical runtime id to its on-disk local config directory name
 * (e.g. `cursor` -> `.cursor`, `windsurf` -> `.windsurf`). Unknown/empty inputs
 * fall back to `.claude`.
 *
 * Pure runtime-identity projection. Relocated from `bin/install.js` per
 * ADR-1508 (epic #1507, #1510 Phase 1) so the Runtime Artifact Conversion
 * Module's rewrite engine can consume it without importing the installer.
 * `bin/install.js` re-exports this same function for back-compat.
 */
export function getDirName(runtime: string): string {
  if (!runtime) return '.claude';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runtimes } = require('./capability-registry.cjs') as {
    runtimes: Record<string, { runtime?: { localConfigDir?: string } } | undefined>;
  };
  const dir = runtimes[runtime]?.runtime?.localConfigDir;
  if (typeof dir === 'string' && dir.length > 0) return dir;
  return '.claude';
}

/**
 * Curated short display labels for the install/uninstall console output, keyed
 * by canonical runtime id. The SINGLE source of truth consumed by both
 * `install()` and `uninstall()` in bin/install.js via `getRuntimeLabel`.
 *
 * Collapses the two duplicated `runtimeLabel` assignment chains that previously
 * lived inline in bin/install.js (ADR-1239 Phase B, #1679) — the add-a-host tax:
 * a new runtime meant remembering to add a label line in BOTH chains, and they
 * had drifted out of sync (uninstall omitted `cline` and used a different
 * `kimi` value than install). This table is the curated canonical resolution:
 *   - kimi:  install 'Kimi' / uninstall 'Kimi CLI'  → 'Kimi CLI' (majority + descriptor title)
 *   - cline: install 'Cline' / uninstall (omitted)  → 'Cline'    (majority + descriptor title)
 *
 * Voice: these are the SHORT UI labels, intentionally distinct from the
 * descriptor `title` (the long product name — e.g. "OpenAI Codex CLI",
 * "GitHub Copilot", "Gemini CLI") which serves documentation/registry display,
 * not the install console. A future slice may relocate this to a
 * `runtime.label` descriptor field; until then this table is the source.
 *
 * Lookup is RAW-ID only (no alias expansion) — callers pass an already-
 * canonicalized runtime id, keeping the label surface explicit. Unknown/empty
 * ids fall back to 'Claude Code' (the always-safe default, fail-closed).
 *
 * The drift-guard test (tests/runtime-label-policy.test.cjs) pins this table's
 * id set to the capability-registry runtime id set, so adding/removing a runtime
 * forces a deliberate update here.
 */
const RUNTIME_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  kilo: 'Kilo',
  codex: 'Codex',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  augment: 'Augment',
  trae: 'Trae',
  qwen: 'Qwen Code',
  hermes: 'Hermes Agent',
  kimi: 'Kimi CLI',
  codebuddy: 'CodeBuddy',
  cline: 'Cline',
};

/**
 * Map a canonical runtime id to its short display label for the
 * install/uninstall console output. Unknown/empty inputs fall back to
 * 'Claude Code'. Sibling to `getDirName`; pure (no I/O).
 */
export function getRuntimeLabel(runtime: string): string {
  if (!runtime) return 'Claude Code';
  const label = RUNTIME_LABELS[runtime];
  return typeof label === 'string' && label.length > 0 ? label : 'Claude Code';
}

/**
 * Source-string fragments for the runtime → global config-home path, used by
 * `getConfigDirFromHome` in bin/install.js to template `path.join()` calls in
 * generated hook scripts. Each value is a JS-source snippet (embedded quotes /
 * commas are intentional — it is spliced into generated code as path.join args).
 *
 * Collapses the prior 14-branch `if (runtime === 'x') return "'...'"` chain in
 * bin/install.js (ADR-1239 Phase B / #1679, AC2 slice 2) — the add-a-host tax:
 * a new runtime meant remembering to add a branch here. Values are preserved
 * BYTE-FOR-BYTE from the prior chain; golden install parity asserts generated
 * hook output is unchanged across all 16 runtimes.
 *
 * Two runtimes are intentionally absent (handled by the caller, NOT this table):
 *   - `claude`     → the default; falls through to `DEFAULT_FRAGMENT`.
 *   - `antigravity`→ resolved dynamically via resolveAntigravityGlobalDir +
 *                    path.relative (multi-segment, env-overridable).
 *
 * Unknown/empty ids fall back to the default (`.claude`).
 */
const DEFAULT_CONFIG_HOME_FRAGMENT = "'.claude'";
const GLOBAL_CONFIG_HOME_FRAGMENTS: Readonly<Record<string, string>> = {
  copilot:   "'.copilot'",
  opencode:  "'.config', 'opencode'",
  gemini:    "'.gemini'",
  kilo:      "'.config', 'kilo'",
  codex:     "'.codex'",
  cursor:    "'.cursor'",
  windsurf:  "'.windsurf'",
  augment:   "'.augment'",
  trae:      "'.trae'",
  qwen:      "'.qwen'",
  hermes:    "'.hermes'",
  codebuddy: "'.codebuddy'",
  cline:     "'.cline'",
  kimi:      "'.config', 'agents'",
};

/**
 * Return the global config-home path-fragment source snippet for a runtime
 * (for hook path.join() codegen). `claude`/unknown/empty → the default
 * `'.claude'` fragment. `antigravity` is NOT handled here (caller resolves it
 * dynamically). Pure: no I/O. Sibling to `getDirName` / `getRuntimeLabel`.
 */
export function getGlobalConfigHomeFragment(runtime: string): string {
  if (!runtime) return DEFAULT_CONFIG_HOME_FRAGMENT;
  const frag = GLOBAL_CONFIG_HOME_FRAGMENTS[runtime];
  return typeof frag === 'string' && frag.length > 0 ? frag : DEFAULT_CONFIG_HOME_FRAGMENT;
}

/**
 * The runtime ids for which `bin/install.js` needs an `is<Runtime>` boolean
 * predicate (every installed host that takes a non-claude install branch).
 * Single source of truth — adding a runtime is one entry here, not a per-
 * function declaration block (the add-a-host tax ADR-1239 Phase B / #1679 AC2
 * removes).
 */
const RUNTIME_FLAG_IDS = Object.freeze([
  'opencode', 'kilo', 'gemini', 'codex', 'copilot', 'antigravity', 'cursor',
  'windsurf', 'augment', 'trae', 'qwen', 'hermes', 'codebuddy', 'cline', 'kimi',
] as const);

/**
 * Return a frozen map of `is<Runtime>` boolean predicates for the given runtime
 * id (e.g. `flags.isOpencode`). Collapses the four duplicated `const isX =
 * runtime === 'x'` declaration blocks that lived in `bin/install.js`'s
 * `uninstall`/`writeManifest`/`install`/etc. into one helper (sibling to
 * `getDirName`/`getRuntimeLabel`). Pure: no I/O.
 */
export function runtimeFlags(runtime: string): Readonly<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};
  for (const id of RUNTIME_FLAG_IDS) {
    flags['is' + id.charAt(0).toUpperCase() + id.slice(1)] = runtime === id;
  }
  return Object.freeze(flags);
}

/**
 * The `/gsd-new-project` invocation syntax per runtime — the post-install
 * "next step" command string. Most runtimes use the default `/gsd-new-project`;
 * a few hosts need a different surface syntax. Collapses the 14-line
 * `if (runtime === 'x') command = ...` chain in bin/install.js's next-step
 * message (ADR-1239 Phase B / #1679 AC2). Pure: no I/O.
 */
const DEFAULT_NEW_PROJECT_COMMAND = '/gsd-new-project';
const RUNTIME_NEW_PROJECT_COMMANDS: Readonly<Record<string, string>> = {
  gemini: '/gsd:new-project',
  codex: '$gsd-new-project',
  cursor: 'gsd-new-project (mention the skill name)',
  kimi: '/skill:gsd-new-project',
};

export function getRuntimeNewProjectCommand(runtime: string): string {
  if (!runtime) return DEFAULT_NEW_PROJECT_COMMAND;
  const c = RUNTIME_NEW_PROJECT_COMMANDS[runtime];
  return typeof c === 'string' && c.length > 0 ? c : DEFAULT_NEW_PROJECT_COMMAND;
}
