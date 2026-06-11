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
// Matrix expansion helpers
// ---------------------------------------------------------------------------

// Build the GitHub Actions Cartesian product of the given base-list matrix
// keys. Returns one context object per realized job, each mapping every key
// to a stringified value. A single key yields one context per value (identical
// to the legacy base-list expansion); N keys yield the full cross-product.
// Values are stringified to match runner-label comparison and matrix-expression
// resolution, which operate on strings.
function cartesianProduct(keys, matrix) {
  return keys.reduce(
    (contexts, key) =>
      contexts.flatMap((context) =>
        matrix[key].map((value) => ({ ...context, [key]: String(value) })),
      ),
    [{}],
  );
}

// ---------------------------------------------------------------------------
// Matrix expansion
// ---------------------------------------------------------------------------

/**
 * Expand a runs-on expression against a job's strategy.matrix.
 * Returns an array of { runner: string, resolvable: boolean, context: object }
 * objects where `context` holds ALL key→value pairs for the realization row
 * (so shell expressions like ${{ matrix.shell }} can be resolved against it).
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
    return [{ runner: raw, resolvable: true, context: {} }];
  }

  const key = match[1];

  if (!matrix) {
    return [{ runner: raw, resolvable: false, context: {} }];
  }

  const realizations = [];

  // matrix.include entries carry complete row context — prefer them as they
  // contain all keys (os, node-version, shell, full_only, etc.).
  // Each include row is a distinct CI realization and must be validated
  // independently — even if two rows share the same runner label, their
  // contexts (and therefore effective shells) may differ.
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) {
      if (entry && entry[key] != null) {
        const runner = String(entry[key]);
        // Clone all keys from include row as the realization context
        const context = {};
        for (const [k, v] of Object.entries(entry)) {
          context[k] = v != null ? String(v) : '';
        }
        realizations.push({ runner, resolvable: true, context });
      }
    }
  }

  // GitHub Actions realizes one job per element of the Cartesian product of all
  // base-list matrix keys (every matrix.<k> that is an array, excluding the
  // include/exclude control keys), and each realized job's context carries a
  // value for EVERY matrix key — so ${{ matrix.<key> }} references (e.g. in a
  // shell: field) resolve against any realization, not only the runs-on key.
  // Single-axis matrices yield exactly one realization per value, identical to
  // the prior behavior; only multi-axis matrices change shape.
  // Each realization is pushed unconditionally — deduplicating by runner label
  // would collapse distinct Cartesian rows (e.g. matrix.os: [macos-latest,
  // macos-latest] paired with different shells) and hide policy violations.
  if (Array.isArray(matrix[key])) {
    const baseListKeys = Object.keys(matrix).filter(
      (k) => k !== 'include' && k !== 'exclude' && Array.isArray(matrix[k]),
    );
    for (const context of cartesianProduct(baseListKeys, matrix)) {
      realizations.push({ runner: context[key], resolvable: true, context });
    }
  }

  // matrix.exclude: remove matches by runner label (first match only).
  // KNOWN LIMITATION (out of scope for #435, tracked as a follow-up): this
  // matches on the runs-on key's runner label rather than the full exclude
  // tuple, so a multi-axis exclude like { os: macos-latest, shell: bash } can
  // remove the wrong cross-product cell. Full GitHub Actions tuple-match
  // (including the include-rows-are-not-excluded rule) is deferred; #435 scopes
  // only the base-list cross-product expansion above.
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
    return [{ runner: raw, resolvable: false, context: {} }];
  }

  return realizations;
}

// ---------------------------------------------------------------------------
// Matrix expression resolution
// ---------------------------------------------------------------------------

/**
 * If `expr` is a `${{ matrix.<key> }}` expression, look up the value in
 * `realizationContext` (a plain-object snapshot of one matrix.include row).
 * Returns:
 *   { resolved: true, value: string }   — expression resolved to a concrete value
 *   { resolved: false, key: string }    — matrix key absent in this realization
 *   null                                — `expr` is not a matrix expression
 */
function resolveMatrixExpr(expr, realizationContext) {
  if (!expr || typeof expr !== 'string') return null;
  const m = expr.match(/^\s*\$\{\{\s*matrix\.(\w+)\s*\}\}\s*$/);
  if (!m) return null;
  const key = m[1];
  if (!realizationContext || !(key in realizationContext)) {
    return { resolved: false, key };
  }
  return { resolved: true, value: String(realizationContext[key]) };
}

// ---------------------------------------------------------------------------
// Effective-shell resolution
// ---------------------------------------------------------------------------

/**
 * Given a step's shell, job defaults, workflow defaults, runner, and the
 * current matrix realization context, return the effective shell that will
 * actually execute.
 *
 * Matrix expressions (`${{ matrix.shell }}`) in any shell field are resolved
 * against `realizationContext` (a plain object of key→value for the current
 * matrix.include row).
 *
 * Returns:
 *   { shell: string, unresolvable: false }  — concrete shell value
 *   { shell: null,  unresolvable: true, key: string } — matrix expr present but key missing
 */
function effectiveShell(stepShell, jobDefaultsShell, workflowDefaultsShell, runner, realizationContext) {
  for (const raw of [stepShell, jobDefaultsShell, workflowDefaultsShell]) {
    if (!raw) continue;
    const mx = resolveMatrixExpr(raw, realizationContext);
    if (mx !== null) {
      // It's a matrix expression
      if (!mx.resolved) {
        return { shell: null, unresolvable: true, key: mx.key };
      }
      return { shell: mx.value, unresolvable: false };
    }
    // Literal value
    return { shell: raw, unresolvable: false };
  }
  // Nothing set at any level — use runner default
  return { shell: runnerDefault(runner), unresolvable: false };
}

// ---------------------------------------------------------------------------
// Violation detection
// ---------------------------------------------------------------------------
/**
 * Determines whether a step/runner combination violates shell policy.
 *
 * `rawStepShell`, `rawJobDefaultsShell`, `rawWorkflowDefaultsShell` are the
 * raw (possibly matrix-expression) values before resolution. They're used
 * only for the MACOS_MISSING_EXPLICIT_ZSH sub-classification: that violation
 * fires only when nothing is set at any level (all three are null/empty AND
 * the runner default is wrong).
 */
function detectViolation(runner, resolvedShell, rawStepShell, rawJobDefaultsShell, rawWorkflowDefaultsShell) {
  if (!(runner in POLICY)) {
    return VIOLATION.UNKNOWN_RUNNER;
  }
  const expected = POLICY[runner];
  // GHA accepts custom shells as a format string containing '{0}' (e.g. 'zsh {0}').
  // Per https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions
  // the shell name before the space is the executable; strip the format suffix before
  // comparing against the policy so 'zsh {0}' satisfies the 'zsh' requirement.
  const normalizedShell = resolvedShell ? resolvedShell.replace(/\s+\{0\}$/, '') : resolvedShell;
  if (normalizedShell !== expected) {
    // Specific subtype for macOS missing explicit zsh:
    // fires only when no shell is set at any level (inherited runner default).
    if (runner.startsWith('macos-') && !rawStepShell && !rawJobDefaultsShell && !rawWorkflowDefaultsShell) {
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

      for (const { runner, resolvable, context: realizationContext } of runnerRealizations) {
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

        const effResult = effectiveShell(stepShell, jobDefaultsShell, workflowDefaultsShell, runner, realizationContext);

        // If a matrix expression referenced a key not present in this realization row
        if (effResult.unresolvable) {
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
              snippet: `matrix.${effResult.key} not present in realization for runner=${runner}`,
            },
          });
          continue;
        }

        const eff = effResult.shell;
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
