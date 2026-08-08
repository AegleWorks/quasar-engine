/**
 * Quasar — Color Utilities
 *
 * Standalone color functions for gradient/grow/exporter interpolation.
 * No external dependencies — pure math.
 *
 * Ported from TextStudio/lib/color.ts (originally backed by culori).
 * These are the minimal subset needed for internal tag export.
 */

// ─── Types ──────────────────────────────────────────────────

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'

// ─── Parsing ────────────────────────────────────────────────

/** Parse "#RRGGBB" to [r, g, b] each in [0, 255] */
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ]
}

/** Format [r, g, b] (0-255) to "#RRGGBB" */
function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return (
    '#' +
    clamp(r).toString(16).padStart(2, '0') +
    clamp(g).toString(16).padStart(2, '0') +
    clamp(b).toString(16).padStart(2, '0')
  ).toUpperCase()
}

// ─── Interpolation ──────────────────────────────────────────

/**
 * Mix two hex colors via linear RGB interpolation.
 * t in [0, 1] — 0 = from, 1 = to.
 */
export function mixHex(from: string, to: string, t: number): string {
  const [r1, g1, b1] = parseHex(from)
  const [r2, g2, b2] = parseHex(to)
  return toHex(
    r1 + (r2 - r1) * t,
    g1 + (g2 - g1) * t,
    b1 + (b2 - b1) * t,
  )
}

/**
 * Mix across multiple hex colors.
 * t in [0, 1] maps across the color array linearly.
 */
export function mixMultiple(colors: string[], t: number): string {
  if (colors.length === 0) return '#FFFFFF'
  if (colors.length === 1) return colors[0]
  const segments = colors.length - 1
  const segment = Math.min(Math.floor(t * segments), segments - 1)
  const localFactor = t * segments - segment
  return mixHex(colors[segment], colors[segment + 1], localFactor)
}

// ─── HSL → Hex ──────────────────────────────────────────────

/**
 * Convert HSL to hex string.
 * @param h hue in [0, 360]
 * @param s saturation in [0, 1]
 * @param l lightness in [0, 1]
 */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360
  const sat = Math.max(0, Math.min(1, s))
  const lit = Math.max(0, Math.min(1, l))

  const c = (1 - Math.abs(2 * lit - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lit - c / 2

  let r = 0, g = 0, b = 0
  if (hue < 60)       { r = c; g = x; }
  else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; }
  else                { r = c; b = x; }

  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

// ─── Easing ─────────────────────────────────────────────────

export function clamp(n: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, n))
}

export function ease(t: number, kind: Easing): number {
  switch (kind) {
    case 'easeIn':
      return t * t
    case 'easeOut':
      return 1 - (1 - t) * (1 - t)
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    default:
      return t
  }
}
