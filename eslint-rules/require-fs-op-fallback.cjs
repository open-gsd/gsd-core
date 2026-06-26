'use strict';

/**
 * require-fs-op-fallback
 *
 * Flag: a bare fs.rename / fs.renameSync call (the atomic-publish primitive
 * named first in DEFECT.WINDOWS-FS-OPS.symptom) that is NOT either:
 *
 *   (a) inside a try/catch whose catch handler BOTH references a transient
 *       errno ('EPERM' / 'EBUSY' / 'EACCES', literally OR via a *RETRY_ERRNOS-
 *       style set identifier) AND carries a retry signal (a loop `continue`
 *       backedge or a `return <call>` delegation — NOT a bare rethrow: the
 *       defect's cure is retry/fallback, not just errno recognition), OR
 *   (b) control-dependent on a Windows platform guard
 *       (process.platform !== 'win32' / early-return — isWindowsExcludedNode).
 *
 * The canonical defect: on Windows, when an antivirus scanner, indexer, or
 * concurrent reader transiently holds the target open, fs.renameSync throws
 * EPERM/EBUSY/EACCES. A bare renameSync (or one wrapped in a try/catch that
 * only cleans up + rethrows without distinguishing the transient errno) fails
 * on the windows-latest CI lane where macOS/Linux CI passed — the established
 * cure is the RENAME_RETRY_ERRNOS = new Set(['EPERM','EBUSY','EACCES']) retry
 * loop already present in five production modules.
 *
 * "never silently swallow": a catch (e) {} or catch (_) {} with no transient-
 * errno reference does NOT satisfy the defect's fix-forward and is still
 * flagged. The fix is to add the bounded retry (the RENAME_RETRY_ERRNOS
 * pattern) or gate behind a Windows platform check.
 *
 * copyFile / unlink are deliberately NOT flagged: per the defect's own
 * .fix-forward ("catch EPERM/EBUSY/EACCES, fall back to copy + unlink with
 * retry") they are the FALLBACK PRIMITIVES, not separate defect sites, and
 * unlink has many intentional best-effort try/catch-swallow cleanup sites.
 *
 * References:
 *   DEFECT.WINDOWS-FS-OPS (CONTEXT.md)
 *   ADR-1703 (docs/adr/1703-portability-enforcement-architecture.md)
 *   issue #1740 (scope note: rename-only v1)
 *
 * Message:
 *   Cite DEFECT.WINDOWS-FS-OPS: fs.renameSync can throw EPERM/EBUSY/EACCES on
 *   Windows when a reader/AV transiently holds the target. Wrap in a bounded
 *   retry on the transient errno (the RENAME_RETRY_ERRNOS pattern) or gate
 *   behind a Windows platform check.
 *
 * ── Known boundaries ─────────────────────────────────────────────────────────
 *
 * (a) Name-based matching only. The rule recognizes `fs.rename` / `fs.renameSync`
 *     by spelling (MemberExpression: object=Identifier{fs}). A bare
 *     `renameSync(...)` call (when `fs` is destructured or the function is
 *     imported bare) is NOT matched — the production survey showed 100%
 *     `fs.renameSync` dotted usage, so dotted-only is the v1 shape.
 *
 * (b) Retry delegated to a helper function is NOT statically traceable. A
 *     bare `fs.renameSync` inside `atomicRenameWithRetry` IS detected as
 *     compliant because that helper wraps it in its own try/catch with the
 *     RENAME_RETRY_ERRNOS reference — but a call site that delegates via
 *     `atomicRenameWithRetry(tmp, target)` (calling the helper, no bare
 *     renameSync at the call site) has nothing to flag in the first place.
 *
 * (c) The catch-handler errno check is a subtree scan for transient-errno
 *     string literals OR *RETRY_ERRNOS identifiers. A catch that builds the
 *     errno set from a non-literal source (e.g. reading from config) is not
 *     recognized — the established convention is a module-level Set literal.
 */

const { isWindowsExcludedNode } = require('./lib/platform-guard.cjs');

// fs mutation methods that are the atomic-publish transient-lock primitives.
const RENAME_METHODS = new Set(['rename', 'renameSync']);

// Transient Windows lock errnos (the DEFECT.WINDOWS-FS-OPS.fix-forward set).
const TRANSIENT_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Recognize retry-errno set identifiers by naming convention, e.g.
// RENAME_RETRY_ERRNOS, WRITE_RETRY_ERRNOS. Matches the established pattern
// across capability-ledger / capability-consent / shell-command-projection.
const RETRY_ERRNO_SET_NAME_RE = /RETRY_ERRNOS$/;

/**
 * True if `node` is an `fs.rename` / `fs.renameSync` CallExpression.
 */
function isFsRenameCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'fs' &&
    callee.property.type === 'Identifier' &&
    RENAME_METHODS.has(callee.property.name)
  ) {
    return true;
  }
  return false;
}

/**
 * Walk a catch-clause subtree looking for evidence the handler distinguishes
 * a transient errno. Recognized evidence:
 *   - a string Literal whose value is in TRANSIENT_ERRNOS ('EPERM'/'EBUSY'/'EACCES')
 *   - an Identifier (or MemberExpression object) whose name matches RETRY_ERRNO_SET_NAME_RE
 *
 * Skips `parent`/`tokens`/`comments` keys to avoid cycles.
 */
function catchHandlerReferencesTransientErrno(handlerNode) {
  if (!handlerNode || typeof handlerNode !== 'object') return false;
  // The CatchClause node has { type, param, body, parent }. Inspect body
  // (and param name — not needed, but walk body subtree).
  const seen = new WeakSet();
  function walk(n) {
    if (!n || typeof n !== 'object') return false;
    if (seen.has(n)) return false;
    seen.add(n);

    // String literal errno: 'EPERM' / 'EBUSY' / 'EACCES'
    if (n.type === 'Literal' && typeof n.value === 'string' && TRANSIENT_ERRNOS.has(n.value)) {
      return true;
    }
    // *RETRY_ERRNOS identifier (bare or as a MemberExpression object)
    if (n.type === 'Identifier' && RETRY_ERRNO_SET_NAME_RE.test(n.name)) {
      return true;
    }

    for (const key of Object.keys(n)) {
      if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            if (walk(item)) return true;
          }
        }
      } else if (child && typeof child === 'object' && child.type) {
        if (walk(child)) return true;
      }
    }
    return false;
  }
  return walk(handlerNode);
}

/**
 * True when `handlerNode` (a CatchClause) contains a RETRY SIGNAL — evidence the
 * catch actually re-attempts the rename rather than merely observing the errno.
 *
 * Recognized retry signals:
 *   - ContinueStatement          — a loop backedge (`for { try{rename}catch{continue} }`)
 *   - ReturnStatement whose argument is a CallExpression — delegation
 *                                  (`return retry()`, `return atomicRenameWithRetry(...)`)
 *
 * This closes the "errno-check-then-rethrow" false-negative: a catch like
 * `catch (e) { if (e.code === 'EPERM') throw e; throw e; }` references the
 * errno but never retries, so it still fails on Windows transient locks. The
 * DEFECT.WINDOWS-FS-OPS fix-forward requires retry/fallback, not just recognition.
 *
 * Skips `parent`/`tokens`/`comments` keys to avoid cycles.
 */
function catchHandlerHasRetrySignal(handlerNode) {
  if (!handlerNode || typeof handlerNode !== 'object') return false;
  const seen = new WeakSet();
  function walk(n) {
    if (!n || typeof n !== 'object') return false;
    if (seen.has(n)) return false;
    seen.add(n);
    // Loop backedge: `continue` re-enters the enclosing retry loop.
    if (n.type === 'ContinueStatement') return true;
    // Delegation: `return retry()` / `return atomicRenameWithRetry(...)` hands
    // the rename off to a helper that performs its own bounded retry.
    if (
      n.type === 'ReturnStatement' &&
      n.argument != null &&
      n.argument.type === 'CallExpression'
    ) {
      return true;
    }
    for (const key of Object.keys(n)) {
      if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            if (walk(item)) return true;
          }
        }
      } else if (child && typeof child === 'object' && child.type) {
        if (walk(child)) return true;
      }
    }
    return false;
  }
  return walk(handlerNode);
}

/**
 * True when `renameNode` is protected by a transient-errno retry: i.e. the
 * NEAREST enclosing TryStatement WITH A CATCH HANDLER whose `block` contains
 * the rename has a handler that BOTH references a transient errno AND carries a
 * retry signal (loop backedge or delegation return).
 *
 * Walks bottom-up and STOPS at the first TryStatement that (a) contains the
 * rename in its `block` and (b) has a `handler`. A try with only a `finally`
 * (no handler) does not intercept the rename error — it is skipped and the
 * climb continues. The nearest catching try is where the rename's error lands;
 * an outer catch is UNREACHABLE once the nearest catch intercepts (it may
 * swallow, transform, or rethrow-as-other), so walking past it would be
 * unsound (a false negative — see the nested-try case). An errno reference
 * alone is insufficient; the handler must also retry (see catchHandlerHasRetrySignal).
 */
function isInsideTransientErrnoTryCatch(renameNode, sourceCode) {
  const ancestors = _getAncestors(renameNode, sourceCode);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const anc = ancestors[i];
    if (anc.type !== 'TryStatement') continue;
    if (!_containsNode(anc.block, renameNode)) continue;
    if (!anc.handler) continue; // try-finally: error propagates, keep climbing
    // Nearest catching try found — its handler is authoritative. An outer
    // catch cannot protect the rename if this one intercepts first.
    return (
      catchHandlerReferencesTransientErrno(anc.handler) &&
      catchHandlerHasRetrySignal(anc.handler)
    );
  }
  return false;
}

// ── AST traversal helpers (mirror platform-guard.cjs internals) ──────────────

function _getAncestors(node, sourceCode) {
  if (sourceCode && typeof sourceCode.getAncestors === 'function') {
    try {
      return sourceCode.getAncestors(node);
    } catch (_) {
      // fall through to manual walk
    }
  }
  return _findAncestors(sourceCode.ast, node);
}

function _findAncestors(root, target) {
  const chain = [];
  function walk(node, ancestors) {
    if (!node || typeof node !== 'object') return false;
    if (node === target) {
      chain.push(...ancestors);
      return true;
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            if (walk(item, [...ancestors, node])) return true;
          }
        }
      } else if (child && typeof child === 'object' && child.type) {
        if (walk(child, [...ancestors, node])) return true;
      }
    }
    return false;
  }
  walk(root, []);
  return chain;
}

function _containsNode(container, target) {
  if (!container || typeof container !== 'object') return false;
  if (container === target) return true;
  const seen = new WeakSet();
  function walk(n) {
    if (!n || typeof n !== 'object') return false;
    if (seen.has(n)) return false;
    seen.add(n);
    if (n === target) return true;
    for (const key of Object.keys(n)) {
      if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            if (walk(item)) return true;
          }
        }
      } else if (child && typeof child === 'object' && child.type) {
        if (walk(child)) return true;
      }
    }
    return false;
  }
  return walk(container);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require fs.rename/fs.renameSync to carry a transient-errno fallback (EPERM/EBUSY/EACCES) ' +
        'or a Windows platform guard (DEFECT.WINDOWS-FS-OPS)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      requireFsOpFallback:
        'Unguarded fs.rename/fs.renameSync: on Windows a concurrent reader or antivirus scanner ' +
        'can transiently hold the target open, throwing EPERM/EBUSY/EACCES ' +
        '(DEFECT.WINDOWS-FS-OPS). Wrap in a bounded retry on the transient errno ' +
        "(the RENAME_RETRY_ERRNOS = new Set(['EPERM','EBUSY','EACCES']) pattern) " +
        "or gate behind if (process.platform !== 'win32').",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CallExpression(node) {
        if (!isFsRenameCall(node)) return;

        // (a) inside a try/catch whose catch handles a transient errno
        if (isInsideTransientErrnoTryCatch(node, sourceCode)) return;

        // (b) control-dependent on a Windows platform guard
        if (isWindowsExcludedNode(node, sourceCode)) return;

        // Otherwise: unguarded atomic-publish rename — report.
        context.report({ node, messageId: 'requireFsOpFallback' });
      },
    };
  },
};

module.exports = rule;
