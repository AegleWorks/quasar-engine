/**
 * Range for `[size=N]`, per dialect.
 *
 * osu! renders `[size]` up to 200 and no further, so a `[size=300]` that the
 * editor painted at 300% was a lie about the published page. Miliastry follows
 * osu! here on purpose. Lyne keeps its wider range.
 *
 * The FLOOR is osu!'s too: `BBCodeFromDB::parseSize` writes
 * `Number::clamp((int) $size, 30, 200)`, so `[size=20]` publishes at 30 %. And
 * because osu! clamps the DIGITS, a `[size=100000]` is a 200 % span rather
 * than no span at all — which is what the CSS sanitizer used to make of it.
 *
 * This is an ENGINE switch, not a user setting: nothing in the app exposes it.
 * Flip `enabled` (or edit `max` / `dialects`) here to change the behaviour for
 * every edge that honours it — the HTML renderer and the BBCode exporter.
 *
 * Like the osu! colour grammar, the rule lives at those edges and never inside
 * `sanitizeFontSize`: that sanitizer is a CSS-injection boundary shared by every
 * dialect and by the effect kernel, and must stay dialect-agnostic.
 */

import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'

export const FONT_SIZE_LIMIT: {
  enabled: boolean
  min: number
  max: number
  dialects: readonly BBCodeDialect[]
} = {
  enabled: true,
  min: 30,
  max: 200,
  dialects: ['osu', 'miliastry'],
}

/** The largest `[size]` a dialect renders, or `null` when it has no ceiling. */
export function maxFontSizeFor(dialect: BBCodeDialect | null | undefined): number | null {
  if (!FONT_SIZE_LIMIT.enabled || !dialect) return null
  return FONT_SIZE_LIMIT.dialects.includes(dialect) ? FONT_SIZE_LIMIT.max : null
}

/** El menor `[size]` que un dialecto pinta, o `null` cuando no tiene suelo. */
export function minFontSizeFor(dialect: BBCodeDialect | null | undefined): number | null {
  if (!FONT_SIZE_LIMIT.enabled || !dialect) return null
  return FONT_SIZE_LIMIT.dialects.includes(dialect) ? FONT_SIZE_LIMIT.min : null
}

/**
 * A size value clamped to the dialect's range. Anything that is not a plain
 * number (an unresolved `$token`, garbage) is returned untouched: deciding what
 * to do with it belongs to the caller's sanitizer, not to the range.
 *
 * Clamping the DIGITS is what makes this a repair rather than a loss: osu!'s
 * own `Number::clamp` sees `100000` and prints 200 %, so a sanitizer that
 * refused the number outright would hide a size osu! shows.
 */
export function clampFontSizeValue(value: string, dialect: BBCodeDialect | null | undefined): string {
  const max = maxFontSizeFor(dialect)
  if (max === null) return value
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return value
  return Number(trimmed) > max ? String(max) : value
}

/**
 * A size value clamped to the range a dialect PAINTS — the ceiling above plus
 * osu!'s floor.
 *
 * The floor is the renderer's alone, on purpose: osu! prints `[size=15]` at 30 %
 * and the preview must say the same, but the document is the author's, and an
 * export that quietly rewrote every `[size=15]` to `[size=30]` would be editing
 * their text to match a paint. (The ceiling needs no such care: it only lowers
 * a value that stays lowered, so the export is still its own fixpoint.)
 */
export function clampFontSizeForRender(value: string, dialect: BBCodeDialect | null | undefined): string {
  const capped = clampFontSizeValue(value, dialect)
  const min = minFontSizeFor(dialect)
  if (min === null) return capped
  const trimmed = capped.trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return capped
  return Number(trimmed) < min ? String(min) : capped
}
