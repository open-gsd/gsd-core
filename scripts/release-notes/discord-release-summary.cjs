#!/usr/bin/env node
'use strict';

const cp = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('../lib/cli-exit.cjs');
const { classifyTitle } = require('./format-github-release-notes.cjs');

const DEFAULT_MAX_CONTENT = 1850;
const SECTION_LIMITS = Object.freeze([
  ['Breaking', 4],
  ['Security', 4],
  ['Feature', 4],
  ['Fix', 4],
  ['Enhancement', 3],
  ['Internal', 2],
  ['New Contributors', 3],
]);

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

function releaseTag(release) {
  return release.tagName || release.tag_name || release.name || 'release';
}

function releaseName(release) {
  return release.name || releaseTag(release);
}

function releaseUrl(release) {
  return release.url || release.html_url || '';
}

function releaseIsPrerelease(release) {
  return release.isPrerelease === true || release.prerelease === true || /-/.test(releaseTag(release));
}

function loadPackageName(repoRoot = path.resolve(__dirname, '..', '..')) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return pkgJson.name || 'package';
}

function normalizeHeading(value) {
  const heading = value.trim().replace(/:$/, '');
  const lower = heading.toLowerCase();

  if (lower.includes('breaking')) return 'Breaking';
  if (lower.includes('security')) return 'Security';
  if (lower === 'feature' || lower === 'features') return 'Feature';
  if (lower === 'fix' || lower === 'fixes' || lower === 'bug fixes') return 'Fix';
  if (lower === 'enhancement' || lower === 'enhancements' || lower === 'improvements') return 'Enhancement';
  if (lower === 'internal' || lower === 'maintenance') return 'Internal';
  if (lower === 'new contributors') return 'New Contributors';
  if (lower === "what's changed" || lower === 'whats changed') return "What's Changed";
  return heading;
}

function collectSections(body) {
  const sections = new Map();
  let current = null;

  for (const line of normalizeNewlines(body).split('\n')) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^#{2,3}\s+(.+)$/);

    if (heading) {
      current = normalizeHeading(heading[1]);
      continue;
    }

    const bullet = trimmed.match(/^([*-])\s+(.+)$/);
    if (!bullet || !current) continue;

    let section = current;
    if (section === "What's Changed") {
      section = classifyTitle(trimmed);
    }

    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(cleanBullet(trimmed));
  }

  return sections;
}

function cleanBullet(value) {
  let text = String(value)
    .replace(/^[*-]\s+/, '')
    .replace(/\s+by\s+@[A-Za-z0-9-]+\s+in\s+https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g, ' (#$1)')
    .replace(/\[([^\]]+)\]\((https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/(\d+))\)/g, '$1 (#$3)')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g, '#$1')
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/g, '#$1')
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/([0-9a-f]{7})[0-9a-f]*/gi, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  text = text
    .replace(/^\[codex\]\s+/i, '')
    .replace(/^(?:feat|fix|docs|chore|ci|refactor|test)(?:\([^)]+\))?!?:\s+/i, '');
  text = text.replace(/#(\d+)\s+\(#\1\)/g, '#$1');
  text = text.replace(/\s+\(#(\d+)\)\s+\(#\1\)$/g, ' (#$1)');

  return truncateAtWord(text, 220);
}

function truncateAtWord(value, maxLength) {
  if (value.length <= maxLength) return value;
  const splitAt = value.lastIndexOf(' ', maxLength - 3);
  if (splitAt < 80) return `${value.slice(0, maxLength - 3)}...`;
  return `${value.slice(0, splitAt)}...`;
}

function extractInstallCommand(body, packageName, release) {
  const lines = normalizeNewlines(body).split('\n');
  let inInstall = false;
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^##\s+Install\b/i.test(trimmed)) {
      inInstall = true;
      continue;
    }

    if (inInstall && /^##\s+/.test(trimmed)) break;
    if (!inInstall) continue;

    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }

    if (inFence && /^npm\s+(?:i|install)\s+/.test(trimmed)) {
      return trimmed;
    }
  }

  const channel = releaseIsPrerelease(release) ? 'next' : 'latest';
  return `npm i ${packageName}@${channel}`;
}

function buildDiscordReleasePayload({ release, packageName = loadPackageName(), maxContent = DEFAULT_MAX_CONTENT }) {
  const tag = releaseTag(release);
  const name = releaseName(release);
  const url = releaseUrl(release);
  const prerelease = releaseIsPrerelease(release);
  const channel = prerelease ? 'next' : 'latest';
  const body = release.body || '';
  const sections = collectSections(body);
  const footer = url ? `Full changelog: ${url}` : `Full changelog: ${tag}`;
  const baseLines = [
    `**${packageName} ${name}${prerelease ? ' pre-release' : ''} is out**`,
    '',
    'Install:',
    `\`${extractInstallCommand(body, packageName, release)}\``,
  ];

  const lines = baseLines.slice();
  for (const [section, limit] of SECTION_LIMITS) {
    appendSection(lines, section, sections.get(section) || [], limit, footer, maxContent);
  }

  if (lines.length === baseLines.length) {
    appendLineGroup(lines, ['', 'No release notes were provided.'], footer, maxContent);
  }

  if (joinedLength(lines, footer) > maxContent) {
    while (lines.length > baseLines.length && joinedLength(lines, footer) > maxContent) {
      lines.pop();
    }
  }

  const content = [...lines, '', footer].join('\n');
  return {
    username: 'GSD Releases',
    content,
    embeds: [
      {
        title: 'Release details',
        url: url || undefined,
        color: prerelease ? 0xd9a441 : 0x2f9e44,
        fields: [
          { name: 'Package', value: `\`${packageName}\``, inline: true },
          { name: 'Channel', value: `\`${channel}\``, inline: true },
          { name: 'Version', value: `\`${tag}\``, inline: true },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function appendSection(lines, section, bullets, limit, footer, maxContent) {
  if (bullets.length === 0) return;

  const label = sectionLabel(section);
  const selected = [];
  for (const bullet of bullets.slice(0, limit)) {
    const candidate = ['', `**${label}**`, ...selected.map((item) => `- ${item}`), `- ${bullet}`];
    if (joinedLength([...lines, ...candidate], footer) > maxContent) break;
    selected.push(bullet);
  }

  if (selected.length === 0) return;

  const group = ['', `**${label}**`, ...selected.map((item) => `- ${item}`)];
  const remaining = bullets.length - selected.length;
  if (remaining > 0) {
    const moreLine = `- ...and ${remaining} more ${label.toLowerCase()}`;
    if (joinedLength([...lines, ...group, moreLine], footer) <= maxContent) {
      group.push(moreLine);
    }
  }

  appendLineGroup(lines, group, footer, maxContent);
}

function appendLineGroup(lines, group, footer, maxContent) {
  if (joinedLength([...lines, ...group], footer) <= maxContent) {
    lines.push(...group);
  }
}

function joinedLength(lines, footer) {
  return [...lines, '', footer].join('\n').length;
}

function sectionLabel(section) {
  if (section === 'Feature') return 'Features';
  if (section === 'Fix') return 'Fixes';
  if (section === 'Enhancement') return 'Enhancements';
  return section;
}

function fetchRelease({ tag, repo, latest = false }) {
  const args = ['release', 'view'];
  if (!latest && tag) args.push(tag);
  args.push('--json', 'tagName,name,isPrerelease,body,url');
  if (repo) args.push('--repo', repo);
  const raw = cp.execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(raw);
}

async function postWebhook(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new ExitError(1, `Discord webhook failed with ${response.status}: ${await response.text()}`);
  }
}

function parseArgs(argv) {
  const opts = {
    tag: null,
    repo: null,
    latest: false,
    stdin: false,
    post: false,
    json: false,
    allowMissingWebhook: false,
    packageName: null,
    maxContent: DEFAULT_MAX_CONTENT,
  };

  const args = argv.slice();
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--tag') {
      opts.tag = requireValue(args, arg);
    } else if (arg === '--repo') {
      opts.repo = requireValue(args, arg);
    } else if (arg === '--package') {
      opts.packageName = requireValue(args, arg);
    } else if (arg === '--max-content') {
      opts.maxContent = Number(requireValue(args, arg));
    } else if (arg === '--latest') {
      opts.latest = true;
    } else if (arg === '--stdin') {
      opts.stdin = true;
    } else if (arg === '--post') {
      opts.post = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--allow-missing-webhook') {
      opts.allowMissingWebhook = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/release-notes/discord-release-summary.cjs [--tag <tag>|--latest|--stdin] [options]\n' +
        '\n' +
        'Options:\n' +
        '  --tag <tag>                 GitHub release tag to announce\n' +
        '  --latest                    Announce the latest GitHub release\n' +
        '  --stdin                     Read release JSON from stdin\n' +
        '  --repo <owner/repo>          Repository for gh release view\n' +
        '  --package <name>             Package name override\n' +
        '  --post                      POST to DISCORD_WEBHOOK_URL\n' +
        '  --allow-missing-webhook      Warn and skip instead of failing when posting without a webhook\n' +
        '  --json                      Print webhook payload JSON instead of content preview\n' +
        '  --max-content <n>            Max Discord content characters before webhook footer\n'
      );
      throw new ExitError(0);
    } else {
      throw new ExitError(2, `error: unknown argument ${arg}`);
    }
  }

  if (!Number.isFinite(opts.maxContent) || opts.maxContent < 500 || opts.maxContent > 2000) {
    throw new ExitError(2, 'error: --max-content must be between 500 and 2000');
  }

  return opts;
}

function requireValue(args, flag) {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ExitError(2, `error: ${flag} requires a value`);
  }
  return value;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let release;

  if (opts.stdin) {
    release = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  } else {
    release = fetchRelease(opts);
  }

  const payload = buildDiscordReleasePayload({
    release,
    packageName: opts.packageName || loadPackageName(),
    maxContent: opts.maxContent,
  });

  if (opts.post) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      if (opts.allowMissingWebhook) {
        process.stderr.write('warning: DISCORD_WEBHOOK_URL is not set; skipping Discord announcement\n');
      } else {
        throw new ExitError(1, 'error: DISCORD_WEBHOOK_URL is not set');
      }
    } else {
      await postWebhook(webhookUrl, payload);
    }
  }

  process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.content}\n`);
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  buildDiscordReleasePayload,
  cleanBullet,
  collectSections,
  extractInstallCommand,
};
