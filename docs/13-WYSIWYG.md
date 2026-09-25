# 13. The WYSIWYG canvas

The canvas is a `contenteditable` painted by the engine's renderer. The **text
is the truth** here, as it is everywhere else in Quasar: the canvas never owns
the document. Every gesture on it has to come back as a few `TextChange`s
against the BBCode source, and every change outside those characters is
collateral damage. That means the author's hex casing, indentation, quoting and
line breaks.

## Two ways a gesture reaches the source

**1. Commands (intent is explicit).** The gesture is computed on the tree, not
read back from the DOM. The canvas selection becomes source offsets
(`Reconciler/CanvasPositions.ts`). Quasar then computes the minimal edit
(`Commands/InlineFormat.ts`). The canvas is repainted from the new text, and
the selection is put back on the same text.

| Command | Edit |
|---|---|
| `toggleInlineFormat(root, source, sel, 'bold' \| 'italic' \| 'underline' \| 'strikethrough')` | inserts `[b]`…`[/b]` per run; off strips the enclosing tag and wraps back what stays formatted, in the author's spelling (`[B]`) |
| `applyColor(root, source, sel, hex)` | recolors a `[color]` whose content is exactly the selection, touching only its value; otherwise wraps it |

A selection is cut into **runs**: inline content under one parent, broken at
line breaks and at blocks. A tag opened in a run closes in the same run, so
the result is always well nested. A caret *inside* a word applies to the word.
At a word's edge the command declines, because "Bold, then type" means what
comes next. A declined command falls back to `execCommand`.

**2. Reconciliation (intent is inferred).** Typing is left to the browser, and
`reconcileVisualDOMToBBCode` works out what changed. It tries each route in
order, from the most precise to the most expensive, and reports which one it
took (`ReconcileResult.route`):

| Route | What it rewrites |
|---|---|
| `surgical` | only the changed text leaves |
| `element` | one element, re-exported from its HTML |
| `full` | the whole document (`fullReason`: `no-baseline`, `duplicate-ids`, `unpaired-top-level`) |

Anything that can be a command should be one: inference is where style gets
lost.

## Positions

`sourceOffsetOfDomPoint` and `domPointOfSourceOffset` require the canvas to be
exactly the render of the tree they are given. The component repaints first if
the user has typed since the last paint, carrying the selection across by
visible character offset.

Inside an element that carries `data-node-id`, DOM text nodes are paired with
the node's text leaves in order, by equal text. Text the renderer made up has
no leaf, and resolves to the nearest real text. Examples: a box heading, a
quote's author line, osu!'s literal `[color="…"]`.

## Measured: the gesture bench

`scripts/wysiwyg-gestures/run.mjs` (Miliastry) plays 33 gestures in real
Chromium per dialect. It reports each gesture's route, whether the BBCode shows
what the canvas shows, and whether distant author style survived byte for
byte. The toolbar helpers are extracted from the component on every run.

| Original 30 gestures | miliastry: phase 0 → **phase 1** | osu!: phase 0 → **phase 1** |
|---|---|---|
| command | — → **7** | — → **7** |
| surgical | 8 → 8 | 7 → 7 |
| element | 13 → **8** | 16 → **10** |
| full | 8 → **7** | 7 → **6** |
| text lost | 0 → 0 | 0 → 0 |
| distant style lost | 1 → 1 (select all) | 10 → **8** |

Phase 0 was measurement. It found two bugs, both fixed:

- Enter mid-paragraph dropped the text after the caret.
- An osu! canvas was reconciled with miliastry markup, so one keystroke rebuilt
  untouched boxes.

## Next

- **Enter / Backspace across structure** (`SplitMerge`). Enter in a box, notice
  or list duplicates ids and goes `full`; joining paragraphs goes `element`.
- **Paste and insert block** as a parsed `TextChange` at the caret's source
  offset. Today these are `full` / `unpaired-top-level`.
- **osu! box edges.** Typing in an osu! box still goes `element` and loses the
  box's own newlines.
