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

  it('finds collapsible gradients with replacement text and combined content', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'H'),
      colorNode('#CC0022', 'e'),
      colorNode('#990044', 'l'),
      colorNode('#660066', 'l'),
      colorNode('#330088', 'o'),
    ])

    const analyzer = new GradientAnalyzer()
    const collapsible = analyzer.findCollapsibleGradients(tree)

    expect(collapsible).toHaveLength(1)
    expect(collapsible[0].combinedText).toBe('Hello')
    expect(collapsible[0].colorCount).toBe(5)
    expect(collapsible[0].confidence).toBeGreaterThan(0.6)
    // Only the necessary stops (endpoints for a smooth linear ramp), NOT all 5 colors!
    expect(collapsible[0].stops).toHaveLength(2)
    expect(collapsible[0].replacementText).toBe('[gradient=#FF0000,#330088]Hello[/gradient]')
  })

  it('accurately reproduces symmetric multi-stop gradients with minimal keyframes (37 chars -> 5 stops)', () => {
    const raw = '[color=#302E38]✩[/color][color=#393A48]₊[/color][color=#424758]˚[/color][color=#4A5368].[/color][color=#535F78]⋆[/color][color=#5C6C87]☾[/color][color=#657897]⋆[/color][color=#6D84A7]⁺[/color][color=#7691B7]₊[/color][color=#7F9DC7]✧[/color][color=#8CA0C8]₊[/color][color=#98A3CA]⁺[/color][color=#A5A6CB]⋆[/color][color=#B1A9CC]☽[/color][color=#BEABCE]⋆[/color][color=#CAAECF].[/color][color=#D7B1D0]˚[/color][color=#E3B4D2]₊[/color][color=#F0B7D3]✩[/color][color=#E3B4D2]₊[/color][color=#D7B1D0]˚[/color][color=#CAAECF].[/color][color=#BEABCE]⋆[/color][color=#B1A9CC]☾[/color][color=#A5A6CB]⋆[/color][color=#98A3CA]⁺[/color][color=#8CA0C8]₊[/color][color=#7F9DC7]✧[/color][color=#7691B7]₊[/color][color=#6D84A7]⁺[/color][color=#657897]⋆[/color][color=#5C6C87]☽[/color][color=#535F78]⋆[/color][color=#4A5368].[/color][color=#424758]˚[/color][color=#393A48]₊[/color][color=#302E38]✩[/color]'
    const colors = raw.match(/#[0-9A-Fa-f]{6}/g)!
    const chars = Array.from('✩₊˚.⋆☾⋆⁺₊✧₊⁺⋆☽⋆.˚₊✩₊˚.⋆☾⋆⁺₊✧₊⁺⋆☽⋆.˚₊✩')
    const nodes = colors.map((c, i) => colorNode(c, chars[i]))
    const tree = greenNode('document', '', nodes)

    const analyzer = new GradientAnalyzer()
    const collapsible = analyzer.findCollapsibleGradients(tree)

    expect(collapsible).toHaveLength(1)
    expect(collapsible[0].stops).toHaveLength(5)
    expect(collapsible[0].replacementText).toBe(
      '[gradient=#302E38,#7F9DC7,#F0B7D3,#7F9DC7,#302E38]✩₊˚.⋆☾⋆⁺₊✧₊⁺⋆☽⋆.˚₊✩₊˚.⋆☾⋆⁺₊✧₊⁺⋆☽⋆.˚₊✩[/gradient]',
    )
  })
})

