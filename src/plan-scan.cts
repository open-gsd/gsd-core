/**
 * Plan Scan Module — detects plan and summary files in a phase directory.
 * Supports both flat (pre-#3139) and nested (post-#3139) layouts.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/plan-scan.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Excluded derivative files
const PLAN_OUTLINE_RE = /-OUTLINE\.md$/i;
const PLAN_PRE_BOUNCE_RE = /\.pre-bounce\.md$/i;

function isRootPlanFile(fileName: string): boolean {
  if (PLAN_OUTLINE_RE.test(fileName)) return false;
  if (PLAN_PRE_BOUNCE_RE.test(fileName)) return false;
  if (fileName.endsWith('-PLAN.md') || fileName === 'PLAN.md') return true;
  // A summary is never a plan. Reject summaries before the loose /PLAN/i
  // fallback so legacy `<N>-PLAN-<NN>-SUMMARY.md` names (which contain the
  // substring "PLAN") are not double-counted as plans. (#500 RC2)
  if (isRootSummaryFile(fileName)) return false;
  return /\.md$/i.test(fileName) && /PLAN/i.test(fileName);
}

function isNestedPlanFile(fileName: string): boolean {
  if (PLAN_OUTLINE_RE.test(fileName)) return false;
  if (PLAN_PRE_BOUNCE_RE.test(fileName)) return false;
  return /^PLAN-\d+.*\.md$/i.test(fileName) || /-PLAN-\d+.*\.md$/i.test(fileName);
}

function isRootSummaryFile(fileName: string): boolean {
  return fileName.endsWith('-SUMMARY.md') || fileName === 'SUMMARY.md';
}

function isNestedSummaryFile(fileName: string): boolean {
  return /^SUMMARY-\d+.*\.md$/i.test(fileName) || /-SUMMARY-\d+.*\.md$/i.test(fileName);
}

interface PhaseScanResult {
  planCount: number;
  summaryCount: number;
  completed: boolean;
  hasNestedPlans: boolean;
  planFiles: string[];
  summaryFiles: string[];
}

function scanPhasePlans(phaseDir: string): PhaseScanResult {
  let rootFiles: string[];
  try {
    rootFiles = readdirSync(phaseDir);
  } catch {
    return {
      planCount: 0,
      summaryCount: 0,
      completed: false,
      hasNestedPlans: false,
      planFiles: [],
      summaryFiles: [],
    };
  }

  const rootPlanFiles = rootFiles.filter(isRootPlanFile);
  const rootSummaryFiles = rootFiles.filter(isRootSummaryFile);
  let nestedPlanFiles: string[] = [];
  let nestedSummaryFiles: string[] = [];
  let hasNestedPlans = false;

  const nestedDir = join(phaseDir, 'plans');
  if (existsSync(nestedDir)) {
    try {
      const nestedFiles = readdirSync(nestedDir);
      nestedPlanFiles = nestedFiles.filter(isNestedPlanFile).map((file) => `plans/${file}`);
      nestedSummaryFiles = nestedFiles.filter(isNestedSummaryFile).map((file) => `plans/${file}`);
      hasNestedPlans = nestedPlanFiles.length > 0;
    } catch { /* ignore unreadable nested layout */ }
  }

  const planFiles = rootPlanFiles.concat(nestedPlanFiles);
  const summaryFiles = rootSummaryFiles.concat(nestedSummaryFiles);
  const planCount = planFiles.length;
  const summaryCount = summaryFiles.length;

  return {
    planCount,
    summaryCount,
    completed: planCount > 0 && summaryCount >= planCount,
    hasNestedPlans,
    planFiles,
    summaryFiles,
  };
}

// CJS callers do: const scanPhasePlans = require('./plan-scan.cjs')
// and also destructure named exports — support both call styles.
// Using export = with extra properties attached.
export = Object.assign(scanPhasePlans, {
  scanPhasePlans,
  isRootPlanFile,
  isNestedPlanFile,
  isRootSummaryFile,
  isNestedSummaryFile,
});
