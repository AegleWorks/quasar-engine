/**
 * The cheap gate in front of the osu! flatten re-parse.
 *
 * `BBCodeExporter` runs `FlattenOsuNestingRule` over every osu! export, but the
 * rule needs a full re-parse of the exported text and most pages have nothing
 * for it to do. This gate answers "can this export contain a flattenable tag
 * nested inside one of the same name?" so those pages skip the re-parse.
 *
 * It is a hand-written scanner over exactly the grammar of
 *
 *   /\[(\/?)(b|i|u|s|strike|spoiler|heading|centre|left|right|color|size)(?:=[^\]]*)?\]/g
 *
 * with the same global-scan semantics (a match resumes after its `]`, so a `[`
 * inside a `=value` is never a tag; a failed attempt resumes at the next `[`).
 * The regex version allocated a match array and capture strings per tag and was
 * a third of the whole osu! export on the 547 KB fixture (~13 ms of ~25 ms);
 * `sameNameNestingGate.test.ts` keeps it as the oracle.
 *
 * A false positive only costs the re-parse. A false negative is impossible:
 * every nested pair the rule could act on shows up here as a second opener
 * while the first is still open.
 */

const CLOSE_BRACKET = 93 // ]
const SLASH = 47 // /
const EQUALS = 61 // =
const LOWER_A = 97
const LOWER_Z = 122

/** Slots of the flattenable tags; `s` and `strike` share one, as in the rule. */
const SLOT_COUNT = 11

/**
 * Slot of the tag name `source[start, start + length)`, or -1.
 *
 * Compares in place instead of slicing, so the scan allocates nothing per tag.
 */
function flattenableSlot(source: string, start: number, length: number): number {
  switch (length) {
    case 1: {
      const c = source.charCodeAt(start)
      if (c === 98) return 0 // b
      if (c === 105) return 1 // i
      if (c === 117) return 2 // u
      if (c === 115) return 3 // s
      return -1
    }
    case 4:
      if (source.startsWith('left', start)) return 7
      if (source.startsWith('size', start)) return 10
      return -1
    case 5:
      if (source.startsWith('right', start)) return 8
      if (source.startsWith('color', start)) return 9
      return -1
    case 6:
      if (source.startsWith('strike', start)) return 3
      if (source.startsWith('centre', start)) return 6
      return -1
    case 7:
      if (source.startsWith('spoiler', start)) return 4
      if (source.startsWith('heading', start)) return 5
      return -1
    default:
      return -1
  }
}

export function mayHaveSameNameNesting(source: string): boolean {
  const open = new Uint8Array(SLOT_COUNT)
  const length = source.length
  let at = source.indexOf('[')

  while (at !== -1) {
    let cursor = at + 1
    const closing = source.charCodeAt(cursor) === SLASH
    if (closing) cursor++

    // The name is the whole run of lowercase letters: the regex needs `=` or
    // `]` right after the name, so a longer run can never match a shorter name.
    const nameStart = cursor
    while (cursor < length) {
      const c = source.charCodeAt(cursor)
      if (c < LOWER_A || c > LOWER_Z) break
      cursor++
    }

    const slot = flattenableSlot(source, nameStart, cursor - nameStart)
    let end = -1
    if (slot !== -1) {
      const next = source.charCodeAt(cursor)
      if (next === CLOSE_BRACKET) end = cursor
      else if (next === EQUALS) end = source.indexOf(']', cursor + 1)
    }

    if (end === -1) {
      at = source.indexOf('[', at + 1)
      continue
    }

    if (closing) {
      open[slot] = 0
    } else {
      if (open[slot] === 1) return true
      open[slot] = 1
    }
    at = source.indexOf('[', end + 1)
  }

  return false
}
