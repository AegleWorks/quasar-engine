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
  wordCount: number
}

const EMPTY_TABLE: SampleTable = {
  samples: [],
  count: 0,
  lineCount: 0,
  lineLengths: [],
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

  let index = 0
  let line = 0
  let col = 0
  let word = -1
  let inWord = false

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]

    if (ch === '\n') {
      lineLengths.push(col)
      samples[i] = { offset: i, isSpace: true, index: -1, line, col: -1, word: -1 }
      line++
      col = 0
      inWord = false
      continue
    }

    const isSpace = ch.trim().length === 0
    if (isSpace) {
      samples[i] = { offset: i, isSpace: true, index: -1, line, col: -1, word: -1 }
      inWord = false
      continue
    }

    if (!inWord) {
      word++
      inWord = true
    }

    samples[i] = { offset: i, isSpace: false, index, line, col, word }
    index++
    col++
  }

  lineLengths.push(col)

  return {
    samples,
    count: index,
    lineCount: lineLengths.length,
    lineLengths,
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
  const lineLengths: number[] = []

  if (len === 0) {
    return {
      start: s, end: e, count: 0,
      localIndex, localLine, localCol, localWord,
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

  for (let i = 0; i < len; i++) {
    const sample = table.samples[s + i]
    const line = sample.line - baseLine
    localLine[i] = line

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
  }

  return {
    start: s,
    end: e,
    count: index,
    localIndex,
    localLine,
    localCol,
    localWord,
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

export const AXES: readonly Axis[] = [
  'index', 'word', 'line', 'column', 'diagonal', 'radial', 'angular', 'random', 'wave',
]

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

/**
 * Project a character onto the [0,1] axis a layer reads.
 *
 * `radial` and `angular` treat the range as a rectangle of lines by
 * columns, which is what makes a multi-line block behave like a canvas
 * rather than a single ribbon of text.
 */
export function axisValue(axis: Axis, ctx: SampleContext, seed = 0): number {
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
    default:
      return norm(ctx.local, scope.count)
  }
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
const PARAM_KEYS = {
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
  globalOffset: 'at',
  documentLength: 'of',
} as const

const KEY_TO_PARAM = new Map<string, keyof typeof PARAM_KEYS>(
  Object.entries(PARAM_KEYS).map(([param, key]) => [key, param as keyof typeof PARAM_KEYS]),
)

const NUMERIC_PARAMS = new Set([
  'cycles', 'phase', 'parabolaCenter', 'parabolaPower', 'steps', 'octaves',
  'seed', 'opacity', 'saturation', 'lightness', 'spread', 'offset', 'min', 'max',
  'freq', 'globalOffset', 'documentLength',
])
const BOOLEAN_PARAMS = new Set(['invert', 'preserveSL', 'perceptual'])

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

  for (const [param, key] of Object.entries(PARAM_KEYS) as [keyof typeof PARAM_KEYS, string][]) {
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
export type EffectKind = 'gradient' | 'rainbow' | 'grow' | 'sinewave'

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
}

export const GRADIENT_DEFAULTS: Partial<EffectParams> = { ...EFFECT_DEFAULTS }
export const RAINBOW_DEFAULTS: Partial<EffectParams> = {
  ...EFFECT_DEFAULTS, saturation: 80, lightness: 60, spread: 300, offset: 0, preserveSL: false,
}
export const GROW_DEFAULTS: Partial<EffectParams> = {
  ...EFFECT_DEFAULTS, wave: 'sine', min: 50, max: 200,
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
  let pending: { text: string; value: number } | null = null

  const flush = () => {
    if (!pending) return
    out.push(styleFor(kind, pending.text, pending.value, p, stops))
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
    let u = spanned
      ? clamp01((spanOffset + sample.index) / (spanLength - 1))
      : axisValue(effectiveAxis(p.axis, p.unit), ctx, p.seed | 0)
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

    pending = { text: chars[i], value: clamp01(v) }
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
    const strength = p.opacity ?? 1
    return { text, size: Math.round(NEUTRAL_SIZE + (size - NEUTRAL_SIZE) * strength) }
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
    return {
      text,
      color: normalizeHex(hslToHex(((hue % 360) + 360) % 360, p.saturation ?? 80, p.lightness ?? 60)),
    }
  }

  return { text, color: normalizeHex(mixMultipleStops(stops, v, p.perceptual)) }
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
