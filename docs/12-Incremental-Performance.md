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

## Opening a document

A full parse — opening a document, and every rebuild — was untouched by the
two rounds above. Measured on the 547 KB fixture with `NODE_ENV=production`,
each figure the median of 10 alternated processes against the previous
commit:

| | Before | After |
|---|---|---|
| Cold open (first parse in the process) | 75.8 ms | **59.2 ms** |
| Warm open, p50 | 32.0 ms | **21.6 ms** |
| Warm open, best | 24.1 ms | **16.8 ms** |
| Heap kept by an open document | 20.2 MB | **12.5 MB** |
| Cold HTML render right after | 55.1 ms | 45.0 ms |

Nearly half of a warm open was the garbage collector, and what it spent its
time on was copying: almost everything a parse allocates survives, so each
young-generation collection moved the whole tree built so far. The work was
to allocate less of what survives, and to let what does not survive die young.

- **Tokens stream.** The parser reads tokens strictly in order, so it pulls
  them from a scanner (`createBBCodeScanner`) in batches of 512 instead of
  receiving an array of 54 733. A token is garbage before the next
  collection. `scanBBCode` still returns the array for everyone else, and osu!
  pairing, which looks ahead, still collects one.
- **Red nodes share their empties.** Leaves have no children, no diagnostics
  and no metadata, and each used to get three fresh empty objects. They share
  frozen ones (`NO_DIAGNOSTICS`, `NO_METADATA`, an empty children array); the
  writers take their own copy first (`ownDiagnostics`, `ownChildren`), and an
  unknown writer fails loudly instead of writing into every node.
- **`initChildren` takes the builder's array** instead of pushing each child
  into a second one that grew by reallocation.
- **`range` and `id` are made on first read.** The renderer reads neither for
  most nodes. A red node stores its start offset; the `range` object is
  created when asked for and kept in step with shifts from then on, so a
  caller holding one sees the same live object as before. Ids are minted on
  first read: still unique, only in a different order. (The differential
  normalises id numbers, which a nested render can carry escaped inside an
  attribute.)
- **Plain leaves skip the metadata and title calls** in `greenToRedNode`.
- **The lexer's scans go native where it can.** A `[` whose next `]` comes
  before any other `[` pairs with it (`indexOf`, no char loop); plain text
  ends at the next `[`, `\n` or `\r`, each position cached so the three
  searches stay linear. Correct and cheaper, though a cold open turned out
  to be bound per token, not per character.
- **`FREEZE_CHILDREN` was on where it could not be turned off.** Its guard
  read "no `process` means development", so a browser bundle without a
  `process` shim froze every children array — a guard its own comment prices
  at 32% of the parser. Without a `process` it is now off.

Tried and reverted: letting `GreenNode` adopt the parser's children arrays.
It saved about 4 ms of a cold open but kept each array's `push` slack alive —
2 MB on the fixture, for as long as the document is open.

What is left of a cold open is mostly V8 running the lexer, parser and red
build before it has optimised them: a larger young generation changes
nothing, and a cold open is still about 2.7× a warm one. Parsing some 150 KB
of anything first brings the next cold open of the fixture from 60 to 37 ms,
which is an application's choice (an idle-time warm-up), not the engine's.
`Tests/ColdOpen.test.ts` pins the behaviour; each fast path was
mutation-tested against it.

### Where a cold open's time goes — and "JIT-friendly" tested

The cold/warm gap was split by preparing the process three ways before one
open of the fixture (`NODE_ENV=production`, six processes each):

| Before the open | Open |
|---|---|
| nothing — truly cold | ~62 ms |
| ~40 MB of unrelated objects allocated and dropped (heap grown, JIT cold) | ~43 ms |
| six parses of a 30 KB slice (JIT warm, heap small) | ~34 ms |
| everything warm | ~21 ms |

So a cold open is roughly a third real work, a third the heap growing for the
first time, and a third V8 learning the code. None of V8's tiering flags
(`--always-sparkplug`, `--no-lazy-feedback-allocation`, `--no-maglev`,
`--max-lazy`) moved it, and `--trace-deopt` shows four deoptimisations in a
whole cold open, all "insufficient type feedback": V8 is not fighting this
code. Two "JIT-friendly" changes were measured against the previous commit:

- **One hidden class for all tokens** (six fields, one constructor): no
  effect, cold or warm. Three shapes at a site is polymorphic, not
  megamorphic, and V8 handles it. Reverted.
- **The parser loop's two tag branches as their own functions** (`onOpen`,
  `onClose`): the parser's Turbofan compile went from 24 ms to 8 ms, and a
  warm open from 21.9 to 20.4 ms (two runs of 16 and 20 alternated
  processes). A cold open did not move — V8 was not waiting for Turbofan,
  its earlier tiers were already running the loop. Kept, for the warm gain
  and a loop that now reads in thirty lines.

The lever left inside the engine for a cold open is memory: every surviving
byte is heap V8 has to grow into. Past that, an idle-time warm-up in the
application covers the JIT third.

