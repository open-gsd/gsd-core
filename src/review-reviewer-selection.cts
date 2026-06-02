/**
 * Review Reviewer Selection Module (ADR-457 build-at-publish: the hand-written
 * bin/lib/review-reviewer-selection.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * Owns reviewer-selection policy projection for /gsd:review:
 * explicit flags > --all > review.default_reviewers > all detected.
 */

export const KNOWN_REVIEWER_SLUGS: ReadonlyArray<string> = [
  'gemini',
  'claude',
  'codex',
  'coderabbit',
  'opencode',
  'qwen',
  'cursor',
  'antigravity',
  'ollama',
  'lm_studio',
  'llama_cpp',
];

export interface NormalizedDefaultReviewers {
  absent: boolean;
  values: string[];
  errors: string[];
}

export interface ReviewerSelectionInput {
  detected?: unknown[];
  explicitFlags?: unknown[];
  allFlag?: unknown;
  configuredDefaultReviewers?: unknown;
}

export interface ReviewerSelectionResult {
  source: string;
  selected: string[];
  warnings: string[];
  infos: string[];
  errors: string[];
}

export function normalizeConfiguredDefaultReviewers(
  rawValue: unknown,
): NormalizedDefaultReviewers {
  if (rawValue === undefined || rawValue === null) {
    return { absent: true, values: [], errors: [] };
  }
  if (!Array.isArray(rawValue)) {
    return {
      absent: false,
      values: [],
      errors: ['review.default_reviewers must be a JSON array of reviewer slugs'],
    };
  }
  if (rawValue.length === 0) {
    return {
      absent: false,
      values: [],
      errors: ['review.default_reviewers cannot be empty'],
    };
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  const errors: string[] = [];
  for (const item of rawValue) {
    if (typeof item !== 'string') {
      errors.push('review.default_reviewers must contain only string slugs');
      continue;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(item)) {
      errors.push(`invalid reviewer slug in review.default_reviewers: ${item}`);
      continue;
    }
    const slug = item.toLowerCase();
    if (!seen.has(slug)) {
      seen.add(slug);
      normalized.push(slug);
    }
  }

  return { absent: false, values: normalized, errors };
}

export function resolveReviewerSelection(
  input: ReviewerSelectionInput,
): ReviewerSelectionResult {
  const detected = new Set(
    (input.detected ?? []).map((v) => String(v).toLowerCase()),
  );
  const explicitFlags = new Set(
    (input.explicitFlags ?? []).map((v) => String(v).toLowerCase()),
  );
  const allFlag = !!input.allFlag;
  const normalizedDefaults = normalizeConfiguredDefaultReviewers(
    input.configuredDefaultReviewers,
  );

  const warnings: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [...normalizedDefaults.errors];

  let source = 'no_config_all_detected';
  let selected: string[] = [];

  if (explicitFlags.size > 0) {
    source = 'explicit_flags';
    selected = [...explicitFlags].filter((slug) => detected.has(slug));
    const missing = [...explicitFlags].filter((slug) => !detected.has(slug));
    if (missing.length > 0) {
      infos.push(`explicit reviewers missing on host: ${missing.join(', ')}`);
    }
    if (selected.length === 0 && errors.length === 0) {
      errors.push('no selected reviewers are available for explicit flags');
    }
  } else if (allFlag) {
    source = 'all_flag';
    selected = [...detected];
  } else if (!normalizedDefaults.absent) {
    source = 'config_default';
    const knownDefaults: string[] = [];
    for (const slug of normalizedDefaults.values) {
      if (!KNOWN_REVIEWER_SLUGS.includes(slug)) {
        warnings.push(`unknown reviewer slug in review.default_reviewers: ${slug}`);
      } else {
        knownDefaults.push(slug);
      }
    }
    const undetected = knownDefaults.filter((slug) => !detected.has(slug));
    if (undetected.length > 0) {
      infos.push(`configured reviewers not detected on this host: ${undetected.join(', ')}`);
    }
    selected = knownDefaults.filter((slug) => detected.has(slug));
    if (selected.length === 0 && errors.length === 0) {
      errors.push('all configured default reviewers are unavailable on this host');
    }
  } else {
    selected = [...detected];
  }

  return {
    source,
    selected: selected.sort(),
    warnings,
    infos,
    errors,
  };
}
