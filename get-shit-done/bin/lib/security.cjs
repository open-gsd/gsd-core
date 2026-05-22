/**
 * Security — Input validation, path traversal prevention, and prompt injection guards
 *
 * This module centralizes security checks for GSD tooling. Because GSD generates
 * markdown files that become LLM system prompts (agent instructions, workflow state,
 * phase plans), any user-controlled text that flows into these files is a potential
 * indirect prompt injection vector.
 *
 * Threat model:
 *   1. Path traversal: user-supplied file paths escape the project directory
 *   2. Prompt injection: malicious text in arguments/PRDs embeds LLM instructions
 *   3. Shell metacharacter injection: user text interpreted by shell
 *   4. JSON injection: malformed JSON crashes or corrupts state
 *   5. Regex DoS: crafted input causes catastrophic backtracking
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ─── Path Traversal Prevention ──────────────────────────────────────────────

/**
 * Validate that a file path resolves within an allowed base directory.
 * Prevents path traversal attacks via ../ sequences, symlinks, or absolute paths.
 *
 * @param {string} filePath - The user-supplied file path
 * @param {string} baseDir - The allowed base directory (e.g., project root)
 * @param {object} [opts] - Options
 * @param {boolean} [opts.allowAbsolute=false] - Allow absolute paths (still must be within baseDir)
 * @returns {{ safe: boolean, resolved: string, error?: string }}
 */
function validatePath(filePath, baseDir, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return { safe: false, resolved: '', error: 'Empty or invalid file path' };
  }

  if (!baseDir || typeof baseDir !== 'string') {
    return { safe: false, resolved: '', error: 'Empty or invalid base directory' };
  }

  // Reject null bytes (can bypass path checks in some environments)
  if (filePath.includes('\0')) {
    return { safe: false, resolved: '', error: 'Path contains null bytes' };
  }

  // Resolve symlinks in base directory to handle macOS /var -> /private/var
  // and similar platform-specific symlink chains
  let resolvedBase;
  try {
    resolvedBase = fs.realpathSync(path.resolve(baseDir));
  } catch {
    resolvedBase = path.resolve(baseDir);
  }

  let resolvedPath;

  if (path.isAbsolute(filePath)) {
    if (!opts.allowAbsolute) {
      return { safe: false, resolved: '', error: 'Absolute paths not allowed' };
    }
    resolvedPath = path.resolve(filePath);
  } else {
    resolvedPath = path.resolve(baseDir, filePath);
  }

  // Resolve symlinks in the target path too
  try {
    resolvedPath = fs.realpathSync(resolvedPath);
  } catch {
    // File may not exist yet (e.g., about to be created) — use logical resolution
    // but still resolve the parent directory if it exists
    const parentDir = path.dirname(resolvedPath);
    try {
      const realParent = fs.realpathSync(parentDir);
      resolvedPath = path.join(realParent, path.basename(resolvedPath));
    } catch {
      // Parent doesn't exist either — keep the resolved path as-is
    }
  }

  // Normalize both paths and check containment
  const normalizedBase = resolvedBase + path.sep;
  const normalizedPath = resolvedPath + path.sep;

  // The resolved path must start with the base directory
  // (or be exactly the base directory)
  if (resolvedPath !== resolvedBase && !normalizedPath.startsWith(normalizedBase)) {
    return {
      safe: false,
      resolved: resolvedPath,
      error: `Path escapes allowed directory: ${resolvedPath} is outside ${resolvedBase}`,
    };
  }

  return { safe: true, resolved: resolvedPath };
}

/**
 * Validate a file path and throw on traversal attempt.
 * Convenience wrapper around validatePath for use in CLI commands.
 */
function requireSafePath(filePath, baseDir, label, opts = {}) {
  const result = validatePath(filePath, baseDir, opts);
  if (!result.safe) {
    throw new Error(`${label || 'Path'} validation failed: ${result.error}`);
  }
  return result.resolved;
}

// ─── Prompt Injection Detection ─────────────────────────────────────────────

/**
 * Patterns that indicate prompt injection attempts in user-supplied text.
 * These patterns catch common indirect prompt injection techniques where
 * an attacker embeds LLM instructions in text that will be read by an agent.
 *
 * Note: This is defense-in-depth — not a complete solution. The primary defense
 * is proper input/output boundaries in agent prompts.
 */
const INJECTION_PATTERNS = [
  // Direct instruction override attempts
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /override\s+(system|previous)\s+(prompt|instructions)/i,

  // Role/identity manipulation
  /you\s+are\s+now\s+(?:a|an|the)\s+/i,
  /act\s+as\s+(?:a|an|the)\s+(?!plan|phase|wave)/i,  // allow "act as a plan"
  /pretend\s+(?:you(?:'re| are)\s+|to\s+be\s+)/i,
  /from\s+now\s+on,?\s+you\s+(?:are|will|should|must)/i,

  // System prompt extraction
  /(?:print|output|reveal|show|display|repeat)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
  /what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions)/i,

  // Hidden instruction markers (XML/HTML tags that mimic system messages)
  // Note: <instructions> is excluded — GSD uses it as legitimate prompt structure
  // Requires > to close the tag (not just whitespace) to avoid matching generic types like Promise<User | null>
  /<\/?(?:system|assistant|human)>/i,
  /\[SYSTEM\]/i,
  /\[\/?(INST)\]/i,
  /<<\s*SYS\s*>>/i,

  // Exfiltration attempts
  /(?:send|post|fetch|curl|wget)\s+(?:to|from)\s+https?:\/\//i,
  /(?:base64|btoa|encode)\s+(?:and\s+)?(?:send|exfiltrate|output)/i,

  // Tool manipulation
  /(?:run|execute|call|invoke)\s+(?:the\s+)?(?:bash|shell|exec|spawn)\s+(?:tool|command)/i,
];

/**
 * Patterns that flag hostile markdown link targets.
 *
 * These address browser-side and agent-side risks when GSD plan files containing
 * markdown links are rendered or consumed by agents:
 *
 *  MD-LINK-JS-SCHEME — javascript: URI in link target.
 *    Source: OWASP Cross-Site Scripting Prevention Cheat Sheet
 *    https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
 *
 *  MD-LINK-DATA-SCHEME — data: URI that is NOT in the explicit safe-list.
 *    Safe-list: image/(png|jpeg|gif|webp|bmp|ico|avif|heic) and font/(woff2?|otf|ttf).
 *    data:image/svg+xml is UNSAFE — SVG can host <script> tags.
 *    Source: OWASP File Upload Cheat Sheet — SVG Files
 *    https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html#svg-files
 *
 *  MD-LINK-USERINFO — https?://user:pass@host (RFC 3986 userinfo in HTTP(S) URL).
 *    Source: RFC 3986 §3.2.1 (userinfo syntax)
 *    https://www.rfc-editor.org/rfc/rfc3986#section-3.2.1
 *    RFC 9110 §4.2.4 (HTTP deprecates userinfo in request URIs)
 *    https://www.rfc-editor.org/rfc/rfc9110#section-4.2.4
 *    Must NOT fire on: mailto:user@host (no : before @), https://host:443/path (port, not userinfo).
 *
 *  MD-LINK-TOKEN-IN-QUERY — sensitive key name in query string regardless of value.
 *    Source: RFC 9700 OAuth 2.0 Security BCP §4.3.1
 *    https://www.rfc-editor.org/rfc/rfc9700#section-4.3.1
 *    "tokens MUST NOT be passed in URI query parameters"
 *
 * Each entry: { pattern: RegExp, ruleId: string }
 */

// Explicit safe-list for data: MIME types that are benign in link targets.
// Note: image/svg+xml is intentionally NOT in this list (SVG can host <script>).
const DATA_URI_SAFE_MIME_RE = /^data:(image\/(png|jpe?g|gif|webp|bmp|ico|avif|heic)|font\/(woff2?|otf|ttf))(;[^,]*)?,/i;

const MARKDOWN_LINK_PATTERNS = [
  {
    // MD-LINK-JS-SCHEME: javascript: URI in markdown link target
    // Matches [text](javascript:...) — case-insensitive
    pattern: /\]\(\s*javascript:/i,
    ruleId: 'MD-LINK-JS-SCHEME',
  },
  {
    // MD-LINK-DATA-SCHEME: data: URI not in safe-list
    // Checked via custom function (safe-list requires lookahead beyond a simple regex)
    pattern: /\]\(\s*data:/i,
    ruleId: 'MD-LINK-DATA-SCHEME',
    safePredicate: (line) => {
      // Extract the data: URI from the markdown link target
      const m = line.match(/\]\(\s*(data:[^)]*)/i);
      if (!m) return false; // pattern matched but no URI found — flag it
      return DATA_URI_SAFE_MIME_RE.test(m[1]);
    },
  },
  {
    // MD-LINK-USERINFO: https?://user:pass@host in markdown link target
    // Flags ://anything:anything@  — must have a colon+non-slash before the @
    // Does NOT match mailto:user@host (mailto has no :// before the user part)
    // Does NOT match https://host:443/path (port has no @ after the colon)
    pattern: /\]\(\s*https?:\/\/[^/\s]+:[^/@\s]+@/i,
    ruleId: 'MD-LINK-USERINFO',
  },
  {
    // MD-LINK-TOKEN-IN-QUERY: sensitive parameter key in query string
    // Fires on key NAME regardless of value, per RFC 9700 §4.3.1
    pattern: /[?&](token|access_token|id_token|refresh_token|api_key|apikey|secret|password|client_secret|code)=/i,
    ruleId: 'MD-LINK-TOKEN-IN-QUERY',
  },
];

/**
 * Layer 2: Encoding-obfuscation patterns with custom finding messages.
 * Each entry: { pattern: RegExp, message: string }
 */
const OBFUSCATION_PATTERN_ENTRIES = [
  {
    pattern: /\b(\w\s){4,}\w\b/,
    message: 'Character-spacing obfuscation pattern detected (e.g. "i g n o r e")',
  },
  {
    pattern: /<\/?(system|human|assistant|user)\s*>/i,
    message: 'Delimiter injection pattern: <system>/<human>/<assistant>/<user> tag detected',
  },
  {
    pattern: /0x[0-9a-fA-F]{16,}/,
    message: 'Long hex sequence detected — possible encoded payload',
  },
];

/**
 * Scan text for potential prompt injection patterns.
 * Returns an array of findings (empty = clean).
 *
 * @param {string} text - The text to scan
 * @param {object} [opts] - Options
 * @param {boolean} [opts.strict=false] - Enable stricter matching (more false positives)
 * @param {string} [opts.file] - Optional file path for structured finding context
 * @returns {{ clean: boolean, findings: string[], structuredFindings: Array<{ruleId: string, file: string|undefined, line: number, match: string}> }}
 */
function scanForInjection(text, opts = {}) {
  if (!text || typeof text !== 'string') {
    return { clean: true, findings: [], structuredFindings: [] };
  }

  const findings = [];
  const structuredFindings = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      findings.push(`Matched injection pattern: ${pattern.source}`);
    }
  }

  // Layer 2: encoding-obfuscation patterns with custom messages
  for (const entry of OBFUSCATION_PATTERN_ENTRIES) {
    if (entry.pattern.test(text)) {
      findings.push(entry.message);
    }
  }

  // Layer 5: Markdown link patterns (issue #113)
  // Scans line-by-line to provide file+line context in structured findings.
  const lines = text.split('\n');
  for (const entry of MARKDOWN_LINK_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(entry.pattern);
      if (!m) continue;

      // If the entry has a safePredicate, skip flagging when the predicate returns true
      if (entry.safePredicate && entry.safePredicate(line)) continue;

      const matchText = m[0];
      findings.push(`Matched markdown link pattern [${entry.ruleId}]: ${matchText}`);
      structuredFindings.push({
        ruleId: entry.ruleId,
        file: opts.file,
        line: i + 1, // 1-based line number
        match: matchText,
      });
    }
  }

  if (opts.strict) {
    // Check for suspicious Unicode that could hide instructions
    // (zero-width chars, RTL override, homoglyph attacks)
    if (/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/.test(text)) {
      findings.push('Contains suspicious zero-width or invisible Unicode characters');
    }

    // Layer 1: Unicode tag block U+E0000\u2013E007F (2025 supply-chain attack vector)
    // These characters are invisible and can embed hidden instructions
    if (/[\uDB40\uDC00-\uDB40\uDC7F]/u.test(text) || /[\u{E0000}-\u{E007F}]/u.test(text)) {
      findings.push('Contains Unicode tag block characters (U+E0000\u2013E007F) \u2014 invisible instruction injection vector');
    }

    // Check for extremely long strings that could be prompt stuffing.
    // Normalize CRLF \u2192 LF before measuring so Windows checkouts don't inflate the count.
    const normalizedLength = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').length;
    if (normalizedLength > 50000) {
      findings.push(`Suspicious text length: ${normalizedLength} chars (potential prompt stuffing)`);
    }
  }

  return { clean: findings.length === 0, findings, structuredFindings };
}

/**
 * Sanitize text that will be embedded in agent prompts or planning documents.
 * Strips known injection markers while preserving legitimate content.
 *
 * This does NOT alter user intent — it neutralizes control characters and
 * instruction-mimicking patterns that could hijack agent behavior.
 *
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
function sanitizeForPrompt(text) {
  if (!text || typeof text !== 'string') return text;

  let sanitized = text;

  // Strip zero-width characters that could hide instructions
  sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g, '');

  // Neutralize XML/HTML tags that mimic system boundaries
  // Replace < > with full-width equivalents to prevent tag interpretation
  // Note: <instructions> is excluded — GSD uses it as legitimate prompt structure
  // Matches system|assistant|human|user with optional whitespace before the closing >
  sanitized = sanitized.replace(/<(\/?)\s*(?:system|assistant|human|user)\s*>/gi,
    (_, slash) => `＜${slash || ''}system-text＞`);

  // Neutralize [SYSTEM] / [INST] / [/INST] markers — both opening and closing variants
  sanitized = sanitized.replace(/\[(\/?)(SYSTEM|INST)\]/gi, (_, slash, tag) => `[${slash}${tag.toUpperCase()}-TEXT]`);

  // Neutralize <<SYS>> and <</SYS>> markers (Llama-style delimiters)
  sanitized = sanitized.replace(/<<\/?\s*SYS\s*>>/gi, '«SYS-TEXT»');

  return sanitized;
}

/**
 * Sanitize text that will be displayed back to the user.
 * Removes protocol-like leak markers that should never surface in checkpoints.
 *
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
function sanitizeForDisplay(text) {
  if (!text || typeof text !== 'string') return text;

  let sanitized = sanitizeForPrompt(text);

  const protocolLeakPatterns = [
    /^\s*(?:assistant|user|system)\s+to=[^:\s]+:[^\n]+$/i,
    /^\s*<\|(?:assistant|user|system)[^|]*\|>\s*$/i,
  ];

  sanitized = sanitized
    .split('\n')
    .filter(line => !protocolLeakPatterns.some(pattern => pattern.test(line)))
    .join('\n');

  return sanitized;
}

// ─── Shell Safety ───────────────────────────────────────────────────────────

/**
 * Validate that a string is safe to use as a shell argument when quoted.
 * This is a defense-in-depth check — callers should always use array-based
 * exec (spawnSync) where possible.
 *
 * @param {string} value - The value to check
 * @param {string} label - Description for error messages
 * @returns {string} The validated value
 */
function validateShellArg(value, label) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${label || 'Argument'}: empty or invalid value`);
  }

  // Reject null bytes
  if (value.includes('\0')) {
    throw new Error(`${label || 'Argument'}: contains null bytes`);
  }

  // Reject command substitution attempts
  if (/[$`]/.test(value) && /\$\(|`/.test(value)) {
    throw new Error(`${label || 'Argument'}: contains potential command substitution`);
  }

  return value;
}

// ─── JSON Safety ────────────────────────────────────────────────────────────

/**
 * Safely parse JSON with error handling and optional size limits.
 * Wraps JSON.parse to prevent uncaught exceptions from malformed input.
 *
 * @param {string} text - JSON string to parse
 * @param {object} [opts] - Options
 * @param {number} [opts.maxLength=1048576] - Maximum input length (1MB default)
 * @param {string} [opts.label='JSON'] - Description for error messages
 * @returns {{ ok: boolean, value?: any, error?: string }}
 */
function safeJsonParse(text, opts = {}) {
  const maxLength = opts.maxLength || 1048576;
  const label = opts.label || 'JSON';

  if (!text || typeof text !== 'string') {
    return { ok: false, error: `${label}: empty or invalid input` };
  }

  if (text.length > maxLength) {
    return { ok: false, error: `${label}: input exceeds ${maxLength} byte limit (got ${text.length})` };
  }

  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `${label}: parse error — ${err.message}` };
  }
}

// ─── Phase/Argument Validation ──────────────────────────────────────────────

/**
 * Validate a phase number argument.
 * Phase numbers must match: integer, decimal (2.1), or letter suffix (12A).
 * Rejects arbitrary strings that could be used for injection.
 *
 * @param {string} phase - The phase number to validate
 * @returns {{ valid: boolean, normalized?: string, error?: string }}
 */
function validatePhaseNumber(phase) {
  if (!phase || typeof phase !== 'string') {
    return { valid: false, error: 'Phase number is required' };
  }

  const trimmed = phase.trim();

  // Standard numeric: 1, 01, 12A, 12.1, 12A.1.2
  if (/^\d{1,4}[A-Z]?(?:\.\d{1,3})*$/i.test(trimmed)) {
    return { valid: true, normalized: trimmed };
  }

  // Custom project IDs: PROJ-42, AUTH-101 (uppercase alphanumeric with hyphens)
  if (/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){1,4}$/i.test(trimmed) && trimmed.length <= 30) {
    return { valid: true, normalized: trimmed };
  }

  return { valid: false, error: `Invalid phase number format: "${trimmed}"` };
}

/**
 * Validate a STATE.md field name to prevent injection into regex patterns.
 * Field names must be alphanumeric with spaces, hyphens, underscores, or dots.
 *
 * @param {string} field - The field name to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFieldName(field) {
  if (!field || typeof field !== 'string') {
    return { valid: false, error: 'Field name is required' };
  }

  // Allow typical field names: "Current Phase", "active_plan", "Phase 1.2"
  if (/^[A-Za-z][A-Za-z0-9 _.\-/]{0,60}$/.test(field)) {
    return { valid: true };
  }

  return { valid: false, error: `Invalid field name: "${field}"` };
}

// ─── Layer 3: Structural Schema Validation ───────────────────────────────────

const KNOWN_VALID_TAGS = new Set([
  'objective', 'process', 'step', 'success_criteria', 'critical_rules',
  'available_agent_types', 'purpose', 'required_reading',
]);

/**
 * Validate the XML structure of a prompt file.
 * For agent/workflow files, flags any XML tag not in the known-valid set.
 *
 * @param {string} text - The file content to validate
 * @param {'agent'|'workflow'|'unknown'} fileType - The type of prompt file
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validatePromptStructure(text, fileType) {
  if (!text || typeof text !== 'string') {
    return { valid: true, violations: [] };
  }

  if (fileType !== 'agent' && fileType !== 'workflow') {
    return { valid: true, violations: [] };
  }

  const violations = [];
  const tagRegex = /<([A-Za-z][A-Za-z0-9_-]*)/g;
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const tag = match[1].toLowerCase();
    if (!KNOWN_VALID_TAGS.has(tag)) {
      violations.push(`Unknown XML tag in ${fileType} file: <${tag}>`);
    }
  }

  return { valid: violations.length === 0, violations };
}

// ─── Layer 4: Paragraph-Level Entropy Anomaly Detection ─────────────────────

function shannonEntropy(text) {
  if (!text || text.length === 0) return 0;
  const freq = {};
  for (const ch of text) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  const len = text.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Scan text for paragraphs with anomalously high Shannon entropy.
 *
 * @param {string} text - The text to scan
 * @returns {{ clean: boolean, findings: string[] }}
 */
function scanEntropyAnomalies(text) {
  if (!text || typeof text !== 'string') {
    return { clean: true, findings: [] };
  }

  const findings = [];
  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    if (para.length <= 50) continue;
    const entropy = shannonEntropy(para);
    if (entropy > 5.5) {
      findings.push(
        `High-entropy paragraph detected (${entropy.toFixed(2)} bits/char) — possible encoded payload`
      );
    }
  }

  return { clean: findings.length === 0, findings };
}

module.exports = {
  // Path safety
  validatePath,
  requireSafePath,

  // Prompt injection
  INJECTION_PATTERNS,
  MARKDOWN_LINK_PATTERNS,
  scanForInjection,
  sanitizeForPrompt,
  sanitizeForDisplay,

  // Shell safety
  validateShellArg,

  // JSON safety
  safeJsonParse,

  // Input validation
  validatePhaseNumber,
  validateFieldName,

  // Structural validation (Layer 3)
  validatePromptStructure,

  // Entropy anomaly detection (Layer 4)
  scanEntropyAnomalies,
};
