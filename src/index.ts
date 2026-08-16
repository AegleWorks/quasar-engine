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
export type { Token, TokenKind, Trivia, TriviaKind } from './Types/tokens'

// ── Green/Red Tree ──
export { GreenNode, greenNode, greenLeaf } from './Syntax/GreenNode'
export { RedNode } from './Syntax/RedNode'
export { RedNodeStore } from './Syntax/RedNodeStore'
export { TreeBuilder, type BuildResult } from './Syntax/TreeBuilder'
export { NodeMatcher, type MatchResult } from './Syntax/NodeMatcher'

// ── Semantic ──
export { SemanticAnalyzer, type AnalyzeResult } from './Semantic/SemanticAnalyzer'
export type { Diagnostic, DiagnosticSeverity, DiagnosticTag } from './Types/diagnostics'

// ── Tag Registry ──
export { TagRegistry, type TagDefinition, type TagHandler } from './Model/TagRegistry'
export { NodeFactory } from './Model/NodeFactory'

// ── Incremental ──
export { IncrementalParser, type EditOperation } from './Incremental/IncrementalParser'
export { ChangeTracker, type TextChange } from './Incremental/ChangeTracker'

// ── Diff ──
export { TreeDiffer, type DiffOperation, type DiffKind } from './Diff/TreeDiffer'

// ── Visitors ──
export { Visitor, type VisitorContext } from './Visitors/Visitor'
export { BBCodeExporter, MILIASTRY_ONLY_TAGS, LYNE_ONLY_TAGS, type ExportTarget } from './Visitors/BBCodeExporter'
export { BBBlocksExporter, type UIBBBlock } from './Visitors/BBBlocksExporter'
export { HTMLRenderer, type HTMLRendererOptions } from './Visitors/HTMLRenderer'
export { morphHTML } from './Visitors/DOMMorpher'
export { patchBlocksInto } from './Visitors/BlockPatcher'
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

// ── Markdown Bridge ──
export { MarkdownDocumentModel } from './Markdown/MarkdownDocumentModel'
export { markdownAstToGreenTree, markdownAstToRedTree } from './Markdown/MarkdownToGreenNode'

// ── HTML Bridge ──
export { HTMLDocumentModel } from './HTML/HTMLDocumentModel'
export { htmlStringToGreenTree } from './HTML/HTMLToGreenNode'

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
  RainbowAnalyzer,
  WaveAnalyzer,
  DefaultDecision,
  CollapseGradientTransform,
  RainbowCollapseTransform,
  WaveCollapseTransform,
  MergeColorsTransform,
} from './Analysis/index'
export type {
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
} from './Analysis/index'

// NOTE: `ExportTarget` from Analysis is intentionally omitted to avoid
// naming collision with the existing `ExportTarget` from Visitors/BBCodeExporter.
// Consumers who need the Analysis export target can import directly:
// `import { ExportTarget } from '@miliastry/quasar/Analysis/Contracts/PipelineContext'`


