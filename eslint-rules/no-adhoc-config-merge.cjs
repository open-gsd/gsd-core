'use strict';

const path = require('path');

/**
 * no-adhoc-config-merge (#6032, epic #4633, ADR-1411 Decision 5).
 *
 * The anti-divergence guard for configuration layer resolution. Flags, outside the boundary:
 *   (a) `layerPathRead`: reading a layer file by a hand-built path (`.gsd/defaults.json`,
 *       `planningDir|planningRoot(...)` + `config.json`, `.planning/config.json`,
 *       `.claude/settings[.local].json`). A path that only reaches a probe, a write, a reported
 *       property or a comparison is exempt by shape; a returned path is not (a local helper is a copy);
 *   (b) `configSpreadMerge`: `{...a, ...b}` / `Object.assign` over two config-ish operands;
 *   (c) `layerWalk`: one function reading two or more different layers, helpers or not.
 * Options: `resolverInternal` (permanent boundary files) and `temporary` (migration entries, empty
 * and kept empty; a stale one reports). A same-line `// allow-adhoc-config-merge: <reason>` holds one.
 * Known gap: computed path segments are not seen. Full rationale: CONTEXT.md, ADR-1411 C5 amendment.
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
/** An injected stat seam (`fsStatSync`, `fsExistsSync`) probes like the call it stands for. */
const PROBE_NAME_RE = /^(?:fs)?(?:exists|stat|lstat|access)(?:Sync)?$/i;

/** Wrappers that only reshape a path string; the use that matters is outside. */
const PATH_WRAPPERS = new Set(['toPosixPath', 'normalize', 'relative', 'basename', 'dirname']);

/** A helper named like a write (`platformWriteSync`, `writeJsonAtomic`) mutates the file too. */
const WRITE_NAME_RE = /^(?:platform)?(?:write|rename|unlink|mkdir|copy)|Write(?:Sync|File|Json)?$/;
/** Owner helper calls that name a layer file; `helperKinds` (in `create`) maps each to its layer kind. */
const LAYER_HELPERS = new Set([
  'projectConfigPath',
  'rootConfigPath',
  'globalDefaultsPath',
  'claudeSettingsPath',
  'claudeSettingsPaths',
]);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

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

/**
 * The layer kind a `join(...)` call names, or null when it names no configuration layer file.
 * The single place the layer literals are interpreted: `global`, `project`, `root`,
 * `claude-local`, `claude-shared`.
 */
function layerKindOfJoin(node) {
  const args = node.arguments;
  if (args.length < 2) return null;
  const last = literalString(args[args.length - 1]);
  if (last === null) return null;
  const literals = args.slice(0, -1).map(literalString);
  const hasLiteral = (seg) => literals.some((s) => s === seg || (s !== null && s.split(/[\\/]/).includes(seg)));
  if (last === 'defaults.json') return hasLiteral('.gsd') ? 'global' : null;
  if (last === 'settings.local.json') return hasLiteral('.claude') ? 'claude-local' : null;
  if (last === 'settings.json') return hasLiteral('.claude') ? 'claude-shared' : null;
  if (last !== 'config.json') return null;
  const planning = args.slice(0, -1).find((a) => a.type === 'CallExpression' && PLANNING_CALLS.has(calleeName(a.callee)));
  if (planning) return calleeName(planning.callee) === 'planningDir' ? 'project' : 'root';
  return hasLiteral('.planning') ? 'root' : null;
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
      layerWalk:
        'This function reads {{kinds}} configuration layers by hand: that is a precedence implementation ' +
        '(ADR-1411), the shape that produced #4071 and #4090 four times. Resolve through ' +
        '`resolveConfigValue` (src/config-value-resolver.cts), which returns the value AND the layer that ' +
        'produced it, instead of reading layers one after another. A justified holdout carries a trailing ' +
        'same-line `// allow-adhoc-config-merge: <non-empty reason>`.',
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
        if (name !== null && (PROBE_OR_WRITE_CALLS.has(name) || PROBE_NAME_RE.test(name))) return true;
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

    function check(node, messageId, data) {
      pending.push({ node, messageId, data });
    }

    /** The layer kinds a helper call names (a list for the plural settings helper). */
    function helperKinds(node) {
      const name = calleeName(node.callee);
      if (name === 'projectConfigPath') return ['project'];
      if (name === 'rootConfigPath') return ['root'];
      if (name === 'globalDefaultsPath') return ['global'];
      if (name === 'claudeSettingsPaths') return ['claude-local', 'claude-shared'];
      const kind = node.arguments[1];
      return [literalString(kind) === 'local' ? 'claude-local' : 'claude-shared'];
    }

    function enclosingFunction(node) {
      let n = node.parent;
      while (n && !FUNCTION_TYPES.has(n.type)) n = n.parent;
      return n || sourceCode.ast;
    }

    /** Layer kinds read per enclosing function, from helper calls and join constructions alike. */
    const kindsByFunction = new Map();
    function noteKinds(node, kinds) {
      if (isWriteOrProbeUse(node, new Set())) return;
      const fn = enclosingFunction(node);
      const set = kindsByFunction.get(fn) || new Set();
      for (const k of kinds) set.add(k);
      kindsByFunction.set(fn, set);
    }

    return {
      CallExpression(node) {
        const helper = calleeName(node.callee);
        if (helper !== null && LAYER_HELPERS.has(helper)) noteKinds(node, helperKinds(node));
        const joinKind = isJoinCall(node) ? layerKindOfJoin(node) : null;
        if (joinKind !== null) {
          noteKinds(node, [joinKind]);
          if (!isWriteOrProbeUse(node, new Set())) {
            check(node, 'layerPathRead');
            return;
          }
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
        for (const [fn, kinds] of kindsByFunction) {
          if (kinds.size >= 2) {
            check(fn === sourceCode.ast ? program : fn, 'layerWalk', { kinds: [...kinds].sort().join(' + ') });
          }
        }
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
          context.report({ node: entry.node, messageId: entry.messageId, data: entry.data });
        }

        if (isTemporary && violations === 0) {
          context.report({ node: program, messageId: 'staleAllowlistEntry', data: { file: rel } });
        }
      },
    };
  },
};

module.exports = rule;
