/** Canonical verification-receipt policy for the OpenCode V2 transport. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterModule = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationModule = require('./verification.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlansModule = require('./plan-scan.cjs');

interface BatchItem { quick_id: string; directory: string | null; }
interface BatchManifest { items: BatchItem[]; }
interface BatchLoadResult { ok: boolean; reason?: string; value?: BatchManifest; }
interface QuickBatchReader { loadBatch(cwd: string, batch: string): BatchLoadResult; }
interface VerificationReceipt { version: number; status: string; checked_at: number; path: string; sha256: string; }
interface VerificationArtifact { path: string; sha256: string; status: string; }
interface ScanPhasePlansResult { summaryFiles: string[]; }
type Frontmatter = Record<string, unknown>;

const { extractFrontmatter } = frontmatterModule as { extractFrontmatter(this: void, content: string, filePath: string): unknown };
const { computeCoveredDigest } = verificationModule as { computeCoveredDigest(this: void, root: string, files: readonly string[]): string | null };
const scanPhasePlans = scanPhasePlansModule as (phaseDir: string) => ScanPhasePlansResult;

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(existingPath: string): string {
  if (!existingPath) throw new Error('missing path');
  return fs.realpathSync(existingPath);
}

function isWithin(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(root, candidate);
  return (allowRoot || relative !== '') && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function exactBatchItem(quickBatch: QuickBatchReader, cwd: string, batch: string, itemId: string): BatchItem {
  const loaded = quickBatch.loadBatch(cwd, batch);
  if (!loaded.ok || !loaded.value) throw new Error(loaded.reason);
  const matches = loaded.value.items.filter((candidate) => candidate.quick_id === itemId);
  if (matches.length !== 1) throw new Error('BATCH must contain exactly one matching item');
  return matches[0];
}

function quickItemDirectory(quickBatch: QuickBatchReader, cwd: string, batch: string, itemId: string): string {
  const batchItem = exactBatchItem(quickBatch, cwd, batch, itemId);
  const root = canonical(cwd);
  const quickRoot = canonical(path.join(cwd, '.planning', 'quick'));
  let directory: string;

  if (typeof batchItem.directory === 'string' && batchItem.directory) {
    directory = canonical(path.resolve(cwd, batchItem.directory));
  } else {
    const matches = fs.readdirSync(quickRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${itemId}-`))
      .map((entry) => canonical(path.join(quickRoot, entry.name)));
    if (matches.length !== 1) throw new Error('quick item must have exactly one deterministic directory');
    [directory] = matches;
  }

  if (!isWithin(root, directory) || !isWithin(quickRoot, directory, true)) {
    throw new Error('verification directory escapes the project quick-task root');
  }
  return directory;
}

function parseCanonicalStatus(decoded: string): string {
  const lines = decoded.split(/\r\n|\n|\r/);
  if (lines[0] !== '---') throw new Error('verification artifact lacks an exact opening frontmatter fence');
  const closing = lines.indexOf('---', 1);
  if (closing === -1) throw new Error('verification artifact lacks an exact closing frontmatter fence');

  const statuses: string[] = [];
  for (const line of lines.slice(1, closing)) {
    if (line && !/^\s/.test(line) && !/^#/.test(line) && !/^[A-Za-z_][A-Za-z0-9_-]*:(?:\s|$)/.test(line)) {
      throw new Error('verification artifact top-level frontmatter keys must use canonical plain syntax');
    }
    if (/^\s*(?:status|["']status["'])\s*:/.test(line)) {
      const match = /^status: (passed|gaps_found|human_needed)$/.exec(line);
      if (!match) throw new Error('verification artifact status must be one unquoted canonical top-level scalar');
      statuses.push(match[1]);
    }
  }
  if (statuses.length !== 1) throw new Error('verification artifact requires exactly one canonical status scalar');
  return statuses[0];
}

function checkStaleness(cwd: string, directory: string, canonicalFile: string, frontmatter: Frontmatter): void {
  const coveredFiles = frontmatter.covered_files;
  const coveredDigest = frontmatter.covered_digest;
  if (coveredFiles !== undefined || coveredDigest !== undefined) {
    if (!Array.isArray(coveredFiles) || coveredFiles.length === 0 || !coveredFiles.every((entry): entry is string => typeof entry === 'string') ||
        typeof coveredDigest !== 'string' || computeCoveredDigest(cwd, coveredFiles) !== coveredDigest) {
      throw new Error('verification artifact fingerprint is stale or malformed');
    }
    return;
  }

  let summaries: string[];
  try {
    summaries = scanPhasePlans(directory).summaryFiles;
  } catch {
    throw new Error('verification artifact staleness is indeterminate');
  }
  try {
    const reportTime = fs.statSync(canonicalFile).mtimeMs;
    if (summaries.some((name) => fs.statSync(path.join(directory, name)).mtimeMs > reportTime)) {
      throw new Error('verification artifact is stale');
    }
  } catch (cause) {
    if (cause instanceof Error) throw cause;
    throw new Error('verification artifact staleness is indeterminate');
  }
}

function verificationArtifact(quickBatch: QuickBatchReader, cwd: string, batch: string, itemId: string): VerificationArtifact {
  const directory = quickItemDirectory(quickBatch, cwd, batch, itemId);
  const file = path.join(directory, `${itemId}-VERIFICATION.md`);
  const canonicalFile = canonical(file);
  if (canonicalFile !== file || !fs.statSync(canonicalFile).isFile()) {
    throw new Error('verification artifact is not the exact canonical file');
  }

  const bytes = fs.readFileSync(canonicalFile);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('verification artifact is not valid UTF-8');
  }

  const status = parseCanonicalStatus(decoded);
  const frontmatter = extractFrontmatter(decoded.replace(/\r\n|\r|\n/g, '\n'), canonicalFile) as Frontmatter;
  if (frontmatter.status !== status) throw new Error('verification artifact shared frontmatter status does not match canonical status');
  checkStaleness(cwd, directory, canonicalFile, frontmatter);
  return { path: canonicalFile, sha256: sha256(bytes), status };
}

function receiptAuthorizesVerification(quickBatch: QuickBatchReader, cwd: string, batch: string, itemId: string, receipt: unknown, expectedStatus: string): boolean {
  const candidate = receipt as Partial<VerificationReceipt> | null;
  if (!candidate || candidate.version !== 1 || candidate.status !== expectedStatus || !Number.isSafeInteger(candidate.checked_at) ||
      typeof candidate.path !== 'string' || typeof candidate.sha256 !== 'string') return false;
  try {
    const current = verificationArtifact(quickBatch, cwd, batch, itemId);
    return current.path === candidate.path && current.sha256 === candidate.sha256 && current.status === candidate.status;
  } catch {
    return false;
  }
}

export = { verificationArtifact, receiptAuthorizesVerification, quickItemDirectory };
