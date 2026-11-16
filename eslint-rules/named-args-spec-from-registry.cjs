'use strict';

/**
 * named-args-spec-from-registry
 *
 * Flag declarations come only from the CLI surface registry (#6087, ADR-4909 D1).
 *
 * 1. `parseNamedArgs(...)` / `parseNamedArgsOrExit(...)` whose 2nd argument is
 *    not a `specFor(...)` call, or an Identifier that a `const` in scope
 *    initialises from a `specFor(...)` call (inline object, other variable, ...).
 *    messageId `inlineSpec`.
 * 2. Ad-hoc flag reads. messageId `adhocFlag`:
 *    - `.indexOf/.includes/.lastIndexOf/.findIndex/.find('--x')` (string
 *      Literal, TemplateLiteral whose first quasi starts with `--`, or an
 *      Identifier a `const` in scope binds to a `--x` string Literal)
 *    - `x === '--x'` (any of ===, ==, !==, != with a `--`-prefixed literal on either side)
 *    - `.startsWith('--x...')` with at least one char after `--`
 *    - `case '--x':` in a switch
 *    - a regex literal beginning `^--<letter>` used with `.test/.exec` or passed
 *      to `.match/.matchAll/.search`
 *    - `new Set([... '--x' ...])` and `['--x', ...].includes/.indexOf(tok)`
 *
 * Not reported: the literal exactly `--` (end-of-options) and the generic
 * shape test `startsWith('--')`.
 *
 * File scoping is done by eslint.config.mjs; the rule has no path logic.
 */

const PARSE_FNS = new Set(['parseNamedArgs', 'parseNamedArgsOrExit']);
const SEARCH_METHODS = new Set(['indexOf', 'includes', 'lastIndexOf', 'findIndex', 'find']);
const ARRAY_SEARCH_METHODS = new Set(['indexOf', 'includes', 'lastIndexOf']);
const REGEX_RECEIVER_METHODS = new Set(['test', 'exec']);
const REGEX_ARGUMENT_METHODS = new Set(['match', 'matchAll', 'search']);
const EQUALITY_OPS = new Set(['===', '==', '!==', '!=']);
const FLAG_REGEX_SOURCE = /^\^--[A-Za-z]/;

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

/** First `--x` (longer than the bare `--`) string Literal among an ArrayExpression's elements, else null. */
function firstFlagElement(node) {
  if (!node || node.type !== 'ArrayExpression') return null;
  for (const element of node.elements) {
    const text = literalString(element);
    if (text !== null && text.startsWith('--') && text !== '--') return text;
  }
  return null;
}

function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name);
    if (variable) return variable;
  }
  return null;
}

/** The initialiser of the `const` declaration an Identifier resolves to, else null. */
function constInit(scope, identifier) {
  if (!identifier || identifier.type !== 'Identifier') return null;
  const variable = findVariable(scope, identifier.name);
  const def = variable && variable.defs[0];
  if (!def || def.type !== 'Variable' || def.parent.kind !== 'const') return null;
  return def.node.init ?? null;
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
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function reportAdhoc(node, literal) {
      context.report({ node, messageId: 'adhocFlag', data: { literal } });
    }

    function isSpecForCall(node) {
      return Boolean(node) && node.type === 'CallExpression' && calleeName(node.callee) === 'specFor';
    }

    function isRegistrySpec(node) {
      if (isSpecForCall(node)) return true;
      if (!node || node.type !== 'Identifier') return false;
      return isSpecForCall(constInit(sourceCode.getScope(node), node));
    }

    function flagBoundTo(node) {
      const init = constInit(sourceCode.getScope(node), node);
      const text = literalString(init);
      return text !== null && text.startsWith('--') && text !== '--' ? text : null;
    }

    function checkRegexLiteral(regexNode, usage) {
      if (!regexNode || regexNode.type !== 'Literal' || !regexNode.regex) return;
      if (FLAG_REGEX_SOURCE.test(regexNode.regex.pattern)) reportAdhoc(usage, regexNode.raw);
    }

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === null) return;

        if (PARSE_FNS.has(name)) {
          if (!isRegistrySpec(node.arguments[1])) context.report({ node, messageId: 'inlineSpec' });
          return;
        }

        if (node.callee.type !== 'MemberExpression') return;
        const first = node.arguments[0];

        if (REGEX_RECEIVER_METHODS.has(name)) checkRegexLiteral(node.callee.object, node);
        if (REGEX_ARGUMENT_METHODS.has(name)) checkRegexLiteral(first, node);

        if (ARRAY_SEARCH_METHODS.has(name)) {
          const element = firstFlagElement(node.callee.object);
          if (element !== null) reportAdhoc(node, element);
        }

        if (SEARCH_METHODS.has(name)) {
          const text = leadingText(first);
          if (text !== null) {
            if (!text.startsWith('--')) return;
            // A bare '--' string Literal is end-of-options; a template `--${x}` is a flag.
            if (first.type === 'Literal' && text === '--') return;
            reportAdhoc(node, text);
            return;
          }
          const bound = flagBoundTo(first);
          if (bound !== null) reportAdhoc(node, bound);
        } else if (name === 'startsWith') {
          const text = literalString(first);
          if (text !== null && text.startsWith('--') && text.length > 2) reportAdhoc(node, text);
        }
      },

      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'Set') return;
        const element = firstFlagElement(node.arguments[0]);
        if (element !== null) reportAdhoc(node, element);
      },

      SwitchCase(node) {
        const text = literalString(node.test);
        if (text !== null && text.startsWith('--') && text !== '--') reportAdhoc(node, text);
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
