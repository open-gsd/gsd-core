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
 *   _setHttpGet         — test seam: override the HTTP transport (pass null to restore)
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
type Ecosystem = string;

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
  lookup(ecosystem: Ecosystem, name: string, version?: string): Promise<PackageSignals>;
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

/** Shape returned by the injectable HTTP transport */
interface HttpResponse {
  statusCode: number;
  body: string;
}

type HttpGetFn = (url: string, timeoutMs: number) => Promise<HttpResponse>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: Thresholds = {
  minAgeDays: 30,
  minWeeklyDownloads: 1000,
  requireRepo: true,
};

// Matches common dangerous postinstall execution patterns.
// Deliberately EXCLUDES bare https?:// (over-fires on legit packages like
// esbuild/sharp/node-gyp that reference download URLs without executing them).
// Shell-execution / download-and-exec signatures only:
const SUSPICIOUS_POSTINSTALL_RE =
  /(curl |wget |\|\s*(ba)?sh|bash -c|sh -c|node -e|eval|base64 -d|\/etc\/|\.\.\/|~\/|nc |>\s*\/)/i;

// ---------------------------------------------------------------------------
// Severity ordering for verdict merging (SLOP > SUS > OK)
// ---------------------------------------------------------------------------

const SEVERITY: Record<Verdict, number> = { OK: 0, SUS: 1, SLOP: 2 };

function moreSevereVerdict(a: Verdict, b: Verdict): Verdict {
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
  } else if (typeof downloads !== 'number' || !Number.isFinite(downloads)) {
    // Odd type / NaN — treat as unknown
    reasons.push('unknown-downloads');
  } else if (downloads < thresholds.minWeeklyDownloads) {
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

  // Terminal: suspicious postinstall is a slopsquatting execution risk
  if (reasons.includes('suspicious-postinstall')) {
    return { verdict: 'SLOP', reasons };
  }

  const verdict: Verdict = reasons.length > 0 ? 'SUS' : 'OK';
  return { verdict, reasons };
}

// ---------------------------------------------------------------------------
// Injectable HTTP transport (test seam — W1)
// ---------------------------------------------------------------------------

/** The real HTTPS transport — resolves { statusCode, body } */
function realHttpsGet(url: string, timeoutMs: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'gsd-core-package-legitimacy/1.0' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

/** Module-level transport pointer — overrideable via _setHttpGet for tests */
let httpsGet: HttpGetFn = realHttpsGet;

/**
 * Test seam: replace the HTTP transport. Pass null to restore the real transport.
 * Tests call this before exercising a real-adapter code path; always restore in finally.
 */
function _setHttpGet(fn: HttpGetFn | null): void {
  httpsGet = fn ?? realHttpsGet;
}

// ---------------------------------------------------------------------------
// Real registry adapters (not exercised by tests — tests inject fakes)
// ---------------------------------------------------------------------------

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

async function lookupNpm(name: string, version?: string): Promise<PackageSignals> {
  try {
    const resp = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(name)}`, 5000);
    if (resp.statusCode === 404) return { ...degradedSignals(), exists: false };
    if (resp.statusCode < 200 || resp.statusCode >= 300) return degradedSignals();

    const data = JSON.parse(resp.body) as Record<string, unknown>;
    if (data.error) return { ...degradedSignals(), exists: false };

    const time = (data.time as Record<string, string> | undefined) ?? {};
    const allVersions = (data.versions as Record<string, unknown> | undefined) ?? {};

    // I3: when a specific version is requested, verify it exists
    if (version !== undefined) {
      if (!(version in allVersions)) {
        return { ...degradedSignals(), exists: false };
      }
    }

    const latestVersion = (data['dist-tags'] as Record<string, string> | undefined)?.latest ?? '';
    const resolvedVersion = version !== undefined ? version : latestVersion;
    const versionMeta = allVersions[resolvedVersion] ?? {};

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

    // Fetch weekly download count from the npm downloads API
    let weeklyDownloads: number | null = null;
    try {
      const dlResp = await httpsGet(
        `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`,
        5000
      );
      if (dlResp.statusCode >= 200 && dlResp.statusCode < 300) {
        const dlData = JSON.parse(dlResp.body) as Record<string, unknown>;
        if (typeof dlData.downloads === 'number') {
          weeklyDownloads = dlData.downloads;
        }
      }
    } catch {
      // Degraded: leave weeklyDownloads as null, never throw
    }

    return {
      exists: true,
      publishedAt: time[resolvedVersion] ?? time.created ?? null,
      weeklyDownloads,
      repoUrl,
      deprecated,
      postinstall,
      ecosystem: 'npm',
    };
  } catch {
    return degradedSignals();
  }
}

async function lookupPypi(name: string, version?: string): Promise<PackageSignals> {
  try {
    const resp = await httpsGet(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, 5000);
    if (resp.statusCode === 404) return { ...degradedSignals(), exists: false };
    if (resp.statusCode < 200 || resp.statusCode >= 300) return degradedSignals();

    const data = JSON.parse(resp.body) as Record<string, unknown>;
    const info = (data.info as Record<string, unknown>) ?? {};

    // I3: when a specific version is requested, verify it exists in releases
    const releases = (data.releases as Record<string, unknown> | undefined) ?? {};
    if (version !== undefined) {
      if (!(version in releases)) {
        return { ...degradedSignals(), exists: false };
      }
    }

    // Finding 2: when version is provided, derive publishedAt from the
    // version-specific release record rather than the package-level urls[] array
    // (which reflects the latest release, not the requested version).
    let uploadTime: string | null = null;
    if (version !== undefined) {
      const versionFiles = (releases[version] as Array<Record<string, unknown>> | undefined) ?? [];
      uploadTime =
        versionFiles.length > 0
          ? (versionFiles[0].upload_time_iso_8601 as string | undefined) ?? null
          : null;
    } else {
      const urls = (data.urls as Array<Record<string, unknown>>) ?? [];
      uploadTime =
        urls.length > 0 ? (urls[0].upload_time_iso_8601 as string | undefined) ?? null : null;
    }

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

async function lookupCrates(name: string, version?: string): Promise<PackageSignals> {
  try {
    const resp = await httpsGet(
      `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
      5000
    );
    if (resp.statusCode === 404) return { ...degradedSignals(), exists: false };
    if (resp.statusCode < 200 || resp.statusCode >= 300) return degradedSignals();

    const data = JSON.parse(resp.body) as Record<string, unknown>;
    const krate = (data.crate as Record<string, unknown>) ?? {};

    // I3: when a specific version is requested, verify it exists in versions list
    const versions = (data.versions as Array<Record<string, unknown>> | undefined) ?? [];
    if (version !== undefined) {
      const found = versions.some(
        (v) => (v.num as string | undefined) === version
      );
      if (!found) {
        return { ...degradedSignals(), exists: false };
      }
    }

    const repoUrl = (krate.repository as string | undefined) ?? null;
    // Finding 2: when version is provided, use the version-specific created_at
    // rather than the package-level crate.created_at (first-ever publish date).
    let created: string | null;
    if (version !== undefined) {
      const versionObj = versions.find((v) => (v.num as string | undefined) === version);
      created = (versionObj?.created_at as string | undefined) ?? null;
    } else {
      created = (krate.created_at as string | undefined) ?? null;
    }
    // recent_downloads is a 90-day count; normalize to a weekly figure for comparison
    // against minWeeklyDownloads (which is a weekly threshold).
    const rawDownloads = krate.recent_downloads;
    const downloads = (rawDownloads != null && typeof Number(rawDownloads) === 'number' && !isNaN(Number(rawDownloads)))
      ? Math.round(Number(rawDownloads) * 7 / 90)
      : null;

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
  async lookup(ecosystem: Ecosystem, name: string, version?: string): Promise<PackageSignals> {
    switch (ecosystem) {
      case 'npm':
        return lookupNpm(name, version);
      case 'pypi':
        return lookupPypi(name, version);
      case 'crates':
        return lookupCrates(name, version);
      default:
        return degradedSignals();
    }
  },
};

// ---------------------------------------------------------------------------
// checkPackages — orchestrates lookup + classify + slopcheck merge
// ---------------------------------------------------------------------------

async function checkPackages(
  { ecosystem, packages, version }: CheckPackagesInput,
  {
    registry = realRegistry,
    clock = Date,
    thresholds = DEFAULT_THRESHOLDS,
    slopcheck = null,
  }: CheckPackagesOptions = {}
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const name of packages) {
    const signals = await registry.lookup(ecosystem, name, version);
    const { verdict: registryVerdict, reasons } = classifyPackage(signals, { thresholds, clock });

    let finalVerdict: Verdict = registryVerdict;

    if (slopcheck != null) {
      const slopVerdict = await slopcheck.check(ecosystem, name);
      if (slopVerdict != null) {
        finalVerdict = moreSevereVerdict(finalVerdict, slopVerdict);
      }
    }

    results.push({ name, verdict: finalVerdict, signals, reasons });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Module export (CommonJS interop — export = only, no other export keywords)
// ---------------------------------------------------------------------------

export = { DEFAULT_THRESHOLDS, classifyPackage, checkPackages, _setHttpGet };
