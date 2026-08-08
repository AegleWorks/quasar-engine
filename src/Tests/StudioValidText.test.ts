import { describe, it, expect } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { processStudioAST } from '@miliastry/quasar-studio'

describe('Studio Effects Valid Structure', () => {
  it('should not alter structure of valid bbcode', () => {
    const text = "[notice]\n  [box=Hello]\n    [centre]Content[/centre]\n  [/box]\n[/notice]"

    const layers = [
      { id: 'grad', type: 'gradient', active: true, value: 100, properties: { color1: '#ff0000', color2: '#0000ff' } }
    ]

    const registry = new TagRegistry()
    const { redRoot } = processStudioAST(text, layers as any, {})
    
    const exporter = new BBCodeExporter(registry)
    const exportedBBCode = exporter.export(redRoot)

    // Strip colors to verify exact match
    const stripped = exportedBBCode.replace(/\[\/?color[^\]]*\]/g, '')
    
    expect(stripped).toEqual(text)
  })
})
