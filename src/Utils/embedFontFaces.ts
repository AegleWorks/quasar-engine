/**
 * The `@font-face` rules a snapshot needs, with the font files inlined.
 *
 * `domToSVG` draws text with the page's fonts, but an SVG shown through
 * `<img>` — how osu! shows an `[img]` — loads nothing external: no
 * `@import`, no `url()`. Torus, the font of every osu! card, is not even on
 * Google Fonts. So the text fell through to the viewer's default serif.
 *
 * This reads the page's own `@font-face` rules, keeps the ones the text
 * actually uses (family, nearest weight, style, and only the `unicode-range`
 * slices its characters fall in) and returns them with each file as a
 * `data:` URI, for `DomToSVGOptions.fontCSS`.
 */

import type { FontUse } from './dom-to-svg'

/** One `@font-face` rule of the page, read into plain data. */
export interface FontFaceSource {
  family: string
  /** `[min, max]`: a single weight is `[w, w]`, a variable font a range. */
  weight: readonly [number, number]
  style: string
  /** `[from, to]` code point ranges; empty means every character. */
  ranges: ReadonlyArray<readonly [number, number]>
  /** Absolute URL of the font file. */
  url: string
  /** The `format()` hint, when the rule gives one. */
  format: string | null
}

const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2')

/** `"Torus", Inter, sans-serif` → `['torus', 'inter', 'sans-serif']`. */
export function familyNames(list: string): string[] {
  return list.split(',').map((f) => unquote(f).toLowerCase()).filter(Boolean)
}

/** `U+0000-00FF, U+0131, U+4??` → code point ranges. */
export function parseUnicodeRange(value: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const part of value.split(',')) {
    const m = /^\s*U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part)
    if (!m) continue
    if (m[1].includes('?')) {
      out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'f'), 16)])
    } else {
      const from = parseInt(m[1], 16)
      out.push([from, m[2] ? parseInt(m[2], 16) : from])
    }
  }
  return out
}

function parseWeight(value: string): [number, number] {
  const nums = value.trim().split(/\s+/).map((v) => (v === 'bold' ? 700 : v === 'normal' ? 400 : parseInt(v, 10)))
  const [a, b] = [nums[0] || 400, nums[1] || nums[0] || 400]
  return [Math.min(a, b), Math.max(a, b)]
}

/** The first `url()` of a `src` descriptor, resolved against `base`, with its format hint. */
function parseSrc(src: string, base: string): { url: string; format: string | null } | null {
  const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]+)\3\s*\))?/.exec(src)
  if (!m) return null
  try {
    return { url: new URL(m[2], base).href, format: m[4] ?? null }
  } catch {
    return null
  }
}

/** Every `@font-face` rule the document can read (cross-origin sheets refuse `cssRules`). */
export function readFontFaceSources(doc: Document = document): FontFaceSource[] {
  const out: FontFaceSource[] = []
  const visit = (rules: CSSRuleList, base: string): void => {
    for (const rule of Array.from(rules)) {
      if (rule.constructor.name === 'CSSFontFaceRule' || rule.type === 5 /* FONT_FACE_RULE */) {
        const style = (rule as CSSFontFaceRule).style
        const src = parseSrc(style.getPropertyValue('src'), base)
        const family = unquote(style.getPropertyValue('font-family'))
        if (!src || !family) continue
        out.push({
          family,
          weight: parseWeight(style.getPropertyValue('font-weight') || '400'),
          style: style.getPropertyValue('font-style').trim() || 'normal',
          ranges: parseUnicodeRange(style.getPropertyValue('unicode-range')),
          url: src.url,
          format: src.format,
        })
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        visit((rule as CSSGroupingRule).cssRules, base)
      }
    }
  }
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    visit(rules, sheet.href ?? doc.baseURI)
  }
  return out
}

/**
 * How far down CSS's preference order a face of `[min, max]` weight sits for
 * a wanted `w` (CSS Fonts 4, §5.2 "font-weight"): 0 is a face that covers
 * it. Past that, a weight above 500 looks heavier first and then lighter, one
 * below 400 lighter first and then heavier, and one in between up to 500
 * first, then lighter, then heavier. Lower is better.
 */
export function weightRank(w: number, [min, max]: readonly [number, number]): number {
  if (w >= min && w <= max) return 0
  const heavier = min > w
  const gap = heavier ? min - w : w - max
  if (w > 500) return heavier ? gap : 1000 + gap
  if (w < 400) return heavier ? 1000 + gap : gap
  // 400–500: up to 500 first, then lighter, then above 500.
  if (heavier && min <= 500) return gap
  return heavier ? 2000 + gap : 1000 + gap
}

/**
 * The rules that draw `use`: its first family that the page defines, the
 * style it asks for (else any), the weight CSS would pick, and of it only
 * the slices whose `unicode-range` holds one of its characters.
 */
export function selectFontFaces(use: FontUse, sources: readonly FontFaceSource[]): FontFaceSource[] {
  const codePoints = Array.from(use.text, (ch) => ch.codePointAt(0) ?? 0)
  for (const name of familyNames(use.family)) {
    const family = sources.filter((s) => s.family.toLowerCase() === name)
    if (family.length === 0) continue
    const styled = family.filter((s) => s.style === use.style)
    const pool = styled.length > 0 ? styled : family
    const best = Math.min(...pool.map((s) => weightRank(use.weight, s.weight)))
    return pool
      .filter((s) => weightRank(use.weight, s.weight) === best)
      .filter((s) => s.ranges.length === 0 || codePoints.some((cp) => s.ranges.some(([a, b]) => cp >= a && cp <= b)))
  }
  return []
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const FONT_MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', opentype: 'font/otf', truetype: 'font/ttf' }

/**
 * `@font-face` CSS with every file the text of `uses` needs inlined.
 * A file that cannot be fetched is left out: the text then falls through the
 * family list, as it would on a page whose font failed to load.
 */
export async function embedFontFaces(
  uses: readonly FontUse[],
  fetchImpl: typeof fetch = fetch,
  sources: readonly FontFaceSource[] = readFontFaceSources(),
): Promise<string> {
  const wanted = new Map<string, FontFaceSource>()
  for (const use of uses) {
    for (const face of selectFontFaces(use, sources)) {
      wanted.set(`${face.family}|${face.weight}|${face.style}|${face.url}|${face.ranges.join()}`, face)
    }
  }
  const files = new Map<string, Promise<string | null>>()
  const dataUri = (face: FontFaceSource): Promise<string | null> => {
    let pending = files.get(face.url)
    if (!pending) {
      pending = (async () => {
        try {
          const res = await fetchImpl(face.url)
          if (!res.ok) return null
          const type = (face.format && FONT_MIME[face.format]) || res.headers.get('content-type') || 'font/otf'
          return `data:${type};base64,${toBase64(new Uint8Array(await res.arrayBuffer()))}`
        } catch {
          return null
        }
      })()
      files.set(face.url, pending)
    }
    return pending
  }
  const rules = await Promise.all(Array.from(wanted.values(), async (face) => {
    const data = await dataUri(face)
    if (!data) return ''
    const range = face.ranges.length > 0
      ? `unicode-range:${face.ranges.map(([a, b]) => (a === b ? `U+${a.toString(16)}` : `U+${a.toString(16)}-${b.toString(16)}`)).join(',')};`
      : ''
    const weight = face.weight[0] === face.weight[1] ? `${face.weight[0]}` : `${face.weight[0]} ${face.weight[1]}`
    return `@font-face{font-family:"${face.family.replace(/"/g, '')}";font-style:${face.style};font-weight:${weight};${range}src:url(${data})${face.format ? ` format("${face.format}")` : ''};}`
  }))
  return rules.filter(Boolean).join('')
}
