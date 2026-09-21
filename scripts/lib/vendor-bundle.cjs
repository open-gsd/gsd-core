'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { buildSync } = require('esbuild');

/** Rebuild locked upstream code without edits; installed trees need no node_modules. */
function buildVendorBundle(root, entry) {
  const result = buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    write: false,
    metafile: true,
    legalComments: 'inline',
    banner: { js: '// Generated from locked npm dependencies by lint-vendored-deps.cjs --fix. Do not edit.' },
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !isBuiltin(imported.path)) {
        throw new Error(`Vendor bundle has an external dependency: ${imported.path}`);
      }
    }
  }
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    let dir = path.dirname(path.resolve(root, input));
    while (dir !== root && dir !== path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name && pkg.version) {
          const licenses = fs.readdirSync(dir).filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name)).sort();
          // saxes 6.0.0 omits its LICENSE from npm; preserve the exact tagged
          // upstream file (https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE).
          const supplemental = path.join(__dirname, 'vendor-licenses', `${pkg.name}-${pkg.version}.txt`);
          if (licenses.length === 0 && !fs.existsSync(supplemental)) throw new Error(`Missing upstream license: ${pkg.name}`);
          packages.set(`${pkg.name}@${pkg.version}`, [
            `${pkg.name}@${pkg.version} (package metadata: ${pkg.license})`,
            ...licenses.map((name) => `${name}:\n${fs.readFileSync(path.join(dir, name), 'utf8')}`),
            ...(licenses.length === 0 ? [fs.readFileSync(supplemental, 'utf8')] : []),
          ].join('\n\n'));
          break;
        }
      }
      dir = path.dirname(dir);
    }
  }
  return {
    code: result.outputFiles[0].contents,
    notices: Buffer.from([...packages.keys()].sort().map((name) => packages.get(name)).join('\n\n---\n\n') + '\n'),
  };
}

module.exports = { buildVendorBundle };
