/**
 * Roadmap Parser — ROADMAP.md parsing helpers
 *
 * ADR-857 rollout phase 2b: extracted from core.cts (issue #870).
 * Owns shipped-milestone slicing, current-milestone extraction,
 * milestone/phase lookups, and milestone-phase filtering.
 * Behaviour is preserved byte-for-behaviour from the prior location;
 * only the module boundary moved. The core.cjs re-export spine was retired
 * in epic #1267; callers import roadmap-parser helpers directly.
 *
 * Dependencies (leaf modules only — no loadConfig):
 *   - node:fs / node:path (stdlib)
 *   - ./phase-id.cjs        (escapeRegex, phaseMarkdownRegexSource)
 *   - ./planning-workspace.cjs (planningDir)
 *   - ./shell-command-projection.cjs (platformReadSync)
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const {
  escapeRegex,
  phaseMarkdownRegexSource,
  phaseMarkdownRegexSourceExact,
  stripProjectCodePrefix,
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
} = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
import { platformReadSync } from './shell-command-projection.cjs';
import { tokenizeHeadings } from './markdown-sectionizer.cjs';

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
    const afterHeading = headingStart + headingText.length;
    // Use tokenizeHeadings (fence-aware, offsets into original content) to find
    // the next stop boundary without re-implementing fence detection. T4 seam migration.
    const headings = tokenizeHeadings(content);
    for (const h of headings) {
      if (h.offset <= headingStart) continue;
      if (h.offset < afterHeading) continue;
      if (h.level > level) continue;
      // Mirrors old stopPattern: level-bounded, not a Phase heading, milestone marker
      if (/^Phase\s+\S/i.test(h.text)) continue;
      if (!/v\d+\.\d+|✅|📋|🚧/i.test(h.text)) continue;
      return h.offset;
    }
    return content.length;
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

function findRoadmapPhaseInContent(content: string, phaseNum: unknown, phaseSource?: string): RoadmapPhaseResult | null {
  const phasePattern = new RegExp(
    `#{2,4}\\s*(?:\\[[^\\]]+\\]\\s*)?Phase\\s+${phaseSource ?? phaseMarkdownRegexSource(phaseNum)}:\\s*([^\\n]+)`,
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
    phase_number: String(phaseNum),
    phase_name: phaseName,
    goal,
    section,
  };
}

function roadmapPhaseLookupSources(phaseNum: unknown): string[] {
  const sources: string[] = [];
  const exactSource = phaseMarkdownRegexSourceExact(phaseNum);
  if (exactSource) sources.push(exactSource);

  const numericSource = phaseMarkdownRegexSource(phaseNum);
  // Source order matters: the bare numeric source is tried before the
  // prefix-tolerant form so that a canonical bare heading ("Phase 117:") is
  // preferred over a drifted prefixed heading ("Phase MANIFOLD-117:") when
  // both exist in the same ROADMAP.  The prefix-tolerant form is the fallback
  // that handles the drifted-only case.
  sources.push(numericSource);
  sources.push(`${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${numericSource}`);

  return [...new Set(sources)];
}

function getRoadmapPhaseInternal(cwd: string, phaseNum: unknown): RoadmapPhaseResult | null {
  if (!phaseNum) return null;
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return null;

  try {
    const roadmapRaw = platformReadSync(roadmapPath);
    if (roadmapRaw === null) throw new Error('missing');
    const content = extractCurrentMilestone(roadmapRaw, cwd);
    const fullContent = stripShippedMilestones(roadmapRaw);

    for (const source of roadmapPhaseLookupSources(phaseNum)) {
      const scopedResult = findRoadmapPhaseInContent(content, phaseNum, source);
      if (scopedResult) return scopedResult;

      const fullResult = findRoadmapPhaseInContent(fullContent, phaseNum, source);
      if (fullResult) return fullResult;
    }

    return null;
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

/**
 * Derives a stable identity for a milestone-boundary heading, or null when the
 * heading is not a milestone boundary. Identity is the version token if present
 * (`v3.0`, `v3.0-B`), else a numeric `Milestone N` label, else — for an
 * emoji-marked heading carrying neither — its normalized text. The `(Phase
 * Details)` suffix is stripped so a milestone's split continuation heading shares
 * its boundary heading's identity (#730 split layouts). A non-numeric prose
 * heading like `## Milestone Notes` yields null (not a boundary).
 */
function milestoneHeadingIdentity(headingText: string): string | null {
  const ver = headingText.match(/v\d+(?:\.\d+)+(?:[-.][A-Za-z0-9]+)*/i);
  if (ver) return 'v:' + ver[0].toLowerCase();
  const mnum = headingText.match(/\bMilestone\s+(\d+)/i);
  if (mnum) return 'm:' + mnum[1];
  if (/✅|📋|🚧|🔄/u.test(headingText)) {
    return 't:' + headingText.replace(/\(Phase\s+Details\)/i, '').replace(/[✅📋🚧🔄]/gu, '').trim().toLowerCase();
  }
  return null;
}

/**
 * Counts the number of DISTINCT milestones a block of ROADMAP text spans, used
 * to decide whether a resolved milestone scope conflates siblings (#1761).
 *
 * Only milestone-boundary headings at the SHALLOWEST matched level are counted —
 * deeper marker-bearing subheadings (e.g. `### v3.0 Notes`, `### Milestone 4
 * Risks`) inside a section are not milestone boundaries. Boundaries are then
 * deduplicated by milestone identity, so a milestone heading and its same-version
 * `(Phase Details)` continuation count once (#730 split layouts), while genuinely
 * distinct siblings count separately.
 */
function countMilestoneHeadings(text: string): number {
  const matched: Array<{ level: number; id: string }> = [];
  for (const h of tokenizeHeadings(text)) {
    if (h.level < 1 || h.level > 3) continue;
    if (/^Phase\s+\S/i.test(h.text)) continue;
    const id = milestoneHeadingIdentity(h.text);
    if (id) matched.push({ level: h.level, id });
  }
  if (matched.length === 0) return 0;
  const base = Math.min(...matched.map(m => m.level));
  return new Set(matched.filter(m => m.level === base).map(m => m.id)).size;
}

/**
 * Detects when the current milestone cannot be bounded to a single ROADMAP
 * section, so any phase count derived from the resolved scope would conflate
 * phases from sibling milestones (#1761).
 *
 * Works on the SCOPE that `extractCurrentMilestone` actually returns, counting
 * the milestone-boundary headings inside it. A correctly bounded milestone yields
 * exactly one; >= 2 means the scope conflates siblings — whether because the
 * version anchor matched no heading (whole-document fallback) or because the
 * section bled past an unversioned sibling milestone (extractCurrentMilestone's
 * computeSectionEnd only stops on versioned/marked headings).
 *
 * Returns true only when BOTH hold:
 *   1. A milestone version anchor is resolvable — STATE.md's `milestone:` field,
 *      else a `🚧/🔄 **vX.Y` in-progress marker in the ROADMAP. Without an anchor
 *      the project has not declared a current milestone and whole-document scope
 *      is the intended reading, so we never fire.
 *   2. The resolved scope contains >= 2 milestone-boundary headings.
 *
 * A single-milestone ROADMAP (one heading in scope) or a version that resolves
 * cleanly to one section both return false, so callers proceed exactly as before.
 */
function currentMilestoneScopeIsAmbiguous(roadmapContent: string, cwd?: string): boolean {
  // (1) Resolve the version anchor exactly as extractCurrentMilestone does.
  let version: string | null = null;
  if (cwd) {
    try {
      const stateRaw = platformReadSync(path.join(planningDir(cwd), 'STATE.md'));
      if (stateRaw !== null) {
        const m = stateRaw.match(/^milestone:\s*(.+)/m);
        if (m) version = m[1].trim();
      }
    } catch { /* ignore */ }
  }
  if (!version) {
    const inProgress = roadmapContent.match(/(?:🚧|🔄)\s*\*\*v(\d+\.\d+)\s/);
    if (inProgress) version = 'v' + inProgress[1];
  }
  if (!version) return false; // No anchor → legacy whole-document scope is intended.

  // (2) Count milestone-boundary headings within the RESOLVED scope. >= 2 means
  // the scope conflates more than one milestone.
  const scope = extractCurrentMilestone(roadmapContent, cwd);
  return countMilestoneHeadings(scope) >= 2;
}

// ─── Milestone phase filter ───────────────────────────────────────────────────

type MilestonePhaseFilter = ((dirName: string) => boolean) & {
  phaseCount: number;
  missingExplicitVersion: boolean;
};

/**
 * Returns a filter function that checks whether a phase directory belongs
 * to the current milestone based on ROADMAP.md phase headings.
 *
 * @param cwd - Project working directory.
 * @param versionOverride - Optional version string to scope the phase filter
 *   to a specific milestone (e.g. 'v1.2').
 * @param phaseIdConvention - The resolved `phase_id_convention` config value.
 *   When `'milestone-prefixed'`, a deprecation warning is emitted for
 *   free-form ROADMAPs that lack versioned milestone headings. When absent or
 *   any other value, the warning is suppressed — legacy/default projects must
 *   never see spurious warnings.
 */
function getMilestonePhaseFilter(cwd: string, versionOverride?: string | null, phaseIdConvention?: string | null): MilestonePhaseFilter {
  const milestonePhaseNums = new Set<string>();
  let missingExplicitVersion = false;
  try {
    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    const roadmapContent = platformReadSync(roadmapPath);
    if (roadmapContent === null) throw new Error('missing');
    let roadmap = extractCurrentMilestone(roadmapContent, cwd);

    const hasVersionedMilestonesGlobal = /^#{1,3}\s+.*v\d+\.\d+/mi.test(roadmapContent);
    const hasPhaseHeadings = /#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+[\w]/i.test(roadmapContent);
    if (!hasVersionedMilestonesGlobal && hasPhaseHeadings && phaseIdConvention === 'milestone-prefixed') {
      console.warn(
        '[gsd] Deprecated: free-form ROADMAP.md detected (no versioned milestone headings). ' +
        'The project has phase_id_convention set to "milestone-prefixed" in config.json but the ' +
        'ROADMAP does not use versioned milestone headings. Run `gsd-tools roadmap upgrade --convention milestone-prefixed` to migrate (dry-run by default).'
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
        const afterHeading = sectionStart + sectionMatch[0].length;
        // Use tokenizeHeadings (fence-aware, offsets into original content) to find
        // the next milestone-boundary heading. T4 seam migration.
        const allHeadings = tokenizeHeadings(roadmapContent);
        let sectionEnd = roadmapContent.length;
        for (const h of allHeadings) {
          if (h.offset < afterHeading) continue;
          if (h.level > headingLevel) continue;
          if (/^Phase\s+\S/i.test(h.text)) continue;
          if (!/v\d+\.\d+|✅|📋|🚧/i.test(h.text)) continue;
          sectionEnd = h.offset;
          break;
        }

        const currentSection = roadmapContent.slice(sectionStart, sectionEnd);
        roadmap = currentSection;
      }
    }

    // Use tokenizeHeadings (fence-aware) instead of stripFencedLines + regex.
    // T4 seam migration: phase headings inside fences are excluded automatically.
    const phaseHeadingPattern = /^(?:\[[^\]]+\]\s*)?Phase\s+([\w][\w.-]*)\s*:/i;
    for (const h of tokenizeHeadings(roadmap)) {
      if (h.level < 2 || h.level > 4) continue;
      const pm = phaseHeadingPattern.exec(h.text);
      // Exclude 999.x backlog phases from milestone phase set. Mirrors init.cts filter.
      if (pm && !/^999\b/.test(pm[1])) milestonePhaseNums.add(pm[1]);
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
    const stripped = stripProjectCodePrefix(dirName);
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
  currentMilestoneScopeIsAmbiguous,
};
