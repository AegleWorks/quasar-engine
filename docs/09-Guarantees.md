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
| An incremental reparse yields the tree a full parse of the same text would (ids aside). | Property tests (`RedReuse`, `Chars500kEdits`, `Fuzzer`). |
| …and it satisfies every red-tree invariant above. | `RedTreeInvariants.test.ts` (random edits); `QUASAR_VALIDATE_TREES=1` over any suite. |
| The osu! preview tree (`OsuPreviewTree`) equals a fresh full osu! parse after every edit, with unchanged blocks as the same objects. | `OsuPreviewTree.test.ts` (random edits, both dialects, invariants checked). |
| The patched preview DOM equals a full render of the same tree (ids aside), including when the HTML parser reshapes malformed markup. | `OsuPreviewTree.test.ts`, `BlockPatcherReshape.test.ts`, `BlockPatcherAdoption.test.ts`. |

## Rendering and transforms

| Guarantee | Enforced by |
|---|---|
| A renderer's id mode is its own; no render changes another's output. | Per-instance `idMode` option (`RendererIsolation.test.ts`). |
| Effect transforms return a new tree and leave their input untouched and valid. | `TreeTransformersPurity.test.ts`. |

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
