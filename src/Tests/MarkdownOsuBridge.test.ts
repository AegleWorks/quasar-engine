import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { MarkdownExporter } from '../Visitors/MarkdownExporter'
import { MarkdownDocumentModel } from '../Markdown/MarkdownDocumentModel'
import { convertMarkdownToOsu } from '../Markdown/MarkdownToOsu'
import { exportPortableMarkdown } from '../Visitors/PortableMarkdownExporter'

const osuModel = (source: string) =>
  new BBCodeDocumentModel({ source, dialect: 'osu', incremental: false, autoAnalyze: false })
const bb = (md: string) => convertMarkdownToOsu(md).bbcode
const lossKinds = (md: string) => convertMarkdownToOsu(md).losses.map((l) => l.kind)
const render = (source: string) =>
  new HTMLRenderer({ dialect: 'osu', theme: 'osu' }).render(
    new BBCodeDocumentModel({ source, dialect: 'osu', pairing: 'osu', incremental: false, autoAnalyze: false }).redRoot!,
  )
const portable = (source: string) => exportPortableMarkdown(osuModel(source).redRoot!)
const errors = (source: string) => {
  const model = osuModel(source)
  if (!model.redRoot) return []
  return model.analyze().diagnostics.items.filter((d) => d.severity === 'error')
}

/** Visible blank lines between two pieces of text, as osu! renders them. */
function blankBetween(html: string, a: string, b: string): number {
  const from = html.indexOf(a)
  const to = html.indexOf(b, from + a.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return (html.slice(from, to).match(/bb-empty-line/g) ?? []).length
}

describe('Markdown -> osu!: probe cases', () => {
  it('nests lists three levels deep', () => {
    const out = bb('- one\n- two\n  - nested\n    - deep\n  - back\n- three')
    expect(out).toBe(
      '[list]\n[*]one\n[*]two\n[list]\n[*]nested\n[list]\n[*]deep\n[/list]\n[*]back\n[/list]\n[*]three\n[/list]',
    )
    expect(out).not.toContain('  - ')
  })

  it('keeps ordered and mixed nesting', () => {
    const out = bb('1. a\n   - b\n   - c\n2. d')
    expect(out).toBe('[list=1]\n[*]a\n[list]\n[*]b\n[*]c\n[/list]\n[*]d\n[/list]')
  })

  it('turns a table into an aligned code block and reports it', () => {
    const r = convertMarkdownToOsu('| name | n |\n|:-----|--:|\n| 日本語 | 1 |\n| café | 22 |')
    expect(r.bbcode).toBe(
      '[code]| name   |   n |\n| :----- | --: |\n| 日本語 |   1 |\n| café   |  22 |[/code]',
    )
    expect(r.losses).toEqual([{ kind: 'table', count: 1, sample: 'name | n' }])
  })

  it('turns <br> into a newline, other html into text with a loss', () => {
    expect(bb('one<br>two')).toBe('one\ntwo')
    expect(bb('a<br/>b')).toBe('a\nb')
    const r = convertMarkdownToOsu('<span style="x">hi</span> there')
    expect(r.bbcode).toBe('hi there')
    expect(r.losses.find((l) => l.kind === 'html')?.count).toBe(2)
  })

  it('maps simple html formatting without a loss', () => {
    const r = convertMarkdownToOsu('<u>under</u> and <b>bold</b>')
    expect(r.bbcode).toBe('[u]under[/u] and [b]bold[/b]')
    expect(r.losses).toEqual([])
  })

  it('drops a thematic break and reports it', () => {
    const r = convertMarkdownToOsu('above\n\n---\n\nbelow')
    expect(r.bbcode).toBe('above\n\nbelow')
    expect(r.losses).toEqual([{ kind: 'thematic-break', count: 1 }])
    expect(lossKinds('***\n\n___')).toEqual(['thematic-break'])
  })

  it('separates consecutive blocks', () => {
    expect(bb('# A\n\n# B')).toBe('[heading]A[/heading]\n\n[heading]B[/heading]')
    expect(bb('- a\n\n1. b\n\nLine one')).toBe('[list]\n[*]a\n[/list]\n\n\n[list=1]\n[*]b\n[/list]\n\n\nLine one')
  })

  it('does not treat standard text as the MilHibri dialect', () => {
    expect(bb('a -> b || c {#fff} [b]')).toBe(`a -> b || c {#fff} [${'​'}b]`)
  })
})

describe('Markdown -> osu!: inline and blocks', () => {
  it('handles emphasis, strike, links, images and code', () => {
    expect(bb('**b** *i* ~~s~~ _u_ ***both***')).toBe('[b]b[/b] [i]i[/i] [s]s[/s] [i]u[/i] [i][b]both[/b][/i]')
    expect(bb('[x](https://a.b/c "t")')).toBe('[url=https://a.b/c]x[/url]')
    expect(bb('![alt](https://i/x.png)')).toBe('[img]https://i/x.png[/img]')
    expect(bb('[![b](https://i/x.png)](https://a.b)')).toBe('[url=https://a.b][img]https://i/x.png[/img][/url]')
    expect(bb('[mail](mailto:a@b.c)')).toBe('[email=a@b.c]mail[/email]')
    expect(bb('snake_case_word and 2*3*4')).toBe('snake_case_word and 2[i]3[/i]4')
  })

  it('wraps bare urls so a closing tag cannot be autolinked with them', () => {
    expect(bb('**https://a.b/c**')).toBe('[b][url]https://a.b/c[/url][/b]')
    expect(bb('see <https://a.b>, and https://x.y/z.')).toBe('see [url]https://a.b[/url], and [url]https://x.y/z[/url].')
  })

  it('reports links osu! cannot follow', () => {
    const r = convertMarkdownToOsu('[top](#top) [js](javascript:alert(1)) ![l](pic.png)')
    expect(r.bbcode).toBe('top js l')
    expect(r.losses.map((l) => l.kind).sort()).toEqual(['relative-image', 'relative-link', 'unsafe-link'])
  })

  it('handles inline code with backticks', () => {
    expect(bb('use `a``b` and ``x ` y``')).toBe('use [c]a``b[/c] and [c]x ` y[/c]')
  })

  it('writes code fences without the language, keeping blank lines', () => {
    expect(bb('```ts\nconst a = 1\n\nconst b = [/code]\n```')).toBe(
      `[code]const a = 1\n\nconst b = [${'​'}/code][/code]`,
    )
    expect(bb('    indented\n    code')).toBe('[code]indented\ncode[/code]')
  })

  it('writes quotes, nested quotes and alerts', () => {
    expect(bb('> a\n> b\n>\n> > inner')).toBe('[quote]a\nb\n\n[quote]inner[/quote][/quote]')
    expect(bb('> [!WARNING]\n> careful')).toBe('[notice][b]Warning[/b]\ncareful[/notice]')
  })

  it('writes task lists', () => {
    expect(bb('- [ ] todo\n- [x] done')).toBe('[list]\n[*]☐ todo\n[*]☑ done\n[/list]')
  })

  it('keeps every line break, as GitHub comments and Discord do', () => {
    expect(bb('a\nb')).toBe('a\nb')
    expect(bb('a \nb')).toBe('a\nb')
    expect(bb('a  \nb')).toBe('a\nb')
    expect(bb('a\\\nb')).toBe('a\nb')
  })

  it('neutralises literal bbcode and reports it', () => {
    const r = convertMarkdownToOsu('write \\[b\\]x\\[/b\\] literally')
    expect(r.bbcode).toBe(`write [${'​'}b]x[${'​'}/b] literally`)
    expect(r.losses.map((l) => l.kind)).toEqual(['bbcode-literal'])
    expect(osuModel(r.bbcode).redRoot!.children.some((c) => c.kind === 'bold')).toBe(false)
  })

  it('reports footnotes, comments, front matter and list starts', () => {
    const r = convertMarkdownToOsu('---\ntitle: x\n---\nText[^1] <!-- hidden -->\n\n[^1]: The note\n\n3. three')
    expect(r.losses.map((l) => l.kind).sort()).toEqual(['footnote', 'front-matter', 'html-comment', 'list-start'])
    expect(r.losses.find((l) => l.kind === 'footnote')?.count).toBe(2)
    expect(r.bbcode).not.toContain('hidden')
  })

  it('resolves reference links', () => {
    expect(bb('[site][a] and [b]\n\n[a]: https://a.b\n[b]: <https://c.d>')).toBe(
      '[url=https://a.b]site[/url] and [url=https://c.d]b[/url]',
    )
  })

  it('splits formatting around hard breaks', () => {
    expect(bb('**a  \nb**')).toBe('[b]a[/b]\n[b]b[/b]')
  })

  it('never throws and respects nesting depth', () => {
    const inputs = [
      '', '\0\0', '[', ']()', '![', '`', '```', '> '.repeat(500) + 'x', '- '.repeat(500) + 'x',
      '*'.repeat(5000), '*a '.repeat(3000), '[a]('.repeat(2000), '<'.repeat(100), '&#99999999;',
      '| a |\n|---|\n'.repeat(3), '**'.repeat(600) + 'x' + '**'.repeat(600),
    ]
    for (const input of inputs) {
      const r = convertMarkdownToOsu(input)
      expect(typeof r.bbcode).toBe('string')
      expect(errors(r.bbcode)).toEqual([])
    }
    const deep = convertMarkdownToOsu('> '.repeat(300) + 'x').bbcode
    expect(osuModel(deep).analyze().diagnostics.items.some((d) => d.code === 'nesting-too-deep')).toBe(false)
  })
})

describe('Markdown -> osu!: how osu! renders the blocks', () => {
  const kinds: Array<[string, string]> = [
    ['paragraph', 'PARA'],
    ['heading', '# HEAD'],
    ['code', '```\nCODE\n```'],
    ['list', '- LIST'],
    ['quote', '> QUOTE'],
    ['notice', '> [!NOTE]\n> NOTICE'],
  ]
  for (const [a, mdA] of kinds) {
    for (const [b, mdB] of kinds) {
      // Two adjacent lists with the same marker are one list in Markdown.
      if (a === 'list' && b === 'list') continue
      it(`leaves exactly one blank line between ${a} and ${b}`, () => {
        const source = bb(`${mdA}\n\n${mdB}`)
        const html = render(source)
        const A = mdA.includes('NOTICE') ? 'NOTICE' : mdA.replace(/[#`>\-\[\]!\n ]/g, '').replace('NOTE', '')
        const B = mdB.includes('NOTICE') ? 'NOTICE' : mdB.replace(/[#`>\-\[\]!\n ]/g, '').replace('NOTE', '')
        expect(blankBetween(html, A, B)).toBe(1)
      })
    }
  }

  it('renders a nested list as a nested list element', () => {
    const html = render(bb('- one\n- two\n  - nested\n    - deep'))
    expect((html.match(/<ul/g) ?? []).length).toBe(3)
    expect(html).not.toContain('[list]')
    expect(html).not.toContain('[*]')
  })

  it('renders the realistic page without leftover tags or empty lines', () => {
    const html = render(bb(PAGE_MD))
    expect(html).not.toMatch(/\[\/?(?:b|i|list|quote|code|heading|url|img|notice)[\]=]/)
    expect(html).toContain('<h2')
    expect(html).toContain('<blockquote')
  })
})

describe('Markdown -> osu!: diagnostics', () => {
  it('produces no error-severity diagnostics for a realistic page', () => {
    const r = convertMarkdownToOsu(PAGE_MD)
    expect(errors(r.bbcode)).toEqual([])
    expect(r.losses.map((l) => l.kind).sort()).toEqual(['html-comment', 'table', 'thematic-break'])
  })
})

const PAGE_MD = `# peppy-fan

Hi, I play **osu!standard** since 2014. Peak *#1200* in my country.
Find me on [Twitter](https://twitter.com/x) or https://discord.gg/abc.

---

## Setup

| Part | Model |
|------|-------|
| Mouse | Logitech G Pro |
| Tablet | Wacom CTL-472 |

- [x] 5 digit
- [ ] 4 digit
  - maybe next year
    1. practice
    2. patience

> "Aim is just muscle memory."
> -- someone

\`\`\`
cursor: 400
sens: 1.2
\`\`\`

![banner](https://i.imgur.com/abc.png)

<!-- todo: add skin -->
Skin: \`Aristia\` by <u>Rafis</u><br>
Thanks for reading!
`

describe('osu! -> portable Markdown', () => {
  const md = (s: string) => portable(s).markdown
  const kinds = (s: string) => portable(s).losses.map((l) => l.kind)

  it('maps inline formatting', () => {
    expect(md('[b]b[/b] [i]i[/i] [s]s[/s] [strike]t[/strike]')).toBe('**b** *i* ~~s~~ ~~t~~')
    expect(md('[b] spaced [/b]')).toBe(' **spaced** '.trim())
  })

  it('reports tags with no equivalent and keeps their text', () => {
    const cases: Array<[string, string, string]> = [
      ['[u]x[/u]', 'underline', 'x'],
      ['[color=red]x[/color]', 'color', 'x'],
      ['[size=150]x[/size]', 'size', 'x'],
      ['[spoiler]x[/spoiler]', 'spoiler', 'x'],
      ['[centre]x[/centre]', 'alignment', 'x'],
      ['[box=T]x[/box]', 'collapsible', '**T**\n\nx'],
      ['[spoilerbox]x[/spoilerbox]', 'collapsible', '**Spoiler**\n\nx'],
    ]
    for (const [src, kind, text] of cases) {
      const r = portable(src)
      expect(r.markdown).toBe(text)
      expect(r.losses.map((l) => l.kind)).toEqual([kind])
      expect(r.losses[0].count).toBe(1)
    }
  })

  it('aggregates losses per kind with a sample', () => {
    const r = portable('[u]one[/u] and [u]two[/u]')
    expect(r.losses).toEqual([{ kind: 'underline', count: 2, sample: 'one' }])
  })

  it('writes headings, links, mail and profiles', () => {
    expect(md('[heading]Title[/heading]\ntext')).toBe('## Title\n\ntext')
    expect(md('[url=https://x.y]lbl[/url]')).toBe('[lbl](https://x.y)')
    expect(md('[url]https://x.y/a[/url]')).toBe('https://x.y/a')
    expect(md('[email=a@b.c]mail[/email]')).toBe('[mail](mailto:a@b.c)')
    expect(md('[profile=123]Name[/profile]')).toBe('[Name](https://osu.ppy.sh/users/123)')
    expect(md('[profile]Some One[/profile]')).toBe('[Some One](https://osu.ppy.sh/users/Some%20One)')
  })

  it('writes media', () => {
    expect(md('[img]https://i/x.png[/img]')).toBe('![](https://i/x.png)')
    expect(md('[youtube]dQw4w9WgXcQ[/youtube]')).toBe('https://youtu.be/dQw4w9WgXcQ')
    expect(md('[audio]https://a/b.mp3[/audio]')).toBe('[audio](https://a/b.mp3)')
    expect(portable('[audio]https://a/b.mp3[/audio]').losses).toEqual([])
  })

  it('writes an imagemap as an image plus a link list', () => {
    const r = portable('[imagemap]\nhttps://i/x.png\n10 10 20 20 https://l.com Title\n0 0 5 5 https://m.com Other\n[/imagemap]')
    expect(r.markdown).toBe('![](https://i/x.png)\n\n- [Title](https://l.com)\n- [Other](https://m.com)')
    expect(r.losses.map((l) => l.kind)).toEqual(['imagemap'])
  })

  it('indents nested lists, three levels, ordered and unordered', () => {
    const src = '[list]\n[*]one\n[*]two\n[list=1]\n[*]a\n[list]\n[*]deep\n[/list]\n[*]b\n[/list]\n[*]three\n[/list]'
    expect(md(src)).toBe('- one\n- two\n  1. a\n     - deep\n  2. b\n- three')
  })

  it('writes quotes with a source, and notices as quotes', () => {
    expect(md('[quote="Bob"]hi\nthere[/quote]')).toBe('> **Bob wrote:**\n>\n> hi  \n> there')
    expect(md('[quote]plain[/quote]')).toBe('> plain')
    expect(md('[notice]heads up[/notice]')).toBe('> heads up')
    expect(kinds('[notice]x[/notice]')).toEqual([])
    expect(md('[quote=A][quote=B]in[/quote][/quote]')).toBe('> **A wrote:**\n>\n> > **B wrote:**\n> >\n> > in')
  })

  it('chooses a fence longer than any backtick run', () => {
    expect(md('[code]a ``` b[/code]')).toBe('````\na ``` b\n````')
    expect(md('[code]plain\n\nx[/code]')).toBe('```\nplain\n\nx\n```')
  })

  it('handles backticks in inline code', () => {
    expect(md('[c]a`b[/c]')).toBe('``a`b``')
    expect(md('[c]`x`[/c]')).toBe('`` `x` ``')
    expect(md('[c]plain[/c]')).toBe('`plain`')
  })

  it('escapes Markdown-significant text', () => {
    expect(md('2*3*4 and snake_case and _x_ and [link] and <b>')).toBe('2\\*3\\*4 and snake_case and \\_x\\_ and \\[link\\] and \\<b>')
    expect(md('# nope\n1. nope\n- nope')).toBe('\\# nope  \n1\\. nope  \n\\- nope')
    expect(md('see https://a.b/x_y_z ok')).toBe('see https://a.b/x_y_z ok')
  })

  it('maps line breaks and paragraph breaks', () => {
    expect(md('a\nb\n\nc')).toBe('a  \nb\n\nc')
  })

  it('never throws on a degenerate tree', () => {
    for (const src of ['', '[b]', '[list][*][/list]', '[quote][/quote]', '[code][/code]', '[img][/img]', '['.repeat(300)]) {
      expect(typeof portable(src).markdown).toBe('string')
    }
  })
})

describe('round trip', () => {
  const stable = [
    '## Title\n\n**bold** *italic* ~~strike~~ and `code`',
    '- one\n- two\n  - nested\n    - deep\n- three',
    '1. first\n   - sub\n2. second',
    '> quoted text\n\nafter',
    '```\nline 1\n\nline 3\n```\n\ntext',
    '[site](https://example.com) and ![](https://example.com/a.png)',
    'literal \\[b\\]x\\[/b\\] and 2\\*3\\*4 and a # sign',
    'first line  \nsecond line\n\nnew paragraph',
  ]
  for (const original of stable) {
    it(`is stable: ${JSON.stringify(original).slice(0, 48)}`, () => {
      const once = portable(convertMarkdownToOsu(original).bbcode).markdown
      expect(once).toBe(original)
      expect(portable(convertMarkdownToOsu(once).bbcode).markdown).toBe(once)
    })
  }

  it('survives a realistic osu! userpage', () => {
    const page =
      '[centre][img]https://i.imgur.com/a.png[/img][/centre]\n' +
      '[heading]About me[/heading]\n' +
      'I am [b]Aria[/b], playing since [color=#f00]2014[/color].\n\n' +
      '[box=Setup]\n[list]\n[*]Mouse: [i]G Pro[/i]\n[*]Tablet: Wacom\n[/list]\n[/box]\n' +
      '[quote="Aria"]Aim is [u]muscle memory[/u].[/quote]\n' +
      '[url=https://osu.ppy.sh/users/2]Peppy[/url] [profile=2]peppy[/profile]\n' +
      '[spoiler]secret[/spoiler] [youtube]dQw4w9WgXcQ[/youtube]'
    const r = portable(page)
    expect(r.losses.map((l) => l.kind).sort()).toEqual(['alignment', 'collapsible', 'color', 'spoiler', 'underline'])
    expect(r.markdown).toContain('## About me')
    expect(r.markdown).toContain('**Setup**')
    expect(r.markdown).toContain('- Mouse: *G Pro*')
    expect(r.markdown).toContain('> **Aria wrote:**')
    expect(r.markdown).toContain('https://youtu.be/dQw4w9WgXcQ')
    // The result is itself valid input for the other direction.
    expect(errors(convertMarkdownToOsu(r.markdown).bbcode)).toEqual([])
  })
})

describe('MarkdownExporter youtube', () => {
  it('keeps the video id', () => {
    const model = osuModel('[youtube]dQw4w9WgXcQ[/youtube]')
    expect(new MarkdownExporter().export(model.redRoot!)).toBe('[🎥 YouTube Video](https://youtube.com/watch?v=dQw4w9WgXcQ)')
    expect(MarkdownDocumentModel).toBeDefined()
  })
})
