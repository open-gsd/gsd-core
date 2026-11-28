'use strict';

// #6482: the reviewer-lane docs match what ships. Each headline claim of the issue's six tables is pinned:
// an installed lane runs through /gsd-code-review (not /gsd-review) and receives a source-review request;
// the manifest reference's counts, role rules and field table equal the capability registry and
// REVIEWER_LANES; model-key examples, table rows and defaults equal the generated configSchema; no command
// passes --json to review-lane plan; gemini is not a lane. Expected values are derived, never counted by hand.

const { REVIEWER_LANES } = require('../../../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { capabilities, configSchema } = require('../../../gsd-core/bin/lib/capability-registry.cjs');
const { splitTableRow, isDelimiterRow } = require('../../../gsd-core/bin/lib/markdown-table.cjs');

const PAGES = [
  'docs/CONFIGURATION.md',
  'docs/README.md',
  'docs/how-to/develop-a-capability.md',
  'docs/how-to/fix-a-refused-reviewer-lane.md',
  'docs/how-to/list-your-reviewer-lane.md',
  'docs/how-to/set-up-cross-ai-review.md',
  'docs/how-to/ship-a-reviewer-lane.md',
  'docs/reference/capability-manifest.md',
  'docs/registries/README.md',
];
const CONFIG = 'docs/CONFIGURATION.md';
const SETUP = 'docs/how-to/set-up-cross-ai-review.md';
const SHIP = 'docs/how-to/ship-a-reviewer-lane.md';
const MANIFEST = 'docs/reference/capability-manifest.md';
const LINK_PAGES = ['docs/README.md', 'docs/how-to/develop-a-capability.md', 'docs/registries/README.md'];
const REGISTRY_EXAMPLE_PAGES = ['docs/registries/README.md', 'docs/how-to/list-your-reviewer-lane.md'];
// #4209 added reviewer lanes to /gsd-code-review in this release; a reviewer example must not claim less.
const INSTALLED_LANE_FLOOR = [1, 14, 0];

const tick = (s) => '\x60' + s + '\x60';
const untick = (s) => s.replace(/^\x60|\x60$/g, '');
const fence = (lang, body) => '\x60\x60\x60' + lang + '\n' + body + '\n\x60\x60\x60';
const floorStatus = (range) => {
  if (typeof range !== 'string' || !range.trim()) return 'unrecognised';
  const compareFloor = (version) => {
    const tuple = version.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) if (tuple[i] !== INSTALLED_LANE_FLOOR[i]) return tuple[i] < INSTALLED_LANE_FLOOR[i] ? -1 : 1;
    return 0;
  };
  const arms = range.split(/\s*\|\|\s*/);
  if (arms.some((arm) => !arm.trim())) return 'unrecognised';
  for (const arm of arms) {
    const terms = arm.trim().split(/\s+/).map((term) => /^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/.exec(term));
    if (terms.some((term) => !term)) return 'unrecognised';
    const lowerBounds = terms.filter(([, op]) => op === '>=' || op === '>' || op === '=' || !op);
    if (lowerBounds.length === 0 || Math.max(...lowerBounds.map(([, , version]) => compareFloor(version))) < 0) return 'below';
  }
  return 'ok';
};
const jsonBlocks = (text) => [...text.matchAll(/\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60/g)].flatMap(([, body]) => {
  try { return [JSON.parse(body)]; } catch { return []; }
});
// The GFM tables of a text, each as its data rows (header and delimiter dropped), cells split.
const tables = (text) => {
  const found = [];
  let run = [];
  for (const line of text.split('\n').concat('')) {
    if (line.startsWith('|')) { run.push(splitTableRow(line)); continue; }
    if (run.length) found.push(run.slice(1).filter((cells) => !isDelimiterRow(cells)));
    run = [];
  }
  return found;
};
const setDiff = (want, got) => ({ missing: want.filter((k) => !got.includes(k)), extra: got.filter((k) => !want.includes(k)) });
const describeDiff = ({ missing, extra }) => '(missing: ' + (missing.join(', ') || 'none') + '; extra: ' + (extra.join(', ') || 'none') + ')';

// Selection claims are sentence-scoped, tied to an installed lane, and exempt only a nearby negation.
const staleSelectionSentence = (sentence) => {
  if (!/\/gsd-review\b/i.test(sentence)) return false;
  const subject = /\b(?:installed|third[- ]party|add-on)\b[^.;\n]{0,80}\b(?:reviewer\s+)?(?:lanes?|tools?|endpoints?|capabilities|cli)\b|\b(?:reviewer\s+)?lanes?\s+(?:installed|from (?:a )?third[- ]party)\b|\byour\b[^.;\n]{0,80}\b(?:lanes?|tools?|endpoints?|capabilities|review cli)\b/i;
  if (!subject.test(sentence)) return false;
  const verbs = /\b(?:discover|offer|render|hand|select|run|invoke|probe)(?:s|ed|ing)?\b/gi;
  for (const match of sentence.matchAll(verbs)) {
    const before = sentence.slice(0, match.index).trim().split(/\s+/).slice(-4).join(' ');
    if (!/\b(?:not|never|only|no longer)(?:\s+\S+){0,3}$/i.test(before)) return true;
  }
  return false;
};
const GEMINI_LANE = /\bgemini\b[^.\n]*\b(?:is|are) an? (?:shipped|first-party|built-in|declared) (?:reviewer )?lane|review\.models\.gemini/i;

// Full dotted review.models keys a text sets in an example: a config-set command, or a review.models
// object in a JSON block.
function exampleModelKeys(text) {
  const keys = [...text.matchAll(/config-set (review\.models\.[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  for (const parsed of jsonBlocks(text)) {
    const models = parsed && parsed.review && parsed.review.models;
    if (models && typeof models === 'object' && !Array.isArray(models)) keys.push(...Object.keys(models).map((k) => 'review.models.' + k));
  }
  return keys;
}

module.exports = {
  id: 'reviewer-lane-docs',
  issue: '#6482',
  check(ctx) {
    const schemaModelKeys = Object.keys(configSchema).filter((k) => k.startsWith('review.models.')).sort();
    const reviewerIds = Object.values(capabilities).filter((cap) => cap.role === 'reviewer').map((cap) => cap.id).sort();
    for (const lane of REVIEWER_LANES) {
      if (lane.modelConfigKey && !schemaModelKeys.includes(lane.modelConfigKey)) {
        ctx.fail(CONFIG, 'lane ' + lane.slug + ' reads ' + lane.modelConfigKey + ', which no shipped capability declares');
      }
    }

    // Every page: no selection, --json or gemini claim; model-key examples use declared keys.
    for (const rel of PAGES) {
      const doc = ctx.doc(rel);
      const selectionClauses = doc.text.replace(/^#{1,6}.*$/gm, '').split(/[.;]/).flatMap((sentence) => sentence.split(/,\s*(?:(?:and\s+)?neither|but|which|while|so|or)\b/i));
      if (selectionClauses.some(staleSelectionSentence)) ctx.fail(rel, 'an installed lane is not selected by /gsd-review');
      if (!REVIEWER_LANES.some((lane) => lane.slug === 'gemini')) {
        doc.lacks(GEMINI_LANE, 'gemini is not a shipped reviewer lane');
        if (rel === SHIP && doc.text.split('\n').some((line) => /\blike\b/.test(line) && /\x60gemini\x60/.test(line))) {
          ctx.fail(rel, 'gemini is not a shipped reviewer lane');
        }
      }
      const flat = doc.text.replace(/\\\r?\n[ \t]*/g, ' ');
      if (/review-lane plan[^\n\x60]*--json/.test(flat)) ctx.fail(rel, 'review-lane plan takes no --json flag');
      // Only the authoring guide may set its example lane's key, and only one its parsed example manifest
      // both declares in config and reads through reviewer.modelConfigKey.
      const own = new Set(rel !== SHIP ? [] : jsonBlocks(doc.text)
        .filter((m) => m && m.reviewer && m.config && typeof m.reviewer.modelConfigKey === 'string' && Object.prototype.hasOwnProperty.call(m.config, m.reviewer.modelConfigKey))
        .map((m) => m.reviewer.modelConfigKey));
      for (const key of exampleModelKeys(flat)) {
        if (!schemaModelKeys.includes(key) && !own.has(key)) ctx.fail(rel, 'an example sets ' + key + ', which no shipped capability declares');
      }
    }

    // Reviewer examples carry the floor of the release that added installed-lane dispatch.
    const checkFloor = (rel, value) => {
      const status = value ? floorStatus(value) : 'below';
      if (status === 'below') ctx.fail(rel, 'the reviewer example\'s GSD floor is below ' + INSTALLED_LANE_FLOOR.join('.') + ' (#4209)');
      if (status === 'unrecognised') ctx.fail(rel, 'the reviewer example has an unrecognised engines range');
    };
    for (const rel of REGISTRY_EXAMPLE_PAGES) {
      const example = ctx.doc(rel).slice('"id": "acme-review-lane"', '"install"');
      const engines = /"enginesGsd": "([^"]*)"/.exec(example.text);
      checkFloor(rel, engines && engines[1]);
    }

    // The lane how-to: version, where an installed lane runs, what it receives, its worked example.
    const ship = ctx.doc(SHIP);
    const shipRoleRow = ship.text.split('\n').find((line) => line.startsWith('| Your tool only reviews'));
    const shipRoleExamples = shipRoleRow
      ? [...shipRoleRow.matchAll(/\x60([^\x60]+)\x60/g)].map((m) => m[1]).filter((id) => id !== 'role: "reviewer"')
      : [];
    const invalidShipRoleExamples = shipRoleExamples.filter((id) => !reviewerIds.includes(id));
    if (!shipRoleRow || invalidShipRoleExamples.length || new Set(shipRoleExamples).size !== shipRoleExamples.length) {
      ctx.fail(SHIP, 'reviewer-role examples are not in the reviewer capability registry (extra: ' + (invalidShipRoleExamples.join(', ') || 'duplicate') + ')');
    }
    const prereq = /GSD (\d+\.\d+\.\d+) or later/.exec(ship.text);
    checkFloor(SHIP, prereq && '>=' + prereq[1]);
    for (const m of jsonBlocks(ship.text).filter((j) => j && j.reviewer && j.engines)) checkFloor(SHIP, m.engines.gsd);
    const develop = ctx.doc('docs/how-to/develop-a-capability.md');
    const developClaim = /Ship a reviewer lane in your capability[^\n]*\(GSD (\d+\.\d+\.\d+)\+\)/.exec(develop.text);
    checkFloor('docs/how-to/develop-a-capability.md', developClaim && '>=' + developClaim[1]);
    ship.slice('Then dry-check the invocation plan', '\n## ')
      .has(fence('bash', '/gsd-code-review 3 --acme'), 'the worked example runs the lane with /gsd-code-review');
    ship.has('## Where an installed lane runs', 'the lane how-to says where an installed lane runs');
    const where = ship.slice('## Where an installed lane runs', '\n## ')
      .has('/gsd-code-review <phase> --<your-flag>', 'the lane how-to names /gsd-code-review for an installed lane');
    const whereText = where.text.replace(/\n(?!\n|- )/g, ' ');
    const request = whereText.split('\n').find((line) => line.includes('It sends a source-review request'));
    const fields = ['repository root', 'file paths', 'review depth', 'base SHA', 'not plan text'];
    if (!request || fields.some((f) => !request.includes(f))) {
      ctx.fail(SHIP, 'an installed lane receives a source-review request (' + fields.join(', ') + ')');
    }
    ship
      .has(tick('/gsd-code-review') + ' refuses ' + tick('none'), 'the how-to says /gsd-code-review refuses promptChannel none')
      .has('only if it finds the host recorded at consent', 'the host check is conditional on a host recorded at consent')
      .lacks(/default_reviewers\x60? entries/, 'an installed lane is not a review.default_reviewers entry')
      .lacks('sends: plan text', 'the install disclosure does not claim a fixed plan-text payload');
    for (const rel of LINK_PAGES) ctx.doc(rel).has('/gsd-code-review <phase> --<flag>', 'the link to the lane how-to names /gsd-code-review');

    // The cross-AI guide: sequential by default; model provenance and effort wording; no-model-key lanes.
    const setup = ctx.doc(SETUP)
      .lacks('Run every available reviewer in parallel', 'reviewers do not run in parallel by default')
      .has('Reviewers still run one at a time unless ' + tick('review.parallel_lanes') + ' is ' + tick('true'), 'the guide says reviewers run one at a time by default')
      .has('Each of those is a reviewer lane that ships with GSD, and ' + tick('/gsd-review') + ' selects from them.', 'the guide distinguishes shipped lanes from installed lanes');
    const provenance = setup.slice('### Which model produced a review', '\n#')
      .lacks('driven by your ' + tick('effort.*') + ' config', 'reviewer effort keys are review.effort.<slug>')
      .has('the reasoning effort GSD rendered onto that lane', 'the effort suffix is the level GSD rendered');
    for (const sentence of provenance.text.split(/(?<=[.;])\s+/)) {
      if (sentence.includes(tick('pinned')) && /\b(?:set|sets|setting|pin it|pinning)\b/i.test(sentence)) {
        ctx.fail(SETUP, 'setting a model key does not promise a pinned provenance');
      }
    }
    const rosterLine = setup.text.split('\n').find((line) => line.startsWith('GSD Core can route review requests'));
    const rosterNames = rosterLine
      ? rosterLine.slice(rosterLine.indexOf(':') + 1).replace(/\([^)]*\)/g, '').replace(/\.$/, '').replace(/\s+and\s+/g, ',').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
      : [];
    const rosterLanes = rosterNames.map((name) => {
      const lane = REVIEWER_LANES.find((item) => {
        const section = item.reviewsSection.toLowerCase();
        return name === section || name === section + ' cli' || name === section + ' code';
      });
      return lane ? lane.slug : name;
    });
    const rosterDiff = setDiff(REVIEWER_LANES.map((lane) => lane.slug).sort(), rosterLanes.slice().sort());
    if (!rosterLine || rosterDiff.missing.length || rosterDiff.extra.length || new Set(rosterLanes).size !== rosterLanes.length) {
      ctx.fail(SETUP, 'the cross-AI guide shipped roster differs from REVIEWER_LANES ' + describeDiff(rosterDiff));
    }
    const laneCountWords = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve' };
    const laneCountWord = laneCountWords[REVIEWER_LANES.length] || String(REVIEWER_LANES.length);
    ctx.doc('docs/how-to/list-your-reviewer-lane.md').has('None of the ' + laneCountWord + ' first-party lanes', 'the first-party lane count matches REVIEWER_LANES');
    const noModel = REVIEWER_LANES.filter((l) => !l.modelConfigKey).map((l) => l.slug).sort();
    const listed = /lanes that declare no model key \(([^)]*)\)/.exec(setup.text);
    const named = listed ? [...listed[1].matchAll(/\x60([^\x60]+)\x60/g)].map((m) => m[1]).sort() : null;
    if (!named || named.join() !== noModel.join()) ctx.fail(SETUP, 'the lanes that declare no model key are ' + noModel.join(', '));

    // The configuration reference: two model tables, each with exactly the schema's keys and defaults.
    const configDoc = ctx.doc(CONFIG);
    const shippedKeysText = configDoc.slice('The shipped model keys are', '; an installed capability').text;
    const documentedKeys = [...shippedKeysText.matchAll(/\x60([^\x60]+)\x60/g)].map((m) => m[1]).sort();
    const keyDiff = setDiff(schemaModelKeys.map((k) => k.slice('review.models.'.length)), documentedKeys);
    if (keyDiff.missing.length || keyDiff.extra.length) ctx.fail(CONFIG, 'the shipped model-key list differs from configSchema ' + describeDiff(keyDiff));
    const modelTables = tables(configDoc.text)
      .map((rows) => rows.filter((cells) => cells[1] === 'string' && cells[0].startsWith('\x60review.models.')))
      .filter((rows) => rows.length > 0);
    if (modelTables.length !== 2) ctx.fail(CONFIG, 'found ' + modelTables.length + ' review.models tables, want 2');
    for (const rows of modelTables) {
      const keys = rows.map((cells) => untick(cells[0]));
      const diff = setDiff(schemaModelKeys, keys.slice().sort());
      if (diff.missing.length || diff.extra.length) ctx.fail(CONFIG, 'a review.models table differs from configSchema ' + describeDiff(diff));
      if (keys.length !== new Set(keys).size) ctx.fail(CONFIG, 'a review.models table contains a duplicate key row');
      for (const cells of rows) {
        const key = untick(cells[0]);
        if (!configSchema[key]) continue;
        const want = tick(JSON.stringify(configSchema[key].default));
        if (cells[2] !== want) ctx.fail(CONFIG, key + ' default is ' + cells[2] + ', want ' + want);
      }
    }

    // The manifest reference: counts, role rules and the reviewer field table.
    const caps = Object.values(capabilities);
    const roles = {};
    for (const cap of caps) roles[cap.role] = (roles[cap.role] || 0) + 1;
    const laneFields = Object.keys(REVIEWER_LANES[0]).sort();
    for (const lane of REVIEWER_LANES) {
      if (Object.keys(lane).sort().join() !== laneFields.join()) ctx.fail(MANIFEST, 'lane ' + lane.slug + ' carries a different field set from ' + REVIEWER_LANES[0].slug);
    }
    const flags = REVIEWER_LANES.flatMap((lane) => lane.flags);
    const manifest = ctx.doc(MANIFEST)
      .has('. There are currently ' + reviewerIds.length + ': ' + reviewerIds.map(tick).join(', ') + '.', 'the reviewer-role list matches the registry')
      .has('Current role counts across ' + tick('capabilities/') + ': ' + ['feature', 'runtime', 'reviewer'].map((r) => tick(r) + ' ' + (roles[r] || 0)).join(', ') + '.', 'the role counts match the registry')
      .has('All ' + REVIEWER_LANES.length + ' shipped lane declarations carry all ' + laneFields.length + ' fields below.', 'the lane and field counts match REVIEWER_LANES')
      .has('. ' + REVIEWER_LANES.length + ' lanes declare ' + flags.length + ' flags in total.', 'the flag count matches REVIEWER_LANES')
      .has('**optional** on ' + tick('role: "runtime"'), 'a reviewer body is optional on role runtime')
      .has('**required** on ' + tick('role: "reviewer"'), 'a reviewer body is required on role reviewer')
      .has('**rejected** on ' + tick('role: "feature"'), 'a reviewer body is rejected on role feature');
    const roleRow = manifest.slice('- A third role, ' + tick('role: "reviewer"'), '\n\nCurrent role counts').text;
    const roleExamples = [...roleRow.matchAll(/\x60([^\x60]+)\x60/g)].map((m) => m[1]).filter((id) => id !== 'role: "reviewer"').sort();
    const roleDiff = setDiff(reviewerIds, roleExamples);
    if (roleDiff.missing.length || roleDiff.extra.length) ctx.fail(MANIFEST, 'the reviewer-role examples differ from the registry ' + describeDiff(roleDiff));
    if (['feature', 'runtime', 'reviewer'].reduce((sum, role) => sum + (roles[role] || 0), 0) !== caps.length) {
      ctx.fail(MANIFEST, 'the role counts do not cover every capability');
    }
    const fieldTables = tables(manifest.slice('## Reviewer body', '**' + tick('handler') + ' is a closed enum').text);
    const rowKeys = fieldTables.flat().map((cells) => untick(cells[0])).sort();
    const duplicateFields = rowKeys.filter((field, index) => rowKeys.indexOf(field) !== index);
    const diff = setDiff(laneFields, rowKeys);
    if (fieldTables.length !== 1) ctx.fail(MANIFEST, 'found ' + fieldTables.length + ' reviewer field tables, want 1');
    if (duplicateFields.length) ctx.fail(MANIFEST, 'the reviewer field table duplicates rows: ' + [...new Set(duplicateFields)].join(', '));
    if (diff.missing.length || diff.extra.length) {
      ctx.fail(MANIFEST, 'the reviewer field table rows differ from REVIEWER_LANES ' + describeDiff(diff));
    }
  },
};
