"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
const https = __importStar(require("node:https"));
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_THRESHOLDS = {
    minAgeDays: 30,
    minWeeklyDownloads: 1000,
    requireRepo: true,
};
// Matches common dangerous postinstall execution patterns.
// Deliberately EXCLUDES bare https?:// (over-fires on legit packages like
// esbuild/sharp/node-gyp that reference download URLs without executing them).
// Shell-execution / download-and-exec signatures only:
const SUSPICIOUS_POSTINSTALL_RE = /(curl |wget |\|\s*(ba)?sh|bash -c|sh -c|node -e|eval|base64 -d|\/etc\/|\.\.\/|~\/|nc |>\s*\/)/i;
// ---------------------------------------------------------------------------
// Severity ordering for verdict merging (SLOP > SUS > OK)
// ---------------------------------------------------------------------------
const SEVERITY = { OK: 0, SUS: 1, SLOP: 2 };
function moreSevereVerdict(a, b) {
    return SEVERITY[a] >= SEVERITY[b] ? a : b;
}
// ---------------------------------------------------------------------------
// classifyPackage — pure, no IO
// ---------------------------------------------------------------------------
function classifyPackage(signals, { thresholds = DEFAULT_THRESHOLDS, clock = Date } = {}) {
    const reasons = [];
    // Terminal: package does not exist
    if (signals.exists === false) {
        return { verdict: 'SLOP', reasons: ['does-not-exist'] };
    }
    // Age check
    if (signals.publishedAt == null) {
        reasons.push('unknown-age');
    }
    else {
        const parsed = Date.parse(String(signals.publishedAt));
        if (!Number.isFinite(parsed)) {
            // Unparseable date — treat as unknown
            reasons.push('unknown-age');
        }
        else {
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
    }
    else if (typeof downloads !== 'number' || !Number.isFinite(downloads)) {
        // Odd type / NaN — treat as unknown
        reasons.push('unknown-downloads');
    }
    else if (downloads < thresholds.minWeeklyDownloads) {
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
    const verdict = reasons.length > 0 ? 'SUS' : 'OK';
    return { verdict, reasons };
}
// ---------------------------------------------------------------------------
// Injectable HTTP transport (test seam — W1)
// ---------------------------------------------------------------------------
/** The real HTTPS transport — resolves { statusCode, body } */
function realHttpsGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'gsd-core-package-legitimacy/1.0' } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                statusCode: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
            res.on('error', reject);
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`timeout after ${timeoutMs}ms`));
        });
        req.on('error', reject);
    });
}
/** Module-level transport pointer — overrideable via _setHttpGet for tests */
let httpsGet = realHttpsGet;
/**
 * Test seam: replace the HTTP transport. Pass null to restore the real transport.
 * Tests call this before exercising a real-adapter code path; always restore in finally.
 */
function _setHttpGet(fn) {
    httpsGet = fn ?? realHttpsGet;
}
// ---------------------------------------------------------------------------
// Real registry adapters (not exercised by tests — tests inject fakes)
// ---------------------------------------------------------------------------
function degradedSignals() {
    return {
        exists: null,
        publishedAt: null,
        weeklyDownloads: null,
        repoUrl: null,
        deprecated: false,
        postinstall: null,
    };
}
async function lookupNpm(name, version) {
    try {
        const resp = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(name)}`, 5000);
        if (resp.statusCode === 404)
            return { ...degradedSignals(), exists: false };
        if (resp.statusCode < 200 || resp.statusCode >= 300)
            return degradedSignals();
        const data = JSON.parse(resp.body);
        if (data.error)
            return { ...degradedSignals(), exists: false };
        const time = data.time ?? {};
        const allVersions = data.versions ?? {};
        // I3: when a specific version is requested, verify it exists
        if (version !== undefined) {
            if (!(version in allVersions)) {
                return { ...degradedSignals(), exists: false };
            }
        }
        const latestVersion = data['dist-tags']?.latest ?? '';
        const resolvedVersion = version !== undefined ? version : latestVersion;
        const versionMeta = allVersions[resolvedVersion] ?? {};
        const scripts = versionMeta.scripts ??
            {};
        const postinstall = scripts.postinstall ?? null;
        const repoField = versionMeta.repository;
        let repoUrl = null;
        if (typeof repoField === 'string')
            repoUrl = repoField;
        else if (repoField && typeof repoField.url === 'string') {
            repoUrl = repoField.url;
        }
        const deprecated = typeof versionMeta.deprecated === 'string' ? true : false;
        // Fetch weekly download count from the npm downloads API
        let weeklyDownloads = null;
        try {
            const dlResp = await httpsGet(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, 5000);
            if (dlResp.statusCode >= 200 && dlResp.statusCode < 300) {
                const dlData = JSON.parse(dlResp.body);
                if (typeof dlData.downloads === 'number') {
                    weeklyDownloads = dlData.downloads;
                }
            }
        }
        catch {
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
    }
    catch {
        return degradedSignals();
    }
}
async function lookupPypi(name, version) {
    try {
        const resp = await httpsGet(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, 5000);
        if (resp.statusCode === 404)
            return { ...degradedSignals(), exists: false };
        if (resp.statusCode < 200 || resp.statusCode >= 300)
            return degradedSignals();
        const data = JSON.parse(resp.body);
        const info = data.info ?? {};
        // I3: when a specific version is requested, verify it exists in releases
        const releases = data.releases ?? {};
        if (version !== undefined) {
            if (!(version in releases)) {
                return { ...degradedSignals(), exists: false };
            }
        }
        // Finding 2: when version is provided, derive publishedAt from the
        // version-specific release record rather than the package-level urls[] array
        // (which reflects the latest release, not the requested version).
        let uploadTime = null;
        if (version !== undefined) {
            const versionFiles = releases[version] ?? [];
            uploadTime =
                versionFiles.length > 0
                    ? versionFiles[0].upload_time_iso_8601 ?? null
                    : null;
        }
        else {
            const urls = data.urls ?? [];
            uploadTime =
                urls.length > 0 ? urls[0].upload_time_iso_8601 ?? null : null;
        }
        const projectUrls = info.project_urls;
        const repoUrl = projectUrls?.['Source'] ??
            projectUrls?.['Homepage'] ??
            info.home_page ??
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
    }
    catch {
        return degradedSignals();
    }
}
async function lookupCrates(name, version) {
    try {
        const resp = await httpsGet(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, 5000);
        if (resp.statusCode === 404)
            return { ...degradedSignals(), exists: false };
        if (resp.statusCode < 200 || resp.statusCode >= 300)
            return degradedSignals();
        const data = JSON.parse(resp.body);
        const krate = data.crate ?? {};
        // I3: when a specific version is requested, verify it exists in versions list
        const versions = data.versions ?? [];
        if (version !== undefined) {
            const found = versions.some((v) => v.num === version);
            if (!found) {
                return { ...degradedSignals(), exists: false };
            }
        }
        const repoUrl = krate.repository ?? null;
        // Finding 2: when version is provided, use the version-specific created_at
        // rather than the package-level crate.created_at (first-ever publish date).
        let created;
        if (version !== undefined) {
            const versionObj = versions.find((v) => v.num === version);
            created = versionObj?.created_at ?? null;
        }
        else {
            created = krate.created_at ?? null;
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
    }
    catch {
        return degradedSignals();
    }
}
const realRegistry = {
    async lookup(ecosystem, name, version) {
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
async function checkPackages({ ecosystem, packages, version }, { registry = realRegistry, clock = Date, thresholds = DEFAULT_THRESHOLDS, slopcheck = null, } = {}) {
    const results = [];
    for (const name of packages) {
        const signals = await registry.lookup(ecosystem, name, version);
        const { verdict: registryVerdict, reasons } = classifyPackage(signals, { thresholds, clock });
        let finalVerdict = registryVerdict;
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
module.exports = { DEFAULT_THRESHOLDS, classifyPackage, checkPackages, _setHttpGet };
