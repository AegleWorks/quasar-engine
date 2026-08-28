import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { MarkdownDocumentModel } from '../Markdown/MarkdownDocumentModel'
import { MarkdownExporter } from '../Visitors/MarkdownExporter'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

describe('Markdown & Hybrid BBCode Fidelity in Quasar', () => {
  const mdExporter = new MarkdownExporter()
  const bbExporter = new BBCodeExporter(undefined, 'osu')
  const htmlRenderer = new HTMLRenderer({ osuBehaviour: false })

  describe('Standard Markdown Formats', () => {
    it('round-trips bold and italic text', () => {
      const md = '**Bold text** and *italic text*'
      const mdDoc = MarkdownDocumentModel.fromMarkdown(md)
      const bbcode = bbExporter.export(mdDoc.redRoot!)
      expect(bbcode).toBe('[b]Bold text[/b] and [i]italic text[/i]')

      const bbDoc = new BBCodeDocumentModel({ source: bbcode })
      const reExportedMd = mdExporter.export(bbDoc.redRoot!)
      expect(reExportedMd).toBe('**Bold text** and *italic text*')
    })

    it('round-trips strikethrough without dropping text', () => {
      const md = 'This is ~~deleted text~~ right here.'
      const mdDoc = MarkdownDocumentModel.fromMarkdown(md)
      const bbcode = bbExporter.export(mdDoc.redRoot!)
      expect(bbcode).toBe('This is [s]deleted text[/s] right here.')

      const bbDoc = new BBCodeDocumentModel({ source: bbcode })
      const reExportedMd = mdExporter.export(bbDoc.redRoot!)
      expect(reExportedMd).toBe('This is ~~deleted text~~ right here.')
    })

    it('round-trips inline code', () => {
      const md = 'Use `const value = 42;` in your script'
      const mdDoc = MarkdownDocumentModel.fromMarkdown(md)
      const bbcode = bbExporter.export(mdDoc.redRoot!)
      expect(bbcode).toBe('Use [c]const value = 42;[/c] in your script')

      const bbDoc = new BBCodeDocumentModel({ source: bbcode })
      const reExportedMd = mdExporter.export(bbDoc.redRoot!)
      expect(reExportedMd).toBe('Use `const value = 42;` in your script')
    })

    it('round-trips spoiler (||)', () => {
      const md = 'Here is ||secret spoiler|| text'
      const mdDoc = MarkdownDocumentModel.fromMarkdown(md)
      const bbcode = bbExporter.export(mdDoc.redRoot!)
      expect(bbcode).toBe('Here is [spoiler]secret spoiler[/spoiler] text')

      const html = htmlRenderer.render(mdDoc.redRoot!)
      expect(html).toMatch(/<span[^>]*class="spoiler"[^>]*>secret spoiler<\/span>/)

      const bbDoc = new BBCodeDocumentModel({ source: bbcode })
      const reExportedMd = mdExporter.export(bbDoc.redRoot!)
      expect(reExportedMd).toBe('Here is ||secret spoiler|| text')
    })

    it('round-trips code block', () => {
      const md = '```ts\nfunction test() {\n  return true;\n}\n```'
      const mdDoc = MarkdownDocumentModel.fromMarkdown(md)
      const bbcode = bbExporter.export(mdDoc.redRoot!)
      expect(bbcode).toContain('[code]')
      expect(bbcode).toContain('function test()')

      const bbDoc = new BBCodeDocumentModel({ source: bbcode })
      const reExportedMd = mdExporter.export(bbDoc.redRoot!)
      expect(reExportedMd).toContain('```')
      expect(reExportedMd).toContain('function test()')
    })

    it('round-trips headings with levels', () => {
      const md = '# Main Title\n## Section Subtitle'
      const mdDoc = MarkdownDocumentModel.fromMarkdown(md)
      const bbcode = bbExporter.export(mdDoc.redRoot!)
      expect(bbcode).toContain('[heading=1]Main Title[/heading]')
      expect(bbcode).toContain('[heading=2]Section Subtitle[/heading]')
    })

    it('round-trips links and images cleanly', () => {
      const md = '[osu! Home](https://osu.ppy.sh)\n![Avatar](https://example.com/avatar.png)'
      const mdDoc = MarkdownDocumentModel.fromMarkdown(md)
      const bbcode = bbExporter.export(mdDoc.redRoot!)
      expect(bbcode).toContain('[url=https://osu.ppy.sh]osu! Home[/url]')
      expect(bbcode).toContain('[img]https://example.com/avatar.png[/img]')

      const bbDoc = new BBCodeDocumentModel({ source: bbcode })
      const reExportedMd = mdExporter.export(bbDoc.redRoot!)
      expect(reExportedMd).toContain('[osu! Home](https://osu.ppy.sh)')
      expect(reExportedMd).toContain('![Image](https://example.com/avatar.png)')
    })

    it('round-trips unordered and ordered lists', () => {
      const mdUnordered = '- Item 1\n- Item 2'
      const docUnordered = MarkdownDocumentModel.fromMarkdown(mdUnordered)
      const bbUnordered = bbExporter.export(docUnordered.redRoot!)
      expect(bbUnordered).toBe('[list][*]Item 1[*]Item 2[/list]')

      const mdOrdered = '1. First\n2. Second'
      const docOrdered = MarkdownDocumentModel.fromMarkdown(mdOrdered)
      const bbOrdered = bbExporter.export(docOrdered.redRoot!)
      expect(bbOrdered).toBe('[list=1][*]First[*]Second[/list]')
    })
  })

  describe('Hybrid Embedded BBCode in Markdown', () => {
    it('supports embedded [color] with Markdown formatting inside', () => {
      const hybrid = '[color=#ff0055]**Bold Red Text** and `code`[/color]'
      const doc = MarkdownDocumentModel.fromMarkdown(hybrid)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('style="color:#ff0055;"')
      expect(html).toMatch(/<strong[^>]*>Bold Red Text<\/strong>/)
      expect(html).toMatch(/<code[^>]*class="inline">code<\/code>/)

      const bbcode = bbExporter.export(doc.redRoot!)
      expect(bbcode).toBe('[color=#ff0055][b]Bold Red Text[/b] and [c]code[/c][/color]')

      const reExportedMd = mdExporter.export(new BBCodeDocumentModel({ source: bbcode }).redRoot!)
      expect(reExportedMd).toBe('[**Bold Red Text** and `code`]{#ff0055}')
    })

    it('supports embedded [u] (underline)', () => {
      const hybrid = 'Some [u]underlined text[/u] here'
      const doc = MarkdownDocumentModel.fromMarkdown(hybrid)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toMatch(/<u[^>]*>underlined text<\/u>/)

      const bbcode = bbExporter.export(doc.redRoot!)
      expect(bbcode).toBe('Some [u]underlined text[/u] here')

      const reExportedMd = mdExporter.export(new BBCodeDocumentModel({ source: bbcode }).redRoot!)
      expect(reExportedMd).toBe('Some ++underlined text++ here')
    })

    it('supports embedded [size] and [font]', () => {
      const hybrid = '[size=150][font=Tahoma]Big custom font[/font][/size]'
      const doc = MarkdownDocumentModel.fromMarkdown(hybrid)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('style="font-size:150%;"')
      expect(html).toContain('style="font-family:Tahoma;"')

      const bbcodeOsu = bbExporter.export(doc.redRoot!, 'osu')
      expect(bbcodeOsu).toBe('[size=150]Big custom font[/size]')

      const bbcodeMiliastry = bbExporter.export(doc.redRoot!, 'miliastry')
      expect(bbcodeMiliastry).toBe('[size=150][font=Tahoma]Big custom font[/font][/size]')
    })

    it('supports embedded [centre], [right], [left]', () => {
      const hybrid = '[centre]**Centered Header**\n[u]Link[/u][/centre]'
      const doc = MarkdownDocumentModel.fromMarkdown(hybrid)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('style="text-align:center;"')

      const bbcode = bbExporter.export(doc.redRoot!)
      expect(bbcode).toContain('[centre]')
      expect(bbcode).toContain('[b]Centered Header[/b]')
      expect(bbcode).toContain('[u]Link[/u]')
    })

    it('supports embedded [box] with Markdown content inside', () => {
      const hybrid = `[box=Mis Logros]
- **Top 1k** en 2024
- [u]Link al mapa[/u]: [Beatmap](https://osu.ppy.sh/b/123)
[/box]`

      const doc = MarkdownDocumentModel.fromMarkdown(hybrid)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('Mis Logros')
      expect(html).toMatch(/<strong[^>]*>Top 1k<\/strong>/)
      expect(html).toMatch(/<u[^>]*>Link al mapa<\/u>/)
      expect(html).toContain('href="https://osu.ppy.sh/b/123"')

      const bbcode = bbExporter.export(doc.redRoot!)
      expect(bbcode).toContain('[box=Mis Logros]')
      expect(bbcode).toContain('[list]')
      expect(bbcode).toContain('[b]Top 1k[/b]')
      expect(bbcode).toContain('[u]Link al mapa[/u]')
      expect(bbcode).toContain('[url=https://osu.ppy.sh/b/123]Beatmap[/url]')
      expect(bbcode).toContain('[/box]')
    })

    it('supports embedded [notice] and [wnotice]', () => {
      const hybrid = '[notice]\n**Important info** with [u]underline[/u]\n[/notice]'
      const doc = MarkdownDocumentModel.fromMarkdown(hybrid)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('class="notice"')
      expect(html).toMatch(/<strong[^>]*>Important info<\/strong>/)

      const bbcode = bbExporter.export(doc.redRoot!)
      expect(bbcode).toContain('[notice]')
      expect(bbcode).toContain('[b]Important info[/b]')
      expect(bbcode).toContain('[/notice]')

      const reExportedMd = mdExporter.export(new BBCodeDocumentModel({ source: bbcode }).redRoot!)
      expect(reExportedMd).toContain('[notice]')
      expect(reExportedMd).toContain('**Important info**')
      expect(reExportedMd).toContain('++underline++')
      expect(reExportedMd).toContain('[/notice]')
    })
  })

  describe('Modern Markdown Extensions & De-Facto Standards', () => {
    it('supports fenced container details (::: details Title ... :::)', () => {
      const md = '::: details Mis Logros\n- **Top 1k** en 2024\n:::'
      const doc = MarkdownDocumentModel.fromMarkdown(md)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('Mis Logros')
      expect(html).toMatch(/<strong[^>]*>Top 1k<\/strong>/)

      const bb = bbExporter.export(doc.redRoot!)
      expect(bb).toContain('[box=Mis Logros]')
      expect(bb).toContain('[b]Top 1k[/b]')
      expect(bb).toContain('[/box]')
    })

    it('supports fenced container alignment (::: center ... :::)', () => {
      const md = '::: center\nTexto centrado con estilo\n:::'
      const doc = MarkdownDocumentModel.fromMarkdown(md)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('style="text-align:center;"')

      const bb = bbExporter.export(doc.redRoot!)
      expect(bb).toBe('[centre]Texto centrado con estilo[/centre]')
    })

    it('supports CriticMarkup / markdown-it-ins underline (++text++)', () => {
      const md = 'Here is ++critic markup underline++ in text'
      const doc = MarkdownDocumentModel.fromMarkdown(md)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toMatch(/<u[^>]*>critic markup underline<\/u>/)

      const bb = bbExporter.export(doc.redRoot!)
      expect(bb).toBe('Here is [u]critic markup underline[/u] in text')
    })

    it('supports Pandoc attribute span underline ([text]{.underline})', () => {
      const md = 'Here is [pandoc underline]{.underline} in text'
      const doc = MarkdownDocumentModel.fromMarkdown(md)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toMatch(/<u[^>]*>pandoc underline<\/u>/)

      const bb = bbExporter.export(doc.redRoot!)
      expect(bb).toBe('Here is [u]pandoc underline[/u] in text')
    })

    it('supports generic attribute span color ([text]{color="#ff0055"} and [text]{#ff0055})', () => {
      const md1 = 'Here is [colored text]{color="#ff0055"} in text'
      const doc1 = MarkdownDocumentModel.fromMarkdown(md1)
      const html1 = htmlRenderer.render(doc1.redRoot!)
      expect(html1).toContain('style="color:#ff0055;"')
      expect(bbExporter.export(doc1.redRoot!)).toBe('Here is [color=#ff0055]colored text[/color] in text')

      const md2 = 'Here is [hex shorthand]{#00aaee} in text'
      const doc2 = MarkdownDocumentModel.fromMarkdown(md2)
      const html2 = htmlRenderer.render(doc2.redRoot!)
      expect(html2).toContain('style="color:#00aaee;"')
      expect(bbExporter.export(doc2.redRoot!)).toBe('Here is [color=#00aaee]hex shorthand[/color] in text')
    })

    it('supports generic attribute span size and font ([text]{size="150" font="Tahoma"})', () => {
      const md = 'Here is [custom styled text]{size="150" font="Tahoma"} in text'
      const doc = MarkdownDocumentModel.fromMarkdown(md)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('style="font-size:150%;"')
      expect(html).toContain('style="font-family:Tahoma;"')
    })

    it('supports arrow alignment (-> text <-)', () => {
      const md = '-> Centered text with arrows <-'
      const doc = MarkdownDocumentModel.fromMarkdown(md)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('style="text-align:center;"')

      const bb = bbExporter.export(doc.redRoot!)
      expect(bb).toBe('[centre]Centered text with arrows[/centre]')
    })

    it('supports Obsidian collapsible callouts (> [!note]- Title)', () => {
      const md = '> [!note]- Obsidian Secret Box\n> Hidden content inside'
      const doc = MarkdownDocumentModel.fromMarkdown(md)
      const html = htmlRenderer.render(doc.redRoot!)
      expect(html).toContain('Obsidian Secret Box')
      expect(html).toContain('Hidden content inside')

      const bb = bbExporter.export(doc.redRoot!)
      expect(bb).toContain('[box=Obsidian Secret Box]')
      expect(bb).toContain('Hidden content inside')
      expect(bb).toContain('[/box]')
    })

    it('supports blockquote author attribution (> **Author** and > **Author wrote:**)', () => {
      const md1 = '> **peppy**\n> This is a quote block with **formatting** inside'
      const doc1 = MarkdownDocumentModel.fromMarkdown(md1)
      const html1 = htmlRenderer.render(doc1.redRoot!)
      expect(html1).toContain('<strong>peppy wrote:</strong>')
      expect(html1).toMatch(/<strong[^>]*>formatting<\/strong>/)
      expect(bbExporter.export(doc1.redRoot!)).toBe('[quote="peppy"]This is a quote block with [b]formatting[/b] inside[/quote]')

      const md2 = '> **peppy wrote:**\n> Welcome to osu!'
      const doc2 = MarkdownDocumentModel.fromMarkdown(md2)
      const html2 = htmlRenderer.render(doc2.redRoot!)
      expect(html2).toContain('<strong>peppy wrote:</strong>')
      expect(html2).toContain('Welcome to osu!')
      expect(bbExporter.export(doc2.redRoot!)).toBe('[quote="peppy"]Welcome to osu![/quote]')
    })
  })
})
