'use strict';

/**
 * Single source of truth for the package name at runtime (#516).
 *
 * Why this exists: the package name `@opengsd/get-shit-done-redux` was
 * hardcoded as a string literal in ~15 runtime .cjs/.js files. When the
 * package is renamed (e.g. to `@opengsd/gsd-core`), changing this one
 * require path propagates the new name everywhere in runtime code.
 *
 * Path: get-shit-done/bin/lib/package-identity.cjs
 * Resolves package.json both in-repo (3 levels up) and when shipped
 * (package root is always 3 dirs above this file).
 */
const pkg = require('../../../package.json');

module.exports = {
  PACKAGE_NAME: pkg.name,
};
