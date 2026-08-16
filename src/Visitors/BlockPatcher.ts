/**
 * DocumentEngine — BlockPatcher
 *
 * Incremental rendering for the HTML preview.
 *
 * The naive path — `renderToHTML(root)` + `morphHTML(container, html)` on every
 * keystroke — re-serializes the ENTIRE document to a string and, worse, makes
 * the browser re-parse that whole string (`template.innerHTML`) even when only
 * one character changed. Profiled on an 18.5 KB document: `morphHTML` ≈ 29.8 ms
 * per keystroke, of which ~27 ms is the full-HTML parse (morph ≈ baseline
 * `innerHTML=`). The parser itself is ~0.5 ms.
 *
 * This module makes the DOM update O(changed block) instead of O(document):
 *
 *   - The document's top-level children are the independent "blocks".
 *   - With stable `data-node-id`s (see `preserveNodeIds`) a block that did not
 *     change renders to the SAME html string, or is even the SAME RedNode
 *     object (red-subtree reuse). Either way we can detect "unchanged" without
 *     touching the DOM.
 *   - Only changed blocks are re-rendered and re-morphed, in place, keyed by
 *     their element.
 *   - Structural edits — a block inserted, removed or reordered (Enter,
 *     backspace between blocks, moving a block in the visual builder) — are
 *     reconciled BY KEY too. The stable ids let us insert/remove/move ONLY the
 *     affected elements, so every untouched block keeps its DOM identity and
 *     runtime state (an open `<details>`, media playback). When the edit
 *     script adds more blocks than the previous document had (a whole new
 *     document patched into the same container, ids regenerated en masse) we
 *     fall back to a full rebuild: one `innerHTML` parse beats N per-block
 *     ones.
 *
 * DOM alignment — "runs": a top-level block may render to an element, to a
 * bare text node (`text`, osu `spacing`/`empty_line` quirks) or to nothing
 * (`''`, an empty text leaf). Two adjacent bare-text blocks are merged into a
 * single text node by the HTML parser, so a block↔node 1:1 pairing would
 * silently misalign after such a merge. The reconciliation therefore works on
 * RUNS: consecutive bare-text blocks form one "text run" that maps to exactly
 * one text node (mirroring the parser), and element blocks are their own runs.
 * The run list is the exact 1:1 mirror of `container.childNodes`.
 */

import { RedNode } from '../Syntax/RedNode'
import { HTMLRenderer } from './HTMLRenderer'
import { morphHTML } from './DOMMorpher'
import type { TextChangeRange } from '../Incremental/ChangeTracker'

export interface PatchBlocksOptions {
  /** Renderer used to serialize blocks. Defaults to a shared HTMLRenderer. */
  renderer?: HTMLRenderer
  /** Called when a block fails to morph; the caller can log it. */
  onError?: (err: unknown) => void
  /**
   * The source range of the edit that produced `rootNode`, if known.
   *
   * Lets the patcher reconcile ONLY the runs overlapping the edit (O(edit))
   * instead of walking the whole document — the difference between ~2ms and
   * ~100ms per keystroke on a 500k-character document. Coordinates are in
   * new-source space with the old end kept separately; see `TextChangeRange`.
   * When omitted, the patcher falls back to the full keyed reconcile — and it
   * also reads the range attached to the root by `DocumentModel`.
   */
  change?: TextChangeRange
  /**
   * Minimum top-level blocks for the windowed path to run; below it the full
   * keyed walk is cheaper than the windowed bookkeeping. Defaults to
   * `MIN_WINDOWED_BLOCKS` (200). Tests force `0` to exercise the windowed
   * path on small documents.
   */
  minWindowedBlocks?: number
}

export interface PatchBlocksStats {
  /** Which path was taken. */
  mode: 'full' | 'blocks'
  /** Number of top-level blocks. */
  total: number
  /** Blocks whose DOM was actually updated (0 = nothing changed). */
  patched: number
  /** True when the windowed (O(edit)) reconcile ran, not the full keyed walk. */
  windowed?: boolean
}

/** How a top-level block renders: an element, bare text, or nothing. */
type RunKind = 'element' | 'text' | 'none'

/** A DOM-level unit: one element block, or consecutive bare-text blocks. */
interface PatchRun {
  /** Stable key — the first block's id. */
  key: string
  kind: 'element' | 'text'
  /** Rendered output of the whole run (concatenated for text runs). */
  html: string
  /** Block keys composing the run (1 for element runs). */
  blockKeys: string[]
  /** The run's first block, for content morphing. */
  node: RedNode
  /**
   * Source offsets spanned by the run (first block's start to last block's
   * end), accumulated from GREEN widths, never from red `range` reads — see
   * `buildRuns`. Used by the windowed reconcile to locate the runs
   * overlapping an edit by source position, which stays correct when the
   * edit inserts or deletes blocks (index-based lookup would land on the
   * wrong runs).
   */
  start: number
  end: number
  /**
   * Block-list indices spanned by the run (`blockTo` exclusive), used by the
   * windowed reconcile to locate runs by CHURN (block identity) instead of
   * source spans — spans would force a lazy-shift materialization on every
   * displaced block (see `RedNode.setStart`).
   */
  blockFrom: number
  blockTo: number
}

interface PatchCache {
  /** Ordered block keys from the previous patch. */
  lastKeys: string[]
  /**
   * Accumulated set of every block key ever patched into this container.
   *
   * Used by the `added` heuristic in `patchBlocksInto` WITHOUT rebuilding a
   * Set from `lastKeys` on every keystroke. Growing it (new keys get added as
   * they appear) keeps the guard O(keys) but with a plain `has` per block
   * (~µs) instead of an 80k-entry Set construction (~80ms on the big doc).
   * It is deliberately cumulative: a key that disappears from the doc stays
   * in the set, which is exactly right — the heuristic only asks "was this
   * key ever here?" for the previous document, and stale-but-true entries
   * only ever make `added` smaller, never larger. It is rebuilt when it
   * grows past 2× the live document (see the prune in `reconcileKeyed`).
   */
  lastKeySet: Set<string>
  /** Last RedNode per block key — reference equality skips unchanged blocks. */
  lastNode: Map<string, RedNode>
  /** Last rendered html per block key. */
  lastHtml: Map<string, string>
  /** Last render classification per block key. */
  lastClass: Map<string, RunKind>
  /** Ordered runs from the previous patch — the 1:1 mirror of childNodes. */
  lastRuns: PatchRun[]
}

const caches = new WeakMap<HTMLElement, PatchCache>()

const defaultRenderer = new HTMLRenderer()

function getCache(container: HTMLElement): PatchCache {
  let cache = caches.get(container)
  if (!cache) {
    cache = {
      lastKeys: [],
      lastKeySet: new Set(),
      lastNode: new Map(),
      lastHtml: new Map(),
      lastClass: new Map(),
      lastRuns: [],
    }
    caches.set(container, cache)
  }
  return cache
}

/** Stable key for a top-level block: its node id, or a positional one when id-less. */
function blockKey(node: RedNode, index: number): string {
  return node.id ?? `__block_${index}`
}

/** Build a DOM node from an HTML fragment (first child), decoding entities. */
function nodeFromHtml(html: string): Node {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.content.firstChild as Node
}

/**
 * Classify a block's rendered output. Bare text starts with a non-`<` char
 * (escaped entities never emit `<`), elements start with `<`, and `''` emits
 * nothing. The HTML parser merges adjacent bare-text nodes, which is exactly
 * why they are grouped into runs.
 */
function classifyHtml(html: string): RunKind {
  if (html === '') return 'none'
  return html.charCodeAt(0) === 60 /* < */ ? 'element' : 'text'
}

/**
 * Block kinds whose rendered element wraps its children in a renderer-added
 * structure (not present in the red tree), so morphing the element's inner
 * content via `renderChildren` would destroy it:
 *
 *   - `code` → `<pre><code>…</code></pre>` (the `<code>` is added by the
 *     renderer; `renderChildren` only yields the raw text)
 *   - `svg` → `<svg><foreignObject><div>…</div></foreignObject></svg>`
 *   - `imagemap` → a container with an `<img>` and clickable areas
 *
 * These must be replaced outright when their content changes — they carry no
 * runtime state worth preserving, so replacement is free.
 */
/** Can the element's inner content be safely updated via `renderChildren`? */
function canMorphInPlace(node: RedNode): boolean {
  return node.kind !== 'code' && node.kind !== 'svg' && node.kind !== 'imagemap'
}

/**
 * First tag of a rendered block html (`<h2 …>` → `H2`), or null when the
 * output is bare text or empty (never passed here — those go the replace
 * path). The tag check exists because `morphHTML` only patches CONTENT: it
 * cannot change the element's tag. When a block's kind changes in place (an
 * `empty_line` morphing into a `heading` at the same top-level slot keeps the
 * same node id via positional id-preservation), morphing the old `<br>` with
 * the heading's inner text silently drops the element — the heading vanishes.
 * Comparing tags (O(1)) sends those to the replace path instead.
 */
function renderedTag(html: string): string | null {
  if (html.charCodeAt(0) !== 60 /* < */) return null
  const m = /^<([a-zA-Z][\w-]*)/.exec(html)
  return m ? m[1].toUpperCase() : null
}

/**
 * Decide whether a run's element can be morphed in place (content-only) or
 * must be replaced outright. Shared by the full and windowed reconciles so a
 * tag change (kind change at a stable slot) behaves identically on both paths.
 */
function shouldMorphInPlace(
  element: Element,
  run: PatchRun,
): boolean {
  return (
    run.kind === 'element' &&
    !!run.node.id &&
    run.node.children.length > 0 &&
    canMorphInPlace(run.node) &&
    renderedTag(run.html) === element.tagName
  )
}

/**
 * Group the block list into runs, using the per-block render info.
 *
 * Run spans are accumulated from GREEN widths, never from red `range` reads:
 * a mid-document edit displaces every block after it, and each displaced-but-
 * unchanged block carries a pending lazy shift (see `RedNode.setStart`) that
 * a range read would materialize — walking the whole displaced tail per
 * keystroke, the exact cost the lazy shift was introduced to remove. Green
 * widths are position-free and always current, and the partition invariant (a
 * block's accumulated width equals its materialized `range.start`; verified
 * on the 500 KB fixture across every edit shape) makes the accumulation exact.
 */
function buildRuns(
  blocks: RedNode[],
  keys: string[],
  getHtml: (node: RedNode, key: string) => { html: string; kind: RunKind },
  baseStart: number,
): PatchRun[] {
  const runs: PatchRun[] = []
  let textRun: PatchRun | null = null
  let offset = baseStart
  for (let i = 0; i < blocks.length; i++) {
    const node = blocks[i]
    const key = keys[i]
    const start = offset
    offset += node.green.width
    const { html, kind } = getHtml(node, key)
    if (kind === 'none') continue
    if (kind === 'element') {
      textRun = null
      runs.push({ key, kind, html, blockKeys: [key], node, start, end: offset, blockFrom: i, blockTo: i + 1 })
    } else if (textRun) {
      textRun.html += html
      textRun.blockKeys.push(key)
      textRun.end = offset
      textRun.blockTo = i + 1
    } else {
      textRun = { key, kind, html, blockKeys: [key], node, start, end: offset, blockFrom: i, blockTo: i + 1 }
      runs.push(textRun)
    }
  }
  return runs
}

/** Full rebuild of the container from the whole tree. */
function fullRebuild(
  container: HTMLElement,
  rootNode: RedNode,
  renderer: HTMLRenderer,
  cache: PatchCache,
): PatchBlocksStats {
  container.innerHTML = renderer.render(rootNode)
  const blocks = rootNode.children
  const keys: string[] = []
  cache.lastHtml.clear()
  cache.lastNode.clear()
  cache.lastClass.clear()
  cache.lastKeySet = new Set()
  for (let i = 0; i < blocks.length; i++) {
    const node = blocks[i]
    const key = blockKey(node, i)
    keys.push(key)
    cache.lastKeySet.add(key)
    const html = renderer.render(node)
    cache.lastHtml.set(key, html)
    cache.lastNode.set(key, node)
    cache.lastClass.set(key, classifyHtml(html))
  }
  cache.lastKeys = keys
  cache.lastRuns = buildRuns(blocks, keys, (node, key) => ({
    html: cache.lastHtml.get(key)!,
    kind: cache.lastClass.get(key)!,
  }), rootNode.range.start + rootNode.green.leadingWidth)
  return { mode: 'full', total: blocks.length, patched: blocks.length }
}

/**
 * Reconcile `container`'s children against `rootNode`'s top-level blocks by
 * stable key, over the RUN lists (which mirror the DOM 1:1 — see module docs).
 *
 * Surviving runs keep the SAME DOM node (moved in place when their position
 * shifted, so identity and runtime state survive); new runs are inserted;
 * orphans are removed at the tail. Content changes morph element runs in place
 * and swap the text node of text runs.
 *
 * Returns what was done so callers/tests can assert the fast path fired.
 */
function reconcileKeyed(
  container: HTMLElement,
  rootNode: RedNode,
  keys: string[],
  renderer: HTMLRenderer,
  cache: PatchCache,
  options: PatchBlocksOptions,
): PatchBlocksStats {
  const oldRuns = cache.lastRuns
  const oldRunByKey = new Map(oldRuns.map((r) => [r.key, r]))

  // Old DOM ↔ run-key map (1:1 by construction — runs mirror childNodes).
  const oldByKey = new Map<string, Node>()
  for (let i = 0; i < oldRuns.length; i++) {
    const child = container.childNodes[i]
    if (child) oldByKey.set(oldRuns[i].key, child)
  }

  // ── Pass 1 (no DOM writes): compute the new runs. Reference-equal blocks
  // reuse their cached html/classification (no render); changed blocks render.
  // ── Pass 2: reconcile the DOM against the new run order.
  // Ambos passes comparten el fallback: si el render de un bloque o el morph
  // lanzan, se notifica vía onError y se reconstruye completo (el contrato
  // histórico de patchBlocksInto es nunca lanzar hacia el llamante).
  const blocks = rootNode.children
  let runs: PatchRun[]
  let patched = 0
  try {
    runs = buildRuns(blocks, keys, (node, key) => {
      if (cache.lastNode.get(key) === node) {
        return { html: cache.lastHtml.get(key) ?? '', kind: cache.lastClass.get(key) ?? 'none' }
      }
      const html = renderer.render(node)
      const kind = classifyHtml(html)
      cache.lastHtml.set(key, html)
      cache.lastNode.set(key, node)
      cache.lastClass.set(key, kind)
      return { html, kind }
    }, rootNode.range.start + rootNode.green.leadingWidth)

    // ── Pre-pass: drop DOM nodes whose run no longer exists. ──────────────
    // A run whose key vanished (its block was replaced by a new id — e.g.
    // typing at the START of the document re-keys the first block) must leave
    // the DOM BEFORE the reconcile loop. The old algorithm only removed it at
    // the tail: every surviving run then saw `element !== anchor` (the corpse
    // sat at the front) and got moved one slot — 79997 `insertBefore` calls on
    // an 80k-child container ≈ 14s. Removing orphans first means a pure shift
    // (insert/delete anywhere) moves ZERO nodes.
    const newKeySet = new Set<string>()
    for (let i = 0; i < runs.length; i++) newKeySet.add(runs[i].key)
    // Walk the OLD runs; any whose key is gone is an orphan. `childNodes` is a
    // live list, so collect the nodes first, then remove them (the survivors
    // keep their identity — this is what preserves open `<details>`).
    const orphanNodes: Node[] = []
    for (let i = 0; i < oldRuns.length; i++) {
      if (!newKeySet.has(oldRuns[i].key)) {
        const node = container.childNodes[i]
        if (node) orphanNodes.push(node)
      }
    }
    for (let i = 0; i < orphanNodes.length; i++) {
      container.removeChild(orphanNodes[i])
    }

    // ── Pass 2: reconcile the DOM against the new run order. ──────────────
    // `anchor` is the next DOM node the new order expects; walking it with
    // `nextSibling` (not `childNodes[domIndex]`) means a node already in place
    // is never touched, and a freshly inserted node does not shift the anchor
    // of every run after it.
    let anchor: Node | null = container.firstChild
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]
      const prev = oldRunByKey.get(run.key)
      const element = oldByKey.get(run.key)

      if (!element) {
        // Brand-new run (block insertion, id churn, text-run split).
        container.insertBefore(nodeFromHtml(run.html), anchor)
        patched++
        continue
      }

      if (element !== anchor) {
        // Surviving run that moved (a genuine reorder): move the SAME node —
        // its runtime state survives. A pure shift never lands here: the
        // orphan pre-pass already removed the node that used to sit in front.
        container.insertBefore(element, anchor)
      } else {
        anchor = anchor!.nextSibling
      }

      // Unchanged content (same composition, same rendered output).
      if (prev && prev.blockKeys.length === run.blockKeys.length && prev.html === run.html) {
        continue
      }

      if (element.nodeType === 1 && shouldMorphInPlace(element as Element, run)) {
        // Element with children and a matching tag: morph its inner content in
        // place, preserving the element (and runtime state like an open
        // `<details>`). Tag mismatch (kind change at a stable slot) or wrapper
        // kinds (code/svg/imagemap) go the replace path below.
        morphHTML(element as HTMLElement, renderer.renderChildren(run.node))
      } else {
        // Text run, an element leaf (img/video/audio/`<br>`), a kind whose tag
        // changed, or a wrapper renderer kind: the node's own structure must
        // change — replace outright.
        container.replaceChild(nodeFromHtml(run.html), element)
      }
      patched++
    }
  } catch (err) {
    options.onError?.(err)
    return fullRebuild(container, rootNode, renderer, cache)
  }

  // Safety net: with orphans removed up front and every surviving node walked
  // exactly once by the loop, nothing should remain — but if a run rendered to
  // a different node count than last time (parser merge edge), drop the tail.
  while (container.childNodes.length > runs.length) {
    container.removeChild(container.childNodes[runs.length])
  }

  // Prune the cache: removed blocks leave dead entries, and node ids are never
  // reused, so without pruning the maps would grow unbounded between rebuilds.
  if (cache.lastNode.size !== keys.length) {
    const live = new Set(keys)
    for (const k of Array.from(cache.lastNode.keys())) {
      if (!live.has(k)) {
        cache.lastNode.delete(k)
        cache.lastHtml.delete(k)
        cache.lastClass.delete(k)
      }
    }
  }
  // The cumulative key set stays hot while the document churns ids (typing at
  // the start minted a fresh id per keystroke); rebuild it once it dwarfs the
  // live document so the `added` guard stays cheap forever.
  if (cache.lastKeySet.size > keys.length * 2) {
    cache.lastKeySet = new Set(keys)
  }

  cache.lastKeys = keys
  cache.lastRuns = runs
  return { mode: 'blocks', total: keys.length, patched }
}

/**
 * Below this many top-level blocks, skip the windowed path entirely.
 *
 * The windowed bookkeeping (churn scan, key/reference unions, scoped maps,
 * anchor walk) costs a fixed ~2-3 ms; the full keyed walk costs O(blocks).
 * Measured crossover on this module's shape (100 to 4000 blocks, typing and
 * mid-document edits on the real 500 KB fixture): the windowed path wins at
 * EVERY size — 2× on the 457-block fixture and still ahead at 4000. The
 * earlier "crossover well above 2k" claim predates the lazy-offset work,
 * which removed the per-block range reads the windowed path used to pay
 * (the walk now locates the window by churn and reads nothing). The
 * threshold sits at 200 to skip the bookkeeping only for tiny documents
 * where a single innerHTML parse beats either reconcile.
 */
const MIN_WINDOWED_BLOCKS = 200

/**
 * Windowed reconciliation — the 500k-character path.
 *
 * The full `reconcileKeyed` walks every run of the document, which at 100k+
 * top-level blocks costs tens of milliseconds per keystroke even when only a
 * handful of blocks changed. With a `change` range (the model knows exactly
 * what it edited) plus the parser's red-subtree reuse (blocks the edit did not
 * touch are the SAME RedNode objects), this path locates the edited region by
 * source offset and reconciles ONLY the runs overlapping it:
 *
 *   - the NEW runs overlapping [start, end)  (new coordinates), and
 *   - the OLD runs overlapping [start, endOld) (OLD coordinates — `endOld` is
 *     what keeps this correct when the edit inserted or deleted blocks, where
 *     index-based mapping would land on the wrong old runs).
 *
 * Everything outside the window is guaranteed unchanged by the incremental
 * parser contract (green-sharing → red reuse → reference identity), so its DOM
 * nodes are left completely untouched — a pure shift now costs O(window)
 * instead of O(document). The window is still reconciled by stable key with
 * the same morph/insert/remove semantics as the full path, so runtime state
 * (an open `<details>`) inside the edited region survives.
 *
 * Returns the stats, or `null` when the caller should fall back to the full
 * reconcile: no reliable window (whole-document edit), the tree churned
 * outside the window (a rebuild where the parser contract does not hold), or
 * the document is small enough that the full walk is already cheaper than the
 * windowed bookkeeping (see `MIN_WINDOWED_BLOCKS`).
 */
function reconcileWindowed(
  container: HTMLElement,
  rootNode: RedNode,
  change: TextChangeRange,
  renderer: HTMLRenderer,
  cache: PatchCache,
  options: PatchBlocksOptions,
): PatchBlocksStats | null {
  const blocks = rootNode.children
  const n = blocks.length
  if (n === 0) return null
  const minBlocks = options.minWindowedBlocks ?? MIN_WINDOWED_BLOCKS
  if (n < minBlocks) return null
  const __bail = (): null => null

  // ── Block window (new coordinates), derived from the CHURN. ────────────
  // The incremental parser re-keys every block inside its reparse window
  // (roughly [first-1, last+2], plus a leftward walk over newline runs) and
  // leaves everything else reference-identical. So the blocks the edit really
  // touched are exactly the ones that are NOT reference-identical to the
  // cache. Walk outward from the churn until the blocks are identical again:
  // the resulting window is exact by construction — no margin guessing, and
  // it stays small because a normal edit churns only the parser's window.
  //
  // The window is seeded by CHURN, not by source span: locating it through
  // ranges reads `blocks[i].range` for every block up to the edit, and each
  // read materializes the pending lazy shift of every displaced-but-unchanged
  // block (see `RedNode.setStart`) — the subtree walk the lazy shift was
  // meant to eliminate, moved from buildRed to here. By the partition
  // invariant the edit always lands inside some churned block, so the churn
  // scan finds the same window and reads nothing. Keyed with `blockKey` (the
  // same criterion the cache uses) — a bare `.id` would silently treat every
  // block as churned if an id were ever falsy, bailing to the full path on
  // every keystroke.
  const churned = (b: RedNode, i: number): boolean =>
    cache.lastNode.get(blockKey(b, i)) !== b
  let firstChanged = n
  for (let i = 0; i < n; i++) {
    if (churned(blocks[i], i)) {
      firstChanged = i
      break
    }
  }
  let lastChanged = -1
  for (let i = n - 1; i >= 0; i--) {
    if (churned(blocks[i], i)) {
      lastChanged = i
      break
    }
  }
  // Defensive pin when nothing churned (an edit with no observable effect, or
  // a first patch where the cache was still empty): `winEnd` would index
  // `blocks[n]` (OOB crash — this code sits outside the try/catch, so it would
  // escape to the caller). Pin the window to the tail blocks; the churn-walk
  // below widens it over the real edited region.
  if (firstChanged === n) {
    firstChanged = Math.max(0, n - 1)
    lastChanged = Math.max(lastChanged, firstChanged)
  }
  if (lastChanged < firstChanged) lastChanged = firstChanged
  let winStart = firstChanged
  let winEnd = lastChanged + 1
  while (winStart > 0 && churned(blocks[winStart - 1], winStart - 1)) winStart--
  while (winEnd < n && churned(blocks[winEnd], winEnd)) winEnd++

  // A window covering most of the document (paste / load / whole-doc edit — a
  // whole-tree rebuild churns everything) is better served by the single-pass
  // full reconcile.
  if (winEnd - winStart > n / 2) return __bail()

  const keys = blocks.map((b, i) => blockKey(b, i))

  // ── Build the new runs. Reference-identical blocks reuse cached html, so
  // this is O(n) cheap map lookups; only window blocks render.
  let runs: PatchRun[]
  try {
    runs = buildRuns(blocks, keys, (node, key) => {
      if (cache.lastNode.get(key) === node) {
        return { html: cache.lastHtml.get(key) ?? '', kind: cache.lastClass.get(key) ?? 'none' }
      }
      const html = renderer.render(node)
      const kind = classifyHtml(html)
      cache.lastHtml.set(key, html)
      cache.lastNode.set(key, node)
      cache.lastClass.set(key, kind)
      return { html, kind }
    }, rootNode.range.start + rootNode.green.leadingWidth)
  } catch (err) {
    options.onError?.(err)
    return null
  }

  const oldRuns = cache.lastRuns

  const DBG = (globalThis as { __BP_DEBUG__?: boolean }).__BP_DEBUG__ === true
  const dbg = (...a: unknown[]): void => {
    if (DBG) console.log('[BP]', ...a)
  }


  // ── Old window (OLD coordinates). ──────────────────────────────────────
  // Walk the old runs (lockstep with the DOM — a 1:1 mirror) until we pass
  // the edited region. Using `endOld` (old coordinates) keeps the boundary
  // correct under insertions/deletions: a deleted region spans old runs the
  // new tree no longer has, and only the old span can see them.
  let foundStart = false
  let oldFrom = 0
  let oldTo = oldRuns.length
  for (let i = 0; i < oldRuns.length; i++) {
    const run = oldRuns[i]
    if (!foundStart && run.end >= change.start) {
      foundStart = true
      oldFrom = i
    }
    if (run.start >= change.endOld) {
      oldTo = i
      break
    }
  }
  if (!foundStart) oldFrom = 0
  // Margins: the previous run (run-boundary merges) and the parser's widened
  // tail (last+2 blocks — re-parsed, so their old nodes are orphans).
  if (oldFrom > 0) oldFrom -= 1
  oldTo = Math.min(oldRuns.length, oldTo + 2)

  // ── New window in run space: the runs overlapping the churn block window. ──
  // Runs are the DOM unit and can straddle block boundaries (text runs), so
  // slice by BLOCK INDEX — `winStart`/`winEnd` are block positions and every
  // run's `blockFrom`/`blockTo` are block positions too, so the overlap test
  // needs no range reads (a span comparison would materialize the displaced
  // blocks' lazy shifts again). One run of margin on each side covers
  // boundary merges/splits.
  let newFrom = runs.length
  let newTo = runs.length
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    if (newFrom === runs.length && run.blockTo > winStart) newFrom = i
    if (run.blockFrom >= winEnd) {
      newTo = i
      break
    }
  }
  if (newFrom === runs.length) newFrom = Math.max(0, runs.length - 1)
  if (newFrom > 0) newFrom -= 1
  newTo = Math.min(runs.length, newTo + 2)

  // ── Align: both windows must cover the SAME run region. ────────────────
  // Runs outside the region are identical in both trees (same keys, same
  // order), so the two span computations must agree — the parser's reparse
  // window can re-key runs just past the edit on either side, and the old
  // side can span a deleted region the new tree no longer has. If one window
  // covered a run the other did not, the run would be matched on one side and
  // treated as brand-new on the other — duplicating its node. Union both
  // ranges; the extra coverage is harmless (unchanged runs match by key and
  // cost no DOM writes).
  const from = Math.min(newFrom, oldFrom)
  const to = Math.max(newTo, oldTo)

  // ── Scoped keyed reconcile over the window ─────────────────────────────
  const oldToClamped = Math.min(oldRuns.length, to)

  // Key-set union, not just index union: a prepend/append re-keys the churned
  // blocks (they get brand-new ids at the same window positions) while
  // reference-identical runs just outside the reparse window (the quote below)
  // KEEP their keys — and land at a different index in the two run lists. The
  // index union then slices one list without the other's surviving run, and
  // the orphan pre-pass would remove it from the DOM even though it still
  // exists in the new tree. Expand the NEW window to cover every old-window
  // key that survived (identical ⇒ the walk costs nothing), both ends, and
  // anchor the DOM at the earliest start of either window.
  const oldWinRuns = oldRuns.slice(from, oldToClamped)
  const oldWinKeySet = new Set<string>()
  for (let i = 0; i < oldWinRuns.length; i++) oldWinKeySet.add(oldWinRuns[i].key)
  let toNew = Math.min(runs.length, to)
  while (toNew < runs.length && oldWinKeySet.has(runs[toNew].key)) toNew++
  let fromNew = from
  while (fromNew > 0 && oldWinKeySet.has(runs[fromNew - 1].key)) fromNew--
  const newWinRuns = runs.slice(fromNew, toNew)
  // Old runs may begin before the index window too (backward expansion): the
  // DOM anchor and old node list must start at the same earliest index.
  const oldWinFrom = Math.min(from, fromNew)

  // Reference-identity union: a block DELETED before a surviving run re-keys
  // every block after it (the quote went n732 → n762 above), so the key-set
  // union cannot see that the old n732 run and the new n762 run are the SAME
  // RedNode object. The red-reuse contract guarantees it, so widen the OLD
  // window to include runs whose NODE lives on in the new window — the walk
  // then MOVES the old node in place instead of inserting a duplicate.
  //
  // The twin is NOT always near the window edge. The reparse window can be
  // large (a 20 KB mid-document delete re-keys a whole run of siblings), and
  // every surviving run after the edit is then displaced by the number of
  // deleted runs — measured: delete-20k left 24 twins in oldRuns[251..274]
  // while the fixed band stopped at oldToClamped + 8 = 251. A bounded band
  // misses them, the walk inserts duplicates, and the DOM ends up with
  // orphaned blocks (452 childNodes vs 428 on the real 500 KB fixture).
  //
  // Fix: extend the band over the old runs whose NODE is present in the new
  // window — those are exactly the re-keyed survivors the walk must move, not
  // orphan (a run whose node is NOT in the new window stops the scan: it is
  // a genuine structural change, where removing + inserting is right). Both
  // sides, so a large insert re-keys survivors backward too.
  const newByNode = new Map<RedNode, PatchRun>()
  for (let i = 0; i < newWinRuns.length; i++) {
    if (!newByNode.has(newWinRuns[i].node)) newByNode.set(newWinRuns[i].node, newWinRuns[i])
  }
  let oldWinTo = oldToClamped
  let oldWinFrom2 = oldWinFrom
  let bandTo = Math.min(oldRuns.length, oldToClamped + 8)
  // Extend the tail of the identity band while the old runs are twins of the
  // new window. `oldToClamped` is where the old window ended by KEY; survivors
  // re-keyed by a big edit live right after it, each one reference-identical
  // to a new-window run, so scanning until the first non-twin covers exactly
  // the displaced tail with no arbitrary margin to guess. Cost is bounded by
  // the displaced tail itself — normal keystrokes stop after ~0 runs because
  // runs beyond the window keep their keys and are matched by key, not node.
  while (bandTo < oldRuns.length && newByNode.has(oldRuns[bandTo].node)) bandTo++
  // Same for the head: a large insertion re-keys the runs BEFORE the edit
  // (their keys shift backward), so walk left while old runs are twins too.
  let bandFromFinal = Math.max(0, oldWinFrom - 3)
  while (bandFromFinal > 0 && newByNode.has(oldRuns[bandFromFinal - 1].node)) bandFromFinal--
  const oldNodeToIdx = new Map<RedNode, number>()
  for (let i = bandFromFinal; i < bandTo; i++) {
    if (!oldNodeToIdx.has(oldRuns[i].node)) oldNodeToIdx.set(oldRuns[i].node, i)
  }
  for (let i = 0; i < newWinRuns.length; i++) {
    const run = newWinRuns[i]
    if (oldWinKeySet.has(run.key)) continue
    const oldIdx = oldNodeToIdx.get(run.node)
    if (oldIdx === undefined) continue
    if (oldIdx < oldWinFrom2) oldWinFrom2 = oldIdx
    if (oldIdx + 1 > oldWinTo) oldWinTo = oldIdx + 1
  }
  const oldWinRunsFinal = oldRuns.slice(oldWinFrom2, oldWinTo)
  const newWinRunsFinal = newWinRuns

  dbg('change', { start: change.start, end: change.end, endOld: change.endOld })
  dbg('oldWin', oldWinFrom2, oldWinTo, 'keys', oldWinRunsFinal.map((r) => `${r.key}:${r.node.kind}`).slice(0, 40))
  dbg('newWin', fromNew, toNew, 'keys', newWinRunsFinal.map((r) => `${r.key}:${r.node.kind}`).slice(0, 40))
  dbg('newWinKeySet', [...newWinRunsFinal.map((r) => r.key).slice(0, 40)])

  // DOM anchor at the window start, and the window's old nodes.
  let anchorNode: Node | null = container.firstChild
  for (let k = 0; k < oldWinFrom2; k++) anchorNode = anchorNode?.nextSibling ?? null
  const oldWinNodes: Node[] = []
  let node: Node | null = anchorNode
  for (let i = oldWinFrom2; i < oldWinTo; i++) {
    if (node) oldWinNodes.push(node)
    node = node?.nextSibling ?? null
  }
  const afterWindow = node

  const oldRunByKey = new Map<string, PatchRun>()
  const oldRunByNode = new Map<RedNode, PatchRun>()
  for (let i = 0; i < oldWinRunsFinal.length; i++) {
    const old = oldWinRunsFinal[i]
    oldRunByKey.set(old.key, old)
    // Re-keyed survivors: the walk may find the new run by NODE identity
    // instead of key (a deleted/inserted block shifted every id after it).
    if (!oldRunByNode.has(old.node)) oldRunByNode.set(old.node, old)
  }

  const oldByKey = new Map<string, Node>()
  const oldByNode = new Map<RedNode, Node>()
  for (let i = 0; i < oldWinRunsFinal.length; i++) {
    const el = oldWinNodes[i]
    if (!el) continue
    oldByKey.set(oldWinRunsFinal[i].key, el)
    if (!oldByNode.has(oldWinRunsFinal[i].node)) oldByNode.set(oldWinRunsFinal[i].node, el)
  }

  let patched = 0
  try {
    // Orphan pre-pass (scoped): drop old-window nodes whose run key no longer
    // exists BEFORE the anchor walk, so a pure shift moves zero nodes. A node
    // whose RedNode lives on (re-keyed) is NOT an orphan — it is moved by the
    // walk. The removed set doubles as the survival test for the anchor below
    // — a node can be "in" the container yet report `isConnected === false`
    // when the container itself is detached (tests, hidden panels), so
    // connection state is tracked explicitly, never via `Node.isConnected`.
    const newKeySet = new Set<string>()
    for (let i = 0; i < newWinRunsFinal.length; i++) newKeySet.add(newWinRunsFinal[i].key)
    const removed = new Set<Node>()
    for (let i = 0; i < oldWinRunsFinal.length; i++) {
      const k = oldWinRunsFinal[i].key
      if (newKeySet.has(k) || newByNode.has(oldWinRunsFinal[i].node)) continue
      const el = oldWinNodes[i]
      dbg('orphan?', k, oldWinRunsFinal[i].node.kind, 'el=', el ? (el.nodeType === 1 ? (el as Element).tagName : `text:'${String((el as Text).data ?? '').slice(0, 20)}'`) : 'null')
      if (el && !removed.has(el)) {
        removed.add(el)
        container.removeChild(el)
        dbg('  REMOVED', k)
      }
    }

    // Anchor: the first surviving node of the old window (insertions go
    // before it), or the suffix when every old-window node was orphaned.
    let walkAnchor: Node | null = null
    for (let i = 0; i < oldWinRunsFinal.length; i++) {
      const el = oldWinNodes[i]
      if (el && !removed.has(el)) {
        walkAnchor = el
        break
      }
    }
    if (walkAnchor === null) walkAnchor = afterWindow

    // Anchor walk over the new window runs — same semantics as the full path.
    let cursor = walkAnchor
    for (let i = 0; i < newWinRunsFinal.length; i++) {
      const run = newWinRunsFinal[i]
      // By key first (same id), then by node identity (re-keyed survivor).
      const prev = oldRunByKey.get(run.key) ?? oldRunByNode.get(run.node)
      const element = oldByKey.get(run.key) ?? oldByNode.get(run.node)

      dbg('WALK', run.key, run.node.kind, 'element=', element ? (element.nodeType === 1 ? (element as Element).tagName : 'text') : 'NEW', 'cursor=', cursor ? (cursor.nodeType === 1 ? (cursor as Element).tagName : 'text') : 'null')

      if (!element) {
        container.insertBefore(nodeFromHtml(run.html), cursor)
        patched++
        continue
      }

      if (element !== cursor) {
        container.insertBefore(element, cursor)
      } else {
        cursor = cursor?.nextSibling ?? null
      }

      if (prev && prev.blockKeys.length === run.blockKeys.length && prev.html === run.html) {
        continue
      }

      if (element.nodeType === 1 && shouldMorphInPlace(element as Element, run)) {
        morphHTML(element as HTMLElement, renderer.renderChildren(run.node))
      } else {
        container.replaceChild(nodeFromHtml(run.html), element)
      }
      patched++
    }

    // Safety net (parser-merge edges): the window region must end exactly at
    // the first suffix node. Leftovers of runs that rendered to a different
    // node count sit between the walk's end and the suffix — drop them.
    let tail = cursor
    dbg('tail-safety: cursor=', cursor ? (cursor.nodeType === 1 ? (cursor as Element).tagName : `text:'${String((cursor as Text).data ?? '').slice(0, 15)}'`) : 'null', 'afterWindow=', afterWindow ? (afterWindow.nodeType === 1 ? (afterWindow as Element).tagName : `text:'${String((afterWindow as Text).data ?? '').slice(0, 15)}'`) : 'null')
    let tailCount = 0
    while (tail !== afterWindow) {
      if (!tail) break
      const next = tail.nextSibling
      container.removeChild(tail)
      tailCount++
      tail = next
    }
    dbg('tail-safety: removed', tailCount)
  } catch (err) {
    options.onError?.(err)
    return null
  }

  // ── Cache ──────────────────────────────────────────────────────────────
  // Only window keys can have died (everything outside is reference-identical
  // and already cached), so prune just those.
  const newWinKeySet = new Set(newWinRunsFinal.map((r) => r.key))
  for (let i = 0; i < oldWinRunsFinal.length; i++) {
    const k = oldWinRunsFinal[i].key
    if (!newWinKeySet.has(k)) {
      cache.lastNode.delete(k)
      cache.lastHtml.delete(k)
      cache.lastClass.delete(k)
    }
  }
  // Keep the cumulative key set hot for the full path's `added` guard, and
  // rebuild it once it dwarfs the live document (same policy as the full path).
  for (let i = 0; i < newWinRunsFinal.length; i++) cache.lastKeySet.add(newWinRunsFinal[i].key)
  if (cache.lastKeySet.size > keys.length * 2) {
    cache.lastKeySet = new Set(keys)
  }

  cache.lastKeys = keys
  cache.lastRuns = runs
  return { mode: 'blocks', total: keys.length, patched, windowed: true }
}

/**
 * Reconcile `container`'s children against `rootNode`'s top-level blocks.
 *
 * Inline edits morph only the changed block; structural edits (insert, remove,
 * reorder) are reconciled by key so untouched blocks keep their DOM identity.
 * Returns what was done so callers/tests can assert the fast path fired.
 */
export function patchBlocksInto(
  container: HTMLElement,
  rootNode: RedNode | null,
  options: PatchBlocksOptions = {},
): PatchBlocksStats {
  const renderer = options.renderer ?? defaultRenderer
  const cache = getCache(container)

  if (!rootNode) {
    container.innerHTML = ''
    cache.lastHtml.clear()
    cache.lastNode.clear()
    cache.lastClass.clear()
    cache.lastKeys = []
    cache.lastKeySet = new Set()
    cache.lastRuns = []
    return { mode: 'full', total: 0, patched: 0 }
  }

  // DOM out of sync with the cache (a host replaced the innerHTML behind our
  // back, or a run rendered to a different node count than last time).
  if (container.childNodes.length !== cache.lastRuns.length) {
    return fullRebuild(container, rootNode, renderer, cache)
  }

  // The edited region, when the model told us (explicitly, or attached to the
  // root by `DocumentModel`). Windowed reconcile first — it falls back below
  // when the edit is too big or the tree churned outside the window.
  const change =
    options.change ??
    (rootNode as RedNode & { __changeRange?: TextChangeRange | null }).__changeRange ??
    undefined
  if (change) {
    const windowed = reconcileWindowed(container, rootNode, change, renderer, cache, options)
    if (windowed) return windowed
  }

  const blocks = rootNode.children
  const keys = blocks.map((n, i) => blockKey(n, i))

  // Edit script bigger than the previous document (a whole new document in the
  // same container, ids regenerated en masse): one full innerHTML parse beats
  // inserting every block individually. Uses the cumulative key set instead of
  // building a fresh Set from `lastKeys` on every keystroke (see PatchCache).
  const oldSet = cache.lastKeySet
  let added = 0
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (!oldSet.has(k)) added++
    oldSet.add(k)
  }
  if (added >= cache.lastKeys.length) {
    return fullRebuild(container, rootNode, renderer, cache)
  }

  return reconcileKeyed(container, rootNode, keys, renderer, cache, options)
}
