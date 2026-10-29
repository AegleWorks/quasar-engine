import { describe, it, expect } from 'vitest'
import { MilHibriDocumentModel, prefersOsuBBCode, usesBBCodeStructure } from '../MilHibri/MilHibriDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

const osuRenderer = new HTMLRenderer({ dialect: 'osu', theme: 'osu' })
const osuExporter = new BBCodeExporter(undefined, 'osu')

function render(source: string): string {
  const doc = MilHibriDocumentModel.fromSource(source)
  return doc.redRoot ? osuRenderer.render(doc.redRoot) : ''
}

/** Ids are per-tree bookkeeping; the shape is what these tests are about. */
function shape(html: string): string {
  return html.replace(/ data-node-id="[^"]*"/g, '')
}

describe('MilHibri — pure osu! BBCode uses the BBCode engine', () => {
  it('classifies only documents without Markdown extensions as pure BBCode', () => {
    expect(prefersOsuBBCode('[centre][b]LIVES[/b][/centre]')).toBe(true)
    expect(prefersOsuBBCode('[box=]\nhello\n[/box]')).toBe(true)

    expect(prefersOsuBBCode('# Heading\n[b]bold[/b]')).toBe(false)
    expect(prefersOsuBBCode('A [Beatmap](https://osu.ppy.sh/b/1) and [b]bold[/b]')).toBe(false)
    expect(prefersOsuBBCode('[neon]x[/neon]')).toBe(false)
  })

  it('borrows the osu! autolink for plain prose, but leaves Markdown structure alone', () => {
    expect(prefersOsuBBCode('playing this game: https://rhythmtyper.net/')).toBe(true)
    expect(prefersOsuBBCode('- a Markdown list')).toBe(false)
    expect(prefersOsuBBCode('*Markdown emphasis*')).toBe(false)

    const html = shape(render('playing this game: https://rhythmtyper.net/'))
    expect(html).toContain('<a href="https://rhythmtyper.net/" rel="nofollow">https://rhythmtyper.net/</a>')
  })

  it('keeps a BBCode document on the BBCode engine for inline and block Markdown', () => {
    expect(usesBBCodeStructure('[box=T]\n**bold**\n[/box]')).toBe(true)
    expect(usesBBCodeStructure('# Heading\n[box=T]x[/box]')).toBe(true)
    expect(usesBBCodeStructure('[neon]x[/neon] **bold**')).toBe(false)
  })

  it('renders `[box=]` with an empty title, as osu! publishes it', () => {
    const html = shape(render('[box=]\nhello\n[/box]'))

    expect(html).toContain('<span class="bbcode-spoilerbox__link-text"></span>')
    expect(html).not.toContain('SPOILER')
    expect(html).toContain('hello')
  })

  it('keeps a long hyphen line literal instead of turning it into a Markdown rule', () => {
    const html = shape(render('[centre]\n--------------------\n[/centre]'))

    expect(html).toContain('--------------------')
    expect(html).not.toContain('<hr')
  })

  it('drops a crossed closer that osu! seals and discards', () => {
    const html = shape(render('[centre][b]LIVES[/centre][/b]'))

    expect(html).toContain('<strong>LIVES</strong>')
    expect(html).not.toContain('[/b]')
  })

  it('renders a Markdown heading alongside BBCode inline tags', () => {
    const html = shape(render('# Heading\n[b]bold[/b]'))

    expect(html).toContain('<h2 data-bare-level="1">Heading</h2>')
    expect(html).toContain('<strong>bold</strong>')
  })
})

describe('MilHibri — BBCode structure with Markdown inline prose', () => {
  it('keeps nested osu blocks and translates inline Markdown inside them', () => {
    const source = `[centre]
[notice]
[box=[color=#ff0000]Title[/color]]
**strong** and *literal asterisks* and [size=85](2023 - Now)[/size]
[/box]
[/notice]
[/centre]`
    const html = shape(render(source))

    expect(html).toContain('class="bbcode__align-centre"')
    expect(html).toContain('class="well"')
    expect(html).toContain('style="color:#ff0000;">Title</span>')
    expect(html).toContain('<strong>strong</strong>')
    expect(html).toContain('*literal asterisks*')
    expect(html).toContain('<span style="font-size:85%;">(2023 - Now)</span>')
    expect(html).not.toContain('[color=')
    expect(html).not.toContain('[/size]')
    expect(html).not.toContain('href="2023')
  })

  it('keeps Markdown links, images and inline code available inside BBCode', () => {
    const html = shape(render('[b]bold[/b] [Beatmap](https://osu.ppy.sh/b/1), ![cover](https://example.com/c.png) and **strong**'))

    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('href="https://osu.ppy.sh/b/1"')
    expect(html).toContain('>Beatmap</a>')
    expect(html).toContain('src="https://example.com/c.png"')
    expect(html).toContain('<strong>strong</strong>')
  })

  it('does not turn decorative runs into empty emphasis', () => {
    const html = shape(render('[centre]~~~~~~~~ and C++ and O3C++[/centre]'))

    expect(html).toContain('~~~~~~~~')
    expect(html).toContain('C++')
    expect(html).toContain('O3C++')
    expect(html).not.toContain('<s>')
    expect(html).not.toContain('<u>')
  })

  it('leaves underscores literal in a BBCode text run', () => {
    const html = shape(render('[b]__init__ and _type_[/b]'))

    expect(html).toContain('__init__ and _type_')
    expect(html).not.toContain('<strong>init</strong>')
    expect(html).not.toContain('<em>type</em>')
  })

  it('does not translate Markdown inside literal BBCode bodies', () => {
    const source = '[code]**not bold**[/code]\n[c]_not italic_[/c]\n[img]https://example.com/a_b_c.png[/img]'
    const html = shape(render(source))

    expect(html).toContain('<code>**not bold**</code>')
    expect(html).toContain('<code>_not italic_</code>')
    expect(html).toContain('src="https://example.com/a_b_c.png"')
    expect(html).not.toContain('<strong>not bold</strong>')
    expect(html).not.toContain('<em>not italic</em>')
  })

  it('exports the translated inline nodes as BBCode', () => {
    const doc = MilHibriDocumentModel.fromSource('[box=T]\n**strong** and [Beatmap](https://osu.ppy.sh/b/1)\n[/box]')
    const bb = osuExporter.export(doc.redRoot!)

    expect(bb).toContain('[box=T]')
    expect(bb).toContain('[b]strong[/b]')
    expect(bb).toContain('[url=https://osu.ppy.sh/b/1]Beatmap[/url]')
  })
})

describe('MilHibri — Markdown blocks inside BBCode structure', () => {
  it('nests a heading inside a box without losing the box', () => {
    const html = shape(render('[box=Nested]\n# Heading\n**bold**\n[/box]'))

    expect(html).toContain('>Nested<')
    expect(html).toContain('<h2 data-bare-level="1">Heading</h2>')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('nests a fence inside a notice and keeps its body literal', () => {
    const source = '[notice]\n```ts\n# not a heading\n**not bold**\n```\n[/notice]'
    const html = shape(render(source))

    expect(html).toContain('class="well"')
    expect(html).toContain('# not a heading')
    expect(html).toContain('**not bold**')
    expect(html).not.toContain('<h2')
    expect(html).not.toContain('<strong>not bold</strong>')
  })

  it('nests a quote inside a box', () => {
    const html = shape(render('[box=Q]\n> quoted **bold**\n[/box]'))

    expect(html).toContain('>Q<')
    expect(html).toContain('quoted <strong>bold</strong>')
    expect(html).not.toContain('&gt;')
  })

  it('nests a ::: container inside a notice', () => {
    const source = '[notice]\n::: details More\ninside **strong**\n:::\n[/notice]'
    const html = shape(render(source))

    expect(html).toContain('class="well"')
    expect(html).toContain('More')
    expect(html).toContain('inside <strong>strong</strong>')
  })

  it('turns a Markdown arrow line into a BBCode alignment block', () => {
    const html = shape(render('[box=A]\n-> centred **bold** <-\n[/box]'))

    expect(html).toContain('class="bbcode__align-centre"')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('does not rewrite Markdown block markers inside a literal code body', () => {
    const source = '[code]\n# not a heading\n> not a quote\n[/code]'
    const html = shape(render(source))

    expect(html).toContain('# not a heading')
    expect(html).toContain('&gt; not a quote')
    expect(html).not.toContain('<h2')
    expect(html).not.toContain('<blockquote')
  })

  it('converts a Markdown list once the document declares a Markdown block', () => {
    const html = shape(render('[box=L]\n# Heading\n- one\n- two\n  - nested\n[/box]'))

    expect(html).toContain('<h2 data-bare-level="1">Heading</h2>')
    expect(html).toContain('<ul')
    expect(html).toContain('<li')
    expect(html).toContain('nested')
  })

  it('converts ordered lists and lists inside a Markdown container', () => {
    const html = shape(render('[notice]\n::: details More\n1. first\n2. second\n:::\n[/notice]'))

    expect(html).toContain('class="well"')
    expect(html).toContain('<ol')
    expect(html).toContain('first')
    expect(html).toContain('second')
  })

  it('leaves a bare dash line literal in a pasted osu! page', () => {
    const html = shape(render('[box=L]\n- one\n- two\n[/box]'))

    expect(html).toContain('- one')
    expect(html).toContain('- two')
    expect(html).not.toContain('<ul')
  })

  it('converts a fence inside a Markdown list item', () => {
    const source = '[box=L]\n# Heading\n- item\n  ```ts\n  const a = 1\n  ```\n[/box]'
    const html = shape(render(source))

    expect(html).toContain('<h2 data-bare-level="1">Heading</h2>')
    expect(html).toContain('<pre')
    expect(html).toContain('const a = 1')
    expect(html).not.toContain('```')
  })

  it('converts a quote whose fence carries the > prefixes', () => {
    const source = '[box=Q]\n> author\n> quote\n>\n> ```ts\n> const a = 1\n> ```\n[/box]'
    const html = shape(render(source))

    expect(html).toContain('<blockquote')
    expect(html).toContain('<pre')
    expect(html).toContain('const a = 1')
    expect(html).not.toContain('```')
  })

  it('moves a Markdown quote author into the BBCode quote attribute', () => {
    const doc = MilHibriDocumentModel.fromSource('[box=Q]\n> **peppy**\n> quote **bold**\n[/box]')
    const html = shape(osuRenderer.render(doc.redRoot!))

    expect(html).toContain('<strong>peppy wrote:</strong>')
    expect(html).toContain('quote <strong>bold</strong>')
    expect(html).not.toContain('<strong>peppy</strong>')
    expect(osuExporter.export(doc.redRoot!)).toContain('[quote="peppy"]')
  })

  it('maps Markdown callouts to notices and collapsible spoilerboxes', () => {
    const notice = shape(render('[box=N]\n> [!NOTE]\n> body **bold**\n[/box]'))
    expect(notice).toContain('class="well"')
    expect(notice).toContain('body <strong>bold</strong>')
    expect(notice).not.toContain('[!NOTE]')

    const details = shape(render('[box=D]\n> [!NOTE]- More\n> inside\n[/box]'))
    expect(details).toContain('>More<')
    expect(details).toContain('inside')
    expect(details).not.toContain('[!NOTE]')
  })

  it('maps a ::: quote with an author to an osu-quoted opener', () => {
    const doc = MilHibriDocumentModel.fromSource('[box=Q]\n::: quote peppy\nquoted\n:::\n[/box]')
    const html = shape(osuRenderer.render(doc.redRoot!))

    expect(html).toContain('<strong>peppy wrote:</strong>')
    expect(html).toContain('quoted')
    expect(osuExporter.export(doc.redRoot!)).toContain('[quote="peppy"]')
  })
})
