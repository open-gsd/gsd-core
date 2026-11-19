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

/** Parsed code-review flags. `--all` and `--auto` both imply `--fix`. */
export interface CodeReviewFlags {
  /** true when --fix is present (or implied by --all/--auto) */
  fix: boolean;
  /** true when --all is present (implies fix) */
  all: boolean;
  /** true when --auto is present (implies fix) */
  auto: boolean;
  /** --depth= / --depth <value> override value, or '' if not supplied */
  depth: string;
  /** --files= / --files <value> override value, or '' if not supplied */
  files: string;
}

/** Workflow filename the orchestrator should load. */
export type CodeReviewWorkflow = 'code-review.md' | 'code-review-fix.md';

/**
 * Parse code-review flags from an argv array. The first positional argument
 * (phase number) is ignored — phase validation is handled by
 * `gsd-tools query init.phase-op`. `--files` and `--depth` accept both the
 * `=` form and the space-separated form (`--files a.py,b.py` / `--depth deep`
 * take their value from the next token, #6240); a bare flag with no usable
 * value token throws rather than silently dropping the scope/depth override.
 * Unknown flags are silently ignored.
 */
export function parseCodeReviewFlags(argv: string[]): CodeReviewFlags {
  const flags: CodeReviewFlags = {
    fix: false,
    all: false,
    auto: false,
    depth: '',
    files: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fix') {
      flags.fix = true;
    } else if (arg === '--all') {
      flags.all = true;
    } else if (arg === '--auto') {
      flags.auto = true;
    } else if (arg.startsWith('--depth=')) {
      flags.depth = arg.slice('--depth='.length);
    } else if (arg.startsWith('--files=')) {
      flags.files = arg.slice('--files='.length);
    } else if (arg === '--files' || arg === '--depth') {
      // #6240: the space-separated form consumes the next token as its value.
      // Refuse (never silently drop) when the value is missing or looks like
      // another flag — otherwise the review falls back to a different scope
      // (--files) or a different depth (--depth).
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(
          arg === '--files'
            ? 'Missing value for --files (use --files=<file1,file2> or --files <file1,file2>)'
            : 'Missing value for --depth (use --depth=<value> or --depth <value>)',
        );
      }
      if (arg === '--files') {
        flags.files = value;
      } else {
        flags.depth = value;
      }
      i += 1;
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
export function resolveCodeReviewWorkflow(flags: CodeReviewFlags): CodeReviewWorkflow {
  return flags.fix ? 'code-review-fix.md' : 'code-review.md';
}
