import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { RenderTree } from '../RenderPipeline/RenderTree'
import { RenderPipeline } from '../RenderPipeline/RenderPipeline'
import type { TagDefinition } from '../Model/TagRegistry'

/**
 * A plugin tag rendered through `toRenderNode`: what it copies from the
 * document into `style` or `class` is escaped and whitelisted, its children
 * render as real markup, and the canonical `visitChildren(node)` terminates.
 */

const neon: TagDefinition = {
  name: 'neon', kind: 'neon' as never, label: 'N', isInline: true, isSelfClosing: false, canHaveChildren: true,
  toRenderNode: ctx => ({
    kind: 'neon', text: '', props: {}, className: 'neon ' + ctx.node.text, style: { color: ctx.node.text.replace(/^=/, '') },
    children: ctx.node.children.map(c => ctx.renderChild(c)),
  }),
}

function model(source: string): BBCodeDocumentModel {
  const m = new BBCodeDocumentModel({ source })
  m.tagRegistry.register(neon)
  m.rebuild(source)
  return m
}

describe('the plugin render path', () => {
  it('a quote in the attribute cannot open a new one', () => {
    const m = model('[neon=red" onmouseover="alert(1)]x[/neon]')
    const html = new HTMLRenderer({ registry: m.tagRegistry, idMode: 'none' }).render(m.redRoot!)
    const host = document.createElement('div')
    host.innerHTML = html
    const el = host.querySelector('span[class^="neon"]')!
    expect(el.getAttribute('onmouseover')).toBeNull()
    expect([...el.attributes].every(a => a.name === 'class' || a.name === 'style')).toBe(true)
  })

  it('children render as markup, not as escaped text', () => {
    const m = model('[neon=red]hi [b]bold[/b][/neon]')
    const html = new HTMLRenderer({ registry: m.tagRegistry, idMode: 'none' }).render(m.redRoot!)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('style="color:red"')
  })

  it("the model's own toHTML goes through the handler", () => {
    const m = model('[neon=red]x[/neon]')
    expect(m.toHTML()).toContain('class="neon =red"')
  })

  it('style keys outside the whitelist, or values that load something, are dropped', () => {
    const html = RenderTree.toHTML({ kind: 'neon', text: '', props: {}, children: [], style: { position: 'fixed', backgroundColor: 'red', color: 'url(x)' } })
    expect(html).toBe('<span>' + '</span>')
  })

  it('visitChildren(node) in a RenderPipeline handler terminates', () => {
    const m = new BBCodeDocumentModel({ source: '' })
    m.tagRegistry.register({ ...neon, toRenderNode: ctx => RenderTree.text(ctx.visitChildren(ctx.node)) })
    m.rebuild('[neon]a[b]b[/b][/neon]')
    expect(() => new RenderPipeline().render(m.redRoot!, 'html', m.tagRegistry)).not.toThrow()
  })
})
