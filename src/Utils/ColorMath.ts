// ============================================================
// Quasar Studio — Color Math & Utilities
// Ported from TextStudio to provide native algorithms for Quasar
// ============================================================

export type Easing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "easeIO" | "parabola" | "half-parabola" | string // string allows 'bezier(0.25,0.1,0.25,1.0)'

export function solveCubicBezierY(x: number, x1: number, y1: number, x2: number, y2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lower = 0;
  let upper = 1;
  let t = 0.5;
  for (let i = 0; i < 15; i++) {
    const currentX = 3 * Math.pow(1 - t, 2) * t * x1 + 3 * (1 - t) * Math.pow(t, 2) * x2 + Math.pow(t, 3);
    if (Math.abs(currentX - x) < 0.001) break;
    if (currentX < x) lower = t;
    else upper = t;
    t = (lower + upper) / 2;
  }
  return 3 * Math.pow(1 - t, 2) * t * y1 + 3 * (1 - t) * Math.pow(t, 2) * y2 + Math.pow(t, 3);
}

/**
 * Set by EffectMath at module load. ColorMath cannot import it directly —
 * EffectMath depends on ColorMath — and `ease` is the only place that
 * needs it, so the dependency is injected rather than inverted.
 */
type ExpressionFn = (vars: Record<string, number>) => number
let compileExpressionRef: ((src: string) => ExpressionFn | null) | null = null

/** @internal Wire the expression compiler into `ease`. */
export function __setExpressionCompiler(fn: (src: string) => ExpressionFn | null): void {
  compileExpressionRef = fn
}

// Bezier easing approximation or simple evaluation
export function ease(t: number, easing: Easing, center: number = 0.5, power: number = 2): number {
  t = Math.max(0, Math.min(1, t))
  if (typeof easing !== 'string' || easing === 'linear') return t

  if (easing.startsWith('expr(')) {
    // `easing` can arrive straight from a BBCode attribute, so the body is
    // compiled through the validating evaluator in EffectMath rather than
    // handed to `new Function` as-is. A rejected expression is the
    // identity, which degrades the effect instead of the document.
    const fn = compileExpressionRef?.(easing.slice(5, -1))
    if (!fn) return t
    const out = fn({ u: t, t, x: t, i: 0, n: 1, line: 0, lines: 1, col: 0, cols: 1, word: 0, words: 1, rnd: 0 })
    return Number.isFinite(out) ? out : t
  }

  if (easing.startsWith('bezier')) {
    const match = easing.match(/bezier\(([^,]+),([^,]+),([^,]+),([^)]+)\)/);
    if (match) {
      const x1 = parseFloat(match[1]);
      const y1 = parseFloat(match[2]);
      const x2 = parseFloat(match[3]);
      const y2 = parseFloat(match[4]);
      return solveCubicBezierY(t, x1, y1, x2, y2);
    }
  }
  switch (easing) {
    case "easeIn":
    case "ease-in":
    case "half-parabola": return Math.pow(t, power)
    case "easeOut":
    case "ease-out": return t * (2 - t)
    case "easeInOut":
    case "ease-in-out":
    case "easeIO":
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    case "parabola": 
      if (center <= 0) return Math.pow(t, power);
      if (center >= 1) return Math.pow(1 - t, power);
      return t < center 
        ? Math.pow((center - t) / center, power)
        : Math.pow((t - center) / (1 - center), power);
    default: return t
  }
}


export function hslToHex(h: number, s: number, l: number): string {
  l /= 100
  const a = (s * Math.min(l, 1 - l)) / 100
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return byteHex(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)))
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** Hex digit value per char code, `-1` for anything else. */
const HEX_VALUE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1)
  for (let c = 0; c < 10; c++) table[48 + c] = c          // 0-9
  for (let c = 0; c < 6; c++) table[97 + c] = 10 + c      // a-f
  for (let c = 0; c < 6; c++) table[65 + c] = 10 + c      // A-F
  return table
})()

/** Two-character lowercase hex for every byte, built once. */
const BYTE_HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"))

function hexAt(s: string, i: number): number {
  const c = s.charCodeAt(i)
  return c < 128 ? HEX_VALUE[c] : -1
}

/**
 * A hex colour token to RGB.
 *
 * Accepts `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`, hash optional.
 * Anything else returns black instead of `NaN`: these strings come from
 * BBCode attributes and from a text field the user is mid-way through
 * typing, and a `NaN` channel propagates into `#NaNNaNNaN`, corrupting
 * the whole gradient rather than the one bad stop.
 *
 * Parsed by char code rather than by regex + `parseInt`. This runs once
 * per character per colour layer per keystroke — two calls for every
 * `mixHex` — and the regex version was the single largest cost in
 * compiling a long document.
 */
export function hexToRgb(hex: string): [number, number, number] {
  if (typeof hex !== "string") return [0, 0, 0]
  let start = 0
  let end = hex.length
  while (start < end && hex.charCodeAt(start) <= 32) start++
  while (end > start && hex.charCodeAt(end - 1) <= 32) end--
  if (start < end && hex.charCodeAt(start) === 35 /* # */) start++

  const len = end - start
  const short = len === 3 || len === 4
  if (!short && len !== 6 && len !== 8) return [0, 0, 0]

  const digits = short ? 3 : 6
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < digits; i += short ? 1 : 2) {
    const hi = hexAt(hex, start + i)
    if (hi < 0) return [0, 0, 0]
    if (short) {
      out[i] = hi * 17
    } else {
      const lo = hexAt(hex, start + i + 1)
      if (lo < 0) return [0, 0, 0]
      out[i >> 1] = hi * 16 + lo
    }
  }
  return out
}

/** True when a token is a hex colour `hexToRgb` can read exactly. */
export function isHexColor(value: string): boolean {
  if (typeof value !== "string") return false
  let start = 0
  let end = value.length
  while (start < end && value.charCodeAt(start) <= 32) start++
  while (end > start && value.charCodeAt(end - 1) <= 32) end--
  if (start < end && value.charCodeAt(start) === 35) start++

  const len = end - start
  if (len !== 3 && len !== 4 && len !== 6 && len !== 8) return false
  for (let i = start; i < end; i++) {
    if (hexAt(value, i) < 0) return false
  }
  return true
}

/** Clamp to a byte and format as two lowercase hex characters. */
function byteHex(v: number): string {
  const n = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
  return BYTE_HEX[n]
}

export function hexToHsl(hex: string): [number, number, number] {
  let [r, g, b] = hexToRgb(hex);
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

export function mixHex(color1: string, color2: string, weight: number): string {
  // Identical endpoints are the common case in a flat run; skipping the
  // interpolation also skips two parses and a string build.
  if (color1 === color2) return color1
  const [r1, g1, b1] = hexToRgb(color1)
  const [r2, g2, b2] = hexToRgb(color2)
  const w = weight < 0 ? 0 : weight > 1 ? 1 : weight
  return `#${byteHex(r1 + (r2 - r1) * w)}${byteHex(g1 + (g2 - g1) * w)}${byteHex(b1 + (b2 - b1) * w)}`
}

export function mixMultiple(colors: string[], weight: number): string {
  if (colors.length === 0) return "#FFFFFF"
  if (colors.length === 1) return colors[0]
  weight = Math.max(0, Math.min(1, weight || 0))
  const scaled = weight * (colors.length - 1)
  const index = Math.floor(scaled)
  if (index >= colors.length - 1) return colors[colors.length - 1]
  const frac = scaled - index
  return mixHex(colors[index], colors[index + 1], frac)
}

export interface ColorStop {
  color: string;
  position: number; // 0 to 1
}

/**
 * Sample a stop list at `weight`.
 *
 * `perceptual` interpolates in OKLab instead of sRGB. The difference
 * shows wherever two stops differ in hue: an sRGB ramp from blue to
 * yellow dips through a desaturated grey at the midpoint, while OKLab
 * holds chroma. Two conversions per character, so it stays opt-in.
 */
export function mixMultipleStops(stops: ColorStop[], weight: number, perceptual = false): string {
  if (stops.length === 0) return "#FFFFFF";
  if (stops.length === 1) return stops[0].color;
  weight = Math.max(0, Math.min(1, weight || 0));

  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].position <= weight) {
    i++;
  }

  if (i >= stops.length - 1) return stops[stops.length - 1].color;
  if (weight <= stops[i].position) return stops[i].color;

  const range = stops[i + 1].position - stops[i].position;
  // Coincident stops are a hard colour break, not a zero-width ramp:
  // dividing by the gap would yield Infinity.
  const frac = range <= 0 ? 1 : (weight - stops[i].position) / range;
  return perceptual
    ? mixHexOklab(stops[i].color, stops[i + 1].color, frac)
    : mixHex(stops[i].color, stops[i + 1].color, frac);
}

// ═══════════════════════════════════════════════════════════════
// OKLab — Perceptual Color Space
// ═══════════════════════════════════════════════════════════════
//
// OKLab is a color space designed by Björn Ottosson in 2020 to be
// perceptually uniform: equal Euclidean distance ≈ equal perceived
// color difference. This makes it ideal for gradient detection.
//
// Reference: https://bottosson.github.io/posts/oklab/
//
// ═══════════════════════════════════════════════════════════════

// Linear sRGB → LMS (cone response) matrix
const SRGB_TO_LMS = [
  0.4122214708, 0.5363325363, 0.0514459929,
  0.2119034982, 0.6806995451, 0.1073969566,
  0.0883024619, 0.2817188376, 0.6299787005,
] as const

// LMS → OKLab matrix
const LMS_TO_OKLAB = [
   0.2104542553,  0.7936177850, -0.0040720468,
   1.9779984951, -2.4285922050,  0.4505937099,
   0.0259040371,  0.7827717662, -0.8086757660,
] as const

/**
 * Convert sRGB [0-1] to linear RGB (gamma expansion).
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * Convert linear RGB to sRGB (gamma compression for display).
 */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/**
 * Convert a hex colour to OKLab [L, a, b] components.
 * L (lightness) in [0, 1], a/b (opponent axes) roughly in [-0.4, 0.4].
 */
export function hexToOklab(hex: string): [number, number, number] {
  const [r255, g255, b255] = hexToRgb(hex)
  const r = srgbToLinear(r255 / 255)
  const g = srgbToLinear(g255 / 255)
  const b = srgbToLinear(b255 / 255)

  // Linear sRGB → LMS
  const l_ = r * SRGB_TO_LMS[0] + g * SRGB_TO_LMS[1] + b * SRGB_TO_LMS[2]
  const m_ = r * SRGB_TO_LMS[3] + g * SRGB_TO_LMS[4] + b * SRGB_TO_LMS[5]
  const s_ = r * SRGB_TO_LMS[6] + g * SRGB_TO_LMS[7] + b * SRGB_TO_LMS[8]

  // Non-linear transform (cube root)
  const l = Math.cbrt(l_)
  const m = Math.cbrt(m_)
  const s = Math.cbrt(s_)

  // LMS → OKLab
  return [
    l * LMS_TO_OKLAB[0] + m * LMS_TO_OKLAB[1] + s * LMS_TO_OKLAB[2],
    l * LMS_TO_OKLAB[3] + m * LMS_TO_OKLAB[4] + s * LMS_TO_OKLAB[5],
    l * LMS_TO_OKLAB[6] + m * LMS_TO_OKLAB[7] + s * LMS_TO_OKLAB[8],
  ]
}

/**
 * Calculate the perceptual distance between two hex colours using OKLab.
 * Returns a value in [0, ~0.4] where:
 *   < 0.02  ≈ imperceptible difference
 *   < 0.05  ≈ small but noticeable
 *   > 0.1   ≈ very noticeable
 */
export function perceptualDistance(hex1: string, hex2: string): number {
  const [L1, a1, b1] = hexToOklab(hex1)
  const [L2, a2, b2] = hexToOklab(hex2)
  const dL = L2 - L1
  const da = a2 - a1
  const db = b2 - b1
  return Math.sqrt(dL * dL + da * da + db * db)
}

/**
 * Mix two hex colours in OKLab space for perceptually uniform interpolation.
 */
export function mixHexOklab(color1: string, color2: string, weight: number): string {
  const [L1, a1, b1] = hexToOklab(color1)
  const [L2, a2, b2] = hexToOklab(color2)
  const w = Math.max(0, Math.min(1, weight))

  const L = L1 + (L2 - L1) * w
  const a = a1 + (a2 - a1) * w
  const b = b1 + (b2 - b1) * w

  // OKLab → LMS
  const l_ = L + a * 0.3963377774 + b * 0.2158037573
  const m_ = L - a * 0.1055613458 - b * 0.0638541728
  const s_ = L - a * 0.0894841775 - b * 1.2914855480

  // Cube (inverse of cube root)
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  // LMS → linear sRGB
  const rLin = l *  4.0767416621 + m * -3.3077115913 + s *  0.2309699292
  const gLin = l * -1.2684380046 + m *  2.6097574011 + s * -0.3413193965
  const bLin = l * -0.0041960863 + m * -0.7034186147 + s *  1.7076147010

  // Linear sRGB → gamma-corrected sRGB → hex. `byteHex` clamps, which is
  // what keeps an out-of-gamut OKLab mix from producing a negative or
  // five-digit channel.
  return `#${byteHex(linearToSrgb(rLin) * 255)}${byteHex(linearToSrgb(gLin) * 255)}${byteHex(linearToSrgb(bLin) * 255)}`
}