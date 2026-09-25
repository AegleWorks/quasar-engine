/**
 * Anchors, layer 1: ranges of a text that follow it through every edit.
 *
 * An anchor says "this part of the document" in TEXT coordinates, so it means
 * the same thing to every tree built from that text (the default parse, the
 * osu! preview tree, a fresh parse after a reload) — unlike a node id, which
 * belongs to one parse. The same design as Monaco's decorations and
 * ProseMirror's `Mapping`. See docs/11-Anchors-Plan.md.
 */

/** One edit: `text` replaces the OLD text's `[start, end)`. */
export interface TextEdit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * What an insertion exactly at an anchor's edge does, as Monaco's
 * `TrackedRangeStickiness`: join the anchor (grow) or stay outside it.
 */
export type Stickiness =
  | 'always-grows'
  | 'never-grows'
  | 'grows-before'
  | 'grows-after'

export interface Anchor {
  /** Portable: random, not the per-process node-id counter, so it can be stored. */
  readonly id: string
  readonly start: number
  readonly end: number
  readonly stickiness: Stickiness
  /**
   * The anchored text was deleted by an edit: the anchor is collapsed at the
   * place the text used to be. Kept, not dropped, so its owner can decide (a
   * comment shows as orphaned, an open-box state is discarded).
   */
  readonly deleted: boolean
}

/**
 * Where `offset` lands after `edit`. `assoc` decides the ambiguous cases: an
 * offset exactly where text is inserted, or inside replaced text, goes before
 * the new text (-1) or after it (+1). The edges of a replaced range are not
 * ambiguous: its start stays at the start, its end moves past the new text.
 * The same rule as ProseMirror's `StepMap.map`.
 */
export function mapOffset(offset: number, edit: TextEdit, assoc: -1 | 1): number {
  const { start, end } = edit
  const inserted = edit.text.length
  if (offset < start) return offset
  if (offset > end) return offset - (end - start) + inserted
  const side = start === end ? assoc : offset === start ? -1 : offset === end ? 1 : assoc
  return side < 0 ? start : start + inserted
}

/**
 * The one edit that turns `before` into `after`: the longest common prefix
 * and suffix, and what is between — the same scan `DocumentModel` uses for
 * `applyTextUpdate` — with a pure insertion or deletion then slid as far LEFT
 * as it can go. `null` when the texts are equal.
 *
 * The slide matters for anchors. The prefix scan is greedy, so deleting
 * `[box=Uno]a[/box]\n` right before `[box=Dos]` comes out as deleting
 * `Uno]a[/box]\n[box=`: the same text, shifted by the shared `[box=`. Mapped
 * through that, the anchor on `[box=Uno]` survives as `[box=` of the NEXT
 * box, and deleting one box opened its neighbour. A deletion of `d` can slide
 * left while the character before it equals its own last one (and an
 * insertion likewise), and the leftmost position is where the edit really
 * begins in the cases that matter: whole tags and lines.
 */
export function diffText(before: string, after: string): TextEdit | null {
  if (before === after) return null
  const shared = Math.min(before.length, after.length)
  let start = 0
  while (start < shared && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let oldEnd = before.length
  let newEnd = after.length
  while (oldEnd > start && newEnd > start && before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) {
    oldEnd--
    newEnd--
  }
  if (newEnd === start) {
    // Pure deletion of before[start, oldEnd).
    while (start > 0 && before.charCodeAt(start - 1) === before.charCodeAt(oldEnd - 1)) { start--; oldEnd-- }
    return { start, end: oldEnd, text: '' }
  }
  if (oldEnd === start) {
    // Pure insertion of after[start, newEnd).
    while (start > 0 && after.charCodeAt(start - 1) === after.charCodeAt(newEnd - 1)) { start--; newEnd-- }
    return { start, end: start, text: after.slice(start, newEnd) }
  }
  return { start, end: oldEnd, text: after.slice(start, newEnd) }
}

const growsAtStart = (s: Stickiness): boolean => s === 'always-grows' || s === 'grows-before'
const growsAtEnd = (s: Stickiness): boolean => s === 'always-grows' || s === 'grows-after'

/** An anchor after `edit`. Returns the same object when the edit did not move it. */
export function mapAnchor(anchor: Anchor, edit: TextEdit): Anchor {
  if (anchor.end < edit.start) return anchor
  const start = mapOffset(anchor.start, edit, growsAtStart(anchor.stickiness) ? -1 : 1)
  let end = mapOffset(anchor.end, edit, growsAtEnd(anchor.stickiness) ? 1 : -1)
  // A collapsed anchor that does not grow at either edge could invert here
  // (start after the insertion, end before it); it stays a point.
  if (end < start) end = start
  // Every anchored character was inside the removed text.
  const wiped = anchor.end > anchor.start && edit.start <= anchor.start && anchor.end <= edit.end
  if (start === anchor.start && end === anchor.end && !wiped) return anchor
  return {
    ...anchor,
    start: wiped ? edit.start : start,
    end: wiped ? edit.start : end,
    deleted: anchor.deleted || wiped,
  }
}

let fallbackCounter = 0

function newAnchorId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  fallbackCounter++
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${fallbackCounter}`
}

export interface AddAnchorOptions {
  /** Defaults to `'never-grows'`. */
  stickiness?: Stickiness
  /** Reuse a stored id (layer 3 re-anchoring). */
  id?: string
}

/**
 * A set of anchors over one text, kept in step with it.
 *
 * Feed it every change, either as the edit itself (`applyChange`, exact) or as
 * the new text (`updateText`, which diffs against the last text it saw — for
 * undo, redo and rebuilds, which report no edit). Anchors are immutable
 * values: a moved anchor is a new object, an unmoved one keeps its identity.
 */
export class AnchorSet {
  private _text: string
  private readonly anchors = new Map<string, Anchor>()

  constructor(text: string) {
    this._text = text
  }

  /** The text the anchors currently refer to. */
  get text(): string {
    return this._text
  }

  get size(): number {
    return this.anchors.size
  }

  add(start: number, end: number, options: AddAnchorOptions = {}): Anchor {
    if (!(Number.isInteger(start) && Number.isInteger(end) && 0 <= start && start <= end && end <= this._text.length)) {
      throw new RangeError(`anchor [${start}, ${end}) is outside the text (length ${this._text.length})`)
    }
    const id = options.id ?? newAnchorId()
    if (this.anchors.has(id)) throw new Error(`anchor id "${id}" is already in this set`)
    const anchor: Anchor = { id, start, end, stickiness: options.stickiness ?? 'never-grows', deleted: false }
    this.anchors.set(id, anchor)
    return anchor
  }

  get(id: string): Anchor | undefined {
    return this.anchors.get(id)
  }

  remove(id: string): boolean {
    return this.anchors.delete(id)
  }

  all(): Anchor[] {
    return [...this.anchors.values()]
  }

  /** The text an anchor covers now. */
  textOf(anchor: Anchor): string {
    return this._text.slice(anchor.start, anchor.end)
  }

  /** One edit, in the coordinates of the current text. */
  applyChange(edit: TextEdit): void {
    if (!(0 <= edit.start && edit.start <= edit.end && edit.end <= this._text.length)) {
      throw new RangeError(`edit [${edit.start}, ${edit.end}) is outside the text (length ${this._text.length})`)
    }
    this._text = this._text.slice(0, edit.start) + edit.text + this._text.slice(edit.end)
    this.mapAll(edit)
  }

  /**
   * The text as it is now, whatever happened to it. Found as one edit by
   * {@link diffText}; see the plan's *Known limit* for what that cannot tell.
   */
  updateText(text: string): void {
    const edit = diffText(this._text, text)
    this._text = text
    if (edit) this.mapAll(edit)
  }

  private mapAll(edit: TextEdit): void {
    for (const [id, anchor] of this.anchors) {
      const mapped = mapAnchor(anchor, edit)
      if (mapped !== anchor) this.anchors.set(id, mapped)
    }
  }
}
