/**
 * Raster tags — BBCode that osu! can never render, exported as images.
 *
 * Five Miliastry-only tags with an osu!-native look (dark surfaces, pink
 * `#FF66AB` accent, rounded cards) that degrade to plain content on a naive
 * osu! export. The real export path rasterizes them: render the node in
 * isolation → `domToSVG` → upload the SVG to the user's default asset host →
 * replace the node with a centred `[img]url[/img]`.
 *
 * This module is DOM-free and host-free: it collects the nodes, hashes them
 * for the upload cache, and splices the `[img]` replacements into the source.
 * The DOM/SVG/upload half lives in Miliastry (`features/BBCode/raster/`).
 */

import type { RedNode } from '../Syntax/RedNode'
import { newlineRule } from '../Semantic/osu/newlineRules'

export const RASTERIZABLE_TAGS = [
  'profilecard',
  'beatmap',
  'progress',
  'divider',
  'score',
] as const

export type RasterizableTag = (typeof RASTERIZABLE_TAGS)[number]

const RASTER_SET: ReadonlySet<string> = new Set<string>(RASTERIZABLE_TAGS)

export function isRasterizable(node: RedNode): boolean {
  return RASTER_SET.has(node.kind)
}

/** Every rasterizable node in the tree, in document order. */
export function collectRasterNodes(root: RedNode | null | undefined): RedNode[] {
  const out: RedNode[] = []
  if (!root) return out
  const walk = (node: RedNode): void => {
    if (isRasterizable(node)) out.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out
}

/**
 * Stable hash of a raster node: tag + metadata + inner content.
 * Used as the upload-cache key so an unchanged card is never re-uploaded.
 */
export function hashRasterNode(node: RedNode, source: string): string {
  const meta = node.metadata ? JSON.stringify(sortKeys(node.metadata as Record<string, unknown>)) : '{}'
  const inner = source.slice(node.range.start, node.range.end)
  const base = `${node.kind}|${meta}|${inner}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822519)
  }
  return `raster-${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

/**
 * The native BBCode a rasterized node becomes: its image, centred.
 *
 * Centred because every raster tag renders as a block card. Exported so the
 * one wrapper lives here and nowhere else.
 */
export function rasterImageBBCode(url: string): string {
  return `[centre][img]${url}[/img][/centre]`
}

/** The kind {@link rasterImageBBCode} wraps the image in, for its newline budget. */
const RASTER_WRAPPER_KIND = 'center'

/** Newlines in the run that starts at `at` (`\n` or `\r\n` each). */
function newlineRunAt(source: string, at: number): number {
  let count = 0
  let i = at
  for (;;) {
    if (source.charCodeAt(i) === 13 /* \r */ && source.charCodeAt(i + 1) === 10) i += 2
    else if (source.charCodeAt(i) === 10 /* \n */) i += 1
    else return count
    count++
  }
}

/** How many of `run` newlines after its closer a construct of `kind` swallows. */
function eatenAfterClose(kind: string, run: number): number {
  return Math.min(newlineRule(kind)?.afterClose ?? 0, run)
}

/**
 * The replacement for one raster node: the image, plus the newlines its
 * wrapper swallows and the node did not.
 *
 * A raster card has no newline rule of its own, so the newlines after
 * `[/profilecard]` all draw. `[/centre]` eats the first one (osu!'s
 * `strtr` of `[/centre]\n`, measured: `[/centre]\n\n` publishes
 * `</div><br />`), so a plain swap took one line of space off whatever
 * came under the card. Giving that newline back keeps the spacing the
 * author saw in the editor. Both budgets come from `newlineRules`, the
 * table the preview and the exporter already read.
 */
export function rasterReplacementFor(node: RedNode, source: string, url: string): string {
  const run = newlineRunAt(source, node.range.end)
  const owed = eatenAfterClose(RASTER_WRAPPER_KIND, run) - eatenAfterClose(node.kind, run)
  return rasterImageBBCode(url) + '\n'.repeat(Math.max(0, owed))
}

/**
 * Replace every raster node of `root` in `source` with its image.
 *
 * Works on the SOURCE, by the nodes' ranges, so the result goes through the
 * ordinary export afterwards and every exporter rule still applies. A node
 * `urlFor` has no URL for is left as written.
 */
export function spliceRasterImages(
  source: string,
  root: RedNode | null | undefined,
  urlFor: (hash: string) => string | undefined,
): string {
  const nodes = collectRasterNodes(root)
  if (nodes.length === 0) return source
  // Back to front, so each splice leaves the earlier ranges valid.
  const ordered = [...nodes].sort((a, b) => b.range.start - a.range.start)
  let out = source
  for (const node of ordered) {
    const url = urlFor(hashRasterNode(node, source))
    if (!url) continue
    out = out.slice(0, node.range.start) + rasterReplacementFor(node, source, url) + out.slice(node.range.end)
  }
  return out
}

/** Human label for UI: `[profilecard user=..]` → `Profile card “..”`. */
export function describeRasterNode(node: RedNode): string {
  const m = (node.metadata ?? {}) as Record<string, unknown>
  switch (node.kind) {
    case 'profilecard':
      return m.user ? `Profile card “${String(m.user)}”` : 'Profile card'
    case 'beatmap':
      return m.title ? `Beatmap “${String(m.title)}”` : 'Beatmap card'
    case 'progress':
      return m.value !== undefined ? `Progress ${String(m.value)}%` : 'Progress bar'
    case 'divider':
      return m.label ? `Section “${String(m.label)}”` : 'Divider'
    case 'score':
      return m.title ? `Top play “${String(m.title)}”` : 'Top play'
    default:
      return node.kind
  }
}
