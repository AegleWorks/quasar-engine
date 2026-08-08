import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { PluginAPI } from '../Plugins/PluginAPI'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import type { RedNode } from '../Syntax/RedNode'
import type { NodeKind } from '../Types/core'
import type { TagDefinition } from '../Model/TagRegistry'

/**
 * A plugin tag must live the FULL life of a tag: lex → parse → tree → render
 * → export → re-parse. Before `ParseOptions.extraTags`, a registered tag
 * could render and export but never parse — the parser turned it into
 * literal text, so the rest of the pipeline had nothing to work with. The
 * platform's plugin promise starts at the parser or it doesn't start.
 */

function findKind(root: RedNode, kind: string): RedNode | null {
  let found: RedNode | null = null
  root.walk(n => {
    if (!found && n.kind === kind) found = n
  })
  return found
}

const blurTag: TagDefinition = {
  name: 'blur',
  kind: 'blur' as NodeKind,
  label: 'Blur',
  category: 'text',
  isInline: true,
  isSelfClosing: false,
  canHaveChildren: true,
  toRenderNode: (ctx) => ({
    kind: 'blur',
    text: '',
    children: [{ kind: 'text', text: `⟦blur⟧${ctx.visitChildren(ctx.node)}⟦/blur⟧`, children: [], props: {} }],
    props: {},
  }),
}

const wiggleTag: TagDefinition = {
  name: 'wiggle',
  kind: 'wiggle' as NodeKind,
  label: 'Wiggle',
  isInline: true,
  isSelfClosing: false,
  canHaveChildren: true,
}

describe('plugin tags — full pipeline', () => {
  it('parses a registered tag as a real container, with attrs and nesting', () => {
    const model = new BBCodeDocumentModel({ source: '' })
    model.tagRegistry.register(blurTag)
    model.tagRegistry.register(wiggleTag)

    model.rebuild('hola [blur]mundo [b]fuerte[/b][/blur] y [wiggle=3]algo[/wiggle]')

    const blur = findKind(model.redRoot!, 'blur')!
    expect(blur).toBeTruthy()
    expect(findKind(blur, 'bold')).toBeTruthy() // nesting inside the plugin tag
    const wiggle = findKind(model.redRoot!, 'wiggle')!
    expect(wiggle.text).toBe('=3') // attrs preserved like any builtin

    // The tree still partitions the source: the plugin tag owns its delimiters.
    expect(blur.range.end - blur.range.start).toBe('[blur]mundo [b]fuerte[/b][/blur]'.length)
  })

  it('unregistered tags still fall to literal text — prose stays visible', () => {
    const model = new BBCodeDocumentModel({ source: 'combo de [90 misses] con [Gateron Yellow]' })
    expect(findKind(model.redRoot!, 'custom')).toBeNull()
    const html = new HTMLRenderer().render(model.redRoot!)
    expect(html).toContain('[90 misses]')
    expect(html).toContain('[Gateron Yellow]')
  })

  it('renders through the registry handler, and safely without it', () => {
    const model = new BBCodeDocumentModel({ source: '' })
    model.tagRegistry.register(blurTag)
    model.rebuild('[blur]contenido[/blur]')

    const withRegistry = new HTMLRenderer({ registry: model.tagRegistry }).render(model.redRoot!)
    expect(withRegistry).toContain('⟦blur⟧')
    expect(withRegistry).toContain('contenido')

    // Without the registry the wrapper is unknown, but content must survive.
    const bare = new HTMLRenderer().render(model.redRoot!)
    expect(bare).toContain('contenido')
  })

  it('exports under its registered name and round-trips', () => {
    const model = new BBCodeDocumentModel({ source: '' })
    model.tagRegistry.register(blurTag)
    model.tagRegistry.register(wiggleTag)
    const source = 'hola [blur]mundo[/blur] y [wiggle=3]algo[/wiggle]'
    model.rebuild(source)

    const exporter = new BBCodeExporter(model.tagRegistry)
    const exported = exporter.export(model.redRoot!)
    expect(exported).toBe(source)

    // Fixpoint: parsing the export reproduces the same export.
    model.rebuild(exported)
    expect(exporter.export(model.redRoot!)).toBe(exported)
  })

  it('works through PluginAPI, and unregistering returns the tag to prose', () => {
    const model = new BBCodeDocumentModel({ source: '' })
    const api = new PluginAPI(model)
    api.registerPlugin(
      { name: 'blur-plugin', version: '1.0.0' },
      { tags: [blurTag] },
    )

    model.rebuild('[blur]x[/blur]')
    expect(findKind(model.redRoot!, 'blur')).toBeTruthy()

    api.unregisterPlugin('blur-plugin')
    model.rebuild('[blur]x[/blur]')
    expect(findKind(model.redRoot!, 'blur')).toBeNull()
    // Back to what unknown tags always were: visible text.
    expect(new HTMLRenderer().render(model.redRoot!)).toContain('[blur]')
  })

  it('incremental editing with plugin tags matches a full rebuild', () => {
    let src = ''
    for (let i = 0; i < 60; i++) src += `parrafo ${i} con [blur]nucleo ${i}[/blur] normal\n\n`

    const reuse = new BBCodeDocumentModel({ source: '' })
    const control = new BBCodeDocumentModel({ source: '', incremental: false })
    reuse.tagRegistry.register(blurTag)
    control.tagRegistry.register(blurTag)
    reuse.rebuild(src)
    control.rebuild(src)

    const renderer = new HTMLRenderer()
    for (let edit = 0; edit < 30; edit++) {
      const at = (edit * 137) % (reuse.source.length - 10)
      const next = reuse.source.slice(0, at) + 'x' + reuse.source.slice(at)
      reuse.applyTextUpdate(next)
      control.applyTextUpdate(next)

      // Sin los ids: son identidades por modelo, y aquí hay dos modelos
      // independientes. Lo que debe coincidir es la estructura.
      const sinIds = (html: string) => html.replace(/ data-node-id="[^"]*"/g, '')
      expect(sinIds(renderer.render(reuse.redRoot!))).toBe(sinIds(renderer.render(control.redRoot!)))
      expect(reuse.redRoot!.green).toBe(reuse.greenRoot)
    }
  })
})
