/**
 * Post-planning gap analysis (#2493).
 *
 * Reads REQUIREMENTS.md (planning-root) and CONTEXT.md (per-phase) and compares
 * each REQ-ID and D-ID against the concatenated text of all PLAN.md files in
 * the phase directory. Emits a unified `Source | Item | Status` report.
 *
 * Gated on workflow.post_planning_gaps (default true). When false, returns
 * { enabled: false } and does not scan.
 *
 * Coverage detection uses word-boundary regex matching to avoid false positives
 * (REQ-1 must not match REQ-10).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/gap-checker.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import core = require('./core.cjs');
const { escapeRegex, output, error } = core;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, planningDir, findContextMdIn } = planningWorkspace;
import { parseDecisions } from './decisions.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReqItem {
  id: string;
  text: string;
}

interface RequirementItem extends ReqItem {
  source: string;
}

type DecisionItem = ReturnType<typeof parseDecisions>[number] & { source: string };

type Item = RequirementItem | DecisionItem;

interface CoverageRow {
  source: string;
  item: string;
  status: string;
}

interface GapCounts {
  total: number;
  covered: number;
  uncovered: number;
}

interface GapResult {
  enabled: boolean;
  rows: CoverageRow[];
  table: string;
  summary: string;
  counts: GapCounts;
}

interface RunGapAnalysisOptions {
  phaseReqIds?: string | null | undefined;
}

/**
 * Parse REQ-IDs from REQUIREMENTS.md content.
 *
 * Supports both checkbox (`- [ ] **REQ-NN** ...`) and traceability table
 * (`| REQ-NN | ... |`) formats.
 */
function parseRequirements(reqMd: unknown): ReqItem[] {
  if (!reqMd || typeof reqMd !== 'string') return [];
  const out: ReqItem[] = [];
  const seen = new Set<string>();

  // Prefix-agnostic ID format: REQ-01, TST-01, BACK-07, INSP-04, etc.
  const ID_PATTERN = '[A-Z][A-Z0-9]*-[A-Za-z0-9_-]+';

  const checkboxRe = new RegExp(`^\\s*-\\s*\\[[x ]\\]\\s*\\*\\*(${ID_PATTERN})\\*\\*\\s*(.*)$`, 'gm');
  let cm = checkboxRe.exec(reqMd);
  while (cm !== null) {
    const id = cm[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ id, text: (cm[2] || '').trim() });
    }
    cm = checkboxRe.exec(reqMd);
  }

  const tableFirstCellRe = new RegExp(`^\\s*\\|\\s*(${ID_PATTERN})\\s*\\|`);
  const separatorRowRe = /^\s*\|[\s:|-]+\|\s*$/;
  const lines = reqMd.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('|')) continue;

    // Skip markdown table separator rows and header rows immediately preceding them.
    if (separatorRowRe.test(line)) continue;
    if (i + 1 < lines.length && separatorRowRe.test(lines[i + 1])) continue;

    const tm = tableFirstCellRe.exec(line);
    if (!tm) continue;
    const id = tm[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ id, text: '' });
    }
  }

  return out;
}

function detectCoverage(items: Item[], planText: string): CoverageRow[] {
  return items.map(it => {
    const re = new RegExp('\\b' + escapeRegex(it.id) + '\\b');
    return {
      source: it.source,
      item: it.id,
      status: re.test(planText) ? 'Covered' : 'Not covered',
    };
  });
}

function naturalKey(s: unknown): string {
  return String(s).replace(/(\d+)/g, (_, n: string) => n.padStart(8, '0'));
}

function sortRows(rows: CoverageRow[]): CoverageRow[] {
  const sourceOrder: Record<string, number> = { 'REQUIREMENTS.md': 0, 'CONTEXT.md': 1 };
  return rows.slice().sort((a, b) => {
    const so = (sourceOrder[a.source] ?? 99) - (sourceOrder[b.source] ?? 99);
    if (so !== 0) return so;
    return naturalKey(a.item).localeCompare(naturalKey(b.item));
  });
}

function formatGapTable(rows: CoverageRow[]): string {
  if (rows.length === 0) {
    return '## Post-Planning Gap Analysis\n\nNo requirements or decisions to check.\n';
  }
  const header = '| Source | Item | Status |\n|--------|------|--------|';
  const body = rows.map(r => {
    const tick = r.status === 'Covered' ? '✓ Covered'
      : r.status === 'Missing from REQUIREMENTS.md' ? '⚠ Missing from REQUIREMENTS.md'
      : '✗ Not covered';
    return `| ${r.source} | ${r.item} | ${tick} |`;
  }).join('\n');
  return `## Post-Planning Gap Analysis\n\n${header}\n${body}\n`;
}

function readGate(cwd: string): boolean {
  const cfgPath = path.join(planningDir(cwd), 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && 'workflow' in raw) {
      const wf = (raw as Record<string, unknown>)['workflow'];
      if (wf && typeof wf === 'object' && 'post_planning_gaps' in wf) {
        const val = (wf as Record<string, unknown>)['post_planning_gaps'];
        if (typeof val === 'boolean') return val;
      }
    }
  } catch { /* fall through */ }
  return true;
}

/**
 * Normalize a raw `--phase-req-ids` argument into the scoping signal used by
 * runGapAnalysis (#447). Mirrors §13's null/TBD skip semantics.
 *
 *   undefined           → flag absent: compare the whole REQUIREMENTS.md (back-compat)
 *   null | '' | TBD     → no requirements mapped to this phase: skip the comparison
 *   "REQ-01,REQ-02"     → restrict the comparison to these IDs
 *
 * Tolerates JSON-array-ish input (`["REQ-01","REQ-02"]`) since callers may pass
 * the roadmap value through verbatim.
 */
function normalizePhaseReqIds(rawVal: unknown): string[] | null | undefined {
  if (rawVal === undefined) return undefined;
  if (rawVal === null) return null;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const v = String(rawVal).replace(/["'[\]()]/g, '').trim();
  if (v === '' || /^(null|tbd|none)$/i.test(v)) return null;
  // Tolerate comma-, space-, or newline-separated lists (callers may pass the
  // roadmap value verbatim, whose serialization is not guaranteed).
  const ids = v.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  return ids.length === 0 ? null : ids;
}

function runGapAnalysis(cwd: string, phaseDir: string, options: RunGapAnalysisOptions = {}): GapResult {
  const phaseReqIds = normalizePhaseReqIds(options.phaseReqIds);
  if (!readGate(cwd)) {
    return {
      enabled: false,
      rows: [],
      table: '',
      summary: 'workflow.post_planning_gaps disabled — skipping post-planning gap analysis',
      counts: { total: 0, covered: 0, uncovered: 0 },
    };
  }

  const absPhaseDir = path.isAbsolute(phaseDir) ? phaseDir : path.join(cwd, phaseDir);

  const reqPath = planningPaths(cwd).requirements;
  const reqMd = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf-8') : '';
  let reqItems: RequirementItem[] = parseRequirements(reqMd).map(r => ({ ...r, source: 'REQUIREMENTS.md' }));

  // Scope the requirements comparison to the phase's mapped REQ-IDs (#447).
  // A phase that maps no requirements (phase_req_ids null/TBD) must not report
  // every unrelated project REQ-ID as a gap — mirror §13's skip behavior.
  // CONTEXT.md decisions (below) are always in scope regardless.
  let ghostReqIds: string[] = [];
  if (phaseReqIds === null) {
    reqItems = [];
  } else if (Array.isArray(phaseReqIds)) {
    const wanted = new Set(phaseReqIds);
    const foundIds = new Set(reqItems.map(r => r.id));
    reqItems = reqItems.filter(r => wanted.has(r.id));
    ghostReqIds = phaseReqIds.filter(id => !foundIds.has(id));
  }

  // Read the phase directory once; reuse the listing for both context detection
  // and plan-file enumeration (avoids redundant readdirSync calls).
  let phaseDirFiles: string[] = [];
  try {
    if (fs.existsSync(absPhaseDir)) phaseDirFiles = fs.readdirSync(absPhaseDir);
  } catch { /* unreadable */ }

  const ctxFile = findContextMdIn(phaseDirFiles);
  const ctxPath = ctxFile ? path.join(absPhaseDir, ctxFile) : null;
  const ctxMd = ctxPath ? fs.readFileSync(ctxPath, 'utf-8') : '';
  const dItems: DecisionItem[] = parseDecisions(ctxMd).map(d => ({ ...d, source: 'CONTEXT.md' }));

  const items: Item[] = [...reqItems, ...dItems];

  let planText = '';
  try {
    if (phaseDirFiles.length > 0) {
      const files = phaseDirFiles.filter(f => /-PLAN\.md$/.test(f));
      planText = files.map(f => {
        try { return fs.readFileSync(path.join(absPhaseDir, f), 'utf-8'); }
        catch { return ''; }
      }).join('\n');
    }
  } catch { /* unreadable */ }

  if (items.length === 0) {
    return {
      enabled: true,
      rows: [],
      table: '## Post-Planning Gap Analysis\n\nNo requirements or decisions to check.\n',
      summary: 'no requirements or decisions to check',
      counts: { total: 0, covered: 0, uncovered: 0 },
    };
  }

  const rows = sortRows([
    ...detectCoverage(items, planText),
    ...ghostReqIds.map(id => ({ source: 'REQUIREMENTS.md', item: id, status: 'Missing from REQUIREMENTS.md' })),
  ]);
  const covered = rows.filter(r => r.status === 'Covered').length;
  const uncovered = rows.length - covered;

  const summary = uncovered === 0
    ? `✓ All ${rows.length} items covered by plans`
    : `⚠ ${uncovered} of ${rows.length} items not covered by any plan`;

  return {
    enabled: true,
    rows,
    table: formatGapTable(rows) + '\n' + summary + '\n',
    summary,
    counts: { total: rows.length, covered, uncovered },
  };
}

function cmdGapAnalysis(cwd: string, args: string[], raw: boolean): void {
  const idx = args.indexOf('--phase-dir');
  if (idx === -1 || !args[idx + 1]) {
    error('Usage: gap-analysis --phase-dir <path-to-phase-directory>');
  }
  const phaseDir = args[idx + 1];

  // Optional --phase-req-ids scopes the requirements comparison (#447).
  // Absent → compare the whole REQUIREMENTS.md (back-compat).
  const reqIdx = args.indexOf('--phase-req-ids');
  const phaseReqIds = reqIdx === -1 ? undefined : (args[reqIdx + 1] ?? '');

  const result = runGapAnalysis(cwd, phaseDir, { phaseReqIds });
  output(result, raw, result.table || result.summary);
}

export = {
  parseRequirements,
  detectCoverage,
  formatGapTable,
  sortRows,
  normalizePhaseReqIds,
  runGapAnalysis,
  cmdGapAnalysis,
};
