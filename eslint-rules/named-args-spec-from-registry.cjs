'use strict';

/**
 * named-args-spec-from-registry
 *
 * Flag declarations come only from the CLI surface registry (#6087, ADR-4909 D1).
 *
 * 1. `parseNamedArgs(...)` / `parseNamedArgsOrExit(...)` whose 2nd argument is
 *    not a `specFor(...)` call (inline object, variable, ...). messageId `inlineSpec`.
 * 2. Ad-hoc flag reads. messageId `adhocFlag`:
 *    - `.indexOf/.includes/.lastIndexOf/.findIndex/.find('--x')` (string
 *      Literal, or TemplateLiteral whose first quasi starts with `--`)
 *    - `x === '--x'` (any of ===, ==, !==, != with a `--`-prefixed literal on either side)
 *    - `.startsWith('--x...')` with at least one char after `--`
 *
 * Not reported: the literal exactly `--` (end-of-options) and the generic
 * shape test `startsWith('--')`.
 *
 * File scoping is done by eslint.config.mjs; the rule has no path logic.
 */

const PARSE_FNS = new Set(['parseNamedArgs', 'parseNamedArgsOrExit']);
const SEARCH_METHODS = new Set(['indexOf', 'includes', 'lastIndexOf', 'findIndex', 'find']);
const EQUALITY_OPS = new Set(['===', '==', '!==', '!=']);

/** Name of an Identifier callee or a non-computed member property, else null. */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

/** String value of a string Literal, else null. */
function literalString(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

/** Leading text of a string Literal or the first quasi of a TemplateLiteral, else null. */
function leadingText(node) {
  const s = literalString(node);
  if (s !== null) return s;
  if (node && node.type === 'TemplateLiteral') return node.quasis[0].value.cooked;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require CLI flag declarations to come from the CLI surface registry (specFor)',
    },
    schema: [],
    messages: {
      inlineSpec:
        "Declare this verb's flags in src/cli-surface.cts and pass specFor('<verb>') (ADR-4909 D1).",
      adhocFlag: "Read '{{literal}}' through specFor(...)/parseNamedArgs, not by hand (ADR-4909 D1).",
    },
  },

  create(context) {
    function reportAdhoc(node, literal) {
      context.report({ node, messageId: 'adhocFlag', data: { literal } });
    }

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === null) return;

        if (PARSE_FNS.has(name)) {
          const spec = node.arguments[1];
          const ok = spec && spec.type === 'CallExpression' && calleeName(spec.callee) === 'specFor';
          if (!ok) context.report({ node, messageId: 'inlineSpec' });
          return;
        }

        if (node.callee.type !== 'MemberExpression') return;
        const first = node.arguments[0];

        if (SEARCH_METHODS.has(name)) {
          const text = leadingText(first);
          if (text === null || !text.startsWith('--')) return;
          // A bare '--' string Literal is end-of-options; a template `--${x}` is a flag.
          if (first.type === 'Literal' && text === '--') return;
          reportAdhoc(node, text);
        } else if (name === 'startsWith') {
          const text = literalString(first);
          if (text !== null && text.startsWith('--') && text.length > 2) reportAdhoc(node, text);
        }
      },

      BinaryExpression(node) {
        if (!EQUALITY_OPS.has(node.operator)) return;
        for (const side of [node.left, node.right]) {
          const text = literalString(side);
          if (text !== null && text.startsWith('--') && text !== '--') {
            reportAdhoc(node, text);
            return;
          }
        }
      },
    };
  },
};

module.exports = rule;
