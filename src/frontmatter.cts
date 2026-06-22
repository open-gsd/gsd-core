/**
 * Frontmatter — YAML frontmatter parsing, serialization, and CRUD commands
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/frontmatter.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
import { platformReadSync as safeReadFile, platformWriteSync } from './shell-command-projection.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;

// ─── Parsing engine ───────────────────────────────────────────────────────────

/**
 * Split a YAML inline array body on commas, respecting quoted strings.
 * e.g. '"a, b", c' → ['a, b', 'c']
 */
function splitInlineArray(body: string): string[] {
  const items: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ',') {
      const trimmed = current.trim();
      if (trimmed) items.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) items.push(trimmed);
  return items;
}

function extractFrontmatter(content: string): Frontmatter {
  const frontmatter: Frontmatter = {};
  // Match frontmatter only at byte 0 — a `---` block later in the document
  // body (YAML examples, horizontal rules) must never be treated as frontmatter.
  const headerEnd = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : -1;
  if (headerEnd === -1) return frontmatter;

  const closingLineStart = content.indexOf('\n---', headerEnd);
  if (closingLineStart === -1) return frontmatter;

  const yamlEnd = content[closingLineStart - 1] === '\r' ? closingLineStart - 1 : closingLineStart;
  const yaml = content.slice(headerEnd, yamlEnd);
  const lines = yaml.split(/\r?\n/);

  // Stack to track nested objects: [{obj, key, indent}]
  type StackEntry = { obj: Record<string, unknown> | unknown[]; key: string | null; indent: number };
  const stack: StackEntry[] = [{ obj: frontmatter, key: null, indent: -1 }];

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === '') continue;

    // Calculate indentation (number of leading spaces)
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Pop stack back to appropriate level
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1];

    // Check for key: value pattern
    const keyMatch = line.match(/^(\s*)([a-zA-Z0-9_-]+):\s*(.*)/);
    if (keyMatch) {
      const key = keyMatch[2];
      const value = keyMatch[3].trim();

      if (value === '' || value === '[') {
        // Key with no value or opening bracket — could be nested object or array
        const newObj: Record<string, unknown> | unknown[] = value === '[' ? [] : {};
        (current.obj as Record<string, unknown>)[key] = newObj;
        current.key = null;
        // Push new context for potential nested content
        stack.push({ obj: newObj, key: null, indent });
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array: key: [a, b, c] — quote-aware split (REG-04 fix)
        (current.obj as Record<string, unknown>)[key] = splitInlineArray(value.slice(1, -1));
        current.key = null;
      } else {
        // Simple key: value
        (current.obj as Record<string, unknown>)[key] = value.replace(/^["']|["']$/g, '');
        current.key = null;
      }
    } else if (line.trim().startsWith('- ')) {
      // Array item
      const itemValue = line.trim().slice(2).replace(/^["']|["']$/g, '');

      // If current context is an empty object, convert to array
      if (typeof current.obj === 'object' && !Array.isArray(current.obj) && Object.keys(current.obj).length === 0) {
        // Find the key in parent that points to this object and convert it
        const parent = stack.length > 1 ? stack[stack.length - 2] : null;
        if (parent) {
          for (const k of Object.keys(parent.obj)) {
            if ((parent.obj as Record<string, unknown>)[k] === current.obj) {
              (parent.obj as Record<string, unknown>)[k] = [itemValue];
              current.obj = (parent.obj as Record<string, unknown>)[k] as unknown[];
              break;
            }
          }
        }
      } else if (Array.isArray(current.obj)) {
        current.obj.push(itemValue);
      }
    }
  }

  return frontmatter;
}

function reconstructFrontmatter(obj: Frontmatter): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (value.every(v => typeof v === 'string') && value.length <= 3 && (value).join(', ').length < 60) {
        lines.push(`${key}: [${(value).join(', ')}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${typeof item === 'string' && (item.includes(':') || item.includes('#')) ? `"${item}"` : item}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [subkey, subval] of Object.entries(value)) {
        if (subval === null || subval === undefined) continue;
        if (Array.isArray(subval)) {
          if (subval.length === 0) {
            lines.push(`  ${subkey}: []`);
          } else if (subval.every((v: unknown) => typeof v === 'string') && subval.length <= 3 && (subval).join(', ').length < 60) {
            lines.push(`  ${subkey}: [${(subval).join(', ')}]`);
          } else {
            lines.push(`  ${subkey}:`);
            for (const item of subval) {
              lines.push(`    - ${typeof item === 'string' && (item.includes(':') || item.includes('#')) ? `"${item}"` : item}`);
            }
          }
        } else if (typeof subval === 'object') {
          lines.push(`  ${subkey}:`);
          for (const [subsubkey, subsubval] of Object.entries(subval as Record<string, unknown>)) {
            if (subsubval === null || subsubval === undefined) continue;
            if (Array.isArray(subsubval)) {
              if (subsubval.length === 0) {
                lines.push(`    ${subsubkey}: []`);
              } else {
                lines.push(`    ${subsubkey}:`);
                for (const item of subsubval) {
                  lines.push(`      - ${item}`);
                }
              }
            } else {
              // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions
              lines.push(`    ${subsubkey}: ${subsubval}`);
            }
          }
        } else {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          const sv = String(subval);
          lines.push(`  ${subkey}: ${sv.includes(':') || sv.includes('#') ? `"${sv}"` : sv}`);
        }
      }
    } else {
      const sv = String(value);
      if (sv.includes(':') || sv.includes('#') || sv.startsWith('[') || sv.startsWith('{')) {
        lines.push(`${key}: "${sv}"`);
      } else {
        lines.push(`${key}: ${sv}`);
      }
    }
  }
  return lines.join('\n');
}

function spliceFrontmatter(content: string, newObj: Frontmatter): string {
  const match = content.match(/^---\r?\n[\s\S]+?\r?\n---/);
  if (match) {
    // Identity-preservation (additive, lossless round-trip): `reconstructFrontmatter` is a
    // deliberately lossy serializer — it cannot faithfully re-emit nested object-list items
    // (e.g. must_haves.artifacts / must_haves.prohibitions, whose items are `{ path, provides }`
    // / `{ statement, status, … }` maps). When the caller is writing back a value that is
    // STRUCTURALLY UNCHANGED from the original parse (the canonical CRUD round-trip and the
    // #644 prohibition schema round-trip both do this), regenerating from the lossy object would
    // silently mangle those blocks. Detect that case by deep-equality against a re-parse of the
    // original frontmatter and preserve the ORIGINAL raw text verbatim — a true no-op splice.
    // This touches neither the parser (`extractFrontmatter`) nor `parseMustHavesBlock`; it only
    // makes the existing splice faithful when nothing changed. A genuine mutation (different
    // object) still flows through `reconstructFrontmatter` exactly as before.
    try {
      if (frontmatterDeepEqual(extractFrontmatter(content), newObj)) {
        return content;
      }
    } catch {
      /* fall through to regeneration on any comparison hiccup */
    }
    const yamlStr = reconstructFrontmatter(newObj);
    return `---\n${yamlStr}\n---` + content.slice(match[0].length);
  }
  const yamlStr = reconstructFrontmatter(newObj);
  return `---\n${yamlStr}\n---\n\n` + content;
}

/**
 * Structural deep-equality for two parsed frontmatter objects. Order-sensitive for arrays
 * (YAML lists are ordered), key-order-insensitive for objects. Used only by `spliceFrontmatter`
 * to recognize a no-op write-back; intentionally narrow (handles the string / string[] /
 * nested-object shapes `extractFrontmatter` produces).
 */
function frontmatterDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => frontmatterDeepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao: Record<string, unknown> = a as Record<string, unknown>;
    const bo: Record<string, unknown> = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      Object.prototype.hasOwnProperty.call(bo, k) && frontmatterDeepEqual(ao[k], bo[k]),
    );
  }
  return false;
}

function parseMustHavesBlock(content: string, blockName: string): unknown[] {
  // Extract a specific block from must_haves in raw frontmatter YAML
  // Handles 3-level nesting: must_haves > artifacts/key_links > [{path, provides, ...}]
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return [];

  const yaml = fmMatch[1];

  // Find must_haves: first to detect its indentation level
  const mustHavesMatch = yaml.match(/^(\s*)must_haves:\s*$/m);
  if (!mustHavesMatch) return [];
  const mustHavesIndent = mustHavesMatch[1].length;

  // Find the block (e.g., "truths:", "artifacts:", "key_links:") under must_haves
  // It must be indented more than must_haves but we detect the actual indent dynamically
  const blockPattern = new RegExp(`^(\\s+)${blockName}:\\s*$`, 'm');
  const blockMatch = yaml.match(blockPattern);
  if (!blockMatch) return [];

  const blockIndent = blockMatch[1].length;
  // The block must be nested under must_haves (more indented)
  if (blockIndent <= mustHavesIndent) return [];

  // Find where the block starts in the yaml string
  const blockStart = yaml.indexOf(blockMatch[0]);
  if (blockStart === -1) return [];

  const afterBlock = yaml.slice(blockStart);
  const blockLines = afterBlock.split(/\r?\n/).slice(1); // skip the header line

  // List items are indented one level deeper than blockIndent
  // Continuation KVs are indented one level deeper than list items
  const items: unknown[] = [];
  let current: string | Record<string, unknown> | null = null;
  let listItemIndent = -1; // detected from first "- " line

  for (const line of blockLines) {
    // Skip empty lines
    if (line.trim() === '') continue;
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    // Stop at same or lower indent level than the block header
    if (indent <= blockIndent && line.trim() !== '') break;

    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      // Detect list item indent from the first occurrence
      if (listItemIndent === -1) listItemIndent = indent;

      // Only treat as a top-level list item if at the expected indent
      if (indent === listItemIndent) {
        if (current) items.push(current);
        const afterDash = trimmed.slice(2);
        const trimmedAfterDash = afterDash.trim();
        // Check if it's a fully-quoted string (may contain ':' inside the quotes)
        if ((trimmedAfterDash.startsWith('"') && trimmedAfterDash.endsWith('"')) ||
            (trimmedAfterDash.startsWith("'") && trimmedAfterDash.endsWith("'"))) {
          current = trimmedAfterDash.slice(1, -1);
        // Check if it's a simple string item (no colon means not a key-value)
        } else if (!afterDash.includes(':')) {
          current = afterDash.replace(/^["']|["']$/g, '');
        } else {
          // Key-value on same line as dash: "- path: value"
          // YAML KV always has at least one space after the colon: "key: value"
          // Requiring \s+ rejects "Class::Method" and "db:seed" (no space after colon)
          const kvMatch = afterDash.match(/^(\w+):\s+"?([^"]*)"?\s*$/);
          if (kvMatch) {
            current = {};
            (current)[kvMatch[1]] = kvMatch[2];
          } else {
            // Looks like KV but doesn't match — treat as plain string (#2757)
            current = afterDash.replace(/^["']|["']$/g, '');
          }
        }
        continue;
      }
    }

    if (current && typeof current === 'object' && indent > listItemIndent) {
      // Continuation key-value or nested array item
      if (trimmed.startsWith('- ')) {
        // Array item under a key
        const arrVal = trimmed.slice(2).replace(/^["']|["']$/g, '');
        const keys = Object.keys(current);
        const lastKey = keys[keys.length - 1];
        if (lastKey && !Array.isArray((current)[lastKey])) {
          const existing = (current)[lastKey];
          (current)[lastKey] = existing ? [existing] : [];
        }
        if (lastKey) ((current)[lastKey] as unknown[]).push(arrVal);
      } else {
        const kvMatch = trimmed.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
        if (kvMatch) {
          const val = kvMatch[2];
          // Try to parse as number
          (current)[kvMatch[1]] = /^\d+$/.test(val) ? parseInt(val, 10) : val;
        }
      }
    }
  }
  if (current) items.push(current);

  // Warn when must_haves block exists but parsed as empty -- likely YAML formatting issue.
  // This is a critical diagnostic: empty must_haves causes verification to silently degrade
  // to Option C (LLM-derived truths) instead of checking documented contracts.
  if (items.length === 0 && blockLines.length > 0) {
    const nonEmptyLines = blockLines.filter(l => l.trim() !== '').length;
    if (nonEmptyLines > 0) {
      process.stderr.write(
        `[gsd-tools] WARNING: must_haves.${blockName} block has ${nonEmptyLines} content lines but parsed 0 items. ` +
        `Possible YAML formatting issue — verification will fall back to LLM-derived truths.\n`
      );
    }
  }

  return items;
}

// ─── Frontmatter CRUD commands ────────────────────────────────────────────────

const FRONTMATTER_SCHEMAS: Record<string, { required: string[] }> = {
  plan: { required: ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'] },
  summary: { required: ['phase', 'plan', 'subsystem', 'tags', 'duration', 'completed'] },
  verification: { required: ['phase', 'verified', 'status', 'score'] },
};

function cmdFrontmatterGet(cwd: string, filePath: string, field: string | undefined, raw: boolean): void {
  if (!filePath) { error('file path required'); }
  // Path traversal guard: reject null bytes
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  const fm = extractFrontmatter(content);
  if (field) {
    const value = fm[field];
    if (value === undefined) { output({ error: 'Field not found', field }, raw, undefined); return; }
    output({ [field]: value }, raw, JSON.stringify(value));
  } else {
    output(fm, raw, undefined);
  }
}

function cmdFrontmatterSet(cwd: string, filePath: string, field: string | undefined, value: string | undefined, raw: boolean): void {
  if (!filePath || !field || value === undefined) { error('file, field, and value required'); }
  // Path traversal guard: reject null bytes
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);
  let parsedValue: unknown;
  try { parsedValue = JSON.parse(value as string); } catch { parsedValue = value; }
  fm[field as string] = parsedValue as FrontmatterValue;
  const newContent = spliceFrontmatter(content, fm);
  platformWriteSync(fullPath, newContent);
  output({ updated: true, field, value: parsedValue }, raw, 'true');
}

function cmdFrontmatterMerge(cwd: string, filePath: string, data: string | undefined, raw: boolean): void {
  if (!filePath || !data) { error('file and data required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);
  let mergeData: Record<string, FrontmatterValue>;
  try { mergeData = JSON.parse(data as string) as Record<string, FrontmatterValue>; } catch { error('Invalid JSON for --data'); return; }
  Object.assign(fm, mergeData);
  const newContent = spliceFrontmatter(content, fm);
  platformWriteSync(fullPath, newContent);
  output({ merged: true, fields: Object.keys(mergeData) }, raw, 'true');
}

function cmdFrontmatterValidate(cwd: string, filePath: string, schemaName: string | undefined, raw: boolean): void {
  if (!filePath || !schemaName) { error('file and schema required'); }
  const schema = FRONTMATTER_SCHEMAS[schemaName as string];
  if (!schema) { error(`Unknown schema: ${schemaName}. Available: ${Object.keys(FRONTMATTER_SCHEMAS).join(', ')}`); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  const fm = extractFrontmatter(content);
  const missing = schema.required.filter(f => fm[f] === undefined);
  const present = schema.required.filter(f => fm[f] !== undefined);
  output({ valid: missing.length === 0, missing, present, schema: schemaName }, raw, missing.length === 0 ? 'valid' : 'invalid');
}

export = {
  extractFrontmatter,
  // Additive alias (#644 prohibition-probe schema contract): the probe round-trip seam reads a
  // frontmatter object via `parseFrontmatter` (the name the contract test pins). It is the SAME
  // function as `extractFrontmatter` — a bare-object parse with no behavior change — exposed under
  // the alias so the prohibition schema round-trip and any future caller can use the canonical name.
  parseFrontmatter: extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  parseMustHavesBlock,
  FRONTMATTER_SCHEMAS,
  cmdFrontmatterGet,
  cmdFrontmatterSet,
  cmdFrontmatterMerge,
  cmdFrontmatterValidate,
};
