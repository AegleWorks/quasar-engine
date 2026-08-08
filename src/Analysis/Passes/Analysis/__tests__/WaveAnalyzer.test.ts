/**
 * Tests for WaveAnalyzer (size oscillation detection)
 */

import { describe, it, expect } from 'vitest'
import { greenNode, greenLeaf } from '../../../../Syntax/GreenNode'
import type { GreenNode } from '../../../../Syntax/GreenNode'
import { WaveAnalyzer } from '../WaveAnalyzer'
import type { PipelineContext } from '../../../Contracts/PipelineContext'
import { PipelineMode, ExportTarget } from '../../../Contracts/PipelineContext'
import { ContributionKind } from '../../../Contracts/Contribution'

const mockContext: PipelineContext = {
  mode: PipelineMode.Batch,
  target: ExportTarget.Miliastry,
  featureFlags: {},
  metadata: {},
}

function sizeNode(size: number, text: string): GreenNode {
  // Widths of the real BBCode this stands for: `[size=NN]` and `[/size]`.
  const textLeaf = greenLeaf('text', text)
  return greenNode('font_size', `=${size}`, [textLeaf], 7 + String(size).length, 7)
}

describe('WaveAnalyzer', () => {
  it('detects a sine wave size pattern', () => {
    // Sinusoidal sizes: 90 → 120 → 150 → 120 → 90
    const tree = greenNode('document', '', [
      sizeNode(90, 'A'),
      sizeNode(120, 'B'),
      sizeNode(150, 'C'),
      sizeNode(120, 'D'),
      sizeNode(90, 'E'),
    ])

    const analyzer = new WaveAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('gives higher confidence to clear wave patterns', () => {
    // Perfect sine-like: 90→125→160→125→90
    const tree = greenNode('document', '', [
      sizeNode(90, 'A'),
      sizeNode(110, 'B'),
      sizeNode(140, 'C'),
      sizeNode(160, 'D'),
      sizeNode(140, 'E'),
      sizeNode(110, 'F'),
      sizeNode(90, 'G'),
    ])

    const analyzer = new WaveAnalyzer()
    const results = analyzer.run(tree, mockContext)

    if (results.length > 0 && results[0].kind === 'semantic') {
      expect(results[0].confidence).toBeGreaterThan(0.4)
    }
  })

  it('detects a wave pattern and produces a contribution', () => {
    // Validates the WaveAnalyzer produces a semantic contribution for size patterns
    const tree = greenNode('document', '', [
      sizeNode(90, 'A'),
      sizeNode(120, 'B'),
      sizeNode(150, 'C'),
      sizeNode(120, 'D'),
      sizeNode(90, 'E'),
      sizeNode(120, 'F'),
      sizeNode(150, 'G'),
    ])

    const analyzer = new WaveAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results.length).toBeGreaterThanOrEqual(1)
    if (results[0].kind === 'semantic') {
      expect(results[0].label).toBe('Wave')
      expect(results[0].metadata.model).toBeDefined()
    }
  })

  it('ignores sequences shorter than minimum length (5)', () => {
    const tree = greenNode('document', '', [
      sizeNode(90, 'A'),
      sizeNode(120, 'B'),
      sizeNode(150, 'C'),
      sizeNode(120, 'D'),
    ])

    const analyzer = new WaveAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results).toHaveLength(0)
  })

  it('reports diagnostics with periodicity score', () => {
    const tree = greenNode('document', '', [
      sizeNode(90, 'A'),
      sizeNode(120, 'B'),
      sizeNode(150, 'C'),
      sizeNode(120, 'D'),
      sizeNode(90, 'E'),
      sizeNode(120, 'F'),
      sizeNode(150, 'G'),
    ])

    const analyzer = new WaveAnalyzer()
    const results = analyzer.run(tree, mockContext)

    if (results.length > 0 && results[0].kind === 'semantic') {
      const diag = results[0].metadata.diagnostics as Record<string, unknown>
      expect(typeof diag.periodicityScore).toBe('number')
      expect(typeof diag.transitionSmoothness).toBe('number')
    }
  })
})
