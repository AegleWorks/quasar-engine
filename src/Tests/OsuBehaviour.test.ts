import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'
import { scanBBCode } from '../Lexer/BBCodeLexer'
import { applyOsuPairing } from '../Osu/osuPairing'

/**
 * `previewOsuBehaviour`'s meaning, since the render-only mechanism was
 * replaced: the PREVIEW parses the same source a second time with
 * `pairing: 'osu'` (see `Osu/osuPairing.ts`) and renders THAT tree instead of
 * the editor's. This file tests the pairing engine itself — the renderer has
 * no osu!-specific branch left at all; whatever tree it is given, it renders
 * the same way.
 *
 * Fixtures are not guesses — they are osu!'s own visible output, measured by
 * running osu-web's real PHP pipeline (BBCodeForDB → BBCodeFromDB →
 * HTMLPurifier) on each `src` through the harness described in the module
 * doc of `osuPairing.ts`. No osu-web source is copied here (AGPL); only
 * observed behaviour.
 */

const DIALECTS: readonly BBCodeDialect[] = ['osu', 'miliastry']

const strip = (html: string): string => html.replace(/ data-node-id="[^"]*"/g, '')

function renderOsuPaired(source: string, dialect: BBCodeDialect): string {
  const doc = new BBCodeDocumentModel({ source, dialect, pairing: 'osu', incremental: false })
  const renderer = new HTMLRenderer({ dialect, theme: dialect === 'lyne' ? 'lyne' : 'osu' })
  return strip(renderer.render(doc.redRoot!))
}

function renderQuasar(source: string, dialect: BBCodeDialect): string {
  const doc = new BBCodeDocumentModel({ source, dialect })
  const renderer = new HTMLRenderer({ dialect, theme: dialect === 'lyne' ? 'lyne' : 'osu' })
  return strip(renderer.render(doc.redRoot!))
}

describe('osuPairing — pairing: osu reproduces osu!\'s tag sealing', () => {
  describe.each(DIALECTS)('dialect=%s', (dialect) => {
    it('an unclosed opener with no closer anywhere renders as literal text', () => {
      const html = renderOsuPaired('[b]texto', dialect)
      expect(html).not.toContain('<strong')
      expect(html).toContain('[b]texto')
    })

    it('quasar pairing (default) still renders an unclosed opener formatted — unchanged', () => {
      const html = renderQuasar('[b]texto', dialect)
      expect(html).toContain('<strong')
      expect(html).not.toContain('[b]texto<')
    })

    it('unlike the lazy family, [box=title] SEALS even with no closer anywhere — osu! never requires one for box', () => {
      // Measured: '[box=t]a' → osu! opens a real (structurally unclosed)
      // spoilerbox div around "a". Quasar's own parser auto-closes the frame
      // at EOF instead, producing a well-formed box node — same outcome
      // (formatted, not literal), different structural mechanism.
      const html = renderOsuPaired('[box=title]texto', dialect)
      expect(html).not.toContain('[box=title]texto')
      expect(html).toContain('title')
      expect(html).toContain('texto')
    })

    it('an opener auto-closed by an ancestor, whose own closer arrives later as a dropped sibling, still renders FORMATTED — osu!\'s lazy pairing finds it', () => {
      const source = '[centre][b]hola[/centre][/b]'
      const html = renderOsuPaired(source, dialect)
      // osu!: <div class="…align-centre"><strong>hola</strong></div>
      expect(html).toContain('<strong')
      expect(html).toContain('hola')
      expect(html).not.toContain('[b]')
      expect(html).not.toContain('[/b]')
    })

    it('children still render normally inside a literal opener — [b][i]x[/i] → literal [b] + <em>x</em>', () => {
      const html = renderOsuPaired('[b][i]x[/i]', dialect)
      expect(html).toContain('[b]')
      expect(html).toContain('<em')
      expect(html).toContain('x')
      expect(html).not.toContain('<strong')
    })

    it('an unclosed opener WITH attributes renders its exact source text, params included', () => {
      const html = renderOsuPaired('[quote="User"]hola', dialect)
      expect(html).not.toContain('<blockquote')
      // Literal text is HTML-escaped like any other text leaf — the quotes
      // come back as entities, not the raw characters.
      expect(html).toContain('[quote=&quot;User&quot;]hola')
    })

    it('a stray closer with no opener at all renders literal either way', () => {
      const html = renderOsuPaired('hola[/b]', dialect)
      expect(html).toContain('hola[/b]')
    })

    it('a properly closed tag is never touched', () => {
      const html = renderOsuPaired('[b]basic[/b]', dialect)
      expect(html).toContain('<strong')
      expect(html).toContain('basic')
    })

    it('nested openers of the SAME name: osu! pairs only the outer, non-nested, and leaves the inner literal', () => {
      // Measured: '[b]a [b]b[/b]' → '<strong>a [b]b</strong>'
      const html = renderOsuPaired('[b]a [b]b[/b]', dialect)
      expect(html).toContain('<strong')
      expect(html).toContain('a [b]b')
      // Only ONE <strong> — the inner opener never became its own element.
      expect(html.match(/<strong/g)?.length).toBe(1)
    })

    it('nested openers of the SAME name with trailing text: only the outer pair is bold', () => {
      // Measured: '[b]a [b]b[/b] c' → '<strong>a [b]b</strong> c'
      const html = renderOsuPaired('[b]a [b]b[/b] c', dialect)
      expect(html).toContain('<strong')
      expect(html).toContain('a [b]b')
      expect(html.match(/<strong/g)?.length).toBe(1)
      // ' c' sits OUTSIDE the <strong>, exactly as osu! shows it.
      const strongEnd = html.indexOf('</strong>')
      expect(html.slice(strongEnd)).toContain(' c')
    })

    it('case sensitivity: [B]x[/B] never seals (osu!\'s own regexes carry no /i flag)', () => {
      const html = renderOsuPaired('[B]x[/B]', dialect)
      expect(html).not.toContain('<strong')
      expect(html).toContain('[B]x[/B]')
    })

    it('quasar-only alias "center" never seals — osu! only recognises "centre"', () => {
      const html = renderOsuPaired('[center]a[/center]', dialect)
      expect(html).not.toContain('bbcode__align-center')
      expect(html).not.toContain('text-align')
      expect(html).toContain('[center]a[/center]')
    })

    it('quasar-only alias "colour" never seals — osu! only recognises "color"', () => {
      const html = renderOsuPaired('[colour=red]a[/colour]', dialect)
      expect(html).not.toContain('style="color')
      expect(html).toContain('[colour=red]a[/colour]')
    })

    it('[code] protects its content: a tag typed inside never fires, even under osu! pairing', () => {
      const html = renderOsuPaired('[code][b]x[/b][/code]', dialect)
      expect(html).toContain('<pre')
      expect(html).not.toContain('<strong')
      expect(html).toContain('[b]x[/b]')
    })

    it('[code] unclosed: the opener goes literal, and what follows keeps tokenising normally — matches real osu!', () => {
      // Real osu! (measured): '[code]a[b]y[/b]' → '[code]a<strong>y</strong>'
      // — an unclosed [code] protects nothing, so the trailing [b]y[/b]
      // seals normally. `scanBBCode` only isolates a raw block under
      // `pairing: 'osu'` when a closer actually exists (see
      // `Lexer/BBCodeLexer.ts`); with none here the opener is left an
      // ordinary token and lexing continues normally past it, so
      // `[b]y[/b]` tokenises and seals like anywhere else.
      const html = renderOsuPaired('[code]a[b]y[/b]', dialect)
      expect(html).not.toContain('<pre')
      expect(html).toContain('<strong')
      expect(html).toContain('[code]a')
      expect(html).not.toContain('[code]a[b]y[/b]')
    })

    it('[code] unclosed, followed by a blank line — both newlines still break normally', () => {
      // Measured: '[code]x\n\n[b]y[/b]' → '[code]x<br /><br /><strong>y</strong>'
      const html = renderOsuPaired('[code]x\n\n[b]y[/b]', dialect)
      expect(html).not.toContain('<pre')
      expect(html).toContain('<strong')
      expect(html.match(/<br/g)?.length).toBe(2)
    })

    it('[code] properly closed, followed by an unrelated unclosed [code] — only the second stays literal', () => {
      // Measured: '[code]a[/code] [code]b\n[i]z[/i]' →
      //   '<pre>a</pre> [code]b<br /><em>z</em>'
      const html = renderOsuPaired('[code]a[/code] [code]b\n[i]z[/i]', dialect)
      expect(html).toContain('<pre')
      expect(html).toContain('>a<')
      expect(html).toContain('[code]b')
      expect(html).toContain('<em')
      expect(html).toContain('z')
    })

    it('[c] (single-line) refuses to pair across a newline — osu!\'s own regex is not dotall for it', () => {
      const html = renderOsuPaired('[c]a\nb[/c]', dialect)
      expect(html).not.toContain('<code')
      expect(html).toContain('[c]a')
    })

    it('[c] whose only closer is reachable across a newline does not swallow it either — what follows keeps tokenising', () => {
      // Measured: '[c]x\n[/c]y' → '[c]x<br />[/c]y' — the newline breaks
      // normally (the lexer never isolated it as raw content) and the now-
      // unrelated '[/c]' renders literal, like any other orphan closer (it
      // is not box/spoilerbox).
      const html = renderOsuPaired('[c]x\n[/c]y', dialect)
      expect(html).not.toContain('<code')
      expect(html).toContain('[c]x')
      expect(html).toContain('[/c]y')
      expect(html.match(/<br/g)?.length).toBe(1)
    })

    it('quote: count-limited — 2 openers, 1 closer → only the FIRST opener seals', () => {
      // Measured: '[quote]a[quote]b[/quote]' → '<blockquote>a[quote]b</blockquote>'
      const html = renderOsuPaired('[quote]a[quote]b[/quote]', dialect)
      expect(html.match(/<blockquote/g)?.length).toBe(1)
      expect(html).toContain('[quote]b')
    })

    it('quote: count-limited — 2 openers, 3 closers → first 2 of EACH seal, third closer stays literal', () => {
      // Measured: '[quote]a[/quote][quote]b[/quote][/quote]' →
      //   '<blockquote>a</blockquote><blockquote>b</blockquote>[/quote]'
      const html = renderOsuPaired('[quote]a[/quote][quote]b[/quote][/quote]', dialect)
      expect(html.match(/<blockquote/g)?.length).toBe(2)
      expect(html).toContain('a</blockquote>')
      expect(html).toContain('b</blockquote>')
      expect(html).toContain('[/quote]')
      // The literal third closer comes after both real blockquotes.
      expect(html.indexOf('[/quote]')).toBeGreaterThan(html.lastIndexOf('</blockquote>'))
    })

    it('quote: an UNQUOTED =value opener never counts — osu! only accepts bare or ="text"', () => {
      // Measured: '[quote=Author]a[/quote]' → entirely literal.
      const html = renderOsuPaired('[quote=Author]a[/quote]', dialect)
      expect(html).not.toContain('<blockquote')
      expect(html).toContain('[quote=Author]a[/quote]')
    })

    it('box: every syntactically valid [box=title]/[/box] seals unconditionally, nesting included', () => {
      // Markup vocabulary is dialect-specific (`<details>` vs osu!'s own
      // spoilerbox structure — see `renderBox`/`isOsu()`); what's asserted
      // here is the PAIRING outcome, not a class name: both titles reached
      // the tree as real box nodes, and no literal bracket survived.
      const html = renderOsuPaired('[box=t1]a[box=t2]b[/box]c[/box]', dialect)
      expect(html).toContain('t1')
      expect(html).toContain('t2')
      expect(html).not.toContain('[box=')
      expect(html).not.toContain('[/box]')
    })

    it('box: bare [box] (no =value) is not osu! syntax — opener stays literal, and its orphan [/box] (no matching opener) renders NOTHING, like real osu!', () => {
      // osu!'s own closer IS unconditionally sealed (`[/box]a` → `[box]a` +
      // an unmatched `</div>` that HTMLPurifier silently drops — measured:
      // real osu! shows nothing for it at all). `parseTokensToGreen`'s
      // orphan-close branch now matches: under `pairing: 'osu'` an orphan
      // `[/box]`/`[/spoilerbox]` becomes a `discarded_box_close` leaf,
      // which `HTMLRenderer` renders as '' — see `Osu/osuPairing.ts`'s
      // module doc, gap 2.
      const html = renderOsuPaired('[box]a[/box]', dialect)
      expect(html).toContain('[box]a')
      expect(html).not.toContain('[/box]')
    })

    it('spoilerbox: bare seals; [spoilerbox=x] (osu! spoilerbox takes no value) has its OPENER stay literal, and its now-orphan closer renders nothing (same fix as bare [box] above)', () => {
      const bare = renderOsuPaired('[spoilerbox]a[/spoilerbox]', dialect)
      expect(bare).not.toContain('[spoilerbox]')
      expect(bare.includes('<details') || bare.includes('bbcode-spoilerbox')).toBe(true)

      const withValue = renderOsuPaired('[spoilerbox=x]a[/spoilerbox]', dialect)
      expect(withValue).toContain('[spoilerbox=x]a')
      expect(withValue).not.toContain('[/spoilerbox]')
    })

    it('an orphan [/box]/[/spoilerbox] with no adjacent newlines just vanishes', () => {
      // Measured: 'hola[/box] mundo' → 'hola mundo'; 'hola[/spoilerbox] mundo' → 'hola mundo'.
      const box = renderOsuPaired('hola[/box] mundo', dialect)
      expect(box).toContain('hola mundo')
      expect(box).not.toContain('[/box]')

      const spoilerbox = renderOsuPaired('hola[/spoilerbox] mundo', dialect)
      expect(spoilerbox).toContain('hola mundo')
      expect(spoilerbox).not.toContain('[/spoilerbox]')
    })

    it('an orphan [/box] swallows the same newlines a matched close would — ALL before, ONE after', () => {
      // Measured: 'hola\n\n[/box]\n\nmundo' → 'hola<br />mundo'.
      const html = renderOsuPaired('hola\n\n[/box]\n\nmundo', dialect)
      expect(html).toContain('hola')
      expect(html).toContain('mundo')
      expect(html).not.toContain('[/box]')
      expect(html.match(/<br/g)?.length).toBe(1)
    })

    it('an orphan [/spoilerbox] with exactly one newline on each side eats both', () => {
      // Measured: 'hola\n[/spoilerbox]\nmundo' → 'holamundo' (zero <br>).
      const html = renderOsuPaired('hola\n[/spoilerbox]\nmundo', dialect)
      expect(html).not.toContain('[/spoilerbox]')
      expect(html.match(/<br/g)).toBeNull()
    })

    it('two [/box] closers in a row: the first closes the real box, the second (orphan) vanishes with no trace', () => {
      // Measured: '[box=t]a[/box][/box] b' → box(t){a}, then ' b' — the
      // second closer disappears entirely.
      const html = renderOsuPaired('[box=t]a[/box][/box] b', dialect)
      expect(html).not.toContain('[/box]')
      expect(html).toContain('t')
      expect(html).toContain('a')
      expect(html).toContain(' b')
    })

    it('img: content containing a literal "[" never seals (osu!\'s [^[]+ can\'t cross a bracket)', () => {
      const html = renderOsuPaired('[img]http://x.com/a[b].png[/img]', dialect)
      expect(html).not.toContain('<img')
      expect(html).toContain('[img]')
    })

    it('img: plain content seals normally', () => {
      const html = renderOsuPaired('[img]a[/img][img]b[/img]', dialect)
      expect(html.match(/<img/g)?.length).toBe(2)
    })

    it('list: [*] item markers always seal, even outside the sealed [list] (unconditional in osu!, like box)', () => {
      // Measured: '[list][*]a[/list][*]b[/list]' → only the first [list]…
      // [/list] seals (1 opener, 2 closers → limit 1), yet BOTH [*] became
      // list items — the second is an orphan <li>, not literal `[*]` text.
      const html = renderOsuPaired('[list][*]a[/list][*]b[/list]', dialect)
      expect(html).not.toContain('[*]')
    })
  })

  it('pairing: "quasar" (default) is byte-identical to a bare `new HTMLRenderer()` across every fixture above', () => {
    const sources = [
      '[b]texto',
      '[box=title]texto',
      '[centre][b]hola[/centre][/b]',
      '[b][i]x[/i]',
      '[quote="User"]hola',
      'hola[/b]',
      '[b]basic[/b]',
      '[b]a [b]b[/b]',
      '[code][b]x[/b][/code]',
      '[quote]a[quote]b[/quote]',
      // Gap 1 (unclosed [code]/[c]) and gap 2 (orphan [/box]/[/spoilerbox])
      // fixtures — the default 'quasar' pairing must render every one of
      // these exactly as it did before either fix.
      '[code]x\n[b]y[/b]',
      '[c]x [b]y[/b]',
      '[code]a[/code] [code]b\n[i]z[/i]',
      '[code]x\n\n[b]y[/b]',
      '[c]x\n[/c]y',
      'hola[/box] mundo',
      'hola\n\n[/box]\n\nmundo',
      'hola\n[/spoilerbox]\nmundo',
      '[box=t]a[/box][/box] b',
    ]
    for (const source of sources) {
      const doc = new BBCodeDocumentModel({ source })
      const bare = strip(new HTMLRenderer().render(doc.redRoot!))
      const explicitQuasar = strip(new HTMLRenderer().render(new BBCodeDocumentModel({ source, pairing: 'quasar' }).redRoot!))
      expect(explicitQuasar).toBe(bare)
      expect(renderQuasar(source, 'miliastry')).toBe(bare)
    }
  })

  it('gap 1 fix does not change default pairing: an unclosed [code]/[c] still swallows the rest of the document', () => {
    const html = renderQuasar('[code]x\n[b]y[/b]', 'miliastry')
    expect(html).toContain('<pre')
    expect(html).not.toContain('<strong')
    // The whole tail, tags included, is literal `<pre>` content — never
    // tokenised, exactly like before either gap fix.
    expect(html).toContain('[b]y[/b]')
  })

  it('gap 2 fix does not change default pairing: an orphan [/box]/[/spoilerbox] still renders as literal text and keeps its newlines', () => {
    const html = renderQuasar('hola\n\n[/box]\n\nmundo', 'miliastry')
    expect(html).toContain('[/box]')
    // Every newline is still an ordinary, unswallowed break: two before the
    // literal closer, two after.
    expect(html.match(/<br/g)?.length).toBe(4)
  })

  it('an empty document under pairing: "osu" never throws — same as "quasar" (both leave redRoot unset for an empty initial source)', () => {
    expect(() => new BBCodeDocumentModel({ source: '', pairing: 'osu' })).not.toThrow()
    const doc = new BBCodeDocumentModel({ source: '', pairing: 'osu' })
    expect(doc.redRoot).toBe(new BBCodeDocumentModel({ source: '' }).redRoot)
  })

  it('pairing: "osu" forces a full rebuild — incremental never runs even if requested', () => {
    const doc = new BBCodeDocumentModel({ source: '[b]x[/b]', pairing: 'osu', incremental: true })
    // Constructing successfully and exposing a tree is the contract here;
    // IncrementalParser.test.ts / DocumentModel's own suite cover the
    // incremental machinery itself.
    expect(doc.redRoot).toBeTruthy()
    expect(doc.pairing).toBe('osu')
  })
})

describe('applyOsuPairing — token-level unit tests', () => {
  function summarize(source: string): string {
    const tokens = applyOsuPairing(scanBBCode(source), source)
    return tokens
      .map((t) => {
        if (t.kind === 'open') return `<${t.tag}>`
        if (t.kind === 'close') return `</${t.tag}>`
        if (t.kind === 'text') return t.value
        return '\n'
      })
      .join('')
  }

  it('leaves a fully quasar-only tag (no osu! entry at all) completely untouched', () => {
    // `gradient` has no OSU_FAMILY entry — always passes through.
    expect(summarize('[gradient=#fff,#000]x[/gradient]')).toBe('<gradient>x</gradient>')
  })

  it('demotes only the unsealed nested opener, keeping offsets intact', () => {
    const source = '[b]a [b]b[/b]'
    const tokens = applyOsuPairing(scanBBCode(source), source)
    const innerOpen = tokens.find((t) => t.start === source.indexOf('[b]', 3))!
    expect(innerOpen.kind).toBe('text')
    expect(innerOpen.start).toBe(source.indexOf('[b]', 3))
    expect(innerOpen.end).toBe(source.indexOf('[b]', 3) + 3)
  })

  it('quote count-limiting seals openers/closers by DOCUMENT ORDER, not nesting', () => {
    expect(summarize('[quote]a[/quote][quote]b[/quote][/quote]'))
      .toBe('<quote>a</quote><quote>b</quote>[/quote]')
  })

  it('img requires the very next bracket to be its own closer', () => {
    expect(summarize('[img]ok[/img]')).toBe('<img>ok</img>')
    // The failed opener goes literal; the failed `b` opener (no [/b]
    // anywhere) goes literal too. The now-ORPHAN `[/img]` close token is
    // untouched at this token-filter level (this module only ever demotes
    // an OPEN token to literal for img) — `parseTokensToGreen`'s existing
    // orphan-close fallback renders it as literal text once the tree is
    // built, same as any other unmatched `[/tag]`; see the HTML-level
    // `'img: content containing a literal "[" never seals'` test above.
    expect(summarize('[img]a[b][/img]')).toBe('[img]a[b]</img>')
  })
})
