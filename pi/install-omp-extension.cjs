'use strict';

/**
 * Installs the GSD bridge into OMP's native extension discovery directory.
 *
 * Usage: node pi/install-omp-extension.cjs [destination]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourcePath = path.resolve(__dirname, 'gsd.cjs');
const destination = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent'), 'extensions', 'gsd-omp.ts');

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `import gsdPiExtension from ${JSON.stringify(sourcePath)};\n\nexport default gsdPiExtension;\n`);
process.stdout.write(JSON.stringify({ destination, sourcePath }) + '\n');
