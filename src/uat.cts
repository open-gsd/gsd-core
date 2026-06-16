/**
 * UAT Audit — Cross-phase UAT/VERIFICATION scanner
 *
 * Reads all *-UAT.md and *-VERIFICATION.md files across all phases.
 * Extracts non-passing items. Returns structured JSON for workflow consumption.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/uat.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParser = require('./roadmap-parser.cjs');
const { getMilestonePhaseFilter } = roadmapParser;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { toPosixPath } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatter;
import { requireSafePath, sanitizeForDisplay } from './security.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

type UatResult = string;
type UatCategory = 'server_blocked' | 'device_needed' | 'build_needed' | 'third_party' | 'blocked' | 'skipped_unresolved' | 'pending' | 'human_uat' | 'unknown';

interface UatItem {
  test?: number;
  name: string;
  expected?: string;
  result: UatResult;
  category: UatCategory;
  reason?: string;
  blocked_by?: string;
}

interface UatFileResult {
  phase: string;
  phase_dir: string;
  file: string;
  file_path: string;
  type: 'uat' | 'verification';
  status: string;
  items: UatItem[];
}

interface CurrentTest {
  complete: boolean;
  number?: number;
  name?: string;
  expected?: string;
}

// ─── cmdAuditUat ─────────────────────────────────────────────────────────────

function cmdAuditUat(cwd: string, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  if (!fs.existsSync(phasesDir)) {
    error('No phases directory found in planning directory');
  }

  const isDirInMilestone = getMilestonePhaseFilter(cwd);
  const results: UatFileResult[] = [];

  // Scan all phase directories
  const dirs = fs.readdirSync(phasesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(isDirInMilestone)
    .sort();

  for (const dir of dirs) {
    const phaseMatch = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
    const phaseNum = phaseMatch ? phaseMatch[1] : dir;
    const phaseDir = path.join(phasesDir, dir);
    const files = fs.readdirSync(phaseDir);

    // Process UAT files
    for (const file of files.filter(f => f.includes('-UAT') && f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(phaseDir, file), 'utf-8');
      const items = parseUatItems(content);
      if (items.length > 0) {
        results.push({
          phase: phaseNum,
          phase_dir: dir,
          file,
          file_path: toPosixPath(path.relative(cwd, path.join(phaseDir, file))),
          type: 'uat',
          status: (extractFrontmatter(content).status as string || 'unknown'),
          items,
        });
      }
    }

    // Process VERIFICATION files
    for (const file of files.filter(f => f.includes('-VERIFICATION') && f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(phaseDir, file), 'utf-8');
      const status = extractFrontmatter(content).status as string || 'unknown';
      if (status === 'human_needed' || status === 'gaps_found') {
        const items = parseVerificationItems(content, status);
        if (items.length > 0) {
          results.push({
            phase: phaseNum,
            phase_dir: dir,
            file,
            file_path: toPosixPath(path.relative(cwd, path.join(phaseDir, file))),
            type: 'verification',
            status,
            items,
          });
        }
      }
    }
  }

  // Compute summary
  const summary: {
    total_files: number;
    total_items: number;
    by_category: Record<string, number>;
    by_phase: Record<string, number>;
  } = {
    total_files: results.length,
    total_items: results.reduce((sum, r) => sum + r.items.length, 0),
    by_category: {},
    by_phase: {},
  };

  for (const r of results) {
    if (!summary.by_phase[r.phase]) summary.by_phase[r.phase] = 0;
    for (const item of r.items) {
      summary.by_phase[r.phase]++;
      const cat = item.category || 'unknown';
      summary.by_category[cat] = (summary.by_category[cat] || 0) + 1;
    }
  }

  output({ results, summary }, raw, undefined);
}

// ─── cmdRenderCheckpoint ──────────────────────────────────────────────────────

function cmdRenderCheckpoint(cwd: string, options: { file?: string } = {}, raw: boolean): void {
  const filePath = options.file;
  if (!filePath) {
    error('UAT file required: use uat render-checkpoint --file <path>');
  }

  const resolvedPath = requireSafePath(filePath, cwd, 'UAT file', { allowAbsolute: true });
  if (!fs.existsSync(resolvedPath)) {
    error(`UAT file not found: ${filePath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const currentTest = parseCurrentTest(content);

  if (currentTest.complete) {
    error('UAT session is already complete; no pending checkpoint to render');
  }

  const checkpoint = buildCheckpoint(currentTest as Required<Omit<CurrentTest, 'complete'>> & { complete: false });
  output({
    file_path: toPosixPath(path.relative(cwd, resolvedPath)),
    test_number: currentTest.number,
    test_name: currentTest.name,
    checkpoint,
  }, raw, checkpoint);
}

// ─── parseCurrentTest ─────────────────────────────────────────────────────────

function parseCurrentTest(content: string): CurrentTest {
  const currentTestMatch = content.match(/##\s*Current Test\s*(?:\n<!--[\s\S]*?-->)?\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!currentTestMatch) {
    error('UAT file is missing a Current Test section');
  }

  const section = currentTestMatch![1].trimEnd();
  if (!section.trim()) {
    error('Current Test section is empty');
  }

  if (/\[testing complete\]/i.test(section)) {
    return { complete: true };
  }

  const numberMatch = section.match(/^number:\s*(\d+)\s*$/m);
  const nameMatch = section.match(/^name:\s*(.+)\s*$/m);
  const expectedBlockMatch = section.match(/^expected:\s*\|\n([\s\S]*?)(?=^\w[\w-]*:\s)/m)
    || section.match(/^expected:\s*\|\n([\s\S]+)/m);
  const expectedInlineMatch = section.match(/^expected:\s*(.+)\s*$/m);

  if (!numberMatch || !nameMatch || (!expectedBlockMatch && !expectedInlineMatch)) {
    if (!numberMatch && !nameMatch && !expectedBlockMatch && !expectedInlineMatch) {
      const pendingTest = parseFirstPendingTest(content);
      if (pendingTest) {
        return pendingTest;
      }
      error('Current Test section is non-structured and no pending UAT test remains to resume');
    }
    error('Current Test section is malformed');
  }

  let expected: string;
  if (expectedBlockMatch) {
    expected = expectedBlockMatch[1]
      .split('\n')
      .map((line: string) => line.replace(/^ {2}/, ''))
      .join('\n')
      .trim();
  } else {
    expected = expectedInlineMatch![1].trim();
  }

  return {
    complete: false,
    number: parseInt(numberMatch![1], 10),
    name: sanitizeForDisplay(nameMatch![1].trim()),
    expected: sanitizeForDisplay(expected),
  };
}

function parseFirstPendingTest(content: string): CurrentTest | null {
  const testsMatch = content.match(/##\s*Tests\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!testsMatch) {
    return null;
  }

  const testsSection = testsMatch[1];
  const headingPattern = /^###\s*(\d+)\.\s*([^\n]+)\s*$/gm;
  const headings: Array<{ index: number; number: number; name: string }> = [];
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingPattern.exec(testsSection)) !== null) {
    headings.push({
      index: headingMatch.index,
      number: parseInt(headingMatch[1], 10),
      name: headingMatch[2].trim(),
    });
  }

  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i];
    const next = headings[i + 1];
    const block = testsSection.slice(current.index, next ? next.index : undefined);
    if (!/^result:\s*\[?pending\]?\s*$/im.test(block)) {
      continue;
    }

    const expected = parseExpectedFromTestBlock(block);
    if (!expected) {
      error(`Pending UAT test ${current.number} is missing an expected field`);
    }

    return {
      complete: false,
      number: current.number,
      name: sanitizeForDisplay(current.name),
      expected: sanitizeForDisplay(expected),
    };
  }

  return null;
}

function parseExpectedFromTestBlock(block: string): string | null {
  const expectedBlockMatch = block.match(/^expected:\s*\|\n([\s\S]*?)(?=^\w[\w-]*:\s)/m)
    || block.match(/^expected:\s*\|\n([\s\S]+)/m);
  if (expectedBlockMatch) {
    return expectedBlockMatch[1]
      .split('\n')
      .map((line: string) => line.replace(/^ {2}/, ''))
      .join('\n')
      .trim();
  }

  const expectedInlineMatch = block.match(/^expected:\s*(.+)\s*$/m);
  return expectedInlineMatch ? expectedInlineMatch[1].trim() : null;
}

// ─── buildCheckpoint ──────────────────────────────────────────────────────────

function buildCheckpoint(currentTest: { number: number; name: string; expected: string }): string {
  return [
    '╔══════════════════════════════════════════════════════════════╗',
    '║  CHECKPOINT: Verification Required                           ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `**Test ${currentTest.number}: ${currentTest.name}**`,
    '',
    currentTest.expected,
    '',
    '──────────────────────────────────────────────────────────────',
    'Type `pass` or describe what\'s wrong.',
    '──────────────────────────────────────────────────────────────',
  ].join('\n');
}

// ─── parseUatItems ────────────────────────────────────────────────────────────

function parseUatItems(content: string): UatItem[] {
  const items: UatItem[] = [];
  // Match test blocks: ### N. Name\nexpected: ...\nresult: ...\n
  // Accept both bare (result: pending) and bracketed (result: [pending]) formats (#2273)
  const testPattern = /###\s*(\d+)\.\s*([^\n]+)\nexpected:\s*([^\n]+)\nresult:\s*\[?(\w+)\]?(?:\n(?:reported|reason|blocked_by):\s*[^\n]*)?/g;
  let match: RegExpExecArray | null;
  while ((match = testPattern.exec(content)) !== null) {
    const [, num, name, expected, result] = match;
    if (result === 'pending' || result === 'skipped' || result === 'blocked') {
      // Extract optional fields — limit to current test block (up to next ### or EOF)
      const afterMatch = content.slice(match.index);
      const nextHeading = afterMatch.indexOf('\n###', 1);
      const blockText = nextHeading > 0 ? afterMatch.slice(0, nextHeading) : afterMatch;
      const reasonMatch = blockText.match(/reason:\s*(.+)/);
      const blockedByMatch = blockText.match(/blocked_by:\s*(.+)/);

      const item: UatItem = {
        test: parseInt(num, 10),
        name: name.trim(),
        expected: expected.trim(),
        result,
        category: categorizeItem(result, reasonMatch?.[1], blockedByMatch?.[1]),
      };
      if (reasonMatch) item.reason = reasonMatch[1].trim();
      if (blockedByMatch) item.blocked_by = blockedByMatch[1].trim();
      items.push(item);
    }
  }
  return items;
}

// ─── parseVerificationItems ───────────────────────────────────────────────────

function parseVerificationItems(content: string, status: string): UatItem[] {
  const items: UatItem[] = [];
  if (status === 'human_needed') {
    // Extract from human_verification section — look for numbered items or table rows
    const hvSection = content.match(/##\s*Human Verification.*?\n([\s\S]*?)(?=\n##\s|\n---\s|$)/i);
    if (hvSection) {
      const lines = hvSection[1].split('\n');
      for (const line of lines) {
        // Match table rows: | N | description | ... |
        const tableMatch = line.match(/\|\s*(\d+)\s*\|\s*([^|]+)/);
        // Match bullet items: - description
        const bulletMatch = line.match(/^[-*]\s+(.+)/);
        // Match numbered items: 1. description
        const numberedMatch = line.match(/^(\d+)\.\s+(.+)/);

        if (tableMatch) {
          // Skip rows that already have a passing result (PASS, pass, resolved, etc.)
          const rowRemainder = line.slice(tableMatch.index! + tableMatch[0].length);
          const cellValues = rowRemainder.split('|').map(c => c.trim());
          const hasPassResult = cellValues.some(c => /^pass$/i.test(c) || /^resolved$/i.test(c));
          if (hasPassResult) continue;
          items.push({
            test: parseInt(tableMatch[1], 10),
            name: tableMatch[2].trim(),
            result: 'human_needed',
            category: 'human_uat',
          });
        } else if (numberedMatch) {
          items.push({
            test: parseInt(numberedMatch[1], 10),
            name: numberedMatch[2].trim(),
            result: 'human_needed',
            category: 'human_uat',
          });
        } else if (bulletMatch && bulletMatch[1].length > 10) {
          items.push({
            name: bulletMatch[1].trim(),
            result: 'human_needed',
            category: 'human_uat',
          });
        }
      }
    }
  }
  // gaps_found items are already handled by plan-phase --gaps pipeline
  return items;
}

// ─── categorizeItem ───────────────────────────────────────────────────────────

function categorizeItem(result: string, reason?: string, blockedBy?: string): UatCategory {
  if (result === 'blocked' || blockedBy) {
    if (blockedBy) {
      if (/server/i.test(blockedBy)) return 'server_blocked';
      if (/device|physical/i.test(blockedBy)) return 'device_needed';
      if (/build|release|preview/i.test(blockedBy)) return 'build_needed';
      if (/third.party|twilio|stripe/i.test(blockedBy)) return 'third_party';
    }
    return 'blocked';
  }
  if (result === 'skipped') {
    if (reason) {
      if (/server|not running|not available/i.test(reason)) return 'server_blocked';
      if (/simulator|physical|device/i.test(reason)) return 'device_needed';
      if (/build|release|preview/i.test(reason)) return 'build_needed';
    }
    return 'skipped_unresolved';
  }
  if (result === 'pending') return 'pending';
  if (result === 'human_needed') return 'human_uat';
  return 'unknown';
}

export = {
  cmdAuditUat,
  cmdRenderCheckpoint,
  parseCurrentTest,
  buildCheckpoint,
};
