import { describe, expect, it } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { renderBBCode } from '../BBCode/BBCodeBatch'
import { isRasterizable } from '../Raster/rasterTags'
import type { RedNode } from '../Syntax/RedNode'
import { compileCompositionText } from './compileText'
import { parseCompositionSpec, parsePaneSpec, placePanes } from './compositionSpec'
import { measure, spaceWidth } from './OsuTextMeasurer'

const ZWSP = '​'
const PAD = ` ${ZWSP}`

function compositionOf(source: string): RedNode {
  const model = new BBCodeDocumentModel({ source })
  const found = model.redRoot!.children.find((c) => c.kind === 'composition')
  if (!found) throw new Error('no composition')
  return found
}

/**
 * Replay a compiled line of plain text: where each run of non-padding text
 * starts and how wide it is, measured the way osu! draws it.
 */
function runsOf(line: string): { x: number; text: string; width: number }[] {
  const step = spaceWidth()
  const runs: { x: number; text: string; width: number }[] = []
  let x = 0
  let rest = line.startsWith(ZWSP) ? line.slice(1) : line
  while (rest.length > 0) {
    if (rest.startsWith(PAD)) {
      x += step
      rest = rest.slice(PAD.length)
      continue
    }
    const next = rest.indexOf(PAD)
    const text = next === -1 ? rest : rest.slice(0, next)
    const width = measure(text, { px: 14 }).width
    runs.push({ x, text, width })
    x += width
    rest = next === -1 ? '' : rest.slice(next)
  }
  return runs
}

const THREE = `[composition]
[pane]pings
ping when you reply
dont excessively ping me.[/pane]
[pane centre]frqs
Unless you dont have a pfp[/pane]
[pane right]dms
i love recieving dms[/pane]
[/composition]`

describe('compileCompositionText', () => {
  it('starts every pane line where the pane is, to within half a space', () => {
    const node = compositionOf(THREE)
    const { bbcode, issues } = compileCompositionText(node)
    expect(issues).toEqual([])
    const spec = parseCompositionSpec(undefined)
    const slots = placePanes(spec, [parsePaneSpec(''), parsePaneSpec('centre'), parsePaneSpec('right')])
    const half = spaceWidth() / 2 + 0.01
    const lines = bbcode.split('\n')
    expect(lines).toHaveLength(3)
    // The left pane's third line has no neighbours.
    expect(runsOf(lines[2])).toEqual([expect.objectContaining({ x: 0, text: 'dont excessively ping me.' })])
    for (const line of lines.slice(0, 2)) {
      const [left, centre, right] = runsOf(line)
      expect(left.x).toBe(0)
      expect(Math.abs(centre.x + centre.width / 2 - (slots[1].x + slots[1].width / 2))).toBeLessThan(half)
      // Right-aligned lines stop short of the edge rather than past it: one
      // pixel over and the browser wraps the line (seen on a live userpage).
      const end = right.x + right.width
      expect(end).toBeLessThanOrEqual(spec.width - 1)
      expect(spec.width - 1 - end).toBeLessThan(spaceWidth())
    }
  })

  it('never makes a line wider than the composition', () => {
    const { bbcode } = compileCompositionText(compositionOf(
      '[composition]\n[pane]ping when you reply[/pane]\n[pane centre]Unless you dont have a pfp[/pane]\n[pane right]i love recieving dms[/pane]\n[/composition]',
    ))
    for (const line of bbcode.split('\n')) {
      const runs = runsOf(line)
      const last = runs[runs.length - 1]
      expect(last.x + last.width).toBeLessThanOrEqual(899)
    }
  })

  it('opens a line that starts with padding with U+200B, or osu! drops the spaces', () => {
    const { bbcode } = compileCompositionText(compositionOf('[composition]\n[pane]a\nb[/pane]\n[pane]only one[/pane]\n[/composition]'))
    const second = bbcode.split('\n')[1]
    expect(second).toBe('b')
    const one = compileCompositionText(compositionOf('[composition]\n[pane][/pane]\n[pane]x[/pane]\n[/composition]')).bbcode
    expect(one.startsWith(ZWSP + PAD)).toBe(true)
  })

  it('wraps a pane at its width, as osu! would', () => {
    const { bbcode } = compileCompositionText(compositionOf(
      '[composition width=300 gap=0]\n[pane=50%]breaking these boundaries results in a block usually.[/pane]\n[pane=50%][/pane]\n[/composition]',
    ))
    for (const line of bbcode.split('\n')) expect(runsOf(line)[0].width).toBeLessThanOrEqual(150)
    expect(bbcode.split('\n').length).toBeGreaterThan(1)
  })

  it('keeps inline formatting and links, one run per style', () => {
    const { bbcode } = compileCompositionText(compositionOf(
      '[composition]\n[pane][b]pings[/b] and [url=https://osu.ppy.sh]my [color=#ff66ab]site[/color][/url][/pane]\n[/composition]',
    ))
    expect(bbcode).toBe('[b]pings[/b] and [url=https://osu.ppy.sh]my [/url][url=https://osu.ppy.sh][color=#ff66ab]site[/color][/url]')
  })

  it('never drops text: no panes is one pane, loose text goes under the columns', () => {
    expect(compileCompositionText(compositionOf('[composition]just text[/composition]')).bbcode).toBe('just text')
    const { bbcode, issues } = compileCompositionText(compositionOf('[composition]\n[pane]a[/pane]\nloose\n[pane]b[/pane]\n[/composition]'))
    expect(bbcode.split('\n')[1]).toBe('loose')
    expect(issues.map((i) => i.code)).toEqual(['stray-content'])
  })

  it('reports what it cannot place instead of guessing', () => {
    const { issues } = compileCompositionText(compositionOf(
      '[composition width=1200]\n[pane][box=x]inside[/box] ⠀[/pane]\n[/composition]',
    ))
    expect(issues.map((i) => i.code).sort()).toEqual(['unmeasured-character', 'unsupported-content', 'wider-than-osu'])
  })
})

describe('[composition] in the engine', () => {
  it('round-trips byte for byte in the Miliastry dialect', () => {
    for (const source of [THREE, '[composition=svg width=640 gap=16]\n[pane=40%]a[/pane]\n[pane=60% right]b[/pane]\n[/composition]\nafter']) {
      const model = new BBCodeDocumentModel({ source })
      expect(new BBCodeExporter(model.tagRegistry, 'miliastry').export(model.redRoot!)).toBe(source)
    }
  })

  it('exports to osu! as padded BBCode with no Miliastry tags left', () => {
    const model = new BBCodeDocumentModel({ source: `before\n${THREE}\nafter` })
    const out = new BBCodeExporter(model.tagRegistry, 'osu').export(model.redRoot!)
    expect(out).not.toMatch(/\[\/?(composition|pane)\b/)
    expect(out).toContain(PAD)
    expect(out.startsWith('before\n')).toBe(true)
    expect(out.endsWith('\nafter')).toBe(true)
  })

  it('previews exactly what the export publishes', () => {
    const source = `before\n${THREE}\nafter`
    const model = new BBCodeDocumentModel({ source })
    const exported = new BBCodeExporter(model.tagRegistry, 'osu').export(model.redRoot!)
    const text = (html: string) => {
      const el = document.createElement('div')
      el.innerHTML = html
      return el.innerText ?? el.textContent
    }
    const preview = new HTMLRenderer({ registry: model.tagRegistry, idMode: 'none' }).render(model.redRoot!)
    expect(text(preview)).toBe(text(renderBBCode(exported)))
  })

  it('sends only svg compositions to the rasterizer', () => {
    expect(isRasterizable(compositionOf('[composition=svg]\n[pane]a[/pane]\n[/composition]'))).toBe(true)
    expect(isRasterizable(compositionOf(THREE))).toBe(false)
  })
})
