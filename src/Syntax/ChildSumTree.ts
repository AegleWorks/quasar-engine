/**
 * Persistent B-Tree / SumTree for wide syntax node child lists (Zed-style).
 *
 * When a `GreenNode` / `RedNode` (typically the `document` root on multi-MB
 * files) holds hundreds of thousands of children, copying a flat `Array` on
 * every keystroke costs O(N) time and memory (~15 ms at 10M chars / 177k
 * blocks). A persistent B-Tree of branching factor `B = 64` (height 3 up to
 * 262,144 children) reduces:
 *
 *   - offset lookup (`findAtOffset`)       : O(N) → O(log N) (~15 ops)
 *   - index lookup (`at`, `offsetOfIndex`) : O(N) → O(log N) (~3–64 ops)
 *   - structural splice (`splice`)         : O(N) → O(log N) (~190 ptrs copied)
 *   - Red tree reconciliation              : O(N) → O(log N) (untouched subtrees
 *     shared by reference; exact offsets derived from Green widths on read)
 *
 * Small nodes (`count < SUM_TREE_THRESHOLD`) continue using plain JS arrays
 * with zero tree overhead.
 */

import type { GreenNode } from './GreenNode'
import type { RedNode } from './RedNode'

/** Minimum child count to promote a node's children to a persistent SumTree. */
export const SUM_TREE_THRESHOLD = 256

/** Target branching factor / leaf size (power of 2 for fast division). */
const LEAF_MAX = 64
const LEAF_MIN = 24
const BRANCH_MAX = 64
const BRANCH_MIN = 24

// ─── Green SumTree ──────────────────────────────────────────────────────────

export interface GreenSumLeaf {
  readonly height: 0
  readonly count: number
  readonly width: number
  readonly items: readonly GreenNode[]
}

export interface GreenSumBranch {
  readonly height: number // >= 1
  readonly count: number
  readonly width: number
  readonly children: readonly GreenSumNode[]
}

export type GreenSumNode = GreenSumLeaf | GreenSumBranch

function makeGreenLeaf(items: readonly GreenNode[]): GreenSumLeaf {
  let width = 0
  for (let i = 0; i < items.length; i++) width += items[i].width
  return { height: 0, count: items.length, width, items }
}

function makeGreenBranch(height: number, children: readonly GreenSumNode[]): GreenSumBranch {
  let count = 0
  let width = 0
  for (let i = 0; i < children.length; i++) {
    count += children[i].count
    width += children[i].width
  }
  return { height, count, width, children }
}

/** Build a balanced persistent `GreenSumNode` from a flat array in O(N). */
export function buildGreenSumTree(items: readonly GreenNode[]): GreenSumNode {
  if (items.length <= LEAF_MAX) {
    return makeGreenLeaf(items.slice())
  }
  let level: GreenSumNode[] = []
  for (let i = 0; i < items.length; i += LEAF_MAX) {
    const end = Math.min(i + LEAF_MAX, items.length)
    const slice = new Array<GreenNode>(end - i)
    for (let j = i; j < end; j++) slice[j - i] = items[j]
    level.push(makeGreenLeaf(slice))
  }
  let height = 1
  while (level.length > 1) {
    const next: GreenSumNode[] = []
    for (let i = 0; i < level.length; i += BRANCH_MAX) {
      const end = Math.min(i + BRANCH_MAX, level.length)
      const slice = new Array<GreenSumNode>(end - i)
      for (let j = i; j < end; j++) slice[j - i] = level[j]
      next.push(makeGreenBranch(height, slice))
    }
    level = next
    height++
  }
  return level[0]!
}

/** Flatten a `GreenSumNode` into a newly allocated array (cold path only). */
export function flattenGreenSumTree(root: GreenSumNode): GreenNode[] {
  const out = new Array<GreenNode>(root.count)
  let w = 0
  const visit = (node: GreenSumNode): void => {
    if (node.height === 0) {
      const items = (node as GreenSumLeaf).items
      for (let i = 0; i < items.length; i++) out[w++] = items[i]
      return
    }
    const kids = (node as GreenSumBranch).children
    for (let i = 0; i < kids.length; i++) visit(kids[i])
  }
  visit(root)
  return out
}

/** Return child at `index` in O(log N). */
export function greenSumAt(root: GreenSumNode, index: number): GreenNode | undefined {
  if (index < 0 || index >= root.count) return undefined
  let node: GreenSumNode = root
  let idx = index
  while (node.height > 0) {
    const kids = (node as GreenSumBranch).children
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (idx < c.count) {
        node = c
        break
      }
      idx -= c.count
    }
  }
  return (node as GreenSumLeaf).items[idx]
}

/** Return cumulative width of items `[0 .. index)` in O(log N). */
export function greenSumOffsetOfIndex(root: GreenSumNode, index: number): number {
  if (index <= 0) return 0
  if (index >= root.count) return root.width
  let node: GreenSumNode = root
  let idx = index
  let offset = 0
  while (node.height > 0) {
    const kids = (node as GreenSumBranch).children
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (idx < c.count) {
        node = c
        break
      }
      idx -= c.count
      offset += c.width
    }
  }
  const items = (node as GreenSumLeaf).items
  for (let i = 0; i < idx; i++) offset += items[i].width
  return offset
}

/**
 * Find the first child whose end (`relStart + width`) is `>= relOffset`,
 * returning `{ index, offset }` in O(log N).
 */
export function greenSumFindAtOffset(
  root: GreenSumNode,
  relOffset: number,
): { index: number; offset: number } {
  if (root.count === 0) return { index: 0, offset: 0 }
  if (relOffset <= 0) return { index: 0, offset: 0 }
  if (relOffset > root.width) return { index: root.count, offset: root.width }
  let node: GreenSumNode = root
  let index = 0
  let offset = 0
  while (node.height > 0) {
    const kids = (node as GreenSumBranch).children
    let descended = false
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (offset + c.width >= relOffset) {
        node = c
        descended = true
        break
      }
      offset += c.width
      index += c.count
    }
    if (!descended) return { index: root.count, offset: root.width }
  }
  const items = (node as GreenSumLeaf).items
  for (let i = 0; i < items.length; i++) {
    const w = items[i].width
    if (offset + w >= relOffset) return { index: index + i, offset }
    offset += w
  }
  return { index: index + items.length, offset }
}

/** Extract `[start, end)` items in O(log N + (end - start)). */
export function greenSumSlice(root: GreenSumNode, start: number, end: number): GreenNode[] {
  const s = Math.max(0, start)
  const e = Math.min(root.count, end)
  if (e <= s) return []
  const out: GreenNode[] = []
  const collect = (node: GreenSumNode, baseIdx: number): void => {
    if (baseIdx >= e || baseIdx + node.count <= s) return
    if (node.height === 0) {
      const items = (node as GreenSumLeaf).items
      const lo = Math.max(0, s - baseIdx)
      const hi = Math.min(items.length, e - baseIdx)
      for (let i = lo; i < hi; i++) out.push(items[i])
      return
    }
    const kids = (node as GreenSumBranch).children
    let cur = baseIdx
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (cur >= e) break
      if (cur + c.count > s) collect(c, cur)
      cur += c.count
    }
  }
  collect(root, 0)
  return out
}

/**
 * Persistent single-element replacement at `index` in O(log N).
 * Copies only the `height + 1` nodes on the root-to-leaf path.
 */
export function greenSumReplaceAt(
  root: GreenSumNode,
  index: number,
  replacement: GreenNode,
): GreenSumNode {
  if (root.height === 0) {
    const old = (root as GreenSumLeaf).items
    const next = old.slice()
    const delta = replacement.width - old[index].width
    next[index] = replacement
    return { height: 0, count: root.count, width: root.width + delta, items: next }
  }
  const oldKids = (root as GreenSumBranch).children
  let idx = index
  for (let i = 0; i < oldKids.length; i++) {
    const c = oldKids[i]
    if (idx < c.count) {
      const updated = greenSumReplaceAt(c, idx, replacement)
      const nextKids = oldKids.slice()
      nextKids[i] = updated
      return {
        height: root.height,
        count: root.count,
        width: root.width + (updated.width - c.width),
        children: nextKids,
      }
    }
    idx -= c.count
  }
  return root
}

/** Split an oversized leaf into balanced leaves of at most `LEAF_MAX`. */
function splitGreenLeaves(items: readonly GreenNode[]): GreenSumLeaf[] {
  if (items.length === 0) return []
  if (items.length <= LEAF_MAX) return [makeGreenLeaf(items)]
  const parts = Math.ceil(items.length / LEAF_MAX)
  const step = Math.ceil(items.length / parts)
  const out: GreenSumLeaf[] = []
  for (let i = 0; i < items.length; i += step) {
    out.push(makeGreenLeaf(items.slice(i, Math.min(i + step, items.length))))
  }
  return out
}

/** Split an oversized branch list into balanced branches of at most `BRANCH_MAX`. */
function splitGreenBranches(height: number, kids: readonly GreenSumNode[]): GreenSumBranch[] {
  if (kids.length === 0) return []
  if (kids.length <= BRANCH_MAX) return [makeGreenBranch(height, kids)]
  const parts = Math.ceil(kids.length / BRANCH_MAX)
  const step = Math.ceil(kids.length / parts)
  const out: GreenSumBranch[] = []
  for (let i = 0; i < kids.length; i += step) {
    out.push(makeGreenBranch(height, kids.slice(i, Math.min(i + step, kids.length))))
  }
  return out
}

/**
 * Persistent range splice: replace `[from, to)` with `replacement` in O(log N + K).
 *
 * Fast-path: when `to - from === 1 && replacement.length === 1` (the 99%
 * single-keystroke edit inside an existing block), uses `greenSumReplaceAt`
 * directly with zero splitting or rebalancing.
 *
 * General path: recursively splices only the touched subtrees and splits
 * oversized nodes / collapses emptied nodes along the path.
 */
export function greenSumSplice(
  root: GreenSumNode,
  from: number,
  to: number,
  replacement: readonly GreenNode[],
): GreenSumNode {
  if (to - from === 1 && replacement.length === 1) {
    return greenSumReplaceAt(root, from, replacement[0])
  }

  // Recursive splice returning 0, 1, or more same-height nodes replacing `node`.
  const spliceRec = (
    node: GreenSumNode,
    s: number,
    e: number,
    rep: readonly GreenNode[],
  ): GreenSumNode[] => {
    if (node.height === 0) {
      const items = (node as GreenSumLeaf).items
      const next: GreenNode[] = []
      for (let i = 0; i < s; i++) next.push(items[i])
      for (let i = 0; i < rep.length; i++) next.push(rep[i])
      for (let i = e; i < items.length; i++) next.push(items[i])
      return splitGreenLeaves(next)
    }

    const kids = (node as GreenSumBranch).children
    // Find first and last child overlapping `[s, e]` (note: pure insert `s === e` lands in 1 child).
    let first = 0
    let acc = 0
    while (first < kids.length - 1 && acc + kids[first].count < s) {
      acc += kids[first].count
      first++
    }
    const firstStart = acc
    let last = first
    let lastStart = firstStart
    while (last < kids.length - 1 && lastStart + kids[last].count < e) {
      lastStart += kids[last].count
      last++
    }

    const nextKids: GreenSumNode[] = []
    for (let i = 0; i < first; i++) nextKids.push(kids[i])

    if (first === last) {
      // Entire splice falls within a single child branch — recurse with full `rep`.
      const replaced = spliceRec(kids[first], s - firstStart, e - firstStart, rep)
      for (let i = 0; i < replaced.length; i++) nextKids.push(replaced[i])
    } else {
      // Spans multiple children: trim right of `first` (inserting `rep`), drop
      // middle children completely, trim left of `last`.
      const leftRep = spliceRec(kids[first], s - firstStart, kids[first].count, rep)
      for (let i = 0; i < leftRep.length; i++) nextKids.push(leftRep[i])
      const rightRep = spliceRec(kids[last], 0, e - lastStart, [])
      for (let i = 0; i < rightRep.length; i++) nextKids.push(rightRep[i])
    }

    for (let i = last + 1; i < kids.length; i++) nextKids.push(kids[i])

    // Rebalance tiny adjacent leaves when splicing shrinks a leaf below LEAF_MIN.
    if (node.height === 1 && nextKids.length > 1) {
      const merged: GreenSumNode[] = []
      for (let i = 0; i < nextKids.length; i++) {
        const cur = nextKids[i] as GreenSumLeaf
        const prev = merged.length > 0 ? (merged[merged.length - 1] as GreenSumLeaf) : null
        if (prev && (prev.count < LEAF_MIN || cur.count < LEAF_MIN) && prev.count + cur.count <= LEAF_MAX) {
          merged[merged.length - 1] = makeGreenLeaf([...prev.items, ...cur.items])
        } else {
          merged.push(cur)
        }
      }
      return splitGreenBranches(node.height, merged)
    }

    if (node.height > 1 && nextKids.length > 1) {
      const merged: GreenSumNode[] = []
      for (let i = 0; i < nextKids.length; i++) {
        const cur = nextKids[i] as GreenSumBranch
        const prev = merged.length > 0 ? (merged[merged.length - 1] as GreenSumBranch) : null
        if (prev && (prev.count < BRANCH_MIN || cur.count < BRANCH_MIN) && prev.children.length + cur.children.length <= BRANCH_MAX) {
          merged[merged.length - 1] = makeGreenBranch(node.height - 1, [...prev.children, ...cur.children])
        } else {
          merged.push(cur)
        }
      }
      return splitGreenBranches(node.height, merged)
    }

    return splitGreenBranches(node.height, nextKids)
  }

  let nodes = spliceRec(root, from, to, replacement)
  if (nodes.length === 0) return makeGreenLeaf([])
  // Grow tree height if root split into multiple nodes.
  let h = nodes[0].height + 1
  while (nodes.length > 1) {
    nodes = splitGreenBranches(h, nodes)
    h++
  }
  // Collapse redundant single-child root branches.
  let top = nodes[0]
  while (top.height > 0 && (top as GreenSumBranch).children.length === 1) {
    top = (top as GreenSumBranch).children[0]
  }
  return top
}

// ─── Red SumTree ────────────────────────────────────────────────────────────

export interface RedSumLeaf {
  readonly height: 0
  readonly green: GreenSumLeaf
  readonly items: readonly RedNode[]
}

export interface RedSumBranch {
  readonly height: number // >= 1
  readonly green: GreenSumBranch
  readonly children: readonly RedSumNode[]
}

export type RedSumNode = RedSumLeaf | RedSumBranch

/**
 * Build a `RedSumNode` mirroring `green` from scratch, using `buildChild` for
 * each leaf `GreenNode` with its exact absolute start offset.
 */
export function buildRedSumTree(
  green: GreenSumNode,
  startOffset: number,
  parent: RedNode,
  buildChild: (g: GreenNode, offset: number) => RedNode,
): RedSumNode {
  const buildRec = (g: GreenSumNode, baseOffset: number, baseIndex: number): RedSumNode => {
    if (g.height === 0) {
      const gItems = (g as GreenSumLeaf).items
      const items = new Array<RedNode>(gItems.length)
      let off = baseOffset
      for (let i = 0; i < gItems.length; i++) {
        const r = buildChild(gItems[i], off)
        r.parent = parent
        r.setIdxCache(baseIndex + i)
        items[i] = r
        off += gItems[i].width
      }
      return { height: 0, green: g as GreenSumLeaf, items }
    }
    const gKids = (g as GreenSumBranch).children
    const kids = new Array<RedSumNode>(gKids.length)
    let off = baseOffset
    let idx = baseIndex
    for (let i = 0; i < gKids.length; i++) {
      kids[i] = buildRec(gKids[i], off, idx)
      off += gKids[i].width
      idx += gKids[i].count
    }
    return { height: g.height, green: g as GreenSumBranch, children: kids }
  }
  return buildRec(green, startOffset, 0)
}

/**
 * Reconcile a new `GreenSumNode` against the previous `RedSumNode` in **O(log N)**.
 *
 * Any subtree whose `GreenSumNode` reference is identical (`g === old.green`) is
 * adopted **by reference in O(1)** — zero child iteration, zero `shiftLazy`,
 * zero `parent` rewriting. Exact offsets and `parent`/`_idxCache` links are
 * synced lazily whenever a child is actually accessed via `redSumAt`,
 * `redSumSlice`, or `flattenRedSumTree`.
 */
/** Collect every leaf `RedNode` under `nodes[lo..hi]` into a GreenNode-keyed reuse pool. */
function collectRedPool(nodes: readonly RedSumNode[], lo: number, hi: number): Map<GreenNode, RedNode[]> {
  const pool = new Map<GreenNode, RedNode[]>()
  const visit = (node: RedSumNode): void => {
    if (node.height === 0) {
      const items = (node as RedSumLeaf).items
      for (let i = 0; i < items.length; i++) {
        const r = items[i]
        const list = pool.get(r.green)
        if (list) list.push(r)
        else pool.set(r.green, [r])
      }
      return
    }
    const kids = (node as RedSumBranch).children
    for (let i = 0; i < kids.length; i++) visit(kids[i])
  }
  for (let i = lo; i <= hi; i++) visit(nodes[i])
  return pool
}

/** Build a `RedSumNode` adopting any leaf `RedNode` whose `GreenNode` is in `pool`. */
function buildRedSumFromPool(
  green: GreenSumNode,
  startOffset: number,
  startIndex: number,
  parent: RedNode,
  pool: Map<GreenNode, RedNode[]>,
  buildChild: (g: GreenNode, offset: number) => RedNode,
  stats?: { adopted: number },
): RedSumNode {
  const buildRec = (g: GreenSumNode, baseOffset: number, baseIndex: number): RedSumNode => {
    if (g.height === 0) {
      const gItems = (g as GreenSumLeaf).items
      const items = new Array<RedNode>(gItems.length)
      let off = baseOffset
      for (let i = 0; i < gItems.length; i++) {
        const gChild = gItems[i]
        const list = pool.get(gChild)
        let r: RedNode
        if (list && list.length > 0) {
          r = list.shift()!
          r.setStart(off)
          if (stats) stats.adopted++
        } else {
          r = buildChild(gChild, off)
        }
        r.parent = parent
        r.setIdxCache(baseIndex + i)
        items[i] = r
        off += gChild.width
      }
      return { height: 0, green: g as GreenSumLeaf, items }
    }
    const gKids = (g as GreenSumBranch).children
    const kids = new Array<RedSumNode>(gKids.length)
    let off = baseOffset
    let idx = baseIndex
    for (let i = 0; i < gKids.length; i++) {
      kids[i] = buildRec(gKids[i], off, idx)
      off += gKids[i].width
      idx += gKids[i].count
    }
    return { height: g.height, green: g as GreenSumBranch, children: kids }
  }
  return buildRec(green, startOffset, startIndex)
}

export function reconcileRedSumTree(
  newGreen: GreenSumNode,
  oldRed: RedSumNode,
  startOffset: number,
  parent: RedNode,
  buildChild: (g: GreenNode, offset: number) => RedNode,
  reuseChild: (g: GreenNode, old: RedNode, offset: number) => RedNode,
  stats?: { adopted: number },
): RedSumNode {
  const rec = (
    g: GreenSumNode,
    old: RedSumNode | null,
    baseOffset: number,
    baseIndex: number,
  ): RedSumNode => {
    if (old !== null && g === old.green) {
      if (stats) stats.adopted += g.count
      return old
    }

    if (g.height === 0) {
      const gLeaf = g as GreenSumLeaf
      const gItems = gLeaf.items
      if (old !== null && old.height === 0) {
        const oItems = (old as RedSumLeaf).items
        const gLen = gItems.length
        const items = new Array<RedNode>(gLen)
        const limit = Math.min(gLen, oItems.length)

        let lo = 0
        let off = baseOffset
        while (lo < limit && gItems[lo] === oItems[lo].green) {
          const c = oItems[lo]
          c.setStart(off)
          c.parent = parent
          c.setIdxCache(baseIndex + lo)
          items[lo] = c
          off += gItems[lo].width
          lo++
        }
        if (stats) stats.adopted += lo

        let gHi = gLen - 1
        let oHi = oItems.length - 1
        let endOff = baseOffset + g.width
        const suffixStart = gHi
        while (gHi >= lo && oHi >= lo && gItems[gHi] === oItems[oHi].green) {
          endOff -= gItems[gHi].width
          const c = oItems[oHi]
          c.setStart(endOff)
          c.parent = parent
          c.setIdxCache(baseIndex + gHi)
          items[gHi] = c
          gHi--
          oHi--
        }
        if (stats) stats.adopted += suffixStart - gHi

        if (gHi === lo && oHi === lo) {
          const c = reuseChild(gItems[lo], oItems[lo], off)
          c.parent = parent
          c.setIdxCache(baseIndex + lo)
          items[lo] = c
        } else {
          let midOff = off
          for (let i = lo; i <= gHi; i++) {
            const c = buildChild(gItems[i], midOff)
            c.parent = parent
            c.setIdxCache(baseIndex + i)
            items[i] = c
            midOff += gItems[i].width
          }
        }
        return { height: 0, green: gLeaf, items }
      }
      if (old !== null) {
        const pool = collectRedPool([old], 0, 0)
        return buildRedSumFromPool(g, baseOffset, baseIndex, parent, pool, buildChild, stats)
      }
      return buildRedSumTree(g, baseOffset, parent, buildChild)
    }

    // Internal branch: match prefix & suffix by GreenSumNode reference in O(64).
    const gBranch = g as GreenSumBranch
    const gKids = gBranch.children
    if (old !== null && old.height === g.height) {
      const oKids = (old as RedSumBranch).children
      const gLen = gKids.length
      const kids = new Array<RedSumNode>(gLen)
      const limit = Math.min(gLen, oKids.length)

      let lo = 0
      let off = baseOffset
      let idx = baseIndex
      while (lo < limit && gKids[lo] === oKids[lo].green) {
        kids[lo] = oKids[lo]
        if (stats) stats.adopted += gKids[lo].count
        off += gKids[lo].width
        idx += gKids[lo].count
        lo++
      }

      let gHi = gLen - 1
      let oHi = oKids.length - 1
      while (gHi >= lo && oHi >= lo && gKids[gHi] === oKids[oHi].green) {
        kids[gHi] = oKids[oHi]
        if (stats) stats.adopted += gKids[gHi].count
        gHi--
        oHi--
      }

      if (gHi === lo && oHi === lo) {
        kids[lo] = rec(gKids[lo], oKids[lo], off, idx)
      } else {
        // Leaf split / merge changed branch count in `[lo..gHi]`: preserve
        // every untouched RedNode's identity from `oKids[lo..oHi]`.
        const pool = oHi >= lo ? collectRedPool(oKids, lo, oHi) : null
        let midOff = off
        let midIdx = idx
        for (let i = lo; i <= gHi; i++) {
          kids[i] = pool
            ? buildRedSumFromPool(gKids[i], midOff, midIdx, parent, pool, buildChild, stats)
            : buildRedSumTree(gKids[i], midOff, parent, buildChild)
          midOff += gKids[i].width
          midIdx += gKids[i].count
        }
      }
      return { height: g.height, green: gBranch, children: kids }
    }

    if (old !== null) {
      const pool = collectRedPool([old], 0, 0)
      return buildRedSumFromPool(g, baseOffset, baseIndex, parent, pool, buildChild, stats)
    }
    return buildRedSumTree(g, baseOffset, parent, buildChild)
  }

  return rec(newGreen, oldRed, startOffset, 0)
}

/**
 * Retrieve child at `index` in O(log N), syncing its exact offset, `parent`,
 * and `_idxCache` from the `GreenSumTree` widths along the descent path.
 */
export function redSumAt(
  root: RedSumNode,
  index: number,
  rootInnerStart: number,
  parent: RedNode,
): RedNode | undefined {
  if (index < 0 || index >= root.green.count) return undefined
  let node: RedSumNode = root
  let idx = index
  let offset = rootInnerStart
  while (node.height > 0) {
    const kids = (node as RedSumBranch).children
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (idx < c.green.count) {
        node = c
        break
      }
      idx -= c.green.count
      offset += c.green.width
    }
  }
  const items = (node as RedSumLeaf).items
  for (let i = 0; i < idx; i++) offset += items[i].green.width
  const child = items[idx]
  child.setStart(offset)
  child.parent = parent
  child.setIdxCache(index)
  return child
}

/**
 * Extract `[start, end)` children in O(log N + (end - start)), syncing exact
 * offsets, `parent`, and `_idxCache` ONLY for the returned slice.
 */
export function redSumSlice(
  root: RedSumNode,
  start: number,
  end: number,
  rootInnerStart: number,
  parent: RedNode,
): RedNode[] {
  const s = Math.max(0, start)
  const e = Math.min(root.green.count, end)
  if (e <= s) return []
  const out: RedNode[] = []
  const collect = (node: RedSumNode, baseIdx: number, baseOff: number): void => {
    if (baseIdx >= e || baseIdx + node.green.count <= s) return
    if (node.height === 0) {
      const items = (node as RedSumLeaf).items
      const lo = Math.max(0, s - baseIdx)
      const hi = Math.min(items.length, e - baseIdx)
      let off = baseOff
      for (let i = 0; i < lo; i++) off += items[i].green.width
      for (let i = lo; i < hi; i++) {
        const child = items[i]
        child.setStart(off)
        child.parent = parent
        child.setIdxCache(baseIdx + i)
        out.push(child)
        off += child.green.width
      }
      return
    }
    const kids = (node as RedSumBranch).children
    let curIdx = baseIdx
    let curOff = baseOff
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (curIdx >= e) break
      if (curIdx + c.green.count > s) collect(c, curIdx, curOff)
      curIdx += c.green.count
      curOff += c.green.width
    }
  }
  collect(root, 0, rootInnerStart)
  return out
}

/** Flatten a `RedSumNode` into a full `RedNode[]` with synced offsets (cold path only). */
export function flattenRedSumTree(
  root: RedSumNode,
  rootInnerStart: number,
  parent: RedNode,
): RedNode[] {
  const out = new Array<RedNode>(root.green.count)
  let w = 0
  let off = rootInnerStart
  const visit = (node: RedSumNode): void => {
    if (node.height === 0) {
      const items = (node as RedSumLeaf).items
      for (let i = 0; i < items.length; i++) {
        const child = items[i]
        child.setStart(off)
        child.parent = parent
        child.setIdxCache(w)
        out[w++] = child
        off += child.green.width
      }
      return
    }
    const kids = (node as RedSumBranch).children
    for (let i = 0; i < kids.length; i++) visit(kids[i])
  }
  visit(root)
  return out
}
