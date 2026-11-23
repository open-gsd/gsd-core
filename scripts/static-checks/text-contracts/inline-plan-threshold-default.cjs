'use strict';

// workflow.inline_plan_threshold's default has ONE owner (#3801): the defaults manifest owns it (key present, value
// 2), every shipped doc that names a default agrees with the manifest (the settings prompt, CONFIGURATION.md in
// English and its translations, planning-config.md's tables), and the execute-plan shell fallback and prose default
// agree too (#3923 drifted several of these to 3). Was tests/inline-plan-threshold-default.test.cjs.

const path = require('node:path');

const DEFAULT = '2';
const lib = (name) => require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', name));

// Every surface that states the default, with the pattern capturing the stated value.
const SURFACES = [
  ['gsd-core/workflows/settings-advanced.md', /inline_plan_threshold`\s{0,20}\(default:\s{0,20}`(\d{1,6})`/],
  ['gsd-core/workflows/settings-advanced.md', /Inline plan threshold[^\n]{0,500}\(current: <value or (\d{1,6})>\)/],
  ['gsd-core/workflows/settings-advanced.md', /Inline plan threshold[\s\S]{0,400}?Default: (\d{1,6})/],
  ['docs/CONFIGURATION.md', /`workflow\.inline_plan_threshold`\s{0,20}\|\s{0,20}number\s{0,20}\|\s{0,20}`(\d{1,6})`/],
  ['docs/zh-CN/CONFIGURATION.md', /`workflow\.inline_plan_threshold`\s{0,20}\|\s{0,20}number\s{0,20}\|\s{0,20}`(\d{1,6})`/],
  ['docs/pt-BR/CONFIGURATION.md', /`workflow\.inline_plan_threshold`\s{0,20}\|\s{0,20}number\s{0,20}\|\s{0,20}`(\d{1,6})`/],
];

module.exports = {
  id: 'inline-plan-threshold-default',
  issue: '#3801',
  check(ctx) {
    ctx.doc('gsd-core/bin/shared/config-defaults.manifest.json').satisfies((text) => {
      let manifest;
      try {
        manifest = JSON.parse(text);
      } catch (err) {
        return `the manifest is not valid JSON: ${err.message}`;
      }
      if (manifest === null || typeof manifest !== 'object' || !manifest.workflow || typeof manifest.workflow !== 'object'
        || !Object.prototype.hasOwnProperty.call(manifest.workflow, 'inline_plan_threshold')) {
        return 'the key is not registered in config-defaults.manifest.json';
      }
      return manifest.workflow.inline_plan_threshold === Number(DEFAULT) || `the manifest default is ${manifest.workflow.inline_plan_threshold}`;
    }, 'the defaults manifest must own workflow.inline_plan_threshold (default 2), one source of truth');

    for (const [rel, pattern] of SURFACES) {
      ctx.doc(rel).satisfies((text) => {
        const match = pattern.exec(text);
        if (!match) return 'the surface does not name the inline_plan_threshold default';
        return match[1] === DEFAULT || `documents the default as ${match[1]}`;
      }, `${rel} must name the inline_plan_threshold default and agree with the manifest's ${DEFAULT}`);
    }

    // planning-config.md's tables are read through the shared markdown-table parser, not an ad-hoc cell regex.
    ctx.doc('gsd-core/references/planning-config.md').satisfies((text) => {
      const parsed = lib('markdown-table.cjs').parseMarkdownTable(text);
      if (!parsed.ok) return 'no parseable defaults table';
      // parseMarkdownTable never throws and an ok result always carries { columns, rows } with plain row objects.
      const rows = parsed.value.rows.filter((row) => String(row['Option']).includes('inline_plan_threshold'));
      if (rows.length < 1) return 'no inline_plan_threshold row';
      for (const row of rows) {
        const value = String(row['Default']).replace(/`/g, '').trim();
        if (value !== DEFAULT) return `documents the default as ${value}`;
      }
      return true;
    }, `planning-config.md must document inline_plan_threshold and agree with the manifest's ${DEFAULT}`);

    // The execute-plan shell fallback and prose default both say 2.
    ctx.doc('gsd-core/workflows/execute-plan.md')
      .satisfies((text) => {
        const line = lib('text-lines.cjs').splitLines(text).find((l) => l.includes('config-get workflow.inline_plan_threshold'));
        if (!line) return 'no config-get workflow.inline_plan_threshold line';
        return line.includes('echo "2"') || `the fallback line is ${line}`;
      }, 'execute-plan.md must fetch the key with a shell fallback that agrees with the manifest default')
      .has(/default: 2, set to `0` to always spawn/, 'the prose default must stay 2');
  },
};
