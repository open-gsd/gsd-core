/**
 * Proof-of-reading check for a reviewer lane (#5491).
 *
 * `agy` can review a prompt it only partly read and still exit 0 with a normal-looking review: a
 * single stdin message is cut at ~191 KB and replaced with `<truncated N bytes>`
 * (google-antigravity/antigravity-cli#224), `view_file` pages at ~46 KB, and a session compacts
 * itself at a fixed ~128K-token limit and then reviews from its own summary. Nothing in the lane
 * result told these apart from a full read.
 *
 * So the lane is asked to restate, per plan, four facts only a reader of that plan has —
 * `requirements`, `wave`, `depends_on` and the task count — and the restatement is compared with
 * the plan files. A missing or wrong line, a `<truncated N bytes>` marker in the output, or a
 * compaction the handler saw in the session log flags the lane. A live run (agy 1.5.10, 432 KB
 * prompt) read every plan, restated all nine correctly, then compacted while checking repo files
 * and wrote the review from its summary — the restatement alone cannot see that case. Diagnostic only, like the #3301 plan-coverage check: it stamps the review and records
 * the result; it never fails or blocks the lane.
 *
 * Lane-agnostic on purpose. Only the antigravity handler wires it in today (the approved scope);
 * another lane opting in needs its prompt to carry `readCheckInstruction()` and its result
 * handling to call `runReadCheck` (passing `compacted` if it can read its own session log).
 */

import frontmatter from './frontmatter.cjs';
import planScan from './plan-scan.cjs';

/** The four facts a lane must restate for one plan. */
export interface PlanFacts {
  /** Plan id: the file's basename without `-PLAN.md`, the same id the coverage manifest lists. */
  id: string;
  requirements: string[];
  wave: number | null;
  dependsOn: string[];
  tasks: number;
}

export interface ReadCheck {
  complete: boolean;
  /** The output carries agy's `<truncated N bytes>` marker. */
  truncated: boolean;
  /** The session compacted its context before the review was written (reported by the lane's handler). */
  compacted: boolean;
  /** Plan ids with no `READ-CHECK` line. */
  missing: string[];
  /** Plan id → the fields whose restated value disagrees with the plan. */
  mismatched: Record<string, string[]>;
}

export const READ_CHECK_MARKER = '[incomplete-read]';

const FIELDS = ['requirements', 'wave', 'depends_on', 'tasks'] as const;

/** The sentence appended to a lane's prompt instruction. The line shape is what `parseReadCheckLines` reads. */
export function readCheckInstruction(): string {
  return (
    `Begin each plan's section with this exact line, copying requirements, wave and depends_on ` +
    `from that plan's frontmatter and counting its <task elements: ` +
    `READ-CHECK <plan id>: requirements=[<ids>]; wave=<n>; depends_on=[<plan ids>]; tasks=<n>`
  );
}

/** Repo-relative plan paths from the prompt's `#### <path>-PLAN.md` headers (review.md build_prompt). */
export function planPathsFromPrompt(prompt: string): string[] {
  const paths: string[] = [];
  for (const line of String(prompt ?? '').split(/\r?\n/)) {
    const m = /^#### (\S+)\s*$/.exec(line);
    // plan-scan owns which filenames are plans (lint-plan-count-drift); the canonical rule is the
    // one review.md's `*-PLAN.md` glob uses.
    if (m && planScan.isCanonicalPlanFile(m[1].split(/[\\/]/).pop() ?? '') && !paths.includes(m[1])) paths.push(m[1]);
  }
  return paths;
}

/** A frontmatter or restated scalar as text; anything else (a nested map) has no comparable value. */
function scalar(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

function toList(v: unknown): string[] {
  const items: unknown[] = Array.isArray(v) ? v : scalar(v).split(',');
  return items.map((x) => scalar(x).trim().replace(/^["'`]+|["'`]+$/g, '')).filter(Boolean);
}

function toInt(v: unknown): number | null {
  const n = Number.parseInt(scalar(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** The expected facts for one plan file's content. */
export function planFacts(planPath: string, content: string): PlanFacts {
  const fm = frontmatter.extractFrontmatter(content) as Record<string, unknown>;
  const base = planPath.split(/[\\/]/).pop() ?? planPath;
  return {
    id: base.replace(/-PLAN\.md$/, ''),
    requirements: toList(fm.requirements),
    wave: toInt(fm.wave),
    dependsOn: toList(fm.depends_on),
    // `\b` keeps the `<tasks>` wrapper out of the count.
    tasks: (content.match(/<task\b/g) ?? []).length,
  };
}

/**
 * Every `READ-CHECK <id>: k=v; …` line in a review, keyed by id (first one wins). Leading markdown
 * decoration (`#`, `*`, `` ` ``, `>`, `-`) is tolerated: the facts are what is checked, not the format.
 */
export function parseReadCheckLines(review: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const line of String(review ?? '').split(/\r?\n/)) {
    const m = /^[\s>*_`#-]*READ-CHECK\s+([^\s:`*]+)[`*]*\s*:\s*(.*)$/.exec(line);
    if (!m || out.has(m[1])) continue;
    const fields: Record<string, string> = {};
    for (const part of m[2].replace(/[`*_\s]+$/, '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
    }
    out.set(m[1], fields);
  }
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function wrongFields(facts: PlanFacts, got: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const f of FIELDS) {
    const raw = got[f];
    if (raw === undefined) {
      bad.push(f);
      continue;
    }
    const list = toList(raw.replace(/^\[|\]$/g, ''));
    const ok =
      f === 'requirements' ? sameSet(list, facts.requirements)
        : f === 'depends_on' ? sameSet(list, facts.dependsOn)
          : f === 'wave' ? toInt(raw) === facts.wave
            : toInt(raw) === facts.tasks;
    if (!ok) bad.push(f);
  }
  return bad;
}

/** Compare a review's restatements with the plans it was given. */
export function checkRead(review: string, expected: PlanFacts[], compacted = false): ReadCheck {
  const truncated = /<truncated\s+\d+\s+bytes>/i.test(String(review ?? ''));
  const lines = parseReadCheckLines(review);
  const missing: string[] = [];
  const mismatched: Record<string, string[]> = {};
  for (const facts of expected) {
    const got = lines.get(facts.id);
    if (!got) {
      missing.push(facts.id);
      continue;
    }
    const bad = wrongFields(facts, got);
    if (bad.length) mismatched[facts.id] = bad;
  }
  return {
    complete: !truncated && !compacted && missing.length === 0 && Object.keys(mismatched).length === 0,
    truncated,
    compacted,
    missing,
    mismatched,
  };
}

/** Prepend the down-weight marker to a review that failed the check. Idempotent. */
export function stampIncompleteRead(review: string, check: ReadCheck): string {
  if (check.complete || review.includes(READ_CHECK_MARKER)) return review;
  const why: string[] = [];
  if (check.truncated) why.push('its output contains a `<truncated N bytes>` marker');
  if (check.compacted) why.push('its session compacted its context before the review was written');
  if (check.missing.length) why.push(`no READ-CHECK line for ${check.missing.join(', ')}`);
  const wrong = Object.entries(check.mismatched).map(([id, f]) => `${id} (${f.join(', ')})`);
  if (wrong.length) why.push(`READ-CHECK disagrees with the plan for ${wrong.join('; ')}`);
  return (
    `> ${READ_CHECK_MARKER} This review may not rest on a full read of the plans: ${why.join('; ')}. ` +
    'Down-weight its verdict in the Consensus Summary.\n\n' +
    review
  );
}

/** The filesystem seams `runReadCheck` needs — a subset of the runner's `RunnerDeps`. */
export interface ReadCheckDeps {
  exists(p: string): boolean;
  readFile(p: string): string;
}

/**
 * Run the check for one lane's review. Plans come from the prompt's plan headers and are read from
 * the repo, so the expected facts are the plans themselves. `compacted` comes from the lane's own
 * session log, which only its handler can read. Returns `undefined` when there is nothing to check
 * (no plan headers, no truncation marker, no compaction); an unreadable prompt or plan is
 * skipped rather than flagged — this check must never invent a failure it cannot see.
 */
export function runReadCheck(
  review: string,
  promptPath: string,
  repoRoot: string,
  deps: ReadCheckDeps,
  opts: { compacted?: boolean } = {},
): ReadCheck | undefined {
  let prompt = '';
  try {
    if (deps.exists(promptPath)) prompt = deps.readFile(promptPath);
  } catch {
    prompt = '';
  }
  const expected: PlanFacts[] = [];
  for (const rel of planPathsFromPrompt(prompt)) {
    const abs = rel.startsWith('/') ? rel : `${String(repoRoot).replace(/\/+$/, '')}/${rel}`;
    try {
      if (deps.exists(abs)) expected.push(planFacts(rel, deps.readFile(abs)));
    } catch {
      // unreadable plan: skip it, see above
    }
  }
  const check = checkRead(review, expected, opts.compacted === true);
  if (expected.length === 0 && !check.truncated && !check.compacted) return undefined;
  return check;
}
