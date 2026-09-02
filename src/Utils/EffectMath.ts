// ============================================================
// Quasar — Effect Math
// ============================================================
//
// The evaluation kernel shared by everything that modulates text: the
// `[gradient]` / `[grow]` / `[rainbow]` tag handlers, the HTML renderer's
// preview of them, and Text Studio's own compiler in @miliastry/quasar-studio.
//
// It lives here, in the engine, for one reason: the same document has to
// look the same in all three. When the studio owned this maths and the
// tag handlers owned a second copy, `[gradient=#a,#b]` rendered one way
// in the studio preview and exported another way through the registry,
// and every parameter the studio grew — easing, waveforms, axes — was
// silently dropped the moment the document round-tripped through BBCode.
//
// The model is three stages:
//
//   axis(sample) → u ∈ [0,1]      where the character sits
//   wave(u)      → v ∈ [0,1]      what the curve says there
//   effect(v)    → colour / size  what that means visually
//
// Everything stochastic is seeded and addressed by character offset, never
// drawn from `Math.random()`: these functions run on every keystroke, and
// an unseeded effect produces different output each time it is evaluated,
// which makes previews flicker and exports unreproducible.
// ============================================================

import {
  hexToRgb, hexToHsl, hslToHex, solveCubicBezierY, mixHex, mixMultipleStops,
  ease, __setExpressionCompiler, type ColorStop, type Easing,
} from './ColorMath'

// ── Deterministic randomness ───────────────────────────────────

/** FNV-1a over a string → 32-bit unsigned seed. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Stateless hash → [0,1) for one (seed, index) pair.
 *
 * Stateless matters: layers are evaluated per text node and per range, in
 * an order the user can change by dragging. A stateful generator would
 * hand character #7 a different number depending on how the document was
 * split into nodes. Addressing by index makes the value a pure function
 * of the character's position.
 */
export function randAt(seed: number, index: number): number {
  let t = (Math.imul(index ^ seed, 0x27d4eb2d) + seed) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Smooth (cosine-interpolated) value noise over a 1-D axis. */
export function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x)
  const f = x - i
  const a = randAt(seed, i)
  const b = randAt(seed, i + 1)
  // Smoothstep between lattice points — cheaper than cosine, same shape.
  const t = f * f * (3 - 2 * f)
  return a + (b - a) * t
}

/** Fractal Brownian motion: octaves of value noise at halving amplitude. */
export function fbm(x: number, seed: number, octaves = 4): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  const n = Math.max(1, Math.min(8, Math.round(octaves)))
  for (let o = 0; o < n; o++) {
    sum += valueNoise(x * freq, seed + o * 7919) * amp
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return norm > 0 ? sum / norm : 0
}

// ── Sandboxed expressions ──────────────────────────────────────

/**
 * Variables an `expr(...)` waveform can read.
 *
 * `u` is the raw axis position, `t` its alias, `i`/`n` the character's
 * index and the unit count, `line`/`col` its 2-D address, and `rnd` a
 * deterministic per-character random draw.
 */
export interface ExpressionVars {
  u: number
  t: number
  x: number
  i: number
  n: number
  line: number
  lines: number
  col: number
  cols: number
  word: number
  words: number
  rnd: number
}

export const EXPRESSION_VARS: readonly (keyof ExpressionVars)[] = [
  'u', 't', 'x', 'i', 'n', 'line', 'lines', 'col', 'cols', 'word', 'words', 'rnd',
]

/**
 * Math members an expression may name. Anything else is rejected.
 *
 * They are passed to the compiled function as ordinary parameters rather
 * than pulled in with `with (Math)`. `with` is a syntax error under
 * `"use strict"`, and dropping strict mode to keep it would hand the
 * expression a writable global scope — the opposite of what a sandbox is
 * for.
 */
const MATH_NAMES = [
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt',
  'ceil', 'cos', 'cosh', 'exp', 'floor', 'hypot', 'log', 'log2', 'log10',
  'max', 'min', 'pow', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh',
  'trunc', 'PI', 'E', 'LN2', 'LN10', 'SQRT2',
] as const

const MATH_ALLOWLIST = new Set<string>(MATH_NAMES)

const MATH_VALUES = MATH_NAMES.map(
  name => (Math as unknown as Record<string, unknown>)[name],
)

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g
/** Characters an expression may contain outside identifiers and digits. */
const OPERATOR_RE = /^[0-9.\s+\-*/%()<>!&|?:,=]*$/

export type CompiledExpression = (vars: ExpressionVars) => number

const expressionCache = new Map<string, CompiledExpression | null>()
const EXPRESSION_CACHE_LIMIT = 256

/**
 * Validate that `src` is pure arithmetic over the allowed vocabulary.
 *
 * The check is allowlist-based in both directions: every identifier must
 * be a known variable or `Math` member, and every remaining character
 * must be an operator or a digit. That rejects property access
 * (`constructor`, `__proto__`), string and template literals, array and
 * object syntax, and statement separators — the whole surface an
 * injected payload would need — without trying to enumerate attacks.
 */
export function validateExpression(src: string): { ok: true } | { ok: false; reason: string } {
  if (!src.trim()) return { ok: false, reason: 'empty' }
  if (src.length > 512) return { ok: false, reason: 'too long' }

  const identifiers = src.match(IDENTIFIER_RE) ?? []
  for (const id of identifiers) {
    if (MATH_ALLOWLIST.has(id)) continue
    if ((EXPRESSION_VARS as readonly string[]).includes(id)) continue
    return { ok: false, reason: `unknown name "${id}"` }
  }

  const skeleton = src.replace(IDENTIFIER_RE, '')
  if (!OPERATOR_RE.test(skeleton)) {
    return { ok: false, reason: 'illegal character' }
  }
  // `=` is only legal as part of a comparison; a bare one is an assignment.
  if (/[^=!<>]=[^=]/.test(` ${skeleton} `)) {
    return { ok: false, reason: 'assignment not allowed' }
  }
  return { ok: true }
}

/** Compile a validated expression, or return null if it is rejected. */
export function compileExpression(src: string): CompiledExpression | null {
  const cached = expressionCache.get(src)
  if (cached !== undefined) return cached

  let compiled: CompiledExpression | null = null
  if (validateExpression(src).ok) {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        ...MATH_NAMES,
        ...EXPRESSION_VARS,
        `"use strict"; return (${src});`,
      ) as (...args: unknown[]) => unknown
      compiled = (vars: ExpressionVars) => {
        const out = fn(...MATH_VALUES, ...EXPRESSION_VARS.map(k => vars[k]))
        const num = Number(out)
        return Number.isFinite(num) ? num : 0
      }
      // Fail fast on expressions that throw for every input rather than
      // discovering it once per character.
      compiled({ u: 0.5, t: 0.5, x: 0.5, i: 0, n: 1, line: 0, lines: 1, col: 0, cols: 1, word: 0, words: 1, rnd: 0.5 })
    } catch {
      compiled = null
    }
  }

  if (expressionCache.size >= EXPRESSION_CACHE_LIMIT) expressionCache.clear()
  expressionCache.set(src, compiled)
  return compiled
}

// ── Waveforms ──────────────────────────────────────────────────

export type WaveKind =
  | 'none'
  | 'sine'
  | 'cosine'
  | 'triangle'
  | 'sawtooth'
  | 'square'
  | 'bounce'
  | 'elastic'
  | 'exponential'
  | 'pulse'
  | 'edges'
  | 'alternate'
  | 'noise'
  | 'fbm'
  | 'steps'
  | 'bezier'
  | 'expr'

export const WAVE_KINDS: readonly WaveKind[] = [
  'none', 'sine', 'cosine', 'triangle', 'sawtooth', 'square', 'bounce',
  'elastic', 'exponential', 'pulse', 'edges', 'alternate', 'noise', 'fbm',
  'steps', 'bezier', 'expr',
]

export interface WaveOptions {
  /** How many times the waveform repeats across the axis. */
  cycles: number
  /** Shifts the waveform along the axis, in cycles. */
  phase: number
  /** Control points for `bezier`. */
  bezier: readonly [number, number, number, number]
  /** Source for `expr`. */
  expression?: string
  /** Octaves for `fbm`. */
  octaves: number
  /** Quantisation levels for `steps`, and post-quantisation for any wave. */
  steps: number
  /** Seed for `noise` / `fbm`. */
  seed: number
  /** Index used to address deterministic noise and index-parity waves. */
  index: number
  /** Unit count in the scope, for index-based waves. */
  count: number
  /** Full variable bag, for `expr`. */
  vars?: ExpressionVars
}

export const DEFAULT_WAVE_OPTIONS: WaveOptions = {
  cycles: 1,
  phase: 0,
  bezier: [0.25, 0.1, 0.25, 1.0],
  octaves: 4,
  steps: 0,
  seed: 0,
  index: 0,
  count: 1,
}

const TAU = Math.PI * 2

/**
 * Evaluate a waveform at axis position `u`, returning [0,1].
 *
 * `cycles`/`phase` are applied first so every periodic wave shares one
 * notion of frequency, and the non-periodic ones (`bezier`, `steps`,
 * `edges`) read the wrapped position too so a cycles slider still does
 * something sensible for them.
 */
export function waveform(kind: WaveKind, u: number, opts: Partial<WaveOptions> = {}): number {
  // Read through with defaults rather than spreading into a fresh object.
  // This runs once per character per layer, and building a nine-field
  // object each time cost more than every waveform in the table combined.
  const o = opts as WaveOptions
  const oCycles = o.cycles ?? DEFAULT_WAVE_OPTIONS.cycles
  const oPhase = o.phase ?? DEFAULT_WAVE_OPTIONS.phase
  const oBezier = o.bezier ?? DEFAULT_WAVE_OPTIONS.bezier
  const oOctaves = o.octaves ?? DEFAULT_WAVE_OPTIONS.octaves
  const oSteps = o.steps ?? DEFAULT_WAVE_OPTIONS.steps
  const oSeed = o.seed ?? DEFAULT_WAVE_OPTIONS.seed
  const oIndex = o.index ?? DEFAULT_WAVE_OPTIONS.index

  const clamped = clamp01(u)

  // Position within the current cycle, in [0,1).
  const cycles = Number.isFinite(oCycles) ? oCycles : 1
  const scaled = clamped * cycles + oPhase
  const p = ((scaled % 1) + 1) % 1
  const angle = scaled * TAU

  let v: number
  switch (kind) {
    case 'none':
      v = clamped
      break
    case 'sine':
      v = (Math.sin(angle) + 1) / 2
      break
    case 'cosine':
      v = (Math.cos(angle) + 1) / 2
      break
    case 'triangle':
      v = 1 - Math.abs(p * 2 - 1)
      break
    case 'sawtooth':
      v = p
      break
    case 'square':
      v = p < 0.5 ? 1 : 0
      break
    case 'bounce':
      v = bounceOut(p)
      break
    case 'elastic':
      v = elasticOut(p)
      break
    case 'exponential':
      v = p === 0 ? 0 : Math.pow(2, 10 * (p - 1))
      break
    case 'pulse': {
      // A sharp spike at the centre of each cycle.
      const dist = Math.abs(p - 0.5) * 2
      v = Math.pow(Math.max(0, 1 - dist), 8)
      break
    }
    case 'edges': {
      // Maximum at both ends of the cycle, minimum in the middle.
      const dist = Math.abs(p * 2 - 1)
      v = dist * dist
      break
    }
    case 'alternate':
      // Index parity, not a continuous wave: the point is that adjacent
      // characters differ, which a periodic function only approximates.
      v = Math.floor(oIndex * Math.max(1, cycles)) % 2 === 0 ? 1 : 0
      break
    case 'noise':
      v = valueNoise(scaled * 4 + oIndex * 0.0001, oSeed)
      break
    case 'fbm':
      v = fbm(scaled * 3, oSeed, oOctaves)
      break
    case 'steps': {
      const levels = Math.max(2, Math.round(oSteps || 4))
      v = Math.round(p * (levels - 1)) / (levels - 1)
      break
    }
    case 'bezier':
      v = solveCubicBezierY(p, oBezier[0], oBezier[1], oBezier[2], oBezier[3])
      break
    case 'expr': {
      const fn = o.expression ? compileExpression(o.expression) : null
      if (!fn) { v = clamped; break }
      const vars = o.vars
        ? { ...o.vars, u: p, t: p, x: p }
        : { u: p, t: p, x: p, i: oIndex, n: 1, line: 0, lines: 1, col: 0, cols: 1, word: 0, words: 1, rnd: randAt(oSeed, oIndex) }
      v = fn(vars)
      break
    }
    default:
      v = clamped
  }

  // A post-quantisation pass is what turns any smooth wave into a banded
  // one — and, on the export side, collapses hundreds of near-identical
  // [color] tags into a handful of long runs.
  if (kind !== 'steps' && oSteps && oSteps >= 2) {
    const levels = Math.round(oSteps)
    v = Math.round(clamp01(v) * (levels - 1)) / (levels - 1)
  }

  return clamp01(v)
}

function bounceOut(t: number): number {
  const n1 = 7.5625
  const d1 = 2.75
  if (t < 1 / d1) return n1 * t * t
  if (t < 2 / d1) { const t2 = t - 1.5 / d1; return n1 * t2 * t2 + 0.75 }
  if (t < 2.5 / d1) { const t2 = t - 2.25 / d1; return n1 * t2 * t2 + 0.9375 }
  const t2 = t - 2.625 / d1
  return n1 * t2 * t2 + 0.984375
}

function elasticOut(t: number): number {
  if (t === 0 || t === 1) return t
  const c4 = TAU / 3
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// ── Blend modes ────────────────────────────────────────────────

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'colorDodge'
  | 'colorBurn'
  | 'hardLight'
  | 'softLight'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

export const BLEND_MODES: readonly BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'colorDodge', 'colorBurn', 'hardLight', 'softLight', 'difference',
  'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]

/** Separable blend functions, operating on one channel in [0,1]. */
const SEPARABLE: Partial<Record<BlendMode, (b: number, s: number) => number>> = {
  normal: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  colorDodge: (b, s) => (b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s))),
  colorBurn: (b, s) => (b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  hardLight: (b, s) => (s <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b)),
  softLight: (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b)
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)
    return b + (2 * s - 1) * (d - b)
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
}

type Rgb = [number, number, number]

function lum(c: Rgb): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

function clipColor(c: Rgb): Rgb {
  const l = lum(c)
  const min = Math.min(c[0], c[1], c[2])
  const max = Math.max(c[0], c[1], c[2])
  let out = c
  if (min < 0) {
    const d = l - min
    out = d === 0 ? [l, l, l] : (out.map(v => l + ((v - l) * l) / d) as Rgb)
  }
  if (max > 1) {
    const d = max - l
    out = d === 0 ? [l, l, l] : (out.map(v => l + ((v - l) * (1 - l)) / d) as Rgb)
  }
  return out
}

function setLum(c: Rgb, l: number): Rgb {
  const d = l - lum(c)
  return clipColor([c[0] + d, c[1] + d, c[2] + d])
}

function sat(c: Rgb): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])
}

function setSat(c: Rgb, s: number): Rgb {
  const idx: [number, number, number] = [0, 1, 2]
  idx.sort((a, b) => c[a] - c[b])
  const [minI, midI, maxI] = idx
  const out: Rgb = [0, 0, 0]
  if (c[maxI] > c[minI]) {
    out[midI] = ((c[midI] - c[minI]) * s) / (c[maxI] - c[minI])
    out[maxI] = s
  }
  out[minI] = 0
  return out
}

/**
 * Composite `layer` over `base` with a blend mode and opacity.
 *
 * Follows the W3C compositing spec (the same maths Photoshop uses), so
 * the separable modes match what a designer expects and the four
 * non-separable ones (hue/saturation/color/luminosity) transplant one
 * property while preserving the rest.
 */
export function blendHex(base: string, layer: string, mode: BlendMode, opacity = 1): string {
  const alpha = clamp01(opacity)
  if (alpha <= 0) return base
  if (mode === 'normal') return alpha >= 1 ? layer : mixHex(base, layer, alpha)

  const [br, bg, bb] = hexToRgb(base)
  const [sr, sg, sb] = hexToRgb(layer)
  const b: Rgb = [br / 255, bg / 255, bb / 255]
  const s: Rgb = [sr / 255, sg / 255, sb / 255]

  let blended: Rgb
  const fn = SEPARABLE[mode]
  if (fn) {
    blended = [fn(b[0], s[0]), fn(b[1], s[1]), fn(b[2], s[2])]
  } else {
    switch (mode) {
      case 'hue': blended = setLum(setSat(s, sat(b)), lum(b)); break
      case 'saturation': blended = setLum(setSat(b, sat(s)), lum(b)); break
      case 'color': blended = setLum(s, lum(b)); break
      case 'luminosity': blended = setLum(b, lum(s)); break
      default: blended = s
    }
  }

  const out: Rgb = [
    b[0] + (blended[0] - b[0]) * alpha,
    b[1] + (blended[1] - b[1]) * alpha,
    b[2] + (blended[2] - b[2]) * alpha,
  ]
  return rgbToHex(out[0] * 255, out[1] * 255, out[2] * 255)
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${BYTE_HEX[clampByte(r)]}${BYTE_HEX[clampByte(g)]}${BYTE_HEX[clampByte(b)]}`
}

/** Two-character lowercase hex per byte, built once. */
const BYTE_HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'))

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

// ── Colour utilities built on the kernel ───────────────────────

/** Shift or set a colour's HSL components. Amounts are absolute. */
export function adjustHsl(
  hex: string,
  opts: { hue?: number; sat?: number; light?: number; absolute?: boolean },
): string {
  const [h, s, l] = hexToHsl(hex)
  const dh = opts.hue ?? 0
  const ds = opts.sat ?? 0
  const dl = opts.light ?? 0
  if (opts.absolute) {
    return hslToHex(
      ((dh % 360) + 360) % 360,
      clampRange(ds, 0, 100),
      clampRange(dl, 0, 100),
    )
  }
  return hslToHex(
    (((h + dh) % 360) + 360) % 360,
    clampRange(s + ds, 0, 100),
    clampRange(l + dl, 0, 100),
  )
}

/** Snap each channel to `levels` evenly spaced values. */
export function posterizeHex(hex: string, levels: number): string {
  const n = Math.max(2, Math.min(64, Math.round(levels)))
  const step = 255 / (n - 1)
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(
    Math.round(r / step) * step,
    Math.round(g / step) * step,
    Math.round(b / step) * step,
  )
}

export function clampRange(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return v < min ? min : v > max ? max : v
}

// ═══════════════════════════════════════════════════════════════
// Character coordinate model
// ═══════════════════════════════════════════════════════════════

/** One character's address within the document. */
export interface CharSample {
  /** Code-point offset in the plain text. */
  offset: number
  /** True for whitespace, which carries no visual index. */
  isSpace: boolean
  /** Running index among non-whitespace characters, document-wide. -1 for spaces. */
  index: number
  /** Zero-based line number. */
  line: number
  /** Running index among non-whitespace characters within the line. -1 for spaces. */
  col: number
  /**
   * Visual column: every character on the line counted, spaces included.
   *
   * `col` deliberately skips whitespace so a gradient does not spend a
   * step of its ramp on a space — the right rule for a ramp, and the
   * wrong one for a picture. In ASCII art the spaces ARE the layout, so
   * `"  \u2588\u2588"` has its blocks at visual columns 2 and 3 while `col`
   * calls them 0 and 1. A spatial effect that read `col` would shear
   * every line left by its own indentation.
   *
   * Both coordinates therefore exist side by side: `col` for ramps,
   * `rawCol` for geometry.
   */
  rawCol: number
  /** Zero-based word number, document-wide. -1 for spaces. */
  word: number
}

/** The whole document's coordinate table. */
export interface SampleTable {
  /** One entry per code point of the plain text. */
  samples: CharSample[]
  /** Non-whitespace character count. */
  count: number
  lineCount: number
  /** Non-whitespace character count per line. */
  lineLengths: number[]
  /** Every-character length per line, for geometry. */
  rawLineLengths: number[]
  /** The widest line, in visual columns. The grid's width. */
  maxCols: number
  wordCount: number
}

const EMPTY_TABLE: SampleTable = {
  samples: [],
  count: 0,
  lineCount: 0,
  lineLengths: [],
  rawLineLengths: [],
  maxCols: 0,
  wordCount: 0,
}

/**
 * Build the coordinate table for a plain-text document.
 *
 * Whitespace is addressed but never indexed: it keeps its offset and line
 * so ranges can span it, but gets `index = -1` so it does not consume a
 * step of a gradient. That is what stops "a b" from spending a third of
 * its colour ramp on the space.
 */
export function buildSampleTable(plainText: string): SampleTable {
  if (!plainText) return EMPTY_TABLE

  const chars = Array.from(plainText)
  const samples: CharSample[] = new Array(chars.length)
  const lineLengths: number[] = []
  const rawLineLengths: number[] = []

  let index = 0
  let line = 0
  let col = 0
  let rawCol = 0
  let word = -1
  let inWord = false
  let maxCols = 0

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]

    if (ch === '\n') {
      lineLengths.push(col)
      rawLineLengths.push(rawCol)
      if (rawCol > maxCols) maxCols = rawCol
      // The break itself sits one past the line's last character, which
      // is where a mask's right edge belongs.
      samples[i] = { offset: i, isSpace: true, index: -1, line, col: -1, rawCol, word: -1 }
      line++
      col = 0
      rawCol = 0
      inWord = false
      continue
    }

    const isSpace = ch.trim().length === 0
    if (isSpace) {
      samples[i] = { offset: i, isSpace: true, index: -1, line, col: -1, rawCol, word: -1 }
      rawCol++
      inWord = false
      continue
    }

    if (!inWord) {
      word++
      inWord = true
    }

    samples[i] = { offset: i, isSpace: false, index, line, col, rawCol, word }
    index++
    col++
    rawCol++
  }

  lineLengths.push(col)
  rawLineLengths.push(rawCol)
  if (rawCol > maxCols) maxCols = rawCol

  return {
    samples,
    count: index,
    lineCount: lineLengths.length,
    lineLengths,
    rawLineLengths,
    maxCols,
    wordCount: word + 1,
  }
}

// ── Scopes ─────────────────────────────────────────────────────

/**
 * A character range with its own local coordinate system.
 *
 * Local matters: a gradient applied to characters 40–60 should run its
 * full ramp across those twenty characters, not show the slice of a
 * document-wide ramp that happens to fall there. Every layer reads local
 * coordinates; only `sample` keeps the document-wide ones, for effects
 * that deliberately want the global picture.
 */
export interface RangeScope {
  start: number
  end: number
  /** Non-whitespace count inside the range. */
  count: number
  /** Local index per offset, `-1` for whitespace and out-of-range. */
  localIndex: Int32Array
  /** Local line number per offset, `-1` out of range. */
  localLine: Int32Array
  /** Local column per offset, `-1` for whitespace and out-of-range. */
  localCol: Int32Array
  /** Local word number per offset, `-1` for whitespace and out-of-range. */
  localWord: Int32Array
  /**
   * Visual column per offset, spaces counted, `-1` out of range.
   *
   * Unlike `localCol` this is NOT re-based per line: it keeps the
   * document's own column so a range starting mid-line still sits where
   * the reader sees it. `rawColMin`/`rawColMax` carry the bounding box
   * that turns it into a [0,1] coordinate.
   */
  localRawCol: Int32Array
  /** Left edge of the range's painted bounding box, in visual columns. */
  rawColMin: number
  /** Right edge of that box. Equal to `rawColMin` for a single column. */
  rawColMax: number
  lineCount: number
  lineLengths: number[]
  wordCount: number
}

/**
 * Derive a range's local coordinate system from the document table.
 *
 * Cost is O(range length) and it is computed once per compile per range,
 * which is what lets `applyLayer` be a straight indexed lookup no matter
 * how many layers the range stacks.
 */
export function buildRangeScope(table: SampleTable, start: number, end: number): RangeScope {
  const total = table.samples.length
  const s = Math.max(0, Math.min(start, total))
  const e = Math.max(s, Math.min(end, total))
  const len = e - s

  const localIndex = new Int32Array(len).fill(-1)
  const localLine = new Int32Array(len).fill(-1)
  const localCol = new Int32Array(len).fill(-1)
  const localWord = new Int32Array(len).fill(-1)
  const localRawCol = new Int32Array(len).fill(-1)
  const lineLengths: number[] = []

  if (len === 0) {
    return {
      start: s, end: e, count: 0,
      localIndex, localLine, localCol, localWord,
      localRawCol, rawColMin: 0, rawColMax: 0,
      lineCount: 0, lineLengths: [], wordCount: 0,
    }
  }

  // Local lines are the document's lines re-based on the range's first
  // one, so a range that starts mid-paragraph still sees line 0 at its
  // own top edge rather than inheriting the document's numbering.
  const baseLine = table.samples[s].line

  const lastLine = table.samples[e - 1].line - baseLine
  for (let l = 0; l <= lastLine; l++) lineLengths.push(0)

  let index = 0
  let word = -1
  let inWord = false
  // The bounding box is measured over PAINTED characters only. Measuring
  // it over every offset would let a line's trailing spaces stretch the
  // box to the right of anything the reader can see, and a shape centred
  // in that box would sit off-centre on the page.
  let rawColMin = Number.POSITIVE_INFINITY
  let rawColMax = Number.NEGATIVE_INFINITY

  for (let i = 0; i < len; i++) {
    const sample = table.samples[s + i]
    const line = sample.line - baseLine
    localLine[i] = line
    localRawCol[i] = sample.rawCol

    if (sample.isSpace) {
      inWord = false
      continue
    }

    if (!inWord) { word++; inWord = true }
    localIndex[i] = index
    localCol[i] = lineLengths[line]
    localWord[i] = word
    lineLengths[line]++
    index++

    if (sample.rawCol < rawColMin) rawColMin = sample.rawCol
    if (sample.rawCol > rawColMax) rawColMax = sample.rawCol
  }

  if (!Number.isFinite(rawColMin)) { rawColMin = 0; rawColMax = 0 }

  return {
    start: s,
    end: e,
    count: index,
    localIndex,
    localLine,
    localCol,
    localWord,
    localRawCol,
    rawColMin,
    rawColMax,
    lineCount: lineLengths.length,
    lineLengths,
    wordCount: word + 1,
  }
}

/** A scope covering the whole document. */
export function documentScope(table: SampleTable): RangeScope {
  return buildRangeScope(table, 0, table.samples.length)
}

// ── Axes ───────────────────────────────────────────────────────

/**
 * How a character's address collapses into the single number `u ∈ [0,1]`
 * that drives a layer.
 */
export type Axis =
  | 'index'
  | 'word'
  | 'line'
  | 'column'
  | 'diagonal'
  | 'radial'
  | 'angular'
  | 'random'
  | 'wave'
  // ── Placeable, aspect-corrected. See SpatialOptions. ──
  | 'spot'
  | 'sweep'
  | 'linear'

export const AXES: readonly Axis[] = [
  'index', 'word', 'line', 'column', 'diagonal', 'radial', 'angular', 'random', 'wave',
  'spot', 'sweep', 'linear',
]

/** Axes that read an origin, an angle and a radius. */
export const SPATIAL_AXES: ReadonlySet<Axis> = new Set<Axis>(['spot', 'sweep', 'linear'])

/** Everything a layer needs to place one character. */
export interface SampleContext {
  sample: CharSample
  scope: RangeScope
  table: SampleTable
  /** Local index within the scope, `-1` for whitespace. */
  local: number
}

function norm(value: number, count: number): number {
  if (count <= 1) return 0
  return clamp01(value / (count - 1))
}

// ── Page geometry ──────────────────────────────────────────────
//
// The axes above collapse a character to one number and stop. A shape
// cannot: a circle needs to know that the box it sits in is forty
// characters wide and six lines tall, and that a character cell is about
// twice as tall as it is wide. Without that second fact a circle renders
// as a flat oval, because forty columns and forty rows are not the same
// distance on the page.

/**
 * Width ÷ height of one character cell.
 *
 * Monospace faces cluster around 0.5–0.6; this is the middle of that
 * range and the value every shape assumes unless the document says
 * otherwise.
 */
export const DEFAULT_CELL_ASPECT = 0.55

/** Where a placeable effect sits and how far it reaches. */
export interface SpatialOptions {
  /** Origin across the box, 0 = left edge, 1 = right edge. */
  originX: number
  /** Origin down the box, 0 = top, 1 = bottom. */
  originY: number
  /** Rotation of `linear` and `sweep`, in degrees, clockwise from east. */
  angle: number
  /** Reach of `spot` and `linear`, in units of the box's longer side. */
  radius: number
  /** Width ÷ height of a character cell. */
  aspect: number
}

export const DEFAULT_SPATIAL: SpatialOptions = {
  originX: 0.5,
  originY: 0.5,
  angle: 0,
  radius: 0.5,
  aspect: DEFAULT_CELL_ASPECT,
}

/**
 * A character's place on the page, in a square-ish coordinate system.
 *
 * `x`/`y` are the plain [0,1] fractions across the range's painted
 * bounding box. `w`/`h` are that box's physical proportions, normalised
 * so the longer side is 1 — multiplying the fractions by them is what
 * makes a circle round instead of an oval.
 *
 * A single-line range has no vertical extent, so every character reports
 * `y = 0.5`: the text is one line tall and sits at its own middle. The
 * same holds for `x` in a single-column range.
 */
export interface SpatialPoint {
  x: number
  y: number
  w: number
  h: number
}

export function spatialPoint(ctx: SampleContext, cellAspect = DEFAULT_CELL_ASPECT): SpatialPoint {
  const { scope, sample } = ctx
  const rel = sample.offset - scope.start

  const colSpan = scope.rawColMax - scope.rawColMin
  const rowSpan = scope.lineCount - 1

  const rawCol = rel >= 0 && rel < scope.localRawCol.length && scope.localRawCol[rel] >= 0
    ? scope.localRawCol[rel]
    : scope.rawColMin
  const line = rel >= 0 && rel < scope.localLine.length && scope.localLine[rel] >= 0
    ? scope.localLine[rel]
    : 0

  const x = colSpan > 0 ? clamp01((rawCol - scope.rawColMin) / colSpan) : 0.5
  const y = rowSpan > 0 ? clamp01(line / rowSpan) : 0.5

  // Cell counts, not spans: a box one column wide is still one column of
  // physical width, and dividing by a zero span would make it infinitely
  // flat.
  const aspect = Number.isFinite(cellAspect) && cellAspect > 0 ? cellAspect : DEFAULT_CELL_ASPECT
  const pw = (colSpan + 1) * aspect
  const ph = rowSpan + 1
  const longer = Math.max(pw, ph)

  return { x, y, w: pw / longer, h: ph / longer }
}

/** A character's offset from an origin, in the square-ish space. */
function offsetFromOrigin(pt: SpatialPoint, ox: number, oy: number): [number, number] {
  return [(pt.x - ox) * pt.w, (pt.y - oy) * pt.h]
}

function rotate(px: number, py: number, degrees: number): [number, number] {
  if (!degrees) return [px, py]
  const r = (degrees * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [px * c + py * s, -px * s + py * c]
}

/**
 * Project a character onto the [0,1] axis a layer reads.
 *
 * `radial` and `angular` treat the range as a rectangle of lines by
 * columns, which is what makes a multi-line block behave like a canvas
 * rather than a single ribbon of text. They are centred and uncorrected,
 * and stay that way: documents written against them must keep rendering
 * identically. `spot`, `sweep` and `linear` are their placeable,
 * aspect-corrected successors — same idea, with an origin the author
 * chooses and a circle that comes out round.
 */
export function axisValue(
  axis: Axis,
  ctx: SampleContext,
  seed = 0,
  geo: Partial<SpatialOptions> = DEFAULT_SPATIAL,
): number {
  const { sample, scope } = ctx
  const rel = sample.offset - scope.start
  if (rel < 0 || rel >= scope.localIndex.length) return 0

  const line = scope.localLine[rel]
  const col = scope.localCol[rel]
  const lineLen = scope.lineLengths[line] ?? scope.lineLengths[0] ?? 1

  switch (axis) {
    case 'index':
      return norm(ctx.local, scope.count)
    case 'word':
      return norm(scope.localWord[rel], scope.wordCount)
    case 'line':
      return norm(line, scope.lineCount)
    case 'column':
      return norm(col, lineLen)
    case 'diagonal': {
      const x = norm(col, lineLen)
      const y = norm(line, scope.lineCount)
      return clamp01((x + y) / 2)
    }
    case 'radial': {
      const x = norm(col, lineLen) * 2 - 1
      const y = norm(line, scope.lineCount) * 2 - 1
      // Normalised so a corner reads 1 and the centre reads 0.
      return clamp01(Math.hypot(x, y) / Math.SQRT2)
    }
    case 'angular': {
      const x = norm(col, lineLen) * 2 - 1
      const y = norm(line, scope.lineCount) * 2 - 1
      if (x === 0 && y === 0) return 0
      return clamp01(Math.atan2(y, x) / (Math.PI * 2) + 0.5)
    }
    case 'random':
      return randAt(seed, sample.offset)
    case 'wave': {
      // Serpentine: alternate lines run right-to-left, so a gradient
      // reads continuously down a paragraph instead of snapping back.
      const x = norm(col, lineLen)
      return line % 2 === 0 ? x : 1 - x
    }

    case 'spot': {
      // Distance from a chosen point. `radius` is the reach: at the
      // radius the ramp has run out, beyond it it stays at its end.
      const pt = spatialPoint(ctx, geo.aspect ?? DEFAULT_SPATIAL.aspect)
      const [px, py] = offsetFromOrigin(
        pt, geo.originX ?? DEFAULT_SPATIAL.originX, geo.originY ?? DEFAULT_SPATIAL.originY,
      )
      const radius = geo.radius ?? DEFAULT_SPATIAL.radius
      if (!(radius > 0)) return 0
      return clamp01(Math.hypot(px, py) / radius)
    }

    case 'sweep': {
      // Angle around a chosen point, so a ramp can spin about a word in
      // the middle of a paragraph rather than about the paragraph.
      const pt = spatialPoint(ctx, geo.aspect ?? DEFAULT_SPATIAL.aspect)
      const [px, py] = offsetFromOrigin(
        pt, geo.originX ?? DEFAULT_SPATIAL.originX, geo.originY ?? DEFAULT_SPATIAL.originY,
      )
      if (px === 0 && py === 0) return 0
      const a = Math.atan2(py, px) - ((geo.angle ?? DEFAULT_SPATIAL.angle) * Math.PI) / 180
      let turns = a / (Math.PI * 2)
      turns -= Math.floor(turns)
      return clamp01(turns)
    }

    case 'linear': {
      // A ramp along an arbitrary direction. `radius` is its half-length,
      // so the origin sits at the ramp's midpoint (0.5) and the ends land
      // one radius away on each side.
      const pt = spatialPoint(ctx, geo.aspect ?? DEFAULT_SPATIAL.aspect)
      const [ox, oy] = offsetFromOrigin(
        pt, geo.originX ?? DEFAULT_SPATIAL.originX, geo.originY ?? DEFAULT_SPATIAL.originY,
      )
      const [px] = rotate(ox, oy, geo.angle ?? DEFAULT_SPATIAL.angle)
      const radius = geo.radius ?? DEFAULT_SPATIAL.radius
      if (!(radius > 0)) return px >= 0 ? 1 : 0
      return clamp01(0.5 + px / (radius * 2))
    }

    default:
      return norm(ctx.local, scope.count)
  }
}

// ── Masks ──────────────────────────────────────────────────────
//
// An axis says WHAT COLOUR a character gets. A mask says WHETHER IT GETS
// ONE AT ALL, and how strongly.
//
// That second question is what a layer stack could not answer before.
// `opacity` was a scalar, so a layer applied everywhere at one strength:
// three gradients over one paragraph each repainted the whole paragraph,
// and the last one won. Making the weight a function of position is the
// entire feature — a gradient in the top-left corner is a gradient whose
// mask is a circle in the top-left corner, and every shape below is one
// more way of writing that function.
//
// The shapes are signed distance fields: negative inside, zero on the
// edge, positive outside. Distance rather than a boolean is what makes
// `feather` a single line of maths instead of a special case per shape.

export type MaskShape =
  | 'none'
  | 'circle'
  | 'ellipse'
  | 'square'
  | 'rect'
  | 'diamond'
  | 'triangle'
  | 'star'
  | 'ring'
  | 'half'

export const MASK_SHAPES: readonly MaskShape[] = [
  'none', 'circle', 'ellipse', 'square', 'rect', 'diamond', 'triangle',
  'star', 'ring', 'half',
]

/** Placement and form of one layer's mask. */
export interface MaskOptions {
  shape: MaskShape
  /** Centre across the box, 0 = left edge, 1 = right edge. */
  x: number
  /** Centre down the box, 0 = top, 1 = bottom. */
  y: number
  /** Half-width, in units of the box's longer side. */
  width: number
  /** Half-height. Read only by `ellipse` and `rect`. */
  height: number
  /** Rotation in degrees, clockwise. */
  rotate: number
  /**
   * Width of the soft edge, in the same units as `width`.
   *
   * Zero gives a hard cut — the right choice for block art, where a
   * half-lit character reads as a mistake. Anything above it fades, which
   * is what stops a circle over prose from looking stamped on.
   */
  feather: number
  /** Keep what falls OUTSIDE the shape instead of inside. */
  invert: boolean
  /** Points, for `star`. */
  points: number
  /** Spike depth for `star` (0 = thin, 1 = polygon); thickness for `ring`. */
  inner: number
  /** Width ÷ height of a character cell. */
  aspect: number
}

export const DEFAULT_MASK: MaskOptions = {
  shape: 'none',
  x: 0.5,
  y: 0.5,
  width: 0.5,
  height: 0.5,
  rotate: 0,
  feather: 0,
  invert: false,
  points: 5,
  inner: 0.45,
  aspect: DEFAULT_CELL_ASPECT,
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** Positive modulo, which `%` is not. */
function pmod(a: number, b: number): number {
  return ((a % b) + b) % b
}

function sdBox(px: number, py: number, bx: number, by: number): number {
  const dx = Math.abs(px) - bx
  const dy = Math.abs(py) - by
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0)
}

function sdRhombus(px: number, py: number, bx: number, by: number): number {
  const ax = Math.abs(px)
  const ay = Math.abs(py)
  const denom = bx * bx + by * by
  if (denom === 0) return Math.hypot(ax, ay)
  // ndot(b - 2p, b) / dot(b, b)
  const h = Math.max(-1, Math.min(1, ((bx - 2 * ax) * bx - (by - 2 * ay) * by) / denom))
  const d = Math.hypot(ax - 0.5 * bx * (1 - h), ay - 0.5 * by * (1 + h))
  return d * Math.sign(ax * by + ay * bx - bx * by)
}

function sdEquilateralTriangle(px: number, py: number, r: number): number {
  if (!(r > 0)) return Math.hypot(px, py)
  const k = Math.sqrt(3)
  let x = Math.abs(px) - r
  let y = py + r / k
  if (x + k * y > 0) {
    const nx = (x - k * y) / 2
    const ny = (-k * x - y) / 2
    x = nx
    y = ny
  }
  x -= Math.max(-2 * r, Math.min(0, x))
  return -Math.hypot(x, y) * Math.sign(y)
}

function sdStar(px: number, py: number, r: number, n: number, m: number): number {
  if (!(r > 0)) return Math.hypot(px, py)
  const an = Math.PI / n
  const en = Math.PI / m
  const acsX = Math.cos(an)
  const acsY = Math.sin(an)
  const ecsX = Math.cos(en)
  const ecsY = Math.sin(en)

  // Fold the plane into one wedge, so one wedge's maths covers every point.
  const bn = pmod(Math.atan2(px, py), 2 * an) - an
  const len = Math.hypot(px, py)
  let qx = len * Math.cos(bn) - r * acsX
  let qy = len * Math.abs(Math.sin(bn)) - r * acsY

  const reach = ecsY !== 0 ? (r * acsY) / ecsY : 0
  const t = Math.max(0, Math.min(reach, -(qx * ecsX + qy * ecsY)))
  qx += ecsX * t
  qy += ecsY * t

  return Math.hypot(qx, qy) * Math.sign(qx)
}

/**
 * Signed distance from a character to a shape's edge, negative inside.
 *
 * Exported so a preview can draw the outline from the same maths that
 * decides which characters the shape covers. Two implementations of a
 * shape is two shapes.
 */
export function maskDistance(ctx: SampleContext, opts: Partial<MaskOptions> = {}): number {
  const shape = opts.shape ?? DEFAULT_MASK.shape
  if (shape === 'none') return -1

  const pt = spatialPoint(ctx, opts.aspect ?? DEFAULT_MASK.aspect)
  const [ox, oy] = offsetFromOrigin(pt, opts.x ?? DEFAULT_MASK.x, opts.y ?? DEFAULT_MASK.y)
  const [px, py] = rotate(ox, oy, opts.rotate ?? DEFAULT_MASK.rotate)

  const w = Math.max(0, opts.width ?? DEFAULT_MASK.width)
  const h = Math.max(0, opts.height ?? DEFAULT_MASK.height)

  switch (shape) {
    case 'circle':
      return Math.hypot(px, py) - w
    case 'ellipse': {
      if (w <= 0 || h <= 0) return Math.hypot(px, py)
      // Scale to a unit circle, then back by the smaller semi-axis. Exact
      // for a circle and a close enough approximation elsewhere — the
      // value only ever feeds a feather ramp.
      const k = Math.hypot(px / w, py / h)
      return (k - 1) * Math.min(w, h)
    }
    case 'square':
      return sdBox(px, py, w, w)
    case 'rect':
      return sdBox(px, py, w, h)
    case 'diamond':
      return sdRhombus(px, py, w, h)
    case 'triangle':
      // Screen y grows downward; the SDF is written for y growing up, so
      // the sign flip is what keeps the triangle pointing at the sky.
      return sdEquilateralTriangle(px, -py, w)
    case 'star': {
      const n = Math.max(3, Math.round(opts.points ?? DEFAULT_MASK.points))
      const inner = clamp01(opts.inner ?? DEFAULT_MASK.inner)
      // IQ's parameter runs [2, n]: 2 is a thin spike, n a plain polygon.
      const m = 2 + inner * (n - 2)
      return sdStar(px, -py, w, n, m)
    }
    case 'ring': {
      const thickness = Math.max(1e-6, clamp01(opts.inner ?? DEFAULT_MASK.inner) * w)
      return Math.abs(Math.hypot(px, py) - w) - thickness
    }
    case 'half':
      return px
    default:
      return -1
  }
}

/**
 * How strongly a mask covers one character, in [0,1].
 *
 * 1 is fully inside, 0 fully outside. A layer multiplies its opacity by
 * this, so a masked layer composites exactly like an unmasked one at
 * reduced strength — no separate code path, and stacking three masked
 * layers is the same operation as stacking three plain ones.
 */
export function maskValue(ctx: SampleContext, opts: Partial<MaskOptions> = {}): number {
  const shape = opts.shape ?? DEFAULT_MASK.shape
  if (shape === 'none') return 1

  const d = maskDistance(ctx, opts)
  const feather = Math.max(0, opts.feather ?? DEFAULT_MASK.feather)

  const coverage = feather > 0
    ? 1 - smoothstep(-feather / 2, feather / 2, d)
    : (d <= 0 ? 1 : 0)

  return (opts.invert ?? DEFAULT_MASK.invert) ? 1 - coverage : coverage
}

/** Build the variable bag an `expr()` waveform sees for one character. */
export function expressionVars(ctx: SampleContext, u: number, seed: number) {
  const { sample, scope } = ctx
  const rel = sample.offset - scope.start
  const line = rel >= 0 && rel < scope.localLine.length ? scope.localLine[rel] : 0
  const col = rel >= 0 && rel < scope.localCol.length ? scope.localCol[rel] : 0
  const word = rel >= 0 && rel < scope.localWord.length ? scope.localWord[rel] : 0
  return {
    u, t: u, x: u,
    i: ctx.local,
    n: scope.count,
    line,
    lines: scope.lineCount,
    col,
    cols: scope.lineLengths[line] ?? 1,
    word,
    words: scope.wordCount,
    rnd: randAt(seed, sample.offset),
  }
}

// ── Paint grids ────────────────────────────────────────────────
//
// Colouring text from an image, without moving a character.
//
// The obvious implementation — keep the image, sample it at render time
// — cannot work here: a BBCode tag is text, and a document has to survive
// a copy-paste into a forum post. So the image is reduced ONCE, at author
// time, to a small indexed grid: a palette of at most 63 colours and one
// character per cell naming which one. That grid is short enough to live
// in an attribute, and reopening the document gives back an editable
// layer rather than a wall of frozen `[color]` tags.
//
// It is a quantiser, not a compressor. Text has one colour per character
// and a paragraph is maybe eighty columns wide, so the detail an image
// can actually deliver is already far below what a photograph holds.
// Reducing to a palette up front is not a loss — it is the resolution the
// medium has.

/**
 * Cell alphabet. Index 0 (`'0'`) means "paint nothing here", so a grid can
 * have holes and the text keeps its own colour there.
 *
 * Every character is safe inside a BBCode attribute: no `;` (the
 * parameter separator), no `=` (the key separator), no `,` (the colour
 * list separator) and no bracket.
 */
const PAINT_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_.'

/** Palette entries a grid can name, the transparent slot excluded. */
export const PAINT_MAX_COLORS = PAINT_ALPHABET.length - 1

const PAINT_INDEX = new Map<string, number>(
  Array.from(PAINT_ALPHABET).map((ch, i) => [ch, i]),
)

/** An image reduced to something a tag can carry. */
export interface PaintGrid {
  cols: number
  rows: number
  /** Hex colours, `#RRGGBB`. At most `PAINT_MAX_COLORS` of them. */
  palette: string[]
  /** `rows * cols` indices into `palette`; `-1` paints nothing. */
  cells: Int16Array
}

/** Serialise a grid's cells to the alphabet. */
export function stringifyPaintCells(grid: PaintGrid): string {
  const out: string[] = new Array(grid.cells.length)
  for (let i = 0; i < grid.cells.length; i++) {
    const idx = grid.cells[i]
    out[i] = idx < 0 || idx >= grid.palette.length ? PAINT_ALPHABET[0] : PAINT_ALPHABET[idx + 1]
  }
  return out.join('')
}

/**
 * Read a grid back from its parts.
 *
 * Returns `null` rather than a partial grid when the cell count does not
 * match `cols * rows`: a grid off by one cell is sheared diagonally
 * across the whole paragraph, which is far worse than not painting.
 */
export function parsePaintGrid(
  cols: number,
  rows: number,
  paletteStr: string,
  cellsStr: string,
): PaintGrid | null {
  const c = Math.round(cols)
  const r = Math.round(rows)
  if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) return null
  if (!cellsStr || cellsStr.length !== c * r) return null

  const palette = paletteStr
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => normalizeHex(p.startsWith('#') ? p : `#${p}`))
  if (palette.length === 0) return null

  const cells = new Int16Array(c * r)
  for (let i = 0; i < cells.length; i++) {
    const idx = PAINT_INDEX.get(cellsStr[i])
    cells[i] = idx === undefined || idx === 0 ? -1 : idx - 1
  }

  return { cols: c, rows: r, palette, cells }
}

/** Serialise a palette to the attribute form, `#` stripped. */
export function stringifyPaintPalette(palette: readonly string[]): string {
  return palette.map(c => normalizeHex(c).replace('#', '')).join(',')
}

function paintCellAt(grid: PaintGrid, cx: number, cy: number): string | undefined {
  const x = cx < 0 ? 0 : cx >= grid.cols ? grid.cols - 1 : cx
  const y = cy < 0 ? 0 : cy >= grid.rows ? grid.rows - 1 : cy
  const idx = grid.cells[y * grid.cols + x]
  return idx < 0 ? undefined : grid.palette[idx]
}

/**
 * The colour a grid paints at a point of the box, or `undefined` for a
 * hole.
 *
 * `smooth` interpolates between the four surrounding cells, which is what
 * you want over prose — the grid is coarser than the text and hard cells
 * read as banding. It is the wrong choice for block art, where the grid
 * and the characters line up one to one and any interpolation invents
 * colours that belong to neither neighbour, so it defaults off.
 */
export function samplePaintGrid(
  grid: PaintGrid,
  x: number,
  y: number,
  smooth = false,
  perceptual = false,
): string | undefined {
  const gx = clamp01(x) * (grid.cols - 1)
  const gy = clamp01(y) * (grid.rows - 1)

  if (!smooth) {
    return paintCellAt(grid, Math.round(gx), Math.round(gy))
  }

  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0

  const c00 = paintCellAt(grid, x0, y0)
  const c10 = paintCellAt(grid, x0 + 1, y0)
  const c01 = paintCellAt(grid, x0, y0 + 1)
  const c11 = paintCellAt(grid, x0 + 1, y0 + 1)

  // A hole next to a colour stays a hole rather than half-fading into it:
  // partial transparency is not expressible in a `[color]` tag, so the
  // honest answer at the edge of a hole is the neighbour's colour.
  const top = c00 === undefined ? c10 : c10 === undefined ? c00 : mixStop(c00, c10, fx, perceptual)
  const bottom = c01 === undefined ? c11 : c11 === undefined ? c01 : mixStop(c01, c11, fx, perceptual)
  if (top === undefined) return bottom
  if (bottom === undefined) return top
  return mixStop(top, bottom, fy, perceptual)
}

function mixStop(a: string, b: string, t: number, perceptual: boolean): string {
  return mixMultipleStops(
    [{ color: a, position: 0 }, { color: b, position: 1 }],
    clamp01(t),
    perceptual,
  )
}

// ═══════════════════════════════════════════════════════════════
// Effect parameters
// ═══════════════════════════════════════════════════════════════
//
// One attribute grammar for every effect tag:
//
//   [gradient=#ff0000,#00ff00]                      classic, still valid
//   [gradient=#ff0000,#00ff00;easing=easeInOut]     with modulation
//   [rainbow=spread=360;sat=90;axis=line]           no positional part
//   [grow=min=90;max=160;wave=sine;cycles=3]
//
// Segments are separated by `;`. A segment containing `=` is a named
// parameter; one without is the tag's positional value (the colour list).
// That keeps every document ever written with the old one-value form
// parsing unchanged, while giving the studio somewhere to put the rest.
//
// Without this, Miliastry mode was a lossy export: `[rainbow]` carried no
// saturation, no spread and no offset, so re-opening a saved document
// showed a rainbow nobody had configured.

/** Everything an effect tag can carry, after parsing. */
export interface EffectParams {
  /** Colour list for gradient / rainbow ramps. */
  colors?: string[]
  /** Raw stop list, positions included. */
  stops?: ColorStop[]

  axis?: Axis
  wave?: WaveKind
  cycles?: number
  phase?: number
  easing?: string
  bezier?: [number, number, number, number]
  parabolaCenter?: number
  parabolaPower?: number
  invert?: boolean
  steps?: number
  octaves?: number
  expression?: string
  seed?: number
  unit?: EffectUnit
  opacity?: number
  perceptual?: boolean

  // rainbow
  saturation?: number
  lightness?: number
  spread?: number
  offset?: number
  preserveSL?: boolean

  // grow
  min?: number
  max?: number

  // sinewave — an index-in-radians oscillator, not a modulated axis
  freq?: number
  step?: 'char' | 'word'

  // ── Placement (spot / sweep / linear) ──
  originX?: number
  originY?: number
  /** Degrees, clockwise from east. */
  angle?: number
  /** Reach, in units of the box's longer side. */
  radius?: number
  /** Width \u00f7 height of a character cell. */
  aspect?: number

  // ── Mask ──
  maskShape?: MaskShape
  maskX?: number
  maskY?: number
  maskWidth?: number
  maskHeight?: number
  maskRotate?: number
  maskFeather?: number
  maskInvert?: boolean
  maskPoints?: number
  maskInner?: number

  // ── Paint grid (the `image` effect) ──
  gridCols?: number
  gridRows?: number
  /** Comma-separated hex colours, `#` stripped. */
  palette?: string
  /** One character per cell, in the paint alphabet. */
  cells?: string
  /** Interpolate between cells instead of snapping to the nearest. */
  smooth?: boolean

  /**
   * The colour underneath, so a partial weight has something to fade to.
   *
   * A colour tag paints; unlike a studio layer it has nothing to
   * composite against, which is why `opacity` was never expressible
   * natively. A mask makes the weight vary per character, so the question
   * stops being avoidable: carrying the base colour is what lets a
   * feathered edge and a partial opacity survive as one tag instead of
   * expanding to one `[color]` per letter.
   *
   * Absent, a partial weight falls back to a hard cut at half strength.
   */
  baseColor?: string

  /**
   * Position of this tag's text inside a longer effect, in visible
   * characters. Set when one logical effect is split across several tags
   * — a gradient down a multi-paragraph block — so each tag continues the
   * ramp instead of restarting it.
   */
  globalOffset?: number
  /** Total visible characters of that longer effect. */
  documentLength?: number
}

export type EffectUnit = 'character' | 'word' | 'line'

/**
 * The stepping units, as data.
 *
 * The type alone cannot be enumerated at runtime, so every UI that offered
 * these had to retype them — and a tool that wants to *validate* `unit=`
 * had nothing to validate against at all.
 */
export const EFFECT_UNITS: readonly EffectUnit[] = ['character', 'word', 'line']

/**
 * The axis a layer actually reads, given its stepping unit.
 *
 * Stepping per word while measuring per character is almost never what
 * someone means: a word-unit gradient over "one two three" would give
 * every word the colour of its first letter, so the ramp reached 60% of
 * the way to its end colour and stopped. `unit` therefore promotes the
 * default `index` axis to the matching coordinate. An axis the user
 * chose deliberately — radial, line, random — is left alone.
 */
export function effectiveAxis(axis: Axis, unit: EffectUnit | undefined): Axis {
  if (axis !== 'index') return axis
  if (unit === 'word') return 'word'
  if (unit === 'line') return 'line'
  return 'index'
}

/** Short attribute keys, so a tag stays readable in a document. */
/**
 * The attribute key each parameter is written as, and the only place that
 * mapping exists.
 *
 * Exported because it is the answer to "what can be spelled inside
 * `[gradient=…]`" — the same question `TagVocabulary` answers for the tags
 * whose attribute is a plain enum. A consumer that retyped `pc`, `oct` or
 * `mrat` would be a second transcription of a grammar that already has
 * exactly one, which is the drift this module was written to end.
 *
 * Note this says how a parameter is SPELLED, not which effect kinds read
 * it: `sat` is rainbow's and `min` is grow's, and a caller that offers
 * every key on every tag would be promising things the evaluator ignores.
 */
export const EFFECT_PARAM_KEYS = {
  axis: 'axis',
  wave: 'wave',
  cycles: 'cycles',
  phase: 'phase',
  easing: 'easing',
  bezier: 'bezier',
  parabolaCenter: 'pc',
  parabolaPower: 'pp',
  invert: 'invert',
  steps: 'steps',
  octaves: 'oct',
  expression: 'expr',
  seed: 'seed',
  unit: 'unit',
  opacity: 'opacity',
  perceptual: 'oklab',
  saturation: 'sat',
  lightness: 'light',
  spread: 'spread',
  offset: 'offset',
  preserveSL: 'keepsl',
  min: 'min',
  max: 'max',
  freq: 'freq',
  step: 'step',
  originX: 'ox',
  originY: 'oy',
  angle: 'ang',
  radius: 'rad',
  aspect: 'asp',
  maskShape: 'mask',
  maskX: 'mx',
  maskY: 'my',
  maskWidth: 'mw',
  maskHeight: 'mh',
  maskRotate: 'mrot',
  maskFeather: 'mfea',
  maskInvert: 'minv',
  maskPoints: 'mpts',
  maskInner: 'mrat',
  gridCols: 'cols',
  gridRows: 'rows',
  palette: 'pal',
  cells: 'map',
  smooth: 'smooth',
  baseColor: 'base',
  globalOffset: 'at',
  documentLength: 'of',
} as const

const KEY_TO_PARAM = new Map<string, keyof typeof EFFECT_PARAM_KEYS>(
  Object.entries(EFFECT_PARAM_KEYS).map(([param, key]) => [key, param as keyof typeof EFFECT_PARAM_KEYS]),
)

const NUMERIC_PARAMS = new Set([
  'cycles', 'phase', 'parabolaCenter', 'parabolaPower', 'steps', 'octaves',
  'seed', 'opacity', 'saturation', 'lightness', 'spread', 'offset', 'min', 'max',
  'freq', 'globalOffset', 'documentLength',
  'originX', 'originY', 'angle', 'radius', 'aspect',
  'maskX', 'maskY', 'maskWidth', 'maskHeight', 'maskRotate', 'maskFeather',
  'maskPoints', 'maskInner', 'gridCols', 'gridRows',
])
const BOOLEAN_PARAMS = new Set(['invert', 'preserveSL', 'perceptual', 'maskInvert', 'smooth'])

const stopCache = new Map<string, ColorStop[]>()
const STOP_CACHE_LIMIT = 256

/**
 * Parse a stop list, `"#hex 0%, #hex 50%, #hex"`.
 *
 * Unpositioned stops are spread evenly between their positioned
 * neighbours, matching CSS gradient semantics.
 *
 * Cached because a gradient layer asks for the same string once per
 * character; the result is treated as immutable by every caller.
 */
export function parseColorStops(colorsStr: string): ColorStop[] {
  const key = colorsStr ?? ''
  const cached = stopCache.get(key)
  if (cached) return cached

  const parts = key.split(',').map(s => s.trim()).filter(Boolean)
  const stops: ColorStop[] = []

  for (const part of parts) {
    const match = part.match(/^(\S+)(?:\s+(-?[\d.]+)%)?$/)
    if (match) {
      const pos = match[2] !== undefined ? parseFloat(match[2]) / 100 : -1
      stops.push({ color: match[1], position: Number.isFinite(pos) ? pos : -1 })
    } else {
      stops.push({ color: part, position: -1 })
    }
  }

  if (stops.length > 0) {
    if (stops[0].position === -1) stops[0].position = 0
    if (stops[stops.length - 1].position === -1) stops[stops.length - 1].position = 1

    let lastKnown = 0
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].position === -1) continue
      const span = stops[i].position - stops[lastKnown].position
      const steps = i - lastKnown
      for (let j = 1; j < steps; j++) {
        stops[lastKnown + j].position = stops[lastKnown].position + (span * j) / steps
      }
      lastKnown = i
    }
  }

  if (stopCache.size >= STOP_CACHE_LIMIT) stopCache.clear()
  stopCache.set(key, stops)
  return stops
}

/** Serialise stops to the canonical `"#hex 0.0%, …"` form. */
export function stringifyColorStops(stops: readonly ColorStop[]): string {
  return stops.map(s => `${s.color} ${(s.position * 100).toFixed(1)}%`).join(', ')
}

/** Parse an effect tag's attribute value into parameters. */
export function parseEffectParams(value: string): EffectParams {
  const params: EffectParams = {}
  if (!value) return params

  for (const rawSegment of value.split(';')) {
    const segment = rawSegment.trim()
    if (!segment) continue

    const eq = segment.indexOf('=')
    if (eq < 0) {
      // Positional: the colour list.
      const stops = parseColorStops(segment)
      const colors = stops.map(s => s.color).filter(c => c.startsWith('#'))
      if (colors.length > 0) {
        params.colors = colors
        params.stops = stops
      }
      continue
    }

    const key = segment.slice(0, eq).trim().toLowerCase()
    const raw = segment.slice(eq + 1).trim()
    const param = KEY_TO_PARAM.get(key)
    if (!param) continue

    if (NUMERIC_PARAMS.has(param)) {
      const n = Number(raw)
      if (Number.isFinite(n)) (params as Record<string, unknown>)[param] = n
    } else if (BOOLEAN_PARAMS.has(param)) {
      (params as Record<string, unknown>)[param] = raw === '1' || raw === 'true'
    } else if (param === 'bezier') {
      const nums = raw.split(/[,\s]+/).map(Number)
      if (nums.length === 4 && nums.every(Number.isFinite)) {
        params.bezier = nums as [number, number, number, number]
      }
    } else {
      (params as Record<string, unknown>)[param] = raw
    }
  }

  return params
}

/**
 * Serialise parameters back to an attribute value.
 *
 * Only what differs from `defaults` is written, so a plain gradient stays
 * `[gradient=#a,#b]` and only a configured one grows an attribute tail.
 */
export function stringifyEffectParams(
  params: EffectParams,
  defaults: Partial<EffectParams> = {},
): string {
  const segments: string[] = []

  if (params.stops && params.stops.length > 0) {
    segments.push(stringifyColorStops(params.stops))
  } else if (params.colors && params.colors.length > 0) {
    segments.push(params.colors.join(','))
  }

  for (const [param, key] of Object.entries(EFFECT_PARAM_KEYS) as [keyof typeof EFFECT_PARAM_KEYS, string][]) {
    const value = (params as Record<string, unknown>)[param]
    if (value === undefined || value === null || value === '') continue
    const fallback = (defaults as Record<string, unknown>)[param]
    if (fallback !== undefined && valuesEqual(value, fallback)) continue

    if (param === 'bezier' && Array.isArray(value)) {
      segments.push(`${key}=${value.join(',')}`)
    } else if (typeof value === 'boolean') {
      segments.push(`${key}=${value ? '1' : '0'}`)
    } else if (typeof value === 'number') {
      segments.push(`${key}=${round4(value)}`)
    } else {
      segments.push(`${key}=${String(value)}`)
    }
  }

  return segments.join(';')
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6
  return a === b
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// ═══════════════════════════════════════════════════════════════
// Effect evaluation over a plain string
// ═══════════════════════════════════════════════════════════════

/** A run of text with the style its effect computed. */
export interface StyledSegment {
  text: string
  color?: string
  size?: number
}

/** Which effect a set of parameters describes. */
export type EffectKind = 'gradient' | 'rainbow' | 'grow' | 'sinewave' | 'paint'

/** The size a character has with no size effect on it, in percent. */
export const NEUTRAL_SIZE = 100

/** Where a node sits in a larger logical effect that spans several nodes. */
export interface EffectSpan {
  globalOffset?: number
  documentLength?: number
}

const EFFECT_DEFAULTS = {
  axis: 'index' as Axis,
  wave: 'none' as WaveKind,
  cycles: 1,
  phase: 0,
  easing: 'linear',
  bezier: [0.25, 0.1, 0.25, 1.0] as [number, number, number, number],
  parabolaCenter: 0.5,
  parabolaPower: 2,
  invert: false,
  steps: 0,
  octaves: 4,
  seed: 1,
  unit: 'character' as EffectUnit,
  opacity: 1,
  perceptual: false,
  // Placement and mask belong to every effect kind, not to one of them: a
  // rainbow can be a star in the corner exactly as a gradient can. They
  // live in the shared defaults so `stringifyEffectParams` omits them
  // when untouched — otherwise every tag ever written would grow fifteen
  // attributes restating the defaults.
  originX: DEFAULT_SPATIAL.originX,
  originY: DEFAULT_SPATIAL.originY,
  angle: DEFAULT_SPATIAL.angle,
  radius: DEFAULT_SPATIAL.radius,
  aspect: DEFAULT_SPATIAL.aspect,
  maskShape: DEFAULT_MASK.shape,
  maskX: DEFAULT_MASK.x,
  maskY: DEFAULT_MASK.y,
  maskWidth: DEFAULT_MASK.width,
  maskHeight: DEFAULT_MASK.height,
  maskRotate: DEFAULT_MASK.rotate,
  maskFeather: DEFAULT_MASK.feather,
  maskInvert: DEFAULT_MASK.invert,
  maskPoints: DEFAULT_MASK.points,
  maskInner: DEFAULT_MASK.inner,
}

export const GRADIENT_DEFAULTS: Partial<EffectParams> = { ...EFFECT_DEFAULTS }
export const RAINBOW_DEFAULTS: Partial<EffectParams> = {
  ...EFFECT_DEFAULTS, saturation: 80, lightness: 60, spread: 300, offset: 0, preserveSL: false,
}
export const GROW_DEFAULTS: Partial<EffectParams> = {
  ...EFFECT_DEFAULTS, wave: 'sine', min: 50, max: 200,
}
export const PAINT_DEFAULTS: Partial<EffectParams> = {
  ...EFFECT_DEFAULTS, smooth: false,
}

/**
 * The placement and mask subset of the shared defaults.
 *
 * Every effect kind already carries these; this names them separately so
 * a UI can reset just the placement without touching the modulation.
 */
export const SPATIAL_DEFAULTS: Partial<EffectParams> = {
  originX: EFFECT_DEFAULTS.originX,
  originY: EFFECT_DEFAULTS.originY,
  angle: EFFECT_DEFAULTS.angle,
  radius: EFFECT_DEFAULTS.radius,
  aspect: EFFECT_DEFAULTS.aspect,
  maskShape: EFFECT_DEFAULTS.maskShape,
  maskX: EFFECT_DEFAULTS.maskX,
  maskY: EFFECT_DEFAULTS.maskY,
  maskWidth: EFFECT_DEFAULTS.maskWidth,
  maskHeight: EFFECT_DEFAULTS.maskHeight,
  maskRotate: EFFECT_DEFAULTS.maskRotate,
  maskFeather: EFFECT_DEFAULTS.maskFeather,
  maskInvert: EFFECT_DEFAULTS.maskInvert,
  maskPoints: EFFECT_DEFAULTS.maskPoints,
  maskInner: EFFECT_DEFAULTS.maskInner,
}

/** Read a tag's placement parameters, filling in the defaults. */
export function spatialFromParams(p: EffectParams): SpatialOptions {
  return {
    originX: p.originX ?? DEFAULT_SPATIAL.originX,
    originY: p.originY ?? DEFAULT_SPATIAL.originY,
    angle: p.angle ?? DEFAULT_SPATIAL.angle,
    radius: p.radius ?? DEFAULT_SPATIAL.radius,
    aspect: p.aspect ?? DEFAULT_SPATIAL.aspect,
  }
}

/** Read a tag's mask parameters, filling in the defaults. */
export function maskFromParams(p: EffectParams): MaskOptions {
  return {
    shape: p.maskShape ?? DEFAULT_MASK.shape,
    x: p.maskX ?? DEFAULT_MASK.x,
    y: p.maskY ?? DEFAULT_MASK.y,
    width: p.maskWidth ?? DEFAULT_MASK.width,
    height: p.maskHeight ?? DEFAULT_MASK.height,
    rotate: p.maskRotate ?? DEFAULT_MASK.rotate,
    feather: p.maskFeather ?? DEFAULT_MASK.feather,
    invert: p.maskInvert ?? DEFAULT_MASK.invert,
    points: p.maskPoints ?? DEFAULT_MASK.points,
    inner: p.maskInner ?? DEFAULT_MASK.inner,
    // A mask and a placeable axis measure the same page, so they must
    // agree about how wide a character is. One value, read twice.
    aspect: p.aspect ?? DEFAULT_MASK.aspect,
  }
}

/** Read a tag's paint grid, or `null` when it carries none. */
export function gridFromParams(p: EffectParams): PaintGrid | null {
  if (p.gridCols === undefined || p.gridRows === undefined) return null
  if (!p.palette || !p.cells) return null
  return parsePaintGrid(p.gridCols, p.gridRows, p.palette, p.cells)
}

/**
 * Evaluate an effect over a plain string, one styled run per unit.
 *
 * This is the single implementation the tag registry's BBCode export, the
 * HTML renderer's preview and the studio's own compiler all call, so a
 * document cannot render one way and export another.
 *
 * `span` carries the document-wide position when one logical effect is
 * split across several nodes — without it, a gradient interrupted by a
 * `[b]` would restart at its first colour on the other side.
 */
export function evaluateEffect(
  text: string,
  kind: EffectKind,
  params: EffectParams,
  span: EffectSpan = {},
): StyledSegment[] {
  if (!text) return []

  // `sinewave` predates the axis/waveform model and is not expressible in
  // it: its argument is the character index in radians (`sin(i * freq)`),
  // not a position normalised over the run, so its period is fixed in
  // characters rather than stretching with the text. Folding it into the
  // general path silently changed every document that used it.
  if (kind === 'sinewave') return mergeStyledSegments(sinewaveSegments(text, params))

  const defaults =
    kind === 'rainbow' ? RAINBOW_DEFAULTS :
    kind === 'grow' ? GROW_DEFAULTS :
    kind === 'paint' ? PAINT_DEFAULTS :
    GRADIENT_DEFAULTS
  const p = { ...defaults, ...params } as Required<Pick<EffectParams,
    'axis' | 'wave' | 'cycles' | 'phase' | 'easing' | 'bezier' | 'parabolaCenter' |
    'parabolaPower' | 'invert' | 'steps' | 'octaves' | 'seed' | 'unit' | 'perceptual'
  >> & EffectParams

  const table = buildSampleTable(text)
  const scope = documentScope(table)
  const stops = params.stops ?? (params.colors ? params.colors.map((color, i, arr) => ({
    color, position: arr.length > 1 ? i / (arr.length - 1) : 0,
  })) : [{ color: '#FF0000', position: 0 }, { color: '#00FF00', position: 1 }])

  const chars = Array.from(text)
  const easingArg: Easing = p.easing === 'custom'
    ? `bezier(${p.bezier.join(',')})`
    : p.easing

  // Placement, mask and grid are resolved once. They do not vary per
  // character, and reading fifteen `??` fallbacks inside the loop cost
  // more than every shape SDF put together.
  const geo = spatialFromParams(p)
  const maskOpts = maskFromParams(p)
  const masked = maskOpts.shape !== 'none'
  const grid = kind === 'paint' ? gridFromParams(p) : null

  // A document-wide span replaces the local index so several nodes read
  // as one continuous effect.
  // The span may arrive as node metadata (set by a tree transform) or in
  // the tag's own attribute (written by Text Studio when it splits one
  // effect across paragraphs). Either way it means the same thing.
  const spanLengthRaw = span.documentLength ?? params.documentLength
  const spanned = spanLengthRaw !== undefined && spanLengthRaw > 1
  const spanOffset = span.globalOffset ?? params.globalOffset ?? 0
  const spanLength = spanLengthRaw ?? scope.count

  const out: StyledSegment[] = []
  let groupKey: number | null = null
  let pending: { text: string; value: number; weight: number; color?: string } | null = null

  const flush = () => {
    if (!pending) return
    out.push(styleFor(kind, pending.text, pending.value, p, stops, pending.weight, pending.color))
    pending = null
  }

  for (let i = 0; i < chars.length; i++) {
    const sample = table.samples[i]

    if (sample.isSpace) {
      flush()
      groupKey = null
      out.push({ text: chars[i] })
      continue
    }

    const key = p.unit === 'word' ? sample.word : p.unit === 'line' ? sample.line : sample.index
    if (pending && key === groupKey) {
      pending.text += chars[i]
      continue
    }
    flush()
    groupKey = key

    const ctx: SampleContext = { sample, scope, table, local: sample.index }

    // A mask that excludes the character settles the question before any
    // of the modulation runs: there is no colour to compute.
    const weight = masked ? maskValue(ctx, maskOpts) : 1
    if (weight <= 0) {
      flush()
      groupKey = null
      out.push({ text: chars[i] })
      continue
    }

    if (kind === 'paint') {
      const pt = spatialPoint(ctx, geo.aspect)
      const hex = grid
        ? samplePaintGrid(grid, pt.x, pt.y, p.smooth === true, p.perceptual)
        : undefined
      if (hex === undefined) {
        out.push({ text: chars[i] })
        groupKey = null
        continue
      }
      pending = { text: chars[i], value: 0, weight, color: hex }
      continue
    }

    let u = spanned
      ? clamp01((spanOffset + sample.index) / (spanLength - 1))
      : axisValue(effectiveAxis(p.axis, p.unit), ctx, p.seed | 0, geo)
    if (p.invert) u = 1 - u

    let v = waveform(p.wave, u, {
      cycles: p.cycles,
      phase: p.phase,
      bezier: p.bezier,
      expression: p.expression,
      octaves: p.octaves,
      steps: 0,
      seed: p.seed | 0,
      index: sample.index,
      count: scope.count,
      vars: p.wave === 'expr' ? expressionVars(ctx, u, p.seed | 0) : undefined,
    })
    v = ease(v, easingArg, p.parabolaCenter, p.parabolaPower)
    if (p.steps >= 2) {
      const levels = Math.round(p.steps)
      v = Math.round(clamp01(v) * (levels - 1)) / (levels - 1)
    }

    pending = { text: chars[i], value: clamp01(v), weight }
  }
  flush()

  return mergeStyledSegments(out)
}

/**
 * Collapse neighbouring runs that resolved to the same style.
 *
 * Every consumer wins: the export writes `[color=#f00]ab[/color]` instead
 * of two tags, and the preview builds one span instead of two. It matters
 * most exactly where the output is largest — a quantised gradient, a
 * word- or line-stepped effect, a long flat tail — which is where the
 * 60 000-character budget actually gets spent.
 *
 * A whitespace run between two identical styles is absorbed rather than
 * splitting them; between different ones it stays unstyled, so a space
 * never picks up a colour it would have to pay a tag for.
 */
export function mergeStyledSegments(segments: StyledSegment[]): StyledSegment[] {
  if (segments.length <= 1) return segments

  const out: StyledSegment[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const prev = out[out.length - 1]

    if (prev && sameStyle(prev, seg)) {
      prev.text += seg.text
      continue
    }

    // Look through a plain gap to the next styled run.
    if (prev && isPlain(seg)) {
      let j = i + 1
      let gap = seg.text
      while (j < segments.length && isPlain(segments[j])) { gap += segments[j].text; j++ }
      if (j < segments.length && sameStyle(prev, segments[j])) {
        prev.text += gap + segments[j].text
        i = j
        continue
      }
    }

    out.push({ ...seg })
  }
  return out
}

function isPlain(seg: StyledSegment): boolean {
  return seg.color === undefined && seg.size === undefined
}

function sameStyle(a: StyledSegment, b: StyledSegment): boolean {
  return a.color === b.color && a.size === b.size
}

/** The legacy sine oscillator, preserved exactly. */
function sinewaveSegments(text: string, params: EffectParams): StyledSegment[] {
  const min = params.min ?? 20
  const max = params.max ?? 80
  const freq = params.freq ?? 0.4
  const step = params.step ?? 'char'
  const amplitude = (max - min) / 2
  const center = min + amplitude

  if (step === 'word') {
    let wordIndex = 0
    return text.split(/(\s+)/).filter(c => c.length > 0).map(chunk => {
      if (chunk.trim() === '') return { text: chunk }
      const size = Math.round(center + Math.sin(wordIndex * freq) * amplitude)
      wordIndex++
      return { text: chunk, size }
    })
  }

  return Array.from(text).map((ch, i) => ({
    text: ch,
    size: Math.round(center + Math.sin(i * freq) * amplitude),
  }))
}

function styleFor(
  kind: EffectKind,
  text: string,
  v: number,
  p: EffectParams & { perceptual: boolean },
  stops: ColorStop[],
  weight = 1,
  directColor?: string,
): StyledSegment {
  if (kind === 'grow' || kind === 'sinewave') {
    const min = p.min ?? 50
    const max = p.max ?? 200
    const size = min + (max - min) * v
    // `opacity` on a size effect is a STRENGTH: how far the computed size
    // travels from the neutral 100%. It is the same lerp-toward-what-is-
    // underneath that opacity performs on a colour, which is why it shares
    // the field — but a font size has no alpha, so the UI labels it
    // "strength" rather than pretending otherwise.
    //
    // A mask multiplies into it, which is exactly right for a size: the
    // neutral 100% IS what is underneath, so a half-covered character is
    // half-grown with nothing extra to know.
    const strength = (p.opacity ?? 1) * weight
    return { text, size: Math.round(NEUTRAL_SIZE + (size - NEUTRAL_SIZE) * strength) }
  }

  if (kind === 'paint') {
    return directColor === undefined
      ? { text }
      : applyWeight(text, directColor, weight * (p.opacity ?? 1), p.baseColor)
  }

  if (kind === 'rainbow') {
    const spread = p.spread ?? 300
    const offset = p.offset ?? 0
    let hue: number
    if (p.colors && p.colors.length > 0) {
      let mapped = (offset / 360 + v * (spread / 360)) % 1
      if (mapped < 0) mapped += 1
      hue = hexToHsl(mixMultipleStops(stops, mapped, p.perceptual))[0]
    } else {
      hue = offset + v * spread
    }
    return applyWeight(
      text,
      hslToHex(((hue % 360) + 360) % 360, p.saturation ?? 80, p.lightness ?? 60),
      weight * (p.opacity ?? 1),
      p.baseColor,
    )
  }

  return applyWeight(text, mixMultipleStops(stops, v, p.perceptual), weight * (p.opacity ?? 1), p.baseColor)
}

/**
 * Composite one computed colour at a partial weight.
 *
 * With a known base the answer is a plain mix, and a feathered edge comes
 * out smooth. Without one there is nothing to fade toward, so the weight
 * becomes a threshold: past halfway the character takes the colour,
 * before it the character keeps whatever it inherits. That is a visible
 * step rather than a gradient, and it is the honest limit of a bare tag —
 * the studio, which always knows the colour underneath, never reaches it.
 */
function applyWeight(
  text: string,
  hex: string,
  weight: number,
  baseColor?: string,
): StyledSegment {
  if (weight >= 1) return { text, color: normalizeHex(hex) }
  if (weight <= 0) return { text }
  if (baseColor) return { text, color: normalizeHex(mixHex(baseColor, hex, weight)) }
  return weight >= 0.5 ? { text, color: normalizeHex(hex) } : { text }
}

/**
 * Upper-case an emitted hex colour.
 *
 * @remarks Exported so the studio's own compiler can apply the same rule;
 * the two must agree byte for byte or the same document exports
 * differently depending on which path produced it.
 *
 * Interpolated colours come back lower-case while a stop copied straight
 * from the attribute keeps whatever the author typed, so a single
 * gradient used to export `#FF0000` next to `#bf4000`. Normalising here
 * — the one place every effect colour passes through — keeps the output
 * uniform without touching the colour maths.
 */
export function normalizeHex(hex: string): string {
  return /^#[0-9a-fA-F]+$/.test(hex) ? hex.toUpperCase() : hex
}

// ── Wiring ─────────────────────────────────────────────────────

// `ease` needs the validating compiler for `expr(...)` easings but cannot
// import it (EffectMath already imports ColorMath). Injecting it here,
// once, at load, keeps the dependency one-way.
__setExpressionCompiler(src => {
  const fn = compileExpression(src)
  return fn ? (vars: Record<string, number>) => fn(vars as unknown as ExpressionVars) : null
})
