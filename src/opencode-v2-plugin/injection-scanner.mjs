// Package-local mirror of hooks/lib/injection-patterns.js. This plugin is
// installable independently, so it must not depend on an external hook bundle.
export const HIGH_CONFIDENCE_FINDING_THRESHOLD = 3;

const INJECTION_PATTERNS = [
  /(?:ignore|disregard|forget|discard|override)\s+(?=(?:all|of|the|your|my|system|previous|prior|above|earlier)\s)(?:all\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:(?:system|previous|prior|above|earlier)\s+)?(?:instructions|directives|prompts?|rules)|disregard\s+(?:all\s+)?previous|forget\s+instructions/i,
  /you\s+are\s+now\s+(?:a|an|the)\s+/i,
  /act\s+as\s+(?:a|an|the)\s+(?!plan|phase|wave)/i,
  /pretend\s+(?:you(?:'re| are)\s+|to\s+be\s+)/i,
  /from\s+now\s+on,?\s+you\s+(?:are|will|should|must)/i,
  /(?:print|output|reveal|show|display|repeat)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
  /<\/?(?:system|assistant|human)>/i,
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<\s*SYS\s*>>/i,
];

function describePattern(pattern) {
  return pattern.source.replace(/\\s\+/g, "-").replace(/[()\\]/g, "").substring(0, 50);
}

export const RULES = Object.freeze(INJECTION_PATTERNS.map((pattern) => Object.freeze({
  rule_id: "INJECTION-PATTERN",
  match: describePattern(pattern),
  pattern,
})).concat([
  Object.freeze({ rule_id: "INVISIBLE-UNICODE", match: null, pattern: /[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u2060-\u2069]/ }),
  Object.freeze({ rule_id: "UNICODE-TAG-BLOCK", match: null, pattern: /[\u{E0000}-\u{E007F}]/u }),
]));

export function scanPromptInjection(prompt) {
  // Match the canonical read scanner's short-content policy: isolated tokens
  // are too weak to be a useful signal and must not become a HIGH finding.
  if (typeof prompt !== "string" || prompt.length < 20) return [];
  return RULES.flatMap(({ rule_id, match, pattern }) => pattern.test(prompt)
    ? [{ rule_id, match }]
    : []);
}

export function findingSeverity(findings) {
  return findings.length >= HIGH_CONFIDENCE_FINDING_THRESHOLD ? "HIGH" : "LOW";
}
