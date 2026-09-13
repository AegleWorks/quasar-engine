/**
 * Ceiling for `[size=N]`, per dialect.
 *
 * osu! renders `[size]` up to 200 and no further, so a `[size=300]` that the
 * editor painted at 300% was a lie about the published page. Miliastry follows
 * osu! here on purpose. Lyne keeps its wider range.
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
  max: number
  dialects: readonly BBCodeDialect[]
} = {
  enabled: true,
  max: 200,
  dialects: ['osu', 'miliastry'],
}

/** The largest `[size]` a dialect renders, or `null` when it has no ceiling. */
export function maxFontSizeFor(dialect: BBCodeDialect | null | undefined): number | null {
  if (!FONT_SIZE_LIMIT.enabled || !dialect) return null
  return FONT_SIZE_LIMIT.dialects.includes(dialect) ? FONT_SIZE_LIMIT.max : null
}

/**
 * A size value capped to the dialect's ceiling. Anything that is not a plain
 * number (an unresolved `$token`, garbage) is returned untouched: deciding what
 * to do with it belongs to the caller's sanitizer, not to the ceiling.
 */
export function clampFontSizeValue(value: string, dialect: BBCodeDialect | null | undefined): string {
  const max = maxFontSizeFor(dialect)
  if (max === null) return value
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return value
  return Number(trimmed) > max ? String(max) : value
}
