'use strict';

/**
 * no-source-grep
 *
 * Flags variables bound to readFileSync() of a .cjs/.js/.ts source path that
 * later have .includes/.match/.startsWith/.indexOf called on them.
 *
 * Honor file-level escape comment: // allow-test-rule: <reason>
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reading source .cjs/.js/.ts files with readFileSync and then doing text search on the result',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      noSourceGrep:
        'Source-grep test: do not read source .cjs/.js/.ts files with readFileSync and call .includes/.match/.startsWith/.indexOf on the result. Use require() to run the module instead. Add // allow-test-rule: <reason> at the top of the file to suppress.',
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode;

    // Check for file-level escape comment
    const comments = sourceCode.getAllComments();
    const hasAllowAnnotation = comments.some(
      (c) => /allow-test-rule:\s*\S/.test(c.value)
    );
    if (hasAllowAnnotation) return {};

    // Track variable names bound to readFileSync of a source path
    const sourceGrepVars = new Set();

    // Detect if a node represents a readFileSync call on a source file (.cjs/.js/.ts)
    // that lives in a source directory (bin, lib, gsd-core, src).
    function isSourceReadFileSync(node) {
      if (node.type !== 'CallExpression') return false;

      // Match: readFileSync(...) or fs.readFileSync(...) or require('fs').readFileSync(...)
      const callee = node.callee;
      const isFsRead =
        (callee.type === 'Identifier' && callee.name === 'readFileSync') ||
        (callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'readFileSync');

      if (!isFsRead) return false;

      const args = node.arguments;
      if (!args || args.length === 0) return false;

      const firstArg = args[0];
      const fullSrc = sourceCode.getText(firstArg);

      return looksLikeSourcePath(fullSrc);
    }

    // Given the source text of a path expression, determine if it references
    // a .cjs/.js/.ts source file in a source directory.
    function looksLikeSourcePath(src) {
      // Must end with a .cjs, .js, or .ts extension (in a string)
      const hasCjsExt = /['"`.][^'"`.]*\.(?:cjs|js|ts)['"`)]/i.test(src);
      if (!hasCjsExt) return false;

      // Must reference a source directory indicator somewhere in the expression
      const hasSourceDir = /['"](?:bin|lib|gsd-core|src)['"]/i.test(src);
      return hasSourceDir;
    }

    const TEXT_METHODS = new Set(['includes', 'match', 'startsWith', 'endsWith', 'indexOf', 'search']);

    return {
      VariableDeclarator(node) {
        // const varName = readFileSync(...)  OR  const varName = fs.readFileSync(...)
        if (node.init && isSourceReadFileSync(node.init)) {
          if (node.id.type === 'Identifier') {
            sourceGrepVars.add(node.id.name);
          }
        }
      },
      AssignmentExpression(node) {
        if (node.right && isSourceReadFileSync(node.right)) {
          if (node.left.type === 'Identifier') {
            sourceGrepVars.add(node.left.name);
          }
        }
      },
      CallExpression(node) {
        // varName.includes(...), varName.match(...), etc.
        if (
          node.callee.type === 'MemberExpression' &&
          TEXT_METHODS.has(node.callee.property.name)
        ) {
          const obj = node.callee.object;
          if (obj.type === 'Identifier' && sourceGrepVars.has(obj.name)) {
            context.report({ node, messageId: 'noSourceGrep' });
          }
          // Inline: readFileSync(...).includes(...)
          if (isSourceReadFileSync(obj)) {
            context.report({ node, messageId: 'noSourceGrep' });
          }
        }
      },
    };
  },
};

module.exports = rule;
