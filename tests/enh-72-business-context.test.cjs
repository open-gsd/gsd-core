// allow-test-rule: source-text-is-the-product
// The PROJECT.md template + complete-milestone workflow .md ARE the product surface
// the runtime loads; asserting on their text tests the deployed contract directly.
/**
 * Enhancement #72 — optional Business Context section in the PROJECT.md template.
 *
 * Contract tests over the product-text surfaces (template + milestone workflow .md):
 * the template offers a Business Context section that is explicitly OPTIONAL, capped
 * at the four approved one-line fields, and the milestone evolution review treats it
 * as conditional so non-business projects that deleted it are never forced to review it.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'gsd-core', 'templates', 'project.md');
const COMPLETE_MILESTONE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md');

function parseTemplateContract(content) {
  const lines = content.split(/\r?\n/);
  const lower = content.toLowerCase();
  // The Business Context block lives between its heading and the next "## " heading.
  const startIdx = lines.findIndex(l => l.trim() === '## Business Context');
  let sectionBody = '';
  if (startIdx !== -1) {
    const rest = lines.slice(startIdx + 1);
    const endOffset = rest.findIndex(l => l.startsWith('## '));
    sectionBody = (endOffset === -1 ? rest : rest.slice(0, endOffset)).join('\n');
  }
  const fieldOf = (label) => new RegExp(`^- \\*\\*${label}\\*\\*:`, 'm').test(sectionBody);
  return {
    hasSection: startIdx !== -1,
    // Optional-by-default: an HTML comment tells non-business projects to delete it.
    hasOptionalMarker: /<!--\s*OPTIONAL/i.test(sectionBody) && /delete this section/i.test(sectionBody),
    fields: {
      customer: fieldOf('Customer'),
      revenueModel: fieldOf('Revenue model'),
      successMetric: fieldOf('Success metric'),
      strategyNotes: fieldOf('Strategy notes'),
    },
    fieldCount: (sectionBody.match(/^- \*\*/gm) || []).length,
    // Positioned between Core Value and Requirements.
    orderedBetweenCoreValueAndRequirements:
      lower.indexOf('## core value') < lower.indexOf('## business context') &&
      lower.indexOf('## business context') < lower.indexOf('## requirements'),
    hasGuidelinesEntry: /\*\*Business Context:\*\*/.test(content),
  };
}

function parseMilestoneContract(content) {
  const lower = content.toLowerCase();
  const lines = content.split(/\r?\n/);
  const reviewLine = lines.find(l =>
    l.toLowerCase().includes('business context') &&
    (l.toLowerCase().includes('if present') || l.toLowerCase().includes('only if')),
  );
  return {
    mentionsBusinessContext: lower.includes('business context'),
    hasConditionalReview: Boolean(reviewLine),
  };
}

describe('enhancement #72 — Business Context template section', () => {
  const tpl = parseTemplateContract(fs.readFileSync(TEMPLATE, 'utf-8'));

  test('template includes a Business Context section', () => {
    assert.ok(tpl.hasSection, 'template must contain a "## Business Context" section');
  });

  test('section is marked OPTIONAL with delete-for-non-business guidance', () => {
    assert.ok(tpl.hasOptionalMarker, 'section must carry an OPTIONAL HTML comment telling non-business projects to delete it');
  });

  test('section carries exactly the four approved one-line fields', () => {
    assert.ok(tpl.fields.customer, 'missing **Customer** field');
    assert.ok(tpl.fields.revenueModel, 'missing **Revenue model** field');
    assert.ok(tpl.fields.successMetric, 'missing **Success metric** field');
    assert.ok(tpl.fields.strategyNotes, 'missing **Strategy notes** field');
    assert.strictEqual(tpl.fieldCount, 4, 'section is capped at four fields (constraint reference, not a business plan)');
  });

  test('section is positioned between Core Value and Requirements', () => {
    assert.ok(tpl.orderedBetweenCoreValueAndRequirements, 'Business Context must sit between Core Value and Requirements');
  });

  test('guidelines document the Business Context section', () => {
    assert.ok(tpl.hasGuidelinesEntry, 'guidelines block must include a **Business Context:** entry');
  });

  test('milestone evolution reviews Business Context only when present', () => {
    const ms = parseMilestoneContract(fs.readFileSync(COMPLETE_MILESTONE, 'utf-8'));
    assert.ok(ms.mentionsBusinessContext, 'complete-milestone must mention Business Context in its review');
    assert.ok(ms.hasConditionalReview, 'the Business Context milestone review must be conditional on the section being present');
  });
});
