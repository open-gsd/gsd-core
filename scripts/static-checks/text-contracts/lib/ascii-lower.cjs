'use strict';

// ASCII-only lower-casing: the contracts that read a phrase the way a case-insensitive pattern did (for ASCII) share it.
const asciiLower = (text) => text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));

module.exports = { asciiLower };
