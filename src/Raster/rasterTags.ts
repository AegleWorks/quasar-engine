/**
 * Raster tags — BBCode that osu! can never render, exported as images.
 *
 * Five Miliastry-only tags with an osu!-native look (dark surfaces, pink
 * `#FF66AB` accent, rounded cards) that degrade to plain content on a naive
 * osu! export. The real export path rasterizes them: render the node in
 * isolation → `domToSVG` → upload the SVG to the user's default asset host →
 * replace the node with `[img]url[/img]`.
 *
 * This module is DOM-free and host-free: it collects the nodes, hashes them
 * for the upload cache, and splices `[img]` replacements into exported text.
 * The DOM/SVG/upload half lives in Miliastry (`features/BBCode/raster/`).
 */

import type { RedNode } from '../Syntax/RedNode'

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

export interface RasterReplacement {
  node: RedNode
  url: string
  hash: string
}

/**
 * Splice `[img]` replacements into already-exported BBCode.
 *
 * `exported` must be the osu-target export of the same tree the nodes came
 * from. Each raster node is located by its source range mapped through the
 * exporter… in practice the exporter strips raster tags to their content, so
 * instead the caller passes the node's *exported span*: the simplest robust
 * contract is to replace by the node's original source slice when the export
 * kept it verbatim (miliastry/lyne), or by explicit ranges the caller computed.
 *
 * To keep this DOM-free, `replaceRasterInExport` works on explicit spans:
 * `{ start, end }` index into `exported`, replaced by `[img]url[/img]`
 * (centred when the node was a block).
 */
export function replaceRasterInExport(
  exported: string,
  spans: ReadonlyArray<{ start: number; end: number; url: string; block: boolean }>,
): string {
  const ordered = [...spans].sort((a, b) => b.start - a.start)
  let out = exported
  for (const span of ordered) {
    const img = span.block
      ? `[centre][img]${span.url}[/img][/centre]`
      : `[img]${span.url}[/img]`
    out = out.slice(0, span.start) + img + out.slice(span.end)
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
