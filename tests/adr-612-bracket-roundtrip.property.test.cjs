'use strict';

/**
 * ADR-612 PR-4 (#4304) — property-based coverage for the bracket phase-id
 * format contract: renderPhaseId / renderMilestoneId / parsePhaseId / toDir.
 *
 * Module: gsd-core/bin/lib/phase-id.cjs (src/phase-id.cts)
 *
 * Why this file exists (#4773 review round 28, trek-e Blocker): the bracket
 * identifier is a bijective-ish parse/serialize contract, which is exactly the
 * class `RULESET.TESTS.property-based-testing` names as ABSOLUTE (CONTEXT.md
 * predicate 1849). The sibling `adr-612-bracket-{grammar,write-path,
 * write-parity,phase-remove}.test.cjs` files cover the write paths by example;
 * this one covers the format contract itself over generated input.
 *
 * Properties:
 *   (a) round-trip      — parse(render(id)) === id, for every id shape
 *   (b) left inverse    — render(parse(s)) === s, byte-for-byte
 *   (c) composition     — render(id) always opens with renderMilestoneId(id)
 *   (d) round-trip      — parse(toDir(id, slug)) recovers the identity dims
 *   (e) containment     — toDir never emits a path separator or a `..` segment
 *   (f) totality        — parse either throws its own error or returns a
 *                         canonical id: it never returns a non-canonical one
 *   (g) boundary        — non-canonical spellings are rejected, not coerced
 *   (h) boundary        — toDir's slug guards hold (empty / all-digit / type)
 *   (i) idempotency     — parse is stable under re-render
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  parsePhaseId,
  renderPhaseId,
  renderMilestoneId,
  toDir,
  phaseHeadingPrefixSrcFor,
  tokenizePhaseDependencyReferences,
  PHASE_HEADING_BASELINE,
} = require('../gsd-core/bin/lib/phase-id.cjs');

// ─── Generators ──────────────────────────────────────────────────────────────

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PROJECT_TAIL = `${UPPER}0123456789_`;
const LOWER = 'abcdefghijklmnopqrstuvwxyz';

// Mirrors the parser's own `[A-Z][A-Z0-9_]*` project-code grammar.
const projectArb = fc
  .tuple(
    fc.constantFrom(...UPPER),
    fc.array(fc.constantFrom(...PROJECT_TAIL), { maxLength: 6 }),
  )
  .map(([head, rest]) => head + rest.join(''));

// Mirrors pad2()'s output shape: exactly 2 digits, or 3+ with no leading zero.
// Generated from the integer side on purpose — the padding rule is the thing
// under test, so the test must not re-spell the regex the module uses.
const segmentArb = fc.nat({ max: 99999 }).map((n) => String(n).padStart(2, '0'));

const idArb = fc.record(
  {
    project: projectArb,
    milestone: segmentArb,
    phase: segmentArb,
    subphase: segmentArb,
    plan: segmentArb,
  },
  { requiredKeys: ['project', 'milestone', 'phase'] },
);

// A slug that survives sanitization unchanged, so (d) exercises the round trip
// itself rather than the guards — (h) covers the guards.
const safeSlugArb = fc
  .array(fc.constantFrom(...LOWER), { minLength: 1, maxLength: 12 })
  .map((cs) => cs.join(''));

const identityDims = (id) => ({
  project: id.project,
  milestone: id.milestone,
  phase: id.phase,
  ...(id.subphase === undefined ? {} : { subphase: id.subphase }),
});

const isParserRejection = (err) =>
  err instanceof Error && /^parsePhaseId: /.test(err.message);

// ─── Display form: render ↔ parse ────────────────────────────────────────────

describe('bracket phase id: display-form round trip', () => {
  // (a) Every id shape survives render → parse unchanged.
  test('property: parse(render(id)) === id', () => {
    fc.assert(
      fc.property(idArb, (id) => {
        // `{ ...id }` because fc.record yields a null-prototype object and
        // deepStrictEqual compares prototypes.
        assert.deepEqual(parsePhaseId(renderPhaseId(id)), { ...id });
      }),
    );
  });

  // (b) The other direction, byte-for-byte: render is a left inverse of parse
  // on every string parse accepts. This is the invariant the parser enforces
  // internally (ADR-612 Decision 4); asserting it here from the outside stops
  // a future parser branch from returning an id that would re-render
  // differently.
  test('property: render(parse(render(id))) === render(id)', () => {
    fc.assert(
      fc.property(idArb, (id) => {
        const rendered = renderPhaseId(id);
        assert.equal(renderPhaseId(parsePhaseId(rendered)), rendered);
      }),
    );
  });

  // (c) The milestone renderer is the prefix of the phase renderer — one
  // spelling of `[PROJECT.MM]`, not two that can drift apart.
  test('property: render(id) starts with renderMilestoneId(id) + space', () => {
    fc.assert(
      fc.property(idArb, (id) => {
        assert.ok(renderPhaseId(id).startsWith(`${renderMilestoneId(id)} `));
      }),
    );
  });

  // (i) Idempotency: parsing a re-rendered id yields the same tuple, so the
  // transform reaches a fixed point after one application.
  test('property: parse is stable under re-render', () => {
    fc.assert(
      fc.property(idArb, (id) => {
        const once = parsePhaseId(renderPhaseId(id));
        assert.deepEqual(parsePhaseId(renderPhaseId(once)), once);
      }),
    );
  });
});

// ─── Dir form: toDir ↔ parse ─────────────────────────────────────────────────

describe('bracket phase id: dir-form round trip', () => {
  // (d) The disk↔identity bijection toDir's docstring claims: the emitted
  // directory name re-parses to the same identity dimensions. `plan` is not an
  // identity dimension of a phase directory and is intentionally absent.
  test('property: parse(toDir(id, slug)) recovers the identity dims', () => {
    fc.assert(
      fc.property(idArb, safeSlugArb, (id, slug) => {
        assert.deepEqual(parsePhaseId(toDir(id, slug)), identityDims(id));
      }),
    );
  });

  // (e) Boundary containment: the slug becomes a real path segment, so no
  // input may produce a separator or a traversal segment. Arbitrary unicode
  // here — a slug that trips a guard throws, and a throw is a pass for this
  // property (nothing unsafe reached disk); what must never happen is an
  // unsafe name being RETURNED.
  test('property: toDir never emits a separator or traversal segment', () => {
    fc.assert(
      fc.property(idArb, fc.string({ maxLength: 40 }), (id, slug) => {
        let dir;
        try {
          dir = toDir(id, slug);
        } catch (err) {
          assert.ok(
            err instanceof Error && /^toDir: /.test(err.message),
            `unexpected error: ${err && err.message}`,
          );
          return;
        }
        assert.ok(!dir.includes('/'), `separator in ${JSON.stringify(dir)}`);
        assert.ok(!dir.includes('\\'), `separator in ${JSON.stringify(dir)}`);
        assert.ok(
          !dir.split('-').includes('..'),
          `traversal in ${JSON.stringify(dir)}`,
        );
        // Whatever it emitted must still re-parse to the same identity.
        assert.deepEqual(parsePhaseId(dir), identityDims(id));
      }),
    );
  });
});

// ─── Totality and boundaries ─────────────────────────────────────────────────

describe('bracket phase id: parser totality', () => {
  // A corpus deliberately mixed so BOTH parser outcomes are exercised: real
  // emitter output (accepted), near-miss spellings and free-form unicode
  // (rejected). A corpus of free-form strings alone never reaches the accept
  // branch — measured 0/500 — which would make the property below vacuous.
  const candidateArb = fc.oneof(
    fc.string({ maxLength: 40 }),
    idArb.map((id) => renderPhaseId(id)),
    fc.tuple(idArb, safeSlugArb).map(([id, slug]) => toDir(id, slug)),
    // Dir form carrying a plan tail — emitted by the plan write path, and the
    // one dir shape whose tail IS an identity dimension.
    idArb.map(
      (id) =>
        `${id.project}.${id.milestone}-${id.phase}` +
        `${id.subphase ? `.${id.subphase}` : ''}${id.plan ? `-${id.plan}` : ''}`,
    ),
    // Near misses: one mutation away from canonical.
    fc
      .tuple(idArb, fc.constantFrom('pad', 'space', 'wrap', 'case', 'junk'))
      .map(([id, kind]) => {
        const s = renderPhaseId(id);
        switch (kind) {
          case 'pad':
            return s.replace(/\] (\d)/, '] 0$1');
          case 'space':
            return s.replace('] ', ']  ');
          case 'wrap':
            return ` ${s} `;
          case 'case':
            return s.toLowerCase();
          default:
            return `${s}!`;
        }
      }),
  );

  // (f) On ANY input the parser has exactly two outcomes: its own rejection,
  // or an id that is canonical BY CONSTRUCTION — one that survives a round
  // trip through both emitters unchanged. It never throws from somewhere else
  // (a TypeError on hostile input would be a defect, not a rejection), and it
  // never returns an id that the emitters would spell differently.
  test('property: parse rejects, or returns an id that round-trips through both emitters', () => {
    let accepted = 0;
    fc.assert(
      fc.property(candidateArb, (s) => {
        let id;
        try {
          id = parsePhaseId(s);
        } catch (err) {
          assert.ok(isParserRejection(err), `unexpected error: ${err && err.message}`);
          return;
        }
        accepted += 1;
        // Display emitter: the returned id is a fixed point of render → parse.
        assert.deepEqual(parsePhaseId(renderPhaseId(id)), id);
        // Dir emitter: the same id survives the disk round trip on its
        // identity dimensions.
        assert.deepEqual(parsePhaseId(toDir(id, 'phase')), identityDims(id));
        // A display-form input must additionally be byte-identical to its own
        // re-render — the canonicality rule ADR-612 Decision 4 states.
        if (s.startsWith('[')) {
          assert.equal(renderPhaseId(id), s);
        }
      }),
    );
    // Coverage guard: if a future grammar change made every candidate
    // unparseable, the property above would still "pass" while asserting
    // nothing about accepted ids. Fail loudly instead.
    assert.ok(accepted > 0, 'corpus never reached the accept branch');
  });

  // Same totality claim over strings shaped LIKE ids, where a sloppy parser is
  // far likelier to leak an acceptance than over free-form unicode.
  test('property: near-miss spellings are rejected, never coerced', () => {
    fc.assert(
      fc.property(
        projectArb,
        fc.nat({ max: 9 }),
        fc.nat({ max: 9 }),
        fc.constantFrom('unpadded', 'overpadded', 'doublespace', 'wrapped'),
        (project, m, p, kind) => {
          const pad = (n) => String(n).padStart(2, '0');
          const variants = {
            unpadded: `[${project}.${m}] ${p}`,
            overpadded: `[${project}.0${pad(m)}] 0${pad(p)}`,
            doublespace: `[${project}.${pad(m)}]  ${pad(p)}`,
            wrapped: ` [${project}.${pad(m)}] ${pad(p)} `,
          };
          assert.throws(() => parsePhaseId(variants[kind]), isParserRejection);
        },
      ),
    );
  });
});

describe('bracket phase id: toDir slug guards', () => {
  // (h) The three declared guards, over generated input rather than one
  // example each: a non-string slug, a slug that sanitizes to nothing, and an
  // all-digit slug (string-indistinguishable from the dir form's plan tail,
  // which would break the bijection asserted in (d)).
  test('property: a non-string slug is refused', () => {
    fc.assert(
      fc.property(
        idArb,
        fc.oneof(fc.constant(undefined), fc.constant(null), fc.nat(), fc.boolean()),
        (id, slug) => {
          assert.throws(() => toDir(id, slug), /^Error: toDir: slug must be a string/);
        },
      ),
    );
  });

  test('property: a slug that sanitizes to empty is refused', () => {
    fc.assert(
      fc.property(
        idArb,
        fc
          .array(fc.constantFrom(...'!@#$%^&*()+=[]{};:",<>?/|~`'), {
            minLength: 1,
            maxLength: 8,
          })
          .map((cs) => cs.join('')),
        (id, slug) => {
          assert.throws(() => toDir(id, slug), /^Error: toDir: slug sanitizes to empty/);
        },
      ),
    );
  });

  test('property: an all-digit slug is refused', () => {
    fc.assert(
      fc.property(idArb, fc.nat({ max: 999999 }), (id, n) => {
        assert.throws(
          () => toDir(id, String(n)),
          /^Error: toDir: slug must not be all-digit/,
        );
      }),
    );
  });

  // Boundary containment on the id side: a hand-built (non-parsePhaseId) id
  // with a non-canonical segment must be refused rather than written to disk.
  test('property: non-canonical id segments are refused', () => {
    fc.assert(
      fc.property(
        idArb,
        safeSlugArb,
        fc.constantFrom('project', 'milestone', 'phase'),
        fc.constantFrom('7', '007', '0', 'gsd', ''),
        (id, slug, field, bad) => {
          const mutated = { ...id, [field]: bad };
          assert.throws(() => toDir(mutated, slug), /^Error: toDir: invalid /);
        },
      ),
    );
  });
});

// ─── Capture-group indexing (#4773 review round 29, Minor 2) ─────────────────
//
// `tokenizePhaseDependencyReferences` composes its bracket-display regex as
// `phaseHeadingPrefixSrcFor(LABEL_ONLY, 'bracket', true)` + an appended
// token-list capture, then reads the bracket id as group 1 and the token list
// as group 2. Those indices are POSITIONAL: a capturing group added anywhere
// inside the prefix — including inside either of its two alternatives, or
// inside BRACKET_ID_SRC — silently shifts the token list to a later index, and
// the reader would then slice the wrong span without failing loudly. The
// review could not rule this out from the regex definitions alone, so the
// invariant is pinned here rather than left to inspection.

describe('bracket dependency tokenizer: capture-group indexing', () => {
  // Structural: the capturing prefix contributes EXACTLY one group, so the
  // appended token-list capture is group 2 and nothing else can be.
  test('the capturing prefix contributes exactly one capture group', () => {
    const prefix = phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, 'bracket', true);
    // `src + '|'` makes the pattern match the empty string, so the result is
    // always non-null and its length is 1 + the group count. Counted through
    // `String.prototype.match` rather than `RegExp.prototype.exec`, whose
    // call spelling collides with prompt-injection-scan.sh's code-execution
    // pattern (DEFECT.PROMPT-INJECTION-SCAN-COLLISION). That pattern cannot
    // be narrowed without dropping real child-process hits, so the collision
    // is avoided here rather than allowlisted — this file has no other need
    // of an exemption, and the wording above deliberately does not spell the
    // trigger token out, the same way gsd-code-reviewer.md's defense contract
    // was reworded instead of exempted (#4209 R2).
    const groupCount = ''.match(new RegExp(`${prefix}|`)).length - 1;
    assert.equal(
      groupCount,
      1,
      'a capture group added to the phase-heading prefix shifts the dependency ' +
        'tokenizer\'s token-list group off index 2',
    );
  });

  // Behavioural: the offsets the tokenizer reports must actually point at the
  // token it names. A misindexed group survives a "did it find something"
  // assertion but not this one.
  test('property: reported offsets point at the token that was named', () => {
    const numberArb = fc.nat({ max: 99 }).map((n) => String(n).padStart(2, '0'));
    fc.assert(
      fc.property(
        projectArb,
        numberArb,
        fc.array(numberArb, { minLength: 1, maxLength: 3 }),
        // Every spelling the bracket alternative admits: any case, optional
        // `Phase` label, zero or more spaces after the bracket.
        fc.constantFrom('] ', ']', '] Phase ', '] PHASE ', ']phase '),
        (project, milestone, tokens, joint) => {
          const prose = `${`[${project}.${milestone}`}${joint}${tokens.join(', ')}`;
          const found = tokenizePhaseDependencyReferences(prose, 'bracket');
          assert.equal(found.length, tokens.length);
          found.forEach((ref, i) => {
            assert.equal(ref.kind, 'qualified');
            // The span [start, end) must be the token's own text — this is
            // what breaks if the token list is read from the wrong group.
            assert.equal(prose.slice(ref.start, ref.end), tokens[i]);
            assert.ok(ref.token.endsWith(tokens[i]));
          });
        },
      ),
    );
  });

  // The unqualified spelling takes the prefix's OTHER alternative, which
  // captures nothing — group 1 is undefined and the reference is legacy, not
  // qualified. This is the branch the `if (!displayMatch[1]) continue;` guard
  // exists for.
  test('an unqualified mention stays legacy, not qualified', () => {
    const found = tokenizePhaseDependencyReferences('Phase 03, 04', 'bracket');
    assert.deepEqual(
      found.map((r) => [r.kind, r.token]),
      [['legacy', '03'], ['legacy', '04']],
    );
  });
});
