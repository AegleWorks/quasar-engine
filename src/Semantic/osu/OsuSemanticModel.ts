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
  discardedTagRule, newlineRule,
  type NewlineRule,
} from './newlineRules'

/** Walking back to an opener: its `afterOpen` rule, newlines and blank text between. */
interface OpenState { readonly afterOpen: NewlineRule['afterOpen'] | null; readonly newlines: number; readonly blank: boolean }
/**
 * Walking forward to a closer: its `beforeClose` rule, whether blank text came
 * between, and whether that closer is one the render shows NOTHING for — a
 * ghost, whose `</div>` osu! never publishes (see {@link eatenByGhostCloser}).
 */
interface CloseState { readonly beforeClose: NewlineRule['beforeClose'] | null; readonly blank: boolean; readonly ghost: boolean }
/**
 * Walking back over newlines to a closer: its `afterClose` budget, the
 * newlines spent, and whether that closer is a ghost.
 */
interface AfterCloseState { readonly afterClose: number | null; readonly newlines: number; readonly ghost: boolean }

/**
 * `trim()` de PHP: espacio, tab, saltos, NUL, \v. Ni U+3000 ni U+00A0 ni
 * U+FEFF, que el `trim()` de JS sí come y osu! cuenta como texto.
 */
const PHP_BLANK_RE = /^[ \t\n\r\0\x0B]*$/


const NO_OPEN: OpenState = { afterOpen: null, newlines: 0, blank: false }
const NO_CLOSE: CloseState = { beforeClose: null, blank: false, ghost: false }
const NO_AFTER_CLOSE: AfterCloseState = { afterClose: null, newlines: 0, ghost: false }

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
      // osu!'s passes are case-sensitive — about the NAME. The check is the
      // name's own span and not the whole spelled tag, because the attribute
      // is not part of it: `[box=[color=#A38792]T][/color]` claims its
      // `[/color]`, and comparing the raw slice lowercased threw the claim
      // away for every uppercase colour, leaving `[/color]` printed as text
      // in the preview (measured on `osu/10053373`).
      const pending = new Map<string, number>()
      for (const t of scanBBCode(rawTitle)) {
        if ((t.kind !== 'open' && t.kind !== 'close') || t.tag === '*') continue
        const nameAt = t.kind === 'close' ? t.start + 2 : t.start + 1
        if (rawTitle.slice(nameAt, nameAt + t.tag.length) !== t.tag) continue
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
    // Blancura de PHP, no de JavaScript: los pasos de osu! son PCRE sin /u y
    // `trim()` de PHP usa " \t\n\r\0\x0B", así que U+3000, U+00A0 y U+FEFF
    // son CONTENIDO — una línea de solo `　` conserva su salto y se publica
    // como línea propia. El `trim()` de JS los come y pegaba esa línea a la
    // anterior (medido: `osu/4637369`, `osu/35798411`).
    return node.kind === 'text' && node.children.length === 0 && PHP_BLANK_RE.test(node.text)
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

  /**
   * Whether this newline leaf is the first break its own run of newlines puts
   * on screen because an INVISIBLE closer ate the one before it.
   *
   * osu!'s `str_replace("\n", '<br />')` turns every surviving newline into a
   * flat `<br />`, so when the eaten one belonged to a ghost — a closer the
   * render shows nothing for — nothing has closed the line yet and this
   * surviving newline is a bare line break. Measured (`a[/box]\n\nb`: the
   * orphan closer's `\n?` ate the first newline, and osu! publishes
   * `a<br />b` — ONE break, since HTMLPurifier drops the stray `</div>`):
   * drawing the second newline as a blank line adds a line nobody sees.
   *
   * A REAL closer is a different story, and the reason this asks for a ghost
   * rather than for "an eaten newline": its `</div>` does reach the page and
   * ends the line, so the newline after it is a blank line, exactly as the
   * `<div class="bb-empty-line">` draws it (measured on `[notice]x[/notice]`
   * and on every matched `[/box]`). False at the start of a run, and false
   * once an earlier newline of the same run survived — that one already ended
   * the line. Nothing here is dialect-gated: Miliastry breaks lines like osu!.
   */
  isBareLineBreak(node: RedNode): boolean {
    return this.eatenEarlierByGhost(node)
  }

  /** Walking back along `node`'s run of newlines: was one of them eaten by a ghost? */
  private eatenEarlierByGhost(node: RedNode): boolean {
    const memo = this.eatenBeforeRunMemo
    const known = memo.get(node)
    if (known !== undefined) return known
    const chain: RedNode[] = []
    let cur = node
    let eaten: boolean
    for (;;) {
      const hit = memo.get(cur)
      if (hit !== undefined) { eaten = hit; break }
      const prev = cur.previousSibling
      // The run starts (or is interrupted by visible content) here: nothing
      // before it for a ghost to have eaten.
      if (prev === null || !OsuSemanticModel.isNewlineNode(prev)) { eaten = false; break }
      chain.push(cur)
      if (this.eatenByGhostCloser(prev)) { eaten = true; break }
      cur = prev
    }
    // Every node in the chain sits AFTER the newline that decided it, so they
    // all share the answer — and none of the nodes walked past does (their own
    // run may still start with a ghost-eaten newline).
    memo.set(cur, eaten)
    for (const c of chain) memo.set(c, eaten)
    return eaten
  }

  /**
   * Whether this newline leaf is eaten by a closer the render shows NOTHING
   * for — a `discarded_tag`/`discarded_box_close` ghost, or the orphan
   * `[/box]`/`[/spoilerbox]` text leaf standing in for one — rather than by a
   * real `[/box]`, whose `</div>` reaches the page. Same two scans
   * `isNewlineSwallowed` runs, read for WHO did the eating instead of whether
   * anybody did.
   */
  private eatenByGhostCloser(node: RedNode): boolean {
    const after = this.afterCloseState(node)
    if (after.ghost && after.afterClose !== null && after.newlines < after.afterClose) return true
    const before = this.closeState(node)
    return before.ghost && (before.beforeClose === 'whitespace' || (before.beforeClose === 'all' && !before.blank))
  }


  // ── The four scans ──────────────────────────────────────────────────
  //
  // Each one walks from a newline over its run of neighbouring newlines (and,
  // for some, blank text) to whatever ends the run, then reads a rule there.
  // Walked afresh for every newline, a run of k newlines cost k² — 16 KB of
  // `\n` took six seconds to render. Every step of a walk is "the answer
  // here is the answer one node on, plus this node", so the answers are
  // memoized per node and filled in one pass along the walk: each node is
  // walked over once per scan, whatever the run's length. The memo is why a
  // model is valid for one tree snapshot.

  //
  // WeakMaps on purpose. A strong Map looks faster in isolation, but it keeps
  // every node of the snapshot alive until the model itself dies, and the corpus
  // measured 25% SLOWER end to end: the collector ends up copying trees that a
  // WeakMap lets go of as soon as the render stops looking at them.
  private readonly openMemo = new WeakMap<RedNode, OpenState>()
  private readonly afterCloseMemo = new WeakMap<RedNode, AfterCloseState>()
  private readonly closeMemo = new WeakMap<RedNode, CloseState>()
  private readonly beforeOpenMemo = new WeakMap<RedNode, boolean>()
  private readonly eatenBeforeRunMemo = new WeakMap<RedNode, boolean>()

  /** `\[box\]\n*`, `\[quote\]\s*`, `[centre]\n`. */
  private eatenByOpeningTag(node: RedNode): boolean {
    const st = this.openState(node)
    switch (st.afterOpen) {
      case 'whitespace': return true
      // `\n*` matches newlines only: a stray space breaks the run.
      case 'all': return !st.blank
      case 'one': return !st.blank && st.newlines === 0
      default: return false
    }
  }

  /** Walking back from `node`: the opener's rule, and what lies between. */
  private openState(node: RedNode): OpenState {
    const memo = this.openMemo
    const known = memo.get(node)
    if (known !== undefined) return known
    const chain: RedNode[] = []
    const steps: number[] = [] // 1 newline, 2 blank text, 0 climb
    let cur = node
    let state: OpenState
    for (;;) {
      const hit = memo.get(cur)
      if (hit !== undefined) { state = hit; break }
      const prev = cur.previousSibling
      if (prev) {
        if (OsuSemanticModel.isNewlineNode(prev)) { chain.push(cur); steps.push(1); cur = prev; continue }
        if (OsuSemanticModel.isBlankText(prev)) { chain.push(cur); steps.push(2); cur = prev; continue }
        state = NO_OPEN
        memo.set(cur, state)
        break
      }
      const parent = cur.parent
      if (!parent) { state = NO_OPEN; memo.set(cur, state); break }
      if (WIDTHLESS_OPEN.has(parent.kind)) { chain.push(cur); steps.push(0); cur = parent; continue }
      const rule = newlineRule(parent.kind)
      state = rule ? { afterOpen: rule.afterOpen, newlines: 0, blank: false } : NO_OPEN
      memo.set(cur, state)
      break
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      if (steps[i] === 1) state = { afterOpen: state.afterOpen, newlines: state.newlines + 1, blank: state.blank }
      else if (steps[i] === 2 && !state.blank) state = { afterOpen: state.afterOpen, newlines: state.newlines, blank: true }
      memo.set(chain[i], state)
    }
    return state
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
    const st = this.closeState(node)
    return st.beforeClose === 'whitespace' || (st.beforeClose === 'all' && !st.blank)
  }

  /** Walking forward from `node`: the closer's `beforeClose`, and whether blank text came first. */
  private closeState(node: RedNode): CloseState {
    const memo = this.closeMemo
    const known = memo.get(node)
    if (known !== undefined) return known
    const chain: RedNode[] = []
    const blanks: boolean[] = []
    let cur = node
    let state: CloseState
    for (;;) {
      const hit = memo.get(cur)
      if (hit !== undefined) { state = hit; break }
      const next = cur.nextSibling
      if (next) {
        if (OsuSemanticModel.isNewlineNode(next)) { chain.push(cur); blanks.push(false); cur = next; continue }
        if (OsuSemanticModel.isBlankText(next)) { chain.push(cur); blanks.push(true); cur = next; continue }
        // Visible text is not a ghost and carries no closing rule. Checking
        // that here skips `firstContent` and the ancestor walk in `isGhost`
        // for the most common boundary in the corpus. The two orphan closers
        // are text but ARE rendered as ghosts, so they keep the slow path.
        if (
          next.kind === 'text' && next.children.length === 0 &&
          next.text !== '[/box]' && next.text !== '[/spoilerbox]'
        ) {
          state = NO_CLOSE
          memo.set(cur, state)
          break
        }
        // `discarded_box_close` is deliberately NOT paragraph-flushed (see
        // Parser.ts), so it can sit as the FIRST child of a `paragraph` —
        // widthless on this side too — instead of always a direct sibling;
        // and a box's own closer lands inside its `box_tail`, which is the
        // last sibling of every box that ran into a crossing tag. Both are
        // wrappers the SOURCE text runs straight through, so the walk does
        // too (measured: `[box=][box=][notice][url=http://p][img]g[/img][/url]
        // \n[/box][/box][/notice]\n\nh` — osu! eats that newline with the
        // notice's or the box's own `\n*`, and stopping ON the `box_tail`
        // made the preview publish a `<br>` inside the well instead).
        // `discarded_tag` itself needs no descent (it IS flushed out of
        // paragraphs, see Parser.ts's root-normalization loop) but reusing
        // the same helper is harmless: it is a no-op on a leaf.
        const boundary = OsuSemanticModel.firstContent(next)
        state = this.isGhost(boundary)
          ? { beforeClose: this.closingRule(boundary)?.beforeClose ?? null, blank: false, ghost: true }
          : NO_CLOSE
        memo.set(cur, state)
        break
      }
      const parent = cur.parent
      if (!parent) { state = NO_CLOSE; memo.set(cur, state); break }
      // Un `box_tail` es lo que un cierre cruzado dejó tras el cuerpo, así que
      // los saltos del final ya NO están dentro de nada: lo que los come es el
      // `\n*` del cierre que venga después EN EL TEXTO, sea del propio box o
      // de cualquier otra etiqueta (osu! corre una pasada por etiqueta, y la de
      // `[/notice]` también empieza por `\n*`). Medido en los dos sentidos:
      //
      // - `[centre][box=t]x[/centre]\n\n[/box]\n\nb` → sigue el `[/box]`
      //   propio → sus `\n*` se come los dos: 1 `<br>` en toda la costura.
      // - `[box=t][centre]x[/box]\n\n[/centre]\n\nb` → el `[/box]` propio ya
      //   llegó (se comió el cuerpo al cruzar a `[centre]`) y lo que sigue es
      //   `[/centre]`, cuyo presupuesto es `none` → no come nada; solo el
      //   `\n?` de su afterClose (uno) toca al primero, y el otro sobrevive
      //   como el `<br>` que osu! deja dentro del wrapper: 2 en total.
      //   `eatenAfterClosingTag` ya cuenta ese presupuesto desde el fantasma,
      //   así que aquí solo hay que NO adelantarse.
      //
      // `closerAfter` encuentra ese cierre: el fantasma que mintió el cierre
      // que popeo el frame, que `Parser.ts` dejó en el bucket activo (puede ser
      // el `box_tail` de un box que lo envuelve, si el nuestro era su último
      // hijo).
      if (parent.kind === 'box_tail' && parent.parent !== null) {
        const after = this.closerAfter(parent.parent)
        state = after !== null && this.isGhost(after)
          ? { beforeClose: this.closingRule(after)?.beforeClose ?? null, blank: false, ghost: true }
          : NO_CLOSE
        memo.set(cur, state)
        break
      }
      if (WIDTHLESS_CLOSE.has(parent.kind)) { chain.push(cur); blanks.push(false); cur = parent; continue }
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
        chain.push(cur); blanks.push(false); cur = parent; continue
      }
      // `quote`/`list` crossed by an ancestor's closer have no own closer at
      // the end of this subtree (`trailingWidth === 0`): their `[/quote]` /
      // `[/list]` is a discarded leaf later in the source, so the `\s*`
      // before it cannot reach these newlines. Measured:
      // `[centre][quote]x\n\n[/centre]\n\n[/quote]` publishes
      // `x<br /><br />` inside the quote, not an eaten seam.
      //
      // `heading` entra aquí por la misma razón: un `[/heading]` que cruza un
      // `[centre]`/`[box]` abierto se descarta y el `<h2>` lo cierra el cierre
      // de fuera, así que los saltos de su cola son de ese cierre de fuera —
      // `osu/20778568`, donde el `[/list]` que cierra el heading auto-cerrado
      // se come los dos saltos finales que el preview publicaba como líneas
      // vacías dentro del título de la lista.
      if ((parent.kind === 'quote' || parent.kind === 'list' || parent.kind === 'heading') && parent.green.trailingWidth === 0) {
        chain.push(cur); blanks.push(false); cur = parent; continue
      }
      // Un INLINE que quedó sin su propio `[/tag]` (`trailingWidth === 0`:
      // lo cerró un cruce, y su cierre real es un fantasma más adelante en
      // el texto) no tiene pasada propia en osu — ninguna regex de
      // `BBCodeFromDB` menciona `[b]`, así que no hay presupuesto contra el
      // que medir. Los saltos al final de su contenido los come quien venga
      // después EN LA FUENTE, que es justo lo que encuentra el branch `next`
      // una vez arriba. Medido en `osu/12264918`:
      // `[notice]\n[b][box=…]…[/box]\n\n[b][box=…]…[/box]\n\n[/notice]` —
      // sin subir, el preview dejaba dentro del `well` el `<br>` que el
      // `\n*` de `[/notice]` se come (su cierre real quedó de
      // `discarded_tag`, y el `bold` cruzado, el padre de los saltos).
      if (newlineRule(parent.kind) === null && parent.green.trailingWidth === 0) {
        chain.push(cur); blanks.push(false); cur = parent; continue
      }
      const rule = newlineRule(parent.kind)
      state = rule ? { beforeClose: rule.beforeClose, blank: false, ghost: false } : NO_CLOSE
      memo.set(cur, state)
      break
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      if (blanks[i] && !state.blank) state = { beforeClose: state.beforeClose, blank: true, ghost: state.ghost }
      memo.set(chain[i], state)
    }
    return state
  }

  /**
   * The closing text osu!'s own regex sees immediately after `node` in the
   * SOURCE — the ghost leaf the parser minted for the closer that popped the
   * frame (`discarded_tag`/`discarded_box_close`, or the orphan `[/box]`
   * text the default pairing keeps), which is what a newline sitting at the
   * very end of a `node` needs to be measured against.
   *
   * Not the same as `node.nextSibling`: the parser APPENDS a frame's
   * `box_tail` after its ordinary children, so a box that was the last child
   * of an enclosing box is followed in the source by the first child of that
   * enclosing tail — where the ghost landed, since the bucket active when the
   * closer popped the frame was the enclosing box's tail. Everything else is
   * a genuine sibling (a crossing closer's ghost sits right where the box
   * ended). Returns `null` at the end of the document, or when what follows is
   * ordinary content instead of a ghost (a `paragraph`, some text, …).
   */
  private closerAfter(node: RedNode): RedNode | null {
    let cur: RedNode = node
    for (;;) {
      const next = cur.nextSibling
      if (next !== null) return OsuSemanticModel.firstContent(next)
      const parent = cur.parent
      if (parent === null) return null
      // The frame's OWN closing text comes first: what follows `cur` in the
      // source is that `[/tag]`, not whatever `parent` is followed by.
      if (parent.green.trailingWidth > 0) return null
      const last = parent.children[parent.children.length - 1]
      if (last !== undefined && last !== cur && last.kind === 'box_tail') {
        const first = last.children[0]
        return first === undefined ? null : OsuSemanticModel.firstContent(first)
      }
      cur = parent
    }
  }

  /**
   * The first node of `node`'s own subtree — how `closerAfter` reaches the
   * text inside a wrapper instead of the wrapper. `box_tail` is in here as
   * well as the widthless kinds: a box that was the last child of another box
   * is followed by that box's tail, and the ghost leaf sits inside it.
   */
  private static firstContent(node: RedNode): RedNode {
    let cur = node
    while (cur.children.length > 0 && (WIDTHLESS_OPEN.has(cur.kind) || cur.kind === 'box_tail')) {
      cur = cur.children[0]
    }
    return cur
  }

  /** `\[/box\]\n?`, `\[/list\]\n?\n?`. */
  private eatenAfterClosingTag(node: RedNode): boolean {
    const st = this.afterCloseState(node)
    return st.afterClose !== null && st.newlines < st.afterClose
  }

  /** Walking back from `node` over newlines: the closer's `afterClose` budget, and how much of it they spent. */
  private afterCloseState(node: RedNode): AfterCloseState {
    const memo = this.afterCloseMemo
    const known = memo.get(node)
    if (known !== undefined) return known
    const chain: RedNode[] = []
    const counts: boolean[] = []
    let cur = node
    let state: AfterCloseState
    for (;;) {
      const hit = memo.get(cur)
      if (hit !== undefined) { state = hit; break }
      const prev = cur.previousSibling
      if (!prev) {
        const parent = cur.parent
        if (parent && WIDTHLESS_OPEN.has(parent.kind)) { chain.push(cur); counts.push(false); cur = parent; continue }
        state = NO_AFTER_CLOSE
        memo.set(cur, state)
        break
      }
      if (OsuSemanticModel.isNewlineNode(prev)) { chain.push(cur); counts.push(true); cur = prev; continue }
      // Same fast path as `closeState`: visible text carries no closing rule.
      if (
        prev.kind === 'text' && prev.children.length === 0 &&
        prev.text !== '[/box]' && prev.text !== '[/spoilerbox]'
      ) {
        state = NO_AFTER_CLOSE
        memo.set(cur, state)
        break
      }
      // Descend to whatever real closing tag sits immediately to our left.
      // `discarded_tag`/`discarded_box_close` are leaves (no children), so
      // this stops on them unchanged — `closingRule` then resolves what they
      // stand in for.
      let closer: RedNode = prev
      while (WIDTHLESS_CLOSE.has(closer.kind) && closer.children.length > 0) {
        closer = closer.children[closer.children.length - 1]
      }
      const rule = this.closingRule(closer)
      state = rule ? { afterClose: rule.afterClose, newlines: 0, ghost: this.isGhost(closer) } : NO_AFTER_CLOSE
      memo.set(cur, state)
      break
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      if (counts[i]) state = { afterClose: state.afterClose, newlines: state.newlines + 1, ghost: state.ghost }
      memo.set(chain[i], state)
    }
    return state
  }

  /** `\s*\[\*\]` — the only pass that eats whitespace BEFORE an opening tag. */
  private eatenBeforeOpeningTag(node: RedNode): boolean {
    const memo = this.beforeOpenMemo
    const known = memo.get(node)
    if (known !== undefined) return known
    const chain: RedNode[] = []
    let cur = node
    let eaten: boolean
    for (;;) {
      const hit = memo.get(cur)
      if (hit !== undefined) { eaten = hit; break }
      const next = cur.nextSibling
      if (next) {
        if (OsuSemanticModel.isNewlineNode(next) || OsuSemanticModel.isBlankText(next)) { chain.push(cur); cur = next; continue }
        eaten = newlineRule(next.kind)?.beforeOpen === 'whitespace'
        break
      }
      const parent = cur.parent
      if (!parent) { eaten = false; break }
      if (WIDTHLESS_CLOSE.has(parent.kind)) { chain.push(cur); cur = parent; continue }
      eaten = false
      break
    }
    memo.set(cur, eaten)
    for (let i = chain.length - 1; i >= 0; i--) memo.set(chain[i], eaten)
    return eaten
  }
}
