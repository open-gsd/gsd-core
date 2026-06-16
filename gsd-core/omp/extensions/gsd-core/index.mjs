import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const extension = require('./index.js');

export default extension;
