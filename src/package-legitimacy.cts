/**
 * Package Legitimacy Module
 *
 * Replaces the bolt-on prose slopcheck gate (which pip-installed `slopcheck`
 * and degraded ALL packages to [ASSUMED] when pip failed) with registry-API
 * verdicts computed in code.
 *
 * Public interface:
 *   DEFAULT_THRESHOLDS  — baseline thresholds
 *   classifyPackage     — pure function: signals → { verdict, reasons }
 *   checkPackages       — async: resolves registry signals and classifies
 *
 * All network IO is injected via a `registry` client option so that tests
 * never touch the real network (same seam pattern as clock injection).
 *
 * ADR-457 build-at-publish: authored as TypeScript .cts → emits .cjs via tsc.
 */

import * as https from 'node:https';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Verdict = 'OK' | 'SUS' | 'SLOP';
type Ecosystem = 'npm' | 'pypi' | 'crates' | string;

interface Thresholds {
  minAgeDays: number;
  minWeeklyDownloads: number;
  requireRepo: boolean;
}

interface PackageSignals {
  exists: boolean | null | undefined;
  publishedAt: string | null | undefined;
  weeklyDownloads: number | null | undefined;
  repoUrl: string | null | undefined;
  deprecated: boolean | null | undefined;
  postinstall: string | null | undefined;
  ecosystem?: string | null | undefined;
}

interface ClassifyResult {
  verdict: Verdict;
  reasons: string[];
}

interface CheckResult {
  name: string;
  verdict: Verdict;
  signals: PackageSignals;
  reasons: string[];
}

interface RegistryClient {
  lookup(ecosystem: Ecosystem, name: string): Promise<PackageSignals>;
}

interface SlopcheckAdapter {
  check(ecosystem: Ecosystem, name: string): Promise<Verdict | null>;
}

interface ClassifyOptions {
  thresholds?: Thresholds;
  clock?: { now(): number };
}

interface CheckPackagesInput {
  ecosystem: Ecosystem;
  packages: string[];
  version?: string;
}

interface CheckPackagesOptions {
  registry?: RegistryClient;
  clock?: { now(): number };
  thresholds?: Thresholds;
  slopcheck?: SlopcheckAdapter | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: Thresholds = {
  minAgeDays: 30,
  minWeeklyDownloads: 1000,
  requireRepo: true,
};

// Matches common dangerous postinstall patterns:
//   curl, wget, http/https URLs, parent-dir traversal (../), /etc/ paths,
//   home-dir (~/) paths, netcat (nc ), bash -c
const SUSPICIOUS_POSTINSTALL_RE =
  /(curl|wget|https?:\/\/|\.\.\/|\/etc\/|~\/|nc |bash -c)/i;

// ---------------------------------------------------------------------------
// Severity ordering for verdict merging (SLOP > SUS > OK)
// ---------------------------------------------------------------------------

const SEVERITY: Record<Verdict, number> = { OK: 0, SUS: 1, SLOP: 2 };

function moreServerVerdict(a: Verdict, b: Verdict): Verdict {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

// ---------------------------------------------------------------------------
// classifyPackage — pure, no IO
// ---------------------------------------------------------------------------

function classifyPackage(
  signals: Partial<PackageSignals>,
  { thresholds = DEFAULT_THRESHOLDS, clock = Date }: ClassifyOptions = {}
): ClassifyResult {
  const reasons: string[] = [];

  // Terminal: package does not exist
  if (signals.exists === false) {
    return { verdict: 'SLOP', reasons: ['does-not-exist'] };
  }

  // Age check
  if (signals.publishedAt == null) {
    reasons.push('unknown-age');
  } else {
    const parsed = Date.parse(String(signals.publishedAt));
    if (!Number.isFinite(parsed)) {
      // Unparseable date — treat as unknown
      reasons.push('unknown-age');
    } else {
      const ageDays = Math.floor((clock.now() - parsed) / 86_400_000);
      if (ageDays < thresholds.minAgeDays) {
        reasons.push('too-new');
      }
    }
  }

  // Downloads check
  const downloads = signals.weeklyDownloads;
  if (downloads == null) {
    reasons.push('unknown-downloads');
  } else if (typeof downloads !== 'number' || !Number.isFinite(downloads as number)) {
    // Odd type / NaN — treat as unknown
    reasons.push('unknown-downloads');
  } else if ((downloads as number) < thresholds.minWeeklyDownloads) {
    reasons.push('low-downloads');
  }

  // Repository check
  if (thresholds.requireRepo && !signals.repoUrl) {
    reasons.push('no-repository');
  }

  // Deprecated check
  if (signals.deprecated === true) {
    reasons.push('deprecated');
  }

  // Suspicious postinstall (npm only — but apply whenever postinstall is present)
  if (signals.postinstall != null && typeof signals.postinstall === 'string') {
    if (SUSPICIOUS_POSTINSTALL_RE.test(signals.postinstall)) {
      reasons.push('suspicious-postinstall');
    }
  }

  const verdict: Verdict = reasons.length > 0 ? 'SUS' : 'OK';
  return { verdict, reasons };
}

// ---------------------------------------------------------------------------
// Real registry adapters (not exercised by tests — tests inject fakes)
// ---------------------------------------------------------------------------

function httpsGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'gsd-core-package-legitimacy/1.0' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

function degradedSignals(): PackageSignals {
  return {
    exists: null,
    publishedAt: null,
    weeklyDownloads: null,
    repoUrl: null,
    deprecated: false,
    postinstall: null,
  };
}

async function lookupNpm(name: string): Promise<PackageSignals> {
  try {
    const raw = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(name)}`, 5000);
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.error) return { ...degradedSignals(), exists: false };

    const time = (data.time as Record<string, string> | undefined) ?? {};
    const latestVersion = (data['dist-tags'] as Record<string, string> | undefined)?.latest ?? '';
    const versionMeta =
      ((data.versions as Record<string, unknown> | undefined) ?? {})[latestVersion] ?? {};

    const scripts =
      ((versionMeta as Record<string, unknown>).scripts as Record<string, string> | undefined) ??
      {};
    const postinstall = scripts.postinstall ?? null;

    const repoField = (versionMeta as Record<string, unknown>).repository;
    let repoUrl: string | null = null;
    if (typeof repoField === 'string') repoUrl = repoField;
    else if (repoField && typeof (repoField as Record<string, unknown>).url === 'string') {
      repoUrl = (repoField as Record<string, string>).url;
    }

    const deprecated =
      typeof (versionMeta as Record<string, unknown>).deprecated === 'string' ? true : false;

    return {
      exists: true,
      publishedAt: time[latestVersion] ?? time.created ?? null,
      weeklyDownloads: null, // npm weekly downloads require a separate API call
      repoUrl,
      deprecated,
      postinstall,
      ecosystem: 'npm',
    };
  } catch {
    return degradedSignals();
  }
}

async function lookupPypi(name: string): Promise<PackageSignals> {
  try {
    const raw = await httpsGet(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, 5000);
    const data = JSON.parse(raw) as Record<string, unknown>;
    const info = (data.info as Record<string, unknown>) ?? {};
    const urls = (data.urls as Array<Record<string, unknown>>) ?? [];
    const uploadTime =
      urls.length > 0 ? (urls[0].upload_time_iso_8601 as string | undefined) ?? null : null;

    const projectUrls = info.project_urls as Record<string, string> | undefined;
    const repoUrl =
      projectUrls?.['Source'] ??
      projectUrls?.['Homepage'] ??
      (info.home_page as string | undefined) ??
      null;

    return {
      exists: true,
      publishedAt: uploadTime,
      weeklyDownloads: null, // PyPI weekly downloads require a separate API
      repoUrl: repoUrl || null,
      deprecated: false, // PyPI doesn't have a first-class deprecated field
      postinstall: null, // Not applicable for PyPI
      ecosystem: 'pypi',
    };
  } catch {
    return degradedSignals();
  }
}

async function lookupCrates(name: string): Promise<PackageSignals> {
  try {
    const raw = await httpsGet(
      `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
      5000
    );
    const data = JSON.parse(raw) as Record<string, unknown>;
    const krate = (data.crate as Record<string, unknown>) ?? {};

    const repoUrl = (krate.repository as string | undefined) ?? null;
    const created = (krate.created_at as string | undefined) ?? null;
    const downloads = typeof krate.recent_downloads === 'number' ? krate.recent_downloads as number : null;

    return {
      exists: true,
      publishedAt: created,
      weeklyDownloads: downloads,
      repoUrl,
      deprecated: false,
      postinstall: null,
      ecosystem: 'crates',
    };
  } catch {
    return degradedSignals();
  }
}

const realRegistry: RegistryClient = {
  async lookup(ecosystem: Ecosystem, name: string): Promise<PackageSignals> {
    switch (ecosystem) {
      case 'npm':
        return lookupNpm(name);
      case 'pypi':
        return lookupPypi(name);
      case 'crates':
        return lookupCrates(name);
      default:
        return degradedSignals();
    }
  },
};

// ---------------------------------------------------------------------------
// checkPackages — orchestrates lookup + classify + slopcheck merge
// ---------------------------------------------------------------------------

async function checkPackages(
  { ecosystem, packages }: CheckPackagesInput,
  {
    registry = realRegistry,
    clock = Date,
    thresholds = DEFAULT_THRESHOLDS,
    slopcheck = null,
  }: CheckPackagesOptions = {}
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const name of packages) {
    const signals = await registry.lookup(ecosystem, name);
    const { verdict: registryVerdict, reasons } = classifyPackage(signals, { thresholds, clock });

    let finalVerdict: Verdict = registryVerdict;

    if (slopcheck != null) {
      const slopVerdict = await slopcheck.check(ecosystem, name);
      if (slopVerdict != null) {
        finalVerdict = moreServerVerdict(finalVerdict, slopVerdict);
      }
    }

    results.push({ name, verdict: finalVerdict, signals, reasons });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Module export (CommonJS interop — export = only, no other export keywords)
// ---------------------------------------------------------------------------

export = { DEFAULT_THRESHOLDS, classifyPackage, checkPackages };
