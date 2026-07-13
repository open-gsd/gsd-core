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
  stripProjectCodePrefix,
  OPTIONAL_PHASE_TAG_SOURCE,
  // #2121: roadmapPhaseLookupSources now lives in phase-id.cjs (single owner of
  // the lookup-source ordering); imported here rather than defined locally.
  roadmapPhaseLookupSources,
} = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
import { platformReadSync } from './shell-command-projection.cjs';
import { tokenizeHeadings, stripTaggedBlocks } from './markdown-sectionizer.cjs';

// ─── Roadmap milestone scoping ───────────────────────────────────────────────

/**
 * Strip shipped milestone content wrapped in <details> blocks.
 */
function stripShippedMilestones(content: string): string {
  return stripTaggedBlocks(content, 'details');
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
        const preamble = stripTaggedBlocks(content.slice(0, preambleCutoff), 'details')
          // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
          .replace(/^#{2,4}\s*Phase\s+[\w][\w.-]*(?:\s*\([^)\n]{0,200}\))?\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim, '')
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

  const preamble = stripTaggedBlocks(beforeMilestones, 'details')
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    .replace(/^#{2,4}\s*Phase\s+[\w][\w.-]*(?:\s*\([^)\n]{0,200}\))?\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim, '')
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

// #2199: a bullet/checkbox phase entry, e.g. `- [ ] **Phase 36 — Authentication**`
// (the bundled roadmapper emits this in bullet-house-style ROADMAPs). The number
// is captured in group 1, the name in group 2; the separator may be an em-dash,
// en-dash, hyphen, or colon. Used as a fallback when no ATX heading matches, and
// to count phases in a milestone that uses the bullet form.
const BULLET_PHASE_LINE_PATTERN =
  /^\s*[-*]\s+(?:\[[ xX]\]\s+)?\*\*Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*[—–:\-]\s*(.+?)\*\*/im;

/** Build a bullet-phase-line regex pinned to a specific phase number (#2199). */
function bulletPhaseLineFor(phaseNum: unknown, phaseSource?: string): RegExp {
  const num = phaseSource ?? phaseMarkdownRegexSource(phaseNum);
  return new RegExp(
    `^\\s*[-*]\\s+(?:\\[[ xX]\\]\\s+)?\\*\\*Phase\\s+(${num})${OPTIONAL_PHASE_TAG_SOURCE}\\s*[—–:\\-]\\s*(.+?)\\*\\*`,
    'im',
  );
}

interface RoadmapPhaseResult {
  found: boolean;
  phase_number: string;
  phase_name: string;
  goal: string | null;
  section: string;
}

function findRoadmapPhaseInContent(content: string, phaseNum: unknown, phaseSource?: string): RoadmapPhaseResult | null {
  // #1729: OPTIONAL_PHASE_TAG_SOURCE after the number tolerates a pre-colon ( ) tag.
  const headingPattern = new RegExp(
    `^(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+${phaseSource ?? phaseMarkdownRegexSource(phaseNum)}${OPTIONAL_PHASE_TAG_SOURCE}:\\s*(.+)$`,
    'i'
  );
  const headings = tokenizeHeadings(content);
  const headingIndex = headings.findIndex((heading) => headingPattern.test(heading.text));
  if (headingIndex === -1) return null;

  const heading = headings[headingIndex];
  const headerMatch = heading.text.match(headingPattern);
  if (!headerMatch) return null;

  const phaseName = headerMatch[1].trim();
  const nextHeading = headings.slice(headingIndex + 1).find((candidate) => candidate.level <= heading.level);
  const sectionEnd = nextHeading ? nextHeading.offset : content.length;
  const section = content.slice(heading.offset, sectionEnd).trim();

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

function findRoadmapBulletPhaseInContent(content: string, phaseNum: unknown, phaseSource?: string): RoadmapPhaseResult | null {
  // #2199: bullet/checkbox entry fallback (`- [ ] **Phase N — name**`). Returns
  // the single bullet line as the section (no multi-line body) — used only as a
  // last resort, AFTER heading lookup on scoped + full content has failed, so a
  // heading with a Requirements/Goal section always wins.
  const bulletMatch = content.match(bulletPhaseLineFor(phaseNum, phaseSource));
  if (!bulletMatch) return null;
  return {
    found: true,
    phase_number: String(phaseNum),
    phase_name: bulletMatch[2].trim(),
    goal: null,
    section: bulletMatch[0].trim(),
  };
}

function getRoadmapPhaseInternal(cwd: string, phaseNum: unknown): RoadmapPhaseResult | null {
  if (!phaseNum) return null;
  const normalizedPhase = stripProjectCodePrefix(phaseNum);
  if (/^999(?:\.|$)/.test(normalizedPhase)) return null;
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

    // #2199: no ATX heading matched on scoped or full content — fall back to a
    // bullet/checkbox entry (em-dash/en-dash/hyphen/colon separator). Last resort
    // so a bullet never pre-empts a heading that carries the Requirements section.
    for (const source of roadmapPhaseLookupSources(phaseNum)) {
      const scopedBullet = findRoadmapBulletPhaseInContent(content, phaseNum, source);
      if (scopedBullet) return scopedBullet;

      const fullBullet = findRoadmapBulletPhaseInContent(fullContent, phaseNum, source);
      if (fullBullet) return fullBullet;
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

/**
 * Strip a leading delimiter run (whitespace, em/en-dash, colon, hyphen) from a
 * milestone-name capture. Markdown headings commonly take the shape
 * `## vX.Y — Name` or `## vX.Y: Name`; the raw capture includes the delimiter
 * because `.trim()` only removes whitespace, not punctuation. A name beginning
 * with punctuation is a delimiter-led fragment, not the curated name (#2135).
 * NOTE: do not strip `#` — a name beginning with `#` is a heading-parse failure
 * that should stay loud rather than be silently cleaned.
 */
function stripLeadingDelimiter(s: string): string {
  return s.replace(/^[\s—–:-]+/, '').trim();
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

      // #2135: consult the 🚧 name-bearing marker FIRST. It is the only construct
      // guaranteed to carry the milestone's curated name adjacent to its version
      // (the active-milestone bullet). A `##` heading is often nameless
      // ("## vX.Y — Active Milestone") and, when unanchored, was matched
      // spuriously on a copy quoted inside backticks in this very bullet.
      const listMatch = roadmap.match(
        new RegExp(`🚧\\s*\\*?\\*?${escapedVer}\\s+([^*\\n]+)`, 'i')
      );
      if (listMatch) {
        const name = stripLeadingDelimiter(listMatch[1]);
        if (name) return { version: stateVersion, name };
      }

      // Fall back to the `##` heading — ANCHORED to line start (`^` + `m` flag)
      // so a heading quoted inside backticks or prose mid-line can no longer
      // match. Skip shipped (✅) headings.
      const headingMatch = roadmap.match(
        new RegExp(`^##[^\\n]*${escapedVer}[:\\s]+([^\\n(]+)`, 'im')
      );
      if (headingMatch && !headingMatch[0].includes('✅')) {
        // Strip a leading delimiter — `.trim()` removes whitespace, not the
        // em-dash/colon that conventionally separates version from name.
        const name = stripLeadingDelimiter(headingMatch[1]);
        if (name) return { version: stateVersion, name };
      }

      return { version: stateVersion, name: 'milestone' };
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
    const hasPhaseHeadings = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+[\w]/i.test(roadmapContent);
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
    // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
    const phaseHeadingPattern = /^(?:\[[^\]]{1,200}\]\s*)?Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:/i;
    for (const h of tokenizeHeadings(roadmap)) {
      if (h.level < 2 || h.level > 4) continue;
      const pm = phaseHeadingPattern.exec(h.text);
      // Exclude 999.x backlog phases from milestone phase set. Mirrors init.cts filter.
      if (pm && !/^999\b/.test(pm[1])) milestonePhaseNums.add(pm[1]);
    }
    // #2199: also count bullet/checkbox phase entries (`- [ ] **Phase N — name**`)
    // so a bullet-house-style ROADMAP populates the milestone phase set instead of
    // collapsing to a zero-count pass-all filter.
    {
      let bm: RegExpExecArray | null;
      const scanner = new RegExp(BULLET_PHASE_LINE_PATTERN.source, 'gim');
      while ((bm = scanner.exec(roadmap)) !== null) {
        if (!/^999\b/.test(bm[1])) milestonePhaseNums.add(bm[1]);
      }
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
  // #2043: milestone-prefixed sub-phase components must be zero-padded (≥2 digits)
  // — "-\d{2,}" instead of "-0*\d+" — so a single-digit slug word after the phase
  // number (e.g. dir "46-6-rs-…") captures "46" and is not silently excluded from
  // the milestone as a bogus "46-6" id.
  const numericRe = roadmapUsesHyphenedIds
    ? /^0*(\d+(?:-\d{2,})*[A-Za-z]?(?:\.\d+)*)/
    // phase-id-owner: the [A-Za-z] letter class does real case handling here — this regex carries NO /i flag; kept literal, not source-byte-equal to the canonical PHASE_NUMBER_TOKEN_SOURCE.
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

/**
 * #2200: raw [start,end) offsets of the current milestone's region(s) in ROADMAP
 * content, for scoping write-path mutations (phase-checkbox flip, Plans-count
 * writer) so they cannot touch a backticked prose literal, a Backlog entry, or a
 * same-numbered phase in a shipped milestone.
 *
 * Mirrors the region selection in `extractCurrentMilestone` (version detection →
 * active heading → next milestone boundary → optional Phase Details section).
 * Returns null when there is no versioned active milestone; callers then fall
 * back to whole-content mutation (the prior behaviour).
 *
 * NOTE: keep the region logic here in sync with extractCurrentMilestone.
 */
function currentMilestoneRawRanges(
  content: string,
  cwd?: string,
): { primary: { start: number; end: number }; details: { start: number; end: number } | null } | null {
  if (!cwd) return null;

  let version: string | null = null;
  try {
    const statePath = path.join(planningDir(cwd), 'STATE.md');
    const stateRaw = platformReadSync(statePath);
    if (stateRaw !== null) {
      const milestoneMatch = stateRaw.match(/^milestone:\s*(.+)/m);
      if (milestoneMatch) version = milestoneMatch[1].trim();
    }
  } catch { /* ignore */ }
  if (!version) {
    const inProgressMatch = content.match(/(?:🚧|🔄)\s*\*\*v(\d+\.\d+)\s/);
    if (inProgressMatch) version = 'v' + inProgressMatch[1];
  }
  if (!version) return null;

  const escapedVersion = escapeRegex(version);
  const sectionPattern = new RegExp(
    `(^#{1,3}\\s+(?!Phase\\s+\\S).*${escapedVersion}\\b[^\\n]*)`,
    'gmi',
  );
  const headingMatches = [...content.matchAll(sectionPattern)];
  if (headingMatches.length === 0) return null;

  const closedMarkerPattern = /\b(?:CLOSED|ARCHIVED|ABANDONED|SHIPPED|FAILED)\b|✅|🗄/i;
  const activeMarkerPattern = /\b(?:STARTED|ACTIVE|WIP)\b|in\s+progress|🚧|🔄/i;
  const isClosed = (h: string) => closedMarkerPattern.test(h) && !activeMarkerPattern.test(h);
  const firstMatch = headingMatches[0];
  const selected = headingMatches.find((m) => !isClosed(m[1])) || firstMatch;
  const sectionStart = selected.index ?? 0;

  const computeSectionEnd = (headingText: string, headingStart: number): number => {
    const level = (headingText.match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
    const afterHeading = headingStart + headingText.length;
    for (const h of tokenizeHeadings(content)) {
      if (h.offset <= headingStart) continue;
      if (h.offset < afterHeading) continue;
      if (h.level > level) continue;
      if (/^Phase\s+\S/i.test(h.text)) continue;
      if (!/v\d+\.\d+|✅|📋|🚧/i.test(h.text)) continue;
      return h.offset;
    }
    return content.length;
  };
  const sectionEnd = computeSectionEnd(selected[0], sectionStart);

  const selectedVersionToken = selected[1].match(
    /v\d+(?:\.\d+)+(?:[-.][A-Za-z0-9]+)*/i,
  )?.[0];
  const detailsVersionBoundary = selectedVersionToken
    ? new RegExp(`${escapeRegex(selectedVersionToken)}(?![\\w.-])`, 'i')
    : null;
  const detailsMatch = headingMatches.find(
    (m) =>
      /\(Phase\s+Details\)/i.test(m[1]) &&
      !isClosed(m[1]) &&
      (!detailsVersionBoundary || detailsVersionBoundary.test(m[1])) &&
      (m.index ?? 0) >= sectionEnd,
  );
  let details: { start: number; end: number } | null = null;
  if (detailsMatch) {
    const detailsStart = detailsMatch.index ?? 0;
    details = { start: detailsStart, end: computeSectionEnd(detailsMatch[0], detailsStart) };
  }

  return { primary: { start: sectionStart, end: sectionEnd }, details };
}

export = {
  stripShippedMilestones,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  getRoadmapPhaseInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  currentMilestoneRawRanges,
};
