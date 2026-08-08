import { describe, it, expect } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { processStudioAST } from '@miliastry/quasar-studio'
import fs from 'fs'
import path from 'path'

describe('Problematic Section Export', () => {
  it('should not add an extra blank line or braille blank', () => {
    const text = fs.readFileSync(path.join(__dirname, '../problematic_section.milia'), 'utf-8')

    const layers = [
      { id: 'grad', type: 'gradient', enabled: true, value: 100, properties: { color1: '#ff0000', color2: '#0000ff' }, colors: '#e8b04b,#e8ae4b,#e7ad4b,#e7aa4b,#e7a84b,#e6a64b,#e6a14c,#e59f4c,#e4994c,#e3914c,#e28b4d,#e1854d,#e07c4d,#df754d,#de6f4e,#dd684e,#dc614e,#db5b4f,#da564f', opacity: 1.0, easing: 'linear' }
    ]

    const registry = new TagRegistry()
    const { redRoot } = processStudioAST(text, layers as any, {})
    
    const exporter = new BBCodeExporter(registry)
    const exportedBBCode = exporter.export(redRoot)

    const origBrailleCount = (text.match(/⠀/g) || []).length
    const expBrailleCount = (exportedBBCode.match(/⠀/g) || []).length

    console.log('Original Braille Blanks:', origBrailleCount)
    console.log('Exported Braille Blanks:', expBrailleCount)

    const expLines = exportedBBCode.split('\n')
    console.log('Last lines:', JSON.stringify(expLines.slice(-5), null, 2))
  })
})
