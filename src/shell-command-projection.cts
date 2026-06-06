/**
 * Shell Command Projection Module
 *
 * Tracer-bullet seam for runtime-aware projection of serialized command text
 * that GSD writes into runtime config or prints for copy/paste. This module
 * does NOT execute commands; it only renders command text for external shells
 * and runtimes.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/shell-command-projection.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import path from 'node:path';
import fs from 'node:fs';
// Use non-destructured namespace import so test-time mock.method(childProcess, 'spawnSync')
// can intercept calls from this seam — destructured imports capture references
// at load time and become un-mockable.
import childProcess from 'node:child_process';

/**
 * Return true when a managed hook command must be prefixed with PowerShell's
 * call operator so a quoted executable token is invokable by the target
 * runtime/shell combination.
 *
 * Current evidence-backed policy:
 * - Gemini on Windows requires `& ` for quoted node/bash runners.
 * - Claude Code on Windows does NOT: its hook commands execute under bash/Git
 *   Bash and `& ` breaks there (#3413).
 *
 * Keep the policy conservative until another runtime has a verified need.
 */
export function hookCommandNeedsPowerShellCallOperator(opts: { platform?: string; runtime?: string } = {}): boolean {
  const platform = opts.platform || process.platform;
  const runtime = opts.runtime || 'generic';
  return platform === 'win32' && runtime === 'gemini';
}

/**
 * Project a fully-assembled hook command string for the target runtime.
 */
export function formatHookCommandForRuntime(command: string, opts: { platform?: string; runtime?: string } = {}): string {
  return hookCommandNeedsPowerShellCallOperator(opts) ? `& ${command}` : command;
}

// #166/#580: Claude Code on Windows executes hook command strings inside Git
// Bash. A `.sh` hook wrapped with an explicit bash.exe path makes bash try to
// exec bash itself ("C:/.../bash.exe: cannot execute binary file"). Both install
// paths — global (buildHookCommand) and local (buildLocalShellHookCommand) — must
// drop the bash runner in this case and emit only the anchored script path.
// Centralized here so the two paths cannot silently drift apart again: the local
// path missed this guard and reintroduced the #166/#377 failure (#580).
export function shellHookOmitsBashRunner({ platform, runtime = 'generic', isShellHook = false }: { platform?: string; runtime?: string; isShellHook?: boolean } = {}): boolean {
  const p = platform ?? process.platform;
  return p === 'win32' && runtime === 'claude' && isShellHook;
}

// Builds the command string for a local-install managed `.sh` hook. Mirrors the
// global buildHookCommand path but uses the $CLAUDE_PROJECT_DIR-anchored prefix
// instead of an absolute configDir. On Claude/Windows the bash runner is dropped
// (see shellHookOmitsBashRunner) and the anchored script path is emitted alone —
// matching the global path. Elsewhere the resolved bash runner is required; a
// null runner yields null so callers skip registration instead of emitting a
// broken hook (#3393).
export function buildLocalShellHookCommand({ localPrefix, hookFile, bashRunner, runtime = 'generic', platform = process.platform }: {
  localPrefix?: string | null;
  hookFile?: string | null;
  bashRunner?: string | null;
  runtime?: string;
  platform?: string;
}): string | null {
  if (!localPrefix || !hookFile) return null;
  const scriptPath = `${localPrefix}/hooks/${hookFile}`;
  if (shellHookOmitsBashRunner({ platform, runtime, isShellHook: true })) {
    return formatHookCommandForRuntime(scriptPath, { platform, runtime });
  }
  if (!bashRunner) return null;
  return projectShellCommandText({
    runnerToken: bashRunner,
    argTokens: [scriptPath],
    runtime,
    platform,
  });
}

/**
 * Project a managed hook script path token for serialized shell commands.
 * Windows managed hook commands normalize to forward slashes so the same path
 * survives JSON/TOML/config surfaces consistently.
 */
export function formatManagedHookScriptToken(scriptPath: string, opts: { platform?: string } = {}): string | null {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return null;
  return JSON.stringify(scriptPath.replace(/\\/g, '/'));
}

export function projectLocalHookPrefix({ runtime = 'claude', dirName }: { runtime?: string; dirName?: string | null }): string | undefined | null {
  if (!dirName) return dirName;
  return (runtime === 'gemini' || runtime === 'antigravity')
    ? dirName
    : `"$CLAUDE_PROJECT_DIR"/${dirName}`;
}

export function projectPortableHookBaseDir({ configDir, homeDir }: { configDir?: string | null; homeDir?: string | null }): string {
  const normalizedConfigDir = String(configDir || '').replace(/\\/g, '/');
  const normalizedHome = String(homeDir || '').replace(/\\/g, '/');
  if (!normalizedConfigDir || !normalizedHome) return normalizedConfigDir;
  return normalizedConfigDir.startsWith(normalizedHome)
    ? '$HOME' + normalizedConfigDir.slice(normalizedHome.length)
    : normalizedConfigDir;
}

export function projectShellCommandText({
  runnerToken,
  argTokens = [],
  runtime = 'generic',
  platform = process.platform,
}: {
  runnerToken?: string | null;
  argTokens?: (string | null | undefined)[];
  runtime?: string;
  platform?: string;
}): string | null {
  if (!runnerToken) return null;
  const parts = [runnerToken, ...argTokens.filter(Boolean)] as string[];
  return formatHookCommandForRuntime(parts.join(' '), { platform, runtime });
}

export function projectManagedHookCommand({ absoluteRunner, scriptPath, runtime = 'generic', platform = process.platform }: {
  absoluteRunner?: string | null;
  scriptPath?: string | null;
  runtime?: string;
  platform?: string;
}): string | null {
  if (!absoluteRunner || !scriptPath) return null;
  const normalizedScriptPath = platform === 'win32' ? scriptPath.replace(/\\/g, '/') : scriptPath;
  return projectShellCommandText({
    runnerToken: absoluteRunner,
    argTokens: [JSON.stringify(normalizedScriptPath)],
    runtime,
    platform,
  });
}

const MANAGED_HOOK_BASENAMES_BY_SURFACE: Record<string, Set<string>> = {
  'settings-json': new Set([
    'gsd-check-update.js',
    'gsd-statusline.js',
    'gsd-context-monitor.js',
    'gsd-prompt-guard.js',
    'gsd-read-guard.js',
    'gsd-read-injection-scanner.js',
    'gsd-update-banner.js',
    'gsd-workflow-guard.js',
  ]),
  'codex-toml': new Set([
    'gsd-check-update.js',
  ]),
};

const MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE: Record<string, Set<string>> = {
  'settings-json': new Set([
    'gsd-check-update.js',
    'gsd-statusline.js',
    'gsd-context-monitor.js',
    'gsd-prompt-guard.js',
    'gsd-read-guard.js',
    'gsd-read-injection-scanner.js',
    'gsd-update-banner.js',
    'gsd-workflow-guard.js',
    'gsd-session-state.sh',
    'gsd-validate-commit.sh',
    'gsd-phase-boundary.sh',
  ]),
  'codex-toml': new Set([
    'gsd-check-update.js',
  ]),
  'codex-hooks-json': new Set([
    'gsd-check-update.js',
    // #3426: Windows .cmd shim for Codex hook — must be treated as managed so
    // reconcileCodexHooksJsonSessionStart can replace stale node-runner commands
    // with the .cmd shim on reinstall (and vice-versa on cross-platform moves).
    'gsd-check-update.cmd',
  ]),
};

const LEGACY_MANAGED_HOOK_ALIASES_BY_SURFACE: Record<string, Set<string>> = {
  'codex-toml': new Set([
    'gsd-update-check.js',
  ]),
  'codex-hooks-json': new Set([
    'gsd-update-check.js',
  ]),
};

function managedHookSurfaceSet(surface: string = 'settings-json'): Set<string> {
  return MANAGED_HOOK_BASENAMES_BY_SURFACE[surface] || MANAGED_HOOK_BASENAMES_BY_SURFACE['settings-json'];
}

export function isManagedHookBasename(scriptPathOrBasename: string | null | undefined, opts: { surface?: string } = {}): boolean {
  if (!scriptPathOrBasename) return false;
  const surface = opts.surface || 'settings-json';
  const basename = String(scriptPathOrBasename).split(/[\\/]/).pop() || '';
  return managedHookSurfaceSet(surface).has(basename);
}

function managedHookCommandSurfaceSet(surface: string = 'settings-json', includeLegacyAliases: boolean = false): Set<string> {
  const base = MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE[surface]
    || MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE['settings-json'];
  if (!includeLegacyAliases) return base;
  const aliases = LEGACY_MANAGED_HOOK_ALIASES_BY_SURFACE[surface];
  if (!aliases || aliases.size === 0) return base;
  return new Set([...base, ...aliases]);
}

export function isManagedHookCommand(commandText: unknown, opts: { surface?: string; includeLegacyAliases?: boolean; configDir?: string } = {}): boolean {
  if (typeof commandText !== 'string') return false;
  const surface = opts.surface || 'settings-json';
  const includeLegacyAliases = opts.includeLegacyAliases === true;
  const managedBasenames = managedHookCommandSurfaceSet(surface, includeLegacyAliases);
  if (!managedBasenames || managedBasenames.size === 0) return false;
  const normalizedCommand = commandText.replace(/\\/g, '/');

  if (typeof opts.configDir === 'string' && opts.configDir.length > 0) {
    const normalizedHooksDir = `${path.join(opts.configDir, 'hooks').replace(/\\/g, '/')}/`;
    if (!normalizedCommand.includes(normalizedHooksDir)) return false;
  }

  for (const basename of managedBasenames) {
    const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[\\\\/\\s"'` + '`' + `])${escapedBasename}(?=$|[\\s"'` + '`' + `])`);
    if (pattern.test(normalizedCommand)) return true;
  }
  return false;
}

/**
 * Projection helper for legacy settings.json hook rewrites.
 *
 * Non-Windows keeps the original script token shape when provided (single
 * quote / bareword / quoted), while Windows normalizes to double-quoted
 * forward-slash path tokens for stable cross-shell behavior.
 */
export function projectLegacySettingsHookCommand({
  absoluteRunner,
  scriptPath,
  scriptToken,
  runtime = 'generic',
  platform = process.platform,
}: {
  absoluteRunner?: string | null;
  scriptPath?: string | null;
  scriptToken?: string | null;
  runtime?: string;
  platform?: string;
}): string | null {
  if (!absoluteRunner || !scriptPath) return null;
  const normalizedScriptPath = platform === 'win32' ? scriptPath.replace(/\\/g, '/') : scriptPath;
  const commandScriptToken = platform === 'win32'
    ? JSON.stringify(normalizedScriptPath)
    : (scriptToken || JSON.stringify(normalizedScriptPath));
  return projectShellCommandText({
    runnerToken: absoluteRunner,
    argTokens: [commandScriptToken],
    runtime,
    platform,
  });
}

export function escapeTomlDoubleQuotedString(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function projectCodexHookTomlCommand({ absoluteRunner, scriptPath, platform = process.platform }: {
  absoluteRunner?: string | null;
  scriptPath?: string | null;
  platform?: string;
}): string | null {
  const command = projectManagedHookCommand({
    absoluteRunner,
    scriptPath,
    runtime: 'codex',
    platform,
  });
  return command === null ? null : escapeTomlDoubleQuotedString(command);
}

export function escapePowerShellSingleQuoted(value: unknown): string {
  return String(value).replace(/'/g, "''");
}

export function escapePosixDoubleQuoted(value: unknown): string {
  return String(value).replace(/[\\$"`]/g, '\\$&');
}

export function escapeSingleQuotedShellLiteral(value: unknown): string {
  return String(value).replace(/'/g, "'\\''");
}

interface ShellAction {
  label: string | null;
  shell: string;
  command: string;
}

export function renderShellActionLines(shellActions: ShellAction[] = []): string[] {
  return shellActions.map((action) => {
    if (!action || !action.command) return '';
    return action.label ? `${action.label}: ${action.command}` : action.command;
  }).filter(Boolean);
}

export function projectPathActionProjection({
  mode = 'repair',
  targetDir,
  platform = process.platform,
}: {
  mode?: string;
  targetDir?: string | null;
  platform?: string;
}): { shellActions: ShellAction[]; actionLines: string[] } {
  if (!targetDir) return { shellActions: [], actionLines: [] };

  const isWin32 = platform === 'win32';

  let shellActions: ShellAction[];
  if (isWin32) {
    const psTargetDir = escapePowerShellSingleQuoted(targetDir);
    const bashTargetDir = escapeSingleQuotedShellLiteral(String(targetDir).replace(/\\/g, '/'));
    shellActions = [
      {
        label: 'PowerShell',
        shell: 'powershell',
        command: `[Environment]::SetEnvironmentVariable('PATH', '${psTargetDir};' + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')`,
      },
      {
        label: 'cmd.exe',
        shell: 'cmd',
        command: `powershell -Command "[Environment]::SetEnvironmentVariable('PATH', '${psTargetDir};' + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')"`,
      },
      {
        label: 'Git Bash',
        shell: 'bash',
        command: `echo 'export PATH="${bashTargetDir}:$PATH"' >> ~/.bashrc`,
      },
    ];
  } else if (mode === 'persist') {
    const bashTargetDir = escapeSingleQuotedShellLiteral(String(targetDir));
    shellActions = [
      {
        label: 'zsh',
        shell: 'zsh',
        command: `echo 'export PATH="${bashTargetDir}:$PATH"' >> ~/.zshrc`,
      },
      {
        label: 'bash',
        shell: 'bash',
        command: `echo 'export PATH="${bashTargetDir}:$PATH"' >> ~/.bashrc`,
      },
      {
        // fish is not POSIX-compatible: it has no `export` and persists PATH
        // through the universal-variable store, not an rc file. `fish_add_path`
        // is the idempotent, deduplicating fish 3.2+ native API (#323). The
        // value is single-quote-escaped consistently with the bash/zsh siblings.
        label: 'fish',
        shell: 'fish',
        command: `fish_add_path '${bashTargetDir}'`,
      },
    ];
  } else {
    const posixTargetDir = escapePosixDoubleQuoted(targetDir);
    shellActions = [
      {
        label: null,
        shell: 'posix',
        command: `export PATH="${posixTargetDir}:$PATH"`,
      },
    ];
  }

  return {
    shellActions,
    actionLines: renderShellActionLines(shellActions),
  };
}

export function projectPersistentPathExportActions({ targetDir, platform = process.platform }: {
  targetDir?: string | null;
  platform?: string;
}): { shellActions: ShellAction[] } {
  const projected = projectPathActionProjection({
    mode: 'persist',
    targetDir,
    platform,
  });
  return { shellActions: projected.shellActions };
}


// ─── Subprocess dispatch ──────────────────────────────────────────────────────

interface SpawnResultOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

function _spawnResult(result: { error?: NodeJS.ErrnoException | null; status?: number | null; stdout?: Buffer | string | null; stderr?: Buffer | string | null; signal?: NodeJS.Signals | null }, program: string): SpawnResultOutput {
  if (result.error && result.error.code === 'ENOENT') {
    return { exitCode: 127, stdout: '', stderr: `${program}: not found`, signal: null, error: result.error };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
    signal: result.signal ?? null,
    error: result.error ?? null,
  };
}

export function execGit(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): SpawnResultOutput {
  // Non-interactive defaults: a hung credential prompt or terminal-input
  // probe must surface as a timeout, not block the tool forever. Callers
  // can override via opts.env.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...(opts.env || {}),
  };
  const result = childProcess.spawnSync('git', args, {
    cwd: opts.cwd,
    env,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 10_000,
    windowsHide: true,
  });
  return _spawnResult(result, 'git');
}

export function execNpm(args: string[], opts: { cwd?: string; timeout?: number } = {}): SpawnResultOutput {
  const result = childProcess.spawnSync('npm', args, {
    cwd: opts.cwd,
    shell: process.platform === 'win32',
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 15_000,
    windowsHide: true,
  });
  return _spawnResult(result, 'npm');
}

export function execTool(program: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): SpawnResultOutput {
  const result = childProcess.spawnSync(program, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    windowsHide: true,
  });
  return _spawnResult(result, program);
}

export function probeTty(opts: { platform?: string } = {}): string | null {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return null;
  try {
    const ttyPath = childProcess.execFileSync('tty', [], {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'ignore'],
    }).trim();
    if (!ttyPath || ttyPath === 'not a tty') return null;
    return ttyPath;
  } catch {
    return null;
  }
}

// ─── Platform file I/O ────────────────────────────────────────────────────────

function _normalizeMd(content: string): string {
  if (!content || typeof content !== 'string') return content;
  let text = content.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const result: string[] = [];
  const fenceRegex = /^```/;
  const insideFence = new Array<boolean>(lines.length);
  let fenceOpen = false;
  for (let i = 0; i < lines.length; i++) {
    if (fenceRegex.test(lines[i].trimEnd())) {
      if (fenceOpen) {
        insideFence[i] = false;
        fenceOpen = false;
      } else {
        insideFence[i] = false;
        fenceOpen = true;
      }
    } else {
      insideFence[i] = fenceOpen;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : '';
    const prevTrimmed = prev.trimEnd();
    const trimmed = line.trimEnd();
    const isFenceLine = fenceRegex.test(trimmed);
    if (/^#{1,6}\s/.test(trimmed) && i > 0 && prevTrimmed !== '' && prevTrimmed !== '---') result.push('');
    if (isFenceLine && i > 0 && prevTrimmed !== '' && !insideFence[i] && (i === 0 || !insideFence[i - 1] || isFenceLine)) {
      if (i === 0 || !insideFence[i - 1]) result.push('');
    }
    if (/^(\s*[-*+]\s|\s*\d+\.\s)/.test(line) && i > 0 && prevTrimmed !== '' && !/^(\s*[-*+]\s|\s*\d+\.\s)/.test(prev) && prevTrimmed !== '---') result.push('');
    result.push(line);
    if (/^#{1,6}\s/.test(trimmed) && i < lines.length - 1 && (lines[i + 1] ?? '').trimEnd() !== '') result.push('');
    if (/^```\s*$/.test(trimmed) && i > 0 && insideFence[i - 1] && i < lines.length - 1 && (lines[i + 1] ?? '').trimEnd() !== '') result.push('');
    if (/^(\s*[-*+]\s|\s*\d+\.\s)/.test(line) && i < lines.length - 1) {
      const next = lines[i + 1];
      if (next !== undefined && next.trimEnd() !== '' && !/^(\s*[-*+]\s|\s*\d+\.\s)/.test(next) && !/^\s/.test(next)) result.push('');
    }
  }
  text = result.join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\n*$/, '\n');
  return text;
}

export function normalizeContent(filePath: string, content: string, opts: { encoding?: BufferEncoding } = {}): { content: string; encoding: BufferEncoding } {
  const encoding = opts.encoding ?? 'utf-8';
  const isMd = path.extname(filePath).toLowerCase() === '.md';
  let normalized: string;
  if (isMd) {
    normalized = _normalizeMd(content);
  } else {
    normalized = (content ?? '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  }
  return { content: normalized, encoding };
}

export function platformWriteSync(filePath: string, content: string, opts: { encoding?: BufferEncoding } = {}): void {
  const { content: normalized, encoding } = normalizeContent(filePath, content, opts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, normalized, encoding);
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    fs.writeFileSync(filePath, normalized, encoding);
  }
}

export function platformReadSync(filePath: string, opts: { encoding?: BufferEncoding; required?: boolean } = {}): string | null {
  const encoding = opts.encoding ?? 'utf-8';
  try {
    return fs.readFileSync(filePath, encoding);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      if (opts.required) throw err;
      return null;
    }
    throw err;
  }
}

export function platformEnsureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
