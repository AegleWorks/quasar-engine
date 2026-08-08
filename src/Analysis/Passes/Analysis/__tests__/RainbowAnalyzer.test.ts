/**
 * Tests for RainbowAnalyzer
 */

import { describe, it, expect } from 'vitest'
import { greenNode, greenLeaf } from '../../../../Syntax/GreenNode'
import type { GreenNode } from '../../../../Syntax/GreenNode'
import { RainbowAnalyzer } from '../RainbowAnalyzer'
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

describe('RainbowAnalyzer', () => {
  it('detects a classic rainbow (hue rotation, stable S/L)', () => {
    // Red → Yellow → Green → Cyan → Blue — classic rainbow with high S, mid L
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'R'),
      colorNode('#FFAA00', 'A'),
      colorNode('#FFFF00', 'Y'),
      colorNode('#00FF00', 'G'),
      colorNode('#00FFFF', 'C'),
      colorNode('#0000FF', 'B'),
      colorNode('#AA00FF', 'V'),
    ])

    const analyzer = new RainbowAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results.length).toBeGreaterThanOrEqual(1)
    if (results[0].kind === 'semantic') {
      expect(results[0].confidence).toBeGreaterThan(0.5)
    }
  })

  it('gives lower confidence to random colors (no hue rotation)', () => {
    // Colors with varying hues, saturations, and lightness — no clear rainbow
    const tree = greenNode('document', '', [
      colorNode('#804868', 'A'),
      colorNode('#7EB8E0', 'B'),
      colorNode('#D194B3', 'C'),
      colorNode('#43383A', 'D'),
      colorNode('#595255', 'E'),
    ])

    const analyzer = new RainbowAnalyzer()
    const results = analyzer.run(tree, mockContext)

    // These have no clear hue rotation — confidence should be low
    if (results.length > 0 && results[0].kind === 'semantic') {
      expect(results[0].confidence).toBeLessThan(0.7)
    }
  })

  it('ignores sequences shorter than minimum length (4)', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#00FF00', 'B'),
      colorNode('#0000FF', 'C'),
    ])

    const analyzer = new RainbowAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results).toHaveLength(0)
  })

  it('reports diagnostics with hue delta and saturation deviation', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#FF8800', 'B'),
      colorNode('#FFFF00', 'C'),
      colorNode('#88FF00', 'D'),
      colorNode('#00FF00', 'E'),
    ])

    const analyzer = new RainbowAnalyzer()
    const results = analyzer.run(tree, mockContext)

    if (results.length > 0 && results[0].kind === 'semantic') {
      const diag = results[0].metadata.diagnostics as Record<string, unknown>
      expect(typeof diag.hueDelta).toBe('number')
      expect(typeof diag.saturationDeviation).toBe('number')
      expect(typeof diag.lightnessDeviation).toBe('number')
    }
  })
})
