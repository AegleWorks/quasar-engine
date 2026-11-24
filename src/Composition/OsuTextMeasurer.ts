/**
 * Text width on osu!, in CSS pixels, without a DOM.
 *
 * osu! draws BBCode text in Inter (`.bbcode { font-family: Inter, sans-serif }`,
 * osu-web's `@font-content`), a webfont it serves itself, with real Italic,
 * Bold and BoldItalic faces. So a run of text is the same width on every
 * device. This measurer shapes a run the way Chrome's HarfBuzz does —
 * cmap → default-on ligatures → GPOS `kern` pair adjustments → sum of
 * advances — from the tables `osuFontMetrics.ts` carries. Pinned to Chrome
 * by `Composition.measure.test.ts`.
 *
 * Kerning is carried for Latin and punctuation only (see the generator); a
 * character Inter does not map falls back to a device font whose width is
 * unknowable here, so `measure` reports it in `unmapped` instead of guessing.
 */

import { OSU_FONT_METRICS } from './osuFontMetrics'

type KernSubtable =
  | { f: 1; cov: number[]; pairs: number[] }
  | { f: 2; cov: number[]; c1: number[]; c2: number[]; m: number[] }

/** The generated tables (`scripts/composition/generate-font-metrics.py`). */
export interface FontMetrics {
  upm: number
  /** Code points, delta-coded. */
  cp: number[]
  /** Local glyph id of each code point in `cp`. */
  glyph: number[]
  /** `[components, ligature]`, longest first. */
  liga: [number[], number][]
  faces: Record<FaceKey, { adv: number[]; kern: KernSubtable[][] }>
}

type FaceKey = 'regular' | 'italic' | 'bold' | 'boldItalic'

/** What a run of text looks like, as far as its width is concerned. */
export interface RunStyle {
  bold?: boolean
  italic?: boolean
  /** Font size in CSS pixels. */
  px: number
}

export interface Measurement {
  width: number
  /** Characters Inter does not have; their width above counts as zero. */
  unmapped: string[]
}

/** osu!'s userpage text size (`.page-extra { font-size: 14px }`). */
export const OSU_BASE_PX = 14

interface PreparedSubtable {
  coverage: Set<number>
  /** Format 1: `a * 65536 + b` → adjustment (a zero stops the search too). */
  pairs?: Map<number, number>
  /** Format 2. */
  c1?: Map<number, number>
  c2?: Map<number, number>
  cells?: Map<number, number>
}

interface PreparedFace {
  adv: number[]
  kern: PreparedSubtable[][]
}

interface Prepared {
  cmap: Map<number, number>
  faces: Record<FaceKey, PreparedFace>
}

let prepared: Prepared | null = null

function pairsOf(flat: number[]): Map<number, number> {
  const out = new Map<number, number>()
  for (let i = 0; i < flat.length; i += 2) out.set(flat[i], flat[i + 1])
  return out
}

function prepare(): Prepared {
  if (prepared) return prepared
  const m = OSU_FONT_METRICS
  const cmap = new Map<number, number>()
  let cp = 0
  for (let i = 0; i < m.cp.length; i++) {
    cp += m.cp[i]
    cmap.set(cp, m.glyph[i])
  }
  const faces = {} as Record<FaceKey, PreparedFace>
  for (const key of Object.keys(m.faces) as FaceKey[]) {
    const face = m.faces[key]
    faces[key] = {
      adv: face.adv,
      kern: face.kern.map((lookup) => lookup.map((st): PreparedSubtable => {
        const coverage = new Set(st.cov)
        if (st.f === 1) {
          const pairs = new Map<number, number>()
          for (let i = 0; i < st.pairs.length; i += 3) pairs.set(st.pairs[i] * 65536 + st.pairs[i + 1], st.pairs[i + 2])
          return { coverage, pairs }
        }
        const cells = new Map<number, number>()
        for (let i = 0; i < st.m.length; i += 3) cells.set(st.m[i] * 65536 + st.m[i + 1], st.m[i + 2])
        return { coverage, c1: pairsOf(st.c1), c2: pairsOf(st.c2), cells }
      })),
    }
  }
  prepared = { cmap, faces }
  return prepared
}

function faceKey(style: RunStyle): FaceKey {
  if (style.bold) return style.italic ? 'boldItalic' : 'bold'
  return style.italic ? 'italic' : 'regular'
}

/** Width of one plain U+0020 at `px`: the padding step. */
export function spaceWidth(px = OSU_BASE_PX): number {
  const p = prepare()
  return (p.faces.regular.adv[p.cmap.get(32)!] * px) / OSU_FONT_METRICS.upm
}

/** Local glyph ids after ligatures; unmapped characters are collected. */
function shape(cmap: Map<number, number>, text: string, unmapped: string[]): number[] {
  const glyphs: number[] = []
  for (const ch of text) {
    // U+200B is default-ignorable: Chrome draws nothing and advances nothing.
    if (ch === '​') continue
    const g = cmap.get(ch.codePointAt(0)!)
    if (g === undefined) {
      unmapped.push(ch)
      continue
    }
    glyphs.push(g)
  }
  const liga = OSU_FONT_METRICS.liga
  if (liga.length === 0) return glyphs
  const out: number[] = []
  for (let i = 0; i < glyphs.length; ) {
    let matched = false
    for (const [components, lig] of liga) {
      if (components[0] !== glyphs[i] || i + components.length > glyphs.length) continue
      let ok = true
      for (let k = 1; k < components.length; k++) {
        if (glyphs[i + k] !== components[k]) { ok = false; break }
      }
      if (ok) {
        out.push(lig)
        i += components.length
        matched = true
        break
      }
    }
    if (!matched) out.push(glyphs[i++])
  }
  return out
}

/**
 * The kern adjustment between `a` and `b` in one lookup: the first subtable
 * whose coverage holds `a` and that applies (HarfBuzz's PairPos semantics —
 * format 1 falls through when the pair is absent, format 2 always applies).
 */
function kernIn(lookup: PreparedSubtable[], a: number, b: number): number {
  for (const st of lookup) {
    if (!st.coverage.has(a)) continue
    if (st.pairs) {
      const v = st.pairs.get(a * 65536 + b)
      if (v !== undefined) return v
      continue
    }
    const k1 = st.c1!.get(a) ?? 0
    const k2 = st.c2!.get(b) ?? 0
    return st.cells!.get(k1 * 65536 + k2) ?? 0
  }
  return 0
}

/**
 * `text` as CSS `white-space: normal` keeps it: a run of ASCII spaces, tabs
 * and newlines draws as one space. U+200B is not white space to CSS, so
 * `' ​ '` keeps both spaces — the padding trick depends on that.
 */
export function collapseSpaces(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, ' ')
}

/** Width of `text` drawn in one style, as Chrome lays it out on osu!. */
export function measure(text: string, style: RunStyle): Measurement {
  const p = prepare()
  const face = p.faces[faceKey(style)]
  const unmapped: string[] = []
  const glyphs = shape(p.cmap, text, unmapped)
  let units = 0
  for (let i = 0; i < glyphs.length; i++) {
    units += face.adv[glyphs[i]]
    if (i + 1 < glyphs.length) {
      for (const lookup of face.kern) units += kernIn(lookup, glyphs[i], glyphs[i + 1])
    }
  }
  return { width: (units * style.px) / OSU_FONT_METRICS.upm, unmapped }
}
