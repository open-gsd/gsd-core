"use strict";
/**
 * Secrets handling — masking convention for API keys and other
 * credentials managed via /gsd-settings-integrations (ADR-457 build-at-publish:
 * the hand-written bin/lib/secrets.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * This module does not read the filesystem.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECRET_CONFIG_KEYS = void 0;
exports.isSecretKey = isSecretKey;
exports.maskSecret = maskSecret;
exports.maskIfSecret = maskIfSecret;
exports.SECRET_CONFIG_KEYS = new Set([
    'brave_search',
    'firecrawl',
    'exa_search',
]);
function isSecretKey(keyPath) {
    return exports.SECRET_CONFIG_KEYS.has(keyPath);
}
function maskSecret(value) {
    if (value === null || value === undefined || value === '')
        return '(unset)';
    const s = String(value);
    if (s.length < 8)
        return '****';
    return '****' + s.slice(-4);
}
function maskIfSecret(keyPath, value) {
    return isSecretKey(keyPath) ? maskSecret(value) : value;
}
