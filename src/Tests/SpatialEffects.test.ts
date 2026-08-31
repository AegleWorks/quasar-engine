import { describe, it, expect } from 'vitest'
import {
  buildSampleTable, buildRangeScope, documentScope, axisValue, spatialPoint,
  maskValue, maskDistance, evaluateEffect,
  parsePaintGrid, samplePaintGrid, stringifyPaintCells, stringifyPaintPalette,
  parseEffectParams, stringifyEffectParams,
  DEFAULT_SPATIAL, GRADIENT_DEFAULTS,
  type SampleContext, type PaintGrid,
} from '../Utils/EffectMath'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { TagRegistry } from '../Model/TagRegistry'
import type { RedNode } from '../Syntax/RedNode'

/**
 * The placeable half of the effect kernel: visual columns, aspect-corrected
 * geometry, shape masks and paint grids.
 *
 * These are the properties the older, centred axes never had to hold — an
 * effect could not be put anywhere, so nothing could be off-centre. The
 * tests below pin the three that are easy to get wrong and invisible in a
 * screenshot: that spaces count as layout, that a circle is round rather
 * than oval, and that a grid never shears.
 */

function ctxAt(text: string, offset: number): SampleContext {
  const table = buildSampleTable(text)
  const scope = documentScope(table)
  return { sample: table.samples[offset], scope, table, local: table.samples[offset].index }
}

describe('visual columns', () => {
  it('counts spaces, while `col` still skips them', () => {
    const table = buildSampleTable('  ab')
    // `col` is the ramp coordinate: the space costs nothing.
    expect(table.samples[2].col).toBe(0)
    expect(table.samples[3].col).toBe(1)
    // `rawCol` is the geometry coordinate: the indentation is real.
    expect(table.samples[2].rawCol).toBe(2)
    expect(table.samples[3].rawCol).toBe(3)
  })

  it('measures the widest line', () => {
    const table = buildSampleTable('ab\n     x\nc')
    expect(table.maxCols).toBe(6)
    expect(table.rawLineLengths).toEqual([2, 6, 1])
    expect(table.lineLengths).toEqual([2, 1, 1])
  })

  it('resets the column at every line', () => {
    const table = buildSampleTable('ab\ncd')
    expect(table.samples[3].rawCol).toBe(0)
    expect(table.samples[4].rawCol).toBe(1)
  })

  it('bounds a range by its painted characters, ignoring trailing space', () => {
    const table = buildSampleTable('  ab   ')
    const scope = buildRangeScope(table, 0, 7)
    expect(scope.rawColMin).toBe(2)
    expect(scope.rawColMax).toBe(3)
  })
})

describe('spatial geometry', () => {
  it('spreads x across the painted box and centres a single line', () => {
    const text = 'abcde'
    expect(spatialPoint(ctxAt(text, 0)).x).toBeCloseTo(0, 6)
    expect(spatialPoint(ctxAt(text, 4)).x).toBeCloseTo(1, 6)
    // One line tall: every character sits at the box's own middle.
    expect(spatialPoint(ctxAt(text, 2)).y).toBeCloseTo(0.5, 6)
  })

  it('places an indented block by where it is seen, not by its letter count', () => {
    //     "ab"  on line 0 at columns 0-1
    //  "    cd" on line 1 at columns 4-5
    const text = 'ab\n    cd'
    // The box spans columns 0..5. `c` sits at column 4 of 5.
    expect(spatialPoint(ctxAt(text, 7)).x).toBeCloseTo(4 / 5, 6)
    // Reading `col` instead would have put it at 0 — flush left, sheared.
    expect(ctxAt(text, 7).scope.localCol[7]).toBe(0)
  })

  it('corrects for the cell being taller than it is wide', () => {
    // Two lines of two characters. Physically that box is much wider than
    // tall only if cells were square; with aspect 0.5 it is nearly so.
    const pt = spatialPoint(ctxAt('ab\ncd', 0), 0.5)
    expect(pt.w).toBeCloseTo(0.5, 6)
    expect(pt.h).toBeCloseTo(1, 6)
    // The longer physical side is always normalised to 1.
    expect(Math.max(pt.w, pt.h)).toBeCloseTo(1, 6)
  })
})

describe('placeable axes', () => {
  const text = 'aaaaa\naaaaa\naaaaa'

  it('spot reads 0 at its origin and grows outward', () => {
    const atOrigin = axisValue('spot', ctxAt(text, 8), 0, { ...DEFAULT_SPATIAL, radius: 1 })
    expect(atOrigin).toBeCloseTo(0, 5)
    const atCorner = axisValue('spot', ctxAt(text, 0), 0, { ...DEFAULT_SPATIAL, radius: 1 })
    expect(atCorner).toBeGreaterThan(atOrigin)
  })

  it('spot honours a moved origin', () => {
    const geo = { ...DEFAULT_SPATIAL, originX: 0, originY: 0, radius: 1 }
    // Top-left character is now the origin.
    expect(axisValue('spot', ctxAt(text, 0), 0, geo)).toBeCloseTo(0, 5)
    expect(axisValue('spot', ctxAt(text, 16), 0, geo)).toBeGreaterThan(0.5)
  })

  it('linear puts its origin at the ramp midpoint', () => {
    const geo = { ...DEFAULT_SPATIAL, radius: 1, angle: 0 }
    expect(axisValue('linear', ctxAt(text, 8), 0, geo)).toBeCloseTo(0.5, 5)
    // Angle 0 runs left-to-right, so the left edge is below the middle.
    expect(axisValue('linear', ctxAt(text, 6), 0, geo)).toBeLessThan(0.5)
    expect(axisValue('linear', ctxAt(text, 10), 0, geo)).toBeGreaterThan(0.5)
  })

  it('leaves the legacy centred axes untouched', () => {
    const square = 'abc\ndef\nghi'
    expect(axisValue('radial', ctxAt(square, 5))).toBeCloseTo(0, 5)
    expect(axisValue('radial', ctxAt(square, 0))).toBeCloseTo(1, 5)
  })
})

describe('masks', () => {
  const grid = Array(9).fill('#########').join('\n')

  it('none covers everything', () => {
    expect(maskValue(ctxAt(grid, 40))).toBe(1)
    expect(maskValue(ctxAt(grid, 0), { shape: 'none' })).toBe(1)
  })

  it('a circle covers its middle and excludes the corners', () => {
    const opts = { shape: 'circle' as const, width: 0.3, aspect: 1 }
    const centre = 4 * 10 + 4
    expect(maskValue(ctxAt(grid, centre), opts)).toBe(1)
    expect(maskValue(ctxAt(grid, 0), opts)).toBe(0)
  })

  it('a circle is round, not oval', () => {
    // A 9x9 block of square cells is a square box, so the distance from
    // the centre to the middle of any edge must be the same.
    const opts = { shape: 'circle' as const, width: 0.5, aspect: 1 }
    const left = maskDistance(ctxAt(grid, 4 * 10 + 0), opts)
    const right = maskDistance(ctxAt(grid, 4 * 10 + 8), opts)
    const top = maskDistance(ctxAt(grid, 0 * 10 + 4), opts)
    const bottom = maskDistance(ctxAt(grid, 8 * 10 + 4), opts)
    expect(left).toBeCloseTo(right, 6)
    expect(top).toBeCloseTo(bottom, 6)
    expect(left).toBeCloseTo(top, 6)
  })

  it('an uncorrected aspect is what makes it oval', () => {
    // The regression this guards: with cells half as wide as tall, the
    // horizontal reach is NOT the vertical one.
    const opts = { shape: 'circle' as const, width: 0.5, aspect: 0.5 }
    const left = maskDistance(ctxAt(grid, 4 * 10 + 0), opts)
    const top = maskDistance(ctxAt(grid, 0 * 10 + 4), opts)
    expect(left).not.toBeCloseTo(top, 3)
  })

  it('invert keeps the outside instead', () => {
    const opts = { shape: 'circle' as const, width: 0.3, aspect: 1, invert: true }
    expect(maskValue(ctxAt(grid, 4 * 10 + 4), opts)).toBe(0)
    expect(maskValue(ctxAt(grid, 0), opts)).toBe(1)
  })

  it('feather produces partial coverage at the edge', () => {
    const hard = { shape: 'circle' as const, width: 0.3, aspect: 1, feather: 0 }
    const soft = { shape: 'circle' as const, width: 0.3, aspect: 1, feather: 0.4 }
    const values = Array.from({ length: 9 }, (_, i) => maskValue(ctxAt(grid, 4 * 10 + i), soft))
    expect(values.some(v => v > 0 && v < 1)).toBe(true)
    // A hard mask is only ever fully in or fully out.
    const hardValues = Array.from({ length: 9 }, (_, i) => maskValue(ctxAt(grid, 4 * 10 + i), hard))
    expect(hardValues.every(v => v === 0 || v === 1)).toBe(true)
  })

  it('every shape covers its own centre and misses a far corner', () => {
    const shapes = ['circle', 'ellipse', 'square', 'rect', 'diamond', 'triangle', 'star', 'ring'] as const
    for (const shape of shapes) {
      const opts = { shape, width: 0.34, height: 0.34, aspect: 1, inner: 0.5 }
      // A ring is hollow in the middle by definition, so it is measured on
      // its band rather than its hole.
      const probe = shape === 'ring' ? 4 * 10 + 8 : 4 * 10 + 4
      expect(maskValue(ctxAt(grid, probe), opts), `${shape} covers its body`).toBe(1)
      expect(maskValue(ctxAt(grid, 0), opts), `${shape} misses the corner`).toBe(0)
    }
  })

  it('a star has points: some directions reach further than others', () => {
    const opts = { shape: 'star' as const, width: 0.45, aspect: 1, points: 5, inner: 0.1 }
    const ring = Array.from({ length: 9 }, (_, i) => maskDistance(ctxAt(grid, 8 * 10 + i), opts))
    expect(Math.max(...ring) - Math.min(...ring)).toBeGreaterThan(0.05)
  })
})

describe('masked effects', () => {
  const text = 'aaaaa\naaaaa\naaaaa'

  it('leaves masked-out characters with no colour at all', () => {
    const segs = evaluateEffect(text, 'gradient', {
      colors: ['#FF0000', '#0000FF'],
      maskShape: 'circle', maskWidth: 0.2, aspect: 1,
    })
    expect(segs.some(s => s.color === undefined && s.text.includes('a'))).toBe(true)
    expect(segs.some(s => s.color !== undefined)).toBe(true)
  })

  it('a full-coverage mask changes nothing', () => {
    const plain = evaluateEffect(text, 'gradient', { colors: ['#FF0000', '#0000FF'] })
    const masked = evaluateEffect(text, 'gradient', {
      colors: ['#FF0000', '#0000FF'], maskShape: 'circle', maskWidth: 50, aspect: 1,
    })
    expect(masked).toEqual(plain)
  })

  it('fades toward a known base colour at a feathered edge', () => {
    const withBase = evaluateEffect(text, 'gradient', {
      colors: ['#FFFFFF', '#FFFFFF'],
      maskShape: 'circle', maskWidth: 0.3, maskFeather: 0.5, aspect: 1,
      baseColor: '#000000',
    })
    const partial = withBase.filter(s => s.color !== undefined && s.color !== '#FFFFFF')
    expect(partial.length).toBeGreaterThan(0)
  })

  it('without a base colour a partial weight is a hard cut, never a wrong colour', () => {
    const segs = evaluateEffect(text, 'gradient', {
      colors: ['#FFFFFF', '#FFFFFF'],
      maskShape: 'circle', maskWidth: 0.3, maskFeather: 0.5, aspect: 1,
    })
    for (const seg of segs) {
      if (seg.color !== undefined) expect(seg.color).toBe('#FFFFFF')
    }
  })
})

describe('paint grids', () => {
  const grid: PaintGrid = {
    cols: 2, rows: 2,
    palette: ['#FF0000', '#00FF00'],
    cells: Int16Array.from([0, 1, 1, -1]),
  }

  it('round-trips through the attribute form', () => {
    const cells = stringifyPaintCells(grid)
    const palette = stringifyPaintPalette(grid.palette)
    expect(cells).toBe('1220')
    expect(palette).toBe('FF0000,00FF00')

    const back = parsePaintGrid(2, 2, palette, cells)
    expect(back).not.toBeNull()
    expect(back!.palette).toEqual(grid.palette)
    expect(Array.from(back!.cells)).toEqual([0, 1, 1, -1])
  })

  it('refuses a cell count that does not match its dimensions', () => {
    // A grid off by one cell shears diagonally across the whole block.
    expect(parsePaintGrid(2, 2, 'FF0000', '121')).toBeNull()
    expect(parsePaintGrid(2, 2, 'FF0000', '12211')).toBeNull()
    expect(parsePaintGrid(0, 2, 'FF0000', '')).toBeNull()
  })

  it('samples the nearest cell by default', () => {
    expect(samplePaintGrid(grid, 0, 0)).toBe('#FF0000')
    expect(samplePaintGrid(grid, 1, 0)).toBe('#00FF00')
    expect(samplePaintGrid(grid, 1, 1)).toBeUndefined()
  })

  it('smooth interpolates between neighbouring cells', () => {
    const mid = samplePaintGrid(grid, 0.5, 0, true)
    expect(mid).not.toBe('#FF0000')
    expect(mid).not.toBe('#00FF00')
  })

  it('lets a neighbour win beside a hole rather than half-fading into it', () => {
    // Partial transparency is not expressible in a [color] tag, so the
    // approach to a hole takes the colour that is actually there.
    expect(samplePaintGrid(grid, 0.75, 1, true)).toBe('#00FF00')
    // Dead centre of the hole all four samples ARE the hole, and the
    // honest answer is to paint nothing.
    expect(samplePaintGrid(grid, 1, 1, true)).toBeUndefined()
  })

  it('paints a block of text without moving a character', () => {
    const art = '##\n##'
    const segs = evaluateEffect(art, 'paint', {
      gridCols: 2, gridRows: 2,
      palette: 'FF0000,00FF00,0000FF,FFFF00',
      cells: '1234',
      aspect: 1,
    })
    // The text is the invariant: an image colours characters, it never
    // adds, removes or reorders one.
    expect(segs.map(s => s.text).join('')).toBe(art)
    const colored = segs.filter(s => s.color !== undefined)
    expect(colored.map(s => s.color)).toEqual(['#FF0000', '#00FF00', '#0000FF', '#FFFF00'])
  })

  it('still merges neighbours that resolve to the same colour', () => {
    // Two greens either side of a line break cost one tag, not two — the
    // same collapse every other effect gets, and the reason a painted
    // block fits the export budget at all.
    const segs = evaluateEffect('##\n##', 'paint', {
      gridCols: 2, gridRows: 2, palette: 'FF0000,00FF00', cells: '1221', aspect: 1,
    })
    expect(segs.map(s => s.text).join('')).toBe('##\n##')
    expect(segs.filter(s => s.color !== undefined).map(s => s.color))
      .toEqual(['#FF0000', '#00FF00', '#FF0000'])
  })

  it('leaves text untouched where the grid has a hole', () => {
    const segs = evaluateEffect('##', 'paint', {
      gridCols: 2, gridRows: 1, palette: 'FF0000', cells: '10', aspect: 1,
    })
    expect(segs.map(s => s.text).join('')).toBe('##')
    expect(segs[0].color).toBe('#FF0000')
    expect(segs[1].color).toBeUndefined()
  })

  it('renders nothing rather than guessing when the grid is malformed', () => {
    const segs = evaluateEffect('##', 'paint', {
      gridCols: 2, gridRows: 1, palette: 'FF0000', cells: '1', aspect: 1,
    })
    expect(segs.map(s => s.text).join('')).toBe('##')
    expect(segs.every(s => s.color === undefined)).toBe(true)
  })
})

describe('attribute grammar', () => {
  it('round-trips placement and mask parameters', () => {
    const attr = 'ox=0.25;oy=0.75;ang=45;rad=0.3;mask=star;mpts=6;mrat=0.2;minv=1'
    const params = parseEffectParams(attr)
    expect(params.originX).toBe(0.25)
    expect(params.originY).toBe(0.75)
    expect(params.angle).toBe(45)
    expect(params.radius).toBe(0.3)
    expect(params.maskShape).toBe('star')
    expect(params.maskPoints).toBe(6)
    expect(params.maskInner).toBe(0.2)
    expect(params.maskInvert).toBe(true)
  })

  it('preserves the case of a cell map, which is case-significant', () => {
    const params = parseEffectParams('cols=2;rows=1;pal=FF0000,00FF00;map=Az')
    expect(params.cells).toBe('Az')
    expect(params.palette).toBe('FF0000,00FF00')
  })

  it('writes nothing for parameters left at their default', () => {
    const attr = stringifyEffectParams(
      { colors: ['#FF0000', '#00FF00'] },
      GRADIENT_DEFAULTS,
    )
    expect(attr).toBe('#FF0000,#00FF00')
    expect(attr).not.toContain('mask')
    expect(attr).not.toContain('ox=')
  })

  it('survives a full round trip through the attribute', () => {
    const before = {
      colors: ['#FF0000', '#00FF00'],
      axis: 'spot' as const, originX: 0.2, originY: 0.8, radius: 0.4,
      maskShape: 'triangle' as const, maskWidth: 0.35, maskFeather: 0.05,
    }
    const after = parseEffectParams(stringifyEffectParams(before, GRADIENT_DEFAULTS))
    expect(after.axis).toBe('spot')
    expect(after.originX).toBe(0.2)
    expect(after.originY).toBe(0.8)
    expect(after.radius).toBe(0.4)
    expect(after.maskShape).toBe('triangle')
    expect(after.maskWidth).toBe(0.35)
    expect(after.maskFeather).toBe(0.05)
  })
})

describe('the [paint] tag, end to end', () => {
  /** The parser wraps inline tags in a paragraph, so look past it. */
  function findKind(node: RedNode, kind: string): RedNode | undefined {
    if (node.kind === kind) return node
    for (const child of node.children) {
      const hit = findKind(child, kind)
      if (hit) return hit
    }
    return undefined
  }

  it('parses, previews and exports without touching the text', () => {
    const source = '[paint=cols=2;rows=2;pal=FF0000,00FF00,0000FF,FFFF00;map=1234;asp=1]##\n##[/paint]'
    const model = new BBCodeDocumentModel({ source })
    const node = findKind(model.redRoot!, 'paint')

    expect(node, 'the tag is registered and parsed').toBeDefined()
    expect(node!.metadata.gridCols).toBe(2)
    expect(node!.metadata.cells).toBe('1234')

    // Preview and export are the same evaluator, so the four colours have
    // to appear in both.
    const html = new HTMLRenderer().render(model.redRoot!)
    for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#FFFF00']) {
      expect(html, `preview paints ${hex}`).toContain(hex)
    }

    const osu = new BBCodeExporter(new TagRegistry(), 'osu').export(model.redRoot!)
    expect(osu).toContain('[color=#FF0000]')
    expect(osu).toContain('[color=#FFFF00]')
    // The characters survive the expansion, in order. This is the whole
    // promise of the feature: an image colours ASCII art, it never
    // redraws it.
    expect(osu.replace(/\[[^\]]*\]/g, '')).toBe('##\n##')
  })

  it('keeps a placeable, masked gradient as one tag through a Miliastry round trip', () => {
    const source = '[gradient=#FF0000,#0000FF;axis=spot;ox=0.2;oy=0.8;rad=0.4;mask=star;mpts=6]hello world[/gradient]'
    const model = new BBCodeDocumentModel({ source })
    const out = new BBCodeExporter(new TagRegistry(), 'miliastry').export(model.redRoot!)

    // Compact, not expanded: the placement survives as parameters.
    expect(out).toContain('[gradient=')
    expect(out).not.toContain('[color=')

    const back = new BBCodeDocumentModel({ source: out })
    const node = findKind(back.redRoot!, 'gradient')!
    expect(node.metadata.axis).toBe('spot')
    expect(node.metadata.originX).toBe(0.2)
    expect(node.metadata.originY).toBe(0.8)
    expect(node.metadata.radius).toBe(0.4)
    expect(node.metadata.maskShape).toBe('star')
    expect(node.metadata.maskPoints).toBe(6)
  })
})
