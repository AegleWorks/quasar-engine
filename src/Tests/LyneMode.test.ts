import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'

describe('Lyne Mode & Dialect Isolation', () => {
  describe('Mode: osu (strict isolation)', () => {
    it('treats Lyne-exclusive tags as literal text with zero parsing errors', () => {
      const doc = new BBCodeDocumentModel({
        source: '[effect=glow]Neon text[/effect] and [wnotice]Warning[/wnotice] and [tables][row][col]1[/col][/row][/tables]',
        mode: 'osu',
      })

      const html = doc.toHTML()
      // In osu mode, effect, wnotice, and tables are unknown tags so they should not render as Lyne elements
      expect(html).not.toContain('bb-wnotice')
      expect(html).not.toContain('bb-table')
      expect(html).toContain('[effect=glow]')
      expect(html).toContain('[wnotice]')
      expect(html).toContain('[tables]')
    })

    it('degrades Lyne-only tags to plain content when exporting to osu target', () => {
      const doc = new BBCodeDocumentModel({
        source: '[wnotice]Important notice[/wnotice]',
        mode: 'lyne',
      })

      const exporter = new BBCodeExporter()
      const osuBBCode = exporter.export(doc.root!, 'osu')
      expect(osuBBCode).toBe('Important notice')
      expect(osuBBCode).not.toContain('[wnotice]')
    })
  })

  describe('Mode: lyne (custom tags & rich features)', () => {
    it('parses and renders consolidated [effect] and alias tags', () => {
      const doc = new BBCodeDocumentModel({
        source: '[effect=neon]Cyberpunk[/effect] [glow=#2EE6E2]Cyan Glow[/glow] [shimmer]Shiny[/shimmer]',
        mode: 'lyne',
      })

      const html = doc.toHTML()
      expect(html).toContain('class="bb-neon"')
      expect(html).toContain('class="bb-glow"')
      expect(html).toContain('text-shadow:0 0 4px #2EE6E2')
      expect(html).toContain('class="bb-shimmer"')
    })

    it('parses and renders consolidated [anim] and alias tags', () => {
      const doc = new BBCodeDocumentModel({
        source: '[anim=pulse]Pulsing[/anim] [wave]Waving[/wave] [glitch]Glitched[/glitch] [typewriter]Typed[/typewriter]',
        mode: 'lyne',
      })

      const html = doc.toHTML()
      expect(html).toContain('class="bb-pulse"')
      expect(html).toContain('class="bb-wave"')
      expect(html).toContain('class="bb-glitch"')
      expect(html).toContain('class="bb-typewriter"')
    })

    it('parses and renders consolidated [container] and hyphenated [neon-box] tags', () => {
      const doc = new BBCodeDocumentModel({
        source: '[container=card]Card content[/container] [container=neon-box:#ff0055]Neon Box[/container] [neon-box=#2ee6e2]Direct Neon Box[/neon-box]',
        mode: 'lyne',
      })

      const html = doc.toHTML()
      expect(html).toContain('class="bb-cut-panel bb-card"')
      expect(html).toContain('class="bb-cut-panel bb-neon-box"')
      expect(html).toContain('--neon-color:#ff0055')
      expect(html).toContain('Direct Neon Box')
      expect(html).not.toContain('[/neon-box]')
    })

    it('parses and renders safe [style] tags with CSS whitelist', () => {
      const doc = new BBCodeDocumentModel({
        source: '[style="display:flex;opacity:0.8;color:#2ee6e2;evil-prop:expression()"]Styled text[/style]',
        mode: 'lyne',
      })

      const html = doc.toHTML()
      expect(html).toContain('display:flex;opacity:0.8;color:#2ee6e2')
      expect(html).not.toContain('evil-prop')
    })

    it('parses and renders [wnotice] with warning symbol and custom color', () => {
      const doc = new BBCodeDocumentModel({
        source: '[wnotice=#ffaa00]Dangerous action ahead[/wnotice]',
        mode: 'lyne',
      })

      const html = doc.toHTML()
      expect(html).toContain('bb-wnotice')
      expect(html).toContain('⚠')
      expect(html).toContain('Dangerous action ahead')
      expect(html).toContain('border-left-color:#ffaa00')
    })

    it('parses and renders [tables], [columns], [gallery], [separator], [scroll]', () => {
      const doc = new BBCodeDocumentModel({
        source: `[tables=striped,borders][row][th]Header[/th][/row][row][col]Cell[/col][/row][/tables]
[columns=3]Col1 Col2 Col3[/columns]
[gallery][img]https://example.com/1.png[/img][img]https://example.com/2.png[/img][/gallery]
[separator=stars]
[scroll=150]Scrollable text[/scroll]`,
        mode: 'lyne',
      })

      const html = doc.toHTML()
      expect(html).toContain('class="bb-table bb-table-striped bb-table-borders"')
      expect(html).toContain('class="bb-th"')
      expect(html).toContain('class="bb-columns" style="column-count:3;"')
      expect(html).toContain('class="bb-gallery"')
      expect(html).toContain('✦ ✦ ✦')
      expect(html).toContain('class="bb-scroll" style="max-height:150px;"')
    })

    it('parses and renders inline typography tags (sup, sub, mark, kbd, tooltip, flip, raw)', () => {
      const doc = new BBCodeDocumentModel({
        source: '[sup]super[/sup] [sub]sub[/sub] [mark]highlight[/mark] [kbd]CTRL[/kbd] [tooltip=Help text]Hover me[/tooltip] [flip]Flipped[/flip] [raw]<strong>Literal</strong>[/raw]',
        mode: 'lyne',
      })

      const html = doc.toHTML()
      expect(html).toContain('>super</sup>')
      expect(html).toContain('>sub</sub>')
      expect(html).toContain('class="bb-mark">highlight</mark>')
      expect(html).toContain('class="bb-kbd">CTRL</kbd>')
      expect(html).toContain('class="bb-tooltip" title="Help text"')
      expect(html).toContain('transform:scaleX(-1)')
      expect(html).toContain('&lt;strong&gt;Literal&lt;/strong&gt;')
    })

    it('supports mediaProxy and entityLinkResolver options', () => {
      const renderer = new HTMLRenderer({
        theme: 'lyne',
        dialect: 'lyne',
        mediaProxy: (url) => `https://proxy.lyne.game/?url=${encodeURIComponent(url)}`,
        entityLinkResolver: (kind, val) => {
          if (kind === 'guild') return { href: `/g/${val}`, external: false }
          if (kind === 'map') return { href: `/m/${val}`, external: true }
          return null
        },
      })

      const doc = new BBCodeDocumentModel({
        source: '[img]https://externalsite.com/pic.jpg[/img] [guild]CYBER[/guild] [map]12345[/map]',
        mode: 'lyne',
      })

      const html = renderer.render(doc.root!)
      expect(html).toContain('src="https://proxy.lyne.game/?url=https%3A%2F%2Fexternalsite.com%2Fpic.jpg"')
      expect(html).toContain('href="/g/CYBER"')
      expect(html).toContain('href="/m/12345" target="_blank"')
    })

    it('supports rich centered and aligned box titles in lyne mode', () => {
      const doc = new BBCodeDocumentModel({
        source: '[centre][box="Centered Mission"]Content[/box][/centre]\n[box=[centre]Inner Centered Title[/centre]]Content[/box]\n[centre][box=joined contests][notice][box=[b]nested box[/b]]inner[/box][/notice][/box][/centre]',
        mode: 'lyne',
      })

      const renderer = new HTMLRenderer({ theme: 'lyne', dialect: 'lyne' })
      const html = renderer.render(doc.root!)
      expect(html).toContain('<details')
      expect(html).toContain('class="box"')
      expect(html).toContain('Centered Mission')
      expect(html).toContain('style="text-align:center;"')
      expect(html).toContain('nested box')
      expect(html).toContain('class="bb-notice-body"')
    })

    it('exports correctly with target lyne', () => {
      const input = '[wnotice=#ff0000]Be careful[/wnotice]'
      const doc = new BBCodeDocumentModel({
        source: input,
        mode: 'lyne',
      })

      const exporter = new BBCodeExporter(undefined, 'lyne')
      const exported = exporter.export(doc.root!)
      expect(exported).toBe('[wnotice=#ff0000]Be careful[/wnotice]')
    })

    it('linkifies @mentions via mentionResolver and keeps unresolved ones as text', () => {
      const doc = new BBCodeDocumentModel({
        source: '[b]Hey @airi and @ghost[/b] tail',
        mode: 'lyne',
      })
      const renderer = new HTMLRenderer({
        registry: doc.tagRegistry,
        dialect: 'lyne',
        theme: 'lyne',
        mentionResolver: (name) => (name === 'airi' ? { href: `/u/${name}`, external: false } : null),
      })
      const html = renderer.render(doc.root!)
      expect(html).toContain('<a class="bb-mention" href="/u/airi">@airi</a>')
      expect(html).toContain('@ghost')
      expect(html).toContain('tail')
    })

    it('escapes mention names and rejects dangerous mention hrefs', () => {
      const doc = new BBCodeDocumentModel({
        source: 'Hi @evil"onclick="alert(1)',
        mode: 'lyne',
      })
      const renderer = new HTMLRenderer({
        registry: doc.tagRegistry,
        dialect: 'lyne',
        theme: 'lyne',
        mentionResolver: () => ({ href: 'javascript:alert(1)', external: false }),
      })
      const html = renderer.render(doc.root!)
      // Dangerous protocol → mention stays plain text, escaped
      expect(html).not.toContain('javascript:')
      expect(html).not.toContain('<a class="bb-mention"')
      expect(html).toContain('&quot;')
    })

    it('allows safe mention hrefs (root-relative and http)', () => {
      const doc = new BBCodeDocumentModel({
        source: '@airi @jane',
        mode: 'lyne',
      })
      const renderer = new HTMLRenderer({
        registry: doc.tagRegistry,
        dialect: 'lyne',
        theme: 'lyne',
        mentionResolver: (name) => ({
          href: name === 'airi' ? `/u/${name}` : `https://example.com/u/${name}`,
          external: name !== 'airi',
        }),
      })
      const html = renderer.render(doc.root!)
      expect(html).toContain('<a class="bb-mention" href="/u/airi">@airi</a>')
      expect(html).toContain('<a class="bb-mention" href="https://example.com/u/jane" target="_blank" rel="noopener">@jane</a>')
    })

    it('turns timestamps into editor deep-link chips via timestampResolver', () => {
      const doc = new BBCodeDocumentModel({
        source: 'At 1:23 the beat drops, see 04:05.5 for the outro',
        mode: 'lyne',
      })
      const renderer = new HTMLRenderer({
        registry: doc.tagRegistry,
        dialect: 'lyne',
        theme: 'lyne',
        timestampResolver: (ms, label) => ({ href: `line://edit?map=42&t=${ms}`, external: false }),
      })
      const html = renderer.render(doc.root!)
      expect(html).toContain('<a class="bb-timeref" href="line://edit?map=42&amp;t=83000">1:23</a>')
      expect(html).toContain('<a class="bb-timeref" href="line://edit?map=42&amp;t=245500">04:05.5</a>')
    })

    it('keeps timestamps as plain text without timestampResolver', () => {
      const doc = new BBCodeDocumentModel({
        source: 'At 1:23 nothing happens',
        mode: 'lyne',
      })
      const renderer = new HTMLRenderer({
        registry: doc.tagRegistry,
        dialect: 'lyne',
        theme: 'lyne',
      })
      const html = renderer.render(doc.root!)
      expect(html).toContain('At 1:23 nothing happens')
      expect(html).not.toContain('bb-timeref')
    })

    it('renders [col] outside [tables] as a plain span, inside as td', () => {
      const doc = new BBCodeDocumentModel({
        source: `[columns=2][col]Left[/col][col]Right[/col][/columns]
[tables][row][col]Cell[/col][/row][/tables]`,
        mode: 'lyne',
      })
      const prev = HTMLRenderer.idMode
      HTMLRenderer.idMode = 'none'
      try {
        const html = doc.toHTML()
        // Orphaned [col] inside [columns] → span, not td
        expect(html).toContain('<div class="bb-columns" style="column-count:2;"><span>Left</span><span>Right</span></div>')
        // [col] inside [tables] stays a real cell
        expect(html).toContain('<td>Cell</td>')
      } finally {
        HTMLRenderer.idMode = prev
      }
    })
  })
})
