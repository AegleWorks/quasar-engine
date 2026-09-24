# 10. Plan — one semantic model between the tree and its outputs

Status: **plan**, not implemented. Written 2026-09-24 after the osu! fidelity
work (parity 128/130 with osu!'s real stylesheet).

## The problem: three leaks between layers

Quasar's syntax layer is Roslyn-grade (see [9. Guarantees](./09-Guarantees.md)).
What sits on top of it is not layered yet. Roslyn keeps three things apart:
the **syntax tree** (what was written), the **semantic model** (what it means)
and the **consumers** (emit, IDE features), which only ask the model. Quasar
blurs them in three places:

1. **The renderer does semantic work.** Which newlines osu! swallows
   (`NEWLINE_RULES`, `isNewlineSwallowed`, `eatenByOpeningTag`,
   `eatenByClosingTag`), which closers are ghosts (`isGhost`,
   `isOrphanBoxCloseText`, `discardedTagRule`) and which closers a rich box
   title claims (`titleClaims`) are facts about the DOCUMENT under osu!'s
   rules. They live as private methods of `HTMLRenderer`, a 2 200-line
   HTML emitter.
2. **The exporter asks the renderer.** `BBCodeExporter` builds and caches
   whole `HTMLRenderer` instances (`ghostResolver`) to call
   `closingBudget` / `isNewlineSwallowedPublic`, and `flattenOsuNesting`
   takes a renderer as an option. The dependency points the wrong way: a
   change to how something LOOKS can change what is PUBLISHED. It has
   happened (the commit that hid orphan closers changed one generated
   export).
3. **The HTML is used as data.** A swallowed newline renders as a bare
   `'\n'` because the WYSIWYG → BBCode path reads it back from the DOM. osu!
   deletes it. After an inline-block (`.imagemap`) that whitespace is one
   space wide and moves a word to the next line — the last real-CSS parity
   difference (`originals/tesla.bbcode`). Deleting it breaks the round trip
   (`WysiwygRoundTrip`, `SurgicalCanvas`, `BoxRichTitle` fail).

## The target

```
            ┌──────────────── SyntaxTree (red/green, unchanged) ───────────────┐
            │                                                                   │
            ▼                                                                   │
   OsuSemanticModel(root, dialect)   — lazy, memoized, one per tree snapshot    │
     newlineFate(spacing)   → kept | eaten-by-open | eaten-by-close | ghost      │
     closingBudget(node)    → how many newlines a close eats                    │
     isGhost(node)          → closer osu! shows nothing for                     │
     titleClaim(node)       → the title tag this closer/element answers to      │
            │                                                                   │
     ┌──────┴──────────┬──────────────────────┐                                 │
     ▼                 ▼                      ▼                                 │
 HTMLRenderer     BBCodeExporter      flattenOsuNesting ◄───────────────────────┘
 (presentation)   (emit BBCode)       (edit rule)
```

- `Semantic/OsuSemanticModel.ts` holds the rule tables (moved verbatim) and
  the queries. It never produces HTML or BBCode.
- The renderer, the exporter and the flatten rule each receive a model (or
  build one from the root they were given). None imports another.
- Like Roslyn's `SemanticModel`, it is **per snapshot**: its caches are keyed
  by red node and valid for one tree version. A new version gets a new model.
  This also retires a latent hazard: today the exporter's cached renderer
  keeps its `titleClaimCache` across exports of different tree versions.

## Phases

Each phase is one commit, and phases 1–3 must be **output-identical**: every
render, export, forum render and effect byte-for-byte equal to before.

### Phase 0 — the safety net
- Turn the scratch differential (65 real documents × {quasar, osu} pairing ×
  {osu, miliastry, lyne} dialect × render/export/forum/effects, plus 3 000
  generated documents) into a reproducible script with a before/after SHA
  switch.
- Record the baseline at the current head.
- **Done when:** the harness reports 0 differences between the head and itself,
  and 1 difference on a deliberately broken build (a proof that it can fail).
- ✅ **Done** — `scripts/differential/run.mjs <base-ref> --corpus <dir|json>`.
  Head against itself: 3 066 documents (66 real + 3 000 generated), 52 097
  outputs, 0 differ, in about 30 s. A one-token mutant (`[/quote]` eats one
  newline instead of two) makes 3 629 outputs differ, 5 of them **exports**:
  leak 2, caught in the act.

### Phase 1 — move the tables
- `NEWLINE_RULES`, `LEGACY_BLOCK_RULE`, `RENDERED_AS_BLOCK` and
  `discardedTagRule` move to `Semantic/osu/newlineRules.ts`, as pure data plus
  pure functions.
- The renderer imports them.
- **Done when:** the differential shows 0 differences and all suites are green.
- ✅ **Done** — `Semantic/osu/newlineRules.ts`: `NEWLINE_RULES`, `LEGACY_BLOCK_RULE`,
  `BLOCK_KINDS`, the widthless sets, `newlineRule`, `discardedTagRule`.
  Differential: 52 097 outputs, 0 differ.

### Phase 2 — `OsuSemanticModel`
- Move the queries out of the renderer, unchanged: `isNewlineSwallowed`,
  `eatenByOpeningTag`/`eatenByClosingTag`, `closingRule`/`closingBudget`,
  `isGhost`/`isOrphanBoxCloseText`, `titleClaims`/`claimedTag`.
- The renderer creates one model per `render()` call and delegates to it.
- The model caches in `WeakMap`s owned by that instance.
- **Done when:** the differential shows 0 differences, suites are green, and the
  547 KB fixture's render time rises by no more than 5%.

### Phase 3 — cut the wrong-way edge
- `BBCodeExporter` and `flattenOsuNesting` take an `OsuSemanticModel`.
- Remove `ghostResolver`, `ghostResolverCache`, `isNewlineSwallowedPublic`,
  the public `closingBudget` and the `renderer` option.
- Add an **architecture test**: no file under `Visitors/BBCodeExporter*`,
  `Edits/` or `Semantic/` imports `HTMLRenderer`. It fails if the edge comes
  back.
- **Done when:** the differential shows 0 differences, the architecture test is
  green, and `09-Guarantees` gains the row "Publishing never depends on
  presentation", enforced by that test.

### Phase 4 — the round trip reads the tree, not whitespace
- A swallowed newline renders as an empty marker with no layout, e.g.
  `<span data-bb-nl hidden></span>`. It no longer renders as `'\n'`.
- The HTML importer (`HTMLToGreenNode`) and the surgical reconciler read the
  marker back as the source newline.
- This is the first phase that changes output. The DOM changes; what the
  reader sees does not, except where the whitespace was visible.
- **Done when:**
  - WYSIWYG, SurgicalCanvas and BoxRichTitle pass unchanged.
  - Kit, real CSS: tesla reads the same, **130/130** (6 through the accepted
    empty-media warning).
  - Kit, neutral CSS and `<br>`: no regression.
  - `BlockPatcher` equivalence tests are green (the marker has no id, like the
    `'\n'` it replaces).

### Phase 5 — the guarantee
- Property test: after random incremental edits, the model built on the
  reused tree answers every query exactly as the model built on a fresh full
  parse does (compared by range).
- Add it to `09-Guarantees` under *Incremental paths*.

## What this plan deliberately does not do

- It does not merge `OsuSemanticModel` into the diagnostic `SemanticAnalyzer`.
  That one reports problems; this one answers questions. Roslyn keeps the two
  apart as well: diagnostics are computed from the model, they are not the
  model.
- It does not touch `Osu/osuPairing.ts` (the full "what osu! shows" pairing
  mode). It already works on raw text and has its own parity tests. It could
  become the model's backend later; that is a separate decision.
- It does not change the parser, the incremental machinery or the green tree.

## Risks

| Risk | Mitigation |
|---|---|
| A query that silently depended on renderer state (options, theme) | Phase 2 passes the dialect to the model explicitly; the differential covers all 3 dialects × 2 pairings. |
| Caches valid for the wrong snapshot | Per-version model (above); the Phase 5 property test. |
| Phase 4 marker confuses `BlockPatcher`'s text-run alignment | Its equivalence and reshape suites run in Phase 4's done-criteria. |
| Performance: one model per render | Lazy queries, same memoization the renderer does today; measured against the 547 KB fixture. |

## Size

| Phase | Kind of change |
|---|---|
| 0 | New script, no source change. |
| 1–2 | About 600 lines move out of `HTMLRenderer.ts`; almost no new logic. |
| 3 | About 150 lines change in the exporter and the flatten rule, plus one new test. |
| 4 | The only behavioural change: renderer, importer and reconciler, plus tests. |
| 5 | Tests and documentation. |
