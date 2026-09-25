# 11. Plan — anchors: "this part of the document", across edits and reloads

Status: **plan**. Written 2026-09-25. First client: which boxes are open in the
preview. Second client: comments on the document.

## Why

Several features want to attach data to a part of a document without writing
it into the BBCode, where osu! would print it as text:

| Feature | Today |
|---|---|
| Which boxes are open in the preview | Lives in the DOM only. The morpher keeps it while you type, but it is lost on reload, on a full rebuild (undo, redo, loading a document) and whenever the preview remounts. |
| Comments on a block | Do not exist: nothing can say "this box" in a way that survives edits. |
| "Ignore this warning here" (`ignoredDiagnosticsStore`) | Identifies a diagnostic by `code::text snippet`, so ignoring one hides every diagnostic with the same snippet anywhere in the project. |

All three need the same mechanism. This plan builds it once.

## Design

### Anchors live in text coordinates, not in a tree

The same text has several trees in the app: the default parse (editor,
canvas) and the osu!-pairing parse (`OsuPreviewTree`, the preview). A node id
belongs to one tree and one parse (see *Ids are not portable* in
`09-Guarantees`). A **range of the source text** belongs to all of them. So an
anchor is a tracked range, and it is bound to a node of whichever tree asks,
by position.

This is what the editors that solved this do: Monaco's decorations,
CodeMirror's position mapping and ProseMirror's `Mapping` are all tracked
ranges, not node ids. Roslyn's `SyntaxAnnotation`, by contrast, survives tree
rewrites but not re-parses of changed text — the main source of change here.

### Three layers

```
 3  Selector (persisted)   { start, end, exact, prefix, suffix }   → survives reloads
          │ toSelector / fromSelector (re-anchoring)
 2  Binding                anchor ⇄ node of any tree, by range      → "the box this anchor means"
          │ anchorForNode / resolveNode
 1  AnchorSet (memory)     tracked ranges, mapped through every edit → survives typing
```

**Layer 1 — `AnchorSet`.** It holds `{ id, start, end, stickiness }` and moves
them through every edit.

- Two entry points:
  - `applyChange({ start, end, text })`, when the caller has the edit.
  - `updateText(newText)`, which diffs against the last text it saw with the
    same prefix/suffix scan `DocumentModel.applyTextUpdate` uses. This covers
    undo, redo and full rebuilds, which report no change range.
- Stickiness says what an edit touching an edge does, following Monaco's
  semantics. Text typed exactly at an edge either grows the anchor or stays
  outside it.
- An edit that deletes the whole anchored text leaves it **collapsed**
  (`start === end`) and flagged `deleted`. A comment then shows as orphaned; a
  box state is simply dropped.
- Anchor ids are portable (random, not the node-id counter), because layer 3
  stores them.

**Layer 2 — binding.**

- `anchorForNode(node)` anchors a structural node by its **opening
  delimiter** (`[box=Title]`: `range.start` to `range.start + leadingWidth`).
  Typing in the box's body never touches it, so the anchor is as stable as the
  box itself. Renaming the title edits inside it, and the anchor follows
  (stickiness: grow).
- `resolveNode(root, anchor, kinds)` finds the node of one of `kinds` whose
  opening delimiter the anchor still overlaps. It works on any tree: the
  default parse, the osu! preview tree, a fresh parse after a reload.

**Layer 3 — selectors.** The persisted form, from the W3C Web Annotation model
(a `TextPositionSelector` plus a `TextQuoteSelector`):
`{ start, end, exact, prefix, suffix }`, with up to 32 characters of context on
each side.

`fromSelector(selector, text)` re-anchors in three steps:
1. The position still holds `exact` → the same place (the common case: the
   text did not change between save and load).
2. Otherwise, every occurrence of `exact` is scored by how much of `prefix`
   and `suffix` still surrounds it, and by its distance from the old
   position. The best score wins if it clears a threshold.
3. Nothing clears it → orphaned, reported to the caller rather than guessed.

This also fixes the duplicate-snippet ambiguity of the ignored-diagnostics
store: two identical snippets differ in their context.

### Where the state lives

- The mechanism is in Quasar (`src/Anchors/`, no DOM, no React).
- The clients are in Miliastry. They hold one `AnchorSet` per open document
  (`DocumentInstance`) and persist selectors keyed by the document's stable
  `fileId`. Unsaved documents keep their anchors in memory only.
- The renderer does not learn about UI state. The preview applies "open" to
  the boxes the set resolves, after each patch, the same way a click does
  today.

## Phases

Each phase is one commit with its own tests. Layer phases (A1–A3) touch
nothing that exists, so the output differential (`scripts/differential`) must
show 0 differences.

### A1 — `AnchorSet` (layer 1)
- `src/Anchors/AnchorSet.ts` with `mapOffset(offset, change, bias)`, the
  stickiness rules, `applyChange` and `updateText`.
- Property tests:
  - an anchor that no edit touches keeps covering **exactly the same
    characters** (checked by comparing the text under it, after thousands of
    random edits);
  - `updateText` and `applyChange` agree whenever both apply;
  - every anchor stays within bounds with `start <= end`;
  - a deletion over an anchor collapses it and flags it.
- Performance: `updateText` on the 547 KB fixture stays within the budget
  the model's own diff has.

### A2 — binding (layer 2)
- `anchorForNode` and `resolveNode`, over both the default tree and the
  osu!-pairing tree.
- Property test: anchor every box, apply random edits outside their opening
  tags through the incremental parser, and check that each anchor resolves to
  the box a fresh parse has at the corresponding range.

### A3 — selectors (layer 3)
- `toSelector` and `fromSelector`.
- Tests:
  - unchanged text re-anchors exactly, always;
  - random edits between save and load re-anchor to the right place, or
    report an orphan — never a wrong place. The wrong-place rate is measured
    and stated;
  - duplicate text is disambiguated by its context.

### A4 — first client: open boxes (Miliastry)
- An `openBoxes` store per `DocumentInstance`.
  - A click that opens or closes a box adds or removes its anchor (`usePreviewClick`, `useBlockHighlight`).
  - After every preview patch and every full rebuild, boxes whose anchor resolves get opened.
  - The state persists by `fileId` (as selectors) and is re-anchored when the document opens.
- jsdom tests:
  - a box opened, then an edit elsewhere, then a full rebuild, stays open;
  - it is still open after a save → reload round trip;
  - it stays closed after its opener is deleted.
- Then a check in the real app, **driven by the user**.

### A5 — second client: comments (Miliastry, separate plan)
The mechanism is ready after A3. What is missing are product decisions:
- where comments show (margin, block badge, panel);
- whether they sync to the cloud with the project;
- who sees them;
- what happens to an orphan.

Those get their own plan once decided.

### A6 — optional: ignored diagnostics on anchors
Migrate `ignoredDiagnosticsStore` signatures to selectors, so ignoring one
diagnostic stops hiding its identical twins elsewhere.

## Guarantees this adds (to `09-Guarantees`)

| Guarantee | Enforced by |
|---|---|
| An anchor no edit touches keeps covering exactly the same text. | A1 property test. |
| An anchored node resolves to the same node through incremental edits, in any tree. | A2 property test. |
| Re-anchoring unchanged text is exact; re-anchoring changed text never lands on the wrong place silently. | A3 tests (wrong-place rate measured). |

## What this plan does not do

- **Track moves.** A box cut and pasted elsewhere is a deletion plus an
  insertion to a text diff; its anchor collapses. Recovering it by content is
  possible later with the same selectors, as an explicit feature.
- **Change node ids.** They stay a per-process counter; anchors do not need
  them.
- **Add multi-region diffs.** An edit that rewrites many places at once
  (effects over the whole document) maps as one region, so anchors inside it
  collapse. A finer diff can come later if a client needs it.

## Known limit

A prefix/suffix diff cannot always tell *where* an insertion happened in a run
of identical characters. For example, typing `[box]` right before another
`[box]` is reported as an insertion after it. For an anchor sitting exactly at
that edge, this means it can end up one copy off. Monaco and CodeMirror have
the same ambiguity when handed only old and new text. When the editor
supplies the real edit (`applyChange`), the ambiguity is gone.
