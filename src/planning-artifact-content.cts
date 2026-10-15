/**
 * Planning-artifact content normalization.
 *
 * PLAN.md and SUMMARY.md are model-authored payloads, but both pass through this
 * pure seam before their final Write call. Fence classification is delegated to
 * markdown-sectionizer so this normalizer cannot drift onto a second Markdown
 * dialect.
 */

import { scanFencedBlocks } from './markdown-sectionizer.cjs';
import fs from 'node:fs';

const STRAY_CONTENT_CLOSER = '</content>';
const STRAY_CONTENT_CLOSER_BYTES = Buffer.from(STRAY_CONTENT_CLOSER);
const STRAY_CONTENT_CLOSER_CR_BYTES = Buffer.from(`${STRAY_CONTENT_CLOSER}\r`);
const LF_BYTE = Buffer.from('\n');

function fencedLineIndexes(lines: string[]): Set<number> {
  const fencedLines = new Set<number>();
  for (const block of scanFencedBlocks(lines)) {
    const lastLine = block.closeLineIdx === -1 ? lines.length - 1 : block.closeLineIdx;
    for (let lineIndex = block.openLineIdx; lineIndex <= lastLine; lineIndex++) {
      fencedLines.add(lineIndex);
    }
  }
  return fencedLines;
}

function splitBufferOnLf(content: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  while (start <= content.length) {
    const end = content.indexOf(0x0a, start);
    if (end === -1) {
      lines.push(content.subarray(start));
      break;
    }
    lines.push(content.subarray(start, end));
    start = end + 1;
  }
  return lines;
}

function joinBufferLines(lines: Buffer[]): Buffer {
  if (lines.length === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [lines[0]];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    chunks.push(LF_BYTE, lines[lineIndex]);
  }
  return Buffer.concat(chunks);
}

/**
 * Remove standalone `</content>` lines outside CommonMark fenced code blocks.
 * Every other byte, including line endings, malformed UTF-8, and fenced marker
 * examples, is kept. String callers receive a string; Buffer callers receive a
 * Buffer so the stdin/stdout CLI cannot silently transcode retained bytes.
 */
export function normalizePlanningArtifactContent(content: string): string;
export function normalizePlanningArtifactContent(content: Buffer): Buffer;
export function normalizePlanningArtifactContent(content: string | Buffer): string | Buffer {
  if (content.length === 0) return content;

  if (Buffer.isBuffer(content)) {
    const lines = splitBufferOnLf(content);
    const fencedLines = fencedLineIndexes(lines.map((line) => line.toString('utf8')));
    return joinBufferLines(lines.filter((rawLine, lineIndex) => {
      if (fencedLines.has(lineIndex)) return true;
      return !rawLine.equals(STRAY_CONTENT_CLOSER_BYTES)
        && !rawLine.equals(STRAY_CONTENT_CLOSER_CR_BYTES);
    }));
  }

  const lines = content.split('\n');
  const fencedLines = fencedLineIndexes(lines);
  return lines
    .filter((rawLine, lineIndex) => {
      if (fencedLines.has(lineIndex)) return true;
      return rawLine.replace(/\r$/, '') !== STRAY_CONTENT_CLOSER;
    })
    .join('\n');
}

/** Read the complete candidate from stdin and emit only normalized content. */
export function cmdNormalizePlanningArtifactContent(): void {
  const content = fs.readFileSync(0);
  process.stdout.write(normalizePlanningArtifactContent(content));
}
