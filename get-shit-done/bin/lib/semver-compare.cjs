'use strict';

function toNumericTuple(input) {
  const cleaned = String(input == null ? '' : input).trim().replace(/^v/, '');
  const base = cleaned.replace(/[-+].*$/, '');
  const parts = base.split('.');
  const major = Number.parseInt(parts[0], 10) || 0;
  const minor = Number.parseInt(parts[1], 10) || 0;
  const patch = Number.parseInt(parts[2], 10) || 0;
  return [major, minor, patch];
}

function compareSemverCore(a, b) {
  const [a0, a1, a2] = toNumericTuple(a);
  const [b0, b1, b2] = toNumericTuple(b);
  if (a0 !== b0) return a0 > b0 ? 1 : -1;
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  if (a2 !== b2) return a2 > b2 ? 1 : -1;
  return 0;
}

function isSemverNewer(a, b) {
  return compareSemverCore(a, b) > 0;
}

function isStableTripletSemver(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v || '').replace(/^v/, ''));
}

module.exports = {
  compareSemverCore,
  isSemverNewer,
  isStableTripletSemver,
  toNumericTuple,
};
