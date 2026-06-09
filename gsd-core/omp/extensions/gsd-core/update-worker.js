'use strict';

const fs = require('node:fs');
const path = require('node:path');

function main() {
  try {
    const cacheFile = process.env.GSD_CACHE_FILE;
    const versionFile = process.env.GSD_VERSION_FILE;
    const configDir = process.env.GSD_CONFIG_DIR;
    if (!cacheFile || !configDir) return;

    let installed = '0.0.0';
    try {
      if (versionFile && fs.existsSync(versionFile)) {
        installed = fs.readFileSync(versionFile, 'utf8').trim() || '0.0.0';
      }
    } catch {}

    const gsdCoreDir = path.join(configDir, 'gsd-core');
    const { isSemverNewer } = require(path.join(gsdCoreDir, 'bin', 'lib', 'semver-compare.cjs'));
    const { checkLatestVersion } = require(path.join(gsdCoreDir, 'bin', 'check-latest-version.cjs'));
    const { PACKAGE_NAME } = require(path.join(gsdCoreDir, 'bin', 'lib', 'package-identity.cjs'));

    let latest = null;
    try {
      const result = checkLatestVersion();
      if (result && result.ok) latest = result.version;
    } catch {}

    const payload = {
      update_available: latest && isSemverNewer(latest, installed),
      installed,
      latest: latest || 'unknown',
      checked: Math.floor(Date.now() / 1000),
      package_name: PACKAGE_NAME,
    };

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(payload));
  } catch {
    // Silent fail — OMP update checks are advisory only.
  }
}

main();
