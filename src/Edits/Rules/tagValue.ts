/**
 * Quasar — Tag attribute reading & normalisation for optimization rules
 *
 * Rules compare tags by what they *mean*, not by how they are spelled:
 * `[Color = "#FF0000"]`, `[color=#ff0000]` and `[color=#F00]` all name the
 * same colour and must be treated as one. Normalising here is what lets the
 * merge rule fuse them while still leaving the author's own bytes in place.
 *
 * `Analysis/Utils/color-utils.extractHex` is deliberately stricter — it
 * accepts only six-digit hex, because a *recolouring* pass must not rewrite a
 * spelling the author chose. These rules have the opposite need: they only
 * ever delete or shorten, so recognising more spellings is pure upside.
 */

import type { GreenNode } from '../../Syntax/GreenNode'

const QUOTES = new Set(['"', "'"])

/**
 * The attribute value a tag node carries, unquoted and trimmed.
 *
 * A node's `text` holds the raw attribute segment of its opening delimiter —
 * `=#FF0000`, `= "#FF0000"`, or `''` for a bare tag.
 */
export function attributeValue(node: GreenNode): string {
  const text = node.text || ''
  const eq = text.indexOf('=')
  let value = (eq >= 0 ? text.slice(eq + 1) : text).trim()

  if (value.length >= 2 && QUOTES.has(value[0]) && value[value.length - 1] === value[0]) {
    value = value.slice(1, -1).trim()
  }
  return value
}

const HEX6 = /^#[0-9a-fA-F]{6}$/
const HEX3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/

/**
 * Canonical form of a colour value, for equality only.
 *
 * Never written back to the document — `#F00` and `#FF0000` normalise to the
 * same string so the two tags can merge, but whichever one the author wrote is
 * the one that survives.
 */
export function normalizeColorValue(raw: string): string {
  const short = HEX3.exec(raw)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase()
  if (HEX6.test(raw)) return raw.toUpperCase()
  // Keywords (`red`, `Transparent`) are case-insensitive in CSS.
  return raw.toLowerCase()
}

/** Six-digit hex whose channels are all doubled digits, e.g. `#FFAA00`. */
export function shortenableHex(raw: string): string | null {
  if (!HEX6.test(raw)) return null
  const r = raw.slice(1)
  if (r[0].toLowerCase() !== r[1].toLowerCase()) return null
  if (r[2].toLowerCase() !== r[3].toLowerCase()) return null
  if (r[4].toLowerCase() !== r[5].toLowerCase()) return null
  // Keep the author's own digit casing; only the redundant half is dropped.
  return `#${r[0]}${r[2]}${r[4]}`
}

/**
 * The identity two sibling tags must share to be mergeable.
 *
 * Returns `null` for kinds this optimizer does not fuse.
 */
export function mergeIdentity(node: GreenNode): string | null {
  if (node.kind === 'color') return `color|${normalizeColorValue(attributeValue(node))}`
  if (MERGEABLE_INLINE.has(node.kind)) return `${node.kind}|${attributeValue(node).toLowerCase()}`
  return null
}

/**
 * Inline formatting tags that fuse when adjacent and identically attributed.
 *
 * Block kinds are absent on purpose. Merging `[box]a[/box][box]b[/box]` into
 * one box is not a rewrite of the same document — it renders one frame where
 * the author drew two.
 */
export const MERGEABLE_INLINE: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'font_size',
  'font',
  'sup',
  'sub',
  'mark',
])

/**
 * Kinds that may absorb the whitespace sitting between two merged siblings.
 *
 * `[color=X]a[/color] [color=X]b[/color]` → `[color=X]a b[/color]` is safe: a
 * coloured space and an uncoloured space are the same pixels. The same move on
 * `[u]` is **not** — the underline would extend across the gap, which is a
 * visible change to a document the user only asked to make smaller. Size and
 * font are excluded for the same reason: a space in another size or face can
 * change advance width and line height.
 */
export const BRIDGES_WHITESPACE: ReadonlySet<string> = new Set(['color', 'bold', 'italic'])
