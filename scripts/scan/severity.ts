/**
 * How a divergence LOOKS, not just that it exists. `scan`/`OsuGoldens` treat every page whose
 * preview differs from osu! the same; a missing word and a blank line are not the same problem,
 * and the corpus tail is mostly one-off shapes, so which one to fix first has to come from the
 * reader's view.
 *
 * Both sides are reduced to their visible lines (`Tests/support/visibleLines`), split into
 * change WINDOWS — the aligned regions that differ — and each window is classified:
 *
 *   content    the words are not the same: one side shows text the other does not
 *   structure  same words, different container (a list/box/quote one side opened and the other
 *              did not: the "list breaks completely" family)
 *   style      same words, same container, different style keys (colour, size, bold, href)
 *   spacing    only blank lines moved
 *
 * A page's severity is the worst of its windows, and `direction` says which side lost the text
 * when the kind is `content`. `knownCauses` labels the divergences already understood and
 * deliberately not reproduced (see `.claude/rules/osu.md`), so a ranking can leave them out.
 */
import type { RedNode } from '../../src/Syntax/RedNode'
import { phpTrim, previewDoc, previewHTML, unwrapOsuHtml, visibleLines } from '../../src/Tests/support/visibleLines'

export type SeverityKind = 'content' | 'structure' | 'style' | 'spacing'

export const SEVERITY_RANK: Record<SeverityKind, number> = { content: 3, structure: 2, style: 1, spacing: 0 }

export interface SeverityWindow {
  kind: SeverityKind
  /** Only for `content`: which side shows text the other does not. */
  direction?: 'preview-missing' | 'preview-extra' | 'mixed'
  /** 1-based line where the window opens in each side (0 when that side has nothing left). */
  previewLine: number
  osuLine: number
  /** Lines the window covers in each side. */
  previewLines: number
  osuLines: number
  /** The first text that differs, elided: what to look at. */
  detail: string
  /**
   * The SHAPE of the difference: the same first difference with every word folded to `w` and
   * every number to `#`. One signature is one cause — `[w=w]w[/w] ⇢ w` is "a literal tag leaks",
   * whatever the tag and the text; two pages sharing one are the same bug to reproduce.
   */
  signature: string
  /**
   * The two sides carry the same text and differ ONLY in where the line breaks fall: the preview
   * runs together what osu! splits. One cause across many pages, and the visible one — a page of
   * list items read as a single run-on paragraph.
   */
  merged: boolean
}

export interface PageSeverity {
  windows: SeverityWindow[]
  worst: SeverityKind
  /** Causes already diagnosed and left alone on purpose. */
  known: string[]
}

interface Cell { key: string; text: string }
interface Line { ctx: string; cells: Cell[]; text: string; styled: string }

/** `ctx|{style}text{style}text` → the container path, its runs with their style key, and the seen text. */
function parseLine(line: string): Line {
  const bar = line.indexOf('|')
  const ctx = bar === -1 ? line : line.slice(0, bar)
  const cells: Cell[] = []
  let rest = bar === -1 ? '' : line.slice(bar + 1)
  let key = ''
  while (rest.length > 0) {
    if (rest[0] === '{') {
      const end = keyEnd(rest)
      key = rest.slice(1, end)
      rest = rest.slice(end + 1)
      continue
    }
    const next = rest.indexOf('{')
    cells.push({ key, text: next === -1 ? rest : rest.slice(0, next) })
    rest = next === -1 ? '' : rest.slice(next)
  }
  return {
    ctx,
    cells,
    text: cells.map((c) => c.text).join(''),
    styled: cells.map((c) => `${c.key}\u0000${c.text}`).join('\u0001'),
  }
}

/** End of the `{…}` style marker at `s[0] === '{'`, respecting quoted JSON strings. */
function keyEnd(s: string): number {
  let inString = false
  let escaped = false
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (!inString && ch === '}') return i
  }
  return s.length
}

const same = (a: Line, b: Line): boolean => a.ctx === b.ctx && a.styled === b.styled

const elide = (text: string): string => (text.length > 120 ? `${text.slice(0, 120)}…` : text)

const nonBlank = (lines: Line[]): string[] => lines.map((l) => l.text).filter((t) => t.trim() !== '')

/** Same multiset of non-blank lines, whatever their order or the blank lines between them. */
function sameWords(a: Line[], b: Line[]): boolean {
  const left = nonBlank(a)
  const right = nonBlank(b)
  if (left.length !== right.length) return false
  const counts = new Map<string, number>()
  for (const t of left) counts.set(t, (counts.get(t) ?? 0) + 1)
  for (const t of right) {
    const n = counts.get(t)
    if (!n) return false
    counts.set(t, n - 1)
  }
  return true
}

function classify(pv: Line[], os: Line[]): Pick<SeverityWindow, 'kind' | 'direction'> {
  const pvText = pv.map((l) => l.text).join('\n')
  const osText = os.map((l) => l.text).join('\n')
  const sameCtx = pv.map((l) => l.ctx).join('\n') === os.map((l) => l.ctx).join('\n')
  if (pvText === osText) return { kind: sameCtx ? 'style' : 'structure' }
  if (sameWords(pv, os)) return { kind: sameCtx ? 'spacing' : 'structure' }
  // Which side is short of words: the text the other side has and this one does not.
  const pvWords = new Set(nonBlank(pv))
  const osWords = new Set(nonBlank(os))
  const missing = nonBlank(os).some((t) => !pvWords.has(t))
  const extra = nonBlank(pv).some((t) => !osWords.has(t))
  const direction = missing && extra ? 'mixed' : missing ? 'preview-missing' : 'preview-extra'
  return { kind: 'content', direction }
}

/** The first line whose text differs, from the two sides' own firsts. */
function detail(pv: Line[], os: Line[]): string {
  for (let k = 0; k < Math.max(pv.length, os.length); k++) {
    const a = pv[k]
    const b = os[k]
    if (a && b && a.text === b.text) continue
    return `preview: ${elide(a?.text ?? '(none)')} ⇢ osu!: ${elide(b?.text ?? '(none)')}`
  }
  // Same words: the difference is the container or the styles, and the windows say which.
  return sameText(pv, os) ? `styles: ${styleDiff(stylesOf(pv), stylesOf(os))}` : `ctx: ${containerDiff(containerOf(pv), containerOf(os))}`
}

const sameText = (pv: Line[], os: Line[]): boolean => pv.map((l) => l.text).join('\n') === os.map((l) => l.text).join('\n')
const containerOf = (lines: Line[]): string => lines.map((l) => l.ctx).join('\n')
const stylesOf = (lines: Line[]): string => lines.flatMap((l) => l.cells.map((c) => c.key)).join('\n')

/** Words to `w`, digits to `#`, runs of space to one — the rest of the punctuation survives. */
function fold(text: string): string {
  return text
    .replace(/[A-Za-zÀ-ÿ0-9_]+/g, (word) => (/\d/.test(word) ? '#' : 'w'))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The preview GLUED what osu! broke: its first differing line starts with the osu! line and then
 * keeps going (`…SuperlightMouse Playstyle…`, `…de odoru the peggies…` where osu! wrote one line
 * per item). One cause across many pages, and the visible one — a block read as one run-on
 * paragraph. osu!'s line being the preview line's own PREFIX is the tell: the two sides agree on
 * the words up to the break osu! has and the preview does not.
 */
function merged(pv: Line[], os: Line[]): boolean {
  const first = firstDifference(pv, os)
  if (!first) return false
  return first.preview.length > first.osu.length && first.preview.startsWith(first.osu)
}

/** The first line whose text differs from the other side's at the same index. */
function firstDifference(pv: Line[], os: Line[]): { preview: string; osu: string } | null {
  for (let k = 0; k < Math.max(pv.length, os.length); k++) {
    const a = pv[k]
    const b = os[k]
    if (a && b && a.text === b.text) continue
    if (!a || !b) return null
    return { preview: a.text, osu: b.text }
  }
  return null
}

/**
 * Where the two texts first part company, folded, with a little context on each side. A blank
 * side that runs out of text keeps a `∅` so `w ⇢ ∅` (one side lost a word) stays distinct from
 * `w ⇢ w#` (the same word numbered differently).
 *
 * When the two texts are IDENTICAL the cause is the container or the styles, so the signature
 * names those instead: `ctx: well ⇢ ∅` is "one side has it in a well", `{b} ⇢ {}` is "one side is
 * bold". Same signature, same cause — that is what the ranking groups on.
 */
function signature(pv: Line[], os: Line[]): string {
  const a = pv.map((l) => l.text).join('\n').replace(/\n+/g, '\n')
  const b = os.map((l) => l.text).join('\n').replace(/\n+/g, '\n')
  if (a === b) {
    const pvCtx = pv.map((l) => l.ctx).join('\n')
    const osCtx = os.map((l) => l.ctx).join('\n')
    if (pvCtx !== osCtx) return `ctx: ${containerDiff(pvCtx, osCtx)}`
    return `styles: ${styleNames(stylesOf(pv), stylesOf(os))}`
  }
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const from = Math.max(0, i - 20)
  const side = (s: string) => fold(s.slice(from, i + 32)) || '∅'
  return `${side(a)} ⇢ ${side(b)}`
}

/** The first container one side has and the other does not, `pv ⇢ osu`. */
function containerDiff(pv: string, os: string): string {
  const left = pv.split('\n').find((c) => !os.split('\n').includes(c))
  const right = os.split('\n').find((c) => !pv.split('\n').includes(c))
  return `${left ?? '∅'} ⇢ ${right ?? '∅'}`
}

/**
 * The first style property one side carries and the other does not, as `name=value` with the
 * value folded — `href=w://w.w.w/w/#` is "a link, to a different place", `font-size=#px` is "a
 * size, differently measured". A property whose NAME is on both sides but carries another value
 * shows up here too, which is why the values are compared, not just the names.
 */
function styleDiff(pv: string, os: string): string {
  const left = styleProps(pv)
  const right = styleProps(os)
  const onlyPv = left.filter((p) => !right.includes(p))
  const onlyOs = right.filter((p) => !left.includes(p))
  const show = (list: string[]) => {
    if (list.length === 0) return '∅'
    const eq = list[0].indexOf('=')
    return `${list[0].slice(0, eq)}=${fold(list[0].slice(eq + 1))}`
  }
  return `${show(onlyPv)} ⇢ ${show(onlyOs)}`
}

/** The same, by property NAME only: one row per cause, not one per URL. */
function styleNames(pv: string, os: string): string {
  const names = (s: string) => [...new Set(styleProps(s).map((p) => p.slice(0, p.indexOf('='))))]
  const left = names(pv)
  const right = names(os)
  const onlyPv = left.filter((n) => !right.includes(n))
  const onlyOs = right.filter((n) => !left.includes(n))
  return `${onlyPv.join('+') || '∅'} ⇢ ${onlyOs.join('+') || '∅'}`
}

/** One entry per `{name}: value` cell of the window, deduplicated. */
const styleProps = (joined: string): string[] => [...new Set(joined.split('\n'))].flatMap((k) => parseStyleProps(k))

/** `[["b","1"],["href","…"]]` → `['b=1', 'href=…']`. */
function parseStyleProps(key: string): string[] {
  try {
    const parsed = JSON.parse(key) as Array<[string, string]>
    return parsed.map(([name, value]) => `${name}=${value}`)
  } catch {
    return []
  }
}

/**
 * Split both sides into change windows. After the lines that match, a window grows until the
 * two sides line up again — accepting an insertion/removal on either side or a same-length
 * replacement — so a page with two separate problems yields two windows, not one huge one.
 */
function changeWindows(pv: Line[], os: Line[]): Array<{ pv: Line[]; os: Line[]; pvAt: number; osAt: number }> {
  const out: Array<{ pv: Line[]; os: Line[]; pvAt: number; osAt: number }> = []
  const CAP = 120
  let i = 0
  let j = 0
  while (i < pv.length && j < os.length && same(pv[i], os[j])) { i++; j++ }
  while (i < pv.length || j < os.length) {
    const pvAt = i
    const osAt = j
    let moved = false
    for (let d = 1; d <= CAP && !moved; d++) {
      for (const [di, dj] of [[d, d], [d, 0], [0, d]] as const) {
        const ni = i + di
        const nj = j + dj
        if (ni > pv.length || nj > os.length) continue
        const atEnd = ni === pv.length && nj === os.length
        if (!atEnd && !(ni < pv.length && nj < os.length && same(pv[ni], os[nj]))) continue
        out.push({ pv: pv.slice(i, ni), os: os.slice(j, nj), pvAt, osAt })
        i = ni
        j = nj
        moved = true
        break
      }
    }
    if (!moved) {
      out.push({ pv: pv.slice(i), os: os.slice(j), pvAt, osAt })
      i = pv.length
      j = os.length
    }
    while (i < pv.length && j < os.length && same(pv[i], os[j])) { i++; j++ }
  }
  return out
}

/**
 * Both sides' visible lines, for reading one page's windows by hand.
 */
export function pageLines(source: string, golden: string): { preview: string[]; osu: string[] } {
  return {
    preview: visibleLines(previewHTML(phpTrim(source))),
    osu: visibleLines(unwrapOsuHtml(golden)),
  }
}

export function pageSeverity(source: string, golden: string): PageSeverity {
  source = phpTrim(source)
  const pv = visibleLines(previewHTML(source)).map(parseLine)
  const os = visibleLines(unwrapOsuHtml(golden)).map(parseLine)
  const windows: SeverityWindow[] = changeWindows(pv, os).map(({ pv: a, os: b, pvAt, osAt }) => ({
    ...classify(a, b),
    previewLine: pvAt + 1,
    osuLine: osAt + 1,
    previewLines: a.length,
    osuLines: b.length,
    detail: detail(a, b),
    signature: signature(a, b),
    merged: merged(a, b),
  }))
  let worst: SeverityKind = 'spacing'
  for (const w of windows) if (SEVERITY_RANK[w.kind] > SEVERITY_RANK[worst]) worst = w.kind
  return { windows, worst, known: knownCauses(source, golden) }
}

const WORDS = /[A-Za-z\u00c0-\u024f0-9_-]{3,}/g

/**
 * Divergences already diagnosed and left in place on purpose — see `.claude/rules/osu.md`, which
 * is the authority. Keeping this list in step with that file is the point: what is here is not a
 * bug to chase, and the ranking can set those pages aside.
 *
 * - `parseColour-swallow`: `BBCodeFromDB::parseColour`'s `[^:]+` crosses the `]`, so an unsealed
 *   `[color=…]` swallows a whole literal tag. The preview cannot hide source text the way the
 *   real pipeline does, and pretending to would hide the tag from the editor too.
 * - `profile-name-resolution`: osu! prints the CURRENT username of `[profile=id]`, not the name
 *   the page typed. Needs the osu! API (the scan's harness feeds its own id/name index); a page
 *   written years ago will show a name its author never wrote.
 */
export function knownCauses(source: string, golden: string): string[] {
  const out: string[] = []
  const src = phpTrim(source)
  if (literalColorOutsideRaw(src)) out.push('parseColour-swallow')
  // An osu!-only word the page never wrote can only have come from a resolved user (the index).
  if (/\[profile[=\]]/.test(src)) {
    const ours = new Set(visibleLines(previewHTML(src)).join('\n').match(WORDS) ?? [])
    for (const word of visibleLines(unwrapOsuHtml(golden)).join('\n').match(WORDS) ?? []) {
      if (ours.has(word) || src.includes(word)) continue
      out.push('profile-name-resolution')
      break
    }
    // The same resolution when the name is not the difference: `[profile]Name[/profile]` without
    // an id publishes `href="/users/<id>"`, and a numeric user link the preview does not have can
    // only be osu! having resolved the name — the words are identical on both sides.
    if (!out.includes('profile-name-resolution')) {
      const idsIn = (html: string) => new Set(html.match(/\/users\/\d+/g) ?? [])
      const theirs = idsIn(unwrapOsuHtml(golden))
      const ours = idsIn(previewHTML(src))
      if ([...theirs].some((id) => !ours.has(id))) out.push('profile-name-resolution')
    }
  }
  return out
}

/** A literal `[color=…]` the reader can see: inside what osu! renders verbatim it is not a tag. */
function literalColorOutsideRaw(src: string): boolean {
  /** Verbatim kinds: a `[color=…]` inside one is text the reader sees, not a tag to parse. */
  const RAW: ReadonlySet<string> = new Set(['inline_code', 'code'])
  const root = previewDoc(src).redRoot
  let found = false
  const visit = (node: RedNode, raw: boolean): void => {
    if (found) return
    if (!raw && node.kind === 'text' && node.text.includes('[color=')) found = true
    for (const child of node.children) visit(child, raw || RAW.has(node.kind))
  }
  if (root) visit(root, false)
  return found
}
