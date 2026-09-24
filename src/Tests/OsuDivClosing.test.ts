import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'

/**
 * `Parser.ts`'s `closeDivUnits` — osu!'s DIV-COUNT closing semantics for
 * `box`/`spoilerbox`/`notice`/`centre`/`left`/`right` under
 * `pairing: 'osu'`. osu! never builds a tree: every one of these becomes
 * literal `<div>`s in `BBCodeFromDB::toHTML()`'s output (two for
 * `box`/`spoilerbox` — wrapper, then body — one for everything else), and
 * HTMLPurifier closes each `</div>` against the INNERMOST currently open
 * `<div>` by POSITION alone, never by which BBCode tag produced it.
 *
 * Fixtures are not guesses — they are osu!'s own visible output, measured by
 * running osu-web's real PHP pipeline (BBCodeForDB → BBCodeFromDB →
 * HTMLPurifier) through the harness described in `Osu/osuPairing.ts`'s
 * module doc. No osu-web source is copied here (AGPL); only observed
 * behaviour. `data-node-id` stripped for readability.
 */

const DIALECTS: readonly BBCodeDialect[] = ['osu', 'miliastry']

const strip = (html: string): string => html.replace(/ data-node-id="[^"]*"/g, '')

function renderOsuPaired(source: string, dialect: BBCodeDialect): string {
  const doc = new BBCodeDocumentModel({ source, dialect, pairing: 'osu', incremental: false })
  const renderer = new HTMLRenderer({ dialect, theme: dialect === 'lyne' ? 'lyne' : 'osu' })
  return strip(renderer.render(doc.redRoot!))
}

function renderQuasarPairing(source: string, dialect: BBCodeDialect): string {
  const doc = new BBCodeDocumentModel({ source, dialect, pairing: 'quasar', incremental: false })
  const renderer = new HTMLRenderer({ dialect, theme: dialect === 'lyne' ? 'lyne' : 'osu' })
  return strip(renderer.render(doc.redRoot!))
}

describe('osu! div-count closing (pairing: osu, Parser.ts closeDivUnits)', () => {
  describe.each(DIALECTS)('dialect=%s', (dialect) => {
    it('half-closed box: a crossing 1-unit closer eats only the BODY div, the wrapper stays open around the tail', () => {
      // Measured (osu-web): `<div box><a/><div body>x</div>y</div>` — `y`
      // renders AFTER the body closes but still INSIDE the wrapper.
      const html = renderOsuPaired('[centre][box=a]x[/centre]y[/box]', dialect)
      if (dialect === 'osu') {
        expect(html).toBe(
          '<div class="bbcode__align-centre">'
          + '<div class="js-spoilerbox bbcode-spoilerbox">'
          + '<a class="js-spoilerbox__link bbcode-spoilerbox__link" href="#">'
          + '<span class="bbcode-spoilerbox__link-icon"></span>'
          + '<span class="bbcode-spoilerbox__link-text">a</span></a>'
          + '<div class="js-spoilerbox__body bbcode-spoilerbox__body">x</div>y</div></div>',
        )
      } else {
        // miliastry renders boxes as `<details>`: the tail cannot live
        // "inside the wrapper but outside the collapsible body" the way
        // osu!'s div can, so it renders AFTER the whole `<details>` element —
        // visible even while the box is collapsed, the same property it has
        // in osu!'s own HTML (see `HTMLRenderer.renderBox`/`renderSpoilerbox`).
        expect(html).toBe(
          '<div style="text-align:center;">'
          + '<details class="box"><summary><span class="bb-box-heading">a</span></summary>'
          + '<div class="bbcode-box-body">x</div></details>y</div>',
        )
      }
    })

    it('adjacent crossing (no tail content): the wrapper closes with nothing extra', () => {
      // Measured: `[notice][box=a]x[/notice][/box]` → the body-closing
      // crossing (`[/notice]`) and the wrapper-closing one (`[/box]`) are
      // back to back, so there is no tail at all — same shape as a
      // non-crossing box.
      const html = renderOsuPaired('[notice][box=a]x[/notice][/box]', dialect)
      if (dialect === 'osu') {
        expect(html).toBe(
          '<div class="well"><div class="js-spoilerbox bbcode-spoilerbox">'
          + '<a class="js-spoilerbox__link bbcode-spoilerbox__link" href="#">'
          + '<span class="bbcode-spoilerbox__link-icon"></span>'
          + '<span class="bbcode-spoilerbox__link-text">a</span></a>'
          + '<div class="js-spoilerbox__body bbcode-spoilerbox__body">x</div></div></div>',
        )
      } else {
        expect(html).toBe(
          '<div class="notice"><details class="box"><summary><span class="bb-box-heading">a</span></summary>'
          + '<div class="bbcode-box-body">x</div></details></div>',
        )
      }
      expect(html).not.toContain('box_tail')
    })

    it('two 1-unit tags crossing: the SECOND closer (in source order) closes the INNERMOST div, not its own name', () => {
      // Measured: `[notice]x[centre]y[/notice]z[/centre]` — `[/notice]`
      // closes `centre` (innermost), `notice` itself stays open until
      // `[/centre]` (the LATER closer) finally reaches it.
      const html = renderOsuPaired('[notice]x[centre]y[/notice]z[/centre]', dialect)
      if (dialect === 'osu') {
        expect(html).toBe('<div class="well">x<div class="bbcode__align-centre">y</div>z</div>')
      } else {
        expect(html).toBe('<div class="notice">x<div style="text-align:center;">y</div>z</div>')
      }
    })

    it('extra closer beyond what is open: dropped, invisible, nothing else touched', () => {
      // Measured: `[box=a][box=b]x[/box][/box][/box]` — the third `[/box]`
      // finds nothing open and vanishes.
      const html = renderOsuPaired('[box=a][box=b]x[/box][/box][/box]', dialect)
      expect(html).not.toContain('[/box]')
      expect(html.match(/js-spoilerbox bbcode-spoilerbox"|details class="box"/g)?.length).toBe(2)
    })

    it('partial crossing: box finds only ONE unit (not its own two) — consumes it, drops the rest', () => {
      // Measured (`docs/ai/NyuPenyu.from-intent.bbcode`'s exact pattern,
      // reduced): a `box` already closed by its OWN matching `[/box]`,
      // leaving only `centre`'s ONE unit open, then an EXTRA `[/box]`
      // (needed: 2). osu! consumes the one unit that exists (closing
      // `centre`) and drops the unmet rest of the closer — it does NOT
      // leave `centre` open because the full two were unavailable. The
      // trailing `[/centre]` (needed so `centre` seals as a real tag at
      // all — see `Osu/osuPairing.ts`) then finds nothing left open either
      // and is dropped too, invisibly (not shown as literal text: it WAS a
      // genuinely sealed closer, just one that arrives too late).
      const html = renderOsuPaired('[centre][box=a]x[/box][/box]after[/centre]', dialect)
      expect(html).not.toContain('[/centre]')
      expect(html).not.toContain('[/box]')
      // `centre` closes right after the box, BEFORE "after" — "after" sits
      // outside it, at the top level.
      const centreOpen = dialect === 'osu' ? 'class="bbcode__align-centre"' : 'style="text-align:center;"'
      const centreIdx = html.indexOf(centreOpen)
      expect(centreIdx).toBeGreaterThanOrEqual(0)
      const afterIdx = html.indexOf('after')
      const closeDivIdx = html.indexOf('</div>', centreIdx)
      expect(closeDivIdx).toBeGreaterThanOrEqual(0)
      expect(closeDivIdx).toBeLessThan(afterIdx)
    })

    it('a genuinely orphan lazy-family closer (no opener anywhere) renders literal, untouched', () => {
      // Measured: `x[/centre]y` → `x[/centre]y` (literal — `notice`/
      // `centre`/`left`/`right` are `lazy`-sealed at the TOKEN level;
      // an unmatched one never becomes a real tag at all).
      expect(renderOsuPaired('x[/centre]y', dialect)).toContain('x[/centre]y')
    })

    it('an orphan lazy closer does not sweep away an unrelated OPEN inline tag', () => {
      // Measured: `[b]bold[/centre]` → `bold` stays bold, `[/centre]`
      // renders literally. Nothing div-related is open at all, so this
      // closer must not touch `[b]` on its way to finding nothing.
      const html = renderOsuPaired('[b]bold[/centre]', dialect)
      expect(html).toContain('[b]bold[/centre]')
    })
  })

  it('default pairing (quasar) is unaffected by any of this — same shape as before div-count tracking existed', () => {
    for (const dialect of DIALECTS) {
      for (const src of [
        '[centre][box=a]x[/centre]y[/box]',
        '[notice]x[centre]y[/notice]z[/centre]',
        '[box=a][box=b]x[/box][/box][/box]',
      ]) {
        expect(renderQuasarPairing(src, dialect)).not.toContain('box_tail')
      }
    }
  })

  describe('docs/ai/NyuPenyu — real userpage excerpt (lines 482-517)', () => {
    // Reduced from the real page: `[centre][box=random stuff]…[/box]` well
    // formed, then `[box=my peripherals]` crosses through a `[notice]` that
    // itself crosses through an old-area/current-area box pair, ending on an
    // unclosed `[box=past collabs]`. Measured outline (osu-web,
    // `docs/ai/`'s own harness — see the module doc): `CENTRE > {BOX random
    // stuff > NOTICE×2, BOX my peripherals > {NOTICE > BOX old area, BOX
    // current area > CENTRE}}`, then `BOX past collabs` at the top level.
    const source =
      '[centre][box=random stuff]\n'
      + '[notice][youtube]hfWx3Cxje_w[/youtube]\n'
      + 'first 9* pass (4:20 kinda goated)\n'
      + '[/notice]\n'
      + '[notice][youtube]QwAN_zlbjiM[/youtube]\n'
      + 'spazza reviewed my profile (pog)\n'
      + '[/notice][/box]\n'
      + '\n'
      + '[box=my peripherals]\n'
      + '[notice][b]keyboard[/b]\n'
      + 'gear\n'
      + '[box=old area (25/10/22 - 05/03/24)]\n'
      + '\n'
      + '[img]https://imgur-archive.ppy.sh/RzHY0dy.png[/img][/centre][/box]\n'
      + '[box=current area (05/03/24)]\n'
      + '\n'
      + '[centre][img]https://nyupenyu.s-ul.eu/G7uVUqs6[/img][/centre]\n'
      + '[/box][/box][/notice]\n'
      + '\n'
      + '[box=past collabs]\n'

    it('nests exactly like osu!: my peripherals > {notice > old area, current area > centre}', () => {
      const html = renderOsuPaired(source, 'osu')
      // `random stuff` closes cleanly and sits INSIDE centre.
      expect(html.indexOf('random stuff')).toBeLessThan(html.indexOf('my peripherals'))
      // `my peripherals` is still inside `centre` — its own closing `</div>`
      // for centre only comes after `past collabs` opens (centre never
      // re-closes early on the way).
      const centreOpenCount = (html.match(/class="bbcode__align-centre"/g) ?? []).length
      expect(centreOpenCount).toBe(2) // the outer one + the nested current-area one
      // `past collabs` is a top-level sibling of `centre`, not nested in it.
      const pastCollabsIdx = html.indexOf('past collabs')
      const lastCentreCloseBeforeIt = html.lastIndexOf('</div>', pastCollabsIdx)
      expect(lastCentreCloseBeforeIt).toBeGreaterThan(0)
      expect(pastCollabsIdx).toBeGreaterThan(0)
    })

    it('matches the exact measured outline shape (box/notice/centre nesting order)', () => {
      const html = renderOsuPaired(source, 'osu')
      const order = [...html.matchAll(/bbcode-spoilerbox__link-text">([^<]*)</g)].map(m => m[1])
      expect(order).toEqual([
        'random stuff',
        'my peripherals',
        'old area (25/10/22 - 05/03/24)',
        'current area (05/03/24)',
        'past collabs',
      ])
    })
  })
})
