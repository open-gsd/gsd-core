/**
 * Static frontend-evidence detector — plan-time structural corroboration for the
 * UI plan gate (#3312).
 *
 * `checkUiPresence` (ui-safety-gate.cjs) is a *vocabulary* signal: a hyphen is a
 * word boundary, so a phase section naming the repo `dashboard-financeiro` matches
 * the token `dashboard` exactly like the real UI compound `micro-frontend` does.
 * That boundary rule is intentional (#3718) and must not be weakened — instead,
 * the plan gate (`computeUiPlanGate` in gate-ui-plan.cjs) corroborates the
 * token match against the static repo tree before blocking.
 *
 * This mirrors what the sibling post-wave gate (`computeUiSafetyGate`) already
 * does dynamically: it blocks only when `git diff HEAD~1 HEAD` touches UI files.
 * Plan time has no diff to inspect, so the corroboration here is static:
 *
 *   (a) a `package.json` (root) with a known UI-framework dependency — a project
 *       that ships react/vue/svelte/... in its manifest is a frontend regardless
 *       of file layout;
 *   (b) any `*.tsx` / `*.jsx` / `*.vue` / `*.svelte` file in the tree — the
 *       component-framework subset of `UI_FILE_EXTENSIONS_RE`
 *       (gate-ui-safety.cjs). The weaker members of that list (css, scss,
 *       html, ...) are deliberately NOT static evidence: docs sites and
 *       markdown/bash/config repos routinely carry stray `.html`/`.css`, which
 *       is precisely the false-positive class #3312 reports.
 *   (c) any `*.xaml` file, or a `*.swift` / `*.kt` / `*.dart` file whose
 *       content carries its ecosystem's UI-framework import marker
 *       (`import SwiftUI` / `import UIKit`, `androidx.compose`,
 *       `package:flutter`) (#4658). Native UI projects (SwiftUI, Jetpack
 *       Compose, Flutter, .NET MAUI) carry neither (a) nor (b), which made the
 *       gate structurally unreachable for them. Source files match on the
 *       IMPORT, not the extension alone — the same unambiguity bar that
 *       justifies (b)'s subset and excludes (css, scss, html): a non-UI Swift
 *       package (a CLI, a server) imports Foundation, not SwiftUI, and must
 *       stay silent. `.xaml` is extension-alone for the same reason `.tsx` is —
 *       the extension itself is unambiguous. Marker matching is case-sensitive
 *       (imports are case-sensitive in all four ecosystems); extension
 *       matching is case-insensitive, mirroring `UI_COMPONENT_FILE_RE`.
 *
 * #5170 (ADR-5057 §4): the detector reads typed evidence. An affirmative finding is
 * `found`; a walk that completed without one is `none`; a `package.json` that exists but cannot be
 * read or parsed, a directory that cannot be listed or a native source file that cannot be opened
 * is `unreadable` WHEN no affirmative evidence was found — the gate that consumes this must not
 * certify "no frontend" over a tree it could not look at. Never throws.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  evidenceFound,
  evidenceFromError,
  evidenceNone,
  evidenceUnreadable,
  readDirEntriesEvidence,
  readTextEvidence,
} from './gate-evidence.cjs';
import type { Evidence } from './gate-evidence.cjs';

/** Component-framework file extensions — the static-evidence subset of UI_FILE_EXTENSIONS_RE. */
export const UI_COMPONENT_FILE_RE = /\.(tsx|jsx|vue|svelte)$/i;

/** Native UI source files whose CONTENT is scanned for an import marker (#4658). */
export const NATIVE_UI_SOURCE_RE = /\.(swift|kt|dart)$/i;

/** Native UI files that are evidence by extension alone — `.xaml`, the `.tsx` analogue. */
export const NATIVE_UI_XAML_RE = /\.xaml$/i;

/**
 * Per-extension UI-framework import markers for `NATIVE_UI_SOURCE_RE` files
 * (#4658). Every marker embeds its ecosystem's import keyword, so a bare
 * framework-name mention in prose or a comment is not evidence; the Dart
 * marker carries both legal quote styles. Case-sensitive: imports are
 * case-sensitive in Swift, Kotlin and Dart.
 */
export const NATIVE_UI_CONTENT_MARKERS: Readonly<Record<string, readonly string[]>> = {
  '.swift': ['import SwiftUI', 'import UIKit'],
  '.kt': ['import androidx.compose'],
  '.dart': ["import 'package:flutter", 'import "package:flutter'],
};

/**
 * UI-framework package.json dependencies (dependencies OR devDependencies).
 * Component frameworks/renderers only — deliberately excludes meta tooling
 * (typescript, eslint, ...) that non-frontend Node projects also carry.
 */
const UI_FRAMEWORK_DEPS: ReadonlySet<string> = new Set([
  'react',
  'react-dom',
  'vue',
  'svelte',
  '@sveltejs/kit',
  'angular',
  '@angular/core',
  'preact',
  'solid-js',
  'lit',
  'lit-element',
  'ember-source',
  '@remix-run/react',
  'react-native',
  'expo',
  'next',
  'nuxt',
  'gatsby',
  'astro',
  '@ionic/react',
  '@ionic/vue',
  '@ionic/angular',
]);

/** Directories never walked — dependencies, VCS data, build output, GSD planning state. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.planning',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  'vendor',
  '.cache',
]);

/** Walk safety cap — beyond this the tree is treated as scanned (evidence decided by then). */
const MAX_WALK_ENTRIES = 10_000;

/** What a walk found, and the first read failure it met on the way (null when it met none). */
interface WalkResult {
  found: boolean;
  unreadable: string | null;
}

/** The first read failure of the package.json signal: `unreadable`, or `none` (absent), or `found`. */
function packageJsonEvidence(projectDir: string): Evidence<true> {
  const read = readTextEvidence(path.join(projectDir, 'package.json'));
  if (read.kind === 'none') return evidenceNone<true>();
  if (read.kind === 'unreadable') return evidenceUnreadable<true>(read.reason, read.span);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch (err) {
    // A package.json that exists but is not valid JSON could not be read: unreadable, not "no deps".
    return evidenceFromError<true>(err, 'package.json');
  }
  if (parsed === null || typeof parsed !== 'object') return evidenceNone<true>();
  const pkg = parsed as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[field];
    if (deps === null || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      if (UI_FRAMEWORK_DEPS.has(name)) return evidenceFound<true>(true);
    }
  }
  return evidenceNone<true>();
}

/**
 * Shared bounded BFS over the project tree — the single home of the walk
 * semantics both evidence walks depend on: SKIP_DIRS pruning, the
 * MAX_WALK_ENTRIES entry cap (cap-hit → not found: the tree is treated as
 * scanned and evidence stays undecided), symlinks never followed
 * (withFileTypes Dirents). `visit` is called for every regular file with its
 * name, full path and a `note` for a read failure it met; returning `true`
 * stops the walk with `found`. A directory that cannot be listed is NOT
 * silently skipped: it is noted, the walk goes on, and the caller learns that
 * part of the tree was never seen (an absent directory is just skipped).
 */
function walkProjectFiles(
  projectDir: string,
  visit: (name: string, fullPath: string, note: (reason: string) => void) => boolean,
): WalkResult {
  let unreadable: string | null = null;
  const note = (reason: string): void => {
    unreadable = unreadable ?? reason;
  };
  const queue: string[] = [projectDir];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_WALK_ENTRIES) {
    const dir = queue.shift() as string;
    const listing = readDirEntriesEvidence(dir);
    if (listing.kind === 'unreadable') {
      note(listing.reason);
      continue;
    }
    if (listing.kind === 'none') continue; // vanished since it was queued: nothing to see
    for (const entry of listing.value) {
      visited++;
      if (visited >= MAX_WALK_ENTRIES) return { found: false, unreadable };
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
      } else if (entry.isFile() && visit(entry.name, path.join(dir, entry.name), note)) {
        return { found: true, unreadable };
      }
    }
  }
  return { found: false, unreadable };
}

function treeComponentFileEvidence(projectDir: string): WalkResult {
  return walkProjectFiles(projectDir, (name) => UI_COMPONENT_FILE_RE.test(name));
}

/**
 * Read at most the first 64 KiB of `file` as evidence (#4658). Import sections live at
 * the top of a source file, so a bounded prefix read keeps the gate's plan-time cost
 * profile without reading generated monsters in full.
 */
function readPrefixEvidence(file: string): Evidence<string> {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    return evidenceFromError<string>(err, file);
  }
  try {
    const bytes = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return evidenceFound(bytes.toString('utf8', 0, read));
  } catch (err) {
    return evidenceFromError<string>(err, file);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed — the evidence was read (or its failure returned) above
    }
  }
}

/**
 * Native-UI walk over the shared bounded BFS (#4658): `.xaml` is evidence by
 * extension alone; `.swift`/`.kt`/`.dart` are evidence only when the file's
 * content carries its ecosystem's import marker.
 */
function treeNativeUiEvidence(projectDir: string): WalkResult {
  return walkProjectFiles(projectDir, (name, fullPath, note) => {
    if (NATIVE_UI_XAML_RE.test(name)) return true;
    if (NATIVE_UI_SOURCE_RE.test(name)) {
      const markers = NATIVE_UI_CONTENT_MARKERS[path.extname(name).toLowerCase()];
      if (markers == null) return false;
      const prefix = readPrefixEvidence(fullPath);
      if (prefix.kind === 'unreadable') {
        note(prefix.reason);
        return false;
      }
      return prefix.kind === 'found' && markers.some((m) => prefix.value.includes(m));
    }
    return false;
  });
}

/**
 * Does the project tree carry static evidence of a frontend?
 *
 * @param projectDir - Absolute path to the project root (the gate's cwd).
 * @returns `found` when package.json declares a UI-framework dependency, the tree
 *          contains a component-framework file, or the tree contains native UI
 *          evidence (a `.xaml` file, or a `.swift`/`.kt`/`.dart` file carrying
 *          its ecosystem's UI import marker — #4658); otherwise `unreadable` when
 *          any part of the tree or manifest could not be read (the absence of
 *          evidence is then not established), else `none`. Affirmative evidence
 *          always wins over a read failure elsewhere.
 */
export function readStaticFrontendEvidence(projectDir: string): Evidence<true> {
  if (typeof projectDir !== 'string' || projectDir === '') return evidenceNone<true>();
  let unreadable: string | null = null;
  const manifest = packageJsonEvidence(projectDir);
  if (manifest.kind === 'found') return manifest;
  if (manifest.kind === 'unreadable') unreadable = manifest.reason;
  const components = treeComponentFileEvidence(projectDir);
  if (components.found) return evidenceFound<true>(true);
  unreadable = unreadable ?? components.unreadable;
  const native = treeNativeUiEvidence(projectDir);
  if (native.found) return evidenceFound<true>(true);
  unreadable = unreadable ?? native.unreadable;
  return unreadable === null ? evidenceNone<true>() : evidenceUnreadable<true>(unreadable, projectDir);
}

/**
 * The boolean projection of {@link readStaticFrontendEvidence}: true only on affirmative evidence. It
 * reads nothing itself; a gate that must tell "no frontend" from "could not look" uses the evidence.
 */
export function hasStaticFrontendEvidence(projectDir: string): boolean {
  return readStaticFrontendEvidence(projectDir).kind === 'found';
}
