'use strict';

/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: sdk/src/query/phase-lifecycle-policy.ts
 * Regenerate: cd sdk && npm run gen:phase-lifecycle-policy
 *
 * Phase Lifecycle Policy — pure computation helpers for phase directory naming,
 * roadmap entry generation, decimal-phase management, and ID computation.
 * No I/O. No async. No filesystem operations.
 *
 * I/O adapter pattern (ADR-3524 §4): pure transforms extracted from the SDK;
 * GSDError is replaced with plain throws that CJS callers can catch.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #4 (open-gsd/get-shit-done-redux)
 */

// Lightweight stub replacing sdk/src/errors.js GSDError.
// CJS callers that need to translate to process.exit(1) should catch these.
class GSDError extends Error {
  constructor(message, classification) {
    super(message);
    this.name = 'GSDError';
    this.classification = classification;
  }
}
// ErrorClassification values used by policy functions
const ErrorClassification = { Validation: 'Validation', Internal: 'Internal' };

// escapeRegex — inlined from sdk/dist/query/helpers.js
function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoNullBytes(value, label) {
    if (value.includes('\0')) {
        throw new GSDError(`${label} contains null byte`, ErrorClassification.Validation);
    }
}

function assertSafePhaseDirName(dirName, label = 'phase directory') {
    if (/[/\\]|\.\./.test(dirName)) {
        throw new GSDError(`${label} contains invalid path segments`, ErrorClassification.Validation);
    }
}

function assertSafeProjectCode(code) {
    if (code && /[/\\]|\.\./.test(code)) {
        throw new GSDError('project_code contains invalid characters', ErrorClassification.Validation);
    }
}

function generatePhaseSlug(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

function parseMultiwordArg(args, flag) {
    const idx = args.indexOf(`--${flag}`);
    if (idx === -1)
        return null;
    const tokens = [];
    for (let i = idx + 1; i < args.length; i++) {
        if (args[i].startsWith('--'))
            break;
        tokens.push(args[i]);
    }
    return tokens.length > 0 ? tokens.join(' ') : null;
}

function extractOneLinerFromBody(content) {
    if (!content)
        return null;
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '');
    // Find the first heading of any level (GFM section ATX headings)
    const headingMatch = body.match(/^(#{1,6}\s[^\n]+\n)/m);
    if (!headingMatch || headingMatch.index === undefined)
        return null;
    const afterHeading = body.slice(headingMatch.index + headingMatch[0].length);
    // Bound to the first section: truncate at the next heading of any level
    const nextHeadingMatch = afterHeading.match(/^#{1,6}\s/m);
    const sectionScope = nextHeadingMatch && nextHeadingMatch.index !== undefined
        ? afterHeading.slice(0, nextHeadingMatch.index)
        : afterHeading;
    const boldMatch = sectionScope.match(/\*\*([^*]+)\*\*/);
    return boldMatch ? boldMatch[1].trim() : null;
}

function scanSequentialMaxPhaseFromMilestone(milestoneContent) {
    const phasePattern = /(?:^|\n)\s*(?:[-*]\s*(?:\[[x ]\]\s*)?|#{2,4}\s*|\*{1,2}\s*)Phase\s+(\d+)[A-Z]?(?:\.\d+)*:/gi;
    let maxPhase = 0;
    let m;
    while ((m = phasePattern.exec(milestoneContent)) !== null) {
        const num = parseInt(m[1], 10);
        if (num === 999)
            continue;
        if (num > maxPhase)
            maxPhase = num;
    }
    return maxPhase;
}

function scanSequentialMaxPhaseFromDirs(dirNames) {
    let maxPhase = 0;
    const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)[A-Z]?(?:\.\d+)*-/i;
    for (const dirName of dirNames) {
        const match = dirNumPattern.exec(dirName);
        if (!match)
            continue;
        const num = parseInt(match[1], 10);
        if (num === 999)
            continue;
        if (num > maxPhase)
            maxPhase = num;
    }
    return maxPhase;
}

function computeNextSequentialPhaseId(milestoneContent, dirNames) {
    return Math.max(scanSequentialMaxPhaseFromMilestone(milestoneContent), scanSequentialMaxPhaseFromDirs(dirNames)) + 1;
}

function computePhaseDirectory(namingMode, descriptionSlug, prefix, nextSequentialPhaseId, customId) {
    if (customId || namingMode === 'custom') {
        const phaseId = customId || descriptionSlug.toUpperCase().replace(/-/g, '_');
        if (!phaseId) {
            throw new GSDError('--id required when phase_naming is "custom"', ErrorClassification.Validation);
        }
        assertSafePhaseDirName(String(phaseId), 'custom phase id');
        const dirName = `${prefix}${phaseId}-${descriptionSlug}`;
        assertSafePhaseDirName(dirName);
        return { phaseId, dirName };
    }
    const phaseId = nextSequentialPhaseId;
    const paddedNum = String(phaseId).padStart(2, '0');
    const dirName = `${prefix}${paddedNum}-${descriptionSlug}`;
    assertSafePhaseDirName(dirName);
    return { phaseId, dirName };
}

function buildPhaseRoadmapEntry(phaseId, description, namingMode) {
    const prevPhase = typeof phaseId === 'number' ? phaseId - 1 : null;
    const dependsOn = namingMode === 'custom' || prevPhase === null || prevPhase < 1
        ? ''
        : `\n**Depends on:** Phase ${prevPhase}`;
    return `\n### Phase ${phaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run /gsd-plan-phase ${phaseId} to break down)\n`;
}

function collectDecimalSuffixesFromDirNames(basePhase, dirNames) {
    const decimalSet = new Set();
    const decimalPattern = new RegExp(`^(?:[A-Z][A-Z0-9]*-)?${escapeRegex(basePhase)}\\.(\\d+)`, 'i');
    for (const dir of dirNames) {
        const match = dir.match(decimalPattern);
        if (match)
            decimalSet.add(parseInt(match[1], 10));
    }
    return decimalSet;
}

function collectDecimalSuffixesFromRoadmap(basePhase, roadmapContent) {
    const decimalSet = new Set();
    const phasePattern = new RegExp(`#{2,4}\\s*Phase\\s+0*${escapeRegex(basePhase)}\\.(\\d+)\\s*:`, 'gi');
    let match;
    while ((match = phasePattern.exec(roadmapContent)) !== null) {
        decimalSet.add(parseInt(match[1], 10));
    }
    return decimalSet;
}

function computeNextDecimalPhase(basePhase, decimalSet) {
    const existing = Array.from(decimalSet)
        .sort((a, b) => a - b)
        .map((n) => `${basePhase}.${n}`);
    const next = decimalSet.size === 0
        ? `${basePhase}.1`
        : `${basePhase}.${Math.max(...decimalSet) + 1}`;
    return { next, existing };
}

module.exports = {
  GSDError,
  assertNoNullBytes,
  assertSafePhaseDirName,
  assertSafeProjectCode,
  generatePhaseSlug,
  parseMultiwordArg,
  extractOneLinerFromBody,
  scanSequentialMaxPhaseFromMilestone,
  scanSequentialMaxPhaseFromDirs,
  computeNextSequentialPhaseId,
  computePhaseDirectory,
  buildPhaseRoadmapEntry,
  collectDecimalSuffixesFromDirNames,
  collectDecimalSuffixesFromRoadmap,
  computeNextDecimalPhase,
};
