import { describe, it } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { processStudioAST } from '@miliastry/quasar-studio'

describe('Studio Effects Debug Text', () => {
  it('should print exported BBCode for debugging', () => {
    const text = "Hello World\nTest\n\nDouble newline."

    const layers = [
      { id: 'grad', type: 'gradient', active: true, value: 100, properties: { color1: '#ff0000', color2: '#0000ff' } }
    ]

    const registry = new TagRegistry()
    const { redRoot } = processStudioAST(text, layers as any, {})
    
    const exporter = new BBCodeExporter(registry)
    const exportedBBCode = exporter.export(redRoot)

    console.log("================================")
    console.log("ORIGINAL TEXT:")
    console.log(JSON.stringify(text))
    console.log("EXPORTED BBCODE:")
    console.log(JSON.stringify(exportedBBCode))
    console.log("================================")
  })
})
