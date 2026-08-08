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

// Bezier easing approximation or simple evaluation
export function ease(t: number, easing: Easing, center: number = 0.5, power: number = 2): number {
  t = Math.max(0, Math.min(1, t))
  
  if (easing.startsWith('expr(')) {
    // to be fixed, dont touch or use it
    const expr = easing.slice(5, -1);
    try {
      const evaluate = new Function('x', `with(Math) { return ${expr}; }`);
      return Number(evaluate(t)) || 0;
    } catch (e) {
      return t;
    }
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
    case "half-parabola": return Math.pow(t, power)
    case "easeOut": return t * (2 - t)
    case "easeInOut": 
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
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color).toString(16).padStart(2, "0")
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ]
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
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
  const [r1, g1, b1] = hexToRgb(color1)
  const [r2, g2, b2] = hexToRgb(color2)
  const w = Math.max(0, Math.min(1, weight))
  const r = Math.round(r1 + (r2 - r1) * w)
  const g = Math.round(g1 + (g2 - g1) * w)
  const b = Math.round(b1 + (b2 - b1) * w)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
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

export function mixMultipleStops(stops: ColorStop[], weight: number): string {
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
  const frac = (weight - stops[i].position) / range;
  return mixHex(stops[i].color, stops[i + 1].color, frac);
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

  // Linear sRGB → gamma-corrected sRGB → hex
  const r255 = Math.round(linearToSrgb(rLin) * 255)
  const g255 = Math.round(linearToSrgb(gLin) * 255)
  const b255 = Math.round(linearToSrgb(bLin) * 255)

  return `#${r255.toString(16).padStart(2, '0')}${g255.toString(16).padStart(2, '0')}${b255.toString(16).padStart(2, '0')}`
}