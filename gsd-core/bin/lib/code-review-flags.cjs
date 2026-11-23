"use strict";
/**
 * Typed flag parser for the /gsd:code-review command (ADR-457 build-at-publish:
 * the hand-written bin/lib/code-review-flags.cjs collapsed to a TypeScript
 * source of truth). Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 *
 * This is the canonical IR for code-review argument parsing. The workflow
 * (code-review.md) delegates flag dispatch to this module so that tests assert
 * on a structured IR rather than rendered bash text, and the dispatch decision
 * is testable without instantiating the workflow.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCodeReviewFlags = parseCodeReviewFlags;
exports.resolveCodeReviewWorkflow = resolveCodeReviewWorkflow;
/**
 * Parse code-review flags from an argv array. The first positional argument
 * (phase number) is ignored — phase validation is handled by
 * `gsd-tools query init.phase-op`. Unknown flags are silently ignored.
 */
function parseCodeReviewFlags(argv) {
    const flags = {
        fix: false,
        all: false,
        auto: false,
        depth: '',
        files: '',
    };
    for (const arg of argv) {
        if (arg === '--fix') {
            flags.fix = true;
        }
        else if (arg === '--all') {
            flags.all = true;
        }
        else if (arg === '--auto') {
            flags.auto = true;
        }
        else if (arg.startsWith('--depth=')) {
            flags.depth = arg.slice('--depth='.length);
        }
        else if (arg.startsWith('--files=')) {
            flags.files = arg.slice('--files='.length);
        }
    }
    // --all and --auto imply --fix
    if (flags.all || flags.auto) {
        flags.fix = true;
    }
    return flags;
}
/**
 * Determine which workflow to dispatch based on parsed flags:
 *  - 'code-review-fix.md' when fix=true (--fix, --all, or --auto present)
 *  - 'code-review.md'     otherwise (review-only pass)
 */
function resolveCodeReviewWorkflow(flags) {
    return flags.fix ? 'code-review-fix.md' : 'code-review.md';
}
