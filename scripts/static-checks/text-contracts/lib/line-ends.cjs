'use strict';

// The characters a multiline `^` or `$` and a dot treat as a line end: LF, CR, U+2028 and U+2029.
const LINE_ENDS = new Set(['\n', '\r', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]);

module.exports = { LINE_ENDS };
