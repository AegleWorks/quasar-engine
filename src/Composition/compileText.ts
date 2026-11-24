/**
 * `[composition]` → plain osu! BBCode, columns placed with spaces.
 *
 * osu! has no columns, but its BBCode text is drawn in a webfont it serves
 * itself (Inter, `.bbcode { font-family: Inter, sans-serif }`), so U+0020 is
 * the same width on every device. Repeated spaces collapse to one, so the
 * padding interleaves them with U+200B, which CSS does not count as white
 * space and Unicode says to draw as nothing: `' \u200b' × n` is exactly n
 * spaces wide (measured in Chrome, and kept by osu!'s purifier — run through
 * the osu-web harness). A line that starts with padding opens with a U+200B,
 * because spaces at the start of a line are dropped.
 *
 * Text is measured with `OsuTextMeasurer`, so a pane's lines wrap where osu!
 * would wrap them, and each pane's line starts at the pane's x to within half
 * a space (~2 px). Pane content is inline BBCode (b, i, u, s, color, size,
 * url, profile); anything else is flattened to its text and reported.
 *
 * Desktop only by nature: a line wider than the reader's screen wraps and
 * the columns fall apart. `issues` says so when the composition is wider
 * than osu!'s userpage.
 */

import type { RedNode } from '../Syntax/RedNode'
import { collapseSpaces, measure, OSU_BASE_PX, spaceWidth } from './OsuTextMeasurer'
import {
  OSU_USERPAGE_WIDTH,
  parseCompositionSpec,
  parsePaneSpec,
  placePanes,
  type PaneAlign,
} from './compositionSpec'

export interface CompositionIssue {
  code: 'unsupported-content' | 'unmeasured-character' | 'pane-overflow' | 'wider-than-osu' | 'stray-content'
  /** Source range the issue is about. */
  range: { start: number; end: number }
  detail?: string
}

export interface TextCompilation {
  bbcode: string
  issues: CompositionIssue[]
}

const ZWSP = '​'

/** Room kept free at the right edge, in px, so subpixel layout never wraps a line. */
const EDGE_MARGIN = 1

interface Style {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color: string | null
  /** Font size in CSS px. */
  px: number
  /** osu! `[size=…]` value that produced `px`, or null at the base size. */
  size: number | null
  href: string | null
  profile: string | null
}

const BASE: Style = {
  bold: false, italic: false, underline: false, strike: false,
  color: null, px: OSU_BASE_PX, size: null, href: null, profile: null,
}

/** A piece of text in one style. */
interface Piece {
  text: string
  style: Style
}

/** One line of a pane, already measured. */
interface PaneLine {
  pieces: Piece[]
  width: number
}

const INLINE_STYLE_KINDS = new Set(['bold', 'italic', 'underline', 'strikethrough', 'color', 'font_size', 'url', 'profile'])
const TRANSPARENT_KINDS = new Set(['paragraph'])
const BREAK_KINDS = new Set(['spacing', 'empty_line'])

function withNode(style: Style, node: RedNode): Style {
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  switch (node.kind) {
    case 'bold': return { ...style, bold: true }
    case 'italic': return { ...style, italic: true }
    case 'underline': return { ...style, underline: true }
    case 'strikethrough': return { ...style, strike: true }
    case 'color': return { ...style, color: String(meta.color ?? '') || null }
    case 'font_size': {
      // osu-web clamps `[size]` to 30–200 % of the enclosing size.
      const n = Number.parseInt(String(meta.size ?? ''), 10)
      if (!Number.isFinite(n)) return style
      const size = Math.max(30, Math.min(200, n))
      return { ...style, size, px: (style.px * size) / 100 }
    }
    case 'url': return { ...style, href: String(meta.href ?? '') || null }
    case 'profile': return { ...style, profile: String(meta.username ?? '') || '' }
    default: return style
  }
}

function plainText(node: RedNode): string {
  if (node.kind === 'text') return node.text
  if (BREAK_KINDS.has(node.kind)) return ' '
  return node.children.map(plainText).join('')
}

/**
 * A pane's content as paragraphs of styled pieces, split at hard breaks.
 * The profile tag's username is its visible text, so it is a piece too.
 */
function paragraphsOf(nodes: readonly RedNode[], issues: CompositionIssue[]): Piece[][] {
  const paragraphs: Piece[][] = [[]]
  const walk = (node: RedNode, style: Style): void => {
    for (const child of node.children) {
      if (child.kind === 'text') {
        paragraphs[paragraphs.length - 1].push({ text: child.text, style })
      } else if (BREAK_KINDS.has(child.kind)) {
        paragraphs.push([])
      } else if (INLINE_STYLE_KINDS.has(child.kind)) {
        walk(child, withNode(style, child))
      } else if (TRANSPARENT_KINDS.has(child.kind)) {
        walk(child, style)
      } else {
        issues.push({ code: 'unsupported-content', range: child.range, detail: child.kind })
        const text = plainText(child)
        if (text) paragraphs[paragraphs.length - 1].push({ text, style })
      }
    }
  }
  for (const node of nodes) walk({ children: [node] } as unknown as RedNode, BASE)
  // The newline right after `[pane]` and right before `[/pane]` is layout, not content.
  while (paragraphs.length > 1 && paragraphs[0].every((p) => p.text.trim() === '')) paragraphs.shift()
  while (paragraphs.length > 1 && paragraphs[paragraphs.length - 1].every((p) => p.text.trim() === '')) paragraphs.pop()
  return paragraphs
}

function sameStyle(a: Style, b: Style): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike &&
    a.color === b.color && a.size === b.size && a.px === b.px && a.href === b.href && a.profile === b.profile
}

function widthOf(pieces: readonly Piece[], unmeasured: Set<string>): number {
  let w = 0
  for (const p of pieces) {
    const m = measure(p.text, { px: p.style.px, bold: p.style.bold, italic: p.style.italic })
    for (const ch of m.unmapped) unmeasured.add(ch)
    w += m.width
  }
  return w
}

/** Words of a paragraph: runs of non-space text, each possibly spanning styles. */
function wordsOf(paragraph: readonly Piece[]): { word: Piece[]; space: Piece | null }[] {
  const out: { word: Piece[]; space: Piece | null }[] = []
  let word: Piece[] = []
  for (const piece of paragraph) {
    const parts = collapseSpaces(piece.text).split(/( )/)
    for (const part of parts) {
      if (part === '') continue
      if (part === ' ') {
        if (word.length > 0) out.push({ word, space: { text: ' ', style: piece.style } })
        word = []
      } else {
        word.push({ text: part, style: piece.style })
      }
    }
  }
  if (word.length > 0) out.push({ word, space: null })
  return out
}

/** Split one word wider than the pane into pieces that fit, character by character. */
function breakWord(word: Piece[], max: number, unmeasured: Set<string>): Piece[][] {
  const lines: Piece[][] = []
  let line: Piece[] = []
  let width = 0
  for (const piece of word) {
    for (const ch of piece.text) {
      const w = widthOf([{ text: ch, style: piece.style }], unmeasured)
      if (width + w > max && line.length > 0) {
        lines.push(line)
        line = []
        width = 0
      }
      const last = line[line.length - 1]
      if (last && sameStyle(last.style, piece.style)) last.text += ch
      else line.push({ text: ch, style: piece.style })
      width += w
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

function wrap(paragraphs: Piece[][], max: number, unmeasured: Set<string>): PaneLine[] {
  const lines: PaneLine[] = []
  for (const paragraph of paragraphs) {
    let line: Piece[] = []
    let pendingSpace: Piece | null = null
    const flush = () => {
      lines.push({ pieces: line, width: widthOf(line, unmeasured) })
      line = []
      pendingSpace = null
    }
    for (const { word, space } of wordsOf(paragraph)) {
      const candidate = line.length > 0 && pendingSpace ? [...line, pendingSpace, ...word] : [...line, ...word]
      if (widthOf(candidate, unmeasured) <= max || line.length === 0) {
        if (line.length === 0 && widthOf(word, unmeasured) > max) {
          const broken = breakWord(word, max, unmeasured)
          for (let i = 0; i < broken.length - 1; i++) lines.push({ pieces: broken[i], width: widthOf(broken[i], unmeasured) })
          line = broken[broken.length - 1]
        } else {
          line = candidate
        }
      } else {
        flush()
        if (widthOf(word, unmeasured) > max) {
          const broken = breakWord(word, max, unmeasured)
          for (let i = 0; i < broken.length - 1; i++) lines.push({ pieces: broken[i], width: widthOf(broken[i], unmeasured) })
          line = broken[broken.length - 1]
        } else {
          line = [...word]
        }
      }
      pendingSpace = space
    }
    flush()
  }
  return lines
}

/** Merge neighbouring pieces that share a style, so each run opens its tags once. */
function merge(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = []
  for (const p of pieces) {
    const last = out[out.length - 1]
    if (last && sameStyle(last.style, p.style)) last.text += p.text
    else out.push({ text: p.text, style: p.style })
  }
  return out
}

function runBBCode(piece: Piece): string {
  const s = piece.style
  let out = piece.text
  if (s.strike) out = `[s]${out}[/s]`
  if (s.underline) out = `[u]${out}[/u]`
  if (s.italic) out = `[i]${out}[/i]`
  if (s.bold) out = `[b]${out}[/b]`
  if (s.color) out = `[color=${s.color}]${out}[/color]`
  if (s.size !== null) out = `[size=${s.size}]${out}[/size]`
  if (s.profile !== null) out = s.profile ? `[profile=${s.profile}]${out}[/profile]` : `[profile]${out}[/profile]`
  if (s.href) out = `[url=${s.href}]${out}[/url]`
  return out
}

/** `n` padding spaces that do not collapse. */
function pad(n: number, atLineStart: boolean): string {
  if (n <= 0) return ''
  return (atLineStart ? ZWSP : '') + ` ${ZWSP}`.repeat(n)
}

function xFor(align: PaneAlign, x: number, width: number, lineWidth: number): number {
  if (align === 'right') return x + Math.max(0, width - lineWidth)
  if (align === 'centre') return x + Math.max(0, (width - lineWidth) / 2)
  return x
}

/** Compile one `[composition]` node to osu! BBCode. */
export function compileCompositionText(node: RedNode): TextCompilation {
  const issues: CompositionIssue[] = []
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const spec = parseCompositionSpec(typeof meta.spec === 'string' ? meta.spec : undefined)
  const paneNodes: RedNode[] = []
  const stray: RedNode[] = []
  for (const child of node.children) {
    if (child.kind === 'pane') paneNodes.push(child)
    else stray.push(child)
  }
  // Text is never lost: with no panes the whole body is one pane, and text
  // between panes is laid out at full width under the columns (and reported).
  const bodies: (readonly RedNode[])[] = paneNodes.length > 0 ? paneNodes.map((p) => p.children) : [node.children]
  const loose = paneNodes.length > 0 ? stray : []
  for (const child of loose) {
    if (!BREAK_KINDS.has(child.kind) && plainText(child).trim() !== '') issues.push({ code: 'stray-content', range: child.range })
  }
  if (spec.width > OSU_USERPAGE_WIDTH) {
    issues.push({ code: 'wider-than-osu', range: node.range, detail: String(spec.width) })
  }

  const paneSpecs = paneNodes.length > 0
    ? paneNodes.map((p) => parsePaneSpec(typeof p.metadata?.spec === 'string' ? (p.metadata.spec as string) : undefined))
    : [parsePaneSpec(undefined)]
  const paneRanges = paneNodes.length > 0 ? paneNodes.map((p) => p.range) : [node.range]
  const slots = placePanes(spec, paneSpecs)
  const unmeasured = new Set<string>()
  const columns = bodies.map((body, i) => wrap(paragraphsOf(body, issues), slots[i].width, unmeasured))
  const step = spaceWidth()

  const height = Math.max(0, ...columns.map((c) => c.length))
  const lines: string[] = []
  for (let row = 0; row < height; row++) {
    let x = 0
    let out = ''
    for (let p = 0; p < columns.length; p++) {
      const line = columns[p][row]
      if (!line || line.pieces.length === 0) continue
      const target = xFor(paneSpecs[p].align, slots[p].x, slots[p].width, line.width)
      let n = Math.round((target - x) / step)
      // Rounding up must never push the line past the composition's edge: a
      // right-aligned pane ends exactly there, and a line a fraction of a
      // pixel too wide is wrapped by the browser (seen on a live userpage).
      const limit = spec.width - EDGE_MARGIN
      if (x + n * step + line.width > limit) n = Math.floor((limit - line.width - x) / step)
      if (x > 0 && n < 1) {
        // The previous pane ran into this one; keep one space so words don't glue.
        issues.push({ code: 'pane-overflow', range: paneRanges[p] })
        out += ` ${ZWSP}`
        x += step
      } else {
        out += pad(n, out === '')
        x += Math.max(0, n) * step
      }
      out += merge(line.pieces).map(runBBCode).join('')
      x += line.width
    }
    lines.push(out)
  }

  const tail = paragraphsOf(loose, issues).filter((para) => para.some((piece) => piece.text.trim() !== ''))
  for (const line of tail.length > 0 ? wrap(tail, spec.width, unmeasured) : []) {
    lines.push(merge(line.pieces).map(runBBCode).join(''))
  }

  if (unmeasured.size > 0) {
    issues.push({ code: 'unmeasured-character', range: node.range, detail: [...unmeasured].join('') })
  }
  return { bbcode: lines.join('\n'), issues }
}
