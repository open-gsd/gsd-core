/**
 * Roadmap Parser — ROADMAP.md parsing helpers
 *
 * ADR-857 rollout phase 2b: extracted from core.cts (issue #870).
 * Owns shipped-milestone slicing, current-milestone extraction,
 * milestone/phase lookups, and milestone-phase filtering.
 * Behaviour is preserved byte-for-behaviour from the prior location;
 * only the module boundary moved. core.cjs re-exports every symbol here
 * under its own `export =` object so existing consumers are unaffected.
 *
 * New imports should pull roadmap-parser helpers from roadmap-parser.cjs directly.
 *
 * Dependencies (leaf modules only — no core.cjs, no loadConfig):
 *   - node:fs / node:path (stdlib)
 *   - ./phase-id.cjs        (escapeRegex, phaseMarkdownRegexSource)
 *   - ./planning-workspace.cjs (planningDir)
 *   - ./shell-command-projection.cjs (platformReadSync)
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const { escapeRegex, phaseMarkdownRegexSource } = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
import { platformReadSync } from './shell-command-projection.cjs';

// ─── Roadmap milestone scoping ───────────────────────────────────────────────

/**
 * Strip shipped milestone content wrapped in <details> blocks.
 */
function stripShippedMilestones(content: string): string {
  return content.replace(/<details>[\s\S]*?<\/details>/gi, '');
}

/**
 * Extract the current milestone section from ROADMAP.md by positive lookup.
 */
function extractCurrentMilestone(content: string, cwd?: string): string {
  if (!cwd) return stripShippedMilestones(content);

  let version: string | null = null;
  try {
    const statePath = path.join(planningDir(cwd), 'STATE.md');
    const stateRaw = platformReadSync(statePath);
    if (stateRaw !== null) {
      const milestoneMatch = stateRaw.match(/^milestone:\s*(.+)/m);
      if (milestoneMatch) {
        version = milestoneMatch[1].trim();
      }
    }
  } catch { /* ignore */ }

  if (!version) {
    const inProgressMatch = content.match(/(?:🚧|🔄)\s*\*\*v(\d+\.\d+)\s/);
    if (inProgressMatch) {
      version = 'v' + inProgressMatch[1];
    }
  }

  if (!version) return stripShippedMilestones(content);

  const escapedVersion = escapeRegex(version);
  const sectionPattern = new RegExp(
    `(^#{1,3}\\s+(?!Phase\\s+\\S).*${escapedVersion}\\b[^\\n]*)`,
    'gmi'
  );
  const summaryPattern = new RegExp(
    `<summary[^>]*>([^<]*${escapedVersion}[^<]*)<\\/summary>`,
    'i'
  );
  const headingMatches = [...content.matchAll(sectionPattern)];

  if (headingMatches.length === 0) {
    const summaryMatch = content.match(summaryPattern);
    if (summaryMatch) {
      const summaryIdx = content.indexOf(summaryMatch[0]);
      const beforeSummary = content.slice(0, summaryIdx);
      const detailsOpenIdx = beforeSummary.lastIndexOf('<details');
      if (detailsOpenIdx !== -1) {
        const afterDetails = content.slice(detailsOpenIdx);
        const closingMatch = afterDetails.match(/<\/details>/i);
        const detailsEnd = closingMatch
          ? detailsOpenIdx + (closingMatch.index ?? 0) + '</details>'.length
          : content.length;
        const anyMilestoneOrDetails = /^#{1,3}\s+(?!Phase\s+\S)(?:.*v\d+\.\d+|✅|📋|🚧|🔄)|<details/im;
        const firstMilestoneMatch = content.match(anyMilestoneOrDetails);
        const preambleCutoff = firstMilestoneMatch ? firstMilestoneMatch.index! : detailsOpenIdx;
        const preamble = content.slice(0, preambleCutoff)
          .replace(/<details>[\s\S]*?<\/details>/gi, '')
          .replace(/^#{2,4}\s*Phase\s+[\w][\w.-]*\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim, '')
          .replace(/^#{1,4}\s*Phase Details\b[^\n]*\n?/gim, '');
        return preamble + content.slice(detailsOpenIdx, detailsEnd);
      }
    }
    return stripShippedMilestones(content);
  }

  const allMatches = headingMatches;

  const closedMarkerPattern = /\b(?:CLOSED|ARCHIVED|ABANDONED|SHIPPED|FAILED)\b|✅|🗄/i;
  const activeMarkerPattern = /\b(?:STARTED|ACTIVE|WIP)\b|in\s+progress|🚧|🔄/i;
  const isClosed = (h: string) => closedMarkerPattern.test(h) && !activeMarkerPattern.test(h);
  const firstMatch = allMatches[0];
  const selected = allMatches.find((m) => !isClosed(m[1])) || firstMatch;

  const sectionStart = selected.index;

  const computeSectionEnd = (headingText: string, headingStart: number): number => {
    const level = (headingText.match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
    const rest = content.slice(headingStart + headingText.length);
    const stopPattern = new RegExp(
      `^#{1,${level}}\\s+(?!Phase\\s+\\S)(?:.*v\\d+\\.\\d+|✅|📋|🚧)`,
      'i',
    );
    let end = content.length;
    let fc: string | null = null;
    let fl = 0;
    let off = 0;
    for (const line of rest.split('\n')) {
      const fm = line.match(/^\s{0,3}((?:`{3,}|~{3,}))(.*)/);
      if (fm) {
        const ch = fm[1][0];
        const ln = fm[1].length;
        const trailing = fm[2] || '';
        if (!fc) {
          fc = ch;
          fl = ln;
        } else if (ch === fc && ln >= fl && /^\s*$/.test(trailing)) {
          fc = null;
          fl = 0;
        }
      } else if (!fc && stopPattern.test(line)) {
        end = headingStart + headingText.length + off;
        break;
      }
      off += line.length + 1;
    }
    return end;
  };

  const sectionEnd = computeSectionEnd(selected[0], sectionStart);

  const anyMilestonePattern = /^#{1,3}\s+(?!Phase\s+\S)(?:.*v\d+\.\d+|✅|📋|🚧)/im;
  const firstMilestoneMatch = content.match(anyMilestonePattern);
  const preambleCutoff = firstMilestoneMatch
    ? firstMilestoneMatch.index!
    : firstMatch.index;
  const beforeMilestones = content.slice(0, preambleCutoff);
  const currentSection = content.slice(sectionStart, sectionEnd);

  // Multi-milestone roadmaps split each added milestone across two version-bearing
  // headings: a `## Phases` checklist subsection (early) and a dedicated
  // `## Milestone … (Phase Details)` section (late) holding the `### Phase N:`
  // detail headers. The scope window above stops at the next version-bearing
  // heading — the current milestone's OWN Phase Details heading — leaving those
  // detail headers outside `currentSection`. Append that section so phase
  // resolution and counting see the current milestone's phases. Anchor the lookup
  // to the SELECTED heading's specific version token (boundary-aware, so a
  // `v3.0` state does not match a `v3.0-A` sub-milestone) so sibling milestones
  // that share a version prefix do not cross-pollinate. (#730)
  const selectedVersionToken = selected[1].match(
    /v\d+(?:\.\d+)+(?:[-.][A-Za-z0-9]+)*/i,
  )?.[0];
  const detailsVersionBoundary = selectedVersionToken
    ? new RegExp(`${escapeRegex(selectedVersionToken)}(?![\\w.-])`, 'i')
    : null;
  let detailsSection = '';
  const detailsMatch = allMatches.find(
    (m) =>
      /\(Phase\s+Details\)/i.test(m[1]) &&
      !isClosed(m[1]) &&
      (!detailsVersionBoundary || detailsVersionBoundary.test(m[1])) &&
      (m.index ?? 0) >= sectionEnd,
  );
  if (detailsMatch) {
    const detailsStart = detailsMatch.index ?? 0;
    detailsSection = content.slice(
      detailsStart,
      computeSectionEnd(detailsMatch[0], detailsStart),
    );
  }

  const preamble = beforeMilestones
    .replace(/<details>[\s\S]*?<\/details>/gi, '')
    .replace(/^#{2,4}\s*Phase\s+[\w][\w.-]*\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim, '')
    .replace(/^#{1,4}\s*Phase Details\b[^\n]*\n?/gim, '');

  return detailsSection
    ? preamble + currentSection + '\n' + detailsSection
    : preamble + currentSection;
}

/**
 * Replace a pattern only in the current milestone section of ROADMAP.md.
 */
function replaceInCurrentMilestone(content: string, pattern: RegExp, replacement: string): string {
  const lastDetailsClose = content.lastIndexOf('</details>');
  if (lastDetailsClose === -1) {
    return content.replace(pattern, replacement);
  }
  const offset = lastDetailsClose + '</details>'.length;
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  return before + after.replace(pattern, replacement);
}

// ─── Roadmap phase lookup ─────────────────────────────────────────────────────

interface RoadmapPhaseResult {
  found: boolean;
  phase_number: string;
  phase_name: string;
  goal: string | null;
  section: string;
}

function getRoadmapPhaseInternal(cwd: string, phaseNum: unknown): RoadmapPhaseResult | null {
  if (!phaseNum) return null;
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return null;

  try {
    const roadmapRaw = platformReadSync(roadmapPath);
    if (roadmapRaw === null) throw new Error('missing');
    const content = extractCurrentMilestone(roadmapRaw, cwd);
    const phasePattern = new RegExp(
      `#{2,4}\\s*(?:\\[[^\\]]+\\]\\s*)?Phase\\s+${phaseMarkdownRegexSource(phaseNum)}:\\s*([^\\n]+)`,
      'i'
    );
    const headerMatch = content.match(phasePattern);
    if (!headerMatch) return null;

    const phaseName = headerMatch[1].trim();
    const headerIndex = headerMatch.index!;
    const restOfContent = content.slice(headerIndex);
    const nextHeaderMatch = restOfContent.match(/\n#{2,4}\s+(?:\[[^\]]+\]\s*)?Phase\s+[\w]/i);
    const sectionEnd = nextHeaderMatch ? headerIndex + nextHeaderMatch.index! : content.length;
    const section = content.slice(headerIndex, sectionEnd).trim();

    const goalMatch = section.match(/\*\*Goal(?:\*\*:|\*?\*?:\*\*)\s*([^\n]+)/i);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    return {
      found: true,
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      phase_number: String(phaseNum),
      phase_name: phaseName,
      goal,
      section,
    };
  } catch {
    return null;
  }
}

// ─── Milestone info lookup ────────────────────────────────────────────────────

interface MilestoneInfo {
  version: string;
  name: string;
}

function getMilestoneInfo(cwd: string): MilestoneInfo {
  try {
    const roadmap = platformReadSync(path.join(planningDir(cwd), 'ROADMAP.md'));
    if (roadmap === null) throw new Error('missing');

    let stateVersion: string | null = null;
    if (cwd) {
      try {
        const statePath = path.join(planningDir(cwd), 'STATE.md');
        const stateRaw = platformReadSync(statePath);
        if (stateRaw !== null) {
          const m = stateRaw.match(/^milestone:\s*(.+)/m);
          if (m) stateVersion = m[1].trim();
        }
      } catch { /* intentionally empty */ }
    }

    if (stateVersion) {
      const escapedVer = escapeRegex(stateVersion);
      const headingMatch = roadmap.match(
        new RegExp(`##[^\\n]*${escapedVer}[:\\s]+([^\\n(]+)`, 'i')
      );
      if (headingMatch) {
        if (!headingMatch[0].includes('✅')) {
          return { version: stateVersion, name: headingMatch[1].trim() };
        }
      } else {
        const listMatch = roadmap.match(
          new RegExp(`🚧\\s*\\*?\\*?${escapedVer}\\s+([^*\\n]+)`, 'i')
        );
        if (listMatch) {
          return { version: stateVersion, name: listMatch[1].trim() };
        }
        return { version: stateVersion, name: 'milestone' };
      }
    }

    const inProgressMatch = roadmap.match(/🚧\s*\*\*v(\d+(?:\.\d+)+)\s+([^*]+)\*\*/);
    if (inProgressMatch) {
      return {
        version: 'v' + inProgressMatch[1],
        name: inProgressMatch[2].trim(),
      };
    }

    const cleaned = stripShippedMilestones(roadmap);
    const headingMatch = cleaned.match(/## (?!.*✅).*v(\d+(?:\.\d+)+)[:\s]+([^\n(]+)/);
    if (headingMatch) {
      return {
        version: 'v' + headingMatch[1],
        name: headingMatch[2].trim(),
      };
    }
    const versionMatch = cleaned.match(/v(\d+(?:\.\d+)+)/);
    return {
      version: versionMatch ? versionMatch[0] : 'v1.0',
      name: 'milestone',
    };
  } catch {
    return { version: 'v1.0', name: 'milestone' };
  }
}

// ─── Milestone phase filter ───────────────────────────────────────────────────

type MilestonePhaseFilter = ((dirName: string) => boolean) & {
  phaseCount: number;
  missingExplicitVersion: boolean;
};

/**
 * Returns a filter function that checks whether a phase directory belongs
 * to the current milestone based on ROADMAP.md phase headings.
 */
function getMilestonePhaseFilter(cwd: string, versionOverride?: string | null): MilestonePhaseFilter {
  const milestonePhaseNums = new Set<string>();
  let missingExplicitVersion = false;
  try {
    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    const roadmapContent = platformReadSync(roadmapPath);
    if (roadmapContent === null) throw new Error('missing');
    let roadmap = extractCurrentMilestone(roadmapContent, cwd);

    const hasVersionedMilestonesGlobal = /^#{1,3}\s+.*v\d+\.\d+/mi.test(roadmapContent);
    const hasPhaseHeadings = /#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+[\w]/i.test(roadmapContent);
    if (!hasVersionedMilestonesGlobal && hasPhaseHeadings) {
      console.warn(
        '[gsd] Deprecated: free-form ROADMAP.md detected (no versioned milestone headings). ' +
        'Set phase_id_convention in config.json to suppress this warning.'
      );
    }

    if (versionOverride) {
      const escapedVersion = escapeRegex(versionOverride);
      const sectionPattern = new RegExp(`(^#{1,3}\\s+(?!Phase\\s+\\S).*${escapedVersion}[^\\n]*)`, 'mi');
      let sectionMatch = roadmapContent.match(sectionPattern);

      if (!sectionMatch) {
        const summaryPat = new RegExp(`<summary[^>]*>[^<]*${escapedVersion}[^<]*<\\/summary>`, 'i');
        const summaryHit = roadmapContent.match(summaryPat);
        if (summaryHit) {
          const beforeSummary = roadmapContent.slice(0, summaryHit.index);
          const detailsIdx = beforeSummary.lastIndexOf('<details');
          if (detailsIdx !== -1) {
            sectionMatch = null;
          }
        }
      }

      if (!sectionMatch) {
        const hasVersionedMilestones = /^#{1,3}\s+(?!Phase\s+\S).*v\d+\.\d+/mi.test(roadmapContent);
        const versionInSummary = new RegExp(`<summary[^>]*>[^<]*${escapedVersion}[^<]*<\\/summary>`, 'i').test(roadmapContent);
        if (hasVersionedMilestones && !versionInSummary) {
          roadmap = '';
          missingExplicitVersion = true;
        }
      } else {
        const sectionStart = sectionMatch.index!;
        const headingLevel = (sectionMatch[1].match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
        const restContent = roadmapContent.slice(sectionStart + sectionMatch[0].length);
        const nextMilestonePattern = new RegExp(`^#{1,${headingLevel}}\\s+(?!Phase\\s+\\S)(?:.*v\\d+\\.\\d+|✅|📋|🚧)`, 'i');

        let sectionEnd = roadmapContent.length;
        let fenceChar: string | null = null;
        let fenceLen = 0;
        let charOffset = 0;
        for (const line of restContent.split('\n')) {
          const fenceMatch = line.match(/^\s{0,3}((?:`{3,}|~{3,}))(.*)/);
          if (fenceMatch) {
            const char = fenceMatch[1][0];
            const len = fenceMatch[1].length;
            const trailing = fenceMatch[2] || '';
            if (!fenceChar) {
              fenceChar = char;
              fenceLen = len;
            } else if (char === fenceChar && len >= fenceLen && /^\s*$/.test(trailing)) {
              fenceChar = null;
              fenceLen = 0;
            }
          } else if (!fenceChar && nextMilestonePattern.test(line)) {
            sectionEnd = sectionStart + sectionMatch[0].length + charOffset;
            break;
          }
          charOffset += line.length + 1;
        }

        const currentSection = roadmapContent.slice(sectionStart, sectionEnd);
        roadmap = currentSection;
      }
    }

    const phasePattern = /#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+([\w][\w.-]*)\s*:/gi;
    let m: RegExpExecArray | null;
    while ((m = phasePattern.exec(roadmap)) !== null) {
      milestonePhaseNums.add(m[1]);
    }
  } catch { /* intentionally empty */ }

  if (milestonePhaseNums.size === 0) {
    const passAll = (() => true) as unknown as MilestonePhaseFilter;
    passAll.phaseCount = 0;
    passAll.missingExplicitVersion = missingExplicitVersion;
    return passAll;
  }

  const normalized = new Set(
    [...milestonePhaseNums].map(n => n.split('-').map(seg => (seg.replace(/^0+(?=\d)/, '') || '0')).join('-').toLowerCase())
  );

  function normalizePhaseIdSegments(id: string): string {
    return id.split('-').map(seg => seg.replace(/^0+(?=\d)/, '') || '0').join('-');
  }

  const roadmapUsesHyphenedIds = [...normalized].some(n => n.includes('-'));
  const numericRe = roadmapUsesHyphenedIds
    ? /^0*(\d+(?:-0*\d+)*[A-Za-z]?(?:\.\d+)*)/
    : /^0*(\d+[A-Za-z]?(?:\.\d+)*)/;

  function isDirInMilestone(dirName: string): boolean {
    const m2 = dirName.match(numericRe);
    if (m2 && normalized.has(normalizePhaseIdSegments(m2[1]).toLowerCase())) return true;
    const customMatch = dirName.match(/^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/);
    if (customMatch && normalized.has(customMatch[1].toLowerCase())) return true;
    const stripped = dirName.replace(/^[A-Z]{1,6}-(?=\d)/i, '');
    if (stripped !== dirName) {
      const sm = stripped.match(numericRe);
      if (sm && normalized.has(normalizePhaseIdSegments(sm[1]).toLowerCase())) return true;
    }
    return false;
  }
  (isDirInMilestone as MilestonePhaseFilter).phaseCount = milestonePhaseNums.size;
  (isDirInMilestone as MilestonePhaseFilter).missingExplicitVersion = missingExplicitVersion;
  return isDirInMilestone as MilestonePhaseFilter;
}

export = {
  stripShippedMilestones,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  getRoadmapPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
};
