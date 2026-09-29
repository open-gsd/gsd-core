'use strict';

/**
 * no-verification-status-literal (#5118, ADR-5057 Phase 4)
 *
 * The verification-status vocabulary is a CLOSED enum with ONE owner:
 * `VERIFICATION_STATUS` in src/verification.cts. Outside that module, a
 * `src/` site that spells one of its values as a string literal and compares
 * it against a verification status is re-deriving the vocabulary — the shape
 * that let `unknown`, `verified` (#4817) and `pending|blocked|partial|…`
 * circulate as statuses no writer emits. Compare against the owner's
 * constant instead (`VERIFICATION_STATUS.PASSED`, …), which `tsc` checks.
 *
 * Flags, in `src/**` `.cts` files other than src/verification.cts:
 *   - `===` / `!==` / `==` / `!=` where one side is a string literal equal to
 *     a VERIFICATION_STATUS value and the other side is a verification-status
 *     expression;
 *   - a `switch` over a verification-status expression with a `case` whose
 *     test is such a literal.
 *
 * A verification-status expression is:
 *   - an identifier, or a member property, named like a verification status:
 *     `verificationStatus`, `verifyStatus`, `verification_status`, `vStatus`,
 *     `verStatus` (/^(?:verif\w*status|v(?:er)?status)$/i);
 *   - a `.status` member whose object is named like a verification value
 *     (`verification.status`, `result.verification.status`,
 *     `verificationResult.status`).
 *
 * Not flagged: the owner itself; an unrelated vocabulary that shares a word
 * (`uatResult === 'passed'`, a UAT `result`); a comparison against the
 * owner's constant; a literal outside the enum (`vStatus === 'VERIFIED'` —
 * plan-drift-guard's unrelated symbol-grounding vocabulary); files outside
 * `src/`.
 *
 * The member list below is parity-locked to the compiled owner's
 * `VERIFICATION_STATUS` by tests/eslint-no-verification-status-literal.test.cjs.
 */

/** The closed enum's values (parity-locked to src/verification.cts's VERIFICATION_STATUS). */
const VERIFICATION_STATUS_MEMBERS = Object.freeze([
  'passed',
  'gaps_found',
  'human_needed',
  'stale',
  'missing',
  'unparseable',
  'phase_dir_not_found',
]);

const MEMBER_SET = new Set(VERIFICATION_STATUS_MEMBERS);
const STATUS_NAME_RE = /^(?:verif\w*status|v(?:er)?status)$/i;
const VERIFICATION_OBJECT_RE = /^verif\w*$/i;

function propertyName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  if (!member.computed && member.property && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property && member.property.type === 'Literal' && typeof member.property.value === 'string') {
    return member.property.value;
  }
  return null;
}

function nameOf(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return propertyName(node);
  return null;
}

/** True when `node` reads a verification status (see the header for the shapes). */
function isVerificationStatusExpression(node) {
  if (!node) return false;
  if (node.type === 'ChainExpression') return isVerificationStatusExpression(node.expression);
  if (node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression') {
    return isVerificationStatusExpression(node.expression);
  }
  const name = nameOf(node);
  if (name && STATUS_NAME_RE.test(name)) return true;
  if (node.type === 'MemberExpression' && name === 'status') {
    const objectName = nameOf(node.object);
    return Boolean(objectName && VERIFICATION_OBJECT_RE.test(objectName));
  }
  return false;
}

function memberLiteral(node) {
  return Boolean(node && node.type === 'Literal' && typeof node.value === 'string' && MEMBER_SET.has(node.value));
}

function isOwnedSourceFile(filename) {
  const posix = String(filename || '').replace(/\\/g, '/');
  if (!/(^|\/)src\/.*\.cts$/.test(posix)) return false;
  return !/(^|\/)src\/verification\.cts$/.test(posix);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow spelling a VerificationStatus value as a string literal outside src/verification.cts — compare against VERIFICATION_STATUS.* instead.',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      verificationStatusLiteral:
        "Verification status '{{value}}' spelled as a literal outside its owner. Import VERIFICATION_STATUS from ./verification.cjs and compare against VERIFICATION_STATUS.{{constant}} (#5118, ADR-5057 Phase 4).",
    },
  },

  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (!isOwnedSourceFile(filename)) return {};

    function report(literal) {
      context.report({
        node: literal,
        messageId: 'verificationStatusLiteral',
        data: { value: literal.value, constant: String(literal.value).toUpperCase() },
      });
    }

    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        if (memberLiteral(node.right) && isVerificationStatusExpression(node.left)) report(node.right);
        else if (memberLiteral(node.left) && isVerificationStatusExpression(node.right)) report(node.left);
      },
      SwitchStatement(node) {
        if (!isVerificationStatusExpression(node.discriminant)) return;
        for (const switchCase of node.cases) {
          if (memberLiteral(switchCase.test)) report(switchCase.test);
        }
      },
    };
  },
};

module.exports = rule;
module.exports.VERIFICATION_STATUS_MEMBERS = VERIFICATION_STATUS_MEMBERS;
