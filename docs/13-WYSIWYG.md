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

| `insertLineBreak(root, source, sel)` (Enter) | `\n`; in a list item `\n[*]`, or out of the list on an empty last item; a heading closes and reopens (in the author's spelling); at a block's swallowed edge `\n\n` |
| `joinBackward` / `joinForward` (Backspace / Delete) | removes the line's `\n`, or `\n[*]` between items; never a box's own edge newline (a no-op edit) |
| `deleteSelection(root, source, sel)` | deletes the range but keeps every tag it cuts through: no orphan `[/b]` |
| `insertContent(root, source, sel, content, parse)` (paste, toolbar blocks, links, typing over a selection) | one insertion, see the placement rules below |

### Where pasted content goes

**Where the caret is.** The caret is the author's intent. Content moves only
when that place cannot sensibly hold it:

| Caret in | Inline content | Block content |
|---|---|---|
| text, a box, a notice, a list item | at the caret | at the caret |
| `[b]`, `[i]`, `[color]`, `[url]`… | at the caret | end of the line, outside every inline tag |
| `[heading]` | at the caret | right after the heading |
| a box heading (`[box=…]`) | at the caret | first line of that box's content |
| `[code]` | literally, at the caret | literally, at the caret |

osu! accepts a box inside `[b]` (all of it turns bold) and even a `[notice]`
inside a box heading (painted inside the clickable title). Both were checked on
osu! itself, and Quasar's osu! mode renders them the same way. Moving the block
out is a choice of style, not a correction. A selection is replaced: deleted
with `deleteSelection`, then the rule is applied where that leaves the caret.
The result is one change against the original source.

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

Backspace and Delete in the middle of a word are left to the browser. The
component decides this cheaply on the DOM (`deletesWithinText`), so those
keystrokes never pay for a repaint. Indentation before the caret at a line's
start counts as the line's start, because those spaces collapse on the canvas.

## Inside boxes

A box renders its content inside markup of its own: a heading, and a body
`<div>`. The reconciler now finds that **content host** (`contentHost`: where
the children's render appears verbatim) and pairs the children there. It trusts
the host only if everything outside it is exactly as rendered, so an edit to
the heading still goes to the coarser paths. The `open` attribute a click gives
a `<details>` is view state, not an edit, and the comparison ignores it. The
component also keeps open boxes open across repaints
(`repaintKeepingOpenBoxes`).

## Decoration between children

A render can also put markup of its own *between* a node's children: a
quote's "X wrote:" line, or the newlines between list items. `descend` aligns
the node's render with its children's, and treats whatever matches no child as
decoration. The decoration must be in the DOM exactly as rendered: an edit to
the author line is not typing, and the coarser paths see it. It is then left
out of the pairing. A single text node that pairs with no child (typed into an
empty list item) is inserted at the offset between its neighbours.

## Lines with no layout

Some newlines render as nothing visible:

- the last lines of a box, which osu! swallows;
- the end of the document, where a final `<br>` makes no line.

The marker a swallowed newline leaves (`<span data-bb-nl hidden>`) carries its
node's id, like every other break. After Enter there, `revealLine` turns the
marker into an empty line with the same id and `data-bb-at` (which side of the
break typing goes on). After a final `<br>`, it opens a line with
`data-bb-after`. The reconciler inserts whatever is typed at exactly that
offset. A line left empty is no edit.

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

`scripts/wysiwyg-gestures/run.mjs` (Miliastry) plays 43 gestures in real
Chromium per dialect, with boxes opened as a user opens them. It reports:

- each gesture's route;
- whether the BBCode shows what the canvas shows;
- whether distant author style survived byte for byte;
- for "gesture + type" rows, whether the typed text landed where the caret
  was.

The component's helpers are extracted from it on every run.

| Original 30 gestures | miliastry: phase 0 → **phase 1** | osu!: phase 0 → **phase 1** |
|---|---|---|
| command | — → **7** | — → **7** |
| surgical | 8 → 8 | 7 → 7 |
| element | 13 → **8** | 16 → **10** |
| full | 8 → **7** | 7 → **6** |
| text lost | 0 → 0 | 0 → 0 |
| distant style lost | 1 → 1 (select all) | 10 → **8** |

Phase 2 (Enter / Backspace / Delete, and editing inside boxes), on all 43
gestures in both dialects:

- **3 `full`**, all phase 3: pasting a block, inserting a box, select-all and
  type.
- **0 text lost** and **0 carets misplaced**.
- The only remaining `element` rows are typing in a quote or a list, and inline
  paste. None of them loses style.

Phase 3 (paste, toolbar blocks, links, typing over a selection): **0 `full`
in both dialects**. No gesture on the bench rewrites the document any more.
Text lost, carets misplaced and distant style lost are all 0. A box heading's
text now maps to its place in the opener's attribute.

Phase 0 was measurement. It found two bugs, both fixed:

- Enter mid-paragraph dropped the text after the caret.
- An osu! canvas was reconciled with miliastry markup, so one keystroke rebuilt
  untouched boxes.

## Next

- Nothing on the bench goes `element` or `full` any more. Every gesture is a
  `command` or `surgical`, in both dialects. The next gestures worth adding
  are tables, columns and image maps.
