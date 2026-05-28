'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ---------------------------------------------------------------------------
// Policy: native shell per OS
// ---------------------------------------------------------------------------
const POLICY = Object.freeze({
  'ubuntu-latest':  'bash',
  'ubuntu-22.04':   'bash',
  'ubuntu-24.04':   'bash',
  'macos-latest':   'zsh',
  'macos-13':       'zsh',
  'macos-14':       'zsh',
  'macos-15':       'zsh',
  'windows-latest': 'pwsh',
  'windows-2022':   'pwsh',
  'windows-2025':   'pwsh',
});

const VIOLATION = Object.freeze({
  WRONG_SHELL_FOR_OS:         'wrong_shell_for_os',
  MACOS_MISSING_EXPLICIT_ZSH: 'macos_missing_explicit_zsh',
  UNKNOWN_RUNNER:             'unknown_runner',
  UNRESOLVABLE_MATRIX:        'unresolvable_matrix',
});

// ---------------------------------------------------------------------------
// Runner default (GitHub Actions documented defaults, not policy)
// ---------------------------------------------------------------------------
function runnerDefault(runner) {
  if (!runner) return null;
  if (runner.startsWith('windows-')) return 'pwsh';
  return 'bash'; // ubuntu-* and macos-* both default to bash on GHA
}

// ---------------------------------------------------------------------------
// Matrix expansion
// ---------------------------------------------------------------------------

/**
 * Expand a runs-on expression against a job's strategy.matrix.
 * Returns an array of { runner: string, resolvable: boolean } objects.
 * 'resolvable: false' means the expression was an unresolved matrix ref.
 */
function expandRunsOn(runsOnRaw, matrix) {
  if (!runsOnRaw) return [];

  const raw = String(runsOnRaw).trim();

  // Detect matrix expression: ${{ matrix.X }} or ${{ matrix['X'] }}
  const matrixExprRe = /\$\{\{\s*matrix\.(\w+)\s*\}\}/;
  const match = raw.match(matrixExprRe);

  if (!match) {
    // Literal runner label
    return [{ runner: raw, resolvable: true }];
  }

  const key = match[1];

  if (!matrix) {
    return [{ runner: raw, resolvable: false }];
  }

  const realizations = [];

  // Collect values from matrix.os (or whatever key) — the explicit list
  if (Array.isArray(matrix[key])) {
    for (const val of matrix[key]) {
      realizations.push({ runner: String(val), resolvable: true });
    }
  }

  // matrix.include entries
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) {
      if (entry && entry[key] != null) {
        const runner = String(entry[key]);
        // Avoid duplicating runners already in the base list
        if (!realizations.find(r => r.runner === runner)) {
          realizations.push({ runner, resolvable: true });
        }
      }
    }
  }

  // matrix.exclude: remove matches
  if (Array.isArray(matrix.exclude)) {
    for (const excl of matrix.exclude) {
      if (excl && excl[key] != null) {
        const exclRunner = String(excl[key]);
        const idx = realizations.findIndex(r => r.runner === exclRunner);
        if (idx !== -1) realizations.splice(idx, 1);
      }
    }
  }

  if (realizations.length === 0) {
    // Could not resolve — no concrete values found
    return [{ runner: raw, resolvable: false }];
  }

  return realizations;
}

// ---------------------------------------------------------------------------
// Effective-shell resolution
// ---------------------------------------------------------------------------

/**
 * Given a step's shell, job defaults, workflow defaults, and runner,
 * return the effective shell that will actually execute.
 */
function effectiveShell(stepShell, jobDefaultsShell, workflowDefaultsShell, runner) {
  if (stepShell) return stepShell;
  if (jobDefaultsShell) return jobDefaultsShell;
  if (workflowDefaultsShell) return workflowDefaultsShell;
  return runnerDefault(runner);
}

// ---------------------------------------------------------------------------
// Violation detection
// ---------------------------------------------------------------------------
function detectViolation(runner, resolvedShell, stepShell, jobDefaultsShell, workflowDefaultsShell) {
  if (!(runner in POLICY)) {
    return VIOLATION.UNKNOWN_RUNNER;
  }
  const expected = POLICY[runner];
  if (resolvedShell !== expected) {
    // Specific subtype for macOS missing explicit zsh
    if (runner.startsWith('macos-') && !stepShell && !jobDefaultsShell && !workflowDefaultsShell) {
      return VIOLATION.MACOS_MISSING_EXPLICIT_ZSH;
    }
    return VIOLATION.WRONG_SHELL_FOR_OS;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source map: find line numbers
// ---------------------------------------------------------------------------

/**
 * Find the line number of a string in YAML text.
 * Returns 1-based line number of the first occurrence at or after startLine.
 */
function findLineNumber(yamlText, searchStr, startLine) {
  const lines = yamlText.split('\n');
  const start = Math.max(0, (startLine || 1) - 1);
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes(searchStr)) {
      return i + 1;
    }
  }
  // Fall back to scanning from beginning
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchStr)) {
      return i + 1;
    }
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Core inspector
// ---------------------------------------------------------------------------

/**
 * inspectWorkflow(yamlText, { filePath }) → structured inspection result
 */
function inspectWorkflow(yamlText, { filePath = '<unknown>' } = {}) {
  let doc;
  try {
    doc = yaml.load(yamlText, { schema: yaml.DEFAULT_SCHEMA });
  } catch (e) {
    return {
      filePath,
      jobs: [],
      workflowDefaultsShell: null,
      parseError: e.message,
    };
  }

  if (!doc || typeof doc !== 'object') {
    return { filePath, jobs: [], workflowDefaultsShell: null };
  }

  const workflowDefaultsShell =
    doc.defaults?.run?.shell ?? null;

  const jobs = [];

  for (const [jobId, jobDef] of Object.entries(doc.jobs || {})) {
    if (!jobDef || typeof jobDef !== 'object') continue;

    const runsOnRaw = jobDef['runs-on'];
    const matrix = jobDef.strategy?.matrix ?? null;
    const jobDefaultsShell = jobDef.defaults?.run?.shell ?? null;

    const runsOnStr = runsOnRaw != null ? String(runsOnRaw) : '';
    const runsOnExpressions = [runsOnStr];
    const runnerRealizations = expandRunsOn(runsOnStr, matrix);

    const steps = [];

    for (const [stepIndex, step] of (jobDef.steps || []).entries()) {
      if (!step || typeof step !== 'object') continue;

      // Only check steps that actually run shell scripts (have `run:`)
      if (!step.run) continue;

      const stepShell = step.shell ?? null;
      const stepName = step.name ?? `step-${stepIndex}`;

      for (const { runner, resolvable } of runnerRealizations) {
        if (!resolvable) {
          // Can't resolve runner — emit UNRESOLVABLE_MATRIX
          const lineNum = findLineNumber(yamlText, stepName !== `step-${stepIndex}` ? stepName : String(step.run).slice(0, 20));
          steps.push({
            index: stepIndex,
            name: stepName,
            stepShell,
            effectiveShell: null,
            runner,
            violation: VIOLATION.UNRESOLVABLE_MATRIX,
            evidence: {
              line: lineNum,
              snippet: `runs-on: ${runsOnStr} (unresolvable matrix expression)`,
            },
          });
          continue;
        }

        const eff = effectiveShell(stepShell, jobDefaultsShell, workflowDefaultsShell, runner);
        const violation = detectViolation(runner, eff, stepShell, jobDefaultsShell, workflowDefaultsShell);

        // Find evidence line: prefer step name, then shell:, then run: content
        let evidenceLine = 1;
        let evidenceSnippet = '';

        if (stepName !== `step-${stepIndex}`) {
          evidenceLine = findLineNumber(yamlText, stepName);
          evidenceSnippet = `name: ${stepName}`;
        } else if (stepShell) {
          evidenceLine = findLineNumber(yamlText, `shell: ${stepShell}`);
          evidenceSnippet = `shell: ${stepShell}`;
        } else {
          const runSnippet = String(step.run).split('\n')[0].slice(0, 40);
          evidenceLine = findLineNumber(yamlText, runSnippet);
          evidenceSnippet = runSnippet;
        }

        steps.push({
          index: stepIndex,
          name: stepName,
          stepShell,
          effectiveShell: eff,
          runner,
          violation: violation ?? null,
          evidence: {
            line: evidenceLine,
            snippet: evidenceSnippet,
          },
        });
      }
    }

    const resolvedRunners = runnerRealizations
      .filter(r => r.resolvable)
      .map(r => r.runner);

    jobs.push({
      jobId,
      runsOnExpressions,
      resolvedRunners,
      defaultsShell: jobDefaultsShell,
      steps,
    });
  }

  return {
    filePath,
    jobs,
    workflowDefaultsShell,
  };
}

/**
 * inspectWorkflowFile(absPath) — reads file from disk and calls inspectWorkflow.
 */
function inspectWorkflowFile(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  return inspectWorkflow(text, { filePath: absPath });
}

// ---------------------------------------------------------------------------
// runPolicyLint
// ---------------------------------------------------------------------------

/**
 * runPolicyLint({ workflowsDir }) → { violations, summary }
 */
function runPolicyLint({ workflowsDir }) {
  const absDir = path.resolve(workflowsDir);
  const files = fs.readdirSync(absDir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(f => path.join(absDir, f))
    .sort();

  const violations = [];

  for (const filePath of files) {
    const result = inspectWorkflowFile(filePath);
    for (const job of result.jobs) {
      for (const step of job.steps) {
        if (step.violation) {
          violations.push({
            filePath: result.filePath,
            jobId: job.jobId,
            stepIndex: step.index,
            stepName: step.name,
            runner: step.runner,
            effectiveShell: step.effectiveShell,
            stepShell: step.stepShell,
            violation: step.violation,
            evidence: step.evidence,
          });
        }
      }
    }
  }

  const perViolationType = {};
  for (const v of violations) {
    perViolationType[v.violation] = (perViolationType[v.violation] || 0) + 1;
  }

  return {
    violations,
    summary: {
      total: violations.length,
      perViolationType,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  POLICY,
  VIOLATION,
  inspectWorkflow,
  inspectWorkflowFile,
  runPolicyLint,
};
