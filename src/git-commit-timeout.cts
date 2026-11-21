/**
 * #5231: the one owner of the `git.commit_timeout_ms` rule and default. `config-set` validates with
 * `isValidCommitTimeoutMs`, the commit sites read with `commitTimeoutMs`, and `SCHEMA_DEFAULTS` plus
 * `config-defaults.manifest.json` carry `COMMIT_TIMEOUT_DEFAULT_MS` (a parity test pins the manifest).
 */

/** Default `git commit` timeout: pre-commit hooks routinely outlast the 10s plumbing default (#3886). */
export const COMMIT_TIMEOUT_DEFAULT_MS = 30_000;

/** Ceiling (1 h): `.planning/config.json` is repo-controlled, so an unbounded value would remove the subprocess bound. */
export const COMMIT_TIMEOUT_MAX_MS = 3_600_000;

/** An integer in [1, COMMIT_TIMEOUT_MAX_MS]; spawnSync throws on fractions and misreads values past 2^31-1. */
export function isValidCommitTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= COMMIT_TIMEOUT_MAX_MS;
}

/** The configured timeout when valid, else the default. */
export function commitTimeoutMs(configValue: unknown): number {
  return isValidCommitTimeoutMs(configValue) ? configValue : COMMIT_TIMEOUT_DEFAULT_MS;
}
