# 15. Language service and restyle performance

Written 2026-10-24. Two fronts in one pass:

1. **Promises the engine made but did not keep.** Editor services that were
   declared and exported but answered nothing for built-in documents, a Fix-All
   scope that threw, plugin contributions that warned instead of working, and a
   cache constant that was declared and never read.
2. **Restyling a whole page.** A theme change used to re-parse and re-walk the
   entire document, the decision layer re-derived colour maths it could cache,
   and applying a plan spliced the source once per action — quadratic in the
   page size.
3. **Answers after an edit.** Tokens, outline and folding were cached by
   `model.version`, so one keystroke threw all three away and rebuilt them from
   the whole tree. They are now cached per top-level green block: unchanged
   blocks keep their answer, moved blocks keep it shifted, and only the edited
   block is walked again.

The measurements in §5 are reproducible with the commands in §7.

---

## 1. Verdict

The compiler core was not the problem. The defects were in the **editor-service
seam** (symbols, navigation, workspace scope) and in the **restyle applier**
(analysis repeat, per-action re-parsing, quadratic string splicing). Fixing
those gives a Roslyn-shaped service surface and, on the 500 KB fixture:

| Operation | Before | After | Change |
|---|---:|---:|---:|
| Plan a restyle (parse + analyse + decide) | 131 ms | **66.6 ms** | **2.0×** |
| Change theme on the same page | 131 ms | **10.7 ms** | **12.2×** |
| Apply 16 848 actions to 500 KB | 3.95–6.8 s | **2.63 ms** | **~1 500–2 600×** |
| Analysis alone (four passes) | 30.5 ms | **19.8 ms** | **1.5×** |
| Decision alone | 57.6 ms | **10.7 ms** | **5.4×** |
| Semantic tokens after one edit | 30.1 ms | **10.6 ms** | **2.8×** |
| Outline after one edit | 12.4 ms | **0.9 ms** | **13.9×** |
| Querying every node (38 522) | 5.1 ms | **3.1 ms** | **1.6×** |

Those before figures come from `packages/quasar` at `HEAD` (`97f8843`) in a
separate process; the after figures are the `restyle.fixture` workload on this
tree. Both use the same 547 KB / 501 841-character fixture. `restyle.plan.cold`
is the first measurement in its process and pays JIT warm-up, so compare it
with the 131 ms base figure rather than with the `fourPass.plan` reference,
which runs later in the same warm process.

The analysis rows are the exception: their "before" is this same tree before
the semantic-analysis pass described in §4 (84.6 ms is the
`fixture.analyze.cold` workload; ~61 ms is the median of six isolated full
passes, which is the like-for-like comparison with the 38.5 ms after figure).

---

## 2. What was unwired, and what happened to it

| Finding | Evidence | Resolution |
|---|---|---|
| **`SymbolTable` could never find a symbol in a normal document.** It only understood `metadata.id` / `metadata.goto`, and no built-in tag produced either. `getSymbolForNode` was also broken before the 2026-10-21 audit. | `[heading]Intro[/heading]` produced zero symbols; `[url=#intro]` was ordinary text to it. | Headings now define a symbol named by their fragment (`intro`, `intro-2` for duplicates); `[url=#intro]` is a reference with the exact `#intro` range. The metadata path remains for plugins. **`SymbolTable.build(root, source?)`** takes the source when a precise reference range is wanted. |
| **Fix-All at `project` / `solution` scope threw `UnimplementedError`.** The `FixAllScope` type promised three scopes; only `document` existed. `fixAllDocuments` could not be called with the other two either. | `fixAllDocuments` ran `checkScope` and rejected them. | `fixAllDocuments` aggregates every target; `Workspace.fixAll(key, { scope: 'project' \| 'solution' })` is the public path. **`fixAll` still refuses a wider scope on purpose**: one `FixAllTarget` is one document. |
| **Plugin `styles` and `dependencies` were declared, typed, and warned about as unsupported.** | `PluginAPI.registerPlugin` logged `"styles are not injected"` and `"dependencies are not checked"`. | Styles are injected as one `<style data-quasar-plugin="name">` per sheet when a DOM exists, removed on unregister, and replaced on re-register. Missing dependencies throw at registration; dependencies must be registered first. |
| **`OKLAB_CACHE` was declared and never read.** A bounded memo with a comment and no call site. | The constant existed at `Utils/ColorMath.ts`; `hexToOklab` converted every time. | It is now the cache behind `hexToOklabCached`, used by gradient detection and palette matching. |
| **`applyRemapPlan` spliced once per action.** Every splice copied the rest of the document. | 16 848 actions on the fixture: **3.95–6.8 s**. | Replaced with `applyRemapActions`, one forward pass over untouched spans, joined once: **2.63 ms**. |
| **A restyle re-parsed the document for every theme preview.** `buildRemapPlan` built a model and ran four analysis passes per call, and the Aura panel calls it for every theme. | The provider already deferred the source; the analysis still depended only on the source, not on the theme. | `PaletteRemapPlanner` caches the analysis per source (LRU 2) and plans per palette (LRU 8). A theme change now runs the decision only. |

Deliberately kept: `applyTransformer`, `BBCodeGenerator`, `internGreenLeaf`,
`withChildren`, `createBBCodeRedNodeStore` and `extractTemplateProvider` are
exported extension surface with no caller inside this repository. They were
reviewed and left public rather than amputated — the same decision recorded in
the roadmap for the subsystems without internal consumers. `withChildren` and
`createBBCodeRedNodeStore` remain reachable through the published `./src/*`
subpath, so removing them is a breaking change, not a cleanup.

---

## 3. The Roslyn-shaped surface

`LanguageService` is the editor-facing layer over one `DocumentModel`. It is
not another model: it caches answers by `model.version` and never mutates the
document.

```ts
const doc = new BBCodeDocumentModel({ source })
const service = new LanguageService(doc)

service.getDiagnostics()                 // flushes the debounced analysis
service.getDocumentSymbols()             // nested outline, blocks only
service.getQuickInfo(offset)             // tag, attribute or symbol
service.getDefinition(offset)            // heading / fragment / plugin id
service.findReferences(offset)           // definition + links, source order
service.rename(offset, 'Introduction')   // SurgicalEdit[] against the source
service.getCompletions(offset)           // tags, closing tags, vocabularies
service.getSemanticTokens()              // tag, attribute, text, string, …
service.getFoldingRanges()               // multi-line blocks
service.getCodeActions(offset)           // the LightbulbHost, flushed first
service.stats                            // hits, misses, symbol builds
```

Design points that matter:

- **Offsets, not line/column.** Every other Quasar API is offset-based;
  `SourceText` is the one translation to positions, and the service does not
  duplicate it.
- **Everything structural is cached by `version`.** Outline, tokens, folding and
  the symbol table are rebuilt after an edit and reused until then. A warm read
  is a version compare (0.00 ms in the harness).
- **Rename refuses what it cannot do safely.** A heading containing nested
  formatting is not flattened; an `id`/`goto` value is edited inside the
  author's quotes and spacing, not re-serialized.
- **Completion is honest about its contexts.** After `[/` it offers the open
  ancestors; after `[tag=` it offers `attributeVocabularyFor(tag)`'s values;
  otherwise it offers tag names for the dialect plus plugin registrations.
  Outside a delimiter it returns nothing.
- **Code actions delegate.** `getCodeActions` flushes the model's analysis and
  asks `LightbulbHost`, so there is one fix registry and one stale-diagnostic
  rebase, not a second implementation.

`Workspace` adds the multi-document noun:

```ts
const workspace = new Workspace()
workspace.open('a.bbcode', '[b]one')
workspace.open('b.bbcode', '[i]two')
workspace.fixAll('unclosed-tag', { scope: 'solution' })
// { applied: 2, deferred: 0, passes: 1 }
```

Keys are caller-chosen strings. The workspace does not own a filesystem and
does not parse URIs.

---

## 4. Restyle architecture

### One analysis, one walk

`RestyleAnalyzer` produces every contribution a palette decision reads —
`Color`, `Gradient`, `GradientTag`, `Symbol`, `Separator` — in one pre-order
walk. The four original analyzers remain public and are the reference
implementation; a test asserts the combined report is contribution-for-
contribution equal to their concatenation.

The walk avoids two costs that were paid per node before:

- offsets are accumulated instead of allocated by `childOffsets` (one array per
  element node);
- a node's children are only inspected for a colour run when it has at least
  three colour children.

Gradient detection itself memoizes `detectStops` and `buildDiagnostics` on the
colour sequence (`SEQUENCE_CACHE_LIMIT = 1024`). Real pages repeat motifs; the
fixture's 17 484 contributions come from far fewer distinct ramps. The memo is
bounded and cleared on overflow, the same policy as the OKLab cache.

### Decision caches

`PaletteRemapDecision` now:

- converts the palette to OKLab **once per instance**;
- memoizes nearest-palette matches per distinct document colour;
- samples the palette through pre-converted OKLab endpoints;
- sorts one contribution list per label instead of filtering the semantic array
  four times;
- finds gradient membership by binary search over source-ordered colours, not
  `colors.filter` per gradient.

### Semantic analysis

The diagnostics pass had its own hot spots, measured with the full fixture and
an isolated analyzer (the bench's `fixture.analyze.cold` process pays JIT once;
the figures below are repeated full passes in one process):

- **`gradient-outlier` reads only the window it decides on.** It used to build
a reversed five-node run, map all of it through `hexOf` and allocate an array
per colour. The fast path now recognises `#RRGGBB` by character codes, parses
the colour into one packed integer, and computes the distances from that — no
regex, no `rgb` arrays, no `steps` list. On the 547 KB fixture it runs over
12 360 colour nodes; the source scans it used to repeat are gone.
- **`unclosed-tag` and `crossed-tags` reuse the walk's answer.** The candidate
walk already asks "is this tag unclosed?" once per element from green widths
and the source. The validators used to ask the same question again, per node,
with their own source scans. They now consult a node-keyed opener set and the
crossing map the pass already built.
- **Analysis does not mint an id for every node.** `collapsible-gradient`,
`crossed-tags` and `unclosed-tag` looked their node up by `node.id`, which
forced a stable id for all 38 522 nodes of the fixture so that 588 diagnostics
could be filed. The maps are now keyed by the node object; the id-keyed forms
remain on the public context for plugins. A full pass mints **660** ids
instead of **38 522**.
- **`empty-tag` checks the cheap condition first.** It reads two lazy range
getters and a Set only for childless nodes; nodes with children returned "no"
after paying for them before.

Median of six full passes on the fixture, warm process: **61 ms → 38.5 ms**.
The first pass in a fresh process (`fixture.analyze.cold`) went **84.6 ms →
62.0 ms**. The edit path is unchanged and still windowed: **1.96 ms p50**.

### Incremental editor answers

The language service now caches tokens, outline and folding **per top-level
green block**, not per document version:

- A block whose green subtree was shared with the previous version keeps its
  token list, its outline subtree and its folding ranges. Ranges are shifted by
  the block's new start; folding lines are stored relative to the block's first
  line, so a move only changes the base line.
- The edited block has new green nodes and is re-walked. An outline block also
  checks red-node identity before reuse, because `nodeId` must still resolve —
  a rebuilt red node with the same green gets a fresh outline.
- Tokenization is the only remaining full pass: the output is one flat array, so
  the 134 713 token objects are re-emitted (and the shifted tail reallocated)
even when the blocks are cached. That is 10.6 ms instead of 30.1 ms on the
fixture; the tree walk and `source.slice` work are gone.

The same identity rule answers the query engine: a one-step query is one
pre-order walk with compiled predicates, not a `flatten` of 38 522 nodes
followed by a filter. Queries with combinators only materialise a set when
several sources can reach the same node.

### Planner lifetimes

`PaletteRemapPlanner.plan(source, palette)` separates document understanding
from palette choice:

```
plan(source, A)   parse + RestyleAnalyzer + decision
plan(source, B)   decision only
plan(source, A)   previous plan object, unchanged
```

The analysis cache is an LRU over **source strings** (default 2). The reports
hold no tree nodes — contributions carry ranges, models and strings — so a
cached analysis does not pin a red/green tree alive. Plans are cached per
source by a palette signature (default 8), so a theme preview that returns to a
previous theme is free.

### Applying

`applyRemapActions` is the linear form of the old back-to-front splice:
collect untouched spans, append each replacement, join once. It skips
overlapping actions with the same first-in-reading-order contract as the
segment preview. `applyEditsToSource` remains the general form; a plan's
actions are just ranges and text.

---

## 5. Measurements

Environment: Node v26, `NODE_ENV=production`, 500 KB fixture
(`packages/quasar/500KCharsTest`, 547 261 bytes / 501 841 characters).
Median of 3–5 runs after warm-up; the harness runs each workload in its own
process.

| Measure | `HEAD` | This tree |
|---|---:|---:|
| Restyle analysis (four passes → one) | 30.5 ms | **19.8 ms** |
| Palette decision, 16 848 actions | 57.6 ms | **10.7 ms** |
| Plan a page (parse + analysis + decision) | 131 ms | **66.6 ms** |
| Theme change on the same source | 131 ms | **10.7 ms** |
| Plan cache hit | — | **0.00 ms** |
| Apply 16 848 actions | 3 953–6 788 ms | **2.63 ms** |
| Actions / contributions | 16 848 / 17 484 | unchanged |
| Language outline (500 KB, cold) | — | **12.4 ms** |
| Language outline after one edit | 12.4 ms | **0.9 ms** |
| Semantic tokens (134 713, cold) | — | **30.1 ms** |
| Semantic tokens after one edit | 30.1 ms | **10.6 ms** |
| Folding after one edit | — | **3.0 ms** |
| Semantic tokens / outline / folding (warm) | — | **0.00 ms** |
| First semantic analysis, full pass (`fixture.analyze.cold`) | 84.6 ms | **62.0 ms** |
| Full semantic analysis, steady state (547 KB, median of 6) | ~61 ms | **38.5 ms** |
| Node ids minted by a full analysis | 38 522 | **660** |
| Analysis after one edit (windowed) | — | **1.96 ms p50** |
| Query every node (38 522) | 5.1 ms | **3.1 ms** |
| Query 12 360 colour nodes | 4.2 ms | **2.8 ms** |
| Symbol navigation (500 headings + links, cold/warm) | — | **3.4 / 0.05 ms** |
| Quick info / completion (per call) | — | **0.01 / 0.02 ms** |
| Code actions at a caret | — | **0.15 ms** |

`restyle.replan.actions.count` remains 8 148 on the fixture. That is
**informational, not a promise**: glyph and native `[gradient]` substitutions
are exact, but a run of `[color]` tags that is recoloured can be re-detected as
a slightly different ramp on the next pass. The old documentation only ever
claimed glyph idempotence; the harness now measures the whole-plan number so a
future change cannot claim otherwise silently.

---

## 6. The harness

`scripts/bench/run.mjs` already ran each workload in a fresh process and
alternated engines. It now also gates:

```bash
cd packages/quasar
npm run bench -- --list

# the new workloads
npm run bench -- --runs 3 \
  --only '^(restyle|language)\.' --json restyle.json

# absolute ceilings for a reference machine
npm run bench -- --runs 3 \
  --only '^(restyle|language)\.' \
  --budget scripts/bench/budget.json --check

# relative regression against a saved run
npm run bench -- --runs 3 \
  --baseline restyle.json --tolerance 0.15 --check
```

New workloads:

| Workload | What it measures |
|---|---|
| `restyle.corpus` | one plan over all 65 corpus documents (682 KB) |
| `restyle.fixture` | cold plan, warm plan, one-walk vs four-pass analysis, decision, linear apply, old apply, re-plan count |
| `language.fixture` | diagnostics, outline, tokens, folding, quick info, completion, code actions, and the post-edit token/outline/folding path on the fixture |
| `language.navigation` | symbol-table build, 500 heading/fragment references, rename edits |
| `fixture.editor` | source locations, structural queries, formatting and Markdown export on the fixture |

Budgets are intentionally loose (`scripts/bench/budget.json`): the harness is
there to catch a phase that became quadratic or lost its cache, not to police
5% of JIT noise. Use `--baseline` for a machine-local gate.

---

## 7. Reproducing

```bash
cd packages/quasar
npm run typecheck
npx vitest run
npx vitest run src/Tests/LanguageService.test.ts src/Tests/RestylePlanner.test.ts \
  src/Tests/PluginPromises.test.ts

cd packages/quasar
npm run bench -- --runs 3 \
  --only '^restyle\.fixture$' --budget scripts/bench/budget.json --check
```

The `HEAD` figures were produced from a clean archive of the submodule in a
separate process:

```bash
mkdir -p scratch/base-src
git -C packages/quasar archive HEAD src | tar -x -C scratch/base-src
# bundle a probe against scratch/base-src/src/index.ts with esbuild, then:
#   parse, four analyzers, PaletteRemapDecision, old back-to-front apply
```

---

## 8. Deliberate limits

- **No signature help or code lens.** They need a call shape BBCode does not
  have; inventing one would be UI, not engine.
- **Completion does no fuzzy ranking.** Prefix matching over the dialect and
  registry; the editor's own provider can rank.
- **Workspace has no file IO.** It manages open models; persistence and URI
  semantics belong to the caller.
- **A gradient run can drift on re-plan.** See §5; fixing it needs the previous
  gradient model, which the source does not carry.
- **The analysis cache is bounded by source text.** Two 500 KB pages is roughly
  the size of two documents plus their contribution objects; the planner is not
  meant to hold a project.
