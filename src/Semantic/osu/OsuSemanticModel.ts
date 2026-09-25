/**
 * What a BBCode document MEANS under osu!'s renderer, as queries over one red
 * tree: which newlines osu! swallows, which closers it shows nothing for, and
 * which closers a rich box title claims. Facts about the document, not about
 * HTML — so the renderer, the exporter and the edit rules all ask this model
 * instead of each other (docs/10-Semantic-Model-Plan.md).
 *
 * Answers are memoized per node, so a model is valid for ONE tree snapshot:
 * build a new one when the tree changes. It never renders or exports.
 */

import type { RedNode } from '../../Syntax/RedNode'
import { tagToNodeKind, type BBCodeDialect } from '../../BBCode/BBCodeToGreenNode'
import { scanBBCode } from '../../Lexer/BBCodeLexer'
import {
  CROSSABLE_DIV_KINDS, WIDTHLESS_CLOSE, WIDTHLESS_OPEN,
  discardedTagRule, firstNonWidthlessOpenChild, newlineRule,
  type NewlineRule,
} from './newlineRules'

export class OsuSemanticModel {
  constructor(readonly dialect: BBCodeDialect) {}

  /**
   * Whether a stray closer in a box's body closes a tag its rich title left
   * open — and so, in osu!, shows nothing.
   *
   * osu! pairs lazily over the raw text (see `Osu/osuPairing.ts`), so in
   * `[box=[size=85]🔧 Settings][/size]` the `[/size]` after the `]` closes the
   * title's `[size=85]`; neither shows. Quasar parses the title on its own,
   * which leaves that `[/size]` an orphan text leaf, rendered as literal text
   * (measured with the parity kit's visual comparison on `docs/ai/examples/3`
   * and `docs/ai/hxovc`). The TREE keeps it as text on purpose: the export
   * must still publish it, since osu! needs it to close the title's tag, and
   * the incremental parser must not depend on a title outside its window.
   * Only the preview stops painting it. Not for Lyne, a platform without
   * osu!'s lazy pairing.
   */
  isClaimedByBoxTitle(node: RedNode): boolean {
    if (this.dialect === 'lyne' || node.children.length > 0) return false
    const text = node.text
    if (text.length < 4 || text.charCodeAt(0) !== 91 /* [ */ || text.charCodeAt(1) !== 47 /* / */) return false
    for (let a = node.parent; a !== null; a = a.parent) {
      if ((a.kind === 'box' || a.kind === 'spoilerbox') && this.titleClaims(a).has(node)) return true
    }
    return false
  }

  /** An element inside a rich-titled box whose closer the title claimed. */
  isClaimedElement(node: RedNode): boolean {
    if (this.dialect === 'lyne') return false
    for (let a = node.parent; a !== null; a = a.parent) {
      if ((a.kind === 'box' || a.kind === 'spoilerbox') && this.titleClaims(a).has(node)) return true
    }
    return false
  }

  /** The title tag's spelling each claimed element answers to, for its literal opener. */
  private readonly claimedTag = new WeakMap<RedNode, string>()

  /** The title tag's spelling a claimed element answers to, for its literal opener. */
  claimedTagOf(node: RedNode): string | undefined {
    return this.claimedTag.get(node)
  }

  /** Per box: the closers its title claims (leaves or elements). See `isClaimedByBoxTitle`. */
  private readonly titleClaimCache = new WeakMap<RedNode, ReadonlySet<RedNode>>()

  private titleClaims(box: RedNode): ReadonlySet<RedNode> {
    const cached = this.titleClaimCache.get(box)
    if (cached !== undefined) return cached
    const claims = new Set<RedNode>()
    const rawTitle = box.metadata?.rawTitle
    if (typeof rawTitle === 'string' && rawTitle.includes('[')) {
      // What the title opens and never closes, by exact (lowercase) spelling:
      // osu!'s passes are case-sensitive.
      const pending = new Map<string, number>()
      for (const t of scanBBCode(rawTitle)) {
        if ((t.kind !== 'open' && t.kind !== 'close') || t.tag === '*') continue
        const spelled = rawTitle.slice(t.start, t.end)
        if (spelled !== spelled.toLowerCase()) continue
        pending.set(t.tag, (pending.get(t.tag) ?? 0) + (t.kind === 'open' ? 1 : -1))
      }
      // The FIRST closers of those tags after the title, in document order —
      // the lazy pass takes the nearest one, whatever it closes in Quasar's
      // tree: an orphan text leaf (`[box=[size=85]T][/size]`), or the closing
      // delimiter of a same-kind element opened in the body
      // (`[box=[size=85]T][size=80]x[/size]` — then osu! shows `[size=80]`
      // as text). A node's closer comes after its children, so the walk
      // visits children first. Raw blocks hold text, not closers.
      const kindOf = new Map<string, string>()
      for (const tag of pending.keys()) kindOf.set(tagToNodeKind(tag, this.dialect), tag)
      const claim = (tag: string | undefined, n: RedNode): void => {
        if (tag === undefined) return
        const left = pending.get(tag) ?? 0
        if (left <= 0) return
        claims.add(n)
        this.claimedTag.set(n, tag)
        pending.set(tag, left - 1)
      }
      const walk = (n: RedNode): void => {
        for (const c of n.children) {
          if (c.kind === 'code' || c.kind === 'inline_code') continue
          if (c.kind === 'text' && c.children.length === 0) {
            const m = /^\[\/([a-z0-9_-]+)\]$/.exec(c.text)
            if (m !== null) claim(m[1], c)
            continue
          }
          walk(c)
          if (c.green.trailingWidth > 0) claim(kindOf.get(c.kind), c)
        }
      }
      walk(box)
    }
    this.titleClaimCache.set(box, claims)
    return claims
  }


  /**
   * The newline rule a CLOSING node carries — its own kind for a real,
   * matched close, or the kind it stands in for when it is a ghost of one:
   * `discarded_tag` (a stranded closer of an auto-closed tag, any dialect,
   * any pairing) or `discarded_box_close` (`pairing: 'osu'` only — a
   * `box`/`spoilerbox`/`notice`/`centre`/`left`/`right` closer that reached
   * `Parser.ts`'s `closeDivUnits` with nothing left open). Both ghosts are
   * invisible in the render the same way a matched close's own tag is, so
   * they swallow newlines the same way too, and BOTH resolve their budget
   * from their own leaf text — `discarded_box_close` used to carry one fixed
   * table row (`box`'s own budget) back when it could only ever be a
   * `box`/`spoilerbox`; now that it can be any of the five, it needs the
   * same per-tag lookup `discarded_tag` already does.
   */
  private closingRule(node: RedNode) {
    return this.isGhost(node)
      ? discardedTagRule(node.text, this.dialect)
      : newlineRule(node.kind)
  }

  /**
   * A closer the render shows nothing for, standing in for a real one's
   * newline budget: the parser's ghosts, plus an orphan `[/box]` text leaf
   * (see {@link isOrphanBoxCloseText}).
   */
  isGhost(node: RedNode): boolean {
    return node.kind === 'discarded_tag' || node.kind === 'discarded_box_close' || this.isOrphanBoxCloseText(node)
  }

  /**
   * An orphan `[/box]`/`[/spoilerbox]`, which the default pairing keeps as a
   * literal text leaf: the preview renders it as the `discarded_box_close`
   * `pairing: 'osu'` makes of it — invisible, eating newlines like a real
   * box closer — because osu! seals every such closer and HTMLPurifier drops
   * the stray `</div>` (measured with the parity kit's visual comparison on
   * `docs/ai/NyuPenyu`, where a crossed `[/box]` showed as text).
   *
   * Only the render changes. The tree keeps the text and the export still
   * publishes it (`BBCodeExporter`'s own ghost test is by kind), so what goes
   * to osu! is byte-for-byte what it was. Exact lowercase spelling, as osu!'s
   * pass is case-sensitive; not inside raw blocks, whose text is content; not
   * for Lyne, a platform without osu!'s sealing.
   */
  isOrphanBoxCloseText(node: RedNode): boolean {
    if (node.kind !== 'text' || node.children.length > 0 || this.dialect === 'lyne') return false
    const text = node.text
    if (text !== '[/box]' && text !== '[/spoilerbox]') return false
    for (let a = node.parent; a !== null; a = a.parent) {
      if (a.kind === 'code' || a.kind === 'inline_code') return false
    }
    return true
  }

  private static isNewlineNode(node: RedNode): boolean {
    return node.kind === 'spacing' || node.kind === 'empty_line'
  }

  private static isBlankText(node: RedNode): boolean {
    return node.kind === 'text' && node.children.length === 0 && node.text.trim() === ''
  }

  /**
   * Whether this `spacing` / `empty_line` leaf is eaten by a neighbouring tag
   * and therefore renders nothing.
   *
   * Each leaf is exactly ONE source newline (the parser splits a run into one
   * node per `\n`), so the four scans below can be read straight off the
   * regexes they mirror. A newline eaten by any of them is eaten: osu's passes
   * run in a fixed order, but since a consumed newline is consumed whichever
   * pass claimed it, the union is enough — the per-pass order only matters for
   * a budget that could be spent elsewhere, and budgets here are counted from
   * the tag outwards, exactly as `\n?\n?` counts.
   */
  isNewlineSwallowed(node: RedNode): boolean {
    return this.eatenByOpeningTag(node)
      || this.eatenByClosingTag(node)
      || this.eatenAfterClosingTag(node)
      || this.eatenBeforeOpeningTag(node)
  }

  /** The newline budget a CLOSING node carries (see {@link closingRule}). */
  closingBudget(node: RedNode): NewlineRule | null {
    return this.closingRule(node)
  }


  /** `\[box\]\n*`, `\[quote\]\s*`, `[centre]\n`. */
  private eatenByOpeningTag(node: RedNode): boolean {
    let cur: RedNode = node
    let newlinesBetween = 0
    let blankBetween = false
    for (;;) {
      const prev = cur.previousSibling
      if (prev) {
        if (OsuSemanticModel.isNewlineNode(prev)) { newlinesBetween++; cur = prev; continue }
        if (OsuSemanticModel.isBlankText(prev)) { blankBetween = true; cur = prev; continue }
        return false
      }
      const parent = cur.parent
      if (!parent) return false
      if (WIDTHLESS_OPEN.has(parent.kind)) { cur = parent; continue }
      const rule = newlineRule(parent.kind)
      if (!rule) return false
      switch (rule.afterOpen) {
        case 'whitespace': return true
        // `\n*` matches newlines only: a stray space breaks the run.
        case 'all': return !blankBetween
        case 'one': return !blankBetween && newlinesBetween === 0
        default: return false
      }
    }
  }

  /**
   * `\n*\[/box\]`, `\s*\[/quote\]`, `\s*\[/list\]` — and, for a discarded
   * closing leaf sitting among its own siblings rather than at the tail of a
   * real container's children, the same `beforeClose` budget applied to it
   * directly (this method's usual climb to an ENCLOSING parent's boundary
   * does not apply — a leaf has no children to be the last one of). That
   * covers `discarded_box_close` (an orphan `[/box]`/`[/spoilerbox]` under
   * `pairing: 'osu'`) and `discarded_tag` (a stranded closer of a tag a
   * crossing auto-closed, any dialect, any pairing — see `closingRule`).
   * Scoped to those two kinds deliberately: eating `beforeClose` for an
   * arbitrary NEXT sibling would also eat newlines before a real block's
   * OPENING tag, which osu! never does (`eatenByOpeningTag` already covers
   * openings).
   */
  private eatenByClosingTag(node: RedNode): boolean {
    let cur: RedNode = node
    let blankBetween = false
    for (;;) {
      const next = cur.nextSibling
      if (next) {
        if (OsuSemanticModel.isNewlineNode(next)) { cur = next; continue }
        if (OsuSemanticModel.isBlankText(next)) { blankBetween = true; cur = next; continue }
        // `discarded_box_close` is deliberately NOT paragraph-flushed (see
        // Parser.ts), so it can sit as the FIRST child of a `paragraph` —
        // widthless on this side too — instead of always a direct sibling.
        // `discarded_tag` never needs that descent (it IS flushed out of
        // paragraphs, see Parser.ts's root-normalization loop) but reusing
        // the same helper is harmless: it is a no-op when `next` is not
        // itself a paragraph/group.
        const boundary = firstNonWidthlessOpenChild(next)
        if (this.isGhost(boundary)) {
          const rule = this.closingRule(boundary)
          return rule?.beforeClose === 'all' ? !blankBetween : rule?.beforeClose === 'whitespace'
        }
        return false
      }
      const parent = cur.parent
      if (!parent) return false
      if (WIDTHLESS_CLOSE.has(parent.kind)) { cur = parent; continue }
      // `pairing: 'osu'` crossing: a `notice`/`center`/`left`/`right` with NO
      // closing delimiter of its own (`trailingWidth === 0`) was closed by
      // an UNRELATED closer's cascade (`Parser.ts`'s `closeDivUnits`), not by
      // its own `[/tag]` — so its own `beforeClose` budget never actually
      // ran against this content. osu!'s real per-tag regex pass for THIS
      // content is whichever closer's bytes come LATER in the source
      // (tracked as a `discarded_tag` further out, past this node's own
      // `nextSibling` — see the `next` branch above): climb past this node
      // the same way as a `WIDTHLESS_CLOSE` wrapper instead of applying its
      // own rule. Measured: `[centre][notice]x[/centre]\n\n[/notice]\n\nb`
      // — real osu! eats the WHOLE seam via `notice`'s own `beforeClose`
      // (unlimited), even though it sits, in this tree, inside `centre`.
      // Scoped to these four kinds only. `trailingWidth === 0` can ALSO
      // happen under the default `'quasar'` pairing (its own, unrelated
      // auto-close of an inner tag crossed by an outer one — see
      // `Parser.ts`'s legacy branch), in which case this climbs past it too;
      // the full suite (`OsuNewlineSwallowing.test.ts` and everything else
      // exercising quasar-pairing auto-close) stays green with this in
      // place, so it has not been observed to change that pairing's output —
      // but it was not written FOR it, only measured not to break it.
      if (CROSSABLE_DIV_KINDS.has(parent.kind) && parent.green.trailingWidth === 0) {
        cur = parent
        continue
      }
      const rule = newlineRule(parent.kind)
      if (!rule) return false
      switch (rule.beforeClose) {
        case 'whitespace': return true
        case 'all': return !blankBetween
        default: return false
      }
    }
  }

  /** `\[/box\]\n?`, `\[/list\]\n?\n?`. */
  private eatenAfterClosingTag(node: RedNode): boolean {
    let cur: RedNode = node
    let newlinesBetween = 0
    for (;;) {
      const prev = cur.previousSibling
      if (!prev) {
        const parent = cur.parent
        if (parent && WIDTHLESS_OPEN.has(parent.kind)) { cur = parent; continue }
        return false
      }
      if (OsuSemanticModel.isNewlineNode(prev)) { newlinesBetween++; cur = prev; continue }
      // Descend to whatever real closing tag sits immediately to our left.
      // `discarded_tag`/`discarded_box_close` are leaves (no children), so
      // this stops on them unchanged — `closingRule` then resolves what they
      // stand in for.
      let closer: RedNode = prev
      while (WIDTHLESS_CLOSE.has(closer.kind) && closer.children.length > 0) {
        closer = closer.children[closer.children.length - 1]
      }
      const rule = this.closingRule(closer)
      return rule !== null && newlinesBetween < rule.afterClose
    }
  }

  /** `\s*\[\*\]` — the only pass that eats whitespace BEFORE an opening tag. */
  private eatenBeforeOpeningTag(node: RedNode): boolean {
    let cur: RedNode = node
    for (;;) {
      const next = cur.nextSibling
      if (next) {
        if (OsuSemanticModel.isNewlineNode(next) || OsuSemanticModel.isBlankText(next)) { cur = next; continue }
        return newlineRule(next.kind)?.beforeOpen === 'whitespace'
      }
      const parent = cur.parent
      if (!parent) return false
      if (WIDTHLESS_CLOSE.has(parent.kind)) { cur = parent; continue }
      return false
    }
  }
}
