/**
 * The grammar of `[composition]` and `[pane]` attributes.
 *
 *   [composition]                      text output, 900 px wide, 24 px gaps
 *   [composition=svg width=640 gap=16] image output (rasterized on export)
 *   [pane=40%] [pane=220px right] [pane centre]
 *
 * One parser for every reader (compiler, renderer, raster), so a value the
 * compiler accepts is never drawn differently by the preview.
 */

export type CompositionMode = 'text' | 'svg'
export type PaneAlign = 'left' | 'centre' | 'right'

export interface CompositionSpec {
  mode: CompositionMode
  /** Total width in CSS px. */
  width: number
  /** Space between panes in CSS px. */
  gap: number
}

export interface PaneSpec {
  /** Requested width: a share of the panes' room, a fixed px width, or the rest. */
  width: { kind: 'percent'; value: number } | { kind: 'px'; value: number } | { kind: 'auto' }
  align: PaneAlign
}

/**
 * osu!'s userpage content width: `.osu-page` is at most 1000 px, and
 * `.page-extra` takes 10 px of margin and 40 px of padding off each side.
 */
export const OSU_USERPAGE_WIDTH = 900

export const DEFAULT_COMPOSITION: CompositionSpec = { mode: 'text', width: OSU_USERPAGE_WIDTH, gap: 24 }

const MIN_WIDTH = 120
const MAX_WIDTH = 2000

function tokens(spec: string | undefined): string[] {
  return (spec ?? '').trim().split(/\s+/).filter(Boolean)
}

function px(value: string, fallback: number, min: number, max: number): number {
  const n = Number.parseFloat(value.replace(/px$/i, ''))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

export function parseCompositionSpec(spec: string | undefined): CompositionSpec {
  const out = { ...DEFAULT_COMPOSITION }
  for (const token of tokens(spec)) {
    const [key, raw] = token.includes('=') ? token.split('=', 2) : [null, token]
    const k = key === null ? null : key.toLowerCase()
    const v = raw.toLowerCase()
    if ((k === null || k === 'mode') && (v === 'text' || v === 'svg')) out.mode = v
    else if (k === 'width') out.width = px(v, out.width, MIN_WIDTH, MAX_WIDTH)
    else if (k === 'gap') out.gap = px(v, out.gap, 0, 400)
  }
  return out
}

export function parsePaneSpec(spec: string | undefined): PaneSpec {
  const out: PaneSpec = { width: { kind: 'auto' }, align: 'left' }
  for (const token of tokens(spec)) {
    const v = token.toLowerCase().replace(/^(width|align)=/, '')
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(v)
    const fixed = /^(\d+(?:\.\d+)?)(px)?$/.exec(v)
    if (percent) out.width = { kind: 'percent', value: Math.max(1, Math.min(100, Number(percent[1]))) }
    else if (fixed) out.width = { kind: 'px', value: Math.max(8, Number(fixed[1])) }
    else if (v === 'left' || v === 'right') out.align = v
    else if (v === 'centre' || v === 'center') out.align = 'centre'
  }
  return out
}

/** Where each pane starts and how wide it is, in CSS px from the composition's left edge. */
export function placePanes(composition: CompositionSpec, panes: readonly PaneSpec[]): { x: number; width: number }[] {
  if (panes.length === 0) return []
  const room = Math.max(0, composition.width - composition.gap * (panes.length - 1))
  const fixed = panes.map((p) =>
    p.width.kind === 'percent' ? (room * p.width.value) / 100 : p.width.kind === 'px' ? p.width.value : null,
  )
  const taken = fixed.reduce<number>((sum, w) => sum + (w ?? 0), 0)
  const autos = fixed.filter((w) => w === null).length
  const share = autos > 0 ? Math.max(0, room - taken) / autos : 0
  let x = 0
  return fixed.map((w) => {
    const width = w ?? share
    const placed = { x, width }
    x += width + composition.gap
    return placed
  })
}
