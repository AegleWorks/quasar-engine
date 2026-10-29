# 14. Engineering audit — 2026-10-21

An audit of the whole engine against six criteria — correctness, performance,
precision, architecture, developer experience and reliability — followed by
the fixes it justified. Every number below was measured on this tree, with the
commands in [Reproducing](#8-reproducing); nothing is estimated.

**Verdict.** The compiler core (lexer, parser, green/red trees, incremental
reparse, analysis windows, renderer, exporter) is sound and already tuned: the
complete correctness suite, the tree validator under `QUASAR_VALIDATE_TREES=1`,
and a fresh structural fuzzer all pass over malformed input, and no audited
phase regressed. The defects were concentrated in the **editor-service layer**
and the **Markdown boundary** — features the README advertises that either
returned nothing, deleted markup, or changed meaning on export. Those are
fixed, tested and measured below.

---

## 1. Architecture map

The tree is the contract between the phases. Nothing renders from source and
nothing exports from rendered output; both read the same red tree.

| Phase | Modules | Input → output | Boundary |
|---|---|---|---|
| **Lexing** | `Lexer/BBCodeLexer`, `Lexer/Lexer` | text → tokens (`open`, `close`, `text`, `newline`) | No I/O, no allocation of trees. Pure function; usable in a worker. |
| **Parsing** | `BBCode/Parser`, `BBCode/BBCodeToGreenNode`, `Syntax/TreeBuilder` | tokens → green tree | Immutable, position-free nodes; width is computed by the constructor. |
| **Red view** | `Syntax/RedNode`, `Syntax/RedNodeStore` | green tree → red tree | Parent pointers, absolute ranges, stable ids, lazy shifts. |
| **Incremental** | `Incremental/IncrementalParser`, `BracketIndex`, `ChangeTracker` | edit + old tree → new tree | The splice must equal a full parse; enforced differentially. |
| **Semantic** | `Semantic/SemanticAnalyzer`, `Semantic/osu/*` | red tree → diagnostics | Window analysis must equal full analysis, `data` included. |
| **Rendering** | `Visitors/HTMLRenderer`, `RenderPipeline`, `BlockPatcher`, `DOMMorpher` | red tree → HTML / DOM patches | Presentation only; may not be imported by export. |
| **Export** | `Visitors/BBCodeExporter`, `MarkdownExporter`, `JSONExporter`, `TiptapExporter` | red tree → text | Must not import a renderer (enforced by `Architecture.test.ts`). |
| **Import** | `Markdown/*`, `HTML/HTMLToGreenNode`, `MilHibri/*` | other syntax → BBCode-shaped tree | Importer trees translate their source; `treeMirrorsSource` is false. |
| **Editing** | `Edits/*`, `Fixes/*`, `Commands/*`, `Reconciler/*` | red tree + intent → surgical edits | Produces `TextChange`/`SurgicalEdit`, never rewrites untouched text. |
| **Editor services** | `Queries/*`, `Symbols/*`, `Formatter/*`, `Diff/*`, `Transactions/*`, `Source/*` | red tree / text → answers | Read-only except transactions; deterministic. |
| **Effects** | `Utils/EffectMath`, `Utils/ColorMath`, `Visuals/*` | text + parameters → styled segments | Shared math for preview and export; determinism is tested. |

Layer rules that the audit verified and that the suite enforces:

- `Visitors/BBCodeExporter`, `Edits/Rules/*`, `Semantic/osu/*` do not reach
  `HTMLRenderer`, directly or transitively (`Architecture.test.ts`).
- Green nodes are immutable and position-free; red ranges are the only
  positions (`checkRedTree`).
- Every phase terminates on every input: nesting is capped at 256, unclosed
  raw tags consume to EOF by design, and no walker recurses without a bound.

---

## 2. What was verified before changing code

| Check | Command | Result |
|---|---|---|
| Quasar suite | `npx vitest run` (in `packages/quasar`) | **2396 passed**, 1 skipped, 121 files |
| Validation mode | `npm run test:validate` | passed before the work |
| Benchmark baseline | `node scripts/bench/run.mjs --runs 3` | recorded in §6 |
| Structural fuzz (new) | `npx vitest run src/Tests/StructureFuzz.test.ts` | 4000 documents × 2 dialects |

The initial inspection also re-ran the documented public API. That is how the
first two findings surfaced: `query('bold')` returned zero matches on a
document that contained bold, and `new Formatter().format('[b]Hello[/b]')`
returned `Hello`.

---

## 3. Findings and resolutions

### F1 — `QueryEngine` matched nothing (high)

**Evidence.** Every documented selector returned `[]`:

```ts
const doc = parse('[quote][b]bold[/b] [color=red]red[/color][/quote]')
query('paragraph > bold') // []
query('[color]')          // []
query('*')                // []
```

**Cause.** The first step was applied to `[root]` only, so unless the query's
first selector was `document` it could never match; every later step then ran
from an empty set. `*` was parsed as a literal tag name, `[color]` as an
attribute-existence selector, and the `sibling` combinator called `.id` on
every sibling (minting identity state during a read).

**Fix.** `Types/queries.ts` is now a real selector compiler: tokenizer with
bracket/paren/quote depth, compounds (`tag[attr=value]:pseudo`), tag aliases
(`[b]` → `bold`), `*`, and the four combinators. The engine searches the whole
document for the first step, resolves later steps by a set of reachable nodes,
and returns deduplicated document order. No node ids are read.

**Tests.** `Tests/QueryEngine.test.ts` (16): documented examples, aliases,
spaces inside attributes, forward/adjacent/sibling combinators, pseudo-classes,
document order, deduplication, empty/unparseable selectors, id-minting.
`query()` is now exported from the package root (it was missing, so
`DocumentModel.query` was only reachable through a deep import).

### F2 — `Formatter` deleted every tag (high)

**Evidence.** `format('[b]Hello[/b]')` → `Hello`. All four declared options
(`indent`, `blockNewlines`, `maxLineWidth`, `normalizeInlineWhitespace`) were
typed, passed through the public API, and never read.

**Fix.** Serialization delegates to `BBCodeExporter` (the one component that
knows tag spellings, attributes and escaping); formatting is then opt-in
whitespace normalization: `collapseEmptyLines`, `normalizeInlineWhitespace`,
`blockNewlines`. `[code]` is opaque to all three. The two options that were
never implementable at this layer (`indent`, `maxLineWidth`) were removed from
`FormatOptions` rather than left as silent no-ops; see §7.

**Tests.** `Tests/Formatter.test.ts` (18): markup preservation, canonical
casing, each option, code protection, fixed point over four documents × five
option sets, byte-identical repeat runs.

### F3 — `MarkdownExporter` emitted Markdown that means something else (high)

**Evidence.** Concatenating block children changed the document:

```
[heading]Title[/heading]\n\nText  →  # Title\nText        (base)
separator after a paragraph       →  Text\n---           (a setext H2 on re-import)
list followed by a paragraph      →  - a\n- b\nAfter      (lazy continuation: "After" joins the list)
```

**Fix.** `exportSequence` places every block kind on its own blank-line-
delimited section. `visit` normalizes runs of blank lines to one and trims the
document edges, outside fenced code. Nested containers (`quote`, `box`,
`notice`) trim the separators before wrapping.

**Tests.** `Tests/MarkdownBlockFidelity.test.ts` (11): heading/list/quote/fence
separation, `---` never directly under text, re-import keeps `<hr>` and `<h2>`,
fixed point after BBCode-only tags become Markdown.

### F4 — Markdown export collapsed blank lines inside fenced code (medium)

**Evidence.** `visit()` ran `/(?:\r?\n){3,}/g` over the entire output, code
fences included, so four newlines in a sample became two.

**Fix.** `normalizeMarkdown` tracks fences line by line; code content is copied
verbatim. **Test.** the fenced-code case in `MarkdownBlockFidelity.test.ts`.

### F5 — Markdown import lost everything after an unmatched tag (high)

**Evidence.** `before\n\n[separator]\n\n# After` imported as a separator whose
children were the heading; the separator exporter ignores children, so the
heading disappeared. The same happened with a typo'd `[box]`: it consumed to
EOF. A reference written before its definition is analogous in the symbol
layer (F7).

**Fix.** The Markdown parser now checks whether a closer for the tag exists
after the opener (one precomputed last-close index, O(1) per opener). A tag
with no closer is literal text, and the parser continues after the opener;
`separator`/`br`/`hr` are self-closing. Unclosed `[code]` still consumes to EOF,
because that is the language's raw-block rule.

**Tests.** `MarkdownBlockFidelity.test.ts` (self-closing retention, unmatched
block, unmatched inline, unclosed code).

### F6 — No source-location layer (medium, architecture/DX)

**Evidence.** Diagnostics carry offsets and nothing else. The app re-created
`buildLineStarts` plus a linear scan, and there was no engine answer for
offset → line/column, CRLF handling or diagnostic rendering.

**Fix.** New `Source/SourceText.ts`:

- `SourceText`: lazy line index, `positionAt` (binary search), `offsetAt`,
  `lineAt`, `getLineStart/End/EndIncludingBreak`, `getLineText`, clamping.
  `\n`, `\r\n` and lone `\r` each count as one break.
- `formatDiagnostic` / `formatDiagnostics`: compiler-style
  `file(line,col): severity code: message` (1-based), deterministic.
- `DocumentModel.sourceText`, `.positionAt`, `.offsetAt`, `.lineAt`, with the
  index rebuilt only when the source string changes.

**Tests.** `Tests/SourceText.test.ts` (14): empty text, LF/CRLF/CR, EOF,
clamping, every position round-trip, line spans, 20 000-line index, formatting,
model integration across an edit.

### F7 — `SymbolTable` lookup never worked; ids were clock-based (medium)

**Evidence.** `getSymbolForNode` looked a symbol ID up in a map keyed by
name → `undefined` for every node. References before their definition were
dropped. `createSymbolId` embedded `Date.now()`, so identical text produced
different IDs. `search` truncated before ranking, so a better match later in
the document could be lost.

**Fix.** Two passes (definitions, then references), node→symbol-name index used
by `getSymbolForNode`, first definition wins for duplicates, IDs derived from
name + offset, full ranking before the `maxResults` cut.

**Tests.** `Tests/SymbolTable.test.ts` (6), including the exact lookup that
used to fail and the forward reference.

### F8 — `query` builder missing from the barrel (low)

`DocumentModel.query(q)` takes a `Query`, but `query(selector)` was not
exported from the package root. Added, with the selector types.

---

## 4. Deliberately not changed (remaining risks)

These were inspected and left alone; each has a reason, not just a cost.

1. **`Transaction.invert()` is only correct for `replace_node`.** Insert,
   delete and move return the original operations as their "inverse". The
   undo path no longer uses it — `UndoManager` stores text snapshots — so it is
   public API with a misleading name. A correct inverse needs the pre-image of
   a delete, which the operation does not carry. Next step: capture the
   removed subtree in the operation, or mark `invert` internal. Deferred to
   avoid an operation-schema change inside this audit.
2. **`JSONExporter.toJSON().version` reports the root node's version, not a
   schema version.** The field is unread inside the repository, but changing it
   is a wire-format change. Documented here; needs a format decision.
3. **`TiptapExporter` flattens nested inline content** (it joins child text
   and keeps one mark level). It is explicitly an MVP bridge, not a lossless
   round-trip; a real mapping needs ProseMirror's inline schema.
4. **Markdown import does not preserve blank lines** as nodes — Markdown has
   no blank-line node, and the exporter reconstructs separation from blocks.
   The round-trip is semantically stable, not byte-identical, for documents
   that mix BBCode-only tags with Markdown.
5. **Query engine scope.** No `:not()`, no `[attr^=]` operators, no selector
   groups. The tokenizer accepts and skips unknown pseudo-classes rather than
   throwing; adding operators is a grammar decision, not an audit fix.
6. **Formatter canonicalises.** It reconstructs through the exporter, so
   `[B]` becomes `[b]`, an attribute may gain quotes and a colour may be
   normalised to the target's spelling. It is a pretty-printer, not a
   source-preserving rewrite; `applyChange` remains the path that preserves the
   author's bytes.
7. **No automatic benchmark gate.** `scripts/bench` compares against
   `--base <ref>` and the numbers are reproducible, but CI does not fail on a
   regression. Thresholds on shared CI hardware are noisy; the honest gate is
   the differential correctness suite, which is enforced.
8. **`SymbolTable` depends on `id`/`goto` metadata** that the built-in tag set
   does not produce. The type and lookup are now correct, but a plugin must
   provide the metadata; a first-class anchor tag would need parser and
   renderer support (a feature, not a repair).
9. **No cached HTML per red-tree snapshot.** A sound cache needs either
   immutable red nodes or an explicit invalidation call for out-of-band
   mutations (`RedNode.bumpVersion`, `allowMutation` edits). See §6.5; the
   benchmark says a repeat render is 15–17 ms, so this is a future API
   decision, not a missed fix.
10. **Queries still walk the tree.** A kind index trades one walk per tree and
    its memory for a lookup that, for document-wide selectors, visits every
    block anyway. `query()` is 4.5–5.0 ms on the 547 KB fixture (§6.4).

---

## 5. Reliability and resource guarantees after the changes

| Concern | Guarantee | Evidence |
|---|---|---|
| Malformed input | No parse, analyze, render or export call throws; every character belongs to exactly one node | `StructureFuzz.test.ts`: 4000 random documents × 2 dialects, 65 fragments including `[`, `[/`, NUL, CRLF, astral characters |
| Caret resolution | `findNodeAtOffset` returns the deepest containing node at every offset; EOF resolves to the root | same test, every offset of every generated document |
| Diagnostics | Every range is inside the document and `start ≤ end` | same test |
| Incremental = full | Unchanged by this work; re-verified under the validator | `npm run test:validate`: 2458 passed |
| Determinism | Formatter/SymbolTable/Markdown export are clock-free; `SourceText` is a pure index | fixed-point tests, repeat-run test, ID test |
| Complexity | `SourceText.positionAt` O(log lines); query O(steps × nodes); formatter/export O(output); Markdown recovery precomputes close indices O(tokens) | `fixture.editor` workload |
| Repeated analysis | A second `analyze()` with no edit returns the previous result unchanged; every invalidation is tested | `AnalyzeMemo.test.ts`, `fixture.analyzeRepeat` |
| Nesting | Still capped at 256 by the parser; new walks are iterative (query, symbol collection) or bounded by existing limits | `NestingLimit.test.ts` |

---

## 6. Measurements

### 6.1 Test suite

| | Before | After |
|---|---|---|
| Files | 121 passed, 1 skipped | **128 passed, 1 skipped** |
| Tests | 2396 passed, 1 skipped | **2471 passed, 1 skipped** |
| Validation mode | pass | **2467 passed, 1 skipped** (budget suite excluded by design) |
| Package typecheck | pass | pass |

The 75 new tests are the six files named in §3 plus the nine in
`AnalyzeMemo.test.ts` (§6.5). No existing test was weakened or removed.

### 6.2 Core phases — working tree vs `HEAD` (median of 3 processes, ms)

`node scripts/bench/run.mjs --base HEAD --runs 3`

| Metric | HEAD | Working tree | Δ |
|---|---:|---:|---:|
| corpus.parse.warm (65 docs) | 18.7 | 18.7 | 0.1% |
| corpus.analyze.warm | 45.9 | 47.1 | 2.7% |
| corpus.render.warm | 20.8 | 21.0 | 1.0% |
| corpus.export.osu.warm | 31.3 | 31.2 | −0.4% |
| corpus.forum.warm | 39.3 | 39.1 | −0.5% |
| fixture.open.warm.p50 (547 KB) | 24.9 | 25.4 | 1.7% |
| fixture.render.warm | 15.3 | 16.0 | 4.0% |
| fixture.analyze.warm (repeat call — superseded by §6.5) | 65.0 | 64.8 | −0.4% then; 0.00 ms now |
| fixture.export.osu | 18.0 | 17.4 | −3.2% |
| fixture.typing.applyChange.p50 | 0.27 | 0.30 | +0.03 ms |
| fixture.keys.p50 / p99 | 0.36 / 8.92 | 0.36 / 8.75 | −0.7% / −1.8% |
| fixture.keys.rebuilds (300 edits) | 5 | 5 | 0 |

Every difference is within run-to-run noise for this harness, except the
sub-0.3 ms `applyChange` timer, where 0.03 ms is one clock tick of the
measurement. Nothing in the compiler core was touched by the fixes; this table
is the evidence that it stayed that way.

### 6.3 Edited paths

| Metric | HEAD | Working tree | Note |
|---|---:|---:|---|
| fixture.markdown.export | 9.35 ms | 10.2 ms | +0.85 ms buys block correctness; the first implementation was 51 ms (quadratic rope flattening) and was rewritten before landing |
| fixture.markdown.bytes | 339 949 | 339 838 | −0.03% |
| fixture.markdown.separators | 1476 | 1367 | redundant separators collapsed, not lost |

### 6.4 New editor services (547 KB, 38 522 nodes, 4754 lines)

`node scripts/bench/run.mjs --only '^fixture\\.editor$' --runs 5`

| Measure | Result |
|---|---:|
| `SourceText` index build (whole document) | **3.17 ms** |
| 100 000 `positionAt` lookups | **12.4 ms** (~124 ns each) |
| `query('*')` — 38 522 matches | **4.99 ms** |
| `query('[color]')` — 12 360 matches | **4.52 ms** |
| `Formatter.format` (default) | 8.99 ms |
| `Formatter.format` (all three options) | 28.8 ms |
| `MarkdownExporter.export` | 9.70 ms |

Before the fix, `query('*')` returned 0 matches in 0 ms — fast and wrong.

### 6.5 `analyze()` with nothing new to analyse (memoized)

`DocumentModel.analyze()` asks a question about the current document. If the
document has not changed since the last pass, and nothing that feeds a verdict
has changed, there is no second answer to compute: the previous result is
returned — the same object, with the same diagnostics, `scope` and `window`.

`node scripts/bench/run.mjs --base HEAD --runs 5 --only '^(corpus\.analyze|fixture\.(phases|editAnalyze))$'`:

| Metric | HEAD | Working tree | Δ |
|---|---:|---:|---:|
| `fixture.analyze.warm` — repeat call, unchanged tree | 66.2 ms | **0.00 ms** | −100% |
| `corpus.analyze.warm` — repeat over 65 docs | 43.6 ms | **0.01 ms** | −100% |
| `corpus.analyze.cold` — real first pass over 65 docs | 100 ms | 103 ms | +2.9% (noise) |
| `fixture.analyze.cold` — real full pass | 107 ms | 105 ms | −1.8% (noise) |
| `fixture.editAnalyze.p50` — edit + window pass | 1.82 ms | 1.78 ms | −1.9% (noise) |
| `fixture.analyzeRepeat.diagnostics` | — | 588 | the full answer, not an empty one |
| `fixture.analyzeRepeat.sameResult` | — | 1 | same result object |

Precise repeat cost on the 547 KB fixture, measured over 1000 calls after the
first pass: **0.37 µs per call**, 1000/1000 returning the same result object,
and its 588 diagnostics identical — code, severity and range — to a fresh
model's full pass over the same text.

What a hit is allowed to trust is checked on every call: the model has not
edited (`version`), no analysis window is pending, the semantic analyzer still
holds a pass for this exact root and source, and its validators, tokens and
dialect are unchanged. Each invalidation has a test in
`AnalyzeMemo.test.ts`: an edit, a `rebuild` with identical text, a newly
registered validator, a new token source, a dialect change, and a differential
against a fresh model after every edit of a sequence.

The one assumption is the model's own contract: `version` identifies the
document state. A red tree mutated behind the model's back is not observed —
exactly as no other `version`-keyed consumer observes it (the editor's tree
cache, the preview's reconcile). Rebuild, or apply the edit through the model.

**Why the HTML render is not cached the same way.** `render()` takes 15–17 ms
on the fixture, and a repeat render of the same green tree looks cacheable —
but a red tree is mutable by contract. `RedNode.bumpVersion()` exists precisely
for *"attributes/metadata change without structural change"*, and
`RedNode.allowMutation` + `appendChild`/`removeChild`/`replaceChild` can
reorder or replace a live subtree; `BlockPatcher.test.ts` does the latter and
then renders. A green-keyed HTML cache would serve the pre-mutation markup in
both cases, which is a wrong preview, not a slow one. Caching per green is what
the semantic model already does, but its answers are memoized per node and
recomputed from the node at hand; the full HTML is not, and the assumption
would have to hold for every byte of the output. The honest options are an
opt-in cache with an explicit invalidation call, or making red nodes immutable
— both API decisions, not a memo. Deferred deliberately (§4.9).

**Why queries still walk.** `query()` costs 4.5–5.0 ms over 38 522 nodes. A
kind index would cost one full walk per tree plus its memory, and every query
this codebase runs asks for matches anywhere in the document — the index would
be consulted across all blocks anyway. Deferred (§4.10).

---

## 7. API contracts and compatibility

**Additive (no migration):**

- `SourceText`, `formatDiagnostic`, `formatDiagnostics`, `LineAndCharacter`,
  `SourceLine`, `FormatDiagnosticOptions` exported from the root.
- `DocumentModel.sourceText`, `.positionAt(offset)`, `.offsetAt(line, char)`,
  `.lineAt(offset)`.
- `query(selector)` exported; `QuerySelector`, `QueryStep`, `QueryCombinator`
  exported as types.
- `SymbolTable` IDs are now deterministic; `getSymbolForNode` works.
- `SemanticAnalyzer.analysisIsCurrent(root, source)` — whether its last pass
  still answers for that tree (same source, validators, tokens, dialect).
- `DocumentModel.analyze()` returns the previous result object when nothing
  has changed; consumers comparing result identity get a stable answer.

**Narrowing (intentional, documented):**

- `FormatOptions` dropped `indent` and `maxLineWidth`, which were never read.
  Passing either was already a no-op; now the type says so.
- `Formatter.format` accepts `RedNode | null` (returns `''` for `null`).
- `QuerySelector` gained `attribute_value`; exhaustive switches in external
  consumers get a new case. `attribute` keeps its old metadata semantics.

**Output changes (semantic repairs, re-baseline snapshots):**

- Markdown export now separates blocks with blank lines, preserves blank lines
  inside fenced code, and normalises redundant blank runs.
- The Markdown importer keeps text after unmatched/self-closing tags instead
  of deleting it.
- Symbol IDs changed format (clock-free).
- Formatter output is canonical BBCode instead of child text.

The BBCode exporter, renderer, incremental parser and analysis outputs were
not changed.

---

## 8. Reproducing

From `packages/quasar`:

```bash
# correctness
npm run typecheck
npx vitest run

# validator mode (asserts the red-tree invariants after every reparse)
npm run test:validate

# the new structural fuzzer, with a replayable seed
QUASAR_FUZZ_SEED=12345 npx vitest run src/Tests/StructureFuzz.test.ts

# benchmarks (from the Miliastry repository root, so esbuild/jsdom resolve)
node packages/quasar/scripts/bench/run.mjs --runs 3 \
  --only '^(fixture\.(open|phases|typing|keys|markdown|editor)|corpus\.(parse|analyze|render|export\.osu|forum))$'

# the same workloads against the previous tree
node packages/quasar/scripts/bench/run.mjs --base HEAD --runs 3 \
  --only '^(fixture\.(open|phases|typing|keys|markdown)|corpus\.(parse|analyze|render|export\.osu|forum))$'

# the analyze memo, and the analysis an edit still costs
node packages/quasar/scripts/bench/run.mjs --runs 5 \
  --only 'fixture\.(analyzeRepeat|editAnalyze|phases)'

# targeted suites introduced here
npx vitest run src/Tests/SourceText.test.ts src/Tests/QueryEngine.test.ts \
  src/Tests/Formatter.test.ts src/Tests/MarkdownBlockFidelity.test.ts \
  src/Tests/SymbolTable.test.ts src/Tests/StructureFuzz.test.ts
```

The only failing check in the monorepo is pre-existing and unrelated:
`npm run typecheck` at the repository root reports
`scripts/wysiwyg-gestures/page.ts(12,292): Cannot find module './.build/helpers'`,
a generated helper that is not checked in. The Quasar package typechecks
clean.
