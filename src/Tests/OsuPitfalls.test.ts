import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { getCodeFix } from '../Fixes/CodeFixRegistry'
import { registerValidatorFixes } from '../Fixes/validatorFixes'
import { fixToSurgicalEdits } from '../Edits/fixEdits'
import { applyEditsToSource } from '../Edits/applyEdits'
import { intendedUrl, styledUrls } from '../Semantic/osuPitfalls'
import type { Diagnostic } from '../Types/diagnostics'

/**
 * Markup that looks right and is not (`Semantic/osuPitfalls.ts`), from a real
 * profile whose preview looked fine while osu! printed half of it as text.
 * What osu! does with each was checked against osu-web's own PHP pipeline.
 */

registerValidatorFixes()

type Dialect = 'osu' | 'miliastry'

function analyze(source: string, dialect: Dialect = 'osu'): Diagnostic[] {
  return new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).analyze().diagnostics.items
}

function only(source: string, code: string, dialect: Dialect = 'osu'): Diagnostic[] {
  return analyze(source, dialect).filter((d) => d.code === code)
}

/** Applies the fix of every `code` finding, as one batch. */
function fixAll(source: string, code: string, dialect: Dialect = 'osu'): string {
  const edits = only(source, code, dialect).flatMap((d) => {
    const ops = getCodeFix(code)!(d, { source, node: null })
    return fixToSurgicalEdits({ description: '', isAutomatic: true, operations: ops })
  })
  return applyEditsToSource(source, edits.sort((a, b) => b.start - a.start))
}

describe('url-markdown-link', () => {
  const pasted = '[url=https://[https://osu.ppy.sh/users/8986574](https://osu.ppy.sh/users/8986574?utm_source=gemini)]Dezu[/url]'

  it('finds the Markdown an AI answer leaves inside [url=…], in both dialects', () => {
    expect(only(pasted, 'url-markdown-link')).toHaveLength(1)
    expect(only(pasted, 'url-markdown-link', 'miliastry')).toHaveLength(1)
    expect(only('[url=https://osu.ppy.sh/users/1]ok[/url]', 'url-markdown-link')).toHaveLength(0)
  })

  it('the fix keeps the address it wrapped, without the tracking', () => {
    expect(fixAll(pasted, 'url-markdown-link')).toBe('[url=https://osu.ppy.sh/users/8986574]Dezu[/url]')
  })

  it('reads the address from either half of the Markdown', () => {
    expect(intendedUrl('https://[https://a.com/x](https://a.com/x?utm_source=gemini)')).toBe('https://a.com/x')
    expect(intendedUrl('see (https://a.com/y?utm_medium=z&keep=1)')).toBe('https://a.com/y?keep=1')
    expect(intendedUrl('https://[broken')).toBeNull()
  })

  it('the osu! preview shows the link as osu! does: cut at the first "]", the rest printed', () => {
    const root = new BBCodeDocumentModel({ source: pasted, dialect: 'osu', autoAnalyze: false }).redRoot!
    const html = new HTMLRenderer({ dialect: 'osu' }).render(root)
    expect(html).toContain('href="https://[https://osu.ppy.sh/users/8986574"')
    expect(html).toContain('(https://osu.ppy.sh/users/8986574?utm_source=gemini)]</span>Dezu')
    // Miliastry's preview is not osu!'s: it keeps rendering the link it always did.
    const mili = new HTMLRenderer({ dialect: 'miliastry' }).render(
      new BBCodeDocumentModel({ source: pasted, dialect: 'miliastry', autoAnalyze: false }).redRoot!,
    )
    expect(mili).not.toContain('bb-osu-leaked-href')
  })
})

describe('unicode-url', () => {
  it('an imagemap written in styled letters: its addresses back to plain, its titles untouched', () => {
    const source = '[imagemap]\n𝐡𝐭𝐭𝐩𝐬://𝐢𝐳𝐨𝐥𝐨.𝐬-𝐮𝐥.𝐞𝐮/𝐓𝐄𝐃𝐢𝐤7𝐑5\n0 0 50 100 𝐡𝐭𝐭𝐩𝐬://𝐨𝐬𝐮.𝐩𝐩𝐲.𝐬𝐡/𝐮𝐬𝐞𝐫𝐬/13836963 𝐦𝐞!\n[/imagemap]'
    expect(only(source, 'unicode-url')).toHaveLength(1)
    expect(fixAll(source, 'unicode-url')).toBe(
      '[imagemap]\nhttps://izolo.s-ul.eu/TEDik7R5\n0 0 50 100 https://osu.ppy.sh/users/13836963 𝐦𝐞!\n[/imagemap]',
    )
  })

  it('a styled [url=…] keeps its styled text', () => {
    const source = '[url=𝐡𝐭𝐭𝐩𝐬://𝐨𝐬𝐮.𝐩𝐩𝐲.𝐬𝐡]𝐨𝐬𝐮![/url]'
    expect(fixAll(source, 'unicode-url')).toBe('[url=https://osu.ppy.sh]𝐨𝐬𝐮![/url]')
  })

  it('styled prose is not an address', () => {
    expect(styledUrls('𝐂𝐥𝐢𝐜𝐤 𝐇𝐞𝐫𝐞', 0)).toEqual([])
    expect(only('[url=https://osu.ppy.sh]𝐂𝐥𝐢𝐜𝐤[/url]', 'unicode-url')).toHaveLength(0)
  })
})

describe('osu-titled-spoilerbox (osu! only)', () => {
  const source = '[notice]antes[spoilerbox=Mi collab]contenido[/spoilerbox]después[/notice]'

  it('is information in osu!, nothing in Miliastry (where it exists)', () => {
    const [d] = only(source, 'osu-titled-spoilerbox')
    expect(d.severity).toBe('info')
    expect(only(source, 'osu-titled-spoilerbox', 'miliastry')).toHaveLength(0)
    expect(only('[spoilerbox]x[/spoilerbox]', 'osu-titled-spoilerbox')).toHaveLength(0)
  })

  it('the fix writes what the export writes: [box=…]', () => {
    expect(fixAll(source, 'osu-titled-spoilerbox')).toBe('[notice]antes[box=Mi collab]contenido[/box]después[/notice]')
  })
})

describe('osu-nested-alignment (osu! only)', () => {
  it('a [centre] opened inside another: unwrapping it keeps every line centred', () => {
    const source = '[centre]About\n[centre]My stuff[/centre]\n[centre]Team[/centre]\n[/centre]'
    const found = only(source, 'osu-nested-alignment')
    expect(found).toHaveLength(2)
    expect(only(source, 'osu-nested-alignment', 'miliastry')).toHaveLength(0)
    expect(fixAll(source, 'osu-nested-alignment')).toBe('[centre]About\nMy stuff\nTeam\n[/centre]')
  })

  it('siblings are not nested', () => {
    expect(only('[centre]a[/centre]\n[centre]b[/centre]', 'osu-nested-alignment')).toHaveLength(0)
  })
})

describe('gradient-outlier', () => {
  const run = (colors: string[]) => colors.map((c, i) => `[color=${c}]${'abcdefgh'[i]}[/color]`).join('')

  it('one colour that breaks a smooth run — the letter it hides', () => {
    const source = run(['#11FF00', '#12FF00', '#293F27', '#14FF00', '#15FF00'])
    const [d] = only(source, 'gradient-outlier')
    expect(d.message).toContain('#13FF00')
    expect(fixAll(source, 'gradient-outlier')).toBe(run(['#11FF00', '#12FF00', '#13FF00', '#14FF00', '#15FF00']))
  })

  it('an accent between two equal colours is a choice', () => {
    expect(only('[color=#FF75FD]♡[/color] ٠ [color=#f573bd]♡[/color] ٠ [color=#FF75FD]♡[/color][color=#FF75FD]x[/color]', 'gradient-outlier')).toHaveLength(0)
  })

  it('alternating colours are a pattern', () => {
    expect(only(run(['#FF0000', '#0000FF', '#FF0000', '#0000FF', '#FF0000']), 'gradient-outlier')).toHaveLength(0)
  })

  it('a smooth run has nothing to report', () => {
    expect(only(run(['#000000', '#202020', '#404040', '#606060', '#808080']), 'gradient-outlier')).toHaveLength(0)
  })
})

describe('empty-tag: a value is not content', () => {
  it('[size=90][/size] and [color=#fff][/color] paint nothing', () => {
    const source = 'a[size=90][/size]b[color=#ffffff][/color]c'
    expect(only(source, 'empty-tag')).toHaveLength(2)
    expect(fixAll(source, 'empty-tag')).toBe('abc')
  })

  it('a valued tag with content is not empty', () => {
    expect(only('[size=90]x[/size]', 'empty-tag')).toHaveLength(0)
  })
})
