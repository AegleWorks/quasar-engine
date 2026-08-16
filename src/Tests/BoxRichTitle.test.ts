import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { MarkdownExporter } from '../Visitors/MarkdownExporter'

describe('Box & Spoilerbox Rich Title Support', () => {
  it('parses and renders images, colors, and bold formatting inside box title', () => {
    const source = `[box=[b][color=#efefef]▎[/color][/b]💛⠀[b][color=#efefef]Gifts from People (,,>﹏<,,)[/color][/b] [img]https://example.com/tja000.gif[/img][img]https://example.com/nyeee.gif[/img]]Body content[/box]`
    const model = new BBCodeDocumentModel({ source })
    const box = model.redRoot!.children.find(c => c.kind === 'box')!

    expect(box).toBeDefined()
    expect(box.metadata.rawTitle).toBe('[b][color=#efefef]▎[/color][/b]💛⠀[b][color=#efefef]Gifts from People (,,>﹏<,,)[/color][/b] [img]https://example.com/tja000.gif[/img][img]https://example.com/nyeee.gif[/img]')
    expect(box.metadata.title).toBe('▎💛⠀Gifts from People (,,>﹏<,,) https://example.com/tja000.gifhttps://example.com/nyeee.gif')

    const titleNodes = box.metadata.titleNodes as typeof box.children
    expect(titleNodes).toBeDefined()
    expect(titleNodes.length).toBeGreaterThan(0)

    // Check images in titleNodes
    const imageNodes = titleNodes.filter(n => n.kind === 'image')
    expect(imageNodes.length).toBe(2)
    expect(imageNodes[0].metadata.src).toBe('https://example.com/tja000.gif')
    expect(imageNodes[1].metadata.src).toBe('https://example.com/nyeee.gif')

    // Render HTML
    const renderer = new HTMLRenderer()
    const html = renderer.render(model.redRoot!)

    expect(html).toContain('<details')
    expect(html).toContain('class="box"')
    expect(html).toContain('<summary>')
    expect(html).toContain('style="color:#efefef;">▎</span>')
    expect(html).toContain('Gifts from People (,,&gt;﹏&lt;,,)')
    expect(html).toContain('<img')
    expect(html).toContain('src="https://example.com/tja000.gif"')
    expect(html).toContain('src="https://example.com/nyeee.gif"')
  })

  it('renders testforquasar fixture correctly', () => {
    const source = `[box=[b][color=#efefef]▎[/color][/b]💛⠀[b][color=#efefef]Gifts from People (,,>﹏<,,)[/color][/b] [img]https://blogger.googleusercontent.com/img/b/tja000.gif[/img][img]https://blogger.googleusercontent.com/img/b/nyeee.gif[/img][img]https://blogger.googleusercontent.com/img/b/vy_2.gif[/img]][color=#efefef]Thank you so much[/color][/box]`
    const model = new BBCodeDocumentModel({ source })
    const renderer = new HTMLRenderer()
    const html = renderer.render(model.redRoot!)

    expect(html).toContain('<summary>')
    expect(html).toContain('src="https://blogger.googleusercontent.com/img/b/tja000.gif"')
    expect(html).toContain('src="https://blogger.googleusercontent.com/img/b/nyeee.gif"')
    expect(html).toContain('src="https://blogger.googleusercontent.com/img/b/vy_2.gif"')
    expect(html).toContain('style="color:#efefef;">Thank you so much</span>')
  })

  it('renders testforquasar2 fixture correctly', () => {
    const source = `[box=[b][color=#ff4040][c]D[/c][/color][color=#ff9240][c]O[/c][/color][c] [/c][color=#ffe440][c]N[/c][/color][color=#c8ff40][c]O[/c][/color][color=#76ff40][c]T[/c][/color][c] [/c][color=#40ff5b][c]C[/c][/color][color=#40ffad][c]L[/c][/color][color=#40ffff][c]I[/c][/color][color=#40adff][c]C[/c][/color][color=#405bff][c]K[/c][/color][c] [/c][color=#7640ff][c]H[/c][/color][color=#c840ff][c]E[/c][/color][color=#ff40e4][c]R[/c][/color][color=#ff4092][c]E[/c][/color][/b]
][notice][size=200][color=#ccd7be]𝓹[/color][color=#bacef9]𝓮[/color][color=#f38fe2]𝓮[/color][color=#eea5b7]𝓴[/color] [color=#bcc4c7]𝓪[/color] [color=#9c85f1]𝓫[/color][color=#ccc793]𝓸[/color][color=#d390c9]𝓸[/color] [color=#d1abb8]>[/color][color=#bee1e8].[/color][color=#c4eefb]<[/color][/size]
[/notice]
[/box]`
    const model = new BBCodeDocumentModel({ source })
    const renderer = new HTMLRenderer()
    const html = renderer.render(model.redRoot!)

    expect(html).toContain('<details')
    expect(html).toContain('<summary>')
    expect(html).toContain('style="color:#ff4040;"><code')
    expect(html).toContain('>D</code>')
    expect(html).toContain('style="color:#ff9240;"><code')
    expect(html).toContain('>O</code>')
    expect(html).toContain('<div')
    expect(html).toContain('class="notice"')
    expect(html).toContain('style="font-size:200%;"')
    expect(html).toContain('𝓹')
  })

  it('preserves rich title during BBCode export', () => {
    const source = `[box=[b][color=#efefef]▎[/color][/b]💛⠀[img]https://example.com/tja000.gif[/img]]Content[/box]`
    const model = new BBCodeDocumentModel({ source })
    const exporter = new BBCodeExporter()
    const exported = exporter.export(model.redRoot!)

    expect(exported).toContain('[box=[b][color=#efefef]▎[/color][/b]💛⠀[img]https://example.com/tja000.gif[/img]]')
  })

  it('exports rich title to Markdown', () => {
    const source = `[box=[b]Bold Title[/b]]Content[/box]`
    const model = new BBCodeDocumentModel({ source })
    const exporter = new MarkdownExporter()
    const exported = exporter.export(model.redRoot!)

    expect(exported).toContain('**Bold Title**')
  })

  it('allows offset lookups inside the rich title', () => {
    const source = `[box=[img]https://example.com/tja000.gif[/img]]Content[/box]`
    const model = new BBCodeDocumentModel({ source })
    const box = model.redRoot!.children.find(c => c.kind === 'box')!
    const imageNode = (box.metadata.titleNodes as typeof box.children)[0]

    expect(imageNode.kind === 'image').toBe(true)
    // Offset inside [img]...[/img] should locate the image node
    const found = model.redRoot!.findNodeAtOffset(10)
    expect(found).toBeDefined()
    expect(found?.kind === 'text' || found?.kind === 'image').toBe(true)
  })
})
