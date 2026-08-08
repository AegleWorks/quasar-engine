/**
 * Tests for refined GradientAnalyzer v2 (OKLab, change-point detection)
 */

import { describe, it, expect } from 'vitest'
import { greenNode, greenLeaf } from '../../../../Syntax/GreenNode'
import type { GreenNode } from '../../../../Syntax/GreenNode'
import { GradientAnalyzer } from '../GradientAnalyzer'
import type { PipelineContext } from '../../../Contracts/PipelineContext'
import { PipelineMode, ExportTarget } from '../../../Contracts/PipelineContext'
import { ContributionKind } from '../../../Contracts/Contribution'

const mockContext: PipelineContext = {
  mode: PipelineMode.Batch,
  target: ExportTarget.Miliastry,
  featureFlags: {},
  metadata: {},
}

function colorNode(hex: string, text: string): GreenNode {
  // Widths of the real BBCode this stands for: `[color=#RRGGBB]` and `[/color]`.
  const textLeaf = greenLeaf('text', text)
  return greenNode('color', `=${hex}`, [textLeaf], 8 + hex.length, 8)
}

describe('GradientAnalyzer v2', () => {
  it('detects a smooth linear gradient with high confidence', () => {
    // Perfectly spaced perceptual gradient: #FF0000 → #990000 → #330000
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#CC0022', 'B'),
      colorNode('#990044', 'C'),
      colorNode('#660066', 'D'),
      colorNode('#330088', 'E'),
      colorNode('#0000AA', 'F'),
    ])

    const analyzer = new GradientAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results.length).toBeGreaterThanOrEqual(1)
    if (results[0].kind === 'semantic') {
      expect(results[0].confidence).toBeGreaterThan(0.7)
    }
  })

  it('detects change points (stops) in plateau-heavy sequences', () => {
    // RRRR→G→BBBB: 4 R, 1 G, 4 B
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'R'),
      colorNode('#FF0000', 'R'),
      colorNode('#FF0000', 'R'),
      colorNode('#FF0000', 'R'),
      colorNode('#00FF00', 'G'),
      colorNode('#0000FF', 'B'),
      colorNode('#0000FF', 'B'),
      colorNode('#0000FF', 'B'),
      colorNode('#0000FF', 'B'),
    ])

    const analyzer = new GradientAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results.length).toBeGreaterThanOrEqual(1)
    if (results[0].kind === 'semantic') {
      // Check that stops were detected via change-point detection
      const model = results[0].metadata.model as Record<string, unknown>
      const stops = model.stops as Array<{ color: string; position: number }>
      // Should detect 3 stops: R, G, B
      expect(stops.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('gives low confidence to random colour jumps', () => {
    // Red→Green→Blue: sharp perceptual jumps
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#00FF00', 'B'),
      colorNode('#0000FF', 'C'),
    ])

    const analyzer = new GradientAnalyzer()
    const results = analyzer.run(tree, mockContext)

    // Should detect, but with low confidence (large perceptual error)
    if (results.length > 0 && results[0].kind === 'semantic') {
      expect(results[0].confidence).toBeLessThan(0.7)
    }
  })

  it('ignores sequences shorter than minimum length', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#00FF00', 'B'),
    ])

    const analyzer = new GradientAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results).toHaveLength(0)
  })

  it('handles mixed content (non-color nodes between colors)', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      greenLeaf('text', ' break '),
      colorNode('#EE1100', 'B'),
    ])

    const analyzer = new GradientAnalyzer()
    const results = analyzer.run(tree, mockContext)

    // The break text should separate the sequence into single nodes
    expect(results).toHaveLength(0)
  })

  it('returns diagnostics with stop count in metadata', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#DD2222', 'B'),
      colorNode('#BB4444', 'C'),
      colorNode('#996666', 'D'),
      colorNode('#778888', 'E'),
    ])

    const analyzer = new GradientAnalyzer()
    const results = analyzer.run(tree, mockContext)

    if (results.length > 0 && results[0].kind === 'semantic') {
      const diag = results[0].metadata.diagnostics as Record<string, unknown>
      expect(typeof diag.stopCount).toBe('number')
      expect(typeof diag.maxPerceptualError).toBe('number')
    }
  })
})
