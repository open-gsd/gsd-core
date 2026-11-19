"use strict";
/**
 * SPEC section-status helper — the SINGLE source of truth for "did the phase SPEC supply
 * section X (with at least one resolved row)?".
 *
 * Consumed by `plan-phase` step 7.95 (the spec-less probe fallback) to decide, per section,
 * whether to run the fallback. Previously this lived as ad-hoc `awk` in the workflow body, which
 * (1) hard-coded the section header strings at the call site and (2) hand-rolled markdown-table
 * row counting — a brittleness that produced two bugs: an exact `^## Prohibitions$` anchor that
 * missed the canonical `## Prohibitions (must-NOT)` heading, and a single-table row-counting
 * assumption. Centralising the header matchers + the counting here makes the knowledge testable
 * and shared (any future SPEC-section consumer reuses it instead of re-parsing markdown).
 *
 * Authored as strict TypeScript (`src/spec-section.cts`) and compiled by
 * `tsc -p tsconfig.build.json` to the gitignored runtime artifact
 * `gsd-core/bin/lib/spec-section.cjs`. Do NOT hand-write the `.cjs`; it is emitted. Tests
 * `require()` the built artifact; `pretest` runs `build:lib`.
 *
 * Pure and dependency-free.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECTION_HEADERS = void 0;
exports.countSectionDataRows = countSectionDataRows;
exports.specSectionStatus = specSectionStatus;
const node_fs_1 = __importDefault(require("node:fs"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cliExitModule = require("./cli-exit.cjs");
const { ExitError, runMain } = cliExitModule;
/**
 * Canonical SPEC section header matchers — the SINGLE source of truth for the headings
 * `templates/spec.md` renders. Suffix-tolerant by design: `prohibitions` matches BOTH
 * `## Prohibitions` and `## Prohibitions (must-NOT)`; `edges` matches `## Edge Coverage`
 * (and any future parenthetical suffix). If spec-phase renames a heading, update HERE and the
 * spec.md template together — the contract is pinned by `tests/spec-section.test.cjs`.
 */
exports.SECTION_HEADERS = {
    edges: /^##[ \t]+Edge Coverage([ \t]|\(|$)/,
    prohibitions: /^##[ \t]+Prohibitions([ \t]|\(|$)/,
};
const ANY_H2 = /^##[ \t]/;
const TABLE_LINE = /^\|/;
// Separator row of a markdown table: |---|, |:--|, | :---: |, etc.
const SEPARATOR = /^\|[ \t]*:?-{2,}/;
/**
 * Count markdown table DATA rows inside the named section. A data row is a `|…|` line that
 * follows the table's `|---|` separator; the `|…|` line BEFORE the separator is the table header
 * row and is not counted. Blank or prose lines reset the per-table state, so a section containing
 * multiple tables (or prose between tables) counts every table's data rows without miscounting a
 * second table's header — more robust than the single-table awk it replaces.
 */
function countSectionDataRows(specText, key) {
    const header = exports.SECTION_HEADERS[key];
    let inSection = false;
    let present = false;
    let afterSeparator = false;
    let dataRows = 0;
    for (const line of specText.split(/\r?\n/)) {
        if (ANY_H2.test(line)) {
            inSection = header.test(line);
            if (inSection)
                present = true;
            afterSeparator = false;
            continue;
        }
        if (!inSection)
            continue;
        if (TABLE_LINE.test(line)) {
            if (SEPARATOR.test(line)) {
                afterSeparator = true; // the next |…| lines are data rows
            }
            else if (afterSeparator) {
                dataRows++;
            }
            // a |…| line before any separator is the table header row -> not counted
        }
        else {
            // blank or prose line ends the current table; a later table re-arms on its own separator
            afterSeparator = false;
        }
    }
    return { present, dataRows };
}
/**
 * Resolve a SPEC file's section status from disk. A missing/unreadable file is reported as
 * not present (so the fallback fires) rather than throwing.
 */
function specSectionStatus(specFile, key) {
    let text;
    try {
        text = node_fs_1.default.readFileSync(specFile, 'utf8');
    }
    catch {
        return { key, present: false, dataRows: 0, supplied: false };
    }
    const { present, dataRows } = countSectionDataRows(text, key);
    return { key, present, dataRows, supplied: present && dataRows > 0 };
}
const VALID_KEYS = ['edges', 'prohibitions'];
// CLI: `node spec-section.cjs <specFile> <edges|prohibitions>` -> prints SectionStatus JSON.
// Exit 0 on success (even when the file is absent — that is a valid "not supplied" answer); exit
// 2 only on a usage error (missing args / bad key). `require.main === module` so it runs only when
// the compiled `.cjs` is executed directly, never when imported by tests.
if (require.main === module) {
    runMain(() => {
        const specFile = process.argv[2];
        const key = process.argv[3];
        if (!specFile || !key || !VALID_KEYS.includes(key)) {
            process.stderr.write('usage: spec-section.cjs <specFile> <edges|prohibitions>\n');
            throw new ExitError(2);
        }
        process.stdout.write(JSON.stringify(specSectionStatus(specFile, key)) + '\n');
    });
}
