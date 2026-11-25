'use strict';

// The orchestrator-worktree process spawn carries the gsd-executor identity and execution contract (#3637): the
// single `text` fence of executor-isolation-dispatch.md is the prompt template, with the required-reading contract
// (plan path, scope-resolved placeholders, no root .planning/ literals), the execution-context embeds, the
// gitignored-skip success path that forbids `git add -f`, the role definition and prior-wave summaries, and the
// persona. Also (#5531) the substitution instruction names every placeholder a fenced block uses, the template
// sits in no bash block, it carries the two guard markers, the conditional embed line is replaced whole, and the
// wave name shape matches execute-phase.md; (#5934) quick-batch gives every substituted placeholder a value or a
// stated not-applicable. Was tests/executor-isolation-prompt-contract.test.cjs. It uses the same helpers as the
// test (the fenced-block scanner, substitutePlaceholders). The bare "created AND committed" probe is a line walk.

const path = require('node:path');

const DISPATCH = 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md';
const QUICK_STEP = 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md';
const TDD_EMBED_TERNARY = '${TDD_APPLICABLE ? "- tdd.md" : ""}';
const CREATED_AND_COMMITTED = 'SUMMARY.md created AND committed';
const MIN_PLACEHOLDERS = 7;
const MAX_MAPPED_VALUE = 80;
const SECTIONIZER = path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs');
const SHELLCHECK_LINT = path.join(__dirname, '..', '..', 'lint-workflow-shellcheck.cjs');

// Every "`{inner}`" of a line (a brace pair in backticks, no backtick or closing brace inside), as "{inner}".
function backtickedBraces(line) {
  const out = [];
  let at = line.indexOf('`');
  while (at !== -1) {
    if (line[at + 1] === '{') {
      const close = line.indexOf('}', at + 2);
      if (close > at + 2 && line[close + 1] === '`' && !line.slice(at + 2, close).includes('`')) {
        out.push(line.slice(at + 1, close + 1));
        at = line.indexOf('`', close + 2);
        continue;
      }
    }
    at = line.indexOf('`', at + 1);
  }
  return out;
}

// Every "{name}" of the text where name is a lowercase letter then lowercase letters and underscores, as "name".
function bracedNames(text) {
  const out = [];
  let at = text.indexOf('{');
  while (at !== -1) {
    let end = at + 1;
    if (/[a-z]/.test(text[end] || '')) {
      end += 1;
      while (end < text.length && /[a-z_]/.test(text[end])) end += 1;
      if (text[end] === '}') {
        out.push(text.slice(at + 1, end));
        at = text.indexOf('{', end + 1);
        continue;
      }
    }
    at = text.indexOf('{', at + 1);
  }
  return out;
}

// The prompt template: the one `text` fence the orchestrator writes to PROMPT_FILE, or the reason there is none. A
// fence is any line whose trim is the text fence opener (what the test counted, whatever its indentation or
// surroundings) or a text-info-string block of the sectionizer's fence scan (backtick or tilde, any letter case); the
// two sets are joined and must hold exactly one, and that one must be a closed block of the scan.
function promptBody(text) {
  const lines = text.split('\n');
  const blocks = require(SECTIONIZER).scanFencedBlocks(lines).filter((block) => block.infoString.trim().toLowerCase() === 'text');
  const opened = new Set(blocks.map((block) => block.openLineIdx));
  lines.forEach((line, index) => {
    if (line.trim() === '```text') opened.add(index);
  });
  if (opened.size !== 1) return { error: `the fragment must hold exactly one text fence (the prompt template), found ${opened.size}` };
  const block = blocks.find((candidate) => opened.has(candidate.openLineIdx));
  if (!block || block.closeLineIdx === -1) return { error: 'the text fence must close' };
  return { body: `${lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n')}\n` };
}

// The fence error is reported once, by the first check of the contract; the checks on the template pass without it.
const onBody = (check) => (text) => {
  const prompt = promptBody(text);
  return prompt.error ? true : check(prompt.body);
};

const has = (pattern, miss) => onBody((body) => pattern.test(body) || miss);

// Every occurrence of the unconditional criterion must be followed, on its line, by OR.
function bareCreatedAndCommitted(body) {
  for (const line of body.split('\n')) {
    let from = line.indexOf(CREATED_AND_COMMITTED);
    while (from !== -1) {
      const rest = line.slice(from + CREATED_AND_COMMITTED.length);
      if (!rest.includes('OR')) return true;
      from = line.indexOf(CREATED_AND_COMMITTED, from + 1);
    }
  }
  return false;
}

// Does the bullet map `{name}` to a short backticked value ("`{name}` = `value`")?
function mapsPlaceholder(bullet, name) {
  const token = `\`{${name}}\``;
  let from = bullet.indexOf(token);
  while (from !== -1) {
    let i = from + token.length;
    while (i < bullet.length && /\s/.test(bullet[i])) i += 1;
    if (bullet[i] === '=') {
      i += 1;
      while (i < bullet.length && /\s/.test(bullet[i])) i += 1;
      if (bullet[i] === '`') {
        let length = 0;
        let j = i + 1;
        while (j < bullet.length && bullet[j] !== '`' && bullet[j] !== '\n') {
          length += 1;
          j += 1;
        }
        if (bullet[j] === '`' && length >= 1 && length <= MAX_MAPPED_VALUE) return true;
      }
    }
    from = bullet.indexOf(token, from + 1);
  }
  return false;
}

module.exports = {
  id: 'executor-isolation-prompt-contract',
  issue: '#3637',
  check(ctx) {
    let placeholders = [];
    ctx.doc(DISPATCH)
      .satisfies((text) => promptBody(text).error || true, 'the prompt template must be exactly one closed text fence')
      .satisfies(has(/<required_reading>/, 'no <required_reading>'), 'the prompt must carry the required-reading contract')
      .satisfies(has(/\{phase_dir\}\/\{plan_file\}/, 'no {phase_dir}/{plan_file}'), 'the prompt must name the explicit plan path')
      .satisfies(has(/\{project_rel\}/, 'no {project_rel}'), 'project context is required reading')
      .satisfies(has(/\{state_rel\}/, 'no {state_rel}'), 'state is required reading')
      .satisfies(has(/\{config_rel\}/, 'no {config_rel}'), 'config is required reading')
      .satisfies(onBody((body) => !/\.planning\/(?:PROJECT|STATE)\.md|\.planning\/config\.json/.test(body) || 'a root .planning/ literal is present'), 'no root .planning/ literal in required reading')
      .satisfies(has(/<execution_context>/, 'no <execution_context>'), 'the prompt must carry an execution_context block')
      .satisfies(has(/execute-plan\.md/, 'no execute-plan.md'), 'execute-plan.md must be embedded (the executor workflow)')
      .satisfies(has(/worktree-path-safety\.md/, 'no worktree-path-safety.md'), 'worktree path safety must be embedded')
      .satisfies(has(/skipped_gitignored/, 'no skipped_gitignored'), 'skipped_gitignored must be named as an intentional success path')
      .satisfies(has(/git add -f/, 'no git add -f'), 'force-staging must be explicitly forbidden')
      .satisfies(onBody((body) => !bareCreatedAndCommitted(body) || 'the bare criterion is present'), 'the unconditional "created AND committed" criterion that drove git add -f must not appear bare')
      .satisfies(has(/agents\/gsd-executor\.md/, 'no agents/gsd-executor.md'), 'the role definition file must be named as an embedded source')
      .satisfies(has(/steps\s{0,20}0\/0a\/0b/, 'no steps 0/0a/0b'), 'the per-commit HEAD/cwd-drift/path-guard discipline must be pointed at')
      .satisfies(has(/prior_wave_summaries/, 'no prior_wave_summaries'), 'prior-wave SUMMARY files must be required reading on this parallel-wave backend')
      .satisfies(has(/\$\{AGENT_SKILLS\}/, 'no ${AGENT_SKILLS}'), 'the gsd-executor persona variable must be spliced into the prompt')
      .satisfies((text) => {
        const lines = text.split('\n');
        const sentence = lines.find((line) => line.includes('Before running each bash block below'));
        if (!sentence) return 'the substitution instruction does not exist';
        const { scanFencedBlocks } = require(SECTIONIZER);
        const blocks = scanFencedBlocks(lines);
        if (!blocks.every((block) => block.closeLineIdx !== -1)) return 'a fenced block of the fragment does not close';
        const named = backtickedBraces(sentence);
        if (named.length === 0) return 'the instruction names no placeholders';
        const { substitutePlaceholders } = require(SHELLCHECK_LINT);
        for (const block of blocks) {
          const body = lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n');
          const rest = named.reduce((acc, token) => acc.replaceAll(token, ''), body);
          if (substitutePlaceholders(rest) !== rest) return 'a placeholder of a fenced block is missing from the instruction';
        }
        return true;
      }, 'the substitution instruction must name every placeholder any fenced block of the fragment uses')
      .satisfies((text) => {
        const lines = text.split('\n');
        const { scanFencedBlocks } = require(SECTIONIZER);
        const bash = scanFencedBlocks(lines).filter((block) => block.infoString.trim().toLowerCase().split(/\s/)[0] === 'bash').map((block) => lines.slice(block.openLineIdx + 1, block.closeLineIdx === -1 ? lines.length : block.closeLineIdx).join('\n'));
        if (bash.length === 0) return 'the fragment holds no bash blocks';
        const inBash = ['<objective>', '<mcp_tools>', '[gsd:dispatch'].find((marker) => bash.some((body) => body.includes(marker)));
        return inBash ? `${inBash} sits in a bash block` : true;
      }, 'the template text must sit in no bash block')
      .has('with your file-writing tool and never through the shell', 'the template is written with the file tool, never through the shell')
      .satisfies(onBody((body) => {
        const missing = ['Inline the actual contents', '${TDD_APPLICABLE'].find((marker) => !body.includes(marker));
        return missing ? `the template does not carry ${missing}` : true;
      }), 'the template must carry the two markers that only the read-and-check guards look for')
      .satisfies(onBody((body) => {
        const line = body.split('\n').find((candidate) => candidate.startsWith(TDD_EMBED_TERNARY));
        if (!line) return 'the template holds no conditional embed line';
        return /\s#\s/.test(line) || 'the conditional line carries no trailing comment';
      }), 'the template must hold the conditional embed line with its trailing comment')
      .has('replace the whole line, its trailing `#` comment included, with `- tdd.md` when the verdict is `true` and with nothing otherwise', 'the instruction must replace the whole conditional line')
      .satisfies((text) => {
        const sentence = /Substitute this plan's([\s\S]{0,400}?)placeholders/.exec(text);
        if (!sentence) return 'the fragment must state its substitution list';
        placeholders = bracedNames(sentence[1]);
        return placeholders.length >= MIN_PLACEHOLDERS || `the substitution list names ${placeholders.length} placeholders, expected at least ${MIN_PLACEHOLDERS}`;
      }, "the fragment's substitution list must name at least the 7 known placeholders");

    ctx.doc('gsd-core/workflows/execute-phase.md')
      .has('mktemp "${TMPDIR:-/tmp}/gsd-worktree-wave-XXXXXX"', 'the manifest must be named gsd-worktree-wave-XXXXXX');

    const bullet = ctx.doc(QUICK_STEP).slice('**`isolation == "orchestrator-worktree"`:**', '**`isolation == "none"`:**');
    bullet
      .satisfies((text) => {
        const unmapped = placeholders.filter((name) => !text.includes(`{${name}}`));
        return unmapped.length === 0 || `the quick-batch step never names {${unmapped.join('}, {')}}`;
      }, 'the quick-batch step must name every placeholder the reused fragment substitutes')
      .satisfies((text) => {
        const lines = text.split('\n');
        const neither = placeholders.filter((name) => text.includes(`{${name}}`) && !mapsPlaceholder(text, name)
          && !lines.some((line) => line.includes(`\`{${name}}\``) && /\b(?:is|are) not applicable\b/.test(line)));
        return neither.length === 0 || `{${neither.join('}, {')}} has neither a mapped value nor a stated "not applicable"`;
      }, 'every orchestrator-worktree placeholder must have a mapped value or a stated not-applicable for a quick item')
      .has('Execute quick item ${quick_id}', 'the prompt header for a quick item must be stated')
      .has(/omit[^\n]{0,500}\[gsd:dispatch/i, 'the [gsd:dispatch ...] marker line must be stated as omitted for a quick item')
      .has(/`\{plan_padded\}`\s{0,20}=\s{0,20}`\$\{quick_id\}`/, '{plan_padded} must map to the quick id')
      .has('${ITEM_DIR}/${quick_id}-SUMMARY.md', 'the worker-record summary path must be spelled out');
  },
};
