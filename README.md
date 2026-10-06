<div align="center">
  <img src="./assets/quasar-icon.svg" alt="Quasar" width="128" height="128">
  <h1>Quasar Document Engine</h1>
  <p><strong>A Roslyn-style syntax engine for BBCode, in pure TypeScript.</strong></p>
</div>

---

Quasar is the document engine behind **Miliastry**. It parses BBCode into an immutable red-green syntax tree, re-parses only what an edit touched, and gives you everything an editor needs on top of that tree: diagnostics with fixes, a WYSIWYG canvas that writes minimal edits back to the source, an osu!-accurate preview, exporters, and a text-effects toolkit.

**The text is always the truth.** The tree is derived from it, every gesture comes back as a `TextChange`, and nothing Quasar does rewrites characters the author did not touch.

- **Zero runtime dependencies.** Runs in the browser, Node.js, Bun, Deno and Tauri.
- **Never throws on input.** Any text parses to a valid tree. Broken markup becomes diagnostics, not exceptions.
- **Three BBCode dialects.** `osu` (osu! profile and forum), `miliastry` (the default superset) and `lyne`.

## Quick start

```ts
import { BBCodeDocumentModel, BBCodeExporter } from '@miliastry/quasar'

const doc = new BBCodeDocumentModel({
  source: '[b]Hello[/b] [color=#ff0000]world',
  dialect: 'osu',
})

doc.toHTML()
// <span class="bb-paragraph"><strong>Hello</strong> <span style="color:#ff0000;">world</span></span>

doc.diagnostics?.items
// [{ severity: 'warning', code: 'unclosed-tag',
//    message: 'Missing [/color] — the tag was closed automatically', … }]

// Feed edits straight from your editor (Monaco hands you exactly this shape).
doc.applyChange({ start: 3, end: 8, text: 'Hi' })

new BBCodeExporter({ target: 'osu' }).export(doc.redRoot!)
// [b]Hi[/b] [color=#ff0000]world[/color]
```

Read-only views (forum posts, comments) can skip the editor machinery entirely:

```ts
const html = BBCodeDocumentModel.renderForum(source, { dialect: 'lyne' })
```

`renderForum` turns off analysis, undo and node ids, so it is the cheapest way to get HTML.

## What Quasar gives you

| Area | What you get | Entry points |
|---|---|---|
| **Syntax tree** | Immutable, position-free green nodes shared across edits. Red nodes on top of them carry parents, absolute ranges and stable ids. | `GreenNode`, `RedNode`, `TreeBuilder` |
| **Incremental parsing** | Re-parses a window around each edit and reuses everything outside it, including red subtrees. Below 2.5 KB a full parse is faster, so it does that instead. | `DocumentModel.applyChange`, `IncrementalParser` |
| **Diagnostics** | Unclosed, orphan and crossed tags, unknown tags (with replacements suggested per dialect), empty or redundant markup, unsafe URLs, and osu! pitfalls: markup the preview shows as fine but osu! publishes differently. | `SemanticAnalyzer`, `Linter` |
| **Lightbulb** | Quick fixes and refactorings at the caret, Fix All across one document or many. Each action exposes its edits and a lazy preview. | `queryLightbulb`, `fixAll`, `registerCodeFix`, `registerRefactoring` |
| **Optimizer** | Rules that shrink BBCode without changing the result: merge adjacent tags, drop empty or redundant ones, shorten hex colors. Conflicting edits are resolved by one shared plan. | `optimizeBBCode`, `optimizeTree`, `resolveEditConflicts` |
| **WYSIWYG canvas** | A `contenteditable` painted by the renderer. Bold, color, Enter, Backspace and paste become minimal source edits that keep the author's casing and spacing. | `CanvasDocument`, `toggleInlineFormat`, `insertContent` |
| **osu! fidelity** | Reproduces osu!'s own tag pairing and newline rules, with an incremental preview tree that patches the DOM block by block. | `OsuPreviewTree`, `patchBlocksInto`, `pairing: 'osu'` |
| **Rendering and export** | HTML (with osu! and Lyne themes), in-place DOM morphing, SVG, BBCode per target dialect, Markdown, JSON and Tiptap. | `HTMLRenderer`, `morphHTML`, `BBCodeExporter`, `domToSVG` |
| **Import** | Markdown, HTML and MilHibri (a hybrid of BBCode and Markdown) are translated into the same tree. | `MarkdownDocumentModel`, `HTMLDocumentModel`, `MilHibriDocumentModel` |
| **Text effects** | Gradients, rainbows, waves and grow effects baked into BBCode, plus the math behind them: OKLab mixing, easing, noise, masks, paint grids and user expressions. | `applyGradient`, `GradientTransformer`, `evaluateEffect`, `mixHexOklab` |
| **Analysis pipeline** | Pass-based analysis that finds collapsible gradients, mergeable colors and decorative symbol runs, and remaps a document to a palette. | `PipelineBuilder`, `GradientAnalyzer`, `PaletteRemapDecision` |
| **Anchors** | Ranges that follow the text through edits and survive a reload, for comments, open boxes or ignored warnings. | `AnchorSet`, `toSelector`, `restoreAnchors` |
| **Collaboration** | Offset and range transforms for a text CRDT (Yjs or similar). Every edit carries an `origin`, so you can tell your own echo apart. | `transformOffset`, `transformRange` |
| **Editor services** | CSS-like structural queries, a symbol table, tree diffing, transactions with undo, a formatter and nesting repair. | `QueryEngine`, `SymbolTable`, `TreeDiffer`, `Transaction`, `repairNesting` |
| **Extensibility** | One plugin can contribute tags, commands, validators, lint rules, code fixes, refactorings, render hooks and CSS. Design tokens resolve at export time. | `PluginRegistry`, `TagRegistry`, `toTokenResolver` |

Everything listed is exported from the package root. Nothing requires a deep import.

## Guarantees

Every promise has an enforcer: the type system, a constructor, the tree validator or a property test. The full table is in [9. Guarantees](./docs/09-Guarantees.md). The ones you rely on most:

- **Round-trip.** For BBCode, every text leaf holds exactly the source characters its range covers.
- **Incremental equals full.** An incremental re-parse produces the same tree a full parse of the same text would, checked over 144 000 fuzzed edits with 0 divergences.
- **Publishing never depends on presentation.** The exporter and the optimizer cannot import a renderer. A test walks the import graph to enforce it.

The Markdown, HTML and MilHibri models are importers: they keep every tree invariant, but they do not reproduce their own source text.

## Performance

Measured on a 547 KB document and on the 65-document Miliastry corpus. The method is in [12. Incremental performance](./docs/12-Incremental-Performance.md).

| Measure | Result |
|---|---|
| Real typing on the corpus handled incrementally | 96.4% |
| Typing in prose, 547 KB, per keystroke | 0.30 ms |
| Random keystrokes, 547 KB, p50 / p90 / p99 | 0.89 / 2.02 / 28.6 ms |
| Full rebuild, 547 KB | about 55 ms |

Prefer `applyChange` when your editor gives you the change. `applyTextUpdate` has to diff the whole text first.

## Installation

Inside the Miliastry monorepo, Quasar is the `@miliastry/quasar` workspace package and needs no setup.

Elsewhere, install it from GitHub Packages. Add this to your project's `.npmrc`:

```
@miliastry:registry=https://npm.pkg.github.com/
```

Then:

```bash
npm install @miliastry/quasar
```

Themes ship as separate stylesheets:

```ts
import '@miliastry/quasar/Visuals/osu.css'
import '@miliastry/quasar/Visuals/lyne.css'
```

For a step-by-step integration into an existing site, see [INTEGRATION-LYNE.md](./INTEGRATION-LYNE.md).

## Development

| Command | What it does |
|---|---|
| `npm test` | Runs the Vitest suite. |
| `npm run test:validate` | Runs the suite with the tree validator after every rebuild and re-parse. |
| `npm run typecheck` | Type-checks without emitting. |
| `npm run verify` | Typecheck, then tests. Run it before publishing. |
| `npm run build` | Builds ESM, CJS, type declarations and the theme stylesheets into `dist/`. |

## Documentation

| Start here if you want to… | Read |
|---|---|
| Understand the architecture in depth | [QuasarArch.MD](./QuasarArch.MD) |
| Know what the engine promises | [9. Guarantees](./docs/09-Guarantees.md) |
| Build an editor on the canvas | [13. WYSIWYG canvas](./docs/13-WYSIWYG.md) |
| Find out where a keystroke's time goes | [12. Incremental performance](./docs/12-Incremental-Performance.md) |
| Attach data to parts of a document | [11. Anchors](./docs/11-Anchors-Plan.md) |
| See how osu! semantics are modeled | [10. Semantic model](./docs/10-Semantic-Model-Plan.md) |
| Add real-time collaboration | [QuasarCollab.MD](./QuasarCollab.MD) |
| See what is planned | [QuasarRoadmap.MD](./QuasarRoadmap.MD) |

The [docs index](./docs/_Sidebar.md) lists every page.

## License

[**Miliastry Source License (MSL-1.1)**](LICENSE). Copyright (c) 2026 hxovc / Miliastry Team.

Quasar is source-available. You can use, modify and distribute it in any project, including visual BBCode editors and osu! profile tools, **except** to build a Competing Product: a clone of Miliastry as an integrated IDE, or a competing standalone engine based on this code.
