# 12. Incremental parsing — where a keystroke's time goes

Written 2026-09-25, after two rounds of measuring real typing on the Miliastry
corpus (`docs/ai`, 65 documents) and the 547 KB fixture.

## Results

| | Before | Round 1 | **Round 2** |
|---|---|---|---|
| Real typing on the corpus, edits spliced incrementally | 66.7% | 92.1% | **96.4%** |
| ↳ typing in prose | ~96% | 96.2% | **99.9%** |
| ↳ typing inside tag syntax | ~62% | 87.0% | **91.9%** |
| 547 KB, typing in prose, per keystroke (`applyTextUpdate`) | 2.02 ms | 0.30 ms | 0.30 ms |
| 547 KB, random keystrokes, p50 | 4.92 ms | 0.99 ms | **0.89 ms** |
| 547 KB, random keystrokes, p90 | 54.2 ms | 2.99 ms | **2.02 ms** |
| 547 KB, random keystrokes, p99 | 65.3 ms | 67.3 ms | **28.6 ms** |
| 547 KB, random keystrokes, mean | 17.7 ms | 3.24 ms | **1.96 ms** |

The output did not change. The differential (`scripts/differential`) shows 0
of 52 097 outputs differing, after each round. Every patched tree equals a
full parse: 128 000 fuzzed edits over the Miliastry corpus after round 1, and
144 000 after round 2 (both dialects, a third of them with bracket-heavy edit
alphabets), with 0 divergences. The same fuzz, smaller and on documents that
live in this repository, is `Tests/IncrementalDifferential.test.ts`.

## What was costing what

**The parser declined too much.** Every refusal is a full rebuild: about 55 ms
at 547 KB, and the preview then has to reconcile the whole document instead
of patching a window. Four causes stood out.

- **List items.** `[*]` has no closing tag, so every `list_item` looked like
  "a tag left open at the window's edge", and every keystroke inside a list
  that was not in its last item fell back. This was 41% of all fallbacks.
  Now an item left open is accepted when the sibling right after the window is
  another item, because the full parse ends it exactly there.
- **Bare `[`.** The lexer emits a lone `[` in three places, and only one of
  them depends on the text after it ("no `]` matched"). Typing a space inside
  a closing tag (`[/col or]`) is one of the other two: that decision is made
  by a `]` the lexer did find. Now a bare `[` is accepted when its `]` (by
  bracket depth) is inside the window.
- **One window, then give up.** A window that cannot stand on its own is now
  the first rung of a ladder: the same run widened rightwards (+1, +3, +7…
  siblings), then the ancestor's window, level by level. Every rung passes
  every guard. The parse that rungs cost before one is accepted is capped at
  one document plus 16 KB, so the worst keystroke cannot cost more than about
  twice a rebuild.
- **The leak guard with nothing to protect.** A window that runs to the end of
  the document has no text after it to leak parser state into.

**Outside the parser, the model copied the document twice per keystroke.**

- `applyTextUpdate` found the edit with a char-by-char scan of the whole
  text: 1.1 ms. `Utils/textDiff` compares 16 KB → 32-character blocks as
  slices first (a native memory compare), which takes 0.04 ms and gives the
  same answer by construction.
- It then rebuilt the new text by concatenation, even though the editor had
  just handed over the same text flat. The first character read of that
  ConsString (the bracket index's) flattened all 547 KB, another ~0.5–1 ms.
  The given text is now used as is.

As a result, `applyTextUpdate` with a flat string is now the fast entry
point: 0.30 ms, against 0.79 ms for `applyChange`, which still has to
concatenate.

## Bugs the fuzz found on the way

Each one is pinned by a minimised regression test in
`Incremental/__tests__/IncrementalParser.test.ts`.

- **`PendingSpans.covers` excluded its end** (pre-existing). A name that
  became pending at the very offset where its retiring `[/tag]` began got an
  empty span. A window starting there then kept that `[/size]` as visible
  text, where the full parse discards it. The end is now inclusive.
- **Crossings born and retired inside one window** were never recorded
  (pre-existing, made common by wider windows). A later window starting
  between the two believed the name was not pending. `shifted` now adds the
  spans measured on the re-parsed region.
- **A root paragraph split across a window edge** (new with the ladder). Two
  paragraphs are never adjacent in a grouped tree, so a window whose edge
  paragraph touches one outside it is declined.

## Round 2: brackets that nothing can pair

Both remaining bracket guards asked "is this `[` paired?" when the question
that matters is "could the edit change what it pairs with?". The lexer pairs a
`[` with the first `]` after it at relative depth 0, so a `[` that has no `]`
before some offset stays unpaired exactly when the running bracket sum from
that offset to the end of the text never goes below 0. `BracketDepthIndex`
answers that for the text after a window from its piece summaries
(`suffixMin`), without reading it.

- **A stray `[` before the window** (`open-bracket-before`, 87 rebuilds on the
  corpus → 4). One `[sic` or half-typed tag near the top kept the depth above
  0 for the rest of the document, and every edit after it rebuilt. Now the
  window is accepted when every such bracket is unpaired both before and
  after the edit: the window's own (sum, lowest point), in the old text and in
  the new, composed with the lowest point of the text after it. The old
  window's brackets are rebuilt from the new text and the removed characters,
  which `DocumentModel` now passes to `reparse`.
- **A bare `[` inside the window** (`bare-bracket`, 34 → 4). Backspacing the
  `]` of a `[b]` leaves a `[` with no `]` in the window. When nothing after
  the window dips below 0, the full parse leaves it bare too.
- Two reads past a window edge stay refused in both places: a `[` right at the
  edge peeks at the next character, and a `[/` searches for its `]` without
  counting depth. The fuzz never reached either with the check removed; they
  stay because they cost nothing.

Each condition was mutation-tested: dropping the old-text side, the tail, or
the whole relaxation makes the fuzz diverge and a named test in
`IncrementalParser.test.ts` fail.

## What still falls back

On the corpus, the remaining 3.6% are real dependencies on text outside any
affordable window:

- **`open-before-siblings`** (54): a tag left open that swallows its siblings
  to a large ancestor's end — a space typed into `[/centr|e]`, a newline
  typed into `[s|ize=85]` (which makes it `[s]`, strikethrough).
- **`open-raw-block`** (11): a space typed into `[c|olor=…]` makes it `[c]`, a
  raw block that, with no `[/c]` after it, turns the whole rest of the
  document into literal text. The tree really does change to the end.
- Crossings with pending names and ancestors (`closes-pending`,
  `closes-ancestor`, `pending-auto-close`, 15 together), and the 8 bracket
  cases above.

On the 547 KB fixture's random keystrokes, 7 of 380 still rebuild, all of
them one of the first two kinds. `ReparseResult.isolation` /
`DocumentModel.lastReparseIsolation` name the check behind each one.
