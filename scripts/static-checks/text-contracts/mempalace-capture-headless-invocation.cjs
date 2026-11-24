'use strict';

// The headless mempalace-capture surfaces (the skill and the command) and the problems fragment: no `mempalace mine`
// command line carries --room (mine has no such flag, #2220); the staging instructions name mempalace.yaml, detect_room
// and .mempalace-stage; .gitignore excludes the staging directory; the embedded `rooms:` YAML block parses to at
// least five dict entries with a non-empty name (a bare-string list crashes the miner, #2414) and holds no bare-string
// entry; each surface has exactly two mine lines inside the daemon guard (#4700, #6266) and names queued and skipped
// captures; the problems fragment takes the same daemon route and never starts one. The behaviour of that snippet
// under bash with a stub stays in tests/mempalace-capture-headless-invocation.test.cjs. Was its text half.

const SURFACES = ['skills/gsd-mempalace-capture/SKILL.md', 'commands/gsd/mempalace-capture.md'];
const FRAGMENT = 'capabilities/mempalace/fragments/capture-problems.md';

const isWord = (ch) => ch !== undefined && /\w/.test(ch);

// `^\s*mempalace\s+mine\b`: a shell command line that invokes `mempalace mine`, not prose that mentions it.
function isMineCommand(line) {
  const start = line.trimStart();
  if (!start.startsWith('mempalace')) return false;
  const rest = start.slice('mempalace'.length);
  const body = rest.trimStart();
  return body.length < rest.length && body.startsWith('mine') && !isWord(body[4]);
}

const mineLines = (text) => text.split('\n').filter(isMineCommand);

// The `rooms:` block of the embedded heredoc, from the `rooms:` line up to the `YAML` sentinel line, or null.
function roomsBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'rooms:');
  if (start === -1) return null;
  const end = lines.findIndex((line, at) => at > start && line.trim() === 'YAML');
  return end === -1 ? null : lines.slice(start, end).join('\n');
}

// `^\s*-\s+WORD\s*$` with WORD a letter then letters, digits, underscores or hyphens: a bare-string list entry.
function isBareEntry(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('-') || !/\s/.test(trimmed[1] ?? '')) return false;
  const word = trimmed.slice(1).trim();
  return word !== '' && /[A-Za-z]/.test(word[0]) && [...word].every((ch) => /[A-Za-z0-9_-]/.test(ch));
}

// The lines from the #6266 daemon-route comment to the `fi` that closes the daemon guard, or a reason.
function snippetOf(text) {
  const lines = text.split('\n');
  const from = lines.findIndex((line) => line.includes('#6266: use the daemon route only when'));
  if (from === -1) return 'the #6266 daemon-route comment must be present';
  const to = lines.findIndex((line, at) => at > from && line.trim() === 'fi');
  if (to === -1) return 'the daemon guard must be closed by fi';
  return lines.slice(from, to + 1);
}

// js-yaml, loaded through a function so a load failure is a finding of its own (not a parse error).
function loadYaml(loader = () => require('js-yaml')) {
  try {
    return { yaml: loader() };
  } catch (err) {
    return { error: `js-yaml cannot be loaded: ${err.message}` };
  }
}

function buildCheck(loadYamlFn = loadYaml) {
  return (ctx) => {
    for (const rel of SURFACES) {
      ctx.doc(rel)
        .satisfies((text) => {
          const offender = mineLines(text).find((line) => line.includes('--room'));
          return offender === undefined || `offending line: ${offender.trim()}`;
        }, `${rel}: a "mempalace mine" command must not include --room (mine has no such flag per the CLI reference)`)
        .has('mempalace.yaml', `${rel}: must reference mempalace.yaml for room taxonomy`)
        .has('detect_room', `${rel}: must reference detect_room() as the room-assignment mechanism`)
        .has('.mempalace-stage', `${rel}: must use the .mempalace-stage staging directory`)
        .satisfies((text) => {
          const block = roomsBlock(text);
          if (block === null) return 'could not locate a rooms: YAML block';
          const loaded = loadYamlFn();
          if (loaded.error) return loaded.error;
          // The parsed values of the raw bare-entry lines (a word, null, a boolean): the bare-entry assertion below reports
          // those, this one the other non-dict entries.
          const bareValues = block.split('\n').filter(isBareEntry).flatMap((line) => {
            try {
              return [loaded.yaml.load(line.trim().slice(1).trim())];
            } catch {
              return [];
            }
          });
          let parsed;
          try {
            parsed = loaded.yaml.load(block);
          } catch (err) {
            return `the rooms: block is not valid YAML: ${err.message}`;
          }
          if (!(parsed && Array.isArray(parsed.rooms))) return 'rooms: must parse to an array';
          if (parsed.rooms.length < 5) return `expected the GSD room taxonomy (at least 5 rooms), got ${parsed.rooms.length}`;
          for (const [at, entry] of parsed.rooms.entries()) {
            if (bareValues.some((value) => Object.is(value, entry))) continue; // a bare entry is reported once, below
            if (!(entry !== null && typeof entry === 'object' && !Array.isArray(entry))) return `rooms:[${at}] must be a dict, got ${JSON.stringify(entry)}`;
            if (!(typeof entry.name === 'string' && entry.name.length > 0)) return `rooms:[${at}] must have a non-empty name string`;
          }
          return true;
        }, `${rel}: every rooms: entry must be a dict with a name key (a bare-string list crashes the miner's detect_room, #2414)`)
        .satisfies((text) => {
          const block = roomsBlock(text);
          if (block === null) return true; // reported once by the assertion above
          const bare = block.split('\n').filter(isBareEntry);
          return bare.length === 0 || `offenders: ${JSON.stringify(bare)}`;
        }, `${rel}: the rooms: block must not contain bare-string entries (the pre-fix shape, #2414)`)
        .satisfies((text) => {
          const count = mineLines(text).length;
          if (count !== 2) return `found ${count} mempalace mine lines, expected one guarded daemon mine and one plain mine`;
          const snippet = snippetOf(text);
          if (typeof snippet === 'string') return snippet;
          const inside = snippet.filter(isMineCommand).length;
          return inside === 2 || `the daemon guard holds ${inside} mempalace mine lines, expected 2`;
        }, `${rel}: every mempalace mine line must sit inside the daemon guard`)
        .has('queued', `${rel}: the report must name queued captures`)
        .has(/skipped/i, `${rel}: the report must name skipped captures`)
        .has('interactive run must never start the daemon', `${rel}: the surface must say an interactive run never starts the daemon`);
    }

    ctx.doc(FRAGMENT)
      .satisfies((text) => {
        const offender = mineLines(text).find((line) => line.includes('--room'));
        return offender === undefined || `offending line: ${offender.trim()}`;
      }, 'capture-problems.md: a "mempalace mine" command must not include --room')
      .has('`--daemon --background` only when `mempalace daemon status` already reports a running daemon, never starting one', 'the execute:post problems fragment must take the same daemon route and never start a daemon (#6266)')
      .lacks('the background queue defers the write', 'the queue claim is true only with a running daemon')
      .lacks('mempalace mine --daemon --background', 'the unconditional daemon invocation must not return');

    ctx.doc('.gitignore').has('.mempalace-stage/', '.gitignore must exclude .planning/.mempalace-stage/');
  };
}

module.exports = {
  id: 'mempalace-capture-headless-invocation',
  issue: '#2220',
  walkers: { isMineCommand, isBareEntry, roomsBlock, loadYaml, buildCheck },
  check: buildCheck(),
};
