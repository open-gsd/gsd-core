'use strict';
/**
 * Profile-pipeline command router — CLI dispatcher for gsd-tools profiling commands.
 *
 * ADR-857 phase 6 / ADR-959: profile-pipeline capability command cutover.
 * Extracted from hardcoded case arms in gsd-tools.cjs (lines 1324-1410).
 * Dispatch path: default → dispatchCapabilityCommand →
 *   require(profile-pipeline-command-router.cjs) → route<X>.
 *
 * Router signature: { args, cwd, raw, error } — identical to existing routers.
 * Test seams: _pipeline / _output inject mock modules; _core injects mock core.
 *
 * Async note: cmdExtractMessages and cmdProfileSample are async functions.
 * dispatchCapabilityCommand (gsd-tools.cjs:366-371) explicitly errors if a
 * router returns a Promise. Therefore these router functions call the async
 * function WITHOUT await and WITHOUT returning the Promise. The async functions
 * end with output() or process.exit() so the process terminates correctly once
 * the event loop drains. Unhandled rejections are caught by the .catch() wrapper
 * to surface errors via the error() callback.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ERROR_REASON } = require('./io.cjs');

// ─── Pipeline phase commands ───────────────────────────────────────────────────

function routeScanSessions({ args, cwd, raw, error, _pipeline }) {
  void cwd; void error;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const p = _pipeline ?? require('./profile-pipeline.cjs');
  const pathIdx = args.indexOf('--path');
  const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
  const verboseFlag = args.includes('--verbose');
  const jsonFlag = args.includes('--json');
  // cmdScanSessions is synchronous — call directly.
  p.cmdScanSessions(sessionsPath, { verbose: verboseFlag, json: jsonFlag }, raw);
}

function routeExtractMessages({ args, cwd, raw, error, _pipeline }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const p = _pipeline ?? require('./profile-pipeline.cjs');
  const sessionIdx = args.indexOf('--session');
  const sessionId = sessionIdx !== -1 ? args[sessionIdx + 1] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const pathIdx = args.indexOf('--path');
  const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
  // args[0] = 'extract-messages' (family name), args[1] = project positional
  const projectArg = args[1];
  if (!projectArg || projectArg.startsWith('--')) {
    error('Usage: gsd-tools extract-messages <project> [--session <id>] [--limit N] [--path <dir>]\nRun scan-sessions first to see available projects.', ERROR_REASON.USAGE);
    return;
  }
  // cmdExtractMessages is async — do NOT return the Promise.
  // The function ends with output() or process.exit(); the event loop will drain.
  void cwd;
  p.cmdExtractMessages(projectArg, { sessionId, limit }, raw, sessionsPath)
    .catch(e => { error(e && e.message ? e.message : String(e)); });
}

function routeProfileSample({ args, cwd, raw, error, _pipeline }) {
  void cwd; void error;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const p = _pipeline ?? require('./profile-pipeline.cjs');
  const pathIdx = args.indexOf('--path');
  const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 150;
  const maxPerIdx = args.indexOf('--max-per-project');
  const maxPerProject = maxPerIdx !== -1 ? parseInt(args[maxPerIdx + 1], 10) : null;
  const maxCharsIdx = args.indexOf('--max-chars');
  const maxChars = maxCharsIdx !== -1 ? parseInt(args[maxCharsIdx + 1], 10) : 500;
  // cmdProfileSample is async — do NOT return the Promise.
  p.cmdProfileSample(sessionsPath, { limit, maxPerProject, maxChars }, raw)
    .catch(e => { error(e && e.message ? e.message : String(e)); });
}

// ─── Output phase commands ─────────────────────────────────────────────────────

function routeWriteProfile({ args, cwd, raw, error, _output }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const o = _output ?? require('./profile-output.cjs');
  const inputIdx = args.indexOf('--input');
  const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : null;
  if (!inputPath) {
    error('--input <analysis-json-path> is required', ERROR_REASON.USAGE);
    return;
  }
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  o.cmdWriteProfile(cwd, { input: inputPath, output: outputPath }, raw);
}

function routeProfileQuestionnaire({ args, cwd, raw, error, _output }) {
  void cwd; void error;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const o = _output ?? require('./profile-output.cjs');
  const answersIdx = args.indexOf('--answers');
  const answers = answersIdx !== -1 ? args[answersIdx + 1] : null;
  o.cmdProfileQuestionnaire({ answers }, raw);
}

function routeGenerateDevPreferences({ args, cwd, raw, error, _output }) {
  void error;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const o = _output ?? require('./profile-output.cjs');
  const analysisIdx = args.indexOf('--analysis');
  const analysisPath = analysisIdx !== -1 ? args[analysisIdx + 1] : null;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const stackIdx = args.indexOf('--stack');
  const stack = stackIdx !== -1 ? args[stackIdx + 1] : null;
  o.cmdGenerateDevPreferences(cwd, { analysis: analysisPath, output: outputPath, stack }, raw);
}

function routeGenerateClaudeProfile({ args, cwd, raw, error, _output }) {
  void error;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const o = _output ?? require('./profile-output.cjs');
  const analysisIdx = args.indexOf('--analysis');
  const analysisPath = analysisIdx !== -1 ? args[analysisIdx + 1] : null;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const globalFlag = args.includes('--global');
  o.cmdGenerateClaudeProfile(cwd, { analysis: analysisPath, output: outputPath, global: globalFlag }, raw);
}

function routeGenerateClaudeMd({ args, cwd, raw, error, _output }) {
  void error;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const o = _output ?? require('./profile-output.cjs');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const autoFlag = args.includes('--auto');
  const forceFlag = args.includes('--force');
  o.cmdGenerateClaudeMd(cwd, { output: outputPath, auto: autoFlag, force: forceFlag }, raw);
}

module.exports = {
  routeScanSessions,
  routeExtractMessages,
  routeProfileSample,
  routeWriteProfile,
  routeProfileQuestionnaire,
  routeGenerateDevPreferences,
  routeGenerateClaudeProfile,
  routeGenerateClaudeMd,
};
