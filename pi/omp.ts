/**
 * OMP loads TypeScript extension entries as ESM. Keep the proven legacy Pi
 * bridge in CommonJS and export it through OMP's native module contract.
 */
const gsdPiExtension = require('./gsd.cjs');

export default (pi: unknown) => gsdPiExtension(pi, { runtime: 'omp' });
