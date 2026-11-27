'use strict';

// A shipped library through `load`, or the reason it cannot be loaded: a missing build is a finding for that library,
// not a throw that ends the contract. The loader is a parameter so a test can hand in one that throws.
function loadLib(load, file) {
  try {
    return { lib: load() };
  } catch (err) {
    return { error: `${file} cannot be loaded: ${err.message}` };
  }
}

module.exports = { loadLib };
