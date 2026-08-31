/**
 * Quasar — Enumerated attribute vocabularies
 *
 * Some tags take an attribute that is not free text: `[effect=glow]`,
 * `[anim=glitch]`, `[container=grid]`, `[separator=dots]`. The set of values
 * each one accepts was, until now, knowable only by reading the `switch` in
 * `HTMLRenderer` — so the editor could offer tag names but never values, and
 * an author had to remember thirty-six magic words.
 *
 * ── Why this is a problem worth a module ──
 *
 * Every one of those switches ends in a `default:`, and none of the defaults
 * is an error. A misspelling does not fail; it renders something else:
 *
 *   [anim=glich]      → `bb-pulse`   (a different animation)
 *   [container=gird]  → `bb-stack`   (a different container)
 *   [effect=nen]      → a bare span  (no effect at all)
 *   [img=round,shadow]→ ignored      (`parseImgAttr` is exclusive, not flags)
 *
 * The author sees a preview that works and never learns the value was wrong.
 * Offering the vocabulary at the point of typing is the cheapest fix, and it
 * needs the vocabulary to exist as data rather than as control flow.
 *
 * ── Why here and not in the editor ──
 *
 * This is the engine's knowledge: the renderer decides what `glow` means, so
 * the renderer's package owns the list of what is spellable. A copy in the
 * editor would be a fourth transcription of an engine fact, which is the
 * exact mistake `TagSyntax` and `EffectMath` were both written to undo.
 *
 * `TagVocabulary.test.ts` pins every value below to the renderer: a value
 * that stops being handled starts rendering as the fallback, and the test
 * fails. The list cannot silently drift away from the behaviour.
 *
 * Human-readable descriptions are deliberately NOT here. Quasar has no
 * locales; the editor names these values through its own i18n.
 */

/** How an attribute's value is written. */
export type VocabularySyntax =
  /** Exactly one of `values`. */
  | 'enum'
  /** Any subset of `values`, comma- or space-separated. */
  | 'flags'

export interface AttributeVocabulary {
  /** The tag whose attribute this describes. */
  tag: string
  /** Every value the engine actually handles, in the renderer's own order. */
  values: readonly string[]
  syntax: VocabularySyntax
  /**
   * The value an unrecognised attribute behaves as, or `null` when an
   * unrecognised attribute simply does nothing.
   *
   * This is the honest part: it is what the `default:` branch does, not what
   * the documentation wishes it did.
   */
  fallback: string | null
  /**
   * Whether a `:<param>` suffix is read after the value.
   *
   * What the suffix MEANS is per value, not per tag, which is why this is
   * only a boolean: `[effect=glow:#2EE6E2]` and `[tables=striped:#hex]` take
   * a colour, but `[container=grid:3]` takes a column count and
   * `[container=flex:12]` a gap in pixels. Completion needs no more than
   * "there is a suffix here, and it is not part of the vocabulary".
   */
  suffixed: boolean
}

/** `[effect=…]` — `HTMLRenderer.renderEffect`. */
export const EFFECT_TYPES = [
  'glow', 'neon', 'outline', 'emboss', 'engrave',
  'shimmer', 'ghost', 'rainbow', 'fire', 'ice',
] as const

/** `[anim=…]` — `HTMLRenderer.renderAnim`. */
export const ANIM_TYPES = [
  'bounce', 'shake', 'pulse', 'fade-in', 'fade-out',
  'typewriter', 'wave', 'sparkle', 'glitch', 'levitate',
] as const

/**
 * `[container=…]` — `HTMLRenderer.renderContainer`.
 *
 * `neonbox` is the unhyphenated spelling of `neon-box` and renders
 * identically; it stays in the list because a document may carry it, but the
 * hyphenated form is the canonical one and comes first.
 */
export const CONTAINER_TYPES = [
  'stack', 'flex', 'grid', 'middle', 'square', 'circle',
  'card', 'glass', 'neon-box', 'neonbox',
] as const

/** `[separator=…]` — `HTMLRenderer.renderSeparator`. */
export const SEPARATOR_VARIANTS = ['line', 'dots', 'stars'] as const

/** `[tables=…]` — `HTMLRenderer.renderTables`. Combinable. */
export const TABLE_FLAGS = ['striped', 'borders'] as const

/**
 * `[img=…]` — `parseImgAttr` in `Syntax/nodeAttr`.
 *
 * Exclusive despite reading like flags: the parser returns on the first
 * match, so `[img=round,shadow]` yields neither. A dimension pair
 * (`[img=200x100]`) is the other accepted form and is not enumerable.
 */
export const IMG_MODIFIERS = ['round', 'shadow', 'float'] as const

const VOCABULARIES: readonly AttributeVocabulary[] = [
  // `effect` is suffixed, but only `glow`, `neon` and `outline` read the
  // colour; the other seven ignore it. `container` is suffixed with a colour
  // for the panels and with a number for `flex` and `grid`.
  { tag: 'effect',    values: EFFECT_TYPES,       syntax: 'enum',  fallback: null,    suffixed: true  },
  { tag: 'anim',      values: ANIM_TYPES,         syntax: 'enum',  fallback: 'pulse', suffixed: false },
  { tag: 'container', values: CONTAINER_TYPES,    syntax: 'enum',  fallback: 'stack', suffixed: true  },
  { tag: 'separator', values: SEPARATOR_VARIANTS, syntax: 'enum',  fallback: 'line',  suffixed: false },
  { tag: 'tables',    values: TABLE_FLAGS,        syntax: 'flags', fallback: null,    suffixed: true  },
  { tag: 'img',       values: IMG_MODIFIERS,      syntax: 'enum',  fallback: null,    suffixed: false },
]

const BY_TAG = new Map(VOCABULARIES.map(v => [v.tag, v]))

/**
 * The vocabulary for a tag's attribute, or `null` when its attribute is free
 * text (`[box=Título]`, `[url=…]`, `[size=200]`).
 *
 * Case-insensitive, because the renderer lowercases before matching.
 *
 * Note this answers only "what can be spelled here"; whether the tag exists
 * at all is a dialect question, and the caller already knows the dialect.
 */
export function attributeVocabularyFor(tag: string): AttributeVocabulary | null {
  return BY_TAG.get(tag.toLowerCase()) ?? null
}

/** Every vocabulary, for tests and for tooling that enumerates them. */
export function allAttributeVocabularies(): readonly AttributeVocabulary[] {
  return VOCABULARIES
}
