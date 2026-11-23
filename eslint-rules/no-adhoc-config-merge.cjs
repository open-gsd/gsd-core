'use strict';

const path = require('path');

/**
 * no-adhoc-config-merge
 *
 * Epic #4633 (ADR-1411, Decision 5) gave configuration layer resolution one
 * owner: `resolveConfigValue` in `src/config-value-resolver.cts` returns the
 * value AND the layer that produced it, and `src/config-loader.cts` owns the
 * loader's deep merge. Four hand-rolled precedence copies had accumulated before
 * that (#4071, #4090). This rule is the anti-divergence guard: a fifth copy fails
 * lint instead of shipping.
 *
 * It flags two shapes outside the resolver boundary.
 *
 * ## Shape (a) — `layerPathRead`: reading a configuration layer file
 *
 * Constructing the path of a layer file and reading it:
 *   - `path.join(…, '.gsd', 'defaults.json')`                (global defaults)
 *   - `path.join(planningDir(…) | planningRoot(…), 'config.json')`,
 *     `path.join(…, '.planning', 'config.json')`             (project / workstream)
 *   - `path.join(…, '.claude', 'settings.json' | 'settings.local.json')`
 *
 * A construction is a READ unless every use of its value is a write or a probe.
 * Write and probe sites parse or stat without merging, so they never match, and
 * the ADR keeps them out of the allowlist ("rule shape, not allowlist entry"):
 *   - an argument of a probe or write call (`existsSync`, `statSync`,
 *     `writeFileSync`, `renameSync`, `mkdirSync`, `unlinkSync`, …);
 *   - a value that is only reported (an object property value, e.g.
 *     `config_path: …`) or compared (`===`), optionally wrapped by `toPosixPath`.
 * A RETURNED path is not exempt: a local `function cfgPath() { return join(…) }` would be a
 * fifth copy of the layer location wearing a helper's name. The helpers live in the boundary.
 * Anything else — an argument of a reader, an element pushed into a candidate
 * list, an unknown call — is a read and is flagged, so an unfamiliar consumer
 * fails closed rather than slipping through.
 *
 * ## Shape (b) — `configSpreadMerge`: spread-merging two parsed config objects
 *
 * `{ ...globalCfg, ...projectCfg }` and `Object.assign({}, globalCfg, projectCfg)`
 * where at least two operands are config objects: an identifier or member chain
 * whose name says so (`config`, `cfg`, `defaults`, `settings`), or a direct
 * `JSON.parse(…)` / `loadConfig(…)` / `readConfig…(…)` call. A spread of one
 * config over a literal of defaults is a single-source copy, not a precedence
 * merge, and is not flagged.
 *
 * ## Boundary and exemptions
 *
 * Two kinds, kept apart and not interchangeable (ADR-1411 Decision 5):
 *   - `resolverInternal` — permanent. `src/config-value-resolver.cts` and
 *     `src/config-loader.cts` ARE the boundary and are exempt by construction.
 *   - `temporary` — migration exemptions, each removed by the child that adopts
 *     the owner there. The list is empty at the end of epic #4633 and stays
 *     empty. An entry whose file no longer offends reports `staleAllowlistEntry`
 *     so a list can only shrink (scripts/lib/allowlist-ratchet.cjs validates it
 *     by identity in tests/no-adhoc-config-merge.allowlist.test.cjs).
 *
 * A one-line justified holdout can carry a trailing same-line
 * `// allow-adhoc-config-merge: <reason>` comment; the reason is mandatory.
 *
 * ## Known gaps
 *
 * The rule recognizes literal path segments, not computed ones: a layer path
 * assembled from a variable segment (`join(dir, name)` with `name = 'config.json'`)
 * is not seen. It raises the cost of the accidental copy — the failure observed
 * four times — it does not prove no copy exists.
 */

const JOIN_NAMES = new Set(['join', 'resolve']);
const PLANNING_CALLS = new Set(['planningDir', 'planningRoot']);

/** Calls that only stat: a layer path handed to one is a probe, not a read. */
const PROBE_CALLS = new Set(['existsSync', 'statSync', 'lstatSync', 'accessSync', 'access', 'stat', 'lstat', 'exists']);

/**
 * Calls that mutate a file. A layer path that reaches one is a WRITE site, including a
 * read-modify-write setter: it parses to change a value, never to resolve one.
 */
const WRITE_CALLS = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'renameSync',
  'rename',
  'mkdirSync',
  'mkdir',
  'unlinkSync',
  'unlink',
  'rmSync',
  'rm',
  'copyFileSync',
  'atomicWriteFileSync',
]);
const PROBE_OR_WRITE_CALLS = new Set([...PROBE_CALLS, ...WRITE_CALLS]);

/** Wrappers that only reshape a path string; the use that matters is outside. */
const PATH_WRAPPERS = new Set(['toPosixPath', 'normalize', 'relative', 'basename', 'dirname']);

/** A helper named like a write (`platformWriteSync`, `writeJsonAtomic`) mutates the file too. */
const WRITE_NAME_RE = /^(?:platform)?(?:write|rename|unlink|mkdir|copy)|Write(?:Sync|File|Json)?$/;
const MARKER_RE = /allow-adhoc-config-merge:(.*)$/;
const CONFIGISH_RE = /(config|cfg|defaults|settings)/i;
const CONFIG_CALL_RE = /^(loadConfig|readConfig\w*|readSettings|readJson\w*)$/;

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

function isJoinCall(node) {
  if (node.type !== 'CallExpression') return false;
  const name = calleeName(node.callee);
  return name !== null && JOIN_NAMES.has(name);
}

function literalString(node) {
  if (node && node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node && node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

/** Does this `join(...)` call name a configuration layer file? */
function isLayerPathJoin(node) {
  const args = node.arguments;
  if (args.length < 2) return false;
  const last = literalString(args[args.length - 1]);
  if (last === null) return false;
  const literals = args.slice(0, -1).map(literalString);
  const hasLiteral = (seg) => literals.some((s) => s === seg || (s !== null && s.split(/[\\/]/).includes(seg)));
  if (last === 'defaults.json') return hasLiteral('.gsd');
  if (last === 'settings.json' || last === 'settings.local.json') return hasLiteral('.claude');
  if (last === 'config.json') {
    if (hasLiteral('.planning')) return true;
    return args.slice(0, -1).some((a) => a.type === 'CallExpression' && PLANNING_CALLS.has(calleeName(a.callee)));
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reading a configuration layer file or spread-merging parsed config objects outside the config resolver',
      category: 'Best Practices',
    },
    schema: [
      {
        type: 'object',
        properties: {
          resolverInternal: { type: 'array', items: { type: 'string' } },
          temporary: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      layerPathRead:
        'Reading a configuration layer file directly bypasses the config resolver (ADR-1411): a read of ' +
        '`.gsd/defaults.json`, `.planning/config.json` or `.claude/settings*.json` that skips ' +
        '`resolveConfigValue` silently ignores root inheritance, global defaults and the schema default, ' +
        'and drops which layer produced the value. Call `resolveConfigValue(key, { cwd, … })` ' +
        '(src/config-value-resolver.cts) or `loadConfig` (src/config-loader.cts). A write or a probe ' +
        '(`existsSync`, `writeFileSync`, …) is not a read and does not match. A justified holdout ' +
        'carries a trailing same-line `// allow-adhoc-config-merge: <non-empty reason>`.',
      configSpreadMerge:
        'Spread-merging two parsed config objects re-implements layer precedence (ADR-1411): four copies ' +
        'of it produced #4071 and #4090. Resolve through `resolveConfigValue` (src/config-value-resolver.cts) ' +
        'or the loader’s merge in src/config-loader.cts instead of merging layers by hand. A justified ' +
        'holdout carries a trailing same-line `// allow-adhoc-config-merge: <non-empty reason>`.',
      staleAllowlistEntry:
        '{{file}} no longer contains an ad-hoc config merge. Delete it from ' +
        'eslint-rules/no-adhoc-config-merge.allowlist.json — the allowlist only ratchets down.',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const resolverInternal = Array.isArray(options.resolverInternal) ? options.resolverInternal : [];
    const temporary = Array.isArray(options.temporary) ? options.temporary : [];

    const filename = context.filename || context.getFilename();
    const cwd = context.cwd || (context.getCwd ? context.getCwd() : process.cwd());
    const rel = path.relative(cwd, filename).split(path.sep).join('/');
    const isResolverInternal = resolverInternal.includes(rel);
    const isTemporary = temporary.includes(rel);
    const exempt = isResolverInternal || isTemporary;

    const sourceCode = context.sourceCode || context.getSourceCode();
    const pending = [];

    /**
     * True when `node` (a layer-path expression) is used only as a write or a
     * probe. `seen` guards a self-referential alias chain.
     */
    function isWriteOrProbeUse(node, seen) {
      const parent = node.parent;
      if (!parent) return false;
      if (parent.type === 'CallExpression' && parent.arguments.includes(node)) {
        const name = calleeName(parent.callee);
        if (name !== null && PROBE_OR_WRITE_CALLS.has(name)) return true;
        if (name !== null && PATH_WRAPPERS.has(name)) return isWriteOrProbeUse(parent, seen);
        return false;
      }
      if (parent.type === 'Property' && parent.value === node) return true;
      // Path identity (`basename !== 'config.json'`, `p === expected`) is neither a read nor a merge.
      if (parent.type === 'BinaryExpression' && /^[!=]==?$/.test(parent.operator)) return true;
      if (parent.type === 'TemplateLiteral') return isWriteOrProbeUse(parent, seen);
      if (parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') {
        const variables = sourceCode.getDeclaredVariables(parent);
        const variable = variables.find((v) => v.name === parent.id.name);
        if (!variable || seen.has(variable)) return false;
        seen.add(variable);
        const uses = variable.references.filter((r) => r.identifier !== parent.id);
        if (uses.length === 0) return true;
        if (uses.some((r) => isWriteUse(r.identifier))) return true;
        return uses.every((r) => isWriteOrProbeUse(r.identifier, seen));
      }
      return false;
    }

    function isWriteUse(node) {
      const parent = node.parent;
      if (!parent || parent.type !== 'CallExpression' || !parent.arguments.includes(node)) return false;
      const name = calleeName(parent.callee);
      return name !== null && (WRITE_CALLS.has(name) || WRITE_NAME_RE.test(name));
    }

    function isConfigOperand(node) {
      if (!node) return false;
      if (node.type === 'Identifier') return CONFIGISH_RE.test(node.name);
      if (node.type === 'MemberExpression') {
        let n = node;
        while (n.type === 'MemberExpression') {
          if (!n.computed && n.property.type === 'Identifier' && CONFIGISH_RE.test(n.property.name)) return true;
          n = n.object;
        }
        return n.type === 'Identifier' && CONFIGISH_RE.test(n.name);
      }
      if (node.type === 'CallExpression') {
        const name = calleeName(node.callee);
        if (name === 'parse' && node.callee.type === 'MemberExpression') {
          const obj = node.callee.object;
          return obj.type === 'Identifier' && obj.name === 'JSON';
        }
        return name !== null && CONFIG_CALL_RE.test(name);
      }
      return false;
    }

    function check(node, messageId) {
      pending.push({ node, messageId });
    }

    return {
      CallExpression(node) {
        if (isJoinCall(node) && isLayerPathJoin(node) && !isWriteOrProbeUse(node, new Set())) {
          check(node, 'layerPathRead');
          return;
        }
        const name = calleeName(node.callee);
        if (
          name === 'assign' &&
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'Object'
        ) {
          const sources = node.arguments.slice(1).filter((a) => a.type !== 'SpreadElement');
          if (sources.filter(isConfigOperand).length >= 2) check(node, 'configSpreadMerge');
        }
      },

      ObjectExpression(node) {
        const spreads = node.properties.filter((p) => p.type === 'SpreadElement');
        if (spreads.length >= 2 && spreads.filter((s) => isConfigOperand(s.argument)).length >= 2) {
          check(node, 'configSpreadMerge');
        }
      },

      'Program:exit'(program) {
        const markers = (typeof sourceCode.getAllComments === 'function' ? sourceCode.getAllComments() : []).filter(
          (c) => {
            if (c.type !== 'Line') return false;
            const m = MARKER_RE.exec(c.value);
            return Boolean(m && m[1] && m[1].trim().length > 0);
          },
        );
        const suppressed = new Set();
        for (const comment of markers) {
          let best = null;
          for (const entry of pending) {
            if (suppressed.has(entry)) continue;
            if (entry.node.loc.end.line !== comment.loc.start.line) continue;
            if (entry.node.range[1] > comment.range[0]) continue;
            if (!best || entry.node.range[1] > best.node.range[1]) best = entry;
          }
          if (best) suppressed.add(best);
        }

        let violations = 0;
        for (const entry of pending) {
          if (suppressed.has(entry)) continue;
          violations += 1;
          if (exempt) continue;
          context.report({ node: entry.node, messageId: entry.messageId });
        }

        if (isTemporary && violations === 0) {
          context.report({ node: program, messageId: 'staleAllowlistEntry', data: { file: rel } });
        }
      },
    };
  },
};

module.exports = rule;
