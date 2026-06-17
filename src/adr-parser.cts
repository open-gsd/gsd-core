/**
 * ADR Markdown parser — parses Architecture Decision Record documents into
 * structured objects for downstream processing (adr command, gap checker, etc.).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/adr-parser.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requireSafePath } from './security.cjs';
import { collectSections, iterateBullets } from './markdown-sectionizer.cjs';

const STATUS_REJECT_SET = new Set(['superseded', 'rejected', 'deprecated']);

type CanonicalHeader =
  | 'status'
  | 'goal'
  | 'decisions'
  | 'considered_options'
  | 'risks'
  | 'success_criteria'
  | 'plan_sequence'
  | 'key_files'
  | 'out_of_scope'
  | 'deferred'
  | 'dependencies'
  | 'update'
  | 'consequences';

const CANONICAL_HEADERS: Record<CanonicalHeader, string[]> = {
  status: ['status', 'state', 'lifecycle', 'stage'],
  goal: [
    'context',
    'background',
    'problem statement',
    'problem',
    'situation',
    'forces',
    'motivation',
    'issue',
    'drivers',
    'pain points',
    'story',
    'setting',
    'premise',
    'status quo',
    'context and problem statement',
  ],
  decisions: [
    'decision',
    'decisions',
    'resolution',
    'conclusion',
    'choice',
    'we decided',
    'direction',
    'approach',
    'solution',
    'outcome',
    'selected option',
    'recommendation',
    'strategy',
    'decision outcome',
  ],
  considered_options: [
    'considered options',
    'alternatives',
    'options',
    'choices',
    'candidates',
    'approaches considered',
    'variants',
    'trade-offs',
    'pros and cons of the options',
    'discussion',
  ],
  risks: [
    'risks',
    'trade-offs',
    'drawbacks',
    'cost',
    'tensions',
    'liabilities',
    'negative consequences',
    'side effects',
  ],
  success_criteria: [
    'success criteria',
    'acceptance criteria',
    'validation',
    "how we'll know",
    'metrics',
    'kpis',
    'verification',
    'test strategy',
    'compliance',
    'definition of done',
    'exit criteria',
    'positive consequences',
  ],
  plan_sequence: [
    'implementation plan',
    'implementation notes',
    'steps',
    'tasks',
    'roadmap',
    'sequence',
    'migration plan',
    'plan',
    'action items',
    'work breakdown',
    'phases',
    'milestones',
    'stages',
  ],
  key_files: [
    'affected files',
    'files touched',
    'surface area',
    'modules affected',
    'code locations',
    'file changes',
    'diff summary',
    'touched code',
  ],
  out_of_scope: [
    'out of scope',
    'non-goals',
    'excluded',
    'not in this adr',
    'out of bounds',
    "won't do",
    "won't have",
    'beyond scope',
    'anti-goals',
  ],
  deferred: [
    'future work',
    'deferred',
    'future',
    'later',
    'follow-up',
    'next steps',
  ],
  dependencies: [
    'dependencies',
    'depends on',
    'prerequisites',
    'sequencing',
    'order',
    'blocked by',
    'cross-cuts',
    'related adrs',
    'links',
    'references',
    'see also',
    'upstream',
    'inbound',
  ],
  update: [
    'update',
    'revision',
    'amendment',
    'locked design',
    'final decision',
    'post-grilling',
    'addendum',
  ],
  consequences: [
    'consequences',
    'implications',
    'impact',
    'what this means',
    'result',
  ],
};

const CONSEQUENCE_NEGATIVE_HINTS: string[] = [
  'negative',
  'drawback',
  'risk',
  'cost',
  'liability',
  'trade-off',
  'tension',
  'side effect',
];

const CONSEQUENCE_POSITIVE_HINTS: string[] = [
  'positive',
  'success',
  'metric',
  'kpi',
  'verification',
  'acceptance',
  'benefit',
];

function normalizeAdrHeader(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s:._-]+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

function classifyHeader(normalizedHeader: string): CanonicalHeader | null {
  for (const [canonical, synonyms] of Object.entries(CANONICAL_HEADERS) as Array<[CanonicalHeader, string[]]>) {
    for (const synonym of synonyms) {
      if (normalizedHeader === synonym) return canonical;
      if (normalizedHeader.startsWith(`${synonym} `)) return canonical;
    }
  }
  return null;
}

/**
 * Thin adapter: splits body text into entries using the seam's `iterateBullets`
 * for marker-stripped bullet text, with a plain-text fallback so non-bullet
 * lines are also included (original splitEntries contract).
 *
 * Behaviour notes vs prior implementation:
 *  - Bullet lines (dash/asterisk/plus/checkbox/numbered): seam strips the
 *    marker, producing item.text.
 *  - Continuation lines (indented, non-bullet): seam accumulates them into the
 *    preceding bullet item's text (not produced as separate entries here), which
 *    differs from the old per-line split for that uncommon edge case. All tested
 *    behaviors are byte-identical.
 *  - Plain-text lines (no marker, no indentation): included verbatim.
 *
 * ADR-1372 T2 migration.
 */
function splitEntries(blockText: unknown): string[] {
  const text = typeof blockText === 'string' ? blockText : '';
  if (!text) return [];

  // iterateBullets returns BulletItem[] in document order with item.text already
  // stripped of the opening marker. Continuation lines are folded into the
  // preceding item, so they will not appear as standalone lines below.
  const bulletItems = iterateBullets(text);

  // Track which trimmed lines are continuation lines (indented, non-opener) by
  // running the seam's bullet-opener detection inline — avoids re-importing a
  // private regex and keeps the logic here self-contained.
  const bulletOpenerRe = /^[-*+](?:\s+|\s*\[[xX ]\]\s+)|\d+\.\s+/;

  let bulletIdx = 0;
  const results: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue; // blank — skip (original filter(Boolean))

    if (bulletOpenerRe.test(trimmed)) {
      // Bullet opener — consume next iterateBullets item (marker already stripped)
      const item = bulletItems[bulletIdx];
      if (item !== undefined) {
        if (item.text) results.push(item.text);
        bulletIdx++;
      }
    } else if (/^[ \t]/.test(rawLine)) {
      // Continuation line (starts with whitespace in original, trims to non-empty).
      // Folded into the preceding bullet item by the seam — skip as standalone entry.
    } else {
      // Plain-text line (no marker, no leading whitespace) — include verbatim.
      results.push(trimmed);
    }
  }

  return results.filter(Boolean);
}

interface MarkdownSection {
  heading: string | null;
  body: string[];
}

/**
 * Thin adapter: wraps the seam's `collectSections` to produce the same
 * `{ heading: string | null, body: string[] }` shape the rest of adr-parser
 * consumes. ADR-1372 T2 migration.
 */
function parseSections(markdown: unknown): MarkdownSection[] {
  const content = typeof markdown === 'string' ? markdown : '';

  // collectSections(content, () => true) collects every heading as a stop
  // boundary — mirrors the old line-by-line heading walk exactly.
  const sections = collectSections(content, () => true);

  // Map seam Section → MarkdownSection. The seam's HeadingToken.text is the
  // heading text after trimming (same as the old m[1].trim() capture).
  // The body is a trimEnd()-ed joined string; split it back to lines to match
  // the old string[] shape consumed by parseStatusFromSections / parseAdrMarkdown.
  const result: MarkdownSection[] = sections.map((sec) => ({
    heading: sec.heading.text,
    body: sec.body === '' ? [] : sec.body.split('\n'),
  }));

  // Preamble: if the document has content before the first heading, the old
  // parseSections emitted a leading { heading: null, body: [...] } entry.
  // collectSections only returns sections that are opened by a heading, so we
  // need to reconstruct the preamble manually when it exists.
  if (content.length > 0) {
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
    const hasLeadingNonHeading = !/^#{1,6}\s/.test(firstLine);

    if (hasLeadingNonHeading && sections.length > 0) {
      // The preamble ends at the first heading's offset.
      const firstHeadingOffset = sections[0].heading.offset;
      const preambleText = content.slice(0, firstHeadingOffset);
      const preambleLines = preambleText.split(/\r?\n/);
      // Trim trailing empty lines to match old behaviour (old code just collected them as-is)
      if (preambleLines.some((l) => l.trim())) {
        result.unshift({ heading: null, body: preambleLines });
      }
    } else if (hasLeadingNonHeading && sections.length === 0) {
      // No headings at all — entire content is the preamble.
      result.unshift({ heading: null, body: content.split(/\r?\n/) });
    }
  }

  return result;
}

function parseStatusFromSections(sections: MarkdownSection[]): string {
  for (const section of sections) {
    const canonical = classifyHeader(normalizeAdrHeader(section.heading));
    if (canonical !== 'status') continue;
    const line = splitEntries(section.body.join('\n'))[0] || '';
    const norm = normalizeAdrHeader(line);
    if (!norm) return '';
    if (norm.includes('accepted')) return 'accepted';
    if (norm.includes('proposed')) return 'proposed';
    if (norm.includes('superseded')) return 'superseded';
    if (norm.includes('rejected')) return 'rejected';
    if (norm.includes('deprecated')) return 'deprecated';
    return norm;
  }
  return '';
}

function pushUnique(target: string[], values: string[]): void {
  const seen = new Set(target);
  for (const value of values) {
    if (!seen.has(value)) {
      target.push(value);
      seen.add(value);
    }
  }
}

interface AdrOut {
  title: string;
  status: string;
  context: string;
  decisions: string[];
  options_considered: string[];
  consequences_positive: string[];
  consequences_negative: string[];
  out_of_scope: string[];
  deferred: string[];
  dependencies: string[];
  updates: Array<{ heading: string; entries: string[] }>;
  source_path: string;
  key_files: string[];
  plan_sequence: string[];
  format: string;
  unmapped_headers: string[];
}

function parseConsequences(lines: string[], out: AdrOut): void {
  for (const entry of lines) {
    const lower = entry.toLowerCase();
    if (CONSEQUENCE_NEGATIVE_HINTS.some((hint) => lower.includes(hint))) {
      out.consequences_negative.push(entry);
      continue;
    }
    if (CONSEQUENCE_POSITIVE_HINTS.some((hint) => lower.includes(hint))) {
      out.consequences_positive.push(entry);
      continue;
    }
    out.consequences_positive.push(entry);
  }
}

interface ParseAdrMarkdownOptions {
  sourcePath?: string;
  format?: string;
}

function parseAdrMarkdown(markdown: unknown, { sourcePath = '', format = 'auto' }: ParseAdrMarkdownOptions = {}): AdrOut {
  const sections = parseSections(markdown);
  const titleLine = (typeof markdown === 'string' ? markdown : '').split(/\r?\n/).find((line) => /^#\s+/.test(line)) || '';
  const title = titleLine.replace(/^#\s+/, '').trim();

  const out: AdrOut = {
    title,
    status: parseStatusFromSections(sections) || 'accepted',
    context: '',
    decisions: [],
    options_considered: [],
    consequences_positive: [],
    consequences_negative: [],
    out_of_scope: [],
    deferred: [],
    dependencies: [],
    updates: [],
    source_path: sourcePath,
    key_files: [],
    plan_sequence: [],
    format,
    unmapped_headers: [],
  };

  for (const section of sections) {
    const heading = section.heading || '';
    if (!heading) continue;
    const canonical = classifyHeader(normalizeAdrHeader(heading));
    const entries = splitEntries(section.body.join('\n'));
    const prose = section.body.join('\n').trim();

    if (!canonical) {
      out.unmapped_headers.push(heading);
      continue;
    }

    switch (canonical) {
      case 'goal':
        if (!out.context && prose) out.context = prose;
        break;
      case 'decisions':
        pushUnique(out.decisions, entries);
        break;
      case 'considered_options':
        pushUnique(out.options_considered, entries);
        break;
      case 'risks':
        pushUnique(out.consequences_negative, entries);
        break;
      case 'success_criteria':
        pushUnique(out.consequences_positive, entries);
        break;
      case 'plan_sequence':
        pushUnique(out.plan_sequence, entries);
        break;
      case 'key_files':
        pushUnique(out.key_files, entries);
        break;
      case 'out_of_scope':
        pushUnique(out.out_of_scope, entries);
        break;
      case 'deferred':
        pushUnique(out.deferred, entries);
        break;
      case 'dependencies':
        pushUnique(out.dependencies, entries);
        break;
      case 'update':
        out.updates.push({ heading, entries });
        break;
      case 'consequences':
        parseConsequences(entries, out);
        break;
      default:
        break;
    }
  }

  return out;
}

function shouldRejectAdrStatus(status: string): boolean {
  return STATUS_REJECT_SET.has(normalizeAdrHeader(status));
}

interface CliOpts {
  input: string | null;
  format: string;
  projectDir: string;
}

function parseCliArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { input: null, format: 'auto', projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') {
      opts.input = argv[++i] || null;
    } else if (arg === '--format') {
      opts.format = argv[++i] || 'auto';
    } else if (arg === '--project-dir') {
      opts.projectDir = argv[++i] || process.cwd();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.input) {
    throw new Error('Missing required --input <path>');
  }
  return opts;
}

function main(argv: string[]): void {
  const opts = parseCliArgs(argv);
  const safePath = requireSafePath(opts.input, path.resolve(opts.projectDir), 'ADR input path', { allowAbsolute: true });
  const content = fs.readFileSync(safePath, 'utf8');
  const parsed = parseAdrMarkdown(content, { sourcePath: opts.input ?? undefined, format: opts.format });
  process.stdout.write(JSON.stringify(parsed, null, 2));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

export = {
  CANONICAL_HEADERS,
  normalizeAdrHeader,
  parseAdrMarkdown,
  shouldRejectAdrStatus,
};
