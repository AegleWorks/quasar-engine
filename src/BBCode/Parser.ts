/**
 * DocumentEngine — BBCode Parser
 *
 * Builds a GreenNode (immutable syntax tree) from BBCode tokens.
 *
 * This is the core parsing logic that replaces the old BBCode parser.
 * Unlike the old parser, this produces GreenNode directly — no BBBlock[]
 * intermediate step. The flow is:
 *
 *   BBCode text
 *     ↓ createBBCodeScanner() [BBCodeLexer] — or scanBBCode(), collected
 *   BBCodeToken, one at a time
 *     ↓ parseTokensToGreen() [this]
 *   GreenNode
 *     ↓ greenToRedNode()
 *   RedNode
 *
 * Key differences from the old parser:
 * - Newlines are explicit tokens (not mixed into text) → precise empty_line detection
 * - All syntactically valid tags are parsed (not just BLOCK_TAGS)
 * - Produces GreenNode directly (no BBBlock[] intermediate)
 * - No newline stripping between block-level tags
 * - Consecutive newlines (2+) = empty_line node (paragraph break)
 * - Single newlines between inline content = ignored (CSS handles spacing)
 */

import { GreenNode, greenNode, greenLeaf } from '../Syntax/GreenNode'
import type { NodeKind } from '../Types/core'
import { GreenNodePool } from '../Syntax/GreenNodePool'
import { tagToNodeKind, type BBCodeDialect } from './BBCodeToGreenNode'
import type { BBCodeToken, BBCodeTokenCursor } from '../Lexer/BBCodeLexer'
import { createBBCodeScanner } from '../Lexer/BBCodeLexer'
import { isBlockKind } from './BBCodeToGreenNode'
import { applyOsuPairing } from '../Osu/osuPairing'

// ─── Main entry point ──────────────────────────────────────────

/**
 * Parse BBCode tokens into a GreenNode tree.
 *
 * @param input   A scanner from createBBCodeScanner(), or the array scanBBCode() collects
 * @param source  Original source text (used for fallback error text)
 * @returns       A GreenNode tree with 'document' as root
 */
export interface ParseOptions {
  strictMode?: boolean;
  /** BBCode dialect to parse against ('osu' | 'miliastry' | 'lyne'). Default: 'miliastry'. */
  dialect?: BBCodeDialect;
  /** Optional interner for structural sharing. If provided, identical subtrees
   *  share the same GreenNode reference in memory. */
  interner?: GreenNodePool;
  /**
   * Group top-level inline nodes into `paragraph` nodes. Default `true`.
   *
   * Paragraph grouping happens at the ROOT ONLY — inside `[centre]` or `[box]`
   * the children stay flat. So when the incremental parser re-parses the inner
   * span of such a container in isolation, that span's content is not root
   * content and must not be grouped, or the re-parsed subtree would gain
   * paragraphs the full parse never produces.
   */
  normalizeParagraphs?: boolean;
  /**
   * Plugin-registered tags: tag name → the kind their nodes get.
   *
   * The built-in table deliberately turns unknown tags into literal text
   * (`[Gateron]` in prose must stay visible), which also meant a plugin's tag
   * could render and export but never PARSE. This is the missing link: a tag
   * present here parses as a normal paired container. `BBCodeDocumentModel`
   * fills it from the `TagRegistry`'s non-builtin entries; everything not
   * registered still falls to literal text exactly as before.
   */
  extraTags?: ReadonlyMap<string, NodeKind>;
  /**
   * Which tag-pairing rule decides `open`/`close` tokens before the tree is
   * built. `'quasar'` (default) is today's structural rule, unchanged.
   * `'osu'` runs `applyOsuPairing` first: any token osu!'s own
   * `BBCodeForDB::generate()` would not have sealed is demoted to plain text
   * at the SAME source offsets, and the rest of this function — auto-close,
   * `discarded_tag`, strict-mode errors, paragraph grouping — proceeds
   * exactly as it does today on whatever survives. See `Osu/osuPairing.ts`.
   * Full-parse only: the incremental parser does not pass this through.
   */
  pairing?: 'quasar' | 'osu';
}

/** A cursor over a token array, for callers that already hold one. */
function arrayCursor(tokens: readonly BBCodeToken[]): () => BBCodeToken | null {
  let at = 0
  return () => (at < tokens.length ? tokens[at++] : null)
}

function drain(cursor: BBCodeTokenCursor): BBCodeToken[] {
  const out: BBCodeToken[] = []
  for (let t = cursor.next(); t !== null; t = cursor.next()) out.push(t)
  return out
}

export function parseTokensToGreen(
  input: BBCodeToken[] | BBCodeTokenCursor,
  source: string,
  options: ParseOptions = {}
): GreenNode {
  const strictMode = options.strictMode ?? false;
  const dialect = options.dialect ?? 'miliastry';
  const interner = options.interner ?? null;
  const normalizeParagraphs = options.normalizeParagraphs ?? true;
  const extraTags = options.extraTags;
  // Tokens are consumed strictly in order, so a cursor straight off the lexer
  // does: each token dies young instead of sitting in a 54.000-slot array
  // until the tree is built — which is what the collector used to spend a
  // cold parse copying. osu! pairing needs the whole list (it looks ahead for
  // closers), so it still gets one.
  let next: () => BBCodeToken | null
  if (options.pairing === 'osu') {
    next = arrayCursor(applyOsuPairing(Array.isArray(input) ? input : drain(input), source));
  } else {
    next = Array.isArray(input) ? arrayCursor(input) : () => input.next();
  }
  const root: GreenNode[] = []
  /**
   * Etiquetas que un cierre mal emparejado cerró por su cuenta y cuyo `[/tag]`
   * todavía está por llegar.
   *
   * Cuando `[/notice]` cierra un `[box]` que quedaba dentro, el `[/box]` que
   * viene después ya no tiene a quién cerrar. osu! lo tira; subir por la pila a
   * buscar otro `[box]` cierra uno que el autor no quería cerrar y saca del
   * contenedor a todo lo que sigue. En `docs/ai/NyuPenyu` eso aplanaba 43 cajas
   * anidadas a 9 y hacía la página un 78% más alta de lo que osu! muestra.
   *
   * La marca se consume al usarla y se borra si la etiqueta se vuelve a abrir,
   * porque entonces el cierre sí es suyo.
   */
  const autoClosed = new Set<string>()

  /**
   * How many anonymous `<div>`s each `pairing: 'osu'` div-emitting tag pushes
   * per occurrence — see `closeDivUnits` below. `box`/`spoilerbox` push TWO
   * (wrapper + body) at once; `notice`/`centre`/`left`/`right` push one.
   * Never consulted under the default `'quasar'` pairing.
   */
  const DIV_UNITS: Readonly<Record<string, number>> = {
    box: 2,
    spoilerbox: 2,
    notice: 1,
    centre: 1,
    left: 1,
    right: 1,
  }

  const stack: {
    /** The literal tag name. Closing matches on THIS, not on `kind`: `[centre]`
     *  and `[center]` share a kind but do not close each other, and that is
     *  existing behaviour, not something to change while optimising. */
    tag: string
    /** Resolved once, when the tag opens. `tagToNodeKind` used to be called
     *  twice per element — once to test for `custom`, once to close it. */
    kind: string
    attrs: string
    children: GreenNode[]
    /** Width of the opening delimiter, e.g. 3 for `[b]`, 11 for `[color=red]`. */
    leadingWidth: number
    /**
     * `pairing: 'osu'` only. True once a crossing closer has consumed this
     * frame's BODY div (`box`/`spoilerbox` only — see `DIV_UNITS`) while its
     * WRAPPER div is still open. The frame stays on the stack — it is not
     * done — but new content now goes to `tailChildren` (see `currentBucket`)
     * instead of `children`, and gets folded back in as a trailing
     * `box_tail` child once the wrapper itself finally closes (`closeFrame`).
     */
    bodyClosed?: boolean
    /** Content collected after `bodyClosed` flips true. See `bodyClosed`. */
    tailChildren?: GreenNode[]
  }[] = []

  /**
   * Create an internal GreenNode, optionally interning for structural sharing.
   *
   * Note what is NOT here: a start or an end. A green node has a width, and its
   * width is derived from its children plus its own delimiters, so the parser
   * cannot state a span that disagrees with what it actually built.
   */
  function createNode(
    kind: string,
    text: string,
    children: GreenNode[],
    leadingWidth: number = 0,
    trailingWidth: number = 0,
  ): GreenNode {
    if (interner) {
      return interner.internNode(kind, text, children, leadingWidth, trailingWidth)
    }
    return greenNode(kind, text, children, leadingWidth, trailingWidth)
  }

  /** Create a token. `width` defaults to the text's own length. */
  function createLeaf(kind: string, text: string, width: number = text.length): GreenNode {
    if (interner) {
      return interner.internLeaf(kind, text, width)
    }
    return greenLeaf(kind, text, width)
  }

  /**
   * Close a stack frame into an element node.
   *
   * `trailingWidth` is how much of the element's tail is its own closing
   * delimiter — 0 when it was auto-closed (by an enclosing tag, by a sibling
   * `[*]`, or by end of input), because then the closing text belongs to
   * somebody else or does not exist.
   *
   * The element's end used to be passed in as well. It no longer can be, and
   * that is the point: the end is `start + leadingWidth + Σ children + trailing`
   * by construction, so the partition invariant of point 14 stopped being
   * something to check and became something to compute.
   *
   * `pairing: 'osu'` only: if this frame's BODY div was closed early by a
   * crossing closer (`bodyClosed`, see the stack's own doc comment) and it
   * collected any content afterwards, that content is folded in as one
   * trailing `box_tail` child — `children` stays exactly what a non-crossing
   * close would have produced, plus this one extra node at the end. Empty
   * tails (the wrapper closed with nothing after the body) add nothing, so a
   * frame that was marked `bodyClosed` but never actually diverged from the
   * ordinary close still produces the ordinary shape.
   */
  function closeFrame(
    frame: {
      kind: string
      attrs: string
      children: GreenNode[]
      leadingWidth: number
      bodyClosed?: boolean
      tailChildren?: GreenNode[]
    },
    trailingWidth: number,
  ): GreenNode {
    const children = frame.bodyClosed && frame.tailChildren && frame.tailChildren.length > 0
      ? [...frame.children, createNode('box_tail', '', frame.tailChildren, 0, 0)]
      : frame.children
    return createNode(
      frame.kind,
      frame.attrs,
      children,
      frame.leadingWidth,
      trailingWidth,
    )
  }

  /**
   * Where the next node lands: the top stack frame's `tailChildren` if it is
   * mid-`box_tail` (see the stack's own doc comment on `bodyClosed`),
   * otherwise its ordinary `children`, otherwise the document root. EVERY
   * insertion point in this function — text, newlines, opens, auto-closed
   * inner tags, discarded/stray closers — goes through this (or `addToParent`,
   * which just calls it), so `bodyClosed` routing never has to be repeated at
   * each call site. Never diverges from `top.children` under the default
   * `'quasar'` pairing, since only `closeDivUnits` ever sets `bodyClosed`.
   */
  function currentBucket(): GreenNode[] {
    if (stack.length === 0) return root
    const top = stack[stack.length - 1]
    return top.bodyClosed ? top.tailChildren! : top.children
  }

  /**
   * Add a node to the current stack frame (or its tail bucket), or to root
   * if no frame is open.
   */
  function addToParent(node: GreenNode): void {
    currentBucket().push(node)
  }

  /**
   * `pairing: 'osu'` only. How many of `frame`'s own div units are still
   * open — `0` for anything not in `DIV_UNITS` (inline tags, `quote`,
   * `list`, `heading`, `imagemap`, `code`, `*`, …), the full count for a
   * fresh div-emitting frame, or one less once `bodyClosed` is set (see the
   * stack's own doc comment — only `box`/`spoilerbox` can ever be partially
   * closed, since everything else in `DIV_UNITS` is already a single unit).
   */
  function availableDivUnits(frame: (typeof stack)[number]): number {
    const total = DIV_UNITS[frame.tag]
    if (total === undefined) return 0
    return frame.bodyClosed ? total - 1 : total
  }

  /**
   * `pairing: 'osu'` closing for `box`/`spoilerbox`/`notice`/`centre`/
   * `left`/`right` — see `Osu/osuPairing.ts`'s module doc and `DIV_UNITS`.
   *
   * osu! never builds a tree: `BBCodeFromDB::toHTML()` turns every one of
   * these into literal `<div>`s (two for `box`/`spoilerbox` — wrapper, then
   * body — one for everything else), and HTMLPurifier closes each `</div>`
   * against the INNERMOST currently open `<div>` by POSITION alone, never by
   * which BBCode tag produced it, auto-closing anything non-div sitting on
   * top along the way. Measured: `[centre]x[quote]y[/centre]z[/quote]`
   * closes the `<blockquote>` early to reach `[centre]`'s own div (the
   * stray `[/quote]` that follows then finds nothing left open);
   * `[centre][box=a]x[/centre]y[/box]` — `[centre]`'s `</div>` closes only
   * `box`'s BODY div (its first unit), leaving the wrapper open around `x`
   * AND `y`; osu!'s HTML: `<div align-centre><div box><a/><div body>x</div>
   * y</div></div>`.
   *
   * What this does NOT reproduce (measured, and out of scope — see
   * `Osu/osuPairing.ts`'s and this function's own callers for what IS):
   * HTMLPurifier also auto-closes an INLINE element (`<strong>`, `<span>`
   * from `color`/`size`, …) the moment a div tries to open INSIDE it — e.g.
   * `[box=a]x[color=red][box=b]y[/color]z[/box][/box]` renders `x`, an EMPTY
   * `<span>`, then `box b` containing `yz` (color's own stray `[/color]`
   * finds nothing open and vanishes) — and can even split ONE inline tag
   * into several separate elements around interposed block content
   * (measured with `[notice]x[b]bold[centre]y[/notice]z[/centre]w[/b]` →
   * THREE separate `<strong>`s). Neither is a div-count problem — it is
   * HTMLPurifier's inline content-model enforcement, a materially different
   * mechanism this pass does not attempt.
   */
  function closeDivUnits(tag: string, closeWidth: number, tokStart: number, tokEnd: number): void {
    const needed = DIV_UNITS[tag]

    // Nothing div-related open ANYWHERE — leave every unrelated open tag
    // (inline or not) exactly as it was, not swept away on a search that
    // was always going to find nothing (standard HTML fix-nesting behaviour
    // for an end tag with no matching start anywhere: dropped, untouched —
    // measured with an inline tag: `[b]bold[/centre]` never touches `[b]`).
    // Only the FULLY-empty case bails like this: `box`/`spoilerbox` need
    // TWO units and may find only one somewhere — see the loop below, which
    // consumes whatever exists and drops only the leftover need, not
    // everything (measured: `docs/ai/NyuPenyu.from-intent.bbcode` has an
    // extra `[/box]` after its own matching one, with only `centre`'s ONE
    // unit left open; osu! closes `centre` with it and drops the rest of
    // this closer, it does not leave `centre` untouched).
    let anyAvailable = false
    for (let j = stack.length - 1; j >= 0 && !anyAvailable; j--) {
      if (availableDivUnits(stack[j]) > 0) anyAvailable = true
    }

    if (!anyAvailable) {
      // Every one of these five tags is, by construction, a genuinely SEALED
      // closer by the time it is a live `close` token here:
      // `Osu/osuPairing.ts`'s `alwaysSeal` family (`box`/`spoilerbox`) seals
      // every occurrence unconditionally, and its `lazy` family's `sealLazy`
      // now forces any closer it never actually matched with an opener to a
      // plain `text` token BEFORE this function ever runs (see its own sweep
      // step) — so a closer that was NEVER real at all (no opener anywhere,
      // measured: `x[/centre]y` → literal `x[/centre]y`) never reaches here
      // in the first place; it is already literal text upstream. What DOES
      // reach here with nothing left open is a closer that WAS genuinely
      // sealed but arrives once everything is already closed (measured:
      // `docs/ai/NyuPenyu.from-intent.bbcode`'s trailing, once-real
      // `[/centre]` after an earlier crossing already closed it) — osu!'s
      // own substitution already turned THAT one into a real `</div>`, which
      // HTMLPurifier then silently drops for lack of anything to close, same
      // as the leftover half of an insufficient `box`/`spoilerbox` below.
      // Same invisible, non-paragraph-flushing treatment for all five.
      addToParent(createLeaf('discarded_box_close', source.slice(tokStart, tokEnd)))
      return
    }

    // `clean`: the top of the stack IS this exact tag with every one of its
    // own units still open — this closer satisfies itself in one step, the
    // same as before div-unit tracking existed for this tag. Byte-identical
    // to the pre-crossing close: this frame keeps its real `closeWidth`, and
    // no separate leaf is needed for the closer's own text. Any other shape
    // (sweeping through something first, a tag mismatch, a partial
    // body-only close, running out with the need only partly met) means
    // this closer's bytes crossed into someone else's div(s) — or ran past
    // the last one; every frame touched then gets `trailingWidth: 0`
    // (auto-closed) and the closer's own bytes become an explicit
    // `discarded_tag` leaf instead — invisible with the same per-tag
    // newline budget as a real close (`HTMLRenderer.discardedTagRule` reads
    // the tag back out of the leaf's own text), so the rendered HTML is
    // identical either way; only which node "owns" the bytes differs.
    const top0 = stack[stack.length - 1]
    const clean = top0.tag === tag && availableDivUnits(top0) === needed

    let remaining = needed
    while (remaining > 0 && stack.length > 0) {
      const top = stack[stack.length - 1]
      const avail = availableDivUnits(top)

      if (avail === 0) {
        // Not a div at all — swept away by the cascade exactly like an
        // enclosing tag already auto-closes anything nested inside it under
        // the `'quasar'` pairing. Its own later closer (if any) is now
        // stranded: `autoClosed` turns that into a no-op `discarded_tag`
        // instead of reaching for some unrelated same-name tag further out.
        const inner = stack.pop()!
        currentBucket().push(closeFrame(inner, 0))
        autoClosed.add(inner.tag)
        continue
      }

      const take = Math.min(avail, remaining)
      remaining -= take

      if (take === avail) {
        // This frame's own units are fully spent — it closes now, whether
        // that is its OWN matching closer (`clean`) or a crossing one.
        stack.pop()
        currentBucket().push(closeFrame(top, clean && top === top0 ? closeWidth : 0))
      } else {
        // Only reachable for `box`/`spoilerbox` (avail 2, take 1): the body
        // div closes, the wrapper stays open — and stays ON the stack, still
        // collecting content, just now into `tailChildren` instead of
        // `children` (see `currentBucket`). `closeFrame` folds it back in as
        // a trailing `box_tail` child once the wrapper itself finally closes.
        top.bodyClosed = true
        top.tailChildren = []
      }
    }
    // `remaining` can still be > 0 here (`box`/`spoilerbox` found only ONE
    // unit anywhere, not two) — whatever WAS found is already closed above;
    // the unmet rest of this closer's own need just has nothing left to
    // close and is dropped, same as any other excess closer.

    if (!clean) {
      addToParent(createLeaf('discarded_tag', source.slice(tokStart, tokEnd)))
    }
  }

  let tok = next()
  while (tok !== null) {

    // ── Newline token(s) ─────────────────────────────────────
    if (tok.kind === 'newline') {
      // Count consecutive newlines and emit semantic nodes.
      // NO SUPPRESSION for inline context — the tree must preserve
      // ALL source information. The HTMLRenderer handles inline-safe
      // rendering of spacing/empty_line (as `<br>` / `<br><br>`).
      // Each newline in the run gets ITS OWN range. They used to all share the
      // whole run's span, so `"hola\n\nmundo"` produced `spacing [4..6]` and
      // `empty_line [4..6]` — two nodes owning offset 5, which is exactly the
      // ambiguity that made `shiftRanges` impossible to write correctly.
      let first = true

      let nl: BBCodeToken | null = tok
      while (nl !== null && nl.kind === 'newline') {
        // The first newline is soft spacing (ignored in block context); any
        // subsequent one is a hard empty line (rendered as `<br>` everywhere).
        addToParent(createLeaf(first ? 'spacing' : 'empty_line', '', nl.end - nl.start))
        first = false
        nl = next()
      }
      tok = nl

      continue
    }

    // ── Plain text ───────────────────────────────────────────
    if (tok.kind === 'text') {
      addToParent(createLeaf('text', tok.value))
      tok = next()
      continue
    }

    // ── Opening tag: [tag] or [tag=attrs] ──────────────────
    if (tok.kind === 'open') {
      // Unknown tags (not in the BBCode spec) must be preserved
      // as literal text. Treating them as real tags would cause
      // their content to disappear from the preview.
      // E.g. [Gateron], [90 misses], [b][Gateron][/b] → visible text
      //
      // Plugin-registered tags (`extraTags`) are the one exception: they are
      // known — just not to the built-in table — and parse as containers.
      let openKind = tagToNodeKind(tok.tag, dialect)
      if (openKind === 'custom') {
        const pluginKind = extraTags?.get(tok.tag)
        if (pluginKind === undefined) {
          const tagText = source.slice(tok.start, tok.end)
          addToParent(createLeaf('text', tagText))
          tok = next()
          continue
        }
        openKind = pluginKind
      }

      if (tok.tag === '*') {
        // Auto-close previous [*] if it's currently open. It ends where this
        // one begins and owns no closing delimiter.
        if (stack.length > 0 && stack[stack.length - 1].tag === '*') {
          addToParent(closeFrame(stack.pop()!, 0))
        }
        autoClosed.delete(tok.tag)
        stack.push({
          tag: tok.tag,
          kind: openKind,
          attrs: tok.attrs,
          children: [],
          leadingWidth: tok.end - tok.start,
        })
        tok = next()
        continue
      }

      if (openKind === 'separator') {
        addToParent(createLeaf('separator', tok.attrs, tok.end - tok.start))
        tok = next()
        continue
      }

      let attrs = tok.attrs
      if (openKind === 'effect' || openKind === 'anim' || openKind === 'container') {
        if (tok.tag !== openKind) {
          const param = tok.attrs.startsWith('=') ? tok.attrs.slice(1) : tok.attrs
          attrs = param ? `=${tok.tag}:${param}` : `=${tok.tag}`
        }
      } else if (openKind === 'style_tag' && tok.tag !== 'style') {
        if (tok.tag === 'nowrap') attrs = '=white-space:nowrap'
        else if (tok.tag === 'smallcaps') attrs = '=font-variant:small-caps'
      }

      // Push onto the stack — children will be added later.
      autoClosed.delete(tok.tag)
      stack.push({
        tag: tok.tag,
        kind: openKind,
        attrs,
        children: [],
        leadingWidth: tok.end - tok.start,
      })
      tok = next()
      continue
    }

    // ── Closing tag: [/tag] ──────────────────────────────────
    if (tok.kind === 'close') {
      const closeWidth = tok.end - tok.start

      if (strictMode) {
        if (stack.length > 0 && stack[stack.length - 1].tag === '*' && tok.tag === 'list') {
          // Auto-close [*] before closing [list] even in strict mode. The
          // `[/list]` belongs to the list, not to the item.
          addToParent(closeFrame(stack.pop()!, 0))
        }
        // STRICT MODE: Only match the very top of the stack.
        if (stack.length > 0 && stack[stack.length - 1].tag === tok.tag) {
          addToParent(closeFrame(stack.pop()!, closeWidth))
        } else {
          // Strict Mode Mismatch: Emit an 'error' node with the raw tag as child
          const expected = stack.length > 0 ? stack[stack.length - 1].tag : 'nothing'
          const text = source.slice(tok.start, tok.end)
          const errMsg = `Syntax Error: Expected /${expected}, got /${tok.tag}`
          addToParent(createNode('error', errMsg, [createLeaf('text', text)]))
        }
      } else if (options.pairing === 'osu' && DIV_UNITS[tok.tag] !== undefined) {
        closeDivUnits(tok.tag, closeWidth, tok.start, tok.end)
      } else if (autoClosed.has(tok.tag)) {
        // Este cierre llega tarde: su etiqueta ya se cerró sola cuando un
        // cierre anterior pasó por encima de ella. No puede reclamar un
        // ancestro del mismo nombre — hacerlo cerraba el contenedor de fuera
        // y expulsaba de él a todo el resto del documento.
        //
        // Se conserva como nodo `discarded_tag`, que guarda su rango pero no
        // se ve ni se exporta. Como texto volvía a salir del exportador
        // convertido en etiqueta viva, y el documento dejaba de ser estable al
        // reexportarlo (lo cazó `Fuzzer`).
        autoClosed.delete(tok.tag)
        addToParent(createLeaf('discarded_tag', source.slice(tok.start, tok.end)))
      } else {
        // LEGACY MODE: Walk backwards, auto-close inner tags, ignore orphaned closing tags.
        let found = -1
        for (let j = stack.length - 1; j >= 0; j--) {
          if (stack[j].tag === tok.tag) {
            found = j
            break
          }
        }

        if (found !== -1) {
          // Auto-close any tags that were opened inside this one. They end
          // where the closing delimiter BEGINS — the delimiter itself is owned
          // by the tag it actually closes, so an auto-closed inner tag gets a
          // trailing width of 0. This used to hand them `tok.end`, which made
          // `[b][i]x[/b]` produce an `italic` and a `bold` both ending at 10,
          // overlapping on the four characters of `[/b]`.
          const autoClosedHere: string[] = []
          while (stack.length - 1 > found) {
            const inner = stack.pop()!
            autoClosedHere.push(inner.tag)
            currentBucket().push(closeFrame(inner, 0))
          }

          // Close the matched tag itself — this one does own the delimiter.
          addToParent(closeFrame(stack.pop()!, closeWidth))
          // Las etiquetas que se cerraron solas quedan pendientes en el nivel
          // que ha quedado abierto tras cerrar esta.
          for (const tag of autoClosedHere) autoClosed.add(tag)
        } else {
          // Orphaned closing tag: no matching opener anywhere on the stack.
          //
          // This used to be dropped silently, which punched a hole in the
          // source coverage — those characters belonged to no node, so the
          // tree could not answer "what is at this offset?" for them. They are
          // now kept as literal text, exactly as unknown tags already were
          // (see the `custom` branch above), which is also what the user
          // typed and therefore what they expect to see.
          addToParent(createLeaf('text', source.slice(tok.start, tok.end)))
        }
      }

      tok = next()
      continue
    }
  }

  // ── Close any remaining unclosed tags ────────────────────────
  // These are tags that were opened but never closed in the source.
  // They get all remaining source as their content.
  while (stack.length > 0) {
    // No closing delimiter exists, so trailing width is 0.
    addToParent(closeFrame(stack.pop()!, 0))
  }

  if (!normalizeParagraphs) {
    return createNode('document', '', root)
  }

  // Normalize root inline nodes into paragraphs
  const normalizedRoot: GreenNode[] = []
  let currentParagraph: GreenNode[] = []

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      normalizedRoot.push(createNode('paragraph', '', currentParagraph))
      currentParagraph = []
    }
  }

  for (const child of root) {
    // GreenNode.kind is a widened `string`; the kind vocabulary is shared with
    // NodeKind and every value reaching here came from tagToNodeKind().
    // `discarded_tag` viaja suelto igual que `empty_line`: es un tramo de
    // fuente que no se ve, y envolverlo en un párrafo dejaba un `<span>` vacío
    // en el render por cada cierre descartado.
    //
    // `discarded_box_close` (osu! pairing únicamente, ver la rama de arriba)
    // NO entra aquí a propósito, a diferencia de `discarded_tag`: a
    // diferencia de un cierre trasnochado que ya viene pegado a un límite de
    // bloque real, un `[/box]`/`[/spoilerbox]` huérfano puede caer en medio
    // de texto corrido (`"hola[/box] mundo"`), y forzar un flush ahí partía
    // ese texto en dos `paragraph` cuando osu! real lo muestra como una sola
    // corrida ("hola mundo"). Queda inline — invisible igual, HTMLRenderer
    // se encarga de comerse los saltos a su alrededor vía `NEWLINE_RULES`.
    if (isBlockKind(child.kind as NodeKind) || child.kind === 'empty_line' || child.kind === 'discarded_tag') {
      flushParagraph()
      normalizedRoot.push(child)
    } else {
      currentParagraph.push(child)
    }
  }
  flushParagraph()

  // The root spans the whole source, always. It used to be derived from its
  // children (`root[0].start` … `last.end`), which meant that anything the
  // parser dropped — an orphaned closing tag, most commonly — silently
  // shrank the document. Every token now lands somewhere in the tree, so the
  // children genuinely cover `[0..source.length]` and the root can say so.
  return createNode('document', '', normalizedRoot)
}

/**
 * Full parse: BBCode text → GreenNode.
 *
 * Convenience function that combines the lexer and parser.
 * BBCodeDocumentModel internally uses createBBCodeScanner() + parseTokensToGreen() directly.
 *
 * Usage:
 *   import { parseBBCode } from '../BBCode/Parser'
 *   const tree = parseBBCode('[b]Hello[/b]')
 */
export function parseBBCode(source: string, options: ParseOptions = {}): GreenNode {
  return parseTokensToGreen(createBBCodeScanner(source, { pairing: options.pairing }), source, options)
}
