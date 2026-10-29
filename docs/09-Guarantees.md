# 9. Guarantees

What Quasar promises about its trees, and — for each promise — what enforces
it. A guarantee nothing enforces is a hope, so every row names its enforcer:
the **type system** (a violation does not compile), a **constructor** (a
violating object cannot be built), the **validator** (`checkRedTree` /
`checkPartition`, run by tests and by `QUASAR_VALIDATE_TREES=1`), or a
**property test** (random edits, checked after every one).

## The green tree

| Guarantee | Enforced by |
|---|---|
| Immutable: a green node never changes after construction. | Types (`readonly` fields and children); `Object.freeze` outside production. |
| Position-free: a green knows its width, never its offset, so equal structures can be one object. | Types (there is no position field). |
| Widths partition: `width = leading + Σ children + trailing`. | Constructor (width is computed, never passed). |
| The root covers the source; text leaves are as wide as their text. | `checkPartition` (`Tests/Partition.test.ts`). |

## The red tree

| Guarantee | Enforced by |
|---|---|
| Shape changes only through the mutators, inside a mutation boundary, which keep `parent` and the index cache right. | Types (`children` is `readonly RedNode[]`); runtime check in the mutators. |
| Every child's `parent` is the node that lists it, and its `index` points back at its slot. | `checkRedTree` → `parent`, `index`. |
| Every range equals the widths before it — including subtrees whose shift is still pending (`setStart` is lazy). | `checkRedTree` → `range`. |
| The red child list mirrors the green one. | `checkRedTree` → `shape`. |
| Ids are unique within a tree, rich box titles included. | `checkRedTree` → `duplicate-id`. |
| Rich box titles sit on their own characters, inside their box. | `checkRedTree` → `title`, `source`. |
| Round-trip: every text leaf holds exactly the source characters its range covers. | `checkRedTree` → `source` (BBCode only — see below). |

The HTML, Markdown and MilHibri models are **importers**: they translate their
source into a BBCode-shaped tree, so it does not reproduce their text
(`DocumentModel.treeMirrorsSource` is false and the round-trip checks are
skipped), but every other invariant holds for them too.

## Incremental paths

| Guarantee | Enforced by |
|---|---|
| An incremental reparse yields the tree a full parse of the same text would (ids aside) — whichever rung of the window ladder it settled on. | Property tests (`RedReuse`, `Chars500kEdits`, `Fuzzer`, `IncrementalDifferential`: every node's kind, range and text, after every fuzzed edit, both dialects). |
| …and it satisfies every red-tree invariant above. | `RedTreeInvariants.test.ts` (random edits); `QUASAR_VALIDATE_TREES=1` over any suite. |
| The osu! preview tree (`OsuPreviewTree`) equals a fresh full osu! parse after every edit, with unchanged blocks as the same objects. | `OsuPreviewTree.test.ts` (random edits, both dialects, invariants checked). |
| The patched preview DOM equals a full render of the same tree (ids aside), including when the HTML parser reshapes malformed markup. | `OsuPreviewTree.test.ts`, `BlockPatcherReshape.test.ts`, `BlockPatcherAdoption.test.ts`. |
| The osu! semantic model (swallowed newlines, closing budgets, ghosts, title claims) answers on an incrementally patched tree exactly as on a fresh full parse. | `OsuSemanticModel.test.ts` (random edits and their undo, compared by range). |

## Rendering and transforms

| Guarantee | Enforced by |
|---|---|
| A renderer's id mode is its own; no render changes another's output. | Per-instance `idMode` option (`RendererIsolation.test.ts`). |
| Effect evaluation is deterministic: the same text plus parameters yields the same segments, with seeded randomness and no clock or I/O. | `EffectSegments.test.ts`, `SpatialEffects.test.ts`. |
| Publishing never depends on presentation: the exporter and the edit rules reach no renderer, directly or through any chain of imports. What osu! swallows or hides comes from one `OsuSemanticModel`, shared by render and export. | `Architecture.test.ts` (transitive import graph). |

## Input limits

| Guarantee | Enforced by |
|---|---|
| No input throws: every walker over a tree recurses once per level, so tags nest at most `MAX_NESTING_DEPTH` (256) deep. Past it an opener, and the closer that answers it, stay literal text, with a `nesting-too-deep` warning. Real documents nest 8 deep. The HTML and Markdown importers stop at the same depth. | `Tests/NestingLimit.test.ts` (20 000 levels in seven shapes, every phase; importers). |
| An incremental reparse near the limit equals a full parse: a window whose tags reach the limit, before or after the edit, is declined (`nesting-limit`). | `Tests/NestingLimit.test.ts` (fuzzed edits around depth 256). |
| No phase is quadratic in the input on the measured shapes: runs of newlines (render), unclosed tags (osu! pairing), crossed tags (analysis), colour runs (analysis), Fix-All conflicts. | `Tests/OsuNewlineRuns.test.ts`, `Tests/OsuPairingScaling.test.ts`, `scripts/bench` (`scale.*`, log-log exponent). |

## Diagnostics and fixes

| Guarantee | Enforced by |
|---|---|
| A window analysis yields what a full analysis would, `data` included — the offsets the fix providers apply. | `Tests/Chars500kAnalysis.test.ts` (fingerprint includes `data`), `Tests/WindowFixData.test.ts`, `Tests/GradientOutlierWindow.test.ts`. |
| An automatic fix (`isAutomaticFix`: automatic provider AND an `equivalenceKey`) does not change what the reader sees. A finding whose usual repair would — an empty `[box]`, an empty tag alone on its line, a rename that re-pairs closers, a closer written before a newline osu! swallows — keeps a manual fix and stays out of Fix-All. `url-markdown-link` and `unicode-url` change the link on purpose. | `Tests/AutomaticFixesRenderNeutral.test.ts` (every automatic finding on the corpus, plus the shapes that broke it). |
| Built-in fixes are always defined; a runtime override (`registerCodeFix`, a plugin) sits on top and comes off without disturbing the built-in or another override. | `Tests/AutomaticFixesRenderNeutral.test.ts` (registry). |

## Events and transactions

| Guarantee | Enforced by |
|---|---|
| Every edit's `document_changed` carries its `origin` and `change`, spliced or rebuilt; every analysis the model runs on its own is followed by `diagnostics_updated`. | `Tests/EventContract.test.ts`. |
| `transact` is all or nothing: an operation kind `Transaction` does not carry out is refused untouched, and a failure part-way leaves the document as it was. | `Tests/TransactContract.test.ts`. |

## Anchors (`src/Anchors/`, docs/11-Anchors-Plan.md)

| Guarantee | Enforced by |
|---|---|
| An anchor no edit touches keeps covering exactly the same text; every anchor stays in bounds; a deleted anchor is collapsed and flagged, never dropped. | `Anchors.test.ts` (random edits, all four stickiness modes). |
| An anchored node resolves to the same node through incremental edits, in the default tree and in the osu! preview tree alike. | `AnchorsBind.test.ts` (patched trees against fresh parses). |
| Re-anchoring unchanged text is exact. Re-anchoring changed text is never wrong silently: a placement that had a plausible rival (a twin) is flagged `ambiguous`. | `AnchorsSelector.test.ts` (80 fuzzed seeds; 0 silent errors). |

## Debug validation

Run any suite with `QUASAR_VALIDATE_TREES=1` and `DocumentModel` asserts
`checkRedTree` after every rebuild and every incremental reparse — outside the
reparse's fallback `catch`, so a violation fails loudly instead of being
papered over by a full rebuild. It is how Roslyn uses its own validator: every
test that edits a document becomes a fuzz case for the incremental machinery.
Off by default (a full walk per edit); production reads a constant `false`.

`npm run test:validate` runs the suite this way (minus the timing-budget
tests, which a full walk per keystroke is bound to miss). On its first run it
found the HTML importer's ranges ignoring widths; the BBCode parser, full and
incremental, came out clean across every test in both repositories.

## What is deliberately NOT guaranteed

- **Ids are not portable across independent parses.** They come from a
  process-wide counter. Identity across versions is carried by reuse (the
  incremental parser, `OsuPreviewTree`) or by `preserveNodeIds`; two unrelated
  parses of the same text share no ids. Map between trees by range.
- **A superseded red tree is consumed.** Red reuse reparents adopted subtrees
  into the new tree; read only the latest root.
- **The mutation boundary is process-wide**, not per document. With
  `children` read-only at the type level the boundary is a second line of
  defence, not the only one; scoping it per document would cost a root walk
  per mutation to catch a class of bug a single-threaded editor does not have.
- **Malformed documents render whole.** When the HTML parser reshapes a
  block's markup, the patcher falls back to a full render (correct, not
  incremental). None of the 51 real documents in the corpus triggers it.
