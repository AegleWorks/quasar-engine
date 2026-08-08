/**
 * Tests for MergeableColorAnalyzer
 */

import { describe, it, expect } from 'vitest'
import { greenNode, greenLeaf } from '../../../../Syntax/GreenNode'
import { MergeableColorAnalyzer } from '../MergeableColorAnalyzer'
import type { PipelineContext } from '../../../Contracts/PipelineContext'
import { PipelineMode, ExportTarget } from '../../../Contracts/PipelineContext'
import { ContributionKind } from '../../../Contracts/Contribution'

const mockContext: PipelineContext = {
  mode: PipelineMode.Batch,
  target: ExportTarget.Osu,
  featureFlags: {},
  metadata: {},
}

function colorNode(hex: string, text: string): import('../../../../Syntax/GreenNode').GreenNode {
  // Widths of the real BBCode this stands for: `[color=#RRGGBB]` and `[/color]`.
  const textLeaf = greenLeaf('text', text)
  return greenNode('color', `=${hex}`, [textLeaf], 8 + hex.length, 8)
}

describe('MergeableColorAnalyzer', () => {
  it('detects mergeable consecutive identical colors', () => {
    // [color=#FF0000]H[/color][color=#FF0000]e[/color][color=#FF0000]l[/color]
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'H'),
      colorNode('#FF0000', 'e'),
      colorNode('#FF0000', 'l'),
    ])

    const analyzer = new MergeableColorAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      kind: ContributionKind.Optimization,
      label: 'Merge Colors',
    })
  })

  it('does NOT report non-identical consecutive colors', () => {
    // [color=#FF0000]H[/color][color=#EE1100]e[/color][color=#DD2200]l[/color]
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'H'),
      colorNode('#EE1100', 'e'),
      colorNode('#DD2200', 'l'),
    ])

    const analyzer = new MergeableColorAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results).toHaveLength(0)
  })

  it('does NOT report single color nodes', () => {
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'H'),
    ])

    const analyzer = new MergeableColorAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results).toHaveLength(0)
  })

  it('detects multiple separate mergeable sequences', () => {
    // [color=#FF0000]A[/color][color=#FF0000]B[/color] --- [color=#00FF00]X[/color][color=#00FF00]Y[/color][color=#00FF00]Z[/color]
    const tree = greenNode('document', '', [
      colorNode('#FF0000', 'A'),
      colorNode('#FF0000', 'B'),
      colorNode('#00FF00', 'X'),
      colorNode('#00FF00', 'Y'),
      colorNode('#00FF00', 'Z'),
    ])

    const analyzer = new MergeableColorAnalyzer()
    const results = analyzer.run(tree, mockContext)

    expect(results).toHaveLength(2)
  })
})
