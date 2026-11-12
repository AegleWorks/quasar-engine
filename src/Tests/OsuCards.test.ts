import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { cardImageUrl, flagUrl, formatLength, groupNumber, splitMods, starColor } from '../Visitors/osuCards'

const render = (source: string): string => {
  const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
  return new HTMLRenderer({ dialect: 'miliastry', idMode: 'none' }).render(model.redRoot!)
}

describe('osu! cards — helpers', () => {
  it('groups thousands and leaves non-numbers alone', () => {
    expect(groupNumber('12345')).toBe('12,345')
    expect(groupNumber(' 9,876.5 ')).toBe('9,876.5')
    expect(groupNumber('123')).toBe('123')
    expect(groupNumber('1234567')).toBe('1,234,567')
    expect(groupNumber('abc')).toBe('abc')
    expect(groupNumber('12.')).toBe('12.')
  })

  it('formats seconds as m:ss and keeps a written time', () => {
    expect(formatLength('222')).toBe('3:42')
    expect(formatLength('59')).toBe('0:59')
    expect(formatLength('3600')).toBe('60:00')
    expect(formatLength('3:42')).toBe('3:42')
  })

  it('builds the flag from a two-letter code only', () => {
    expect(flagUrl('co')).toBe('https://osu.ppy.sh/assets/images/flags/1f1e8-1f1f4.svg')
    expect(flagUrl('Colombia')).toBe('')
    expect(flagUrl('C1')).toBe('')
  })

  it('accepts only http(s) image URLs', () => {
    expect(cardImageUrl(' https://a.ppy.sh/2 ')).toBe('https://a.ppy.sh/2')
    expect(cardImageUrl('javascript:alert(1)')).toBe('')
    expect(cardImageUrl('//x.y/z.png')).toBe('')
  })

  it('splits mods written together or separated', () => {
    expect(splitMods('hdhr')).toEqual(['HD', 'HR'])
    expect(splitMods('HD, HR + dt')).toEqual(['HD', 'HR', 'DT'])
    expect(splitMods('NM')).toEqual([])
    expect(splitMods('')).toEqual([])
  })

  it("follows osu!'s difficulty spectrum", () => {
    expect(starColor(0.05)).toBe('#AAAAAA')
    expect(starColor(0.1)).toBe('#4290FB')
    expect(starColor(2)).toBe('#4FFFD5')
    expect(starColor(6.7)).toBe('#6563DE')
    expect(starColor(9)).toBe('#000000')
    expect(starColor(NaN)).toBe('#AAAAAA')
    // Between two stops: neither of them.
    expect(starColor(5.35)).not.toBe('#FF4E6F')
    expect(starColor(5.35)).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('osu! cards — render', () => {
  it('never lets an attribute break out of the markup', () => {
    for (const source of [
      '[profilecard user="a<b>&c" avatar="https://x.y/a.png?q=1&r=<2>"][/profilecard]',
      '[beatmap title="a<b" artist="c&d" status="<i>"][/beatmap]',
      '[score title="a<b" mods="<x>" combo="<y>" grade="<z>"]',
      '[progress=50 label="a<b" level="<1>"][/progress]',
    ]) {
      const html = render(source)
      expect(html).not.toMatch(/<(?!\/?(?:div|span|img)\b)/)
      expect(html).not.toContain('"<')
    }
  })

  it('keeps every style attribute whole (no quote inside a style)', () => {
    const html = render('[score grade=S title=T mods=HDHR acc=98.5 pp=456]')
    for (const style of html.match(/style="[^"]*"/g) ?? []) expect(style).toMatch(/;"$/)
    expect(html).toContain('max-width:620px')
  })

  it('shows the profile numbers the way osu! writes them', () => {
    const html = render('[profilecard user=hxovc rank=12345 crank=#7 pp=9876 acc=98.5 country=co][/profilecard]')
    expect(html).toContain('#12,345')
    expect(html).toContain('#7')
    expect(html).toContain('9,876')
    expect(html).toContain('98.50%')
    expect(html).toContain('flags/1f1e8-1f1f4.svg')
    expect(html).toContain('>CO<')
  })

  it('drops an image URL that is not http(s) and falls back to the initial', () => {
    const html = render('[profilecard user=hxovc avatar=javascript:alert(1)][/profilecard]')
    expect(html).not.toContain('<img')
    expect(html).toContain('>H<')
  })

  it('writes the status in capitals itself, since the export reads the DOM text', () => {
    const html = render('[beatmap title=T status=loved sr=5.42 bpm=180 length=222][/beatmap]')
    expect(html).toContain('>LOVED<')
    expect(html).not.toContain('text-transform')
    expect(html).toContain('★ 5.42')
    expect(html).toContain('180 BPM · 3:42')
  })

  it('reads SS as X and gives each mod its own chip', () => {
    const html = render('[score grade=ss title=T mods=hdhr]')
    expect(html).toContain('>SS<')
    expect(html).toContain('>HD<')
    expect(html).toContain('>HR<')
  })

  it('takes a hex colour for the bar and ignores anything else', () => {
    expect(render('[progress=40 color=#66CCFF][/progress]')).toContain('background:#66CCFF')
    expect(render('[progress=40 color=red;x][/progress]')).not.toContain('red')
  })

  it('round-trips the new attributes', () => {
    for (const source of [
      '[profilecard user=hxovc rank=1 crank=2 acc=98.5][/profilecard]',
      '[beatmap title=T bpm=180 length=222][/beatmap]',
    ]) {
      const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
      expect(new BBCodeExporter(model.tagRegistry, 'miliastry').export(model.redRoot!)).toBe(source)
    }
  })
})
