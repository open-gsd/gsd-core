'use strict';

/**
 * Runtime Hooks Surface Module — hook-surface writer functions extracted from
 * bin/install.js (ADR-857 phase 5f-1).
 *
 * Owns the lifecycle writer functions for hook surfaces managed by GSD on four
 * runtimes:
 *   Cline:   writeClineArtifacts + supporting helpers/constants
 *   Cursor:  buildCursorHookEntry, isManagedCursorHookEntry,
 *            reconcileCursorHooksJson, writeCursorHooksJson, removeCursorHooksJson
 *   Copilot: buildCopilotHookConfig, writeCopilotHookConfig
 *   Codex hooks.json: ensureCodexHooksJsonSessionStart, ensureCodexHooksJsonEvent,
 *            reconcileCodexHooksJsonEvent, reconcileCodexHooksJsonSessionStart,
 *            removeCodexHooksJsonEvent, removeCodexHooksJsonSessionStart,
 *            buildCodexHookWindowsShimIR, buildCodexHookBlock, rewriteLegacyCodexHookBlock
 *   Shared:  buildHookCommand, rewriteLegacyManagedNodeHookCommands
 *
 * BEHAVIOR-PRESERVING RELOCATION: all logic is copied verbatim from
 * bin/install.js. No behavior change, no descriptor reads, no new IO.
 *
 * bin/install.js re-exports every symbol from this module so existing
 * consumers that do require('../bin/install.js').writeCursorHooksJson
 * (etc.) continue to work unchanged.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import shellCmdProjection = require('./shell-command-projection.cjs');
const {
  isManagedHookBasename,
  isManagedHookCommand,
  projectLegacySettingsHookCommand,
  projectManagedHookCommand,
  projectPortableHookBaseDir,
  projectCodexHookTomlCommand,
  shellHookOmitsBashRunner,
} = shellCmdProjection as {
  isManagedHookBasename: (scriptPath: string, opts?: { surface?: string }) => boolean;
  isManagedHookCommand: (cmd: string | null | undefined, opts?: { surface?: string; includeLegacyAliases?: boolean; configDir?: string }) => boolean;
  projectLegacySettingsHookCommand: (opts: { absoluteRunner: string; scriptPath: string; scriptToken: string; runtime: string; platform: string }) => string | null;
  projectManagedHookCommand: (opts: { absoluteRunner: string; scriptPath: string; runtime: string; platform: string }) => string | null;
  projectPortableHookBaseDir: (opts: { configDir: string; homeDir: string }) => string;
  projectCodexHookTomlCommand: (opts: { absoluteRunner: string; scriptPath: string; platform: string }) => string;
  shellHookOmitsBashRunner: (opts: { platform: string; runtime: string; isShellHook: boolean }) => boolean;
};

// ---------------------------------------------------------------------------
// Terminal color constants (mirrors install.js for console output parity)
// ---------------------------------------------------------------------------
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const reset = '\x1b[0m';

// ---------------------------------------------------------------------------
// Codex config.toml constants (subset needed by this module)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Copilot hook constants
// ---------------------------------------------------------------------------
const GSD_COPILOT_HOOK_FILE = 'gsd-session.json';
const GSD_COPILOT_SESSION_MSG_PRESENT =
  'GSD: .planning/STATE.md present - review the current phase and any blockers before acting.';
const GSD_COPILOT_SESSION_MSG_ABSENT =
  'GSD: no .planning/ workflow found - run /gsd-new-project to start a tracked workflow.';
const GSD_COPILOT_SESSION_HOOK_BASH =
  'if [ -f .planning/STATE.md ]; then ' +
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_PRESENT}"}'; else ` +
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_ABSENT}"}'; fi`;
const GSD_COPILOT_SESSION_HOOK_PWSH =
  'if (Test-Path .planning/STATE.md) ' +
  `{ '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_PRESENT}"}' } ` +
  `else { '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_ABSENT}"}' }`;

// ---------------------------------------------------------------------------
// Cursor hook constants
// ---------------------------------------------------------------------------
const GSD_CURSOR_SESSION_HOOK_SCRIPT = 'gsd-cursor-session-start.js';
const GSD_CURSOR_POST_TOOL_HOOK_SCRIPT = 'gsd-cursor-post-tool.js';
const GSD_CURSOR_HOOK_MARKER = 'gsd-managed';

// ---------------------------------------------------------------------------
// Cline / AGENTS.md constants
// ---------------------------------------------------------------------------
const GSD_AGENTS_MD_MARKER = '<!-- GSD Configuration — managed by gsd-core installer -->';
const GSD_AGENTS_MD_CLOSE_MARKER = '<!-- End GSD Configuration -->';

// ---------------------------------------------------------------------------
// atomicWriteFileSync — shared canonical implementation.
//
// __atomicWrittenTmps is exported so bin/install.js can merge it into its
// _cleanTmpFiles() scan, ensuring that atomic writes performed by this
// module (Cursor hooks.json, Codex hooks.json shims) participate in the
// same temp-file cleanup as writes performed directly by install.js.
//
// Every temp path written is recorded in the Set so _cleanTmpFiles() can
// scope cleanup to files this installer process actually created, avoiding
// accidental deletion of unrelated tools' temp files.
// ---------------------------------------------------------------------------
let __atomicWriteCounter = 0;
// Set<string> — absolute paths of .tmp-<pid>-<n> files this process created.
const __atomicWrittenTmps: Set<string> = new Set();

function atomicWriteFileSync(target: string, data: string, options: fs.WriteFileOptions): void {
  __atomicWriteCounter += 1;
  const tmp = `${target}.tmp-${process.pid}-${__atomicWriteCounter}`;
  __atomicWrittenTmps.add(tmp);
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, target);
    // Successful rename: the tmp path no longer exists, but leave it in the
    // Set so _cleanTmpFiles can recognise it as installer-owned if it somehow
    // lingers (e.g. a rename succeeded but left a stale entry on some FS).
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// parseTomlValue + findMultilineBasicStringClose
// (needed by rewriteLegacyCodexHookBlock — pure TOML helpers, no state)
// ---------------------------------------------------------------------------

function findMultilineBasicStringClose(line: string, startIndex: number): number {
  let i = startIndex;
  while (i < line.length) {
    if (line.startsWith('"""', i) && (i === 0 || line[i - 1] !== '\\')) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function parseTomlValue(text: string, i: number): { value: unknown; end: number } {
  // Skip leading whitespace.
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i += 1;
  }
  if (i >= text.length) {
    throw new Error('expected value, got end of input');
  }

  const ch = text[i];

  // Basic string
  if (ch === '"') {
    if (text.startsWith('"""', i)) {
      const close = findMultilineBasicStringClose(text, i + 3);
      if (close === -1) {
        throw new Error('unterminated multi-line basic string');
      }
      const raw = text.slice(i + 3, close);
      return { value: raw.replace(/^\r?\n/, ''), end: close + 3 };
    }
    let j = i + 1;
    let out = '';
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') {
        const next = text[j + 1];
        if (next === 'n') { out += '\n'; j += 2; continue; }
        if (next === 't') { out += '\t'; j += 2; continue; }
        if (next === 'r') { out += '\r'; j += 2; continue; }
        if (next === '\\') { out += '\\'; j += 2; continue; }
        if (next === '"') { out += '"'; j += 2; continue; }
        if (next === '/') { out += '/'; j += 2; continue; }
        out += next === undefined ? '' : next;
        j += 2;
        continue;
      }
      if (c === '"') {
        return { value: out, end: j + 1 };
      }
      out += c;
      j += 1;
    }
    throw new Error('unterminated basic string');
  }

  // Literal string
  if (ch === '\'') {
    if (text.startsWith("'''", i)) {
      const close = text.indexOf("'''", i + 3);
      if (close === -1) throw new Error('unterminated multi-line literal string');
      return { value: text.slice(i + 3, close).replace(/^\r?\n/, ''), end: close + 3 };
    }
    const close = text.indexOf('\'', i + 1);
    if (close === -1) throw new Error('unterminated literal string');
    return { value: text.slice(i + 1, close), end: close + 1 };
  }

  // Boolean
  if (text.startsWith('true', i)) return { value: true, end: i + 4 };
  if (text.startsWith('false', i)) return { value: false, end: i + 5 };

  // Number (integer or float, simplified)
  const numMatch = text.slice(i).match(/^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?|inf|nan)/);
  if (numMatch) {
    const raw = numMatch[0];
    const cleaned = raw.replace(/_/g, '');
    const num = Number(cleaned);
    return { value: isNaN(num) ? cleaned : num, end: i + raw.length };
  }

  // Datetime (simplified passthrough)
  const dtMatch = text.slice(i).match(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/);
  if (dtMatch) {
    return { value: dtMatch[0], end: i + dtMatch[0].length };
  }

  throw new Error(`parseTomlValue: unexpected character '${ch}' at position ${i}`);
}

// ---------------------------------------------------------------------------
// normalizeNodePath / resolveNodeRunner / resolveBashRunner
// (needed by buildHookCommand — verbatim from install.js)
// ---------------------------------------------------------------------------

interface NodeNormOpts {
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
}

function normalizeNodePath(execPath: string, opts?: NodeNormOpts): string {
  if (!execPath) return execPath;
  const env = (opts && opts.env) || process.env;
  const existsSync = (opts && opts.existsSync) || fs.existsSync;

  const normalizedForMatch = execPath.replace(/\\/g, '/');
  if (/\/fnm_multishells\/[0-9]+_[0-9]+\/node(\.exe)?$/i.test(normalizedForMatch)) {
    const candidates: string[] = [];
    if (env.FNM_DIR) {
      candidates.push(`${env.FNM_DIR}/aliases/default/node.exe`);
      candidates.push(`${env.FNM_DIR}/aliases/default/bin/node`);
    }
    if (env.APPDATA) {
      candidates.push(`${env.APPDATA}/fnm/aliases/default/node.exe`);
    }
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    return execPath;
  }

  if (/^\/usr\/local\/Cellar\/node(@\d+)?\/[^/]+\/bin\/node(\.exe)?$/.test(execPath)) {
    return '/usr/local/bin/node';
  }
  if (/^\/opt\/homebrew\/Cellar\/node(@\d+)?\/[^/]+\/bin\/node(\.exe)?$/.test(execPath)) {
    return '/opt/homebrew/bin/node';
  }
  return execPath;
}

function resolveNodeRunner(opts?: NodeNormOpts): string | null {
  const execPath = typeof process.execPath === 'string' ? process.execPath : '';
  if (!execPath) return null;
  const stablePath = normalizeNodePath(execPath, opts);
  return JSON.stringify(stablePath.replace(/\\/g, '/'));
}

interface BashRunnerOpts {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
}

function resolveBashRunner(opts?: BashRunnerOpts): string | null {
  const platform = (opts && opts.platform) || process.platform;
  if (platform !== 'win32') return 'bash';

  const env = (opts && opts.env) || process.env;
  const exists = (opts && opts.existsSync) || fs.existsSync;
  const candidates: string[] = [];
  if (env.GSD_BASH_PATH) candidates.push(env.GSD_BASH_PATH);
  if (env.ProgramFiles) candidates.push(path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (env['ProgramFiles(x86)']) candidates.push(path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  if (env.SystemDrive) {
    candidates.push(path.win32.join(env.SystemDrive, 'Program Files', 'Git', 'bin', 'bash.exe'));
    candidates.push(path.win32.join(env.SystemDrive, 'Program Files (x86)', 'Git', 'bin', 'bash.exe'));
  }

  for (const candidate of candidates) {
    if (candidate && exists(candidate)) {
      return JSON.stringify(candidate.replace(/\\/g, '/'));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared: rewriteLegacyManagedNodeHookCommands
// ---------------------------------------------------------------------------

interface HookEntry {
  command?: string;
  args?: unknown[];
}

interface HookGroup {
  hooks?: HookEntry[];
}

interface SettingsHooks {
  [event: string]: HookGroup[];
}

interface Settings {
  hooks?: SettingsHooks;
}

interface RewriteOpts {
  platform?: string;
  runtime?: string;
}

function rewriteLegacyManagedNodeHookCommands(settings: Settings, absoluteRunner: string, opts?: RewriteOpts): boolean {
  if (!settings || !settings.hooks || !absoluteRunner) return false;
  if (!opts) opts = {};
  const platform = opts.platform || process.platform;
  let changed = false;
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue;
        if (Array.isArray(h.args) && h.args.length > 0) continue;
        let trimmed = h.command.trim();
        const hadPowerShellCallOperator = platform === 'win32' && /^&\s+/.test(trimmed);
        if (hadPowerShellCallOperator) {
          trimmed = trimmed.replace(/^&\s+/, '').trim();
        }
        const m = trimmed.match(/^node\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/) ||
                  trimmed.match(/^("([^"]+)"|'([^']+)'|(\S+))\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/);
        if (!m) continue;

        let _runnerToken: string, scriptToken: string, scriptPath: string;
        if (/^node\s+/.test(trimmed)) {
          _runnerToken = 'node';
          scriptToken = m[1];
          scriptPath = m[2] || m[3] || m[4] || '';
        } else {
          _runnerToken = m[1];
          const runnerPath = (m[2] || m[3] || m[4] || '').replace(/\\/g, '/');
          const stableRunner = normalizeNodePath(runnerPath);
          if (stableRunner === runnerPath && platform !== 'win32') continue;
          scriptToken = m[5];
          scriptPath = m[6] || m[7] || m[8] || '';
        }

        if (!isManagedHookBasename(scriptPath, { surface: 'settings-json' })) continue;

        const projectedCommand = projectLegacySettingsHookCommand({
          absoluteRunner,
          scriptPath,
          scriptToken,
          runtime: opts.runtime || 'generic',
          platform,
        });
        if (!projectedCommand) continue;
        if (h.command === projectedCommand) continue;

        h.command = projectedCommand;
        changed = true;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Codex TOML hook block builder
// ---------------------------------------------------------------------------

interface BuildCodexHookBlockOpts {
  absoluteRunner?: string | null;
  eol?: string;
  platform?: string;
}

function buildCodexHookBlock(targetDir: string, opts?: BuildCodexHookBlockOpts): string | null {
  const absoluteRunner = opts && opts.absoluteRunner;
  if (!absoluteRunner) return null;
  const eol = (opts && opts.eol) || '\n';
  const platform = (opts && opts.platform) || process.platform;
  const updateCheckScript = path.resolve(targetDir, 'hooks', 'gsd-check-update.js');
  const commandValue = projectCodexHookTomlCommand({
    absoluteRunner,
    scriptPath: updateCheckScript,
    platform,
  });
  return `${eol}# GSD Hooks${eol}` +
    `[[hooks.SessionStart]]${eol}` +
    `${eol}` +
    `[[hooks.SessionStart.hooks]]${eol}` +
    `type = "command"${eol}` +
    `command = "${commandValue}"${eol}`;
}

// ---------------------------------------------------------------------------
// Codex TOML legacy-hook rewriter
// ---------------------------------------------------------------------------

interface RewriteLegacyResult {
  content: string;
  changed: boolean;
}

function rewriteLegacyCodexHookBlock(content: string, absoluteRunner: string | null, opts?: { platform?: string }): RewriteLegacyResult {
  if (!content || !absoluteRunner) return { content, changed: false };
  const platform = (opts && opts.platform) || process.platform;
  let changed = false;
  const updated = content.replace(
    /^(command\s*=\s*")node\s+((?:\\"[^"]+\\"|\S+))("\s*)$/gm,
    (full: string, prefix: string, scriptToken: string, suffix: string) => {
      const quoted = scriptToken.match(/^\\"([\s\S]+)\\"$/);
      let scriptPath = scriptToken;
      if (quoted) {
        try {
          scriptPath = String(parseTomlValue(`"${quoted[1]}"`, 0).value);
        } catch {
          scriptPath = quoted[1];
        }
      }
      if (!isManagedHookBasename(scriptPath, { surface: 'codex-toml' })) return full;
      const desiredCommand = projectCodexHookTomlCommand({
        absoluteRunner,
        scriptPath,
        platform,
      });
      const currentCommand = `${prefix}${scriptToken}${suffix}`.replace(/^(command\s*=\s*")|("\s*)$/g, '');
      if (currentCommand === desiredCommand) return full;
      changed = true;
      return `${prefix}${desiredCommand}${suffix}`;
    },
  );
  return { content: updated, changed };
}

// ---------------------------------------------------------------------------
// Codex hooks.json: reconcileCodexHooksJsonEvent
// ---------------------------------------------------------------------------

interface ReconcileCodexOpts {
  managedCommand?: string | null;
  commandWindows?: string | null;
  matcher?: string | null;
  timeout?: number | null;
}

interface ReconcileResult {
  changed: boolean;
  wrote: boolean;
  path: string;
}

function reconcileCodexHooksJsonEvent(targetDir: string, eventName: string, opts: ReconcileCodexOpts = {}): ReconcileResult {
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  const managedCommand = typeof opts.managedCommand === 'string' ? opts.managedCommand : null;
  const commandWindows = typeof opts.commandWindows === 'string' ? opts.commandWindows : null;
  const matcher = typeof opts.matcher === 'string' ? opts.matcher : undefined;
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : undefined;
  let parsed: Record<string, unknown> = {};
  let currentContent: string | null = null;
  if (fs.existsSync(hooksJsonPath)) {
    const raw = fs.readFileSync(hooksJsonPath, 'utf8');
    currentContent = raw;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`hooks.json parse failed: ${err && (err as Error).message ? (err as Error).message : String(err)}`);
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const usesNestedHooksObject =
    parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']);
  const hookTable = usesNestedHooksObject ? (parsed['hooks'] as Record<string, unknown>) : parsed;
  const eventEntries = Array.isArray(hookTable[eventName]) ? (hookTable[eventName] as unknown[]) : [];

  let removedLegacy = false;
  const sanitizedEntries: unknown[] = [];
  for (const entry of eventEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const entryObj = entry as Record<string, unknown>;
    const originalHooks = Array.isArray(entryObj['hooks']) ? (entryObj['hooks'] as unknown[]) : [];
    if (originalHooks.length === 0) {
      sanitizedEntries.push(entry);
      continue;
    }
    const keptHooks = originalHooks.filter((hook) => {
      const cmd = hook && typeof hook === 'object' ? (hook as Record<string, unknown>)['command'] : null;
      const managed = isManagedHookCommand(cmd as string | null | undefined, {
        surface: 'codex-hooks-json',
        includeLegacyAliases: true,
        configDir: targetDir,
      });
      if (managed) removedLegacy = true;
      return !managed;
    });
    if (keptHooks.length === 0) continue;
    const nextEntry = { ...entryObj, hooks: keptHooks };
    sanitizedEntries.push(nextEntry);
  }

  if (managedCommand) {
    const hookEntry: Record<string, unknown> = { type: 'command', command: managedCommand };
    if (commandWindows) hookEntry['commandWindows'] = commandWindows;
    if (timeout !== undefined) hookEntry['timeout'] = timeout;
    const newEntry: Record<string, unknown> = { hooks: [hookEntry] };
    if (matcher !== undefined) newEntry['matcher'] = matcher;
    sanitizedEntries.push(newEntry);
  }

  if (sanitizedEntries.length > 0) {
    hookTable[eventName] = sanitizedEntries;
  } else {
    delete hookTable[eventName];
  }
  if (usesNestedHooksObject) parsed['hooks'] = hookTable;

  const nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
  const changed = currentContent !== nextContent;
  const shouldWrite = changed && (currentContent !== null || Object.keys(parsed).length > 0);
  if (shouldWrite) {
    atomicWriteFileSync(hooksJsonPath, nextContent, 'utf8');
  }

  return { changed: changed || removedLegacy, wrote: shouldWrite, path: hooksJsonPath };
}

// ---------------------------------------------------------------------------
// reconcileCodexHooksJsonSessionStart
// ---------------------------------------------------------------------------

interface ReconcileSessionStartOpts {
  managedCommand?: string | null;
  commandWindows?: string | null;
}

function reconcileCodexHooksJsonSessionStart(targetDir: string, opts: ReconcileSessionStartOpts = {}): ReconcileResult {
  return reconcileCodexHooksJsonEvent(targetDir, 'SessionStart', opts);
}

// ---------------------------------------------------------------------------
// buildCodexHookWindowsShimIR
// ---------------------------------------------------------------------------

interface ShimIR {
  invocation: { interpreter: string; target: string };
  cmdPath: string;
  hookCommand: string;
  eol: { cmd: string };
  passthroughArgs: boolean;
  render: { cmd: () => string };
}

function buildCodexHookWindowsShimIR(scriptAbsPath: string, absoluteRunnerToken: string | null): ShimIR | null {
  if (!absoluteRunnerToken) return null;
  let interpreter: string;
  try {
    interpreter = JSON.parse(absoluteRunnerToken) as string;
  } catch {
    interpreter = absoluteRunnerToken;
  }
  const targetAbs = scriptAbsPath.replace(/\\/g, '/');
  const scriptQuoted = JSON.stringify(targetAbs);
  const cmdPath = scriptAbsPath.replace(/\.js$/, '.cmd');
  const hookCommand = JSON.stringify(cmdPath.replace(/\\/g, '/'));
  const runnerQuoted = JSON.stringify(interpreter);
  return {
    invocation: { interpreter, target: scriptAbsPath },
    cmdPath,
    hookCommand,
    eol: { cmd: '\r\n' },
    passthroughArgs: true,
    render: {
      cmd: () => `@ECHO OFF\r\n@SETLOCAL\r\n@${runnerQuoted} ${scriptQuoted} %*\r\n`,
    },
  };
}

// ---------------------------------------------------------------------------
// ensureCodexHooksJsonSessionStart
// ---------------------------------------------------------------------------

interface EnsureCodexSessionStartOpts {
  absoluteRunner?: string | null;
  platform?: NodeJS.Platform;
}

function ensureCodexHooksJsonSessionStart(targetDir: string, opts: EnsureCodexSessionStartOpts = {}): ReconcileResult {
  const platform = opts.platform || process.platform;
  const absoluteRunner = opts.absoluteRunner || null;
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!absoluteRunner) return { changed: false, wrote: false, path: hooksJsonPath };

  const scriptPath = path.resolve(targetDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/');
  const cmdShimPath = scriptPath.replace(/\.js$/, '.cmd');

  let managedCommand: string | undefined;
  if (platform === 'win32') {
    const shimIR = buildCodexHookWindowsShimIR(scriptPath, absoluteRunner);
    if (!shimIR) return { changed: false, wrote: false, path: hooksJsonPath };
    try {
      atomicWriteFileSync(shimIR.cmdPath, shimIR.render.cmd(), 'utf8');
    } catch (shimWriteErr) {
      const reason = shimWriteErr && (shimWriteErr as Error).message ? (shimWriteErr as Error).message : String(shimWriteErr);
      console.warn(
        `  ${yellow}⚠${reset}  Codex Windows hook NOT installed — .cmd shim write failed: ${reason}. ` +
          `Fix the write error (permissions? disk full?) and re-run the installer. ` +
          `Do NOT use the legacy node.exe command path — it triggers the #3426 bash.exe POSIX-exec failure.`,
      );
      return { changed: false, wrote: false, path: hooksJsonPath };
    }
    managedCommand = shimIR.hookCommand;
  } else {
    managedCommand = projectManagedHookCommand({
      absoluteRunner,
      scriptPath,
      runtime: 'codex',
      platform,
    }) ?? undefined;
  }

  if (!managedCommand) return { changed: false, wrote: false, path: hooksJsonPath };

  const commandWindows = platform === 'win32'
    ? JSON.stringify(cmdShimPath.replace(/\\/g, '/'))
    : undefined;

  return reconcileCodexHooksJsonSessionStart(targetDir, { managedCommand, commandWindows });
}

// ---------------------------------------------------------------------------
// ensureCodexHooksJsonEvent
// ---------------------------------------------------------------------------

interface EnsureCodexEventOpts {
  absoluteRunner?: string | null;
  platform?: NodeJS.Platform;
}

function ensureCodexHooksJsonEvent(targetDir: string, eventName: string, opts: EnsureCodexEventOpts = {}): ReconcileResult {
  const platform = opts.platform || process.platform;
  const absoluteRunner = opts.absoluteRunner || null;
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!absoluteRunner) return { changed: false, wrote: false, path: hooksJsonPath };

  const scriptPath = path.resolve(targetDir, 'hooks', 'gsd-context-monitor.js').replace(/\\/g, '/');

  let managedCommand: string | undefined;
  if (platform === 'win32') {
    const shimIR = buildCodexHookWindowsShimIR(scriptPath, absoluteRunner);
    if (!shimIR) return { changed: false, wrote: false, path: hooksJsonPath };
    try {
      atomicWriteFileSync(shimIR.cmdPath, shimIR.render.cmd(), 'utf8');
    } catch (shimWriteErr) {
      const reason = shimWriteErr && (shimWriteErr as Error).message ? (shimWriteErr as Error).message : String(shimWriteErr);
      console.warn(
        `  ${yellow}⚠${reset}  Codex Windows hook NOT installed — .cmd shim write failed for ${eventName}: ${reason}. ` +
          `Fix the write error (permissions? disk full?) and re-run the installer.`,
      );
      return { changed: false, wrote: false, path: hooksJsonPath };
    }
    managedCommand = shimIR.hookCommand;
  } else {
    managedCommand = projectManagedHookCommand({
      absoluteRunner,
      scriptPath,
      runtime: 'codex',
      platform,
    }) ?? undefined;
  }

  if (!managedCommand) return { changed: false, wrote: false, path: hooksJsonPath };
  return reconcileCodexHooksJsonEvent(targetDir, eventName, { managedCommand, timeout: 10 });
}

// ---------------------------------------------------------------------------
// removeCodexHooksJsonEvent / removeCodexHooksJsonSessionStart
// ---------------------------------------------------------------------------

function removeCodexHooksJsonEvent(targetDir: string, eventName: string): ReconcileResult {
  return reconcileCodexHooksJsonEvent(targetDir, eventName, { managedCommand: null });
}

function removeCodexHooksJsonSessionStart(targetDir: string): ReconcileResult {
  return reconcileCodexHooksJsonSessionStart(targetDir, { managedCommand: null });
}

// ---------------------------------------------------------------------------
// Shared: buildHookCommand
// ---------------------------------------------------------------------------

interface BuildHookCommandOpts {
  portableHooks?: boolean;
  platform?: string;
  runtime?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
}

function buildHookCommand(configDir: string, hookName: string, opts?: BuildHookCommandOpts): string | null {
  if (!opts) opts = {};
  const platform = opts.platform || process.platform;
  const runtime = opts.runtime || 'generic';
  const isShellHook = hookName.endsWith('.sh');

  if (shellHookOmitsBashRunner({ platform, runtime, isShellHook })) {
    if (opts.portableHooks) {
      const portableBaseDir = projectPortableHookBaseDir({
        configDir,
        homeDir: os.homedir(),
      });
      return JSON.stringify(`${portableBaseDir}/hooks/${hookName}`);
    }
    return JSON.stringify(configDir.replace(/\\/g, '/') + '/hooks/' + hookName);
  }

  const nodeRunner = resolveNodeRunner();
  const runner = isShellHook ? resolveBashRunner(opts) : nodeRunner;
  if (runner === null) return null;

  if (opts.portableHooks) {
    const portableBaseDir = projectPortableHookBaseDir({
      configDir,
      homeDir: os.homedir(),
    });
    return projectManagedHookCommand({
      absoluteRunner: runner,
      scriptPath: `${portableBaseDir}/hooks/${hookName}`,
      runtime: opts.runtime || 'generic',
      platform,
    });
  }

  const hooksPath = configDir.replace(/\\/g, '/') + '/hooks/' + hookName;
  return projectManagedHookCommand({
    absoluteRunner: runner,
    scriptPath: hooksPath,
    runtime,
    platform,
  });
}

// ---------------------------------------------------------------------------
// Cline helpers
// ---------------------------------------------------------------------------

function buildClineRulesBody(): string {
  return [
    '# GSD Core — Git. Ship. Done.',
    '',
    '- GSD workflows live in `gsd-core/workflows/`. Load the relevant workflow when',
    '  the user runs a `/gsd-*` command.',
    '- GSD agents live in `agents/`. Use the matching agent when spawning subagents.',
    '- GSD tools are at `gsd-core/bin/gsd-tools.cjs`. Run with `node`.',
    '- Planning artifacts live in `.planning/`. Never edit them outside a GSD workflow.',
    '- Do not apply GSD workflows unless the user explicitly asks for them.',
    '- When a GSD command triggers a deliverable (feature, fix, docs), offer the next',
    '  step to the user using Cline\'s ask_user tool after completing it.',
  ].join('\n') + '\n';
}

function buildClineAgentsMdBody(): string {
  return buildClineRulesBody();
}

function buildClinePreToolUseHook(): string {
  return `#!/usr/bin/env node
'use strict';
/* GSD-managed Cline PreToolUse hook — gsd-core issue #787.
 * Protocol: JSON on stdin -> JSON decision on stdout.
 * Honored fields: { cancel, errorMessage, contextModification }.
 * Fails open: any error allows the operation. */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const allow = () => process.stdout.write(JSON.stringify({ cancel: false }));
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return allow(); }
  try {
    const tool = String(
      input.toolName || input.tool_name || input.tool ||
      (input.toolInput && input.toolInput.name) || (input.tool_input && input.tool_input.name) || ''
    ).toLowerCase();
    const isWrite = /write|edit|replace|create|delete|remove|append|apply|patch|insert|mkdir/.test(tool);
    // Collect only PATH-bearing field values (not free-form content), so a doc
    // that merely mentions ".planning/" in its body is never falsely blocked.
    const paths = [];
    const PATH_KEY = /^(path|file|file_?path|filepath|target_?path|target|dir|directory|uri|filename)$/i;
    const walk = (v, depth) => {
      if (depth > 5 || paths.length > 64) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          const val = v[k];
          if (typeof val === 'string' && PATH_KEY.test(k)) paths.push(val);
          else walk(val, depth + 1);
        }
      }
    };
    walk(input, 0);
    const isPlanningPath = (s) => /(^|[\\\\/])\\.planning([\\\\/]|$)/.test(s);
    if (isWrite && paths.some(isPlanningPath)) {
      return process.stdout.write(JSON.stringify({
        cancel: true,
        errorMessage:
          'GSD: .planning/ artifacts are managed by GSD workflows. Edit them only through a /gsd-* command, not directly.',
      }));
    }
  } catch { /* fall through to allow */ }
  return allow();
});
`;
}

function mergeGsdAgentsMd(filePath: string, gsdContent: string): void {
  const gsdBlock = GSD_AGENTS_MD_MARKER + '\n' + gsdContent.trim() + '\n' + GSD_AGENTS_MD_CLOSE_MARKER;

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, gsdBlock + '\n');
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const openIndex = existing.indexOf(GSD_AGENTS_MD_MARKER);
  const closeIndex = existing.indexOf(GSD_AGENTS_MD_CLOSE_MARKER);

  if (openIndex !== -1 && closeIndex !== -1) {
    const before = existing.substring(0, openIndex).trimEnd();
    const after = existing.substring(closeIndex + GSD_AGENTS_MD_CLOSE_MARKER.length).trimStart();
    let newContent = '';
    if (before) newContent += before + '\n\n';
    newContent += gsdBlock;
    if (after) newContent += '\n\n' + after;
    newContent += '\n';
    fs.writeFileSync(filePath, newContent);
    return;
  }

  fs.writeFileSync(filePath, existing.trimEnd() + '\n\n' + gsdBlock + '\n');
}

// ---------------------------------------------------------------------------
// writeClineArtifacts
// ---------------------------------------------------------------------------

function writeClineArtifacts(targetDir: string, isGlobalInstall: boolean): string[] {
  const written: string[] = [];
  const clinerulesDir = path.join(targetDir, '.clinerules');

  try {
    if (fs.existsSync(clinerulesDir)) {
      const st = fs.lstatSync(clinerulesDir);
      if (st.isFile() || st.isSymbolicLink()) {
        fs.unlinkSync(clinerulesDir);
        console.log(`  ${green}✓${reset} Migrated legacy .clinerules to directory form`);
      }
    }
  } catch { /* best-effort migration */ }

  fs.mkdirSync(clinerulesDir, { recursive: true });
  fs.writeFileSync(path.join(clinerulesDir, 'gsd.md'), buildClineRulesBody());
  written.push('.clinerules/gsd.md');
  console.log(`  ${green}✓${reset} Wrote .clinerules/gsd.md`);

  const hooksDir = path.join(clinerulesDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'PreToolUse');
  fs.writeFileSync(hookPath, buildClinePreToolUseHook());
  try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows: hooks unsupported anyway */ }
  written.push('.clinerules/hooks/PreToolUse');
  console.log(`  ${green}✓${reset} Wrote .clinerules/hooks/PreToolUse`);

  if (isGlobalInstall) {
    try {
      const agentsPath = path.join(os.homedir(), '.agents', 'AGENTS.md');
      mergeGsdAgentsMd(agentsPath, buildClineAgentsMdBody());
      console.log(`  ${green}✓${reset} Merged GSD instructions into ~/.agents/AGENTS.md`);
    } catch (err) {
      console.warn(`  ${yellow}⚠${reset} Could not write ~/.agents/AGENTS.md: ${(err as Error).message}`);
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// Cursor hook functions
// ---------------------------------------------------------------------------

function buildCursorHookEntry(scriptPath: string): Record<string, unknown> {
  return {
    type: 'command',
    command: scriptPath.replace(/\\/g, '/'),
    [GSD_CURSOR_HOOK_MARKER]: true,
  };
}

function isManagedCursorHookEntry(entry: unknown): boolean {
  return Boolean(entry && typeof entry === 'object' && (entry as Record<string, unknown>)[GSD_CURSOR_HOOK_MARKER]);
}

interface CursorManagedEntries {
  sessionStart?: Record<string, unknown> | null;
  postToolUse?: Record<string, unknown> | null;
  [event: string]: Record<string, unknown> | null | undefined;
}

function reconcileCursorHooksJson(hooksJsonPath: string, managedEntries: CursorManagedEntries | null): ReconcileResult {
  let parsed: Record<string, unknown> = {};
  let currentContent: string | null = null;

  if (fs.existsSync(hooksJsonPath)) {
    const raw = fs.readFileSync(hooksJsonPath, 'utf8');
    currentContent = raw;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Cursor hooks.json parse failed: ${err && (err as Error).message ? (err as Error).message : String(err)}`);
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const hasNestedHooksObject =
    parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']);
  if (!hasNestedHooksObject) {
    const eventKeys = ['sessionStart', 'postToolUse'];
    const lifted: Record<string, unknown> = {};
    for (const k of eventKeys) {
      if (Array.isArray(parsed[k])) {
        lifted[k] = parsed[k];
        delete parsed[k];
      }
    }
    parsed['hooks'] = lifted;
  }
  if (!parsed['version']) parsed['version'] = 1;
  const hookTable = parsed['hooks'] as Record<string, unknown>;

  const MANAGED_EVENTS = ['sessionStart', 'postToolUse'];
  const entries = managedEntries || {};

  for (const event of MANAGED_EVENTS) {
    const existing = Array.isArray(hookTable[event]) ? (hookTable[event] as unknown[]) : [];
    const userOwned = existing.filter((e) => !isManagedCursorHookEntry(e));
    const newEntry = entries[event] || null;
    if (newEntry) {
      hookTable[event] = [...userOwned, newEntry];
    } else {
      if (userOwned.length > 0) {
        hookTable[event] = userOwned;
      } else {
        delete hookTable[event];
      }
    }
  }

  const nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
  const changed = currentContent !== nextContent;
  const shouldWrite = changed && (currentContent !== null || Object.keys(parsed).length > 0);
  if (shouldWrite) {
    atomicWriteFileSync(hooksJsonPath, nextContent, 'utf8');
  }

  return { changed: changed, wrote: shouldWrite, path: hooksJsonPath };
}

interface WriteCursorHooksJsonOpts {
  absoluteRunner?: string | null;
  platform?: string;
}

function writeCursorHooksJson(targetDir: string, src: string, opts?: WriteCursorHooksJsonOpts): { hooksJsonPath: string; changed: boolean } {
  opts = opts || {};
  const hooksDir = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookScripts = [GSD_CURSOR_SESSION_HOOK_SCRIPT, GSD_CURSOR_POST_TOOL_HOOK_SCRIPT];
  const srcHooksDir = path.join(src, 'hooks');
  const installedScripts = new Set<string>();
  for (const script of hookScripts) {
    const srcPath = path.join(srcHooksDir, script);
    const destPath = path.join(hooksDir, script);
    if (fs.existsSync(srcPath)) {
      let content = fs.readFileSync(srcPath, 'utf8');
      content = content.replace(/gsd:/gi, 'gsd-');
      fs.writeFileSync(destPath, content);
      try { fs.chmodSync(destPath, 0o755); } catch { /* Windows: ignore chmod */ }
      installedScripts.add(script);
    }
  }

  const hookOpts: BuildHookCommandOpts = { runtime: 'cursor', platform: opts.platform || process.platform };
  const sessionStartCmd = installedScripts.has('gsd-cursor-session-start.js')
    ? buildHookCommand(targetDir, 'gsd-cursor-session-start.js', hookOpts)
    : null;
  const postToolCmd = installedScripts.has('gsd-cursor-post-tool.js')
    ? buildHookCommand(targetDir, 'gsd-cursor-post-tool.js', hookOpts)
    : null;

  const managedEntries: CursorManagedEntries = {};
  if (sessionStartCmd) {
    managedEntries['sessionStart'] = {
      type: 'command',
      command: sessionStartCmd,
      [GSD_CURSOR_HOOK_MARKER]: true,
    };
  }
  if (postToolCmd) {
    managedEntries['postToolUse'] = {
      type: 'command',
      command: postToolCmd,
      [GSD_CURSOR_HOOK_MARKER]: true,
    };
  }

  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  const result = reconcileCursorHooksJson(hooksJsonPath, managedEntries);
  return { hooksJsonPath, changed: result.changed };
}

function removeCursorHooksJson(targetDir: string): { changed: boolean } {
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) return { changed: false };
  const result = reconcileCursorHooksJson(hooksJsonPath, null);
  if (result.changed) {
    try {
      const contentRaw = fs.readFileSync(hooksJsonPath, 'utf8');
      const parsed = JSON.parse(contentRaw) as Record<string, unknown>;
      const hookTable = (parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']))
        ? (parsed['hooks'] as Record<string, unknown>)
        : {};
      const hasAnyEvents = Object.keys(hookTable).some(
        (k) => Array.isArray(hookTable[k]) && (hookTable[k] as unknown[]).length > 0,
      );
      if (!hasAnyEvents) {
        fs.unlinkSync(hooksJsonPath);
        return { changed: true };
      }
    } catch { /* best-effort: leave the file */ }
  }
  return { changed: result.changed };
}

// ---------------------------------------------------------------------------
// Copilot hook functions
// ---------------------------------------------------------------------------

function buildCopilotHookConfig(): Record<string, unknown> {
  return {
    version: 1,
    hooks: {
      sessionStart: [
        {
          type: 'command',
          bash: GSD_COPILOT_SESSION_HOOK_BASH,
          powershell: GSD_COPILOT_SESSION_HOOK_PWSH,
          timeoutSec: 10,
        },
      ],
    },
  };
}

function writeCopilotHookConfig(targetDir: string): string {
  const hooksDir = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, GSD_COPILOT_HOOK_FILE);
  fs.writeFileSync(hookPath, JSON.stringify(buildCopilotHookConfig(), null, 2) + '\n');
  return hookPath;
}

// ---------------------------------------------------------------------------
// referencesHook
//
// Pure predicate — checks whether a hook entry object references a managed
// hook by name.  Covers all three registration shapes used by GSD:
//   • plain command string (standard form)
//   • args array (command+args / wrapped-launcher form used by windowless
//     launchers on Windows and some custom PATH-less environments) (#976)
//   • url field (type:"http" local-server routing form) (#1004)
// Without covering all three, an http-form or args-form entry is invisible
// and a stock string-command entry is appended on every install/update,
// running the hook twice.
//
// Originally declared inside install()/finishInstall() as a local function;
// promoted here so applySettingsJsonHooks() and finishInstall() share one
// copy (ADR-857 phase 5f-1b).
// ---------------------------------------------------------------------------

function referencesHook(h: Record<string, unknown>, hookName: string): boolean {
  const cmd = h['command'];
  const args = h['args'];
  const url = h['url'];
  return (typeof cmd === 'string' && cmd.includes(hookName)) ||
    (Array.isArray(args) && args.some(a => typeof a === 'string' && a.includes(hookName))) ||
    (typeof url === 'string' && url.includes(hookName));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  // Cline
  buildClineRulesBody,
  buildClineAgentsMdBody,
  buildClinePreToolUseHook,
  mergeGsdAgentsMd,
  writeClineArtifacts,
  GSD_AGENTS_MD_MARKER,
  GSD_AGENTS_MD_CLOSE_MARKER,

  // Cursor
  buildCursorHookEntry,
  isManagedCursorHookEntry,
  reconcileCursorHooksJson,
  writeCursorHooksJson,
  removeCursorHooksJson,
  GSD_CURSOR_SESSION_HOOK_SCRIPT,
  GSD_CURSOR_POST_TOOL_HOOK_SCRIPT,
  GSD_CURSOR_HOOK_MARKER,

  // Copilot
  buildCopilotHookConfig,
  writeCopilotHookConfig,
  GSD_COPILOT_HOOK_FILE,

  // Codex hooks.json
  reconcileCodexHooksJsonEvent,
  reconcileCodexHooksJsonSessionStart,
  ensureCodexHooksJsonSessionStart,
  ensureCodexHooksJsonEvent,
  removeCodexHooksJsonEvent,
  removeCodexHooksJsonSessionStart,
  buildCodexHookWindowsShimIR,

  // Codex TOML
  buildCodexHookBlock,
  rewriteLegacyCodexHookBlock,

  // Shared
  buildHookCommand,
  referencesHook,
  rewriteLegacyManagedNodeHookCommands,
  normalizeNodePath,
  resolveNodeRunner,
  resolveBashRunner,

  // Atomic write seam (shared with bin/install.js so all writes participate
  // in install.js's _cleanTmpFiles() scoped temp-cleanup).
  atomicWriteFileSync,
  __atomicWrittenTmps,
};
