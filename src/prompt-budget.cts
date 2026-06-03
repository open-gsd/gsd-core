/**
 * prompt-budget.cts
 *
 * Pure functions for assembling and trimming review prompts to fit within
 * a token budget (ADR-457 build-at-publish: the hand-written
 * bin/lib/prompt-budget.cjs collapsed to a TypeScript source of truth).
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
 *
 * Used by the review pipeline to support small-context models.
 *
 * Trim priority (in order — never violate):
 *   1. Instructions:   ALWAYS kept verbatim
 *   2. Reserve note tokens FIRST when any trim is anticipated
 *   3. Roadmap:        ALWAYS kept verbatim
 *   4. PROJECT.md:     head-shrink to projectMdHeadLines (default 40) if over budget
 *   5. Plans:          tail-truncate proportionally; never drop a whole plan
 *   6. Context:        DROP first if still over
 *   7. Research:       DROP second if still over
 *   8. Requirements:   DROP last (last-resort)
 *   9. Hard-fail:      if minimum-set exceeds effectiveBudget
 */

const NOTE_RESERVE_TOKENS = 80;

const DEFAULT_NOTE_TEMPLATE = [
  '<note>',
  'Prompt automatically trimmed to fit a {budget}-token budget.',
  'Omitted sections: {omittedList}.',
  'Plan content truncated by approximately {planTruncationPct}%.',
  'Treat any missing context as out-of-scope rather than a review concern.',
  '</note>',
].join('\n');

/** A single plan section with its filename and content. */
export interface PlanSection {
  file: string;
  content: string;
}

/** Input sections for applyBudget. */
export interface PromptSections {
  instructions: string;
  roadmap: string;
  plans: PlanSection[];
  projectMd?: string | null;
  context?: string | null;
  research?: string | null;
  requirements?: string | null;
}

/** Options for applyBudget. */
export interface BudgetOptions {
  safetyMarginPct?: number;
  noteTemplate?: string;
  projectMdHeadLines?: number;
}

/** Metadata about the budget application result. */
export interface BudgetMetadata {
  budget: number;
  effectiveBudget: number;
  estimatedTokens: number;
  omitted: string[];
  projectMdShrunk: boolean;
  planTruncationPct: number;
  hardFailed: boolean;
  noteInjected: boolean;
}

/** Result of applyBudget. */
export interface BudgetResult {
  prompt: string;
  metadata: BudgetMetadata;
}

/** Input to applyBudget. */
export interface ApplyBudgetInput {
  sections: PromptSections;
  budget: number;
  options?: BudgetOptions;
}

/**
 * Estimate tokens for a string. Chars / 4, rounded up.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Render the trim-disclosure note.
 */
function renderNote(template: string, budget: number, omitted: string[], planTruncationPct: number): string {
  const omittedList = omitted.length > 0 ? omitted.join(', ') : 'none';
  return template
    .replace('{budget}', String(budget))
    .replace('{omittedList}', omittedList)
    .replace('{planTruncationPct}', String(Math.round(planTruncationPct)));
}

/**
 * Head-shrink a string to at most `maxLines` lines.
 */
function headShrink(text: string, maxLines: number): string {
  if (maxLines <= 0) return '';
  let idx = -1;
  let seen = 0;
  while (seen < maxLines) {
    idx = text.indexOf('\n', idx + 1);
    if (idx === -1) return text;
    seen += 1;
  }
  return text.slice(0, idx);
}

/**
 * Tail-truncate a string to at most `maxChars` characters.
 */
function tailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/**
 * Assemble the final prompt string from its sections.
 */
function assemblePrompt(parts: {
  instructions: string;
  note: string | null;
  roadmap: string;
  projectMd: string | null;
  plans: PlanSection[];
  context: string | null;
  research: string | null;
  requirements: string | null;
}): string {
  const {
    instructions,
    note,
    roadmap,
    projectMd,
    plans,
    context,
    research,
    requirements,
  } = parts;

  const blocks: string[] = [];

  blocks.push(instructions);

  if (note) blocks.push(note);

  blocks.push('## Roadmap\n\n' + roadmap);

  if (projectMd) blocks.push('## Project\n\n' + projectMd);

  const planBlocks = plans
    .map((p) => '### ' + p.file + '\n\n' + p.content)
    .join('\n\n');
  blocks.push('## Plans\n\n' + planBlocks);

  if (context) blocks.push('## Context\n\n' + context);
  if (research) blocks.push('## Research\n\n' + research);
  if (requirements) blocks.push('## Requirements\n\n' + requirements);

  return blocks.join('\n\n');
}

/**
 * Apply a token budget to a set of review prompt sections.
 * Returns the trimmed prompt and structured metadata.
 */
export function applyBudget({ sections, budget, options = {} }: ApplyBudgetInput): BudgetResult {
  const {
    safetyMarginPct = 10,
    noteTemplate = DEFAULT_NOTE_TEMPLATE,
    projectMdHeadLines = 40,
  } = options;

  const effectiveBudget = Math.floor(budget * (1 - safetyMarginPct / 100));

  const {
    instructions,
    roadmap,
    plans,
    projectMd: projectMdRaw = null,
    context: contextRaw = null,
    research: researchRaw = null,
    requirements: requirementsRaw = null,
  } = sections;

  // Working mutable state
  let projectMd: string | null = projectMdRaw;
  let context: string | null = contextRaw;
  let research: string | null = researchRaw;
  let requirements: string | null = requirementsRaw;
  let workingPlans: PlanSection[] = plans.map((p) => ({ file: p.file, content: p.content }));

  const omitted: string[] = [];
  let projectMdShrunk = false;
  let planTruncationPct = 0;
  let noteInjected = false;
  let hardFailed = false;

  // Minimum-set check: instructions + roadmap + 1KB per plan.
  // NOTE_RESERVE_TOKENS is intentionally excluded here: a note is only injected
  // when trimming actually occurs, and a prompt that fits without any trim needs
  // no note at all. Including NOTE_RESERVE_TOKENS here would cause false hard-fails
  // for prompts that genuinely fit the effective budget untrimmed.
  const MIN_PLAN_BYTES = 1024;
  const minPlanTokens = plans.reduce((sum, p) => {
    return sum + estimateTokens(p.content.slice(0, MIN_PLAN_BYTES));
  }, 0);
  const minSet =
    estimateTokens(instructions) +
    estimateTokens(roadmap) +
    minPlanTokens;

  if (minSet > effectiveBudget) {
    return {
      prompt: '',
      metadata: {
        budget,
        effectiveBudget,
        estimatedTokens: 0,
        omitted: [],
        projectMdShrunk: false,
        planTruncationPct: 0,
        hardFailed: true,
        noteInjected: false,
      },
    };
  }

  // ── Budget accounting ──────────────────────────────────────────────────────
  const TOKENS_ROADMAP_HEADER = estimateTokens('## Roadmap\n\n');
  const TOKENS_PROJECT_HEADER = estimateTokens('## Project\n\n');
  const TOKENS_PLANS_HEADER = estimateTokens('## Plans\n\n');
  const TOKENS_CONTEXT_HEADER = estimateTokens('## Context\n\n');
  const TOKENS_RESEARCH_HEADER = estimateTokens('## Research\n\n');
  const TOKENS_REQUIREMENTS_HEADER = estimateTokens('## Requirements\n\n');
  const TOKENS_PLAN_ITEM_HEADERS = workingPlans.reduce(
    (sum, p) => sum + estimateTokens('### ' + p.file + '\n\n'),
    0
  );

  const staticBaseTokens =
    estimateTokens(instructions) +
    TOKENS_ROADMAP_HEADER +
    estimateTokens(roadmap) +
    TOKENS_PLANS_HEADER +
    TOKENS_PLAN_ITEM_HEADERS;

  let projectTokens = projectMd
    ? TOKENS_PROJECT_HEADER + estimateTokens(projectMd)
    : 0;
  let contextTokens = context
    ? TOKENS_CONTEXT_HEADER + estimateTokens(context)
    : 0;
  let researchTokens = research
    ? TOKENS_RESEARCH_HEADER + estimateTokens(research)
    : 0;
  let requirementsTokens = requirements
    ? TOKENS_REQUIREMENTS_HEADER + estimateTokens(requirements)
    : 0;
  let planContentTokens = workingPlans.reduce(
    (sum, p) => sum + estimateTokens(p.content),
    0
  );

  const getCurrentBaseTokens = (): number =>
    staticBaseTokens +
    projectTokens +
    planContentTokens +
    contextTokens +
    researchTokens +
    requirementsTokens;

  let currentBaseTokens = getCurrentBaseTokens();

  // Detect budget pressure: is ANY trim needed?
  // Pressure exists when the current base tokens already exceed the effective
  // budget. Only when pressure is real do we reserve NOTE_RESERVE_TOKENS so
  // the note itself fits after trimming. Checking against
  // effectiveBudget - NOTE_RESERVE_TOKENS (the old threshold) would cause
  // spurious pressure 80 tokens early, dropping sections that fit fine.
  const baseTokens = currentBaseTokens;
  const budgetUnderPressure = baseTokens > effectiveBudget;

  // Available for content (reserve note slot when under pressure)
  const contentBudget = budgetUnderPressure
    ? effectiveBudget - NOTE_RESERVE_TOKENS
    : effectiveBudget;

  // ── Trim step 1: head-shrink PROJECT.md ───────────────────────────────────
  if (currentBaseTokens > contentBudget && projectMd) {
    const shrunk = headShrink(projectMd, projectMdHeadLines);
    if (shrunk !== projectMd) {
      projectMd = shrunk;
      projectMdShrunk = true;
      projectTokens = TOKENS_PROJECT_HEADER + estimateTokens(projectMd);
      currentBaseTokens = getCurrentBaseTokens();
    }
  }

  // ── Trim step 2: proportional plan truncation ─────────────────────────────
  if (currentBaseTokens > contentBudget) {
    // Compute tokens available for plan content only
    const overhead =
      staticBaseTokens +
      projectTokens +
      contextTokens +
      researchTokens +
      requirementsTokens;
    const planBudgetTokens = contentBudget - overhead;
    const totalPlanTokens = planContentTokens;

    if (planBudgetTokens > 0 && planBudgetTokens < totalPlanTokens) {
      // Proportional share per plan (at least 1KB per plan)
      const totalOriginalChars = plans.reduce(
        (sum, p) => sum + p.content.length,
        0
      );

      const totalPlanCharsBudget = planBudgetTokens * 4;
      workingPlans = workingPlans.map((p) => {
        const proportionalShare =
          totalOriginalChars > 0
            ? Math.floor((p.content.length / totalOriginalChars) * totalPlanCharsBudget)
            : 0;
        const maxChars = Math.max(proportionalShare, MIN_PLAN_BYTES);
        return { file: p.file, content: tailTruncate(p.content, maxChars) };
      });

      const newTotalChars = workingPlans.reduce(
        (sum, p) => sum + p.content.length,
        0
      );
      if (totalOriginalChars > 0) {
        planTruncationPct =
          ((totalOriginalChars - newTotalChars) / totalOriginalChars) * 100;
      }
      planContentTokens = workingPlans.reduce(
        (sum, p) => sum + estimateTokens(p.content),
        0
      );
      currentBaseTokens = getCurrentBaseTokens();
    }
  }

  // ── Trim step 3: drop context ─────────────────────────────────────────────
  if (currentBaseTokens > contentBudget && context) {
    context = null;
    omitted.push('context');
    contextTokens = 0;
    currentBaseTokens = getCurrentBaseTokens();
  }

  // ── Trim step 4: drop research ────────────────────────────────────────────
  if (currentBaseTokens > contentBudget && research) {
    research = null;
    omitted.push('research');
    researchTokens = 0;
    currentBaseTokens = getCurrentBaseTokens();
  }

  // ── Trim step 5: drop requirements (last resort) ──────────────────────────
  if (currentBaseTokens > contentBudget && requirements) {
    requirements = null;
    omitted.push('requirements');
    requirementsTokens = 0;
    currentBaseTokens = getCurrentBaseTokens();
  }

  // ── Decide whether note is actually needed ────────────────────────────────
  const anyTrimOccurred =
    omitted.length > 0 || projectMdShrunk || planTruncationPct > 0;

  let note: string | null = null;
  if (anyTrimOccurred) {
    note = renderNote(noteTemplate, budget, omitted, planTruncationPct);
    noteInjected = true;
  }

  // Suppress unused variable warning — currentBaseTokens is used via the
  // closure in getCurrentBaseTokens(); the final value is not used directly.
  void currentBaseTokens;

  // ── Assemble ──────────────────────────────────────────────────────────────
  const prompt = assemblePrompt({
    instructions,
    note,
    roadmap,
    projectMd,
    plans: workingPlans,
    context,
    research,
    requirements,
  });

  const estimatedTokens = estimateTokens(prompt);

  if (estimatedTokens > effectiveBudget) {
    hardFailed = true;
    return {
      prompt: '',
      metadata: {
        budget,
        effectiveBudget,
        estimatedTokens,
        omitted,
        projectMdShrunk,
        planTruncationPct,
        hardFailed,
        noteInjected,
      },
    };
  }

  return {
    prompt,
    metadata: {
      budget,
      effectiveBudget,
      estimatedTokens,
      omitted,
      projectMdShrunk,
      planTruncationPct,
      hardFailed,
      noteInjected,
    },
  };
}
