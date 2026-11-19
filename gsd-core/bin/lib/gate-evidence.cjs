"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.evidenceFound = evidenceFound;
exports.evidenceNone = evidenceNone;
exports.evidenceUnreadable = evidenceUnreadable;
exports.evidenceFromError = evidenceFromError;
exports.readTextEvidence = readTextEvidence;
exports.readDirEvidence = readDirEvidence;
exports.readDirEntriesEvidence = readDirEntriesEvidence;
exports.statEvidence = statEvidence;
exports.readPlanScanEvidence = readPlanScanEvidence;
exports.readPlanSetEvidence = readPlanSetEvidence;
exports.verdictFromEvidence = verdictFromEvidence;
/**
 * Gate evidence — what a gate found when it looked (#5170, epic #5056, ADR-5057 §4 third bullet).
 *
 * A gate that reads a file or directory has THREE answers, not two:
 *
 *   - `found`       the evidence is there; `value` is what was read (an empty file is `found ''`).
 *   - `none`        the evidence authoritatively does not exist (`ENOENT`, or `ENOTDIR` because a
 *                   parent component is not a directory, so the path cannot exist). Each gate keeps
 *                   its own documented policy for `none`.
 *   - `unreadable`  the evidence may exist but could not be read (`EISDIR`, `EACCES`, `EIO`, an
 *                   encoding failure ...). `reason` carries the errno code (or the message when
 *                   the failure had none); `span` names what was being read.
 *
 * `unreadable` is never `''`, `false` or an empty list: a tolerant reader that collapses it into
 * "nothing there" lets a gate pass over content it never saw. `verdictFromEvidence` is the one way
 * a gate maps evidence to a verdict, and its `unreadable` arm is typed to return an
 * `UnreadableVerdict`, so a passing verdict from that arm does not type-check.
 *
 * `fs` is reached as a namespace object at call time, never destructured at load, so a test can
 * inject a read failure by replacing the method.
 */
const node_fs_1 = __importDefault(require("node:fs"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planScanMod = require("./plan-scan.cjs");
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningScopeMod = require("./planning-scope.cjs");
const { SCOPE } = planningScopeMod;
function evidenceFound(value) {
    return { kind: 'found', value };
}
function evidenceNone() {
    return { kind: 'none' };
}
function evidenceUnreadable(reason, span) {
    return span === undefined ? { kind: 'unreadable', reason } : { kind: 'unreadable', reason, span };
}
/** Errno codes meaning "the path cannot hold evidence": absent, or a parent is not a directory. */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
/**
 * Classify a thrown read failure as evidence: absent (`ENOENT`/`ENOTDIR`) is `none`, anything else
 * is `unreadable` carrying the errno code (or the message when there was none). A gate that wraps a
 * lookup it does not own (a locator, a roadmap reader) in `try` uses this instead of a bare `catch`.
 */
function evidenceFromError(err, span) {
    return classifyFailure(err, span);
}
function classifyFailure(err, span) {
    const code = err?.code;
    if (typeof code === 'string' && ABSENT_CODES.has(code))
        return evidenceNone();
    if (typeof code === 'string' && code.length > 0)
        return evidenceUnreadable(code, span);
    const message = err instanceof Error ? err.message : String(err);
    return evidenceUnreadable(message.length > 0 ? message : 'unknown read failure', span);
}
/** Read a UTF-8 file as evidence. Never throws. */
function readTextEvidence(filePath) {
    try {
        return evidenceFound(node_fs_1.default.readFileSync(filePath, 'utf8'));
    }
    catch (err) {
        return classifyFailure(err, filePath);
    }
}
/** Read a directory's entry names as evidence. Never throws. */
function readDirEvidence(dirPath) {
    try {
        return evidenceFound(node_fs_1.default.readdirSync(dirPath));
    }
    catch (err) {
        return classifyFailure(err, dirPath);
    }
}
/** Read a directory's entries (with types) as evidence. Never throws. */
function readDirEntriesEvidence(dirPath) {
    try {
        return evidenceFound(node_fs_1.default.readdirSync(dirPath, { withFileTypes: true }));
    }
    catch (err) {
        return classifyFailure(err, dirPath);
    }
}
/** Stat a path (following symlinks) as evidence. Never throws. */
function statEvidence(targetPath) {
    try {
        return evidenceFound(node_fs_1.default.statSync(targetPath));
    }
    catch (err) {
        return classifyFailure(err, targetPath);
    }
}
/**
 * The canonical plan set of a phase directory that is known to exist, as evidence (#5170). Only the
 * scan's `SCOPE.COMPLETE` is a real answer: `TRUNCATED` (an existing nested `plans/` that could not be
 * read), `UNREADABLE` and `UNSCOPED` mean the scan did not see every plan, so a short or empty list is
 * `unreadable` and never "no plans". Every gate that gets its plans from `scanPhasePlans` goes through
 * this one reader.
 */
function readPlanScanEvidence(phaseDir) {
    const scan = scanPhasePlans(phaseDir);
    if (scan.scope !== SCOPE.COMPLETE) {
        return { kind: 'unreadable', reason: `plan scan ${scan.scope}`, span: phaseDir };
    }
    return evidenceFound({ planFiles: [...scan.planFiles], summaryFiles: [...scan.summaryFiles] });
}
/** The plan half of {@link readPlanScanEvidence}. */
function readPlanSetEvidence(phaseDir) {
    const scan = readPlanScanEvidence(phaseDir);
    return scan.kind === 'unreadable' ? scan : evidenceFound(scan.value.planFiles);
}
/** Map evidence to a verdict. Total over the three kinds. */
function verdictFromEvidence(evidence, arms) {
    switch (evidence.kind) {
        case 'found':
            return arms.found(evidence.value);
        case 'none':
            return arms.none();
        case 'unreadable':
            return arms.unreadable(evidence.reason, evidence.span);
    }
}
