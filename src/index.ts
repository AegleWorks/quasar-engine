/**
 * MiliastryPlatform / DocumentEngine — Public API
 *
 * Language Platform agnóstica. El BBCode es solo una representación.
 * Todo pasa por el Document Model.
 *
 * @see MILIASTRY_DOCUMENT_ENGINE_ARCHITECTURE.md
 */

// ═══════════════════════════════════════════════════
// 🟢 PUBLIC API
// ═══════════════════════════════════════════════════

export { DocumentModel } from './Model/DocumentModel'
export type {
  DocumentNode,
  NodeKind,
  NodeAttributes,
  NodeMetadata,
  DocumentChangeEvent,
  SourceRange
} from './Types/core'

// ── Lexer ──
export { Lexer, type LexerOptions } from './Lexer/Lexer'
// Which tags carry literal content. The lexer is the only authority on it;
// exported so consumers stop keeping their own copy.
export { BBCODE_RAW_TAGS } from './Lexer/BBCodeLexer'
export type { Token, TokenKind, Trivia, TriviaKind } from './Types/tokens'

// ── Green/Red Tree ──
export { GreenNode, greenNode, greenLeaf } from './Syntax/GreenNode'
export { RedNode } from './Syntax/RedNode'
export { RedNodeStore } from './Syntax/RedNodeStore'
export { TreeBuilder, type BuildResult } from './Syntax/TreeBuilder'
export { NodeMatcher, type MatchResult } from './Syntax/NodeMatcher'

// ── Semantic ──
export { SemanticAnalyzer, type AnalyzeResult, type SemanticAnalyzerOptions, type CrossedTags, type UnknownTag } from './Semantic/SemanticAnalyzer'
/**
 * Whether an analysis walked the document or only the edit — see
 * {@link AnalyzeResult.scope}.
 *
 * `'full'` every node was validated afresh; `'window'` only the nodes an edit
 * could have changed were, and every other node kept the verdict it already
 * had. The DIAGNOSTICS ARE THE SAME EITHER WAY: this says how they were
 * arrived at, not what they are.
 *
 * Worth reading if you are timing the engine, deciding whether a slow frame
 * was the analysis, or writing a test that must not silently lose the
 * incremental path. NOT worth branching your rendering on — a consumer that
 * treats `'window'` results as partial and merges them into what it already
 * had will double-report, because `AnalyzeResult.diagnostics` is always the
 * whole document's.
 *
 * `AnalyzeResult.window` carries the span that was re-validated on a
 * `'window'` pass, and is `null` on a full one.
 */
export type { AnalyzeScope } from './Semantic/SemanticAnalyzer'
/**
 * `AnalyzeResult` plus the id→node index — see
 * {@link SemanticAnalyzer.analyze}. `allNodes` is a getter that builds the
 * index on first read, so a caller that never asks never pays for the walk.
 */
export type { IndexedAnalyzeResult } from './Semantic/SemanticAnalyzer'
export type { Diagnostic, DiagnosticSeverity, DiagnosticTag, DiagnosticFix, FixOperation } from './Types/diagnostics'

// ── Tag Registry ──
export { TagRegistry, type TagDefinition, type TagHandler } from './Model/TagRegistry'
// El texto plano de un subárbol. Se exporta porque fuera de Quasar nadie puede
// reimplementarlo bien: `[code]` es literal y los saltos de línea son hojas
// `spacing` sin texto propio, así que un recorrido ingenuo los pierde.
export { extractTextContent } from './Model/TagRegistry'
export { NodeFactory } from './Model/NodeFactory'

// ── Incremental ──
export { IncrementalParser, type EditOperation } from './Incremental/IncrementalParser'
export { ChangeTracker, type TextChange } from './Incremental/ChangeTracker'
/**
 * A half-open span of the source, `[start, end)`, in the coordinates of the
 * text whose result carries it.
 *
 * The same shape everywhere it appears — {@link ReparseResult.window},
 * `AnalyzeResult.window`, `DocumentModel.lastReparseWindow` — because it
 * always means the same thing: the part of the CURRENT text that the engine
 * actually looked at.
 */
export type { SourceSpan } from './Incremental/IncrementalParser'
/**
 * What a reparse did, including {@link ReparseResult.window} — the span of the
 * new text that went through the parser, or `null` after a full rebuild,
 * where the answer is "all of it".
 *
 * Everything outside that span came across from the previous tree by
 * reference, so a consumer holding per-node state (a rendered block, a
 * measured height, a decoration) can keep it for every node the span does not
 * touch. `DocumentModel.lastReparseWindow` is the same value for the model's
 * last edit, which is usually the easier place to read it.
 */
export type { ReparseResult } from './Incremental/IncrementalParser'
/**
 * Why a reparse rebuilt the whole document instead of splicing a window.
 *
 * Useful when a document is unexpectedly slow to edit: a reason that repeats
 * on every keystroke is a document shape the window guards will not accept —
 * an unclosed `[` before the caret (`open-bracket-before`), a stray closing
 * tag inside the window (`region-not-isolated`), an edit that changes what the
 * parser leaves pending for the text after it (`pending-auto-close`).
 */
export type { FallbackReason } from './Incremental/IncrementalParser'

// ── Diff ──
export { TreeDiffer, type DiffOperation, type DiffKind } from './Diff/TreeDiffer'

// ── Visitors ──
export { Visitor, type VisitorContext } from './Visitors/Visitor'
export { BBCodeExporter, MILIASTRY_ONLY_TAGS, LYNE_ONLY_TAGS, type ExportTarget, type BBCodeExporterOptions, type BBCodeExportOptions } from './Visitors/BBCodeExporter'
export { BBBlocksExporter, type UIBBBlock } from './Visitors/BBBlocksExporter'
export { HTMLRenderer, type HTMLRendererOptions } from './Visitors/HTMLRenderer'
export { morphHTML, morphElement } from './Visitors/DOMMorpher'
export { patchBlocksInto, clearPatchCache, type PatchBlocksOptions, type PatchBlocksStats } from './Visitors/BlockPatcher'
export { SVGRenderer } from './Visitors/SVGRenderer'
export { MarkdownExporter } from './Visitors/MarkdownExporter'
export { JSONExporter } from './Visitors/JSONExporter'
export { TiptapExporter } from './Visitors/TiptapExporter'

// ── Transactions ──
export { Transaction } from './Transactions/Transaction'
export type { Operation } from './Types/operations'
export { UndoManager, type UndoEntry } from './Transactions/UndoManager'

// ── Commands ──
export { CommandRegistry } from './Commands/CommandRegistry'
export type { Command, CommandContext, CommandResult } from './Commands/Command'
export { InsertText } from './Commands/InsertText'
export { DeleteNode } from './Commands/DeleteNode'
export { WrapInTag } from './Commands/WrapInTag'
export { SplitNode, MergeNode } from './Commands/SplitMerge'

// ── Queries ──
export { QueryEngine } from './Queries/QueryEngine'
export type { Query, QueryMatch, QueryResult } from './Types/queries'

// ── Formatter ──
export { Formatter, type FormatOptions } from './Formatter/Formatter'

// ── Linter ──
export { Linter, type LintRule, type LintResult } from './Linter/Linter'

// ── Symbols ──
export { SymbolTable } from './Symbols/SymbolTable'
export type { SymbolInfo, SymbolKind, Reference, SymbolSearchResult } from './Types/symbols'

// ── Render Pipeline ──
export { RenderPipeline } from './RenderPipeline/RenderPipeline'
export { RenderTree, type RenderNode, type RenderVariant } from './RenderPipeline/RenderTree'

// ── Plugin API ──
export { PluginAPI } from './Plugins/PluginAPI'
export { PluginRegistry, type PluginManifest, type PluginContribution } from './Plugins/PluginRegistry'

// ── Repair ──
export { repairNesting, type NestingRepair, type OrphanCloser, type UnclosedOpener } from './Repair/NestingRepair'

// ── Reconciler ──
export { reconcileVisualDOMToBBCode, computeTextDelta, type SurgicalEdit as QuasarSurgicalEdit, type ReconcileResult } from './Reconciler/SurgicalReconciler'

// ── BBCode Optimizer (edit plan, conflict contract, rules) ──
export * from './Edits'

// ── BBCode Bridge ──
export { BBCodeDocumentModel } from './BBCode/BBCodeDocumentModel'
export type { BBCodeDocumentModelOptions } from './BBCode/BBCodeDocumentModel'
export {
  bbBlocksToRedTree,
  bbBlocksToGreenTree,
  bbBlockToGreenNode,
  greenToRedNode,
  tagToNodeKind,
  nodeKindToTag,
  isBlockKind,
  BBCODE_TAG_NAMES,
  getBBCodeTagNames,
  type BBCodeDialect,
} from './BBCode/BBCodeToGreenNode'
export type { BBBlock } from './BBCode/BBCodeToGreenNode'

// ── Events ──
export { DocumentEventBus, type DocumentEvent, type DocumentEventHandler } from './Events/EventBus'

// ── Collab (position transforms — see QuasarCollab.MD) ──
export { transformOffset, transformRange, type TransformBias } from './Collab/positions'

// ── Visuals ──
export { visualThemes } from './Visuals/index'
export type { VisualThemeId } from './Visuals/index'
export { bindBoxDrawer, toggleBoxWithDrawer } from './Visuals/BoxDrawer'
export type { BoxDrawerOptions } from './Visuals/BoxDrawer'

// ── Tree Transformers (document-wide effects) ──
export { applyGradient, applyGrow, applyRainbow, applyCentralGradient, applyMultiGradient, applyEffect, countTextLength } from './Utils/treeTransformers'
export type { GradientEffect, GrowEffect, RainbowEffect, CentralGradientEffect, MultiGradientEffect, TreeEffect } from './Utils/treeTransformers'

// ── DOM Utilities ──
export { domToSVG, domToSVGResult } from './Utils/dom-to-svg'
export type { DomToSVGOptions, DomToSVGResult, SVGLayerInfo } from './Utils/dom-to-svg'

// ── Transformation Engine ──
export type { Transformer } from './Transformers/Transformer'
export { ASTOptimizer } from './Transformers/ASTOptimizer'
export { SineWaveTransformer, type SineWaveOptions } from './Transformers/SineWaveTransformer'
export { RainbowTransformer, type RainbowOptions } from './Transformers/RainbowTransformer'
export { GradientTransformer, type GradientOptions } from './Transformers/GradientTransformer'
export { GrowTransformer, type GrowOptions } from './Transformers/GrowTransformer'

// ── MilHibri Unified Hybrid Language ──
export { MilHibriDocumentModel, type MilHibriDocumentModelOptions } from './MilHibri/MilHibriDocumentModel'

// ── Markdown Bridge ──
export { MarkdownDocumentModel } from './Markdown/MarkdownDocumentModel'
export { markdownAstToGreenTree, markdownAstToRedTree } from './Markdown/MarkdownToGreenNode'

// ── HTML Bridge ──
export { HTMLDocumentModel } from './HTML/HTMLDocumentModel'
export { htmlStringToGreenTree } from './HTML/HTMLToGreenNode'

// ── Colour Maths ──
// Perceptual colour utilities. Previously reachable only through the `./src/*`
// subpath, which resolves against source rather than `dist` and so breaks for
// any consumer of the built package.
export {
  ease,
  solveCubicBezierY,
  hslToHex,
  hexToRgb,
  hexToHsl,
  hexToOklab,
  mixHex,
  mixHexOklab,
  mixMultiple,
  mixMultipleStops,
  perceptualDistance,
} from './Utils/ColorMath'
export type { Easing, ColorStop } from './Utils/ColorMath'
export { isHexColor } from './Utils/ColorMath'

// ── Effect math: the kernel shared by the tag handlers, the HTML
// renderer and @miliastry/quasar-studio. ──
export {
  hashSeed, randAt, valueNoise, fbm,
  validateExpression, compileExpression, EXPRESSION_VARS,
  waveform, WAVE_KINDS, DEFAULT_WAVE_OPTIONS, clamp01,
  blendHex, BLEND_MODES, rgbToHex, adjustHsl, posterizeHex, clampRange,
  buildSampleTable, buildRangeScope, documentScope, axisValue, expressionVars, AXES,
  effectiveAxis, mergeStyledSegments, normalizeHex,
  parseColorStops, stringifyColorStops, parseEffectParams, stringifyEffectParams,
  EFFECT_PARAM_KEYS, EFFECT_UNITS,
  evaluateEffect, GRADIENT_DEFAULTS, RAINBOW_DEFAULTS, GROW_DEFAULTS, NEUTRAL_SIZE,
  PAINT_DEFAULTS, SPATIAL_DEFAULTS,
  // ── Placeable geometry, masks and paint grids ──
  SPATIAL_AXES, DEFAULT_CELL_ASPECT, DEFAULT_SPATIAL, spatialPoint,
  MASK_SHAPES, DEFAULT_MASK, maskValue, maskDistance,
  spatialFromParams, maskFromParams, gridFromParams,
  PAINT_MAX_COLORS, parsePaintGrid, samplePaintGrid,
  stringifyPaintCells, stringifyPaintPalette,
} from './Utils/EffectMath'
export type {
  WaveKind, WaveOptions, BlendMode, ExpressionVars, CompiledExpression,
  CharSample, SampleTable, RangeScope, SampleContext, Axis,
  EffectParams, EffectUnit, EffectKind, EffectSpan, StyledSegment,
  SpatialOptions, SpatialPoint, MaskShape, MaskOptions, PaintGrid,
} from './Utils/EffectMath'

// ── Tag Vocabulary ──
export {
  attributeVocabularyFor, allAttributeVocabularies,
  EFFECT_TYPES, ANIM_TYPES, CONTAINER_TYPES,
  SEPARATOR_VARIANTS, TABLE_FLAGS, IMG_MODIFIERS,
} from './Utils/TagVocabulary'
export type { AttributeVocabulary, VocabularySyntax } from './Utils/TagVocabulary'

// ── Analysis Framework ──
export {
  Pipeline,
  PipelineBuilder,
  PipelineStage,
  ContributionKind,
  PipelineMode,
  CharacterCountAnalyzer,
  MergeableColorAnalyzer,
  GradientAnalyzer,
  findCollapsibleGradients,
  formatGradientTag,
  RainbowAnalyzer,
  WaveAnalyzer,
  SymbolAnalyzer,
  ColorUsageAnalyzer,
  DefaultDecision,
  PaletteRemapDecision,
  CollapseGradientTransform,
  RainbowCollapseTransform,
  WaveCollapseTransform,
  MergeColorsTransform,
} from './Analysis/index'
export type {
  CollapsibleGradient,
  Pass,
  AnalyzerPass,
  DecisionPass,
  TransformPass,
  TransformationPlan,
  TransformAction,
  Contribution,
  SemanticContribution,
  DiagnosticContribution,
  OptimizationContribution,
  MetricsContribution,
  AnalysisReport,
  PipelineContext,
  PipelineResult,
  GradientModel,
  GradientDiagnostics,
  GradientStop,
  RainbowModel,
  RainbowDiagnostics,
  WaveModel,
  WaveDiagnostics,
  SymbolGlyph,
  SymbolRunModel,
  ColorUsageModel,
  Palette,
  PaletteRemapOptions,
  RemapAction,
} from './Analysis/index'

// NOTE: `ExportTarget` from Analysis is intentionally omitted to avoid
// naming collision with the existing `ExportTarget` from Visitors/BBCodeExporter.
// Consumers who need the Analysis export target can import directly:
// `import { ExportTarget } from '@miliastry/quasar/src/Analysis/Contracts/PipelineContext'`
// The `src/` segment is not optional: `./src/*` is the subpath the exports map
// actually publishes, and the deep specifier without it resolves to nothing.

// Semántica de atributos de etiqueta, compartida con quien pinte BBCode
// fuera del HTMLRenderer (los presets del lienzo, por ejemplo).
export {
  nodeAttrValue,
  parseImgAttr,
  sanitizeColor,
  sanitizeFontSize,
  sanitizeFontFamily,
} from './Syntax/nodeAttr'
export type { ImgAttr } from './Syntax/nodeAttr'

// ── Design Tokens ──
export {
  toTokenResolver,
  resolveTokenValue,
} from './Tokens/index'
export type {
  DocumentTokens,
  TokenResolverFn,
  TokenSource,
} from './Tokens/index'

