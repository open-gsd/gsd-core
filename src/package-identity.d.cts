/**
 * Type declaration for package-identity.cjs — permanently hand-written,
 * not migrated per ADR-457. This .d.cts file allows strict TypeScript
 * sources (src/*.cts) to import it under nodenext moduleResolution.
 *
 * The module exports an Object.freeze()-sealed object; all exports are
 * constant strings / a function. Mirror the exact module.exports shape
 * from package-identity.cjs as named exports.
 */

export declare const packageName: string;
export declare const PACKAGE_NAME: string;
export declare const binName: string;
export declare const repoSlug: string;
export declare const repoUrl: string;
export declare const changelogRawUrl: string;
export declare function manualInstallCommand(opts?: { scope?: string; runtime?: string }): string;
