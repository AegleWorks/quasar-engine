/**
 * Quasar Analysis Framework — Integration Tests
 *
 * End-to-end tests that exercise the full pipeline with real passes:
 *   GradientAnalyzer → DefaultDecision → CollapseGradientTransform
 *   MergeableColorAnalyzer → DefaultDecision → MergeColorsTransform
 */

import { describe, it, expect } from 'vitest'
import { greenNode, greenLeaf } from '../../Syntax/GreenNode'
import type { GreenNode } from '../../Syntax/GreenNode'
import { Pipeline } from '../Pipeline/Pipeline'
import { PipelineBuilder } from '../Pipeline/PipelineBuilder'
import { GradientAnalyzer } from '../Passes/Analysis/GradientAnalyzer'
import { MergeableColorAnalyzer } from '../Passes/Analysis/MergeableColorAnalyzer'
import { DefaultDecision } from '../Passes/Decision/DefaultDecision'
import { CollapseGradientTransform } from '../Passes/Transform/CollapseGradientTransform'
import { MergeColorsTransform } from '../Passes/Transform/MergeColorsTransform'
import type { PipelineContext } from '../Contracts/PipelineContext'
import { PipelineMode, ExportTarget } from '../Contracts/PipelineContext'

// ── Helpers ───────────────────────────────────────────────────────

function colorNode(hex: string, text: string): GreenNode {
  // Widths of the real BBCode this stands for: `[color=#RRGGBB]` and `[/color]`.
  const textLeaf = greenLeaf('text', text)
  return greenNode('color', `=${hex}`, [textLeaf], 8 + hex.length, 8)
}

const interactiveContext: PipelineContext = {
  mode: PipelineMode.Interactive,
  target: ExportTarget.Miliastry,
  featureFlags: {},
  metadata: {},
}

const batchOsuContext: PipelineContext = {
  mode: PipelineMode.Batch,
  target: ExportTarget.Osu,
  featureFlags: {},
  metadata: {},
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Gradient pipeline (full integration)', () => {
  it('collapses a clear gradient with miliastry target', () => {
    // [color=#FF0000]H[/color][color=#EE1100]e[/color][color=#DD2200]l[/color][color=#CC3300]l[/color][color=#BB4400]o[/color]
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'H'),
      colorNode('#EE1100', 'e'),
      colorNode('#DD2200', 'l'),
      colorNode('#CC3300', 'l'),
      colorNode('#BB4400', 'o'),
    ])

    const pipeline = new PipelineBuilder()
      .analysis(new GradientAnalyzer())
      .decision(new DefaultDecision())
      .transform(new CollapseGradientTransform())
      .build()

    const result = pipeline.run(tree, interactiveContext)
    const treeChildren = result.tree.children as GreenNode[]

    // After collapsing, we should have a single gradient node
    const gradientNodes = treeChildren.filter(c => c.kind === 'gradient')
    expect(gradientNodes.length).toBeGreaterThanOrEqual(1)
  })

  it('preserves non-gradient color sequences with osu target', () => {
    // Random colors — low confidence, below osu threshold
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#00FF00', 'B'),
      colorNode('#0000FF', 'C'),
    ])

    const pipeline = new PipelineBuilder()
      .analysis(new GradientAnalyzer())
      .decision(new DefaultDecision())
      .transform(new CollapseGradientTransform())
      .build()

    const result = pipeline.run(tree, batchOsuContext)
    const treeChildren = result.tree.children as GreenNode[]

    // With only 3 random colors, confidence should be below osu threshold
    const gradientNodes = treeChildren.filter(c => c.kind === 'gradient')
    expect(gradientNodes).toHaveLength(0)
  })

  it('produces an AnalysisReport with contributions', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#EE1100', 'B'),
      colorNode('#DD2200', 'C'),
      colorNode('#CC3300', 'D'),
    ])

    const pipeline = new PipelineBuilder()
      .analysis(new GradientAnalyzer())
      .build()

    const result = pipeline.run(tree, interactiveContext)

    expect(result.report.contributions.length).toBeGreaterThanOrEqual(1)
    expect(result.report.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.report.passCount).toBe(1)
  })
})

describe('Merge colors pipeline (full integration)', () => {
  it('merges identical consecutive color nodes', () => {
    // [color=#FF0000]H[/color][color=#FF0000]e[/color][color=#FF0000]l[/color]
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'H'),
      colorNode('#FF0000', 'e'),
      colorNode('#FF0000', 'l'),
    ])

    const pipeline = new PipelineBuilder()
      .analysis(new MergeableColorAnalyzer())
      .decision(new DefaultDecision())
      .transform(new MergeColorsTransform())
      .build()

    const result = pipeline.run(tree, interactiveContext)
    const treeChildren = result.tree.children as GreenNode[]

    // Should be 1 colour node (merged) instead of 3
    const colorNodes = treeChildren.filter(c => c.kind === 'color')
    expect(colorNodes).toHaveLength(1)
  })
})

describe('Combined pipeline', () => {
  it('runs multiple analysis passes and produces correct report', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#EE1100', 'B'),
      colorNode('#DD2200', 'C'),
      colorNode('#FF0000', 'X'),  // part of mergeable (different from gradient sequence)
      colorNode('#FF0000', 'Y'),
    ])

    const pipeline = new PipelineBuilder()
      .analysis(new GradientAnalyzer(), new MergeableColorAnalyzer())
      .decision(new DefaultDecision())
      .build()

    const result = pipeline.run(tree, interactiveContext)

    // Should have contributions from both analyzers
    const analysisContributions = result.report.contributions
    const gradientContributions = analysisContributions.filter(c => c.kind === 'semantic' && c.label === 'Gradient')
    const mergeContributions = analysisContributions.filter(c => c.kind === 'optimization' && c.label === 'Merge Colors')

    expect(gradientContributions.length).toBeGreaterThanOrEqual(1)
    expect(mergeContributions.length).toBeGreaterThanOrEqual(1)
  })
})
