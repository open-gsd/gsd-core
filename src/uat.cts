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
import markdownSectionizer = require('./markdown-sectionizer.cjs');
const { collectSection, tokenizeHeadings } = markdownSectionizer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownTable = require('./markdown-table.cjs');
const { splitTableRow } = markdownTable;
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { PHASE_NUMBER_TOKEN_SOURCE } = phaseIdMod;
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
    const phaseMatch = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
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
  // Use the seam to locate the ## Current Test section (ADR-1372 T5).
  // HTML-comment stripping within the section body is UAT-specific, so we keep
  // the comment removal caller-side after extracting the body.
  const currentTestSection = collectSection(
    content,
    (h) => /^current\s+test$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  if (!currentTestSection) {
    error('UAT file is missing a Current Test section');
  }

  // Remove any leading HTML comment block (UAT-specific document structure)
  const rawBody = currentTestSection!.body.replace(/^<!--[\s\S]*?-->\s*\n?/, '');
  const section = rawBody.trimEnd();
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
  // Use the seam to locate the ## Tests section (ADR-1372 T5).
  const testsSection = collectSection(
    content,
    (h) => /^tests$/i.test(h.text) && h.level === 2,
    { levelBounded: true },
  );
  if (!testsSection) {
    return null;
  }

  const sectionBody = testsSection.body;

  // Within the Tests section body, find ### N. Name sub-headings.
  // tokenizeHeadings operates on the section body as a standalone document,
  // filtering to level-3 headings matching the UAT-specific "N. Name" pattern.
  // The UAT-specific item parsing (number extraction, result parsing) stays caller-side.
  const subHeadings = tokenizeHeadings(sectionBody).filter(
    (h) => h.level === 3 && /^\d+\.\s+/.test(h.text),
  );

  for (let i = 0; i < subHeadings.length; i += 1) {
    const current = subHeadings[i];
    const next = subHeadings[i + 1];
    // Slice the block for this sub-test from the section body text
    const block = next
      ? sectionBody.slice(current.offset, next.offset)
      : sectionBody.slice(current.offset);

    if (!/^result:\s*\[?pending\]?\s*$/im.test(block)) {
      continue;
    }

    // Extract the UAT-specific number and name from the heading text
    const headingParts = current.text.match(/^(\d+)\.\s+(.+)$/);
    if (!headingParts) continue;
    const testNumber = parseInt(headingParts[1], 10);
    const testName = headingParts[2].trim();

    const expected = parseExpectedFromTestBlock(block);
    if (!expected) {
      error(`Pending UAT test ${testNumber} is missing an expected field`);
    }

    return {
      complete: false,
      number: testNumber,
      name: sanitizeForDisplay(testName),
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
    // Use the seam to locate the ## Human Verification section (ADR-1372 T5).
    const hvSection = collectSection(
      content,
      (h) => /^human\s+verification/i.test(h.text) && h.level === 2,
      { levelBounded: true },
    );
    if (hvSection) {
      // #2245 review Fix 3: reverted to the pre-Phase-4 (HEAD 2cbf18642)
      // implementation. The live Human Verification section is NOT a strict
      // GFM table — the planner/verifier templates mix table rows, numbered
      // items, and bullet items in the same section (and a `### N.` heading
      // format is common too), so a table-XOR-list read (parse a table, and
      // if it parses, suppress numbered/bullet items entirely) silently
      // dropped items on any mixed or malformed section: a malformed
      // `| N | … |` table with no valid header/delimiter yielded ZERO items
      // instead of reading the rows positionally. This per-line scan reads
      // table rows AND numbered items AND bullet items as a UNION (whichever
      // pattern a given line matches), exactly like OLD, and reads
      // `| N | desc |` rows even without a valid table header/delimiter.
      //
      // #2245 audit: the table-row branch's CELL SPLIT is name/position-
      // addressed via `splitTableRow` (escape-aware, canonical) instead of a
      // hand-rolled pipe regex — candidacy itself is decided WITHOUT a table
      // regex (a leading `|` plus a purely-numeric first cell), so this no
      // longer needs an allow-adhoc-markdown suppression at all.
      const lines = hvSection.body.split('\n');
      for (const line of lines) {
        const trimmedLine = line.trim();
        // Match table rows: | N | description | ... — candidacy requires a
        // leading pipe and a purely-numeric first cell (mirrors what the old
        // regex effectively required: a "|digit|" cell immediately followed
        // by more content), with at least 2 physical cells so a bare "| N |"
        // with nothing after it is NOT treated as a row.
        //
        // #2245 review Fix 9: this is NOT the same as OLD for a row whose
        // ONLY content past the digit cell is trailing whitespace (e.g.
        // "| N | ", no second delimiting `|`). OLD's `([^|]+)` regex ran
        // against the RAW (untrimmed) line and its `\s*` would backtrack to
        // let `[^|]+` swallow that trailing whitespace, so OLD matched and
        // pushed an item with an EMPTY (`.trim()`-collapsed) name. Here,
        // `trimmedLine = line.trim()` strips that trailing whitespace BEFORE
        // `splitTableRow` ever sees it, collapsing the line to a single cell
        // (`candidateCells.length === 1`), which fails the `>= 2` check —
        // the item is silently dropped instead. A real, acceptable behaviour
        // change (an empty-named UAT item is not useful either way), but the
        // two implementations are NOT equivalent on this input.
        let tableCells: string[] | null = null;
        if (trimmedLine.startsWith('|')) {
          const candidateCells = splitTableRow(trimmedLine);
          if (candidateCells.length >= 2 && /^\d+$/.test(candidateCells[0])) {
            tableCells = candidateCells;
          }
        }
        // Match bullet items: - description
        const bulletMatch = line.match(/^[-*]\s+(.+)/);
        // Match numbered items: 1. description
        const numberedMatch = line.match(/^(\d+)\.\s+(.+)/);

        if (tableCells) {
          // Skip rows that already have a passing result (PASS, pass, resolved, etc.)
          // — checked over every cell AFTER the description column, mirroring
          // OLD's rowRemainder scan (which only ever saw cells past the
          // description, the description itself having already been consumed).
          const hasPassResult = tableCells.slice(2).some(c => /^pass$/i.test(c) || /^resolved$/i.test(c));
          if (hasPassResult) continue;
          items.push({
            test: parseInt(tableCells[0], 10),
            name: tableCells[1] ?? '',
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
