import { describe, it, expect } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { processStudioAST } from '@miliastry/quasar-studio'

describe('Studio Effects Trailing Char Bug', () => {
  it('should not duplicate trailing braille blanks', () => {
    const text = "[notice]Hello⠀[/notice]"

    const layers = [
      { id: 'grad', type: 'gradient', enabled: true, value: 100, properties: { color1: '#ff0000', color2: '#0000ff' }, colors: '#ff0000,#0000ff', opacity: 1.0, easing: 'linear' }
    ]

    const registry = new TagRegistry()
    const { redRoot } = processStudioAST(text, layers as any, {})
    
    const exporter = new BBCodeExporter(registry)
    const exportedBBCode = exporter.export(redRoot)

    console.log("EXPORTED:", JSON.stringify(exportedBBCode))
    
    // Ensure we don't have an extra braille blank at the end
    expect(exportedBBCode.match(/⠀/g)?.length).toBe(1)
  })
})
