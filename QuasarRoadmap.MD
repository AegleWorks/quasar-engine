# 🌌 Quasar — Performance Audit and Optimization Roadmap

> A strict audit of the whole engine (126 files, ~17k LOC) carried out on **2026-07-31**.
> Every figure in this document is **measured**, not estimated. The methodology is at the end.
>
> **Status:** Weeks 1 to 11 ✅ completed. **The audit is closed**: the four
> pillars the engine declared and did not execute —*structural sharing*, *incremental parsing*,
> *stable node identity*, *reliable offsets*— work and are validated differentially.

---

## Index

- [0. Verdict](#0-verdict)
- [1. Results table](#1-results-table)
- [2. Findings — Tier S (broken)](#2-findings--tier-s-broken)
- [3. Findings — Tier A (performance)](#3-findings--tier-a-performance)
- [4. Findings — Tier B (architecture)](#4-findings--tier-b-architecture)
- [5. Week 1 — Stop the bleeding ✅](#5-week-1--stop-the-bleeding-)
- [6. Week 2 — The real 10× ✅](#6-week-2--the-real-10-)
- [7. Week 3 — Structural debt ✅](#7-week-3--structural-debt--except-block-14--9)
- [7-bis. Week 4 — The partition and the incremental ✅](#7-bis-week-4--the-partition-and-the-incremental-)
- [7-ter. Week 5 — Real structural sharing ✅](#7-ter-week-5--real-structural-sharing-)
- [7-quater. Week 6 — The lexer ✅](#7-quater-week-6--the-lexer)
- [7-quinquies. Week 7 — Incremental granularity ✅](#7-quinquies-week-7--incremental-granularity)
- [7-sexies. Week 8 — The parser ✅](#7-sexies-week-8--the-parser)
- [7-septies. Week 9 — The `applyTextUpdate` diff ✅](#7-septies-week-9--the-applytextupdate-diff)
- [7-octies. Week 10 — `analyze()` ✅](#7-octies-week-10--analyze)
- [7-nonies. Week 11 — The lexer's bracket memo ✅](#7-nonies-week-11--the-lexers-bracket-memo)
- [8. Measurement methodology](#8-measurement-methodology)

---

## 0. Verdict

The architecture *on paper* is correct (Roslyn green/red, incremental parsing, pass pipeline).
But the engine **did not execute that architecture**. Three of its four pillars —*structural sharing*,
*incremental parsing*, *stable node identity*— were broken or disconnected at runtime.

`QUASAR.MD §3` declares a budget of **140 FPS / < 0.2 ms**. The real starting measurement
was **290 ms per keystroke**: a factor of **1450×** above the self-imposed target.

---

## 1. Results table

Reference document: `src/problematic_sectionwgradient.milia` — 19.6 KB, 1736 nodes.

| Metric | Baseline | After Week 1 | After Weeks 2-3 | Target |
|---|---|---|---|---|
| Live XSS vectors in the preview | 5 | **0** ✅ | 0 | — |
| Lexer, 16k unclosed `[` | 555.56 ms | **2.72 ms** ✅ | 2.72 ms | — |
| `NodeMatcher.match` (1 char) | 380.2 ms | 5.14 ms | **~0** ✅ (lazy) | ~1 ms |
| **`DocumentModel.rebuild`** | 290.4 ms | 15.13 ms | **3.81 ms** ✅ | < 5 ms |
| **`HTMLRenderer.render`** | 1.95 ms | 1.43 ms | **0.290 ms** ✅ | < 0.3 ms |
| `render`, 4000 siblings | 14.11 ms | 14.11 ms | **1.25 ms** ✅ | linear |
| **`greenToRedNode`** | 3.95 ms | 2.13 ms | **0.252 ms** ✅ | < 0.8 ms |
| `new BBCodeDocumentModel` | 5.92 ms | 5.85 ms | **2.88 ms** ✅ | — |
| HTML emitted (19.2 KB doc) | — | 140.6 KB | **88.7 KB** ✅ | — |
| `parseTokensToGreen` | 0.583 ms | 0.546 ms | 0.644 ms | — |
| `tsc --noEmit` errors | 48 | **0** ✅ | 0 ✅ | 0 (gate in CI) |
| Diagnostics the engine emitted | **0** (3 of 4 validators unreachable) | 0 | **they work + new `unclosed-tag`** ✅ | — |
| Test suite | 4 red + 60% flake | 170 green + 1 `expected fail` | **195 green, no `expected fail`** ✅ | — |

### Week 4 — what it added

| Metric | Before (week 3) | After Week 4 | Note |
|---|---|---|---|
| Documents whose tree partitions the source | **12.42%** | **100%** ✅ | 18,017 documents |
| Partition violations in the corpus | 270,771 | **0** ✅ | 5 distinct types |
| Fixed point of `parse → export` | 99.67% | **100%** ✅ | deleting orphans broke it |
| Incremental edits with a correct tree | 3 of 6 scenarios | **22,100 of 22,100** ✅ | differential validation |
| Cost per keystroke (19.6 KB fixture) | 2.78 ms (rebuild) | **1.22 ms** ✅ (−56%) | 100% incremental hit rate |
| Test suite | 195 green | **243 green** ✅ | +40 partition, +8 incremental |

### Week 5 — what it added

| Metric | Before | After Week 5 | Note |
|---|---|---|---|
| Real deduplication of green nodes | **0%** | **59.6%** ✅ | 1736 nodes → 702 objects |
| Interner `collisionHits` | 0 | **226** ✅ | interning of inner nodes works |
| Green tree memory | 258 KB | **148 KB** (`leaves`) / **114 KB** (`full`) | −42% / −56% |
| Interner ON vs OFF: tree, HTML, export, partition | *offsets lied* | **100% identical** ✅ | 18,016 documents, both modes |
| `shiftGreen` in the incremental splice | 14% of the reparse | **eliminated** ✅ | there is nothing left to shift |
| Test suite | 243 green | **259 green** ✅ | +16 sharing |

### Week 6 — the lexer

| Metric | Before | After | Note |
|---|---|---|---|
| `scanBBCode`, 19.6 KB fixture | 0.618 ms | **0.278 ms** ✅ | **2.22×** |
| `scanBBCode`, 20 KB heavily tagged | 0.576 ms | **0.263 ms** ✅ | 2.19× |
| `scanBBCode`, 20 KB in UPPERCASE | 0.563 ms | **0.290 ms** ✅ | 1.94× |
| `scanBBCode`, 20 KB of plain text | 0.073 ms | **0.058 ms** ✅ | 1.27× |
| **Cost per keystroke** | 1.09 ms | **0.905 ms** ✅ | −17% |
| Token stream vs the previous lexer | — | **identical** ✅ | 56,049 docs, 776,021 tokens |
| Test suite | 259 green | **308 green** ✅ | +49, the lexer had none |

### Week 7 — incremental granularity

| Metric | Before | After | Note |
|---|---|---|---|
| `parse` per keystroke inside `[notice]` | 0.267 ms | **0.0098 ms** ✅ | **27×** — the region stops being 66% of the document |
| Reparse inside `[notice]` | 0.688 ms | **0.378 ms** ✅ | −45% |
| Typing at the end of the post | *full rebuild* | **0.657 ms** ✅ | 43/43 hits; before 0/43 |
| Keystroke with the caret at the end | 1.92 ms | **0.657 ms** ✅ | −66% |
| Divergences vs rebuild | — | **0 of 32,100** ✅ | differential fuzz |
| Test suite | 308 green | **311 green** ✅ | +3 root edit |

### Week 8 — the parser

| Metric | Before | After | Note |
|---|---|---|---|
| `parseTokensToGreen`, 19.6 KB fixture | 0.480 ms | **0.314 ms** ✅ | **1.53×**, A/B alternating against HEAD |
| `Object.freeze` per node | 30% of the parser | **0** in production | kept in dev and in tests |
| Tree identical to the previous parser | — | **196,076 parses** ✅ | 1,985,691 nodes, 0 divergences |
| Cost per keystroke | 0.698 ms | 0.700 ms | no change, and that is expected |

### Week 9 — the `applyTextUpdate` diff

| Metric | Before | After | Note |
|---|---|---|---|
| Keystroke, edit **in the middle** | 0.702 ms | **0.620 ms** ✅ | −12%, A/B against HEAD |
| Keystroke, **append at the end** | 0.617 ms | 0.627 ms | no change (see below) |
| `TextChange` identical to the previous one | — | **253,902 pairs** ✅ | 0 divergences |

### Week 10 — `analyze()`

| Metric | Before | After | Note |
|---|---|---|---|
| `analyze()`, clean document | 0.601 ms | **0.295 ms** ✅ | **2.0×**, median of 7 batches |
| `analyze()`, document full of errors | 1.58 ms | **1.12 ms** ✅ | 1.4× |
| `rebuild` with analysis | 2.74 ms | **2.03 ms** ✅ | −26% |
| Diagnostics and their assignment to nodes | — | **identical** ✅ | 20,002 docs, 18,929 with diagnostics |

### Week 11 — the lexer's bracket memo

| Metric | Before | After | Note |
|---|---|---|---|
| `scanBBCode`, 19.6 KB fixture | 0.286 ms | **0.226 ms** ✅ | −21% |
| `scanBBCode`, 20 KB heavily tagged | 0.283 ms | **0.199 ms** ✅ | −30% |
| `scanBBCode`, 16k unclosed brackets | 1.996 ms | 2.004 ms | **no change** — the quadratic fix is still intact |
| Token stream | — | **identical** ✅ | 56,012 docs, 882,752 tokens |

### Pipeline breakdown (baseline)

| Phase | ms | Note |
|---|---|---|
| `scanBBCode` (lex) | 0.91 | acceptable |
| `parseTokensToGreen` | 0.82 | acceptable |
| **`greenToRedNode`** | **3.95** | slower than lex+parse together |
| `HTMLRenderer.render` | 1.95 | no cache |
| `new BBCodeDocumentModel` | 5.92 | per call |
| **`rebuild()` with matcher** | **290** | 🔴 |

---

## 2. Findings — Tier S (broken)

### S1 · `GreenNode._hash` did not exist — structural sharing was fiction ✅ RESOLVED

`GreenNodePool` and `RedNodeStore` read a property that the class never defined:

```
src/Syntax/GreenNodePool.ts:151   h = this.hashCombine(h, children[0]._hash)   // undefined
src/Syntax/RedNodeStore.ts:52     const hash = green._hash.toString()          // TypeError
```

Consequences:
- `RedNodeStore.getOrCreate()` threw `TypeError` on its first line. **It never ran.**
- `computeBucketKey()` did `seed ^= undefined` → coerces to `0` → the key **ignored the children**.
  All equal `<kind, text, childCount>` fell into the same bucket → `O(N)` interning per node → **global `O(N²)`**.

**Resolved:** `_hash` implemented (FNV-1a, memoized, *excluding the range*). `RedNodeStore` now
works: **53.5% dedup** on a real document.

### S2 · `internLeaf` returns incorrect ranges ✅ RESOLVED (Week 5) — see §7-ter

```ts
// GreenNodePool.ts:68
const key = `${kind}:${text}`   // without start/end
```

The key ignores the position: the second occurrence of `"Hello"` returns the cached node
**with the range of the first**. If the interner is turned on, everything that depends on offsets
(incremental, `findNodeAtOffset`, diagnostics, Monaco↔AST mapping) starts lying silently.

In addition, `internNode` (`GreenNodePool.ts:108-109`) requires identical `range.start`/`range.end` to
deduplicate → the same block pasted 10 times gives **0% dedup and 100% of the scanning cost**.
Confirmed after fixing `_hash`: `collisionHits: 0`.

### S3 · `NodeMatcher` — 380 ms per typed character ✅ RESOLVED

Two failures multiplying:

1. **Phase 1 (match by ID) never hit.** `RedNode` generates a fresh `createNodeId()` on every
   construction → after a `rebuild()` no ID matches. `exact: 0`. Always.
2. **Phase 2 was `O(n² · subtree)`**: a nested loop that recomputed `fingerprint()` (a full
   `walk()` with a string array + `join()`) on every comparison. 1736 × 1736 fingerprints.

Bonus: the result was **incoherent** — `moved: 1734` and `deleted: 1736` at the same time, because Phase 2
deleted from `unmatchedNew` but never from `unmatchedOld` (`NodeMatcher.ts:133`).

**Resolved:** memoized bottom-up fingerprints (64 bits, two FNV lanes) + a bucket index with a
cursor. Scaling is now linear. Coherence fixed: 1736 classifications for 1736 nodes.

### S4 · Active XSS in the preview ✅ RESOLVED

`escapeHtml` covered `& < > "` but style values were injected **without escaping any of them**:

```
IN : [color=red;" onmouseover="alert(1)]hola[/color]
OUT: <span style="color:red;" onmouseover="alert(1);">hola</span>
                       ↑ real, working event attribute
```

Confirmed vectors: `color`, `size`, `font`, `shadow` (`HTMLRenderer.ts:218-240`) and `gradient`
(`:432` — the `startsWith('#')` filter saved nothing: `#a" onmouseover="…` gets through).
It reached `morphHTML()` / `dangerouslySetInnerHTML` in `Preview.tsx:56`,
`preview-panel.tsx:124`, `SnippetsWindow.tsx:309`.

**Resolved:** `escapeHtml` now also escapes `'`, and CSS values go through allowlists
(`CSS_COLOR_RE`, `CSS_SIZE_RE`, `CSS_FONT_RE`). Verified: 0 injections, render of valid BBCode
identical.

### S5 · The incremental parser leaves the tree lying ✅ RESOLVED (Week 4) — see point 9

`IncrementalParser.reparse()` replaces a subtree in-place but **never shifts the offsets of
siblings or ancestors**. The code itself admits it:

```ts
// IncrementalParser.ts:78
// Tree ranges are stale (after fast-path appends without range updates).
```

And instead of fixing it, it does a full rebuild when it detects the corruption. Worse:

```ts
return { green: newRootRed.green, ... }   // :151, :202
```

It returns the root's **old green node** → `_greenRoot` and `_redRoot` stay out of sync
permanently after the first incremental edit.

In addition, `BBCodePipeline.process()` returns **the same reference** `this._model.redRoot` mutated
in-place: any React consumer that compares `prevAst !== nextAst` sees nothing.

### S6 · `O(n²)` lexer with unclosed brackets ✅ RESOLVED

For each `[`, it scanned until it found `]`; if there was none, it scanned **to the end** and
advanced *a single character*.

| Input | Before | Now |
|---|---|---|
| 2000 unclosed `[` | 12.25 ms | ~1 ms |
| 4000 `[` | 36.29 ms | ~1 ms |
| 8000 `[` | 143.38 ms | ~2 ms |
| 16000 `[` | **555.56 ms** | **2.72 ms** |

DoS by pasting: any code snippet or ASCII art with brackets froze the editor.

**Resolved:** a single sweep discovers the `]` of *all* the `[` it crosses via the bracket
stack, and memoizes. `O(n²)` → `O(n)`.
**Validated differentially** against the previous algorithm: 149,894 positions compared,
**0 discrepancies** + 50,000 random documents with contiguous coverage intact.

---

## 3. Findings — Tier A (performance)

### A1 · `greenToRedNode` — 90% is ceremony ✅ RESOLVED (Week 2)

```
greenToRedNode (real)              2.59 ms
equivalent walk without ceremony   0.27 ms   ← 9.6×
walk + randomUUID                  0.78 ms
```

The cost is not building the tree, it is:
- **`crypto.randomUUID()` per node** (1736 UUIDs). They are also 36 characters that get spat out into *every*
  HTML element as `data-node-id` → bloated HTML and slower morphing. A monotonic counter is
  ~7× faster and 4× shorter. The randomness adds nothing: these are not distributed IDs.
- **`RedNode.allowMutation(() => {...})` per node** — closure + `try/finally` + static flag, 1736
  times, to populate freshly created children.
- **`extractGreenNodeMetadata`** allocates two closures (`firstChildText`, `stripBBCode`) **per node**
  even when the `switch` does not use them.

### A2 · `previousSibling` / `nextSibling` / `index` are `O(n)` ✅ RESOLVED (Week 2)

```ts
// RedNode.ts:132, 139, 146
const idx = this.parent.children.indexOf(this)
```

`HTMLRenderer.isPrevBlockBoundary()` (`:177`) walks siblings backwards in a loop, and **every step
does an `indexOf`** → quadratic render:

| Root siblings | ms |
|---|---|
| 500 | 0.96 |
| 1000 | 1.97 |
| 2000 | 5.33 |
| 4000 | **14.11** ← 2.6× per doubling |

**Fix:** cache `indexInParent` in the `RedNode`, invalidated on structural mutations (which all
already go through `assertMutating`). Three `O(n)` getters → `O(1)`, linear render.

> Note: `NodeMatcher` no longer uses the `index` getter (Week 1 precomputes it in its traversal), but
> `HTMLRenderer` and `QueryEngine` still use it.

### A3 · Zero render cache ⛔ DISCARDED (Week 2) — see the warning in point 8

`RedNodeStore.ts:21` promises *"HTMLRenderer cache: same canonicalId = same HTML"*. **It does not exist.**
Every keystroke re-renders the whole document to a string. With `_hash` (already available) + a memo by
hash the hit ratio would be very high: 99% of the tree does not change between keys.

### A4 · `HTMLRenderer` builds strings by concatenation ✅ RESOLVED (Week 2) — but the bottleneck was `escapeHtml`

Every `wrapInline`/`wrapBlock` does `children.map(...).join('')` + a template literal → two
intermediate arrays and N temporary strings per node. A single accumulator `string[]` in pre-order eliminates
almost all of it.

Detail: `this.depth` and `this.inlineLevel` are incremented and decremented religiously and
**never read**. Dead state in the hot loop.

### A5 · Options silently discarded ✅ RESOLVED (Week 3)

```ts
// BBCodeDocumentModel.ts:48
super({ source: '', language: options.language ?? 'bbcode' })
```

`autoAnalyze` and `maxUndo` **never reach `DocumentModel`**. Verified: passing
`autoAnalyze: false` does not change the time. Semantic analysis cannot be turned off.

`QuasarEngineService.parse()` (`:35`) builds a full `BBCodeDocumentModel` per call
—instantiating `TagRegistry`, `NodeFactory`, `TreeBuilder`, `NodeMatcher`, `SemanticAnalyzer`,
`IncrementalParser`, `ChangeTracker`, `UndoManager`, `QueryEngine`, `EventBus`— for a
throwaway parse. `SnippetsWindow` calls it for every snippet.

### A6 · `analyze()` is `O(N · D)` unnecessarily ✅ RESOLVED (Week 3) — but D was 0, see point 15

`DocumentModel.analyze():404` does a full `walk()` to clear diagnostics and then a
`findById()` (`O(N)`) **for each diagnostic**. The `Map<id, node>` is already built inside
`SemanticAnalyzer.analyze()` — it is enough to return it.

### A7 · `ASTOptimizer` clones with `JSON.parse(JSON.stringify(...))` ✅ RESOLVED (Week 3)

Four places (`:84, :117, :123, :151`) and two comparisons via `JSON.stringify` (`:192-193`).
Deep-clone and deep-equal by serialization in a transformer that walks the whole tree.

### A8 · `DOMMorpher` without keys ✅ RESOLVED (Week 3) — but not with keys, see point 12

`morphNodes` pairs children **by index**. Inserting a node at the start causes a cascade of
`replaceChild` over everything that follows — exactly what a morpher must avoid. `data-node-id` is already
emitted on every element: use it as the key (like `morphdom`/`idiomorph`).
Also `Array.from(childNodes)` at every level of recursion.

---

## 4. Findings — Tier B (architecture)

### B1 · `tsc` did not compile — 48 errors ✅ RESOLVED

Including 3 that were a **real runtime crash** (`_hash`). `tsc` had been detecting it all along;
nobody just ran `tsc`.

Two latent bugs discovered while fixing the types:

- **`MarkdownExporter.extractValue` read `node.properties` / `node.attributes`**, which do not exist on
  `RedNode` → it always returned `undefined`. Markdown export had always been
  losing link destinations and quote/box titles. ✅ Rewritten.
- **`MarkdownToGreenNode` dropped `image` and `code_inline`** (they fell into `default` as empty text).
  ✅ Added, and the `default` is now an exhaustiveness guard (`const unhandled: never = node`).
- `MarkdownSpoiler`/`MarkdownNotice` added to the union: the parser already produced them with `as any`.

### B2 · The "mutation lock" protects nothing ✅ RESOLVED (Week 3) — see point 13

`RedNode.assertMutating()` is a **global** static flag. `allowMutation()` turns it on for the whole
process. There is no isolation per document, transaction or thread. It is an expensive `console.assert`
disguised as an invariant — and the red tree is freely mutated from `IncrementalParser`,
`treeTransformers`, `Transaction` and `RedNodeStore`. The "strict immutability" that `QUASAR.MD §3`
invokes to justify the concurrency tolerance **is not in the code**.

### B3 · Logic duplicated word for word ✅ RESOLVED (Week 3)

`RedNodeStore.extractIntrinsicMetadata()` (`:133-183`) is a **literal copy** of
`BBCodeToGreenNode.extractGreenNodeMetadata()` (`:184-236`). The comment itself says so:
*"Mirrors extractGreenNodeMetadata"*. Two sources of truth for the attrs→metadata mapping.

### B4 · Dead code declared as a feature ✅ RESOLVED (Week 3)

- `const SELF_CLOSING = new Set<string>([])` (`Parser.ts:39`) — **empty**. All the
  `SELF_CLOSING.has(...)` branches are unreachable.
- `IncrementalParser.fullReparse()` ignores the parser and returns the whole document as **a single
  text node**. If anything calls it, it destroys the tree.
- `SAFE_BOUNDARY_TAGS` is an array with `.includes()` in the climbing loop (`:102`) → it should be a `Set`.
- Inert copy-paste blocks in the lexer (they assign variables and reassign them identically two lines later).

### B5 · The tests lied about the state of the engine ✅ RESOLVED (partial)

- ✅ **4 permanently red tests** because of `src/document_test.milia`, which does not exist and is not even in
  the git history. Deleted (approved by the user), along with `UrlImgBugEngine.test.ts`, which
  imported `../Engine/QuasarEngine` (nonexistent) and was a duplicate, without assertions, of
  `UrlImgBug.test.ts`.
- ✅ **The fuzzer used `Math.random()` with no seed.** Measured: `pass, FAIL, FAIL, FAIL, pass`
  → **60% flake**, and when it failed the payload was lost. It now uses mulberry32 with a fixed seed
  and an override via `QUASAR_FUZZ_SEED`. Deterministic 5/5.
- ✅ **`ASTOptimizer` is not idempotent** — resolved in Week 3, point 11.
- ⏳ Several tests are `console.log` with no assertions (`StudioDebugText`, `UrlImgBug`,
  `ProblematicSection`): they print, they do not verify.

---

## 5. Week 1 — Stop the bleeding ✅

**Completed on 2026-07-31.** Suite: 170 green + 1 `expected fail`, deterministic 5/5. `tsc`: 0 errors.

| # | Task | Status |
|---|---|---|
| 1 | Escape attributes + CSS value allowlist (S4) | ✅ |
| 2 | Cache the `indexOf(']')` failure in the lexer (S6) | ✅ |
| 3 | Rewrite Phase 2 of `NodeMatcher` + fix `unmatchedOld` (S3) | ✅ |
| 4 | `tsc --noEmit` in CI + fix the 13 errors in `src/` (B1) | ✅ |

### Files touched

```
src/Syntax/hash.ts                        NEW — shared FNV-1a primitives
src/Syntax/GreenNode.ts                   real _hash (lazy, sentinel -1, `declare`)
src/Syntax/NodeMatcher.ts                 rewrite of phases 1-3
src/Lexer/BBCodeLexer.ts                  bracket-pairing memo
src/Visitors/HTMLRenderer.ts              CSS allowlists + escaping of `'`
src/Visitors/MarkdownExporter.ts          extractValue fixed (latent bug)
src/BBCode/Parser.ts                      NodeKind cast
src/Markdown/MarkdownAST.ts               + MarkdownSpoiler, MarkdownNotice
src/Markdown/MarkdownParser.ts            removed two `as any`
src/Markdown/MarkdownToGreenNode.ts       + image, code_inline, exhaustiveness guard
src/Studio/index.ts                       ColorStop disambiguation
src/Tests/Fuzzer.test.ts                  mulberry32 with seed
src/Tests/ASTOptimizerIdempotence.test.ts NEW — pinned repro of the idempotence bug
src/Diff/__tests__/TreeDiffer.test.ts     NodeId/NodeKind types + vitest imports
src/Incremental/__tests__/…test.ts        TextChange without `kind`
package.json                              typecheck / verify scripts
../../.github/workflows/quasar-verify.yml NEW — CI gate
DELETED: StudioExport/Structure/Text/Equality.test.ts, UrlImgBugEngine.test.ts
```

### Trap found during implementation

The `_hashCache` field cost **23% of parsing** (0.583 → 0.718 ms). With `target: ES2022`,
TypeScript enables `useDefineForClassFields` by default, so a field declaration emits a
`defineProperty` on **every construction**. Solution: `private declare _hashCache: number` +
assignment in the constructor with a `-1` sentinel. Result: **0.546 ms**, below the baseline.

> ⚠️ This trap applies to **any new field** added to `GreenNode` or `RedNode`.
> Always measure before and after.

---

## 6. Week 2 — The real 10× ✅

**Completed on 2026-07-31.** Both targets reached: `rebuild` 15.13 → **3.81 ms** (< 5) and
`render` 1.43 → **0.290 ms** (< 0.3). Suite: 170 green + 1 `expected fail`. `tsc`: 0 errors.

Order of attack: 6 → 7 → 8 → 5, chosen so as not to block the week behind the structural change.

### 6. Monotonic IDs + cached `indexInParent` (A1, A2) ✅

- `createNodeId()` goes from `crypto.randomUUID()` to a monotonic counter (`n0`, `n1`, …).
  Verified before touching anything: `NodeId`s are **never restored from persistence**, only
  written, so the randomness added nothing. **HTML emitted: 140.6 → 88.7 KB (−37%)**.
- `indexInParent` cached with a **self-validating** design: the getter trusts the index only if
  `parent.children[cached] === this`, and recomputes if not. That single reference comparison makes it
  immune to code that mutates the array directly (`treeTransformers` does
  `cloned.children = []`), which is exactly where a cache with explicit invalidation would lie
  silently. The index is also seeded in `appendChild`, so construction never searches.
- Validated differentially against `indexOf`: **35,111 nodes, 0 discrepancies**, including
  5,382 structural mutations and direct manipulation of the array behind the cache's back.
- Render of 4000 siblings: **14.11 → 5.20 ms** (already linear at this point).

### 7. Remove `allowMutation` from the construction path (A1) ✅

- New `RedNode.initChildren(children)`: adopts the whole array at once, outside the lock. Before,
  `allowMutation(() => { for (…) appendChild(…) })` was called **once per node** — 1736 closures,
  1736 `try/finally` and 1736 static flag guards per parse.
- Applied to the four red tree constructors (`BBCodeToGreenNode`, `MarkdownToGreenNode`,
  `HTMLToGreenNode`, `UIBlocksToRedTree`) and to `RedNodeStore`.
- `extractGreenNodeMetadata`: the two closures (`firstChildText`, `stripBBCode`) hoisted to
  module level — they were allocated per node even when the `switch` did not use them.
- **`greenToRedNode`: 2.13 → 0.251 ms (8.5×)**, well below the 0.8 ms target.

### 8. Renderer (A3, A4) ✅ — with a deviation

- **The real bottleneck was not the `map/join` that A4 pointed to, but `escapeHtml`**: it made five regex
  passes over *every* string, with up to five intermediate allocations, even though normal prose does not
  contain any of those five characters. Rewritten to a `test` + a single pass.
  Validated differentially against the previous implementation: **208,212 cases, 0 discrepancies**
  (includes the whole one-character space up to U+2000 and 200,000 random strings).
- `renderChildren()` replaces the `map().join('')` idiom in the 16 places.
- `this.depth` and `this.inlineLevel` deleted. `tsc` confirmed that `inlineLevel` was still referenced,
  but only to write: eight `++`/`--` and no reads.
- **`render`: 1.567 → 0.290 ms. With 4000 siblings: 14.11 → 1.25 ms (11.3×).**

> ⚠️ **The `_hash` cache was NOT implemented, and must not be implemented as specified.**
> Two independent reasons, both verified:
> 1. The HTML has `node.id` embedded in every element. Caching a subtree by `_hash` would make
>    two structurally identical subtrees emit **the same `data-node-id`** — duplicate ids
>    in the DOM, which is exactly what would break plan A8 of using them as the morpher's key.
> 2. `spacing` and `empty_line` depend on their **siblings** (`isPrevBlockBoundary`,
>    `isNextCodeBlock`), not just on their subtree. `_hash` does not capture that context, so it would be an
>    incorrect key for those nodes.
>
> The target of < 0.3 ms was reached without a cache. A related fact discovered while analyzing it:
> ~~**`data-node-id` is written but nobody reads it** in the whole repo — today it is dead weight in the HTML.~~
>
> ⚠️ **This is FALSE and deleting it because of that belief would break the editor.** `usePreviewClick.ts:108-112`
> does `target.closest('[data-node-id]')` to translate a click in the preview into a node, and from there
> comes the event that syncs the selection with Monaco. It is the Preview→Monaco half of the
> bidirectional system. Corrected in week 7 by checking it instead of repeating it.
>
> What is true and **is worse**: they are **33.4 KB of the 88.7 KB** of HTML (38%), and since the ids
> are regenerated on every parse, they change on every keystroke. That disables the fast path of the
> `DOMMorpher`, which skips subtrees with `isEqualNode`: measured on a one-character edit,
> **2 of 5** first-level children compare equal with the ids in place, versus **4 of 5** without
> them. The solution is not to delete them, it is to make the ids **stable** across reparses.

### 5. Structural sharing (S2) ⛔ in Week 2 — premise refuted; ✅ RESOLVED in Week 5 (§7-ter)

**The decision to adopt the Roslyn width model was made and then reverted**, because the earlier
differential validation refuted the assumption it had been based on.

The width model requires the tree to be a **partition** of the source text. Measured over 71,070
nodes (2 real fixtures + 5,000 random documents with a seed):

| Divergence | Cases |
|---|---|
| Σ width of children ≠ declared width | 34,366 |
| `parent.start` ≠ `firstChild.start` | 32,630 |
| Gaps between siblings | 6,272 |
| Overlaps between siblings | 3,250 |

Two causes, both confirmed with minimal cases:

1. **Delimiters are not child tokens.** In `[center]…[/center]` the text `[center]` lives in the
   `text` of the parent, not as a child, so the parent legitimately extends beyond its children.
   Deriving positions by summing widths would lose the 8 characters of the tag at every nesting.
2. **There are siblings with identical ranges.** `"hola\n\nmundo"` produces
   `spacing [4..6]` and `empty_line [4..6]` — two siblings over the same 2 characters. The widths
   would be counted twice and all later offsets would shift.

**Conclusion:** doing the Roslyn model for real requires the parser to emit delimiters and spacing
as real tokens of the tree. That is not removing a field, it is rewriting the parser. See point 14 of
week 3, where it also turns out to be a **prerequisite of point 9**.

Instead, what was really blocking the week's target was attacked — below.

### 5-bis. Lazy `NodeMatcher` ✅ — what did unblock the target

Profiling the real `rebuild` (not the isolated phases), `NodeMatcher.match` was **5.11 of 8.17 ms, 62%**.
Two changes:

- A **Phase 0** that pairs unchanged subtrees using `green._hash`, trimming the common prefix and
  suffix at each level. A detail that cost an iteration: requiring the child counts to
  match before descending seemed reasonable, but it meant that **a single node inserted
  near the root disabled the fast path for the whole tree** (measured: it stayed at 5.11 ms).
  Prefix/suffix trimming is immune to that.
  A 32-bit hash is not proof of equality, so each pairing is **verified
  structurally** before being confirmed, with an atomic commit.
- **The big finding: nobody consumes `nodeMatch`.** It was computed on every keystroke —~3.5 ms, a
  result object per node plus five Maps/Sets— to fill an event field that no
  subscriber reads, neither in `packages/quasar`, nor in `MiliastryCore`, nor in `MiliastryNovaFeatures`.
  It is now a **lazy accessor** (`DocumentModel.defineLazyNodeMatch`): the capability is still
  available and `event.nodeMatch` works the same for callers, but it is not run
  speculatively. Note: the closure keeps `oldRoot` alive for as long as the event is retained.
- Invariants revalidated: **307 editing scenarios, 1,054,602 nodes, 487,284 `exact` pairs
  verified one by one, 0 failures.** (Phase 0 claims nodes before phases 1-3, so the
  bookkeeping that Week 1 fixed was checked again in full.)

### Final breakdown of `rebuild` (3.81 ms)

| Phase | ms | % |
|---|---|---|
| `parseToGreen` (lex + parse) | 1.99 | 48.7% |
| `analyze()` | 1.28 | 31.5% |
| `buildRedFromGreen` | 0.79 | 19.4% |
| `NodeMatcher` | 0 (lazy) | — |

The next natural targets are `analyze()` (point 10, A6) and the lexer.

### Files touched

```
src/Types/core.ts                     monotonic createNodeId + __resetNodeIdCounter
src/Syntax/RedNode.ts                 self-validating _idxCache, initChildren, reindexFrom
src/Syntax/NodeMatcher.ts             Phase 0 (prefix/suffix by _hash) + verifyIdentical
src/Syntax/RedNodeStore.ts            initChildren
src/Model/DocumentModel.ts            defineLazyNodeMatch in both event paths
src/Visitors/HTMLRenderer.ts          escapeHtml single pass, renderChildren, no inlineLevel/depth
src/BBCode/BBCodeToGreenNode.ts       initChildren + metadata closures at module level
src/Markdown/MarkdownToGreenNode.ts   initChildren
src/HTML/HTMLToGreenNode.ts           initChildren
src/BBBlocks/UIBlocksToRedTree.ts     initChildren (two branches unified)
```

---

## 7. Week 3 — Structural debt ✅ (except block 14 → 9)

> ⚠️ **Read point 14 first.** Week 2 discovered that point 9 cannot be done properly without
> it, and that it is also the real route to point 5.

### 9. Fix the incremental parser for real (S5) ✅ RESOLVED in Week 4 — see §7-bis

It was blocked by 14, and rightly so: `shiftRanges` has no correct answer while the
ranges do not partition the source. With siblings that occupy the same `[4..6]` there is no single thing to
shift.

### 10. Cleanup (B3, B4, A5, A6, A7) ✅

- ✅ **B3** — `RedNodeStore` no longer carries a literal copy of `extractGreenNodeMetadata`: it receives a
  `MetadataExtractor` via its constructor (none by default). Besides deduplicating, it fixes the layering
  violation: `Syntax/` must not know BBCode semantics. The wiring lives in
  `createBBCodeRedNodeStore()`.
- ✅ **B4** — deleted `SELF_CLOSING` (empty Set) and simplified its two unreachable conditions;
  deleted `IncrementalParser.fullReparse()` (it destroyed the tree, nobody called it);
  `SAFE_BOUNDARY_TAGS` array → `Set`. The "inert copy-paste blocks in the lexer" no longer existed:
  the Week 1 rewrite had taken them away.
- ✅ **A5** — `BBCodeDocumentModel` propagates `autoAnalyze`/`maxUndo` to `super()`. Now
  `autoAnalyze: false` **does something**: `rebuild` 3.78 → 2.41 ms (−36%). `QuasarEngineService.parse()`
  reuses a scratch model without analysis instead of building a full model per call:
  **3.4× per snippet** (0.057 → 0.0166 ms). `createDocumentModel()` is left untouched because
  `ErrorCheckerWindow` does read its diagnostics.
- ✅ **A6** — `SemanticAnalyzer.analyze()` returns the `allNodes` index it was already building, in a separate
  type (`IndexedAnalyzeResult`) *on purpose*: the index references the whole tree, so it must not
  sneak into an `AnalyzeResult` that someone stores long-term. `DocumentModel` uses it instead of
  `findById()` per diagnostic, and only reassigns `node.diagnostics` when there is something to clear
  (before: 1736 new arrays per `analyze`).
- ✅ **A7** — out go `JSON.parse(JSON.stringify)` (4 places) and the comparison by `JSON.stringify`.
  The latter **was a latent bug**: `JSON.stringify` is sensitive to key order, so
  `{color,size}` and `{size,color}` were considered different and two perfectly mergeable nodes
  refused to merge depending on the order in which their metadata had been built. Validated
  differentially: 200,000 random metadata bags, 0 discrepancies in cloning and 0 in
  equality, plus the explicit key-order case, which is now resolved correctly.

> **New finding (it was not in the audit): A6 improved nothing measurable, and the reason matters.**
> `analyze()` returns **zero diagnostics** even on documents full of errors, so the
> `O(N·D)` never ran: `D` is 0. Three of the four built-in validators are
> unreachable — see point 15.

### 11. Fix the idempotence of `ASTOptimizer` (B5) ✅

Minimal repro (minimized from 356 → 71 chars):

```
[url=https://osu.ppy.sh][/url][notice][/notice][url=https://osu.ppy.sh]
```

**The cause was not the one the audit assumed.** `transform()` already iterates to a fixed point
internally, so the non-idempotence was not in the loop: it was in the **round trip through
text**.

`paragraph`s exist because a block element splits the inline content. When that
block is removed —here an empty `[notice]`— the two halves are left as **adjacent** `paragraph`s **with nothing in
between**, and `paragraph` is in `UNMERGEABLE`. Exporting that tree emits no separator at all, so
on reparsing the two paragraphs merge into one and a *second* pass of the optimizer finds more
work.

**Fixed** with `ASTOptimizer.isOrphanedParagraphPair`, which merges exactly that shape. The
fix is deliberately narrow —only when `spaces` is empty, because a blank line
written by the user is a real separation and must survive— and it rests on a prior
empirical check: **over 202,764 nodes (real fixtures + 20,000 random documents) the parser
produces that shape zero times**, so the rule can only fire on trees that the
optimizer itself created.

Validated as a property, not just on the repro: **30,002 documents** (fixtures + 6 seeds × 5,000
random), `optimize → export → reparse → optimize` gives **0 operations** in all of them, and **0**
lose visible text. Fuzzer seeds that used to fail (`2`, `7`, `42`, `99999`): all four
green.

The test went from `it.fails` to a normal regression test, as planned — and with it **the suite
stops having an `expected fail` for the first time since Week 1: 172 green**.

### 12. `DOMMorpher` (A8) ✅ — but **not** with keys by `data-node-id`

It lives in `src/Visitors/DOMMorpher.ts` (the audit did not give the path; it is not in `RenderPipeline/`).
It is consumed by `Preview.tsx`, `MorphPreview.tsx` and the two `de-tester` pages.

**The solution that A8 proposed is not viable, and for the same reason that already invalidated Phase 1 of
`NodeMatcher`:** the `data-node-id`s are regenerated on every parse. Measured on a one-character
edit, **0 of 3 ids survive a `rebuild`**. Pairing by them would find nothing: every
node would look new and the morpher would degenerate into a full replacement. Using `data-node-id` as a key
first requires stable identity across reparses — the same old blocker.

**What was done:** trimming of the identical prefix and suffix with `isEqualNode` (native deep
structural comparison) before pairing by index. A subtree that compares equal is left
**intact**: no recursion, no attribute loops and, since the node is not replaced, its
runtime state (open spoilers, playback, selection) is preserved for free. `Array.from()` now
copies only the window that changed, not every whole level. Insertions use `insertBefore` against
the preserved suffix, not `appendChild`.

**The defect, quantified.** Inserting a node at the start of 200 paragraphs, the previous morpher
left **0** with their text intact —it rewrote all 200, which is exactly the cascade a morpher exists
to avoid—; the new one leaves all **200** and the insertion is its only operation on the DOM.

**The morpher did not have a single test**, despite being code that mutates the DOM the user is looking at.
Added `src/Tests/DOMMorpher.test.ts` (7 cases) with the central property: after the morph, the
container must be structurally identical to what an `innerHTML = newHTML` would have produced.
Verified over 14 hand-written edit shapes plus **2,000 random pairs** with a seed, in addition to
preservation of node identity and of `<details open>`.

### 13. Review the mutation lock (B2) ✅

**Decision: it stays, described honestly as what it is.** It was neither made "real" nor removed, and the
reasoning is measured, not assumed:

- **It cannot be an isolation mechanism.** It is a single static boolean: opening a boundary
  anywhere opens it everywhere. Scoping it per document would force climbing to the root on
  every mutation and passing that root through the **26 call sites**, to catch mutation across
  documents: a class of bug that a single-threaded editor does not have.
- **It cannot be airtight either.** `children` is a public mutable array, and `treeTransformers` assigns to it
  directly in **5 places**, skipping the methods entirely. Sealing it requires making
  `children` private — a big API change for the same small benefit.
- **What it does provide:** wrapping a structural edit marks the intent at the call site, and
  mutating outside a boundary fails loudly instead of silently. That is worth
  one boolean check.

Also done:
- **7 dead wrappers deleted** in `StudioEffects`: they were `allowMutation(() => greenToRedNode(x))`,
  and `greenToRedNode` stopped mutating in Week 2 (it uses `initChildren`, outside the lock).
- Error message: "transaction boundary" → "mutation boundary". There is a real `Transaction` class
  in the engine and this is not one; calling it a transaction was confusing.
- **`QUASAR.MD` corrected.** It claimed "Concurrency Tolerance thanks to strict immutability".
  The *green* tree is indeed immutable and that part is kept; the claim about the red one was false and
  it now says what the lock really is.

### 14. Make the tree partition the source ✅ RESOLVED in Week 4 — see §7-bis

Discovered while validating point 5 of Week 2 (see that section for the full figures).

**The problem.** The tree's ranges are not a partition of the text. Two causes:

1. Delimiters are not nodes. `[center]` lives in the `text` of the parent, so the parent
   extends beyond its children: 32,630 cases of `parent.start != firstChild.start`.
2. There are siblings that occupy the same range. `"hola\n\nmundo"` → `spacing [4..6]` **and**
   `empty_line [4..6]`. Verified with a minimal case.

**Why it matters more than it seems.** It is not an aesthetic matter: it means the tree cannot
answer unambiguously *"which node is at offset 5?"*. Everything that translates positions
to nodes is built on that ambiguity — `findNodeAtOffset`, the Monaco↔AST mapping, the
diagnostics, selection preservation on reparse.

**What it unblocks:**
- **Point 9** (S5, incremental) — `shiftRanges` cannot be done correctly without this.
- **Point 5** (S2, structural sharing) — the Roslyn width model, and with it real interning.
- Reliable offsets for diagnostics and for the editor.

**What it requires:** that the lexer/parser emit delimiters and spacing as real tokens of the tree,
so that the widths add up exactly. It is a project of its own, not an afternoon's task, and
according to the methodology in §8 it must be revalidated differentially against the current parser before
being declared good.

> **Week 4 correction:** the "real tokens of the tree" idea turned out to be the expensive and
> wrong option. See §7-bis: the width model achieves the same invariant without touching the shape of the
> tree, which is also what Roslyn really does.

### 15. Three of the four `SemanticAnalyzer` validators are unreachable ✅ RESOLVED

Discovered while implementing A6: `analyze()` returns **0 diagnostics** even on documents
built on purpose with unknown tags, unclosed ones and orphan closers. Verified case
by case:

| Validator | Why it never fires |
|---|---|
| `unknown-tag` | Requires `node.kind === 'custom'`, but `Parser.ts` turns unknown tags into `text` nodes before the analyzer sees them |
| `deprecated-tag` | Looks up `deprecated[node.text]` with the key `'strike'`, but `node.text` holds the **attributes**, and `[strike]` parses to kind `strikethrough` with empty `text` |
| `nested-structure` | Requires children of `[code]` with kind ≠ `text`, but the parser keeps the content of `code` as raw text, so there never are any |
| `empty-tag` | ✅ This one does work |

Consequence: the engine **reports no BBCode error to the user**, and `ErrorCheckerWindow`
—which exists for exactly that— always shows an empty list.

**A second level of breakage, not detected in the audit:** no validator filled in `range`. Even if
they had fired, the click to jump to the error in `ErrorCheckerWindow` (`if (err.range)`) would not have
done anything and there would be no line or column.

#### What was fixed

- **`deprecated-tag`** — reads the spelling the author wrote from the source. It was needed because the
  tree does not keep it: `[strike]` and `[s]` both produce the kind `strikethrough`. A detail that
  cost an iteration: since `document`, `paragraph` and the tag start **at the same offset**
  (the range problem of point 14 showing up here), reading the source by offset fired the warning
  **three times**; it is tied to the kind that the tag produces.
- **`nested-tags-in-code`** — looks for the tags *inside* the block's text, which is where they are:
  the parser keeps the content of `[code]` as raw text precisely so as not to interpret them.
- **`empty-tag`** — it already worked; it now emits `range`.
- All diagnostics carry `range`, so the jump to the error in `ErrorCheckerWindow` works.

#### `unclosed-tag` — new validator

Decided with the user. It is the BBCode error that really gets made, and legacy mode closes it
silently by design, so nothing warned the author.

The detection is **exact, not heuristic**: a tag the author closed ends right at its
own `[/tag]`, because that is where the parser puts the end of the node; one that was closed *by* it
ends where the parser gave up. A single rule covers both shapes —`[b]x` (never closed) and
`[b][i]x[/b]` (where `[i]` is auto-closed by the legacy nesting rules)— and it did not need to touch the
parser or add fields to `GreenNode`.

Validated against false positives, which is the real risk of a new validator: **20,000 documents
generated with always-balanced nesting, 0 warnings**. And 0 diagnostics on the real 19.2 KB
document.

#### `unknown-tag` — woken up with a pairing rule

It was left dormant on purpose, and with measured reason: on a sentence of normal prose —`Combo de
[90 misses] con teclado [Gateron Yellow]`— it flagged **4** tags, all false positives. The
parser renders unknown ones as text *on purpose*, so warning about all of them was noise.

What makes it usable is requiring that the tag **be closed**. Nobody closes an aside in
brackets: `[Gateron]` does not come with `[/Gateron]`. Over 53 real userpages —which carry `[gb]`,
`[insane]`, `[rm120]`, `[my]` and eleven more— the rule flags **0**; over `[bold]x[/bold]`, which today
is published as visible garbage, it flags 1 and suggests `[b]`.

The detection carries no name list of its own: the parser already decided what is unknown when emitting the
tag as literal text, and the rule reads that decision, so it stays correct in any
dialect with no maintenance. The list is only needed for the suggestion, and edit distance
is not enough —`bold` is three edits away from `b`— so it is combined with a short table of names that
people write too long. It never suggests a deprecated spelling. The fix renames opening AND
closing, and is manual: it turns literal text into formatting, which is exactly changing the render.

#### Cost

`analyze` 1.390 → 1.352 ms **with the validators now working**. The first version cost
1.886 ms (+62%): it was fixed with a pre-filter by kind and by removing two string allocations per
node (a *sticky* regex anchored by `lastIndex` instead of `slice`, and comparing the closer
with `charCodeAt`). Tests: `src/Tests/SemanticValidators.test.ts`, 16 cases.

---

## 7-bis. Week 4 — The partition and the incremental ✅

The whole `14 → 9` block. It was done in that order because 9 cannot be done without 14, and that
turned out to be literally true: the central piece of the new incremental parser —"reparse the interior of the
container"— **cannot even be stated** without the partition invariant, because "the interior" was not
a well-defined range.

### 14. The tree partitions the source ✅

**The design decision.** The roadmap proposed emitting the delimiters as child nodes
(`open_tag`, `close_tag`). It was discarded: it changes the shape of the tree and breaks everything that iterates
`children` — `HTMLRenderer`, `BBCodeExporter`, `ASTOptimizer`, `NodeMatcher`, `treeTransformers` and
the 2150 lines of `StudioEffects`.

The **width model** was implemented instead, which is what Roslyn really does: a node's own
text lives in `leadingWidth`/`trailingWidth`, not in child nodes.

```
element [0..17]  leading=3  trailing=4     "[b]hola mundo[/b]"
└─ text [3..13]                            "hola mundo"

3 + 10 + 4 == 17   ✓
```

The invariant, now executable in `src/Syntax/partition.ts`:

```
node.start + leadingWidth      == firstChild.start
child[i].end                   == child[i+1].start
lastChild.end + trailingWidth  == node.end
```

**The three holes there were, and what was done with each:**

| Hole | Before | Now |
|---|---|---|
| Delimiters with no owner | `[b]hola[/b]` → `bold [0..13]` with a single child `[3..7]`; 6 chars belonging to nobody | `leadingWidth`/`trailingWidth` |
| Overlapping siblings | `"hola\n\nmundo"` → `spacing [4..6]` **and** `empty_line [4..6]` | each line break has its own range |
| Orphan closers deleted | an unmatched `[/b]` vanished from the tree and from the export | it is kept as text, like unknown tags |

Also: auto-closes no longer swallow the other tag's delimiter (`[b][i]x[/b]` gave `italic` and `bold`
**both** ending at 11), and the root always spans `[0..source.length]` instead of being derived from its
children.

**Cost of the invariant in `GreenNode`:** neutral. `fullWidth` was deleted —it was decorative: with
children it was worth `sum(children.fullWidth)`, ignoring the node's own delimiters, and its only 7
consumers used it as `fullWidth - width` to recover a `leadingWidth` that almost always
was 0— and the two new fields use `declare`, which does not emit `defineProperty` (see §8, trap 2).
`parseTokensToGreen` 0.659 → **0.606 ms**, 8% faster.

**Differential validation** (18,017 documents: 2 real fixtures, 15 minimal cases and 6 seeds ×
3,000 random ones with unknown, unclosed and orphan tags and stray brackets):

| | Before | After |
|---|---|---|
| Documents that partition | 2,238 (**12.42%**) | 18,017 (**100%**) ✅ |
| Total violations | 270,771 | **0** |

And against the previous parser, on rendered HTML and re-exported BBCode: **6,672 of 6,672
documents without orphan closers give identical output**. The remaining 11,345 diverge exactly
because of the intentional change.

> **A side effect that was not sought:** the fixed point of `parse → export → parse → export` went
> from **99.67% to 100%**. Deleting the orphans was in itself a source of round-trip
> instability.

Tests: `src/Tests/Partition.test.ts` — 40 cases, including the three original defects pinned by
their minimal case, "every offset has exactly one owner", and 6,000 seeded fuzz documents.

### 9. The real incremental parser (S5) ✅

**First we measured how broken it was.** Six realistic editing scenarios, comparing the resulting
tree against a full rebuild of the same final text:

| | Before |
|---|---|
| Scenarios with HTML **different** from the rebuild's | **3 of 6** |
| Scenarios whose tree did not partition | 4 of 6 |
| Worst node count | **1752 vs 1738** (14 ghost nodes) |

The three causes: the subtree was parsed from `newSource.slice(start, end)` and grafted in **without
rebasing** (all its offsets shifted by `start`); siblings and ancestors kept
old ranges; and `reparse` returned `newRootRed.green`, that is, **the old green root**.

**And then, whether it was worth fixing** (§8, rule 5). Breakdown of a full rebuild:
lexer 0.74 ms + parser 0.52 ms + `greenToRedNode` 0.27 ms = 2.48 ms real. The ceiling of a
correct incremental parser that reparses a region of 2-25%: **0.04-0.53 ms**, a saving of 79-98%.
It was worth it.

**The design: everything on the green tree.** It is not a preference — `RedNode.range` is a view of
`green.range` (`RedNode.ts:132`), so **a range fix in red is not expressible**. The
ranges live in green, so the edits happen in green.

1. Descend to the **deepest block container** whose *interior* contains the change.
2. Reparse only that interior, with `normalizeParagraphs: false` (grouping into paragraphs is a
   root matter; applying it here would invent paragraphs that a full parse never produces), and rebase it.
3. Rebuild the ancestor spine: the subtrees before the splice are shared **by
   reference** and only what comes after is shifted. It lives in `src/Syntax/greenEdit.ts`.

**The guards, and why each one exists.** When any precondition fails, it returns a full
rebuild with the reason in `lastReparseFallbackReason` — never a plausible but wrong tree.

| Reason | What it prevents |
|---|---|
| `region-not-isolated` | a half-typed `[` (its `]` would be outside), an unclosed `[code]`, an orphan closer that would pair with an ancestor, or a tag **of the same kind as the container** left open at the end of the region, which would steal its `[/centre]` |
| `open-bracket-before` | an unclosed `[` **before** the region, which could claim a `]` that the edit believes is inside |
| `no-container` | the edit is at document level |
| `stale-ranges` | the tree does not describe the previous text |
| `region-too-large` / `document-too-small` | cases where the rebuild is cheaper (see below) |

The two performance guards came from measuring, not assuming:
- The isolation guard **lexed the region and the parser lexed it again**. In a document whose
  container spans 95% of the text, the "fast" path measured **3-4× slower** than a rebuild. It was
  rewritten to work on the already-parsed tree —possible precisely because point 14 makes
  the parser keep the stray `[` and the orphan `[/tag]` as `text` nodes.
- Thresholds: region ≤ 70% of the document, document ≥ 2500 chars. At 1.8 KB / 173 nodes the incremental
  was **9% slower**; at 3.5 KB / 341 nodes, **50% faster**. They are constructor options
  (`IncrementalParserOptions`), because they are tuning and not semantics: the tree is the same.

**Differential validation.** The required property is not "renders similarly" but **identical**, node
by node, range by range, against a rebuild of the final text:

| Suite | Edits | Unequal | Broken partition |
|---|---|---|---|
| short document | 10,000 | 0 | 0 |
| with nesting | 7,500 | 0 | 0 |
| with `[code]` | 4,000 | 0 | 0 |
| real 19.6 KB fixture | 600 | 0 | 0 |
| **total** | **22,100** | **0** ✅ | **0** ✅ |

The fuzz found **61 divergences** on the first pass, all of the same shape: typing
`[centre]` inside a `[centre]`. And **9 more** on the second, all due to the unclosed `[` before
the region. Both were closed with the guards above.

**Performance with real typing** (43 keystrokes of normal text inside a `[notice]` of the
19.6 KB fixture, comparing `incremental: true` against `incremental: false` — the same code path
in both, which is the only honest comparison):

| | ms/keystroke |
|---|---|
| full rebuild | 2.78 |
| **incremental** | **1.22** (−56%, stable across 3 batches) |

With a **100% hit rate**: the guards do not fire a single time when typing normal text.

**Other changes:**
- `reparse()` no longer returns `null`. When it cannot do the splice, it does the rebuild itself,
  instead of a `null` that the caller had to interpret.
- `DocumentModelOptions.incremental` (default `true`) turns off the path. It is a performance
  switch, not a correctness one.
- The `IncrementalParser` test required that the RedNode `id`s of untouched blocks survive.
  No longer: red is derived from the new green, just like in a rebuild. Preserving those `id`s is
  precisely what the red splice did that left the ranges lying, and nothing depends on
  them — the `DOMMorpher` pairs by structure (`isEqualNode`) since point 12.

### Files touched

- `src/Syntax/partition.ts` 🆕 — the invariant, executable.
- `src/Syntax/greenEdit.ts` 🆕 — `shiftGreen`, `spliceGreen`, `withChildren`.
- `src/Syntax/GreenNode.ts` — `leadingWidth`/`trailingWidth`; `fullWidth` removed.
- `src/Syntax/GreenNodePool.ts` — widths propagated.
- `src/BBCode/Parser.ts` — delimiters as widths, disjoint line breaks, orphans as
  text, full root, `normalizeParagraphs` option.
- `src/Incremental/IncrementalParser.ts` — rewritten on the green tree.
- `src/Model/DocumentModel.ts`, `src/BBCode/BBCodeDocumentModel.ts` — `incremental` option,
  `parseToGreen` with options, `lastReparseFallbackReason`.
- `src/Studio/StudioEffects.ts` — 7 places that used `fullWidth - width`.
- `src/Tests/Partition.test.ts` 🆕, `src/Incremental/__tests__/IncrementalParser.test.ts` rewritten.

### What remains

**Point 5 / S2** (real interning with structural sharing) is the only thing still open, and point 14
has just given it what it was missing: now that the widths are honest, a `GreenNode` can be
identified by `(kind, text, children, widths)` without its absolute position.

---

## 7-ter. Week 5 — Real structural sharing ✅

The last open point: **5 / S2**, the interning. Point 14 had unblocked it, and this is
the change that cashes it in.

### The diagnosis, once again different from what the audit said

The audit treated S2 as two separate bugs. They are the same bug, and it had no local fix:

- `internLeaf` cached by `kind:text` **ignoring the position**, so the second `"Hello"`
  in the document got the first one's node, with **its** offsets. Turning the interner on made
  everything that depends on positions lie silently.
- `internNode` did the opposite: it required identical `start` and `end` to deduplicate, which two
  different occurrences never satisfy. The same block pasted ten times gave **0% dedup and 100%
  of the scanning cost**.

Ignoring the position and lying, or respecting it and never hitting: there is no third option **as long as
the position lives in the green node**. That is why the fix is to remove it.

### The change

```
BEFORE                         AFTER
GreenNode                      GreenNode
  range: {start, end}   →        (nothing)
  width                          width          ← derived, not passed
  leadingWidth                   leadingWidth
  trailingWidth                  trailingWidth

RedNode.range → green.range    RedNode.range → accumulated on construction
```

A green node knows **how much it occupies**, not **where it is**. Position is a property of the *place* of
a node in a tree, so it lives in the red node, which is the one that has a place: `greenToRedNode` weaves it
in on the way down (one sum per node) and stores it, so that `range` remains the O(1) property
that all the consumers already assumed.

**A design side effect, and not a minor one:** the width is now **derived** from the children plus the
node's own delimiters, so the partition invariant of point 14 stopped being a check
that a careless caller could violate and became constructor arithmetic. `partition.ts`
slimmed down: `sibling-gap`, `sibling-overlap`, `leading-mismatch` and `trailing-mismatch` were deleted
along with the possibility of failing them. Two remain that are still checkable — that the root
covers the source and that a `text` leaf measures what its text does.

And `shiftGreen` disappeared: it was a deep copy of every sibling after an edit just to
renumber it, 14% of the cost of an incremental reparse. Now a later sibling is shared by
reference just like an earlier one.

### Validation

**The interner turned on must be indistinguishable from turned off.** Over 18,016 documents (2 real
fixtures, 14 minimal cases, 6 seeds × 3,000 random ones), in **both modes**:

| | `leaves` | `full` |
|---|---|---|
| Identical tree | **100%** | **100%** |
| Identical HTML | **100%** | **100%** |
| Identical export | **100%** | **100%** |
| Partitions | **100%** | **100%** |
| `collisionMisses` | 0 | 0 |

And the incremental differential fuzz repeated in full with the interner on: **22,100 edits,
0 divergences**, same as off.

**Deduplication finally happens.** 19.6 KB fixture: 1736 reachable nodes →
**702 distinct objects (59.6% shared)**. Before: 0%, with `collisionHits: 0`.

### The cost, measured — and why it stays off by default

Isolating the parse, interning is expensive; end to end, it is almost free. Both things are
true and the second is the one that matters:

| | isolated parse | tree memory | **cost per keystroke** |
|---|---|---|---|
| no interning | 0.518 ms | 258 KB | **1.09 ms** |
| `leaves` | 0.600 ms (+16%) | 148 KB (−42%) | **1.09 ms** (neutral) |
| `full` | 1.090 ms (+110%) | 114 KB (−56%) | **1.15 ms** (+6%) |

*(Cost per keystroke: median of 4 batches, 43 keystrokes of normal text inside a `[notice]`
of the fixture, comparing `interning` set to `true` and to `false` — the same code path in both.)*

**Decision: correct, available, and off by default.** The declared budget of this engine is
latency, not memory, and no consumer had a memory problem; turning it on buys nothing
that is needed today. `BBCodeDocumentModelOptions.interning` turns it on for anyone with many
documents alive at once, and `'leaves'` is the pool's default mode because it buys three quarters
of the saving for a seventh of the cost: interning an inner node forces hashing its
whole subtree, while a leaf costs a string key and a `Map.get` — and the duplication
is in the leaves (930 leaves, 122 distinct).

> Methodological note: the first memory measurement said the interner spent **more**. It was noise:
> `global.gc` was not available under `npx tsx`, so nothing was collected between batches. With
> `node --expose-gc --import .../tsx/dist/loader.mjs` the sign flipped. See §8, rule 8.

### Files touched

- `src/Syntax/GreenNode.ts` — `range` removed; `width` derived; `walkWithOffset`, `childOffsets`.
- `src/Syntax/RedNode.ts` — own `_range`, accumulated on construction; `innerStart`/`innerEnd`.
- `src/Syntax/GreenNodePool.ts` — correct structural key, `InterningMode`.
- `src/Syntax/greenEdit.ts` — `shiftGreen` deleted; `spliceGreen`/`withChildren` without delta.
- `src/Syntax/partition.ts` — rewritten: only what is still checkable.
- `src/BBCode/Parser.ts`, `BBCodeToGreenNode.ts`, `BBCodeDocumentModel.ts` — construction by
  widths, offset threading, `interning` option.
- `src/Incremental/IncrementalParser.ts` — descends through the red tree, which is the one that has positions.
- 4 analyzers, 4 transforms, 4 transformers, `StudioEffects` (47 places), `treeTransformers`,
  `ASTOptimizer`, `TreeBuilder`, `NodeFactory`, `HTMLToGreenNode`, `MarkdownToGreenNode`,
  `UIBlocksToRedTree`, `Transaction` — 67 `green.range` places in total.
- Tests: `Partition.test.ts` and `GreenNodePool.test.ts` rewritten.

> **Side finding:** `ASTOptimizer` built *empty* green nodes as a shell and hung red
> children on them afterwards, so its `range` described nothing. With the derived width that became
> visible (width 0) and was fixed by building the green from the children it is going to have.

---

## 7-quater. Week 6 — The lexer

After weeks 4 and 5, the lexer was the most expensive phase of a full parse (0.74 ms of
~1.5 ms). Only the quadratic behavior from Week 1 had been fixed; the normal case was never
touched.

### Profiling by ablation, not by intuition

Each variant removes **one** cost, to measure its contribution instead of assuming it. Out of 0.625 ms:

| cost | ms | % |
|---|---|---|
| per-character regex in tag names | 0.127 | 20% |
| `toLowerCase()` per tag (1608×) | 0.110 | 18% |
| `TAG_NAME_RE.test` per tag | 0.058 | 9% |
| bracket memo (`Map<number,number>`) | 0.043 | 7% |
| allocating 2538 token objects | 0.042 | 7% |
| `toLowerCase()` of the whole source | 0.030 | 5% |

The first three are the same question asked three times. The lexer looked for the end of the
name with `/[a-zA-Z0-9_*]/.test(inner[i])` **character by character** —allocating a one-character
string and entering the regex engine to resolve what four integer
comparisons answer—, then it sliced, then lowercased, and then **validated again**
with a second regex what the scan had already guaranteed.

### What was done

- **A single scan over `charCodeAt`** that finds the end of the name, validates it and
  detects whether there are uppercase letters, returning length and flag packed into one integer. The
  second regex disappears: every character the scan accepted is valid by definition.
- **`toLowerCase()` only if needed.** Most names already come in lowercase and
  came back as identical copies.
- **The `toLowerCase()` of the whole source becomes lazy.** Only the `[code]`/`[c]`
  blocks use it, and most documents have none — the reference fixture
  paid for a 19.6 KB copy for nothing.
- **The plain-text path** did three string comparisons per character; now one integer
  comparison. It is the one that covers almost the whole document.
- Vestigial ceremony deleted in the raw blocks: `rawVal` was computed **twice**.

### Validation

**The token stream must be identical, field by field.** A lexer "equivalent on valid
input" is not enough: its job is to decide on garbage, and an editor's buffer is garbage
almost all the time.

| | |
|---|---|
| Documents | **56,049** (2 fixtures, 47 minimal cases, 7 seeds × 8,000) |
| Tokens compared | **776,021** |
| Divergences | **0** ✅ |
| Broken source coverage | **0** ✅ |

The fuzz alphabet is hostile on purpose: `[`, `]`, `[[`, `[/`, `[]`, `[ ]`,
`[has space]`, `[123+456]`, `[b`, `b]`, `[=]`, `[CODE]`, `[box=[b]t[/b]]`.

### What turned up while writing the tests

**The lexer did not have a single test of its own**, which is backwards: its job is to decide
on malformed input, and nothing covered that. Writing them revealed a real asymmetry
that I myself had assumed wrongly:

- In an **opening** tag, the name is the initial run of valid characters and **everything
  else goes to attributes**: `[has space]` → `open:has(space)`, `[123+456]` →
  `open:123(+456)`.
- In a **closing** tag, the name must fill the whole gap: `[/has space]` → literal text.

It is not harmless by accident: the parser turns unknown tags into `text` nodes, so the user sees
what they typed. That is why it was never noticed. It is pinned in
`src/Tests/Lexer.test.ts` (49 cases) so that a future reader does not stumble on it.

---

## 7-quinquies. Week 7 — Incremental granularity

Profiling the real keystroke (rule 4) showed that the lexer was no longer the problem: it was
**13.5%** of a keystroke. The two real costs were others, and turned out to be the same
problem seen from two sides.

### The diagnosis

The incremental parser reasoned in **containers**: it looked for the deepest block that wrapped
the change and reparsed its whole interior. Two consequences:

- Typing inside a 13 KB `[notice]` relexed and reparsed **66% of the document on
  every keystroke**, because the container was almost everything.
- Typing **at the end of the post** —the most common caret position there is— had no
  block container wrapping it, so it fell back to a full rebuild: **0 of 43
  keystrokes** took the fast path.

### The change

The unit of an edit is not a whole node, it is a **run of siblings**. The target becomes
a range of children `[from, to)` of the deepest node that contains the change, and the parent
can be the `document` itself — so the second problem disappears by
construction.

The window is **widened by one on each side**. It is not a safety margin: it is what
lets a deletion **merge** two nodes. Removing the blank line between two paragraphs
only touches the node in the middle, and without a neighbor on each side the reparse cannot see that the
two survivors must become one.

### What has to be left out, and why

Four kinds are **opaque** to the descent, each because its children are produced by a rule that
looks **outside** of them, which is exactly what a window cannot see:

| kind | why |
|---|---|
| `paragraph` | grouping into paragraphs is a root matter; a window inside cannot discover that a new blank line must **split** it |
| `code`, `inline_code` | raw blocks: their content is a literal token because the **lexer** saw the `[code]`; reparsing that text alone lexes it as BBCode and shatters it |
| `list_item` | `[*]` auto-closes the previous one, so a `[*]` typed inside is a **sibling** in a full parse and would be a **child** in an isolated one |

And two new guards, both found by the fuzz, not by prior reasoning:

- **The window cannot start in the middle of a run of line breaks.** The first one of
  a run is `spacing` and the following ones `empty_line`: which is which depends on how many
  came before. Starting in the middle makes the first one inside think it is the first of all.
  A test of our own caught it before the fuzz.
- **A tag left open at the end of the window steals the closer from any ANCESTOR of its
  type**, not just from the parent. The fuzz found it with a `[centre]` inside a `[list]`
  inside a `[centre]`.

### Validation

The differential fuzz found **192 divergences** on the first pass —all raw blocks— and
**2** on the second —both the stealing of a closer from an ancestor—. After closing them:

| suite | edits | unequal | broken partition |
|---|---|---|---|
| short document | 10,000 | 0 | 0 |
| root, many paragraphs | 10,000 | 0 | 0 |
| with nesting | 7,500 | 0 | 0 |
| with `[code]` | 4,000 | 0 | 0 |
| real 19.6 KB fixture | 600 | 0 | 0 |
| **total** | **32,100** | **0** ✅ | **0** ✅ |

### Result, and what is left exposed

| caret | incremental | rebuild | hits |
|---|---|---|---|
| inside `[notice]` | **0.742 ms** | 2.04 ms | 43/43 |
| at the end of the post | **0.657 ms** | 1.92 ms | 43/43 |
| at the start of the post | 2.13 ms | 2.17 ms | 0/43 |

At the start it does not hit, and it is right that it does not: the first child of the document **is** almost
the whole document, so the window triggers `region-too-large` and the rebuild is cheaper.

With `parse` reduced to 0.01 ms, the reparse is dominated by two new things:

1. **`buildRed` — 68-77% of the keystroke.** It rebuilds all 1736 red nodes even though
   only one window changes. It is the next big optimization, and the interning of Week
   5 is what makes it possible.
2. **`bracketsCloseBefore` — 22% when the caret is at the end.** It walks the whole prefix on
   every keystroke. It can be cached, but the correctness reasoning is subtle (an
   edit can expose a `]` that was previously covered) and it is not worth a silent bug in
   exchange for 0.09 ms.

---

## 7-sexies. Week 8 — The parser

After Week 6 the parser was the most expensive phase of a full parse, twice the
lexer, and it had never been profiled.

### Ablation

Out of 0.49 ms:

| cost | ms | % |
|---|---|---|
| `new GreenNode` × 1736 | 0.280 | 57% |
| └ of which, `Object.freeze([...children])` | 0.148 | **30%** |
| `tagToNodeKind` (two calls per element) | ~0.08 | 17% |
| stack frame objects | 0.016 | 3% |
| normalization into paragraphs | 0.002 | 0.5% |

### What was done

- **A shared frozen empty array** for nodes without children. More than half of the
  tree is leaves (930 of 1736) and each one allocated and froze its own empty array, which
  cannot differ from any other. −17% of the parser.
- **`Object.freeze` only outside production.** It cost 30% of the parser in exchange for a
  runtime guarantee against a mutation that `readonly GreenNode[]` already rejects at
  compile time. Outside production the exception still fires where the mistakes are made
  —development and the test suite, both verified— and production does not pay for a
  check that has never fired there.
- **`TAG_TO_KIND` goes from an object literal to a `Map`.** It is written as an object because that is how it reads,
  but it is queried with tag names that come from the source, so V8 sees a
  megamorphic key and falls back to dictionary lookup. Measured over 1608 lookups, the `Map` is twice
  as fast.
- **The kind is resolved once per element**, on opening, and travels in the stack frame.
  It was computed twice: once to discard `custom`, another on closing.

> Deliberate caution: the frame **also** keeps the literal `tag`. Closing pairs by
> tag, not by kind, and `[centre]`/`[center]` share a kind without closing each other. It is
> existing behavior and is not touched while optimizing.

### Validation

| | |
|---|---|
| Documents | **49,019** (2 fixtures, 17 minimal cases, 7 seeds × 7,000) |
| Configurations | **4** — strict and legacy × with and without paragraph normalization |
| Parses compared | **196,076** |
| Nodes compared | **1,985,691** |
| Divergences | **0** ✅ |

### A false alarm worth remembering

A loose measurement said that `greenToRedNode` had gone from 0.34 to 0.71 ms and that the
keystroke had **gone up**. It was noise between processes: the alternating A/B against a worktree at
HEAD, three batches, gave `greenToRed` 0.278 → 0.273 ms and the keystroke 0.698 → 0.700 ms. No
regression. It is rule 7 of §8 again, and it still costs the same discipline.

---

## 7-septies. Week 9 — The `applyTextUpdate` diff

Profiling the whole keystroke —and not just the reparse, which is what the model instruments—
revealed that **39% of the cost happened outside the reparse**, in never-measured territory.
Almost all of it was on one line.

### The problem

`applyTextUpdate` had two fast paths ahead of the general case, one for "append
at the end" and another for "delete at the end", both with `startsWith`. They were not shortcuts: both are
the same prefix scan with a specific answer, and getting to that answer cost
comparing the entire shared prefix — which the general case then walked again from scratch.

An edit in the middle of the document paid for the same prefix **twice**: once to discard
the fast path and again to compute the diff it was going to compute anyway.

### The fix

One forward pass and one backward pass, and that is the whole diff. Both cases still
come out right, they simply stop being special: appending at the end leaves `start === oldLen` and
the backward pass stops right there; deleting at the end leaves `start === newLen` and
likewise.

### Validation

253,902 text pairs (8 seeds × 40,000, with insertions, deletions, appends, truncations
and completely different texts, over an alphabet with emoji and accents): **the resulting
`TextChange` is identical to the previous algorithm's in 100%**, and in 100% applying that
change to the old text reconstructs the new one.

### The result, and a prediction of mine that came out high

| caret | before | after |
|---|---|---|
| edit in the middle | 0.702 ms | **0.620 ms** (−12%) |
| append at the end | 0.617 ms | 0.627 ms (same) |

**I had predicted 19% and it is 12%.** The error comes from having measured
`newSource.startsWith(source)` over the whole string: in an edit in the middle,
`startsWith` fails at the edit point and does not walk the rest, so the real cost was
half of what was measured. The lesson is the usual one — a phase measured in isolation does not predict its
weight in the real operation — and this time the bias was optimistic.

That the "append at the end" case does not improve is correct and expected: there the first `startsWith`
hit on the first try, so it was already a single pass.

---

## 7-octies. Week 10 — `analyze()`

### Ablation

Out of 0.620 ms:

| cost | ms | % |
|---|---|---|
| extra tree pass + `Map.set` for `allNodes` | 0.140 | **23%** |
| iterating the validators `Map` + `try/catch` per node | 0.057 | 9% |
| the validators themselves (5 × 1736 calls) | ~0.28 | 45% |
| the base walk pass | 0.051 | 8% |

### The finding, which is the usual one

`analyze()` walked the tree **twice**: once to build a `Map` of 1736 id→node entries, and
another to validate. That index existed so that `DocumentModel` could later look up, by id, the node
to hang each diagnostic on.

But **each diagnostic is produced while its own node is being visited**. The index, and
the pass that built it, solved a problem created by having separated the two steps.
And `context.allNodes` —the stated reason for it to exist— **is not read by any validator**, not
one of the five built-in ones nor anything in the repo.

### What was done

- **A single pass.** The validator hangs the diagnostic on the node it has in front of it.
- **`allNodes` becomes a getter** in the context and in the result, so it is built
  only if someone asks for it. The capability is still available for a validator that really
  needs cross-references; everyone else stops paying for it.
- **Dispatch by kind.** Three of the five built-in validators open with a kind
  test and nothing else (`custom`, `code`/`inline_code`, `DEPRECATED_KINDS`), so they were called
  1736 times each to answer something the dispatcher answers once. `Validator`
  gains an optional `kinds?` field — omitting it keeps the previous behavior, so the
  API does not break anyone.
- **The validators are walked as an array**, not by iterating a `Map`, which allocated an iterator and
  a destructured pair per node. The `try/catch` stays per validator: one that fails
  must not take the rest of the analysis down with it.

### Validation

20,002 documents (2 real fixtures + 5 seeds × 4,000, with an alphabet designed to
**trigger** validators: unknown, empty, unclosed and obsolete tags and `[code]`
with structure inside). **18,929 produce diagnostics**, and the output —the diagnostics
emitted and which one ends up hung on which node— is **byte for byte identical** to the previous one.

### A figure of mine that has to be corrected

For several sessions `analyze()` has been cited as **1.7 ms**. That number came from subtracting
a `rebuild` with analysis minus one without it, which attributed to it costs that were not its own.
Measured directly, it was **0.60 ms** on a clean document. The error did not change any
decision —it was still the right candidate— but the figure was inflated almost 3×.

---

## 7-nonies. Week 11 — The lexer's bracket memo

What was left of the lexer after Week 6, measured: the bracket memo was **15%** and
allocating the 2538 token objects another 15%. The second cannot be touched without changing the API. The first
turned out to be free.

### Instrument before assuming

The memo exists to fix the `O(n²)` from Week 1. Counting real hits:

| document | queries | hits | useful reads |
|---|---|---|---|
| 19.6 KB fixture | 804 | **0** | **0** |
| `[` × 16,000 | 16,000 | 15,999 | 15,999 |
| nested attributes | 400 | **0** | **0** |

It is **essential** in the pathological case and **completely useless** in everything else. The
reason lies in who writes each entry:

- The entry for the queried position (`bracketMatch.set(from, result)`) **is never
  read**. The main loop never asks twice: if the scan hits it jumps past the
  `]`, and if it fails it emits `[` as text and advances to `from + 1`. In neither case
  does it come back. That was 804 wasted `set`s per document — and, worse, they were what kept the
  map from being empty, so every query paid for a lookup miss.
- The entries of the brackets found **inside** the scan are useful, but only
  when that scan fails: then the main loop enters them one by one. That is
  exactly the pathological case.

### What was done

Stop recording the own entry, and skip the query when the map is empty —an integer
comparison is cheaper than a lookup destined to fail—. In a document
without stray brackets the map never gets anything inside.

### Validation

56,012 documents and 882,752 tokens, with an alphabet loaded with brackets (`[[[[`, `[a[b]c]`,
`[box=[b]t`, `[`×500) because it is what exercises the memo: **identical token stream**.

And the number that really mattered to check: `[`×16,000 stays at **2.0 ms**. The quadratic
fix has not been touched.

---

## 8. Measurement methodology

**Fixture:** `src/problematic_sectionwgradient.milia` (19.6 KB, 2538 tokens, 1736 nodes).

**Harness:** 2 warm-up calls + N timed iterations, the mean is reported.
For A/B comparisons: 7 batches of 100 iterations, the **median** is reported (the JIT makes
a single cold measurement useless — the first `NodeMatcher` measurement gave 15.5 ms versus 5.14 ms
at steady state).

**Reproduce:**

```bash
cd packages/quasar
npm run verify          # typecheck + tests
QUASAR_FUZZ_SEED=2 npm test   # corpus that reproduces the idempotence bug
```

The benchmark scripts are throwaway: they are written in `packages/quasar/*-tmp.ts`, run
with `npx tsx` and deleted. They are not versioned so as not to clutter the package.

**Validation of core changes:** any change to the lexer or the parser must be validated
*differentially* against the previous implementation (the lexer's compared 149,894 positions and
50,000 random documents). It is not enough for the tests to pass.

**Rules that took time to learn:**

7. **Compare paths, not different APIs.** Measuring `applyTextUpdate` (incremental) against `rebuild`
   said the incremental lost, but `applyTextUpdate` drags along change-tracking and a debounce `setTimeout`
   that `rebuild` does not have. The honest comparison was to add
   `DocumentModelOptions.incremental` and measure the **same** call with the option set to `true` and to
   `false`. The sign of the result changed.
8. **Check that `global.gc` exists before measuring memory.** Under `npx tsx` it is not there, so
   nothing was collected between batches and the interner seemed to spend **more** memory, not less. With
   `node --expose-gc --import /usr/lib/node_modules/tsx/dist/loader.mjs` the sign flipped:
   from "+68%" to "−49%". Print `typeof global.gc` before believing a heap figure.
9. **An isolated phase does not predict the end-to-end cost.** Interning is +110% over the
   parse measured alone, and +6% over the real cost per keystroke, because parsing is a fraction
   of the work. Decide with the second figure.

---

## Appendix — Things the documentation claims and the code did not meet

| `QUASAR.MD` says | Measured reality | Status |
|---|---|---|
| §3 "140 FPS, latency < 0.2 ms" | 290 ms per keystroke | **1.09 ms** per keystroke after week 4 (incremental path, no analysis) — 266× better, still 5× the stated target |
| §13 "Structural Sharing (Memory Deduplication)" | The module threw `TypeError` on its first line; with it fixed, 0% dedup | ✅ **59.6% real dedup** — point 5, week 5. Opt-in: it is memory in exchange for latency |
| §14 "Incremental Parsing" | Leaves offsets corrupt and desynchronizes green/red | ✅ Correct and validated over 22,100 edits — point 9, week 4 |
| §3 "Concurrency Tolerance thanks to strict immutability" | Global static flag; the red tree is mutated from 4 places | ✅ `QUASAR.MD` corrected — point 13 |
| `RedNodeStore.ts:21` "HTMLRenderer cache by canonicalId" | No such cache exists |
| §2 "Engineering Status: Industrial Production" | 48 `tsc` errors, 4 red tests, fuzzer with 60% flake |

Updating `QUASAR.MD` as weeks 2 and 3 get closed is part of the work:
documentation that lies is worse than having no documentation.

---

## Post-closure — Session 2026-08-05: coherence, connectivity and stable identity

The performance audit remains closed; this is a different front, born from a connectivity
review of the whole engine. User decision: the subsystems without consumers
(~9,000 LOC: Analysis, Markdown, Commands, Transactions, Transformers, Plugins, Linter,
Symbols, Queries, Formatter, TreeDiffer, RenderPipeline…) **are kept** — Quasar is an
independent platform and they are its future (real-time collaboration, plugins). Do not amputate.

### Fixed (suite: 327 green; `ModelCoherence.test.ts` and `StableNodeIds.test.ts` new)

1. **Fresh diagnostics.** `applyChange` defers `analyze()` (10 ms debounce), so
   whoever read `model.diagnostics` right after `applyTextUpdate` saw the errors of the
   PREVIOUS text — the error panel was one keystroke behind. The new
   `DocumentModel.ensureAnalyzed()` flushes the pending work; `BBCodePipeline` (app)
   calls it after every edit.

2. **Lazy EventBus.** The app does not have a single subscriber, yet every `emit` stored the
   event in a history of 50 that nobody reads — and the rebuild/diagnostics events carry
   the closure of the lazy `nodeMatch`, which pins the whole old red+green tree (~258 KB
   per event; megabytes per document). Now: opt-in history (`recordHistory`, off by
   default) and the model does not build events without subscribers (`hasListeners()`).

3. **Coherent `transact`/`undo`/`redo`.** They mutated `_redRoot` without touching `_source` or
   `_greenRoot` (the next edit diffed against a source that the tree no longer matched),
   `invert()` only knew how to invert 1 of 6 kinds, and the `_applied` flag made redo a silent
   no-op. Now `transact` applies to red → `exportSource()` (an override of
   `BBCodeDocumentModel` via `BBCodeExporter` target `'miliastry'`) → `rebuild`: the three
   representations always describe the same document. Undo/redo reproduce **snapshots
   of text** (`UndoManager` rewritten): text is always reproducible, even after rebuilds
   that replace all the ids.

4. **`"sideEffects": false`** in `package.json` (verified: no module has side effects on
   import). Keeping the aspirational subsystems in the repo no longer implies shipping them to the
   browser.

### Stable node identity — the big pending item of the closure ✅

`src/Syntax/preserveNodeIds.ts`, hooked into `rebuild` and into the incremental path of
`applyChange`. It traces Phase 0 of `NodeMatcher` (lockstep + prefix/suffix trimming) with
three tiers: green ref-equal (the incremental splice shares untouched subtrees — it covers
almost everything while typing) → equal hash with structural verification and atomic commit (full
rebuild path) → same kind at the same position (the edited node keeps its identity).
Uniqueness comes by construction: the walk is positional, each old id is adopted at
most once.

| Metric | Value |
|---|---|
| Ids kept while typing in the fixture's `[notice]` | **1736/1736 (100%)** |
| Cost of `preserveNodeIds` per keystroke | **0.077 ms** |
| Full keystroke (now WITH synchronous analysis!) | **~0.95 ms** — within the 0.9-1.1 band |
| `data-node-id` blocks intact after morph (e2e test) | DOM identity preserved, `isEqualNode` fires |

Note: the renderer now only emits `data-node-id` on selectable blocks
(`ID_BEARING_KINDS`), not on every span — the problem of 38% of the HTML being ids was mitigated;
what was missing was for those ids not to change on every parse. With this, Phase 1 of
`NodeMatcher` (match by id) stops being dead by definition, and stable identity
is ready as a prerequisite for collaboration.

### Added in the same session: out goes the UUID per diagnostic ✅

`createDiagnostic` minted a `crypto.randomUUID()` (with a manual v4 fallback for SSR) per
diagnostic, for an `id` field that **nobody read** — not the engine, not `ErrorCheckerWindow`
(it uses `key={idx}`), not `toDocumentErrors`. The field was deleted from the type; a diagnostic is
identified by what it says and where: `(code, range, nodeId)`.

| `analyze()`, 900 diagnostics | median of 7 batches |
|---|---|
| Before | 1.34 ms |
| After | **0.69 ms** (−49%) |

More than the audit's 14% predicted: the real cost included the GC pressure of
900 UUIDs of 36 characters per analysis. Suite: 327 green, `tsc` clean.

### The main course: reuse of red subtrees ✅ (2026-08-05)

`buildRed` rebuilt all ~1736 red nodes on every keystroke even though only one
window changed — the most expensive phase measured (0.30 of 0.94 ms). The observation that unblocks it: after
weeks 4-7, the incremental splice shares all intact green subtrees by reference,
and green reference equality is **proof** that the subtree did not change.
`greenToRedNodeReusing` (in `BBCodeToGreenNode.ts`) adopts the whole old red subtree —
ids, metadata and diagnostics included — with the lockstep + prefix/suffix pattern of
Phase 0; the adoption costs one `parent` (set by `initChildren`) and, only if the subtree
shifted, a `setStart` that adds a delta to two integers per node.

**New contract, documented in the code:** the previous red tree is CONSUMED after
an `applyChange` (the adopted subtrees are reparented). Verified that nobody walks a
superseded red tree: the app ignores `existingAst` and the `IdentityResolver` in the docblock of
`BBCodePipeline` does not exist. Kill-switch: `DocumentModelOptions.reuseRed` (default `true`).

| Metric | Before | After |
|---|---|---|
| `buildRed` per keystroke | 0.296-0.339 ms | **0.041-0.057 ms** (~6×) |
| Full keystroke (with synchronous analysis) | ~0.95 ms | **~0.80 ms** |
| Differential fuzz against full rebuild | — | **120 edits, identical tree** (kind, text, range, metadata) + identical HTML |
| Uniqueness of ids after adoption + fresh ones | — | 40 edits, 0 duplicates |

The kill-switch test caught a real wiring bug: `BBCodeDocumentModel` did not forward
`reuseRed` in the `super()` — the A5 pattern (options silently swallowed) repeating itself.
In addition `preserveNodeIds` gains a tier 0 (same object → nothing to copy), so its cost
drops to 0.048 ms and its stats now count only ids copied between different objects.

Suite: **331 green** (`RedReuse.test.ts` new, 4 tests).

### Consolidation of the effect handlers + kindToTagName ✅ (2026-08-05)

**The "two gradient renderers" turned out to be four pairs.** Each effect (gradient,
sinewave, grow, rainbow) duplicated its entire segment math between `toBBCode` and
`toRenderNode` — same progression t, same easing/mixing/wave, different presentation. Now
there is ONE `*Segments` function per effect and two shared presenters
(`segmentsToBBCode`/`segmentsToRenderNode`). TagRegistry: −101 net lines.

Validated by snapshot: the outputs of the 8 handlers over 9 cases (word mode,
`globalOffset`, empty text, a single color) captured BEFORE the refactor are **byte for byte
identical** afterwards, and are pinned in `EffectSegments.test.ts` + `.snapshot.json` (9
tests) so that the next hand to touch the math cannot desynchronize the two
formats without noticing.

A clarification that matters: `HTMLRenderer.renderGradient` is NOT a duplicate of this — the
preview paints a smooth CSS `linear-gradient`; these segments reproduce the DISCRETE colors
of the exported BBCode. It is an intentional difference, now documented in the
code instead of looking like an accidental divergence.

**`kindToTagName`**: the 30-key map was allocated INSIDE the method — a new object per
exported node. It is now a module constant, with a note on why it is NOT interchangeable with
`nodeKindToTag` from BBCodeToGreenNode (osu! spelling: `centre`, `youtube`).

Suite: **340 green**.

### Platform front — collaboration v0/v1 + plugins end-to-end ✅ (2026-08-05, afternoon)

**Collaboration** (full architecture in `QuasarCollab.MD` — read it before touching anything):
**text-CRDT** was decided: the text is the unit of synchronization, Quasar is a pure function
`text → view` on each client, the tree never travels over the network, the engine stays without
dependencies (Yjs will go in the app). Done: `src/Collab/positions.ts`
(`transformOffset`/`transformRange`, documented biases — the caret sticks to the right, the
ranges preserve exactly their content) and `origin` in `applyChange`/`applyTextUpdate` →
events, so that the sync layer can tell its own echo. Property validated with fuzz:
2,000 documents × every position — the character pointed to before is the one pointed to after.

**Plugins**: the missing link was the parser — `tagToNodeKind` turned any non-builtin
tag into literal text, so a plugin tag rendered and exported but never
PARSED. Now `ParseOptions.extraTags` (a name→kind map) lets the frame be born;
`TagRegistry` distinguishes builtins from plugin registrations (`isBuiltin`, `customTags()`,
`version` for memoizing) and `BBCodeDocumentModel` wires it at zero cost without plugins (one
integer comparison per parse). The exporter serializes plugin tags under their
registered name — strictly limited to NON-builtins: sinewave/rainbow/svg keep their current
serialization, which the Studio flows depend on. The renderer without a registry no
longer swallows the content of unknown kinds (it renders the children, omitting only the wrapper).

Test of the full cycle (`PluginTags.test.ts`, 6 tests): lex → parse (with nesting,
attrs and partition intact) → render (with and without registry) → export (byte for byte round-trip,
fixed point) → PluginAPI registers/unregisters → incremental vs rebuild differential with plugin
tags. Prose with `[90 misses]` is still visible text.

Keystroke unchanged (~0.7-0.8 ms). Suite: **356 green**.

Finding parked for the honesty pass: `RenderTree.toHTML` ignores `style` on `text`
nodes — the effects' toRenderNode lose their styles through that path.

---

## Post-closure — The ~60 ms floor of the app's flush (2026-08-05, night)

After lowering the debounce, the question became the **thread blocking per flush**. Measured in
a production build with Playwright + `Performance.getMetrics`, separating the cost of TYPING
(Monaco) from the cost of the FLUSH (parse + render + morph + React):

| Doc | typing (Monaco) | flush (pipeline) |
|---|---|---|
| 19.6 KB | 24.9 ms | **41.8 ms** (script 22.1 · style 4.2 · layout 0.8) |
| 196 KB | 116.4 ms | **48.2 ms** (script 16.7 · style 13.7 · layout 0.5) |

Two things that correct previous beliefs:

1. **On large documents, the one that dominates is Monaco** (116 ms of typing against 48 of flush),
   not our pipeline. Optimizing the flush there does not move the needle.
2. **The cost of the flush was NOT dev mode.** The app audit assumed that a good part
   of the 57-77 ms in dev was React instrumentation; in production it is ~42 ms real.

### Hypothesis tested and REFUTED: incremental rendering by blocks

A CPU profile of the flush window gave **~30 of the ~42 ms in `(program)`** (native
work) against ~4 ms for all of our JS together. Since `morphHTML` does
`template.innerHTML = fullHtml` before it can compare, the reading was: *we are
re-parsing 90 KB and 5,500 nodes per keystroke*. `IncrementalPreview` was implemented — it only
re-renders and re-parses the first-level block that changed, using the reference identity that the
reuse of red subtrees provides — with 9 tests and differential fuzz.

**A/B in production, both paths in the same session, alternating:**

| Doc | full morph (old) | by blocks (new) |
|---|---|---|
| 19.6 KB | **43.1 ms** | 103.0 ms (style 4.6 → **34.2**) |
| 196 KB | **89.9 ms** | 313.3 ms (style 14.5 → **159.8**) |

**2-3.5× slower.** The premise was false: `(program)` is not mostly HTML parsing,
it is **style recalc + paint**, and that is exactly what the morph minimizes. Replacing the DOM subtree of
a block touches thousands of elements; the morph touches the ones that changed. Besides, the real fixture
has only **7 first-level blocks** (one eats 60% of the post), so block
granularity did not bound the work either. Reverted; `IncrementalPreview` deleted.

> A rule that confirms §8: *the phase a profile points to as expensive is not necessarily the one that
> can be avoided*. `(program)` aggregates parse + style + layout + paint; attributing all of it
> to parsing cost a full implementation. An alternating A/B in the same session would have
> said so sooner — the variance between batches (typing 24.9 / 31.1 / 67.0 ms for the same
> document) makes comparing different builds useless.

### What did come out of this: two real identity bugs ✅

The experiment's differential fuzz (comparing the incremental DOM against the full one)
uncovered that `preserveNodeIds` **corrupted ids** in two cases, and both fixes stay:

1. **Double mechanism.** With red reuse, an intact block IS the previous node and
   already carries its id; running the id walk on top paired it **positionally** with
   its neighbor and overwrote its id — duplicating live ids and changing the `data-node-id` of
   blocks that had not changed. Now identity is carried by **either** the adoption **or** the
   walk, never both: it is decided by counting real adoptions (`reparse` can do
   a full rebuild inside even though reuse is enabled, and then it adopts
   nothing).
2. **Trimming too lax.** The prefix/suffix trim advanced if the nodes shared
   *kind*, which is true of any two paragraphs: **inserting a block made the
   walk march through the whole list pairing each survivor with its neighbor**, and
   renumbered everything after the insertion. Now it requires evidence of content (same
   green reference or same hash).

A good side effect: since the `data-node-id` of the blocks that survive an insertion no longer changes,
the `DOMMorpher` fast path (`isEqualNode`) also works when inserting
and deleting blocks, not just when typing inside one. Pinned in `StableNodeIds.test.ts`.

Suite: **357 green**.

### What remains of the floor, with data

The flush is ~42 ms of which ~30 are native (style + paint + parse) over a preview
that reflects **5,500 DOM nodes** (30,000 in a 196 KB post). The next real candidate
is not how we update the DOM, it is **how much DOM there is**: the renderer emits a
`<span class="bb-text">` for every text node and **`.bb-text` does not have a single CSS rule in
the whole repo** (the only reader is `HTMLToGreenNode`, which nobody uses). Removing that wrapper
cuts ~1 element per text leaf and ~27% of the emitted HTML. Not measured yet: do it
with an alternating A/B, not by comparing builds.

### The `<span class="bb-text">` wrapper: out ✅ (2026-08-05, night)

The candidate left by the previous section, now measured. The renderer wrapped **every text
leaf** in a `<span class="bb-text">`, and that class **does not have a single CSS rule in the whole
repo**: it carries no `data-node-id` (text is not a kind with an id, so neither the click nor the
highlighting ever looked at it) and the styles of a leaf still emit their own
`<span style="…">`. It was one element per leaf in exchange for nothing.

**A/B in production, steady state, alternating cycles** (the methodology the previous section
learned the hard way):

| Doc | WITH spans | WITHOUT spans |
|---|---|---|
| 19.6 KB | 41.4 ms · **1,726** elements | **39.7 ms** · **851** elements |
| 196 KB | 55.4 ms · **17,251** elements | **46.4 ms (−16%)** · **8,510** elements |

**Half the preview's DOM**, ~27% less HTML to serialize and parse, and a cheaper
flush — modest on normal documents, clear on large ones. Confirmed after making it
permanent: 40.3 ms / 851 elements and 60.8 ms / 8,510 elements, with the preview showing
the correct content.

Checked before touching: `osu.css` scopes everything under `.bbcode-preview` with
tag selectors (no rules for `span`, no sibling selectors), `dom-to-svg` walks
`TEXT_NODE` explicitly, and `usePreviewClick`/`useBlockHighlight` resolve by
`data-node-id`, which only the blocks carry.

### In passing: two tests that verified nothing ✅

When removing the span, an `expect(html).toContain('class="bb-text"')` failed, and opening it up revealed
the pattern the audit flagged as B5:

- **`VisualBuilderFidelity.test.ts`** held 6 KB of "expected HTML" that was **never
  compared** with anything, wrote it to `visual-builder-expected.html` /
  `visual-builder-actual.html` —files **tracked by git**, dirtied on every
  run— and only asserted two `toContain`s. Rewritten: 15 tags → expected element,
  attributes, raw `[code]` content, `data-node-id` only on blocks, final prose.
- **`ProblematicSectionHTML.test.ts`** had **not a single assertion**: it rendered two
  variants and wrote them to `orig.html` / `grad.html`. Rewritten: the gradient layer
  colors the text without inventing or losing blocks, and the render is deterministic except for ids.

No test writes into the working tree anymore. (The `.html` files that show up modified in
`git status` are leftovers from earlier runs; they can be restored with `git checkout`.)

Suite: **362 green**.

---

## Post-closure — The cost of `data-node-id` goes with the NUMBER, not the length (2026-08-05)

With `HTMLRenderer.idMode = 'all'` the attribute is carried by **808 of the 852 elements** of the
fixture, and that has a price: the A/B in the app gave 48 → 56 ms of latency and p95 72 → 104 ms
(see the `idMode` comment). The natural question is whether it can be made cheaper without losing
click precision. The short answer: **shortening the attribute is of almost no use**, and the
reason is counterintuitive.

### First, what NO longer costs

| Metric (19.6 KB fixture) | `blocks` (9 ids) | `all` (808 ids) |
|---|---|---|
| HTML emitted | 31.4 KB | 47.7 KB (+52%) |
| `setAttribute` per keystroke (1-character morph) | 1 | **6** |
| `render` of the full document | 0.315 ms | 0.351 ms |
| `applyTextUpdate` + `render` | 0.497 ms | 0.543 ms |

The **6 `setAttribute`s** are the important figure: stable identity did its job and
**the morpher churn no longer exists**. When the ids were regenerated on every parse this
was 1665 writes over 1725 elements. There is nothing left to optimize on that side.

Also ruled out was the suspicion that the global counter inflates the ids over the
session: after **500 keystrokes** they are still 5 digits (+522 bytes of HTML, and of those 500 are
the typed text). The incremental path reuses red subtrees, so it mints very
few new ids per key.

### The finding: the parser charges per attribute, not per byte

Parsing of `template.innerHTML`, jsdom, **minimum of 10 rounds × 25 parses, interleaving the
variants** to cancel drift. The id is emitted on a fraction of the elements, in two
formats of very different length:

| ids | long format (`data-node-id="n12345"`) | short format (`n=9ix`) |
|---|---|---|
| 0 | 31.93 ms · 31.3 KB | — |
| 202 | 32.64 ms · 35.4 KB | 32.70 ms · 32.3 KB |
| 404 | 33.58 ms · 39.5 KB | 33.76 ms · 33.4 KB |
| 808 | 35.14 ms · 47.7 KB | 34.42 ms · 35.5 KB |

With 202 ids it makes no difference whether the HTML weighs 35.4 KB or 32.3 KB: **32.64 against 32.70 ms**. With 404,
the same. The time follows the **count** of elements with an attribute —linear, ~3-4 µs per
element— and is almost indifferent to its length. The parser pays for creating the attribute
entry, not for reading its characters.

Practical consequence: **shortening the name cuts 12.2 KB of string and recovers 0.7 ms of
the 3.2** that separate `blocks` from `all`. The remaining 78% only goes away by lowering the count.

> A rule, sister to the one left by the `IncrementalPreview` experiment: *payload size
> is not a proxy for the cost of parsing it*. Here the size↔latency correlation was real but
> spurious — both grew with the number of elements with an id, and only the latter caused it.
> It took varying the two things separately to see it.

### Formats measured, so as not to repeat the exercise

All validated in jsdom: 808 elements found, `closest('[attr]')` resolves, and the DOM
**reserializes them with quotes**, so the unquoted format only lives in the string
the renderer emits (which is exactly where it would save). Unquoted is valid HTML as long as the
value carries no spaces, quotes, `=`, `<`, `>` or backtick — a base36 qualifies.

| Format | Bytes/element | Total HTML |
|---|---|---|
| `data-node-id="n12345"` (today) | 22 | 47.7 KB |
| `data-i="9ix"` | 13 | 41.1 KB |
| `ni="9ix"` | 12 | 37.9 KB |
| `n="9ix"` | 10 | 37.1 KB |
| `n=9ix` | 8 | 35.5 KB |

If it is ever done, let it be **in lowercase**: the HTML parser lowercases attribute
names, and `SVGRenderer` serializes to XML, where that difference would matter.
The price is that an attribute that is not `data-*` is not conformant and loses `dataset`; today it makes
no difference (there is no sanitizer in the pipeline and it is only read by `getAttribute`, `closest` and
`querySelector`, plus two selectors in `MiliastryNovaFeatures/BBCode/styles.css:252` and `:258`).

### The only real lever, and why it is not pulled

Lowering the count from 808 to 9 without losing precision **is possible**: `closest()` gives the block,
`caretPositionFromPoint` gives the character, and a walk of the block's subtree accumulating
rendered text lengths gives the exact node. Preview→Monaco would stay the same (the click already
resolves to a `RedNode`, and the `miliastry:select-node` event travels with its id).

What holds it back is not performance, it is the **contract of the reverse direction**:
`useBlockHighlight` does `querySelector('[data-node-id="X"]')`, and `EditorWindow` climbs from
the cursor only until it leaves `text`/`spacing`/`empty_line` — so X can be an **inline**
node, which would no longer have an element to carry it. It would have to highlight with Range + CSS
Custom Highlight API, or degrade to the block.

**Decision: it is not done.** 8 ms in the app (3.2 in the probe) in exchange for redoing the highlighting,
on a path that is already below the perception threshold.

Also measured and discarded: emitting the id only where a click can land. By a
conservative approximation, only **22 of the 808** are unreachable by `closest()`. Half a KB.

### Methodology warning

All of this is **jsdom, not Blink**. The absolute figures do not carry over (the probe's ~35 ms of parsing
is a jsdom artifact; in production the whole flush is ~42 ms). What
carries over is the shape: the app's A/B measured the same jump from 9 to 808 ids as 48 → 56 ms.
In Blink the bytes weigh somewhat more than here —the string has to be built and transferred— but
the attribute count still dominates. Any change here is validated with an alternating A/B
in the app, not with this probe.
