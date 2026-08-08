import { describe, it, expect } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { processStudioAST } from '@miliastry/quasar-studio'
import fs from 'fs'
import path from 'path'

/**
 * A real 12 KB post from the wild, rendered with and without a Studio
 * gradient layer.
 *
 * This used to assert nothing at all: it rendered both variants and wrote
 * them to `orig.html` and `grad.html` in the repo root — tracked files, so
 * every test run dirtied the working tree, and no failure was possible. What
 * it should have been checking is below.
 */
describe('Problematic Section HTML Output', () => {
  const text = fs.readFileSync(path.join(__dirname, '../problematic_section.milia'), 'utf-8')

  const layers = [
    { id: 'grad', type: 'gradient', enabled: true, value: 100, properties: { color1: '#ff0000', color2: '#0000ff' }, colors: '#e8b04b,#e8ae4b,#e7ad4b,#e7aa4b,#e7a84b,#e6a64b,#e6a14c,#e59f4c,#e4994c,#e3914c,#e28b4d,#e1854d,#e07c4d,#df754d,#de6f4e,#dd684e,#dc614e,#db5b4f,#da564f', opacity: 1.0, easing: 'linear' }
  ]

  const render = (studioLayers: unknown[]) => {
    const registry = new TagRegistry()
    const renderer = new HTMLRenderer({ registry })
    const { redRoot } = processStudioAST(text, studioLayers as never, {})
    return renderer.render(redRoot)
  }

  it('renders the document without a gradient layer', () => {
    const html = render([])

    expect(html.length).toBeGreaterThan(1000)
    // Structure of the source survives to the output.
    expect(html).toContain('data-node-id')
    // No per-character colouring without a gradient layer.
    expect(html).not.toMatch(/color:\s*#e8b04b/i)
  })

  it('a gradient layer colours the text, and only the text', () => {
    const plain = render([])
    const gradient = render(layers)

    expect(gradient).not.toBe(plain)
    // The layer's own stops reach the output as inline colours.
    expect(gradient).toMatch(/color:\s*#e8b04b/i)
    // Colorear no puede cambiar el TEXTO, que es la invariante de verdad
    // (contar `data-node-id` no servía: el degradado parte el texto en un
    // nodo por carácter, así que el número cambia legítimamente).
    const texto = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    expect(texto(gradient)).toBe(texto(plain))
  })

  it('rendering is deterministic', () => {
    // Node ids come from a monotonic per-process counter, so two parses of
    // the same text legitimately number their nodes differently. Identity is
    // not content: strip it and the output must be identical.
    const withoutIds = (html: string) => html.replace(/ data-node-id="[^"]*"/g, '')
    expect(withoutIds(render(layers))).toBe(withoutIds(render(layers)))
  })
})
