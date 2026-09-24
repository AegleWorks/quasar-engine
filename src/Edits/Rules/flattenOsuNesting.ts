/**
 * Quasar — `flatten-osu-nesting`
 *
 * Export-only rule (target `'osu'`). Never registered in `defaultRules()` —
 * `Optimizer.ts`'s preset is what the EDITOR buffer runs (`document.minify`,
 * `MinifyLayer`), and this rule must never touch that buffer (see
 * `quasar-nested-color-is-supported` and `bbcode-optimizer-range-first` in
 * project memory). `BBCodeExporter.export()` runs it explicitly, over the
 * ALREADY-EXPORTED text, only when `target === 'osu'`.
 *
 * ─── Why export needs this at all ──────────────────────────────────────────
 *
 * Quasar nests same-name tags fine — `[color=X][color=Y]…[/color][/color]`
 * has defined semantics, nearest wins. osu! does not: every one of its
 * BBCode families except `box`/`spoilerbox`/`quote` pairs the FIRST opener
 * with the NEAREST closer, so a same-name inner tag is swallowed as literal
 * text and its own closer strands outside, wrecking the render — measured
 * with the real osu-web pipeline, see `quasar-nested-color-is-supported`
 * memory ("mundo" vanishing from `[color=#AAA]hola [color=#F00]mundo[/color]
 * y adios[/color]"). The default (miliastry) preview is unaffected — nothing
 * here runs for it — so this rule's whole job is making sure `osu(export(src))`
 * never contains a same-name pair osu! would mangle, while staying byte-for-
 * byte silent about it for the default preview per the product rule.
 *
 * ─── Two fixable shapes, one unfixable one ─────────────────────────────────
 *
 * 1. **Idempotent** — `bold`/`italic`/`underline`/`strikethrough`/`spoiler`/
 *    `heading`/`center`/`left`/`right` carry no value, so nesting one inside
 *    itself is always a no-op: DELETE the inner tag's own delimiters (content
 *    stays, merged into the outer). `color` joins this list only when the
 *    inner's normalised value equals the NEAREST governing ancestor's — same
 *    move as `dropRedundantNestingRule`, but this rule owns its own decision
 *    independently (it must run over export text under a different dialect,
 *    and must also handle the split case that rule never does).
 * 2. **Split** — a `color` (or `font_size`) whose inner value genuinely
 *    differs. Rather than touch the inner tag, or the whole span between
 *    outer's own delimiters (which could cross other, unrelated tags), this
 *    closes the outer tag right before — and reopens it right after — the
 *    outer's own DIRECT CHILD that leads down to the inner conflict. That
 *    child's own delimiters, and everything between them, are never touched:
 *    an intervening tag like `[b]` keeps wrapping exactly what it always did,
 *    it just ends up between two pieces of the (now-split) outer tag instead
 *    of strictly inside one. Two maximal instances of the SAME kind under
 *    ONE ancestor split independently (`hola [color=b]1[/color] y
 *    [color=c]2[/color]`, both direct children) — DEDUPED by the direct-child
 *    boundary rather than by the deep conflicting node so that two conflicts
 *    sharing one intervening ancestor (`[b][color=b]1[/color][color=c]2[/color][/b]`,
 *    say) only get ONE close/reopen pair, at `[b]`'s own boundary.
 *
 *    `font_size` additionally REWRITES the inner tag's own value to the
 *    compounded percentage (`outer% of inner%`, HTML nesting compounds —
 *    see `bbcode-optimizer-range-first` memory) so the split single tag
 *    reproduces what the nested pair rendered. Only when that compound is a
 *    whole number osu! actually accepts (`FontSizeLimits`'s ceiling); a
 *    `[size=100]` inner is idempotent instead (100% of anything is that
 *    thing) and always drops rather than splits.
 * 3. **Unfixable** — everything else this rule does not list (`notice`,
 *    `list`, `url`, `code`, `c`, and a `font_size` compound that cannot be
 *    expressed) is left completely untouched here. `SemanticAnalyzer`'s
 *    `osu-unsupported-nesting` validator is what tells the author about
 *    those, on the EDITOR tree, with a real range — this rule only ever
 *    silently fixes, never silently leaves a warning-worthy case unflagged.
 *
 * `box`/`spoilerbox`/`quote` are absent from every list above on purpose:
 * osu! nests them by well-formed HTML alone (see the product rule this
 * module and `SemanticAnalyzer`'s validator both implement).
 */

import type { PlannedEdit } from '../EditPlan'
import {
  type OptimizationRule,
  type RuleContext,
  type Positioned,
  positionedChildren,
  endOf,
  openRange,
  closeRange,
  hasBothDelimiters,
  deletion,
} from './Rule'
import { attributeValue, normalizeColorValue } from './tagValue'
import { maxFontSizeFor } from '../../Utils/FontSizeLimits'
import type { RedNode } from '../../Syntax/RedNode'
import type { HTMLRenderer } from '../../Visitors/HTMLRenderer'
import { isBlockKind } from '../../BBCode/BBCodeToGreenNode'
import type { NodeKind } from '../../Types/core'

export const FLATTEN_OSU_NESTING_PRIORITY = 95

/** No value — always idempotent when nested in an identical ancestor. */
const IDEMPOTENT_KINDS: ReadonlySet<string> = new Set([
  'bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'heading',
  'center', 'left', 'right',
])

/**
 * Of {@link IDEMPOTENT_KINDS}, the ones osu! renders as a BLOCK (a `<div>`,
 * per `HTMLRenderer`'s `RENDERED_AS_BLOCK`/`NEWLINE_RULES`) rather than an
 * inline span. Dropping one of these needs the newline fixup in
 * {@link FlattenOsuNestingRule.fixupBlockNewlines} — an inline drop
 * (`bold`/`italic`/…) never eats a newline in the first place, so it never
 * needs one.
 */
const BLOCK_NEWLINE_KINDS: ReadonlySet<string> = new Set(['center', 'left', 'right', 'heading'])

/** Carries a value that decides drop-vs-split. */
const VALUE_KINDS: ReadonlySet<string> = new Set(['color', 'font_size'])

/**
 * Media kinds that would separate themselves from their neighbours in osu!:
 * none. `[img]` is an inline `<img>`, `[youtube]` an `inline-block` embed of
 * up to 425px (`.u-embed-wide--bbcode` in osu!'s app.css) and `[audio]` an
 * `inline-flex` player (`.audio-player--bbcode`) — each sits on the same line
 * as whatever touches it.
 *
 * This set used to hold all three, on the strength of
 * `docs/ai/gallery/16-galileo.bbcode`'s `[centre]…[/centre]\n[youtube]…` seam
 * showing ZERO `<br>` in osu-web's render. That was a count, not a layout:
 * dropping the inner `[centre]` without a stand-in newline put the video
 * BESIDE the title in osu!, while the preview showed it below — measured by
 * laying out both with their real stylesheets (osu!'s own app.css, a
 * 940px userpage) in the parity kit's visual comparison.
 */
const SELF_SEPARATING_MEDIA_KINDS: ReadonlySet<string> = new Set([])

function isSelfSeparating(kind: NodeKind): boolean {
  return isBlockKind(kind) || SELF_SEPARATING_MEDIA_KINDS.has(kind)
}

export interface FlattenOsuNestingContext {
  /**
   * Builds a RedNode view of the EXACT SAME parse `RuleContext.root` came
   * from — required only to fix up the newlines a dropped BLOCK tag
   * (`center`/`left`/`right`/`heading`) used to eat. A THUNK, not the tree
   * itself: `greenToRedNode` walks and allocates the WHOLE document, and
   * block-kind same-name nesting is the rare case this rule exists for, not
   * the common one — building it unconditionally on every `'osu'` export
   * regressed the 547 KB fixture's export budget roughly 15× (measured
   * chasing `packages/features/BBCode/export/export.perf.test.ts`, 7ms → over
   * 100ms) even for documents with no such nesting at all. This rule calls
   * it AT MOST once per `run()`, and only when `dropInner` is about to drop
   * a block kind — never for the idempotent inline kinds, the color/size
   * split path, or a document that never reaches `resolve()`'s block branch.
   * Optional so the rule stays usable standalone (tests, `allRules()`-style
   * callers) without a renderer on hand; without it, block drops are still
   * structurally correct, just without the newline cleanup.
   */
  readonly redRoot?: () => RedNode
  /**
   * Whose `NEWLINE_RULES`/`closingBudget`/`isNewlineSwallowedPublic` this
   * rule reads rather than duplicating (per `bbcode-optimizer-range-first`:
   * one table, one owner). Any dialect's renderer works — the four block
   * kinds here carry the SAME budget in osu and miliastry (`NEWLINE_RULES`
   * is not dialect-gated).
   */
  readonly renderer?: HTMLRenderer
}

type Outcome = 'drop' | 'split' | 'leave'

interface ForceEntry {
  /** Nearest same-kind ancestor currently governing this branch of the tree. */
  readonly ancestor: Positioned
  /**
   * The direct child of `ancestor` on the path down to here — the boundary a
   * split closes/reopens around. `null` until the walk has descended exactly
   * one level below `ancestor` (filled in by the caller on the next step;
   * see `scan`).
   */
  readonly topChild: Positioned | null
}

export class FlattenOsuNestingRule implements OptimizationRule {
  readonly id = 'flatten-osu-nesting'
  readonly priority = FLATTEN_OSU_NESTING_PRIORITY
  readonly label = 'Flatten osu!-unsupported same-name nesting'

  /**
   * Built AT MOST once per `run()`, and only on the first call that actually
   * needs it (`fixupBlockNewlines`) — see the perf note on
   * `FlattenOsuNestingContext.redRoot`. `undefined` means "not built yet,
   * still eligible"; `null` means "built (or unavailable) — stop asking."
   */
  private redByStart: Map<number, RedNode> | null | undefined = undefined

  constructor(private readonly context: FlattenOsuNestingContext = {}) {}

  run(context: RuleContext): PlannedEdit[] {
    const sink: PlannedEdit[] = []
    const splitBoundaries = new Set<string>()
    this.redByStart = undefined
    this.scan({ node: context.root, start: 0 }, new Map(), context.source, splitBoundaries, sink)
    sink.sort((a, b) => a.start - b.start || a.end - b.end)
    return sink
  }

  /** Builds {@link redByStart} on first use; a no-op on every call after. */
  private ensureRedByStart(): Map<number, RedNode> | null {
    if (this.redByStart === undefined) {
      this.redByStart = this.context.redRoot ? indexByStart(this.context.redRoot()) : null
    }
    return this.redByStart
  }

  private scan(
    item: Positioned,
    inForce: ReadonlyMap<string, ForceEntry>,
    source: string,
    splitBoundaries: Set<string>,
    sink: PlannedEdit[],
  ): void {
    for (const child of positionedChildren(item)) {
      const kind = child.node.kind
      const tracked = IDEMPOTENT_KINDS.has(kind) || VALUE_KINDS.has(kind)

      let base = inForce
      const pending = [...base.entries()].filter(([, e]) => e.topChild === null)
      if (pending.length > 0) {
        const copy = new Map(base)
        for (const [k, e] of pending) copy.set(k, { ancestor: e.ancestor, topChild: child })
        base = copy
      }

      let nextInForce = base
      if (tracked) {
        const entry = base.get(kind)
        if (entry) {
          const outcome = this.resolve(kind, entry, child, source, splitBoundaries, sink)
          if (outcome === 'drop') {
            nextInForce = base
          } else {
            const copy = new Map(base)
            copy.set(kind, { ancestor: child, topChild: null })
            nextInForce = copy
          }
        } else {
          const copy = new Map(base)
          copy.set(kind, { ancestor: child, topChild: null })
          nextInForce = copy
        }
      }

      this.scan(child, nextInForce, source, splitBoundaries, sink)
    }
  }

  private resolve(
    kind: string,
    entry: ForceEntry,
    child: Positioned,
    source: string,
    splitBoundaries: Set<string>,
    sink: PlannedEdit[],
  ): Outcome {
    if (IDEMPOTENT_KINDS.has(kind)) {
      this.dropInner(child, sink)
      if (BLOCK_NEWLINE_KINDS.has(kind)) this.fixupBlockNewlines(child, source, sink)
      return 'drop'
    }

    if (kind === 'color') {
      if (!hasBothDelimiters(child) || !hasBothDelimiters(entry.ancestor)) return 'leave'
      const innerId = normalizeColorValue(attributeValue(child.node))
      const outerId = normalizeColorValue(attributeValue(entry.ancestor.node))
      if (innerId === outerId) {
        this.dropInner(child, sink)
        return 'drop'
      }
      this.emitSplit(kind, entry, source, splitBoundaries, sink)
      return 'split'
    }

    if (kind === 'font_size') {
      if (!hasBothDelimiters(child) || !hasBothDelimiters(entry.ancestor)) return 'leave'
      const innerRaw = attributeValue(child.node)
      const outerRaw = attributeValue(entry.ancestor.node)
      const inner = Number(innerRaw)
      const outer = Number(outerRaw)
      if (!Number.isFinite(inner) || !Number.isFinite(outer)) return 'leave'
      if (inner === 100) {
        this.dropInner(child, sink)
        return 'drop'
      }
      const compound = (outer * inner) / 100
      const max = maxFontSizeFor('osu') ?? 200
      if (!Number.isInteger(compound) || compound < 1 || compound > max) return 'leave'

      this.rewriteSizeValue(child, source, compound, sink)
      this.emitSplit(kind, entry, source, splitBoundaries, sink)
      return 'split'
    }

    return 'leave'
  }

  private dropInner(child: Positioned, sink: PlannedEdit[]): void {
    if (!hasBothDelimiters(child)) return
    const label = 'Flatten osu!-unsupported nesting'
    sink.push(deletion(openRange(child), this.id, this.priority, label))
    sink.push(deletion(closeRange(child), this.id, this.priority, label))
  }

  /**
   * Reconciles the newlines around a dropped BLOCK tag (`center`/`left`/
   * `right`/`heading`) with what `HTMLRenderer` actually did with them,
   * so removing the div boundary neither leaks a blank line nor glues two
   * lines together. Three sources of newline, per side (open and close),
   * all resolved with `HTMLRenderer.isNewlineSwallowedPublic` against the
   * PRE-drop tree — reading `NEWLINE_RULES` through the one shared accessor
   * rather than a second copy of the table (`closingBudget`'s own doc
   * comment; `BBCodeExporter.exportChildren` already leans on this same pair
   * for the analogous ghost-closer problem):
   *
   * 1. `child`'s own LEADING/TRAILING newline children — eaten by `child`'s
   *    own `afterOpen`/`beforeClose` budget, rendering nothing while `child`
   *    existed. Once `child`'s brackets are gone nothing is left to eat
   *    them, so as plain text they would become a `<br>` osu! never showed.
   *    Deleted.
   * 2. The run of newline SIBLINGS right after `child`'s close (`redChild.
   *    nextSibling`, `.nextSibling.nextSibling`, …) — `child`'s `afterClose`
   *    budget can eat those too, and that budget dies with `child` the same
   *    way (1), above, does; `eatenAfterClosingTag` already stops crediting
   *    them past `child`'s own budget, so this walks the run and deletes
   *    only the ones still reporting swallowed. The PRECEDING sibling needs
   *    no equivalent walk: none of these four kinds' `beforeOpen` rule is
   *    anything but `'none'`, so a newline before `child` can never be eaten
   *    on `child`'s account in the first place.
   * 3. `child` was a `<div>`: entering and leaving one is an implicit line
   *    break with NO newline character behind it at all (`A[centre]B[/centre]C`
   *    still shows three lines). Removing the div removes that break too, so
   *    when NEITHER (1) nor (2) nor the immediately preceding/following
   *    sibling already leaves a real, visible newline at the seam, one plain
   *    `\n` is inserted to stand in for it — but ONLY when there is other
   *    content on that side to separate FROM at all (a `previousSibling`/
   *    `nextSibling` exists): `child` sitting alone with nothing beside it
   *    needs no separator, and unconditionally inserting one here regressed
   *    `[centre][centre]B[/centre][/centre]` into a stray trailing `<br>`
   *    while chasing the corpus metric (`Tests/ExportOsuNesting.test.ts`
   *    covers this).
   */
  private fixupBlockNewlines(child: Positioned, source: string, sink: PlannedEdit[]): void {
    const renderer = this.context.renderer
    if (!renderer) return
    const redChild = this.ensureRedByStart()?.get(child.start)
    if (!redChild) return

    const isNL = (n: RedNode) => n.kind === 'spacing' || n.kind === 'empty_line'
    const label = 'Reconcile newlines around a flattened osu! block tag'

    // ── open side ──
    {
      const leading: RedNode[] = []
      for (const c of redChild.children) {
        if (isNL(c)) leading.push(c)
        else break
      }
      const prev = redChild.previousSibling
      // `prev` itself is NEVER touched (see the doc comment: none of these
      // four kinds' `beforeOpen` rule is anything but `'none'`, so a newline
      // before `child` is never eaten on `child`'s account). Its mere
      // EXISTENCE is what matters here, not its current swallow verdict —
      // it may already be invisible for a reason that has nothing to do
      // with `child` at all (`[heading]x[/heading]\n[centre]…[/centre]`:
      // that `\n` is eaten by `heading`'s OWN afterClose, not by anything
      // `child` (the inner `centre`) does), and inserting a SECOND newline
      // on top of a real, un-deleted one is a genuine extra blank line —
      // measured on `docs/ai/gallery-osu/24-zenobia.bbcode` chasing the
      // corpus metric, see `Tests/ExportOsuNesting.test.ts`'s regression
      // case for the minimal repro.
      let sawVisible = !!prev && isNL(prev)
      for (const n of leading) {
        if (renderer.isNewlineSwallowedPublic(n)) {
          sink.push(deletion(n.range, this.id, this.priority, label))
        } else {
          sawVisible = true
        }
      }
      // A `prev` that already renders as its own BLOCK (another div, a
      // `[youtube]` embed, …) already starts `child`'s content on a fresh
      // line by itself — browsers put whatever follows a block box on a new
      // line with no `<br>` needed, the same reason the ORIGINAL nested
      // `[centre]` never needed one to separate from what was outside it.
      // Inserting here anyway added a real, counted `<br>` real osu! never
      // had (measured on `docs/ai/gallery/16-galileo.bbcode`'s `[quote]…
      // [/quote]\n\n[centre][size=85]…` seam — `prev` there is a plain
      // newline already, so THIS check does not even apply to it; the
      // symmetric case that DOES need it is caught on the close side, next).
      // Only `text` (or nothing at all) glues without any separator of its
      // own — an INLINE tag (`[b]`, `[color]`, …) doesn't either, so it
      // still needs the inserted newline; `isBlockKind` is what tells the
      // two apart.
      if (!sawVisible && prev && !isSelfSeparating(prev.kind)) {
        sink.push({ start: child.start, end: child.start, text: '\n', ruleId: this.id, priority: this.priority, label })
      }
    }

    // ── close side ──
    {
      const trailing: RedNode[] = []
      for (let i = redChild.children.length - 1; i >= 0; i--) {
        const c = redChild.children[i]
        if (isNL(c)) trailing.unshift(c)
        else break
      }
      let sawVisible = false
      for (const n of trailing) {
        if (renderer.isNewlineSwallowedPublic(n)) {
          sink.push(deletion(n.range, this.id, this.priority, label))
        } else {
          sawVisible = true
        }
      }

      // The run of sibling newlines `child`'s afterClose budget can still
      // reach — deleting whichever ones `HTMLRenderer` says it is still
      // crediting to `child` specifically (`eatenAfterClosingTag` stops at
      // the budget on its own, so this never over-deletes into a run that
      // belongs to something further back). The first NON-swallowed one
      // found already satisfies "a visible newline sits at the seam", same
      // as the leading-side `prev` check.
      let next = redChild.nextSibling
      let nextExists = !!next
      while (next && isNL(next)) {
        if (renderer.isNewlineSwallowedPublic(next)) {
          sink.push(deletion(next.range, this.id, this.priority, label))
          next = next.nextSibling
        } else {
          sawVisible = true
          break
        }
      }

      // Same block-kind exception as the open side, mirrored: `next` here is
      // whatever the walk above stopped on — either `null` (ran out) or the
      // first non-newline sibling. A block one (`[youtube]`, another div, …)
      // already starts on its own line with no `<br>`; measured on
      // `docs/ai/gallery/16-galileo.bbcode`'s `…primera vez ✦[/color][/size]
      // [/centre]\n[youtube]…` seam — the ORIGINAL nested render showed
      // ZERO `<br>` there (osu-web's own `[youtube]` embed is block-level),
      // so inserting one after flattening was the actual corpus-metric
      // regression this whole method exists to close.
      if (!sawVisible && nextExists && !(next && isSelfSeparating(next.kind))) {
        const end = endOf(child)
        sink.push({ start: end, end, text: '\n', ruleId: this.id, priority: this.priority, label })
      }
    }
  }

  /** Rewrites just the numeric value inside a `[size=N]` opening delimiter. */
  private rewriteSizeValue(child: Positioned, source: string, compound: number, sink: PlannedEdit[]): void {
    const open = openRange(child)
    const openText = source.slice(open.start, open.end)
    const eq = openText.indexOf('=')
    if (eq < 0) return
    let valueStart = open.start + eq + 1
    let valueEnd = open.end - 1 // before the closing ']'
    let value = source.slice(valueStart, valueEnd)
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      valueStart += 1
      valueEnd -= 1
    }
    sink.push({
      start: valueStart,
      end: valueEnd,
      text: String(compound),
      ruleId: this.id,
      priority: this.priority,
      label: 'Rewrite compounded [size] for osu!',
    })
  }

  /**
   * Closes `entry.ancestor` right before — and reopens it right after —
   * `entry.topChild`, using the ancestor's own original delimiter bytes.
   * Deduped by `(kind, topChild.start)` so two conflicts under the same
   * direct child only split once.
   */
  private emitSplit(
    kind: string,
    entry: ForceEntry,
    source: string,
    splitBoundaries: Set<string>,
    sink: PlannedEdit[],
  ): void {
    const boundary = entry.topChild
    if (!boundary) return
    const key = `${kind}:${boundary.start}`
    if (splitBoundaries.has(key)) return
    splitBoundaries.add(key)

    const ancestor = entry.ancestor
    if (!hasBothDelimiters(ancestor)) return
    const openTextRange = openRange(ancestor)
    const closeTextRange = closeRange(ancestor)
    const openText = source.slice(openTextRange.start, openTextRange.end)
    const closeText = source.slice(closeTextRange.start, closeTextRange.end)
    const label = 'Split osu!-unsupported nesting'
    const boundaryEnd = endOf(boundary)

    // If `topChild` is ancestor's FIRST (resp. LAST) piece of content — no
    // sibling before (resp. after) it — inserting a close-then-reopen pair
    // there would bracket nothing: an empty `[kind=x][/kind=x]` at the seam.
    // Harmless to a renderer, but it hands a downstream optimizer (see
    // `Fuzzer.test.ts`'s idempotence check) a redundant tag THIS rule just
    // created — a second pass would then need to clean up what the first one
    // left behind, breaking export's own fixed point. Deleting ancestor's own
    // delimiter on that side instead of duplicating it reaches the same
    // fixed point in one pass: when `topChild` is ancestor's ONLY content,
    // BOTH sides collapse and `ancestor` disappears entirely, which is
    // exactly right for `color` (a fully-overridden outer contributes
    // nothing) and for `font_size` too, since `rewriteSizeValue` already
    // rewrote the inner to the compounded value before this call.
    const contentStart = openTextRange.end
    const contentEnd = closeTextRange.start

    if (boundary.start === contentStart) {
      sink.push(deletion(openTextRange, this.id, this.priority, label))
    } else {
      sink.push({ start: boundary.start, end: boundary.start, text: closeText, ruleId: this.id, priority: this.priority, label })
    }

    if (boundaryEnd === contentEnd) {
      sink.push(deletion(closeTextRange, this.id, this.priority, label))
    } else {
      sink.push({ start: boundaryEnd, end: boundaryEnd, text: openText, ruleId: this.id, priority: this.priority, label })
    }
  }
}

/** Convenience: is this a kind the rule ever acts on? Exported for tests. */
export function isFlattenOsuNestingCandidate(kind: string): boolean {
  return IDEMPOTENT_KINDS.has(kind) || VALUE_KINDS.has(kind)
}

/**
 * Every node of `root`, keyed by its absolute start offset — the join key
 * between a `Positioned` (this rule's own green-tree walk) and the RedNode
 * view `fixupBlockNewlines` needs for sibling/child navigation. A real tag's
 * opening `[` is a unique byte position in a well-formed tree (two nodes
 * cannot open at the same offset), so this is safe for every node this rule
 * ever looks up — it never queries a synthetic/zero-width one.
 */
function indexByStart(root: RedNode): Map<number, RedNode> {
  const map = new Map<number, RedNode>()
  const walk = (n: RedNode) => {
    map.set(n.range.start, n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return map
}
