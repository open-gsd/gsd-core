'use strict';
// hooks/lib/config-read.js — the one bounded reader for a project config.json used by every
// hook (#5759). Hooks are standalone files staged at install, so this mirrors the built
// gsd-core/bin/lib/config-file-read.cjs (a test pins that the two caps agree) instead of
// requiring it.
//
// A config.json planted as a FIFO or device blocks a plain readFileSync forever, and a hook
// runs inside the user's session on every tool call. The file is opened non-blocking and
// checked through its own descriptor (O_NONBLOCK is absent on Windows, hence `|| 0`).
const fs = require('node:fs');

const CONFIG_MAX_BYTES = 1024 * 1024;

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * The UTF-8 text of `file`. A file that is absent returns null, or — with `{ required: true }` —
 * throws an error with code ENOENT, so a caller that already treats any throw as "no usable
 * config" keeps its exact semantics. A FIFO/device (ENXIO), directory (EISDIR), file over
 * CONFIG_MAX_BYTES (EFBIG) or any other failure always throws with `.code` set.
 */
function readConfigFileBounded(file, options) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOCTTY || 0));
  } catch (err) {
    if (err && err.code === 'ENOENT' && !(options && options.required)) return null;
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw coded(`${file} is not a regular file`, st.isDirectory() ? 'EISDIR' : 'ENXIO');
    if (st.size > CONFIG_MAX_BYTES) throw coded(`${file} exceeds ${CONFIG_MAX_BYTES} bytes`, 'EFBIG');
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.toString('utf8', 0, off);
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* already closed */ }
  }
}

module.exports = { CONFIG_MAX_BYTES, readConfigFileBounded };
