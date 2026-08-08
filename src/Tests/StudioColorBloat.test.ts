import { describe, it, expect } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { processStudioAST } from '@miliastry/quasar-studio'

describe('Studio Effects Color Bloat', () => {
  it('should remove redundant outer color tags when a gradient is applied', () => {
    const text = "[color=#000000]Hello[/color]"

    const layers = [
      { id: 'grad', type: 'gradient', enabled: true, value: 100, properties: { color1: '#ff0000', color2: '#0000ff' }, colors: '#ff0000,#0000ff', opacity: 1.0, easing: 'linear' }
    ]

    const registry = new TagRegistry()
    const { redRoot } = processStudioAST(text, layers as any, {})
    
    const exporter = new BBCodeExporter(registry)
    const exportedBBCode = exporter.export(redRoot)

    // The output should NOT contain [color=#000000]
    expect(exportedBBCode).not.toContain('#000000')
    // It should ONLY contain the gradient colors
    expect(exportedBBCode).toContain('#ff0000')
  })
})
